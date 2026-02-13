// app/routes/app._index.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { ensureSettings, markAbandonedByDelay, syncAbandonedCheckoutsFromShopify, enqueueCallJobs } from "../callRecovery.server";
import { createVapiCallForJob } from "../callProvider.server";

/* =========================
   Types (Prisma + Supabase)
   ========================= */

/**
 * UPDATED to match the NEW vapi_call_summaries schema (based on your CSV).
 * Keep it permissive so schema additions won't break the app.
 * NOTE: Some columns may be null depending on pipeline stage.
 */
type SupabaseCallSummary = {
  id?: string;
  shop?: string | null;

  // join keys
  call_id: string; // Vapi call id
  call_job_id?: string | null; // Prisma CallJob.id
  checkout_id?: string | null; // Checkout.checkoutId

  // timestamps
  received_at?: string | null;
  last_received_at?: string | null;
  ai_processed_at?: string | null;

  // status
  latest_status?: string | null;
  ended_reason?: string | null;

  // links
  recording_url?: string | null;
  stereo_recording_url?: string | null;
  log_url?: string | null;

  // raw convo artifacts
  transcript?: string | null;
  end_of_call_report?: string | null;

  // normalized outcome
  call_outcome?: string | null;
  disposition?: string | null;

  answered?: boolean | null;
  voicemail?: boolean | null;

  sentiment?: string | null;
  tone?: string | null; // sometimes people name it tone
  buy_probability?: number | null;
  customer_intent?: string | null;

  // tags can be json array OR csv string columns
  tags?: any;
  tagcsv?: string | null;

  // summaries
  summary?: string | null;
  summary_clean?: string | null;

  // next action fields (newer vs older naming)
  next_best_action?: string | null;
  best_next_action?: string | null;

  follow_up_message?: string | null;

  // arrays or text
  key_quotes?: any;
  key_quotes_text?: string | null;

  objections?: any;
  objections_text?: string | null;

  issues_to_fix?: any;
  issues_to_fix_text?: string | null;

  // escalation / discount
  human_intervention?: boolean | null;
  human_intervention_reason?: string | null;

  discount_suggest?: boolean | null;
  discount_percent?: number | null;
  discount_rationale?: string | null;

  // AI pipeline
  ai_status?: string | null;
  ai_error?: string | null;

  // raw AI payloads
  ai_result?: any;
  ai_insights?: any;
  payload?: any;
  structured_outputs?: any;
};

type Row = {
  id: string;
  checkoutId: string;
  status: string;
  scheduledFor: string;
  createdAt: string;
  attempts: number;

  customerName?: string | null;
  cartPreview?: string | null;

  providerCallId?: string | null;
  recordingUrl?: string | null;
  endedReason?: string | null;
  transcript?: string | null;

  outcome?: string | null; // legacy / prisma

  // ✅ Supabase enriched
  sb?: SupabaseCallSummary | null;

  // Unified fields used by UI
  answeredFlag: "answered" | "no_answer" | "unknown";
  disposition: "interested" | "needs_support" | "call_back_later" | "not_interested" | "wrong_number" | "unknown";
  sentiment: "positive" | "neutral" | "negative" | null;
  buyProbabilityPct: number | null; // 0..100
  tags: string[];
  summaryText: string | null;
  nextActionText: string | null;
  followUpText: string | null;
  callOutcome: string | null;
  humanIntervention: boolean | null;
  discountSuggest: boolean | null;
  discountPercent: number | null;
};

type CheckoutUIRow = {
  checkoutId: string;
  status: "OPEN" | "ABANDONED" | "CONVERTED" | string;
  createdAt: string;
  updatedAt: string;
  abandonedAt: string | null;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  value: number;
  currency: string;
  cartPreview: string | null;

  // latest call job (Prisma)
  callJobId: string | null;
  callStatus: string | null;
  callScheduledFor: string | null;
  callAttempts: number | null;
  providerCallId: string | null;
  recordingUrl: string | null;

  // ✅ Supabase enriched
  callOutcome: string | null;
  sentiment: string | null;
  buyProbabilityPct: number | null;
  disposition: string | null;
  aiStatus: string | null;
};

type LoaderData = {
  shop: string;
  currency: string;
  vapiConfigured: boolean;
  stats: {
    abandonedCount7d: number;
    convertedCount7d: number;
    openCount7d: number;
    potentialRevenue7d: number;
    queuedCalls: number;
    callingNow: number;
    completedCalls7d: number;
  };
  recentJobs: Row[];
  allCheckouts: CheckoutUIRow[];
};

/* =========================
   Helpers
   ========================= */

function buildCartPreview(itemsJson?: string | null): string | null {
  if (!itemsJson) return null;
  try {
    const items = JSON.parse(itemsJson);
    if (!Array.isArray(items) || items.length === 0) return null;
    return items
      .slice(0, 3)
      .map((it: any) => {
        const title = String(it?.title ?? "").trim();
        const qty = Number(it?.quantity ?? 1);
        if (!title) return null;
        return `${title} x${Number.isFinite(qty) ? qty : 1}`;
      })
      .filter(Boolean)
      .join(", ");
  } catch {
    return null;
  }
}

function isVapiConfiguredFromEnv() {
  const assistantId = process.env.VAPI_ASSISTANT_ID?.trim();
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID?.trim();
  const apiKey = process.env.VAPI_API_KEY?.trim();
  const serverUrl = process.env.VAPI_SERVER_URL?.trim();
  return Boolean(apiKey) && Boolean(assistantId) && Boolean(phoneNumberId) && Boolean(serverUrl);
}

function safeStr(v: any) {
  return v == null ? "" : String(v);
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function normalizeTag(t: string) {
  return safeStr(t).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60);
}

function cleanSentiment(v?: string | null) {
  const s = safeStr(v).trim().toLowerCase();
  if (s === "positive" || s === "neutral" || s === "negative") return s as any;
  return null;
}

function toDisposition(v?: string | null): Row["disposition"] {
  const s = safeStr(v).trim().toLowerCase();
  if (
    s === "interested" ||
    s === "needs_support" ||
    s === "call_back_later" ||
    s === "not_interested" ||
    s === "wrong_number" ||
    s === "unknown"
  )
    return s as any;
  return "unknown";
}

function toCallOutcomeTone(outcome: string | null): "green" | "amber" | "red" | "neutral" {
  const s = safeStr(outcome).toLowerCase();
  if (!s) return "neutral";
  if (s.includes("recovered")) return "green";
  if (s.includes("needs_followup")) return "amber";
  if (s.includes("voicemail") || s.includes("no_answer")) return "amber";
  if (s.includes("not_recovered") || s.includes("wrong_number") || s.includes("not_interested")) return "red";
  return "neutral";
}

function pickLatestJobByCheckout(jobs: Array<any>) {
  const map = new Map<string, any>();
  for (const j of jobs) {
    const key = String(j.checkoutId ?? "");
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, j);
      continue;
    }
    const a = new Date(prev.createdAt).getTime();
    const b = new Date(j.createdAt).getTime();
    if (Number.isFinite(b) && b > a) map.set(key, j);
  }
  return map;
}

function parseTags(sb: SupabaseCallSummary | null | undefined): string[] {
  if (!sb) return [];

  const raw = sb.tags;

  let arr: string[] = [];
  if (Array.isArray(raw)) {
    arr = raw.map((x) => safeStr(x)).filter(Boolean);
  } else if (typeof raw === "string" && raw.trim()) {
    arr = raw.split(",").map((x) => safeStr(x)).filter(Boolean);
  } else if (typeof sb.tagcsv === "string" && sb.tagcsv.trim()) {
    arr = sb.tagcsv.split(",").map((x) => safeStr(x)).filter(Boolean);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of arr.map(normalizeTag)) {
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function parseTextList(v: any, fallbackText?: string | null, max = 8): string[] {
  if (Array.isArray(v)) return v.map((x) => safeStr(x)).filter(Boolean).slice(0, max);
  if (typeof v === "string" && v.trim()) return v.split(/\r?\n|,/g).map((x) => safeStr(x)).filter(Boolean).slice(0, max);
  if (fallbackText && fallbackText.trim())
    return fallbackText.split(/\r?\n|,/g).map((x) => safeStr(x)).filter(Boolean).slice(0, max);
  return [];
}

function pickSummary(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  const s = safeStr(sb.summary_clean || sb.summary).trim();
  return s ? s : null;
}

function pickNextAction(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  const s = safeStr(sb.next_best_action || sb.best_next_action).trim();
  return s ? s : null;
}

function pickRecordingUrl(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  return (sb.recording_url || sb.stereo_recording_url || sb.log_url) ?? null;
}

/* =========================
   Supabase REST fetch (NEW schema)
   ========================= */

async function fetchSupabaseSummaries(opts: {
  shop: string;
  callIds?: string[];
  callJobIds?: string[];
  checkoutIds?: string[];
}): Promise<Map<string, SupabaseCallSummary>> {
  const out = new Map<string, SupabaseCallSummary>();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return out;

  const shop = opts.shop;

  const callIds = (opts.callIds ?? []).map((x) => x.trim()).filter(Boolean);
  const callJobIds = (opts.callJobIds ?? []).map((x) => x.trim()).filter(Boolean);
  const checkoutIds = (opts.checkoutIds ?? []).map((x) => x.trim()).filter(Boolean);

  if (callIds.length === 0 && callJobIds.length === 0 && checkoutIds.length === 0) return out;

  // IMPORTANT: include ALL columns you have today (and safe to ignore if null)
  const select = [
    "id",
    "shop",
    "call_id",
    "call_job_id",
    "checkout_id",
    "received_at",
    "last_received_at",
    "latest_status",
    "ended_reason",
    "recording_url",
    "stereo_recording_url",
    "log_url",
    "transcript",
    "end_of_call_report",
    "call_outcome",
    "disposition",
    "answered",
    "voicemail",
    "sentiment",
    "tone",
    "buy_probability",
    "customer_intent",
    "tags",
    "tagcsv",
    "summary",
    "summary_clean",
    "next_best_action",
    "best_next_action",
    "follow_up_message",
    "key_quotes",
    "key_quotes_text",
    "objections",
    "objections_text",
    "issues_to_fix",
    "issues_to_fix_text",
    "human_intervention",
    "human_intervention_reason",
    "discount_suggest",
    "discount_percent",
    "discount_rationale",
    "ai_status",
    "ai_error",
    "ai_processed_at",
    "ai_result",
    "ai_insights",
    "payload",
    "structured_outputs",
  ].join(",");

  const mkIn = (values: string[]) => values.map((x) => `"${x.replace(/"/g, "")}"`).join(",");

  const orParts: string[] = [];
  if (callIds.length) orParts.push(`call_id.in.(${encodeURIComponent(mkIn(Array.from(new Set(callIds))))})`);
  if (callJobIds.length) orParts.push(`call_job_id.in.(${encodeURIComponent(mkIn(Array.from(new Set(callJobIds))))})`);
  if (checkoutIds.length) orParts.push(`checkout_id.in.(${encodeURIComponent(mkIn(Array.from(new Set(checkoutIds))))})`);

  const or = orParts.join(",");
  const endpoint =
    `${url}/rest/v1/vapi_call_summaries` +
    `?select=${encodeURIComponent(select)}` +
    `&shop=eq.${encodeURIComponent(shop)}` +
    (or ? `&or=(${or})` : "");

  const r = await fetch(endpoint, {
    method: "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("[SB] fetch failed", r.status, r.statusText, body.slice(0, 800));
    return out;
  }

  const data = (await r.json()) as SupabaseCallSummary[];

  // Map by multiple keys for robust matching
  for (const row of data || []) {
    if (!row) continue;
    if (row.call_id) out.set(`call:${String(row.call_id)}`, row);
    if (row.call_job_id) out.set(`job:${String(row.call_job_id)}`, row);
    if (row.checkout_id) out.set(`co:${String(row.checkout_id)}`, row);
  }

  return out;
}

/* =========================
   UI components
   ========================= */

function Pill(props: { children: any; tone?: "neutral" | "green" | "blue" | "amber" | "red"; title?: string }) {
  const tone = props.tone ?? "neutral";
  const t =
    tone === "green"
      ? { bg: "rgba(16,185,129,0.10)", bd: "rgba(16,185,129,0.25)", tx: "#065f46" }
      : tone === "blue"
      ? { bg: "rgba(59,130,246,0.10)", bd: "rgba(59,130,246,0.25)", tx: "#1e3a8a" }
      : tone === "amber"
      ? { bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.25)", tx: "#92400e" }
      : tone === "red"
      ? { bg: "rgba(239,68,68,0.10)", bd: "rgba(239,68,68,0.25)", tx: "#7f1d1d" }
      : { bg: "rgba(0,0,0,0.04)", bd: "rgba(0,0,0,0.10)", tx: "rgba(0,0,0,0.75)" };

  return (
    <span
      title={props.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 10px",
        borderRadius: 999,
        border: `1px solid ${t.bd}`,
        background: t.bg,
        color: t.tx,
        fontWeight: 950,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = safeStr(status).toUpperCase();
  const tone = s === "COMPLETED" ? "green" : s === "CALLING" ? "blue" : s === "QUEUED" ? "amber" : s === "FAILED" ? "red" : "neutral";
  return <Pill tone={tone as any}>{s}</Pill>;
}

function CheckoutStatusPill({ status }: { status: string }) {
  const s = safeStr(status).toUpperCase();
  const tone = s === "CONVERTED" ? "green" : s === "ABANDONED" ? "red" : s === "OPEN" ? "amber" : "neutral";
  return <Pill tone={tone as any}>{s}</Pill>;
}

function AnsweredPill({ answered }: { answered: Row["answeredFlag"] }) {
  if (answered === "answered") return <Pill tone="green" title="Customer engaged">Answered</Pill>;
  if (answered === "no_answer") return <Pill tone="amber" title="No pick up / voicemail / busy">No answer</Pill>;
  return <Pill title="Not enough signal">Unknown</Pill>;
}

function DispositionPill({ d }: { d: Row["disposition"] }) {
  if (d === "interested") return <Pill tone="green" title="Positive buying intent">Interested</Pill>;
  if (d === "needs_support") return <Pill tone="blue" title="Needs help to complete order">Needs support</Pill>;
  if (d === "call_back_later") return <Pill tone="amber" title="Asked to be contacted later">Call back</Pill>;
  if (d === "not_interested") return <Pill tone="red" title="Explicit rejection">Not interested</Pill>;
  if (d === "wrong_number") return <Pill tone="red" title="Wrong phone number">Wrong number</Pill>;
  return <Pill title="No clear category">Unknown</Pill>;
}

function BuyPill({ pct }: { pct: number | null }) {
  if (pct == null) return <Pill title="Not available">—</Pill>;
  const tone = pct >= 70 ? "green" : pct >= 40 ? "amber" : "red";
  return (
    <Pill tone={tone as any} title={`Buy probability ${pct}%`}>
      {pct}%
    </Pill>
  );
}

function OutcomePill({ outcome }: { outcome: string | null }) {
  const s = safeStr(outcome);
  if (!s) return <Pill>—</Pill>;
  return <Pill tone={toCallOutcomeTone(s)} title="AI outcome">{s.toUpperCase()}</Pill>;
}

function AiStatusPill({ status, err }: { status: string | null; err: string | null }) {
  const s = safeStr(status).toLowerCase();
  if (!s) return <Pill>AI: —</Pill>;
  if (s === "done") return <Pill tone="green">AI: DONE</Pill>;
  if (s === "processing") return <Pill tone="blue">AI: RUNNING</Pill>;
  if (s === "pending") return <Pill tone="amber">AI: PENDING</Pill>;
  if (s === "error") return <Pill tone="red" title={err ?? ""}>AI: ERROR</Pill>;
  return <Pill>AI: {s.toUpperCase()}</Pill>;
}

function SoftButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" }) {
  const tone = props.tone ?? "ghost";
  const base: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "white",
    cursor: "pointer",
    fontWeight: 950,
    fontSize: 12,
    lineHeight: 1,
  };
  const styles =
    tone === "primary" ? { ...base, border: "1px solid rgba(59,130,246,0.30)", background: "rgba(59,130,246,0.10)" } : base;
  const { tone: _tone, style, ...rest } = props as any;
  return <button {...rest} style={{ ...styles, ...(style ?? {}) }} />;
}

function StatCard(props: { label: string; value: any; sub: string; icon?: string }) {
  return (
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.08)",
        background: "white",
        borderRadius: 16,
        padding: 14,
        boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontWeight: 950, fontSize: 12, color: "rgba(17,24,39,0.62)" }}>{props.label}</div>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.08)",
            background: "rgba(0,0,0,0.03)",
            display: "grid",
            placeItems: "center",
            fontWeight: 1000,
            color: "rgba(17,24,39,0.60)",
          }}
          title={props.icon ?? ""}
        >
          {props.icon ?? "•"}
        </div>
      </div>
      <div style={{ marginTop: 8, fontWeight: 1000, fontSize: 22, color: "rgba(17,24,39,0.92)" }}>{props.value}</div>
      <div style={{ marginTop: 4, fontWeight: 850, fontSize: 12, color: "rgba(17,24,39,0.45)" }}>{props.sub}</div>
    </div>
  );
}

/* =========================
   Loader
   ========================= */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
  await markAbandonedByDelay(shop, settings.delayMinutes);

  await enqueueCallJobs({
    shop,
    enabled: Boolean(settings.enabled),
    minOrderValue: Number(settings.minOrderValue ?? 0),
    callWindowStart: String(settings.callWindowStart ?? "09:00"),
    callWindowEnd: String(settings.callWindowEnd ?? "19:00"),
    delayMinutes: Number(settings.delayMinutes ?? 30),
    maxAttempts: Number(settings.maxAttempts ?? 2),
    retryMinutes: Number(settings.retryMinutes ?? 180),
  });

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    abandonedCount7d,
    convertedCount7d,
    openCount7d,
    potentialAgg,
    queuedCalls,
    callingNow,
    completedCalls7d,
    recentJobsRaw,
  ] = await Promise.all([
    db.checkout.count({ where: { shop, status: "ABANDONED", abandonedAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "CONVERTED", updatedAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "OPEN", createdAt: { gte: since } } }),
    db.checkout.aggregate({ where: { shop, status: "ABANDONED", abandonedAt: { gte: since } }, _sum: { value: true } }),
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        attempts: true,
        createdAt: true,
        providerCallId: true,
        recordingUrl: true,
        endedReason: true,
        transcript: true,
        outcome: true,
      },
    }),
  ]);

  const checkoutIdsFromJobs = recentJobsRaw.map((j: any) => String(j.checkoutId));
  const related =
    checkoutIdsFromJobs.length === 0
      ? []
      : await db.checkout.findMany({
          where: { shop, checkoutId: { in: checkoutIdsFromJobs } },
          select: { checkoutId: true, customerName: true, itemsJson: true },
        });

  const cMap = new Map(related.map((c: any) => [c.checkoutId, c]));

  // ✅ Pull Supabase summaries by ALL join keys
  const callIds = recentJobsRaw.map((j: any) => String(j.providerCallId ?? "")).filter(Boolean);
  const callJobIds = recentJobsRaw.map((j: any) => String(j.id ?? "")).filter(Boolean);
  const checkoutIds = recentJobsRaw.map((j: any) => String(j.checkoutId ?? "")).filter(Boolean);

  const sbMap = await fetchSupabaseSummaries({
    shop,
    callIds,
    callJobIds,
    checkoutIds,
  });

  const potentialRevenue7d = Number(potentialAgg._sum.value ?? 0);

  const rows: Row[] = recentJobsRaw.map((j: any) => {
    const c = cMap.get(j.checkoutId);

    const callId = j.providerCallId ? String(j.providerCallId) : "";
    const jobId = String(j.id);
    const coId = String(j.checkoutId);

    const sb =
      (callId ? sbMap.get(`call:${callId}`) : null) ||
      (jobId ? sbMap.get(`job:${jobId}`) : null) ||
      (coId ? sbMap.get(`co:${coId}`) : null) ||
      null;

    const sentiment = cleanSentiment((sb?.sentiment ?? sb?.tone) ?? null);

    const answeredFlag: Row["answeredFlag"] =
      sb?.answered === true ? "answered" : sb?.answered === false ? "no_answer" : "unknown";

    const disposition = toDisposition(sb?.disposition ?? null);

    const buyProbabilityPct =
      typeof sb?.buy_probability === "number" && Number.isFinite(sb.buy_probability)
        ? Math.max(0, Math.min(100, Math.round(sb.buy_probability)))
        : null;

    const tags = parseTags(sb);

    const summaryText = pickSummary(sb);
    const nextActionText = pickNextAction(sb);
    const followUpText = sb?.follow_up_message ? String(sb.follow_up_message) : null;
    const callOutcome = sb?.call_outcome ? String(sb.call_outcome) : null;

    const recordingFromSb = pickRecordingUrl(sb);

    return {
      id: String(j.id),
      checkoutId: String(j.checkoutId),
      status: String(j.status),
      scheduledFor: j.scheduledFor.toISOString(),
      createdAt: j.createdAt.toISOString(),
      attempts: Number(j.attempts ?? 0),

      customerName: c?.customerName ?? null,
      cartPreview: buildCartPreview(c?.itemsJson ?? null),

      providerCallId: j.providerCallId ?? null,
      recordingUrl: (recordingFromSb ?? j.recordingUrl) ?? null,
      endedReason: (sb?.ended_reason ?? j.endedReason) ?? null,
      transcript: (sb?.transcript ?? j.transcript) ?? null,

      outcome: j.outcome ?? null,

      sb,

      answeredFlag,
      disposition,
      sentiment,
      buyProbabilityPct,
      tags,
      summaryText,
      nextActionText,
      followUpText,
      callOutcome,
      humanIntervention: typeof sb?.human_intervention === "boolean" ? sb.human_intervention : null,
      discountSuggest: typeof sb?.discount_suggest === "boolean" ? sb.discount_suggest : null,
      discountPercent:
        typeof sb?.discount_percent === "number" && Number.isFinite(sb.discount_percent) ? Math.round(sb.discount_percent) : null,
    };
  });

  // ✅ Load all checkouts + connect latest job per checkout
  const [allCheckoutsRaw, allJobsForMap] = await Promise.all([
    db.checkout.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 250,
      select: {
        checkoutId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        abandonedAt: true,
        customerName: true,
        phone: true,
        email: true,
        value: true,
        currency: true,
        itemsJson: true,
      },
    }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        attempts: true,
        createdAt: true,
        providerCallId: true,
        recordingUrl: true,
      },
    }),
  ]);

  const latestJobMap = pickLatestJobByCheckout(allJobsForMap);

  // Pull summaries for checkouts table via checkout_id + providerCallId + call_job_id
  const checkoutIdsAll = allCheckoutsRaw.map((c: any) => String(c.checkoutId)).filter(Boolean);

  const checkoutCallIds = allCheckoutsRaw
    .map((c: any) => {
      const j = latestJobMap.get(String(c.checkoutId)) ?? null;
      return j?.providerCallId ? String(j.providerCallId) : "";
    })
    .filter(Boolean);

  const checkoutJobIds = allCheckoutsRaw
    .map((c: any) => {
      const j = latestJobMap.get(String(c.checkoutId)) ?? null;
      return j?.id ? String(j.id) : "";
    })
    .filter(Boolean);

  const sbMap2 = await fetchSupabaseSummaries({
    shop,
    callIds: Array.from(new Set(checkoutCallIds)),
    callJobIds: Array.from(new Set(checkoutJobIds)),
    checkoutIds: Array.from(new Set(checkoutIdsAll)),
  });

  const allCheckouts: CheckoutUIRow[] = allCheckoutsRaw.map((c: any) => {
    const j = latestJobMap.get(String(c.checkoutId)) ?? null;

    const callId = j?.providerCallId ? String(j.providerCallId) : "";
    const jobId = j?.id ? String(j.id) : "";
    const checkoutId = String(c.checkoutId);

    const sb =
      (callId ? sbMap2.get(`call:${callId}`) : null) ||
      (jobId ? sbMap2.get(`job:${jobId}`) : null) ||
      (checkoutId ? sbMap2.get(`co:${checkoutId}`) : null) ||
      null;

    const recordingFromSb = pickRecordingUrl(sb);

    return {
      checkoutId,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      abandonedAt: c.abandonedAt ? new Date(c.abandonedAt).toISOString() : null,
      customerName: c.customerName ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
      value: Number(c.value ?? 0),
      currency: String(c.currency ?? "USD"),
      cartPreview: buildCartPreview(c.itemsJson ?? null),

      callJobId: j ? String(j.id) : null,
      callStatus: j ? String(j.status) : null,
      callScheduledFor: j?.scheduledFor ? new Date(j.scheduledFor).toISOString() : null,
      callAttempts: j ? Number(j.attempts ?? 0) : null,
      providerCallId: j?.providerCallId ? String(j.providerCallId) : null,
      recordingUrl: (recordingFromSb ?? (j?.recordingUrl ? String(j.recordingUrl) : null)) ?? null,

      callOutcome: sb?.call_outcome ? String(sb.call_outcome) : null,
      sentiment: sb?.sentiment ? String(sb.sentiment) : (sb?.tone ? String(sb.tone) : null),
      buyProbabilityPct:
        typeof sb?.buy_probability === "number" && Number.isFinite(sb.buy_probability) ? Math.round(sb.buy_probability) : null,
      disposition: sb?.disposition ? String(sb.disposition) : null,
      aiStatus: sb?.ai_status ? String(sb.ai_status) : null,
    };
  });

  return {
    shop,
    currency: settings.currency || "USD",
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats: {
      abandonedCount7d,
      convertedCount7d,
      openCount7d,
      potentialRevenue7d,
      queuedCalls,
      callingNow,
      completedCalls7d,
    },
    recentJobs: rows,
    allCheckouts,
  } satisfies LoaderData;
};

/* =========================
   Actions (unchanged)
   ========================= */

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  const redirectBack = () => new Response(null, { status: 303, headers: { Location: "/app" } });

  if (intent === "run_jobs") {
    const settings = await ensureSettings(shop);
    const vapiOk = isVapiConfiguredFromEnv();

    const now = new Date();
    const jobs = await db.callJob.findMany({
      where: { shop, status: "QUEUED", scheduledFor: { lte: now } },
      orderBy: { scheduledFor: "asc" },
      take: 10,
    });

    for (const job of jobs) {
      const locked = await db.callJob.updateMany({
        where: { id: job.id, shop, status: "QUEUED" },
        data: { status: "CALLING", attempts: { increment: 1 }, provider: vapiOk ? "vapi" : "sim", outcome: null },
      });
      if (locked.count === 0) continue;

      if (!vapiOk) {
        await db.callJob.update({
          where: { id: job.id },
          data: { status: "COMPLETED", outcome: `SIMULATED_CALL_OK phone=${job.phone}` },
        });
        continue;
      }

      try {
        await createVapiCallForJob({ shop, callJobId: job.id });
        await db.callJob.update({ where: { id: job.id }, data: { status: "CALLING", outcome: "VAPI_CALL_STARTED" } });
      } catch (e: any) {
        const maxAttempts = settings.maxAttempts ?? 2;
        const fresh = await db.callJob.findUnique({ where: { id: job.id }, select: { attempts: true } });
        const attemptsAfter = Number(fresh?.attempts ?? 0);

        if (attemptsAfter >= maxAttempts) {
          await db.callJob.update({ where: { id: job.id }, data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}` } });
        } else {
          const retryMinutes = settings.retryMinutes ?? 180;
          const next = new Date(Date.now() + retryMinutes * 60 * 1000);
          await db.callJob.update({
            where: { id: job.id },
            data: { status: "QUEUED", scheduledFor: next, outcome: `RETRY_SCHEDULED in ${retryMinutes}m` },
          });
        }
      }
    }

    return redirectBack();
  }

  if (intent === "manual_call") {
    const callJobId = String(fd.get("callJobId") ?? "").trim();
    if (!callJobId) return redirectBack();

    const vapiOk = isVapiConfiguredFromEnv();
    if (!vapiOk) {
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: { outcome: "Missing Vapi ENV (VAPI_API_KEY/VAPI_ASSISTANT_ID/VAPI_PHONE_NUMBER_ID/VAPI_SERVER_URL)" },
      });
      return redirectBack();
    }

    const locked = await db.callJob.updateMany({
      where: { id: callJobId, shop, status: "QUEUED" },
      data: { status: "CALLING", attempts: { increment: 1 }, provider: "vapi", outcome: null },
    });
    if (locked.count === 0) return redirectBack();

    try {
      await createVapiCallForJob({ shop, callJobId });
      await db.callJob.updateMany({ where: { id: callJobId, shop }, data: { status: "CALLING", outcome: "VAPI_CALL_STARTED" } });
    } catch (e: any) {
      const settings = await ensureSettings(shop);
      const maxAttempts = settings.maxAttempts ?? 2;

      const fresh = await db.callJob.findUnique({ where: { id: callJobId }, select: { attempts: true } });
      const attemptsAfter = Number(fresh?.attempts ?? 0);

      if (attemptsAfter >= maxAttempts) {
        await db.callJob.updateMany({ where: { id: callJobId, shop }, data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}` } });
      } else {
        const retryMinutes = settings.retryMinutes ?? 180;
        const next = new Date(Date.now() + retryMinutes * 60 * 1000);
        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: { status: "QUEUED", scheduledFor: next, outcome: `RETRY_SCHEDULED in ${retryMinutes}m` },
        });
      }
    }

    return redirectBack();
  }

  return redirectBack();
};

/* =========================
   UI
   ========================= */

export default function Dashboard() {
  const { shop, stats, recentJobs, currency, vapiConfigured, allCheckouts } = useLoaderData<typeof loader>();

  const revalidator = useRevalidator();
  React.useEffect(() => {
    const active = stats.callingNow > 0 || stats.queuedCalls > 0;
    if (!active) return;

    const id = window.setInterval(() => {
      revalidator.revalidate();
    }, 5000);

    return () => window.clearInterval(id);
  }, [stats.callingNow, stats.queuedCalls, revalidator]);

  const [mode, setMode] = React.useState<"calls" | "checkouts">("calls");
  const [selectedId, setSelectedId] = React.useState<string | null>(recentJobs?.[0]?.id ?? null);

  React.useEffect(() => {
    if (!selectedId && recentJobs?.[0]?.id) setSelectedId(recentJobs[0].id);
  }, [selectedId, recentJobs]);

  const selected = React.useMemo(() => recentJobs.find((r) => r.id === selectedId) ?? null, [recentJobs, selectedId]);

  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();

  const filteredJobs = React.useMemo(() => {
    if (!q) return recentJobs;
    return recentJobs.filter((r) => {
      return (
        safeStr(r.checkoutId).toLowerCase().includes(q) ||
        safeStr(r.customerName).toLowerCase().includes(q) ||
        safeStr(r.cartPreview).toLowerCase().includes(q) ||
        safeStr(r.status).toLowerCase().includes(q) ||
        safeStr(r.callOutcome).toLowerCase().includes(q) ||
        safeStr(r.nextActionText).toLowerCase().includes(q) ||
        safeStr(r.summaryText).toLowerCase().includes(q) ||
        r.tags.some((t) => safeStr(t).toLowerCase().includes(q))
      );
    });
  }, [recentJobs, q]);

  const filteredCheckouts = React.useMemo(() => {
    if (!q) return allCheckouts;
    return allCheckouts.filter((c) => {
      return (
        safeStr(c.checkoutId).toLowerCase().includes(q) ||
        safeStr(c.customerName).toLowerCase().includes(q) ||
        safeStr(c.cartPreview).toLowerCase().includes(q) ||
        safeStr(c.status).toLowerCase().includes(q) ||
        safeStr(c.phone).toLowerCase().includes(q) ||
        safeStr(c.email).toLowerCase().includes(q) ||
        safeStr(c.callStatus).toLowerCase().includes(q) ||
        safeStr(c.callOutcome).toLowerCase().includes(q) ||
        safeStr(c.aiStatus).toLowerCase().includes(q)
      );
    });
  }, [allCheckouts, q]);

  React.useEffect(() => {
    if (mode !== "calls") return;
    if (!filteredJobs.find((r) => r.id === selectedId)) {
      setSelectedId(filteredJobs?.[0]?.id ?? null);
    }
  }, [filteredJobs, selectedId, mode]);

  const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  const headerCell: React.CSSProperties = {
    position: "sticky",
    top: 0,
    background: "white",
    zIndex: 1,
    borderBottom: "1px solid rgba(0,0,0,0.08)",
    padding: "10px 10px",
    fontSize: 12,
    fontWeight: 1000,
    color: "rgba(17,24,39,0.55)",
    whiteSpace: "nowrap",
  };

  const cell: React.CSSProperties = {
    padding: "10px 10px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    verticalAlign: "top",
    fontSize: 13,
    fontWeight: 900,
    color: "rgba(17,24,39,0.78)",
  };

  const [isNarrow, setIsNarrow] = React.useState(false);
  React.useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 1180);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const pageWrap: React.CSSProperties = { padding: 16, minWidth: 0 };

  const selectedKeyQuotes = selected ? parseTextList(selected.sb?.key_quotes, selected.sb?.key_quotes_text, 6) : [];
  const selectedObjections = selected ? parseTextList(selected.sb?.objections, selected.sb?.objections_text, 8) : [];
  const selectedIssues = selected ? parseTextList(selected.sb?.issues_to_fix, selected.sb?.issues_to_fix_text, 8) : [];

  return (
    <div style={pageWrap}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>7-day snapshot</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill title="Shop">{shop}</Pill>
            <Pill title="Currency">{currency}</Pill>
            <Pill title="Provider">{vapiConfigured ? "Vapi ready" : "Sim mode"}</Pill>
            {stats.callingNow > 0 ? <Pill tone="blue" title="Calls in progress">{stats.callingNow} calling</Pill> : null}
            {stats.queuedCalls > 0 ? <Pill tone="amber" title="Calls queued">{stats.queuedCalls} queued</Pill> : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <SoftButton type="button" tone={mode === "calls" ? "primary" : "ghost"} onClick={() => setMode("calls")}>
            Calls view
          </SoftButton>
          <SoftButton type="button" tone={mode === "checkouts" ? "primary" : "ghost"} onClick={() => setMode("checkouts")}>
            All checkouts
          </SoftButton>
        </div>
      </div>

      {/* KPIs */}
      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: isNarrow ? "1fr" : "repeat(6, minmax(0, 1fr))",
          gap: 12,
        }}
      >
        <StatCard label="Open" value={stats.openCount7d} sub="Created in last 7 days" icon="🟨" />
        <StatCard label="Abandoned" value={stats.abandonedCount7d} sub="Abandoned in last 7 days" icon="🛒" />
        <StatCard label="Recovered" value={stats.convertedCount7d} sub="Converted in last 7 days" icon="✅" />
        <StatCard label="Potential revenue" value={money(stats.potentialRevenue7d)} sub="Sum of abandoned carts" icon="€" />
        <StatCard label="Calls queued" value={stats.queuedCalls} sub="Ready to dial" icon="☎" />
        <StatCard label="Completed calls" value={stats.completedCalls7d} sub="Finished in last 7 days" icon="✓" />
      </div>

      {/* Toolbar */}
      <div
        style={{
          marginTop: 14,
          border: "1px solid rgba(0,0,0,0.08)",
          background: "white",
          borderRadius: 16,
          padding: 12,
          boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Form method="post">
            <input type="hidden" name="intent" value="run_jobs" />
            <SoftButton type="submit" tone="primary" style={{ padding: "10px 12px" }}>
              Run queued jobs →
            </SoftButton>
          </Form>

          <Pill title="Auto dial status">{vapiConfigured ? "Auto dial enabled" : "Auto dial disabled"}</Pill>

          <SoftButton type="button" onClick={() => revalidator.revalidate()} style={{ padding: "10px 12px" }} title="Force refresh now">
            Refresh
          </SoftButton>

          <SoftButton
            type="button"
            onClick={() => setQuery("")}
            disabled={!query}
            style={!query ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            Clear
          </SoftButton>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "rgba(0,0,0,0.02)",
              borderRadius: 12,
              padding: "8px 10px",
              minWidth: 280,
            }}
          >
            <span style={{ fontWeight: 1000, color: "rgba(17,24,39,0.45)" }}>⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={mode === "calls" ? "Search calls..." : "Search checkouts..."}
              style={{
                border: "none",
                outline: "none",
                background: "transparent",
                width: "100%",
                fontWeight: 900,
                color: "rgba(17,24,39,0.85)",
              }}
            />
          </div>

          <Pill title="Rows">{mode === "calls" ? filteredJobs.length : filteredCheckouts.length}</Pill>
        </div>
      </div>

      {mode === "checkouts" ? (
        /* ========================= CHECKOUTS TABLE ========================= */
        <div
          style={{
            marginTop: 12,
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 16,
            overflow: "hidden",
            background: "white",
            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
            minWidth: 0,
          }}
        >
          <div style={{ maxHeight: 650, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1320 }}>
              <thead>
                <tr>
                  <th style={headerCell}>Checkout</th>
                  <th style={headerCell}>Status</th>
                  <th style={headerCell}>Customer</th>
                  <th style={headerCell}>Phone</th>
                  <th style={headerCell}>Value</th>
                  <th style={headerCell}>Cart</th>
                  <th style={headerCell}>Updated</th>
                  <th style={headerCell}>Call</th>
                  <th style={headerCell}>AI</th>
                  <th style={headerCell}>Outcome</th>
                  <th style={headerCell}>Buy</th>
                  <th style={headerCell}>Recording</th>
                </tr>
              </thead>
              <tbody>
                {filteredCheckouts.map((c) => (
                  <tr key={c.checkoutId} style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                    <td style={{ ...cell, color: "rgba(30,58,138,0.95)" }}>{c.checkoutId}</td>
                    <td style={cell}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <CheckoutStatusPill status={c.status} />
                        {c.abandonedAt ? <Pill title="Abandoned at">{formatWhen(c.abandonedAt)}</Pill> : null}
                      </div>
                    </td>
                    <td style={cell}>{c.customerName ?? "-"}</td>
                    <td style={cell}>{c.phone ?? "-"}</td>
                    <td style={cell}>
                      {c.value} {c.currency}
                    </td>
                    <td style={{ ...cell, maxWidth: 320 }}>
                      <span
                        title={c.cartPreview ?? ""}
                        style={{
                          display: "inline-block",
                          maxWidth: 320,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontWeight: 900,
                        }}
                      >
                        {c.cartPreview ?? "-"}
                      </span>
                    </td>
                    <td style={cell}>{formatWhen(c.updatedAt)}</td>
                    <td style={cell}>{c.callStatus ? <StatusPill status={c.callStatus} /> : <Pill>—</Pill>}</td>
                    <td style={cell}>
                      <AiStatusPill status={c.aiStatus} err={null} />
                    </td>
                    <td style={cell}>
                      <OutcomePill outcome={c.callOutcome} />
                    </td>
                    <td style={cell}>
                      <BuyPill pct={c.buyProbabilityPct} />
                    </td>
                    <td style={cell}>
                      {c.recordingUrl ? (
                        <a href={c.recordingUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                          <SoftButton type="button" tone="primary">
                            Open
                          </SoftButton>
                        </a>
                      ) : (
                        <SoftButton type="button" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                          Open
                        </SoftButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* ========================= CALLS VIEW ========================= */
        <div
          style={{
            marginTop: 12,
            display: "grid",
            gridTemplateColumns: isNarrow ? "1fr" : "minmax(0, 1fr) 420px",
            gap: 12,
            alignItems: "start",
            minWidth: 0,
          }}
        >
          {/* Table */}
          <div
            style={{
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: 16,
              overflow: "hidden",
              background: "white",
              boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
              minWidth: 0,
            }}
          >
            <div style={{ maxHeight: 520, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180 }}>
                <thead>
                  <tr>
                    <th style={headerCell}>Checkout</th>
                    <th style={headerCell}>Customer</th>
                    <th style={headerCell}>Cart</th>
                    <th style={headerCell}>Status</th>
                    <th style={headerCell}>AI</th>
                    <th style={headerCell}>Outcome</th>
                    <th style={headerCell}>Scheduled</th>
                    <th style={headerCell}>Attempts</th>
                    <th style={headerCell}>Answered</th>
                    <th style={headerCell}>Disposition</th>
                    <th style={headerCell}>Buy</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredJobs.map((j) => {
                    const isSelected = j.id === selectedId;
                    return (
                      <tr
                        key={j.id}
                        onClick={() => setSelectedId(j.id)}
                        style={{
                          background: isSelected ? "rgba(59,130,246,0.06)" : "white",
                          cursor: "pointer",
                        }}
                      >
                        <td style={{ ...cell, color: "rgba(30,58,138,0.95)" }}>{j.checkoutId}</td>
                        <td style={cell}>{j.customerName ?? "-"}</td>

                        <td style={{ ...cell, maxWidth: 260 }}>
                          <span
                            title={j.cartPreview ?? ""}
                            style={{
                              display: "inline-block",
                              maxWidth: 260,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              fontWeight: 900,
                            }}
                          >
                            {j.cartPreview ?? "-"}
                          </span>
                        </td>

                        <td style={cell}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <StatusPill status={j.status} />
                            {j.sentiment ? <Pill title="Sentiment">{j.sentiment.toUpperCase()}</Pill> : null}
                          </div>
                        </td>

                        <td style={cell}>
                          <AiStatusPill status={j.sb?.ai_status ?? null} err={j.sb?.ai_error ?? null} />
                        </td>

                        <td style={cell}>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                            <OutcomePill outcome={j.callOutcome} />
                            {j.humanIntervention === true ? <Pill tone="amber" title="Needs human takeover">HUMAN</Pill> : null}
                            {j.discountSuggest === true ? <Pill tone="blue" title="AI suggests discount">DISC</Pill> : null}
                          </div>
                        </td>

                        <td style={cell}>
                          <div style={{ display: "grid", gap: 4 }}>
                            <div style={{ fontWeight: 1000 }}>{formatWhen(j.scheduledFor)}</div>
                            <div style={{ fontSize: 11, fontWeight: 900, color: "rgba(17,24,39,0.40)" }}>
                              Created {formatWhen(j.createdAt)}
                            </div>
                          </div>
                        </td>

                        <td style={cell}>{j.attempts}</td>
                        <td style={cell}>
                          <AnsweredPill answered={j.answeredFlag} />
                        </td>
                        <td style={cell}>
                          <DispositionPill d={j.disposition} />
                        </td>
                        <td style={cell}>
                          <BuyPill pct={j.buyProbabilityPct} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Details drawer */}
          <div
            style={{
              position: isNarrow ? "relative" : "sticky",
              top: isNarrow ? undefined : 12,
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: 16,
              background: "white",
              overflow: "hidden",
              minWidth: 0,
              width: isNarrow ? "100%" : 420,
              justifySelf: "stretch",
              boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
            }}
          >
            <div style={{ padding: 14, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 1000, color: "rgba(17,24,39,0.80)" }}>Call intelligence</div>
                  <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>
                    {selected ? `Created ${formatWhen(selected.createdAt)}` : "Select a row"}
                  </div>
                </div>

                {selected ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <StatusPill status={selected.status} />
                    <OutcomePill outcome={selected.callOutcome} />
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ padding: 14, display: "grid", gap: 12 }}>
              {!selected ? (
                <div style={{ color: "rgba(17,24,39,0.45)", fontWeight: 950 }}>
                  Select a job to see AI outcome, next step, objections, and follow-up.
                </div>
              ) : (
                <>
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Key</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Pill title="Checkout ID">{selected.checkoutId}</Pill>

                      {selected.providerCallId ? <Pill title="Vapi call id">{selected.providerCallId.slice(0, 14)}…</Pill> : null}
                      {selected.sb?.call_job_id ? <Pill title="call_job_id">{String(selected.sb.call_job_id).slice(0, 12)}…</Pill> : null}

                      {selected.sb?.latest_status ? <Pill title="Latest status">{String(selected.sb.latest_status)}</Pill> : null}
                      {selected.endedReason ? <Pill title="Ended reason">{selected.endedReason}</Pill> : null}

                      <AiStatusPill status={selected.sb?.ai_status ?? null} err={selected.sb?.ai_error ?? null} />
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {selected.sb?.received_at ? <Pill title="received_at">{formatWhen(selected.sb.received_at)}</Pill> : null}
                      {selected.sb?.last_received_at ? <Pill title="last_received_at">{formatWhen(selected.sb.last_received_at)}</Pill> : null}
                      {selected.sb?.ai_processed_at ? <Pill title="ai_processed_at">{formatWhen(selected.sb.ai_processed_at)}</Pill> : null}
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Signals</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <AnsweredPill answered={selected.answeredFlag} />
                      <DispositionPill d={selected.disposition} />
                      <BuyPill pct={selected.buyProbabilityPct} />
                      {selected.sentiment ? <Pill title="Sentiment">{selected.sentiment.toUpperCase()}</Pill> : null}
                      {selected.humanIntervention === true ? <Pill tone="amber">HUMAN TAKEOVER</Pill> : null}
                      {selected.discountSuggest === true ? (
                        <Pill tone="blue" title={selected.discountPercent != null ? `Suggest ${selected.discountPercent}%` : ""}>
                          DISCOUNT SUGGESTED
                        </Pill>
                      ) : null}
                      {selected.sb?.voicemail === true ? <Pill tone="amber" title="Voicemail detected">VOICEMAIL</Pill> : null}
                      {selected.sb?.customer_intent ? <Pill title="customer_intent">{String(selected.sb.customer_intent)}</Pill> : null}
                    </div>

                    {selected.tags.length ? (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {selected.tags.slice(0, 12).map((t) => (
                          <Pill key={t} title="Tag">
                            {t}
                          </Pill>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Summary</div>
                    <div
                      style={{
                        border: "1px solid rgba(0,0,0,0.10)",
                        borderRadius: 14,
                        padding: 10,
                        fontWeight: 900,
                        color: "rgba(17,24,39,0.78)",
                        lineHeight: 1.35,
                        background: "rgba(0,0,0,0.02)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {selected.summaryText ?? "—"}
                    </div>

                    {selectedKeyQuotes.length ? (
                      <div
                        style={{
                          border: "1px solid rgba(0,0,0,0.10)",
                          borderRadius: 14,
                          padding: 10,
                          fontWeight: 900,
                          color: "rgba(17,24,39,0.78)",
                          background: "white",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.35,
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 1000, color: "rgba(17,24,39,0.45)", marginBottom: 6 }}>KEY QUOTES</div>
                        {selectedKeyQuotes.slice(0, 6).map((qq) => `• ${qq}`).join("\n")}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Recommended next action</div>
                    <div
                      style={{
                        border: "1px solid rgba(59,130,246,0.20)",
                        borderRadius: 14,
                        padding: 10,
                        fontWeight: 950,
                        color: "rgba(30,58,138,0.92)",
                        lineHeight: 1.35,
                        background: "rgba(59,130,246,0.06)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {selected.nextActionText ?? "—"}
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Suggested follow-up (email)</div>
                    <div
                      style={{
                        border: "1px solid rgba(0,0,0,0.10)",
                        borderRadius: 14,
                        padding: 10,
                        fontWeight: 900,
                        color: "rgba(17,24,39,0.78)",
                        lineHeight: 1.35,
                        background: "white",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {selected.followUpText ?? "—"}
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <SoftButton
                        type="button"
                        onClick={() => copy(selected.followUpText ?? "")}
                        disabled={!selected.followUpText}
                        style={!selected.followUpText ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                      >
                        Copy follow-up
                      </SoftButton>

                      {selected.sb?.human_intervention_reason ? (
                        <SoftButton type="button" onClick={() => copy(String(selected.sb?.human_intervention_reason ?? ""))}>
                          Copy human reason
                        </SoftButton>
                      ) : null}

                      {selected.recordingUrl ? (
                        <a href={selected.recordingUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                          <SoftButton type="button" tone="primary">
                            Open recording
                          </SoftButton>
                        </a>
                      ) : (
                        <SoftButton type="button" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                          Open recording
                        </SoftButton>
                      )}
                    </div>
                  </div>

                  {/* Objections / Issues */}
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Objections / Issues</div>
                    <div style={{ display: "grid", gap: 8 }}>
                      <div
                        style={{
                          border: "1px solid rgba(0,0,0,0.10)",
                          borderRadius: 14,
                          padding: 10,
                          fontWeight: 900,
                          color: "rgba(17,24,39,0.78)",
                          background: "rgba(0,0,0,0.02)",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.35,
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 1000, color: "rgba(17,24,39,0.45)", marginBottom: 6 }}>OBJECTIONS</div>
                        {selectedObjections.length ? selectedObjections.slice(0, 8).join("\n") : "—"}
                      </div>

                      <div
                        style={{
                          border: "1px solid rgba(0,0,0,0.10)",
                          borderRadius: 14,
                          padding: 10,
                          fontWeight: 900,
                          color: "rgba(17,24,39,0.78)",
                          background: "rgba(0,0,0,0.02)",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.35,
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 1000, color: "rgba(17,24,39,0.45)", marginBottom: 6 }}>ISSUES TO FIX</div>
                        {selectedIssues.length ? selectedIssues.slice(0, 8).join("\n") : "—"}
                      </div>
                    </div>
                  </div>

                  {/* Transcript / report */}
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Transcript / Report</div>

                    <div
                      style={{
                        border: "1px solid rgba(0,0,0,0.10)",
                        borderRadius: 14,
                        padding: 10,
                        fontWeight: 900,
                        color: "rgba(17,24,39,0.78)",
                        background: "white",
                        whiteSpace: "pre-wrap",
                        lineHeight: 1.35,
                        maxHeight: 160,
                        overflow: "auto",
                      }}
                    >
                      {selected.sb?.transcript || selected.transcript || "—"}
                    </div>

                    {selected.sb?.end_of_call_report ? (
                      <div
                        style={{
                          border: "1px solid rgba(0,0,0,0.10)",
                          borderRadius: 14,
                          padding: 10,
                          fontWeight: 900,
                          color: "rgba(17,24,39,0.78)",
                          background: "rgba(0,0,0,0.02)",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.35,
                          maxHeight: 160,
                          overflow: "auto",
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 1000, color: "rgba(17,24,39,0.45)", marginBottom: 6 }}>
                          END OF CALL REPORT
                        </div>
                        {String(selected.sb.end_of_call_report)}
                      </div>
                    ) : null}
                  </div>

                  {/* Manual */}
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Manual</div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="manual_call" />
                      <input type="hidden" name="callJobId" value={selected.id} />
                      <button
                        type="submit"
                        disabled={selected.status !== "QUEUED"}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 12,
                          border: "1px solid rgba(0,0,0,0.12)",
                          background: selected.status === "QUEUED" ? "white" : "#f3f3f3",
                          cursor: selected.status === "QUEUED" ? "pointer" : "not-allowed",
                          fontWeight: 1000,
                          width: "100%",
                        }}
                      >
                        Call now
                      </button>
                    </Form>
                  </div>

                  {/* Raw payloads */}
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>AI raw</div>
                    <div
                      style={{
                        border: "1px solid rgba(0,0,0,0.10)",
                        borderRadius: 14,
                        padding: 10,
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        fontSize: 11,
                        fontWeight: 900,
                        color: "rgba(17,24,39,0.65)",
                        background: "rgba(0,0,0,0.02)",
                        maxHeight: 200,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {selected.sb
                        ? JSON.stringify(
                            {
                              // status
                              ai_status: selected.sb.ai_status,
                              ai_error: selected.sb.ai_error,
                              ai_processed_at: selected.sb.ai_processed_at,

                              // join keys
                              shop: selected.sb.shop,
                              checkout_id: selected.sb.checkout_id,
                              call_job_id: selected.sb.call_job_id,
                              call_id: selected.sb.call_id,

                              // timestamps
                              received_at: selected.sb.received_at,
                              last_received_at: selected.sb.last_received_at,

                              // call state
                              latest_status: selected.sb.latest_status,
                              ended_reason: selected.sb.ended_reason,

                              // links
                              recording_url: selected.sb.recording_url,
                              stereo_recording_url: selected.sb.stereo_recording_url,
                              log_url: selected.sb.log_url,

                              // signals
                              answered: selected.sb.answered,
                              voicemail: selected.sb.voicemail,
                              sentiment: selected.sb.sentiment,
                              tone: selected.sb.tone,
                              buy_probability: selected.sb.buy_probability,
                              customer_intent: selected.sb.customer_intent,
                              disposition: selected.sb.disposition,
                              call_outcome: selected.sb.call_outcome,

                              // text
                              summary: selected.sb.summary,
                              summary_clean: selected.sb.summary_clean,
                              next_best_action: selected.sb.next_best_action,
                              best_next_action: selected.sb.best_next_action,
                              follow_up_message: selected.sb.follow_up_message,

                              // lists
                              tags: selected.sb.tags,
                              tagcsv: selected.sb.tagcsv,
                              key_quotes: selected.sb.key_quotes,
                              key_quotes_text: selected.sb.key_quotes_text,
                              objections: selected.sb.objections,
                              objections_text: selected.sb.objections_text,
                              issues_to_fix: selected.sb.issues_to_fix,
                              issues_to_fix_text: selected.sb.issues_to_fix_text,

                              // escalation / discount
                              human_intervention: selected.sb.human_intervention,
                              human_intervention_reason: selected.sb.human_intervention_reason,
                              discount_suggest: selected.sb.discount_suggest,
                              discount_percent: selected.sb.discount_percent,
                              discount_rationale: selected.sb.discount_rationale,

                              // payloads
                              structured_outputs: selected.sb.structured_outputs,
                              payload: selected.sb.payload,
                              ai_result: selected.sb.ai_result,
                              ai_insights: selected.sb.ai_insights,
                            },
                            null,
                            2
                          )
                        : "—"}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, fontWeight: 900, fontSize: 12, color: "rgba(17,24,39,0.45)" }}>
        {vapiConfigured ? "Live updates every 5s when calls are active." : "Vapi not configured in ENV. Calls can run in sim mode."}
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
