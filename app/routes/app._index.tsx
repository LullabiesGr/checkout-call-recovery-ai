// app/routes/app._index.tsx
import * as React from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  ensureSettings,
  markAbandonedByDelay,
  syncAbandonedCheckoutsFromShopify,
  enqueueCallJobs,
} from "../callRecovery.server";
import { createVapiCallForJob } from "../callProvider.server";

/* =========================
   Types (Prisma + Supabase)
   ========================= */

type SupabaseCallSummary = {
  id?: string;
  shop?: string | null;

  call_id: string;
  call_job_id?: string | null;
  checkout_id?: string | null;

  received_at?: string | null;
  last_received_at?: string | null;
  ai_processed_at?: string | null;

  latest_status?: string | null;
  ended_reason?: string | null;

  recording_url?: string | null;
  stereo_recording_url?: string | null;
  log_url?: string | null;

  transcript?: string | null;
  end_of_call_report?: string | null;

  call_outcome?: string | null;
  disposition?: string | null;

  answered?: boolean | null;
  voicemail?: boolean | null;

  sentiment?: string | null;
  tone?: string | null;
  buy_probability?: number | null;
  customer_intent?: string | null;

  tags?: any;
  tagcsv?: string | null;

  summary?: string | null;
  summary_clean?: string | null;

  next_best_action?: string | null;
  best_next_action?: string | null;

  follow_up_message?: string | null;

  key_quotes?: any;
  key_quotes_text?: string | null;

  objections?: any;
  objections_text?: string | null;

  issues_to_fix?: any;
  issues_to_fix_text?: string | null;

  human_intervention?: boolean | null;
  human_intervention_reason?: string | null;

  discount_suggest?: boolean | null;
  discount_percent?: number | null;
  discount_rationale?: string | null;

  ai_status?: string | null;
  ai_error?: string | null;

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

  outcome?: string | null;

  sb?: SupabaseCallSummary | null;

  answeredFlag: "answered" | "no_answer" | "unknown";
  disposition:
    | "interested"
    | "needs_support"
    | "call_back_later"
    | "not_interested"
    | "wrong_number"
    | "unknown";
  sentiment: "positive" | "neutral" | "negative" | null;
  buyProbabilityPct: number | null;
  tags: string[];
  summaryText: string | null;
  nextActionText: string | null;
  followUpText: string | null;
  callOutcome: string | null;
  humanIntervention: boolean | null;
  discountSuggest: boolean | null;
  discountPercent: number | null;
  isRecovered: boolean;
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

  callJobId: string | null;
  callStatus: string | null;
  callScheduledFor: string | null;
  callAttempts: number | null;
  providerCallId: string | null;
  recordingUrl: string | null;

  callOutcome: string | null;
  sentiment: string | null;
  buyProbabilityPct: number | null;
  disposition: string | null;
  aiStatus: string | null;

  isRecovered: boolean;
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
  return (
    Boolean(apiKey) &&
    Boolean(assistantId) &&
    Boolean(phoneNumberId) &&
    Boolean(serverUrl)
  );
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

function isRecoveredFromOutcome(outcome: string | null | undefined) {
  const s = safeStr(outcome).toLowerCase();
  if (!s) return false;
  return s.includes("recovered") || s.includes("converted") || s.includes("paid");
}

function toCallOutcomeTone(
  outcome: string | null
): "green" | "amber" | "red" | "neutral" {
  const s = safeStr(outcome).toLowerCase();
  if (!s) return "neutral";
  if (s.includes("recovered") || s.includes("converted") || s.includes("paid"))
    return "green";
  if (s.includes("needs_followup")) return "amber";
  if (s.includes("voicemail") || s.includes("no_answer")) return "amber";
  if (
    s.includes("not_recovered") ||
    s.includes("wrong_number") ||
    s.includes("not_interested")
  )
    return "red";
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
  if (Array.isArray(v))
    return v.map((x) => safeStr(x)).filter(Boolean).slice(0, max);
  if (typeof v === "string" && v.trim())
    return v
      .split(/\r?\n|,/g)
      .map((x) => safeStr(x))
      .filter(Boolean)
      .slice(0, max);
  if (fallbackText && fallbackText.trim())
    return fallbackText
      .split(/\r?\n|,/g)
      .map((x) => safeStr(x))
      .filter(Boolean)
      .slice(0, max);
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
   Supabase REST fetch
   ========================= */

function uniq(values: string[]) {
  const s = new Set(values.map((x) => x.trim()).filter(Boolean));
  return Array.from(s);
}

function cleanIdList(values: string[]) {
  return uniq(values).map((x) => x.replace(/[,"'()]/g, ""));
}

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

  const callIds = cleanIdList(opts.callIds ?? []);
  const callJobIds = cleanIdList(opts.callJobIds ?? []);
  const checkoutIds = cleanIdList(opts.checkoutIds ?? []);

  if (callIds.length === 0 && callJobIds.length === 0 && checkoutIds.length === 0) {
    return out;
  }

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

  const orParts: string[] = [];
  if (callIds.length) orParts.push(`call_id.in.(${callIds.join(",")})`);
  if (callJobIds.length) orParts.push(`call_job_id.in.(${callJobIds.join(",")})`);
  if (checkoutIds.length) orParts.push(`checkout_id.in.(${checkoutIds.join(",")})`);

  const params = new URLSearchParams();
  params.set("select", select);
  params.set("or", `(${orParts.join(",")})`);

  const withShopParams = new URLSearchParams(params);
  withShopParams.set("shop", `eq.${shop}`);

  async function doFetch(p: URLSearchParams) {
    const endpoint = `${url}/rest/v1/vapi_call_summaries?${p.toString()}`;
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
      return null as any;
    }

    const data = (await r.json()) as SupabaseCallSummary[];
    return Array.isArray(data) ? data : [];
  }

  let data = await doFetch(withShopParams);

  if (data && data.length === 0) {
    data = await doFetch(params);
  }

  for (const row of data || []) {
    if (!row) continue;
    if (row.call_id) out.set(`call:${String(row.call_id)}`, row);
    if (row.call_job_id) out.set(`job:${String(row.call_job_id)}`, row);
    if (row.checkout_id) out.set(`co:${String(row.checkout_id)}`, row);
  }

  return out;
}

/* =========================
   UI primitives
   ========================= */

function Pill(props: {
  children: any;
  tone?: "neutral" | "green" | "blue" | "amber" | "red";
  title?: string;
}) {
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

function SoftButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "primary" | "ghost" | "dark";
  }
) {
  const tone = props.tone ?? "ghost";
  const base: React.CSSProperties = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.10)",
    cursor: "pointer",
    fontWeight: 950,
    fontSize: 13,
    lineHeight: 1,
    color: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(6px)",
  };

  const styles =
    tone === "primary"
      ? {
          ...base,
          background: "rgba(59,130,246,0.92)",
          border: "1px solid rgba(59,130,246,0.35)",
        }
      : tone === "dark"
      ? {
          ...base,
          background: "rgba(0,0,0,0.35)",
          border: "1px solid rgba(255,255,255,0.12)",
        }
      : base;

  const { tone: _tone, style, ...rest } = props as any;
  return <button {...rest} style={{ ...styles, ...(style ?? {}) }} />;
}

function SmallStatusDot({ tone }: { tone: "green" | "blue" | "amber" | "red" | "neutral" }) {
  const c =
    tone === "green"
      ? "rgba(16,185,129,1)"
      : tone === "blue"
      ? "rgba(59,130,246,1)"
      : tone === "amber"
      ? "rgba(245,158,11,1)"
      : tone === "red"
      ? "rgba(239,68,68,1)"
      : "rgba(156,163,175,1)";
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: c,
        boxShadow: "0 0 0 3px rgba(255,255,255,0.08)",
        display: "inline-block",
      }}
    />
  );
}

function statusToneFromJobStatus(status: string): "green" | "blue" | "amber" | "red" | "neutral" {
  const s = safeStr(status).toUpperCase();
  if (s === "COMPLETED") return "green";
  if (s === "CALLING") return "blue";
  if (s === "QUEUED") return "amber";
  if (s === "FAILED") return "red";
  return "neutral";
}

function SummaryCard(props: {
  title: string;
  value: string;
  subtitle?: string;
  accent?: "green" | "blue" | "amber" | "red" | "neutral";
}) {
  const a = props.accent ?? "neutral";
  const border =
    a === "green"
      ? "rgba(16,185,129,0.30)"
      : a === "blue"
      ? "rgba(59,130,246,0.30)"
      : a === "amber"
      ? "rgba(245,158,11,0.30)"
      : a === "red"
      ? "rgba(239,68,68,0.30)"
      : "rgba(0,0,0,0.12)";

  const bar =
    a === "green"
      ? "rgba(16,185,129,0.90)"
      : a === "blue"
      ? "rgba(59,130,246,0.90)"
      : a === "amber"
      ? "rgba(245,158,11,0.90)"
      : a === "red"
      ? "rgba(239,68,68,0.90)"
      : "rgba(17,24,39,0.30)";

  return (
    <div
      style={{
        border: `1px solid ${border}`,
        background: "white",
        borderRadius: 12,
        overflow: "hidden",
        minWidth: 0,
        boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
      }}
    >
      <div style={{ padding: 12, display: "grid", gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(17,24,39,0.55)" }}>
          {props.title}
        </div>
        <div style={{ fontSize: 26, fontWeight: 1150, color: "rgba(17,24,39,0.92)" }}>
          {props.value}
        </div>
        {props.subtitle ? (
          <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>
            {props.subtitle}
          </div>
        ) : null}
      </div>
      <div style={{ height: 6, background: "rgba(0,0,0,0.04)" }}>
        <div style={{ height: 6, width: "55%", background: bar }} />
      </div>
    </div>
  );
}

function PipelineBar(props: {
  abandoned: number;
  eligible: number;
  queued: number;
  calling: number;
  recovered: number;
}) {
  const items = [
    { k: "Abandoned", v: props.abandoned, bg: "rgba(249,115,22,0.92)" },
    { k: "Eligible", v: props.eligible, bg: "rgba(34,197,94,0.92)" },
    { k: "Queued", v: props.queued, bg: "rgba(59,130,246,0.92)" },
    { k: "Calling", v: props.calling, bg: "rgba(14,165,233,0.92)" },
    { k: "Recovered", v: props.recovered, bg: "rgba(16,185,129,0.92)" },
  ];

  return (
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.10)",
        borderRadius: 12,
        overflow: "hidden",
        background: "white",
        boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
      }}
    >
      <div style={{ padding: 12, fontSize: 13, fontWeight: 1100, color: "rgba(17,24,39,0.85)" }}>
        Recovery Pipeline
      </div>
      <div style={{ display: "flex", width: "100%" }}>
        {items.map((it) => (
          <div
            key={it.k}
            style={{
              flex: 1,
              background: it.bg,
              padding: "12px 12px",
              color: "rgba(255,255,255,0.95)",
              minWidth: 0,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 950, opacity: 0.92 }}>{it.k}</div>
            <div style={{ marginTop: 2, fontSize: 16, fontWeight: 1150 }}>{it.v}</div>
          </div>
        ))}
      </div>
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
    db.checkout.aggregate({
      where: { shop, status: "ABANDONED", abandonedAt: { gte: since } },
      _sum: { value: true },
    }),
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
    const isRecovered =
      isRecoveredFromOutcome(callOutcome) || safeStr(j.outcome).toLowerCase().includes("recovered");

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
        typeof sb?.discount_percent === "number" && Number.isFinite(sb.discount_percent)
          ? Math.round(sb.discount_percent)
          : null,
      isRecovered,
    };
  });

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

    const callOutcome = sb?.call_outcome ? String(sb.call_outcome) : null;
    const isRecovered =
      String(c.status ?? "").toUpperCase() === "CONVERTED" || isRecoveredFromOutcome(callOutcome);

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

      callOutcome,
      sentiment: sb?.sentiment ? String(sb.sentiment) : sb?.tone ? String(sb.tone) : null,
      buyProbabilityPct:
        typeof sb?.buy_probability === "number" && Number.isFinite(sb.buy_probability)
          ? Math.round(sb.buy_probability)
          : null,
      disposition: sb?.disposition ? String(sb.disposition) : null,
      aiStatus: sb?.ai_status ? String(sb.ai_status) : null,

      isRecovered,
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

  const redirectBack = () =>
    new Response(null, { status: 303, headers: { Location: "/app" } });

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
        data: {
          status: "CALLING",
          attempts: { increment: 1 },
          provider: vapiOk ? "vapi" : "sim",
          outcome: null,
        },
      });
      if (locked.count === 0) continue;

      if (!vapiOk) {
        await db.callJob.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            outcome: `SIMULATED_CALL_OK phone=${job.phone}`,
          },
        });
        continue;
      }

      try {
        await createVapiCallForJob({ shop, callJobId: job.id });
        await db.callJob.update({
          where: { id: job.id },
          data: { status: "CALLING", outcome: "VAPI_CALL_STARTED" },
        });
      } catch (e: any) {
        const maxAttempts = settings.maxAttempts ?? 2;
        const fresh = await db.callJob.findUnique({
          where: { id: job.id },
          select: { attempts: true },
        });
        const attemptsAfter = Number(fresh?.attempts ?? 0);

        if (attemptsAfter >= maxAttempts) {
          await db.callJob.update({
            where: { id: job.id },
            data: {
              status: "FAILED",
              outcome: `ERROR: ${String(e?.message ?? e)}`,
            },
          });
        } else {
          const retryMinutes = settings.retryMinutes ?? 180;
          const next = new Date(Date.now() + retryMinutes * 60 * 1000);
          await db.callJob.update({
            where: { id: job.id },
            data: {
              status: "QUEUED",
              scheduledFor: next,
              outcome: `RETRY_SCHEDULED in ${retryMinutes}m`,
            },
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
        data: {
          outcome:
            "Missing Vapi ENV (VAPI_API_KEY/VAPI_ASSISTANT_ID/VAPI_PHONE_NUMBER_ID/VAPI_SERVER_URL)",
        },
      });
      return redirectBack();
    }

    const locked = await db.callJob.updateMany({
      where: { id: callJobId, shop, status: "QUEUED" },
      data: {
        status: "CALLING",
        attempts: { increment: 1 },
        provider: "vapi",
        outcome: null,
      },
    });
    if (locked.count === 0) return redirectBack();

    try {
      await createVapiCallForJob({ shop, callJobId });
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: { status: "CALLING", outcome: "VAPI_CALL_STARTED" },
      });
    } catch (e: any) {
      const settings = await ensureSettings(shop);
      const maxAttempts = settings.maxAttempts ?? 2;

      const fresh = await db.callJob.findUnique({
        where: { id: callJobId },
        select: { attempts: true },
      });
      const attemptsAfter = Number(fresh?.attempts ?? 0);

      if (attemptsAfter >= maxAttempts) {
        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: {
            status: "FAILED",
            outcome: `ERROR: ${String(e?.message ?? e)}`,
          },
        });
      } else {
        const retryMinutes = settings.retryMinutes ?? 180;
        const next = new Date(Date.now() + retryMinutes * 60 * 1000);
        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: {
            status: "QUEUED",
            scheduledFor: next,
            outcome: `RETRY_SCHEDULED in ${retryMinutes}m`,
          },
        });
      }
    }

    return redirectBack();
  }

  return redirectBack();
};

/* =========================
   UI (single layout, no inner sidebar)
   ========================= */

export default function Dashboard() {
  const { shop, stats, recentJobs, currency, vapiConfigured } =
    useLoaderData<typeof loader>();

  const revalidator = useRevalidator();

  React.useEffect(() => {
    const active = stats.callingNow > 0 || stats.queuedCalls > 0;
    if (!active) return;

    const id = window.setInterval(() => {
      revalidator.revalidate();
    }, 5000);

    return () => window.clearInterval(id);
  }, [stats.callingNow, stats.queuedCalls, revalidator]);

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);

  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    if (!q) return recentJobs;
    return recentJobs.filter((r) => {
      return (
        safeStr(r.checkoutId).toLowerCase().includes(q) ||
        safeStr(r.customerName).toLowerCase().includes(q) ||
        safeStr(r.cartPreview).toLowerCase().includes(q) ||
        safeStr(r.status).toLowerCase().includes(q) ||
        safeStr(r.callOutcome).toLowerCase().includes(q) ||
        safeStr(r.summaryText).toLowerCase().includes(q) ||
        safeStr(r.nextActionText).toLowerCase().includes(q) ||
        r.tags.some((t) => safeStr(t).toLowerCase().includes(q))
      );
    });
  }, [recentJobs, q]);

  const topReasons = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of recentJobs) {
      for (const t of (r.tags || []).slice(0, 12)) {
        const key = safeStr(t).trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [recentJobs]);

  const liveActivity = React.useMemo(() => {
    return recentJobs.slice(0, 6);
  }, [recentJobs]);

  const headerWrap: React.CSSProperties = {
    borderRadius: 14,
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,0.12)",
    boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
    background:
      "linear-gradient(180deg, rgba(15,23,42,0.96), rgba(2,6,23,0.96))",
  };

  const page: React.CSSProperties = {
    padding: 14,
    minWidth: 0,
  };

  const gridTop: React.CSSProperties = {
    marginTop: 12,
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    gap: 12,
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 1150,
    color: "rgba(17,24,39,0.88)",
  };

  const card: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.10)",
    borderRadius: 12,
    background: "white",
    boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
    overflow: "hidden",
    minWidth: 0,
  };

  const tableHead: React.CSSProperties = {
    position: "sticky",
    top: 0,
    zIndex: 1,
    background: "white",
    borderBottom: "1px solid rgba(0,0,0,0.10)",
    padding: "10px 10px",
    fontSize: 12,
    fontWeight: 1100,
    color: "rgba(17,24,39,0.55)",
    whiteSpace: "nowrap",
  };

  const td: React.CSSProperties = {
    padding: "10px 10px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    verticalAlign: "top",
    fontSize: 13,
    fontWeight: 900,
    color: "rgba(17,24,39,0.78)",
  };

  const isNarrow = typeof window !== "undefined" ? window.innerWidth < 1100 : false;

  return (
    <div style={page}>
      <div style={headerWrap}>
        <div
          style={{
            padding: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: "rgba(34,197,94,0.18)",
                border: "1px solid rgba(34,197,94,0.25)",
                display: "grid",
                placeItems: "center",
                fontWeight: 1150,
                color: "rgba(255,255,255,0.90)",
              }}
              title="Shopify embedded app"
            >
              S
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 1200,
                  color: "rgba(255,255,255,0.92)",
                  letterSpacing: -0.2,
                }}
              >
                Checkout Recovery Dashboard
              </div>
              <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.55)" }}>
                {shop} • {vapiConfigured ? "Vapi enabled" : "Sim mode"} • Live refresh {stats.callingNow > 0 || stats.queuedCalls > 0 ? "ON" : "OFF"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <SoftButton
              tone="dark"
              type="button"
              onClick={() => revalidator.revalidate()}
              title="Sync now"
            >
              Sync now
            </SoftButton>

            <Form method="post">
              <input type="hidden" name="intent" value="run_jobs" />
              <SoftButton tone="primary" type="submit" title="Create test call (runs queued jobs)">
                Create Test Call
              </SoftButton>
            </Form>

            <SoftButton tone="dark" type="button" title="Menu" onClick={() => {}}>
              ⋯
            </SoftButton>
          </div>
        </div>
      </div>

      <div style={gridTop}>
        <SummaryCard
          title="Recovered Revenue"
          value={money(stats.potentialRevenue7d)}
          subtitle="/7d potential"
          accent="green"
        />
        <SummaryCard
          title="Recovered Checkouts"
          value={String(stats.convertedCount7d)}
          subtitle="/7d"
          accent="green"
        />
        <SummaryCard
          title="Calls in Progress"
          value={`${stats.callingNow}`}
          subtitle={stats.callingNow > 0 ? "Live" : "Idle"}
          accent="blue"
        />
        <SummaryCard
          title="Queued Calls"
          value={`${stats.queuedCalls}`}
          subtitle="Ready to dial"
          accent={stats.queuedCalls > 0 ? "amber" : "neutral"}
        />
        <SummaryCard
          title="Answer Rate"
          value={
            (() => {
              const answered = recentJobs.filter((r) => r.answeredFlag === "answered").length;
              const known = recentJobs.filter((r) => r.answeredFlag !== "unknown").length;
              if (known === 0) return "—";
              const pct = Math.round((answered / known) * 100);
              return `${pct}%`;
            })()
          }
          subtitle="From recent calls"
          accent="blue"
        />
        <SummaryCard
          title="Avg Attempts"
          value={
            (() => {
              if (recentJobs.length === 0) return "—";
              const avg = recentJobs.reduce((a, r) => a + Number(r.attempts ?? 0), 0) / recentJobs.length;
              return `${avg.toFixed(1)}`;
            })()
          }
          subtitle="Recent jobs"
          accent="neutral"
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <PipelineBar
          abandoned={stats.abandonedCount7d}
          eligible={stats.abandonedCount7d}
          queued={stats.queuedCalls}
          calling={stats.callingNow}
          recovered={stats.convertedCount7d}
        />
      </div>

      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: isNarrow ? "1fr" : "minmax(0, 1fr) 360px",
          gap: 12,
          alignItems: "start",
        }}
      >
        <div style={card}>
          <div
            style={{
              padding: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
              borderBottom: "1px solid rgba(0,0,0,0.08)",
            }}
          >
            <div style={sectionTitle}>Recent Calls</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "rgba(0,0,0,0.02)",
                  borderRadius: 10,
                  padding: "8px 10px",
                  minWidth: 260,
                }}
              >
                <span style={{ fontWeight: 1100, color: "rgba(17,24,39,0.45)" }}>⌕</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
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

              <Pill title="Rows">{filtered.length}</Pill>

              <button
                type="button"
                onClick={() => setQuery("")}
                disabled={!query}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "white",
                  cursor: query ? "pointer" : "not-allowed",
                  fontWeight: 950,
                  fontSize: 12,
                  opacity: query ? 1 : 0.55,
                }}
              >
                Clear
              </button>
            </div>
          </div>

          <div style={{ maxHeight: 520, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={tableHead}>Checkout</th>
                  <th style={tableHead}>Customer</th>
                  <th style={tableHead}>Cart</th>
                  <th style={tableHead}>Status</th>
                  <th style={tableHead}>Outcome</th>
                  <th style={tableHead}>Buy</th>
                  <th style={tableHead}>Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const statusTone = statusToneFromJobStatus(r.status);
                  const outcomeTone = toCallOutcomeTone(r.callOutcome);
                  return (
                    <tr
                      key={r.id}
                      style={{
                        background: r.isRecovered
                          ? "linear-gradient(90deg, rgba(16,185,129,0.12), rgba(16,185,129,0.02) 60%, rgba(255,255,255,1) 100%)"
                          : "white",
                      }}
                    >
                      <td style={{ ...td, color: "rgba(30,58,138,0.95)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 1150 }}>{r.checkoutId}</span>
                          {r.isRecovered ? <Pill tone="green">RECOVERED</Pill> : null}
                        </div>
                      </td>

                      <td style={td}>
                        <div style={{ display: "grid", gap: 6 }}>
                          <div style={{ fontWeight: 1150 }}>{r.customerName ?? "-"}</div>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <Pill tone={r.answeredFlag === "answered" ? "green" : r.answeredFlag === "no_answer" ? "amber" : "neutral"}>
                              {r.answeredFlag === "answered" ? "Answered" : r.answeredFlag === "no_answer" ? "No answer" : "Unknown"}
                            </Pill>
                            <Pill tone={r.disposition === "interested" ? "green" : r.disposition === "call_back_later" ? "amber" : r.disposition === "needs_support" ? "blue" : r.disposition === "not_interested" || r.disposition === "wrong_number" ? "red" : "neutral"}>
                              {r.disposition.replace(/_/g, " ").toUpperCase()}
                            </Pill>
                          </div>
                        </div>
                      </td>

                      <td style={{ ...td, maxWidth: 360 }}>
                        <span
                          title={r.cartPreview ?? ""}
                          style={{
                            display: "inline-block",
                            maxWidth: 360,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            fontWeight: 900,
                          }}
                        >
                          {r.cartPreview ?? "-"}
                        </span>
                      </td>

                      <td style={td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <SmallStatusDot tone={statusTone} />
                            <span style={{ fontWeight: 1100 }}>{safeStr(r.status).toUpperCase()}</span>
                          </span>
                          {r.sb?.ai_status ? (
                            <Pill
                              tone={
                                safeStr(r.sb.ai_status).toLowerCase() === "done"
                                  ? "green"
                                  : safeStr(r.sb.ai_status).toLowerCase() === "processing"
                                  ? "blue"
                                  : safeStr(r.sb.ai_status).toLowerCase() === "pending"
                                  ? "amber"
                                  : safeStr(r.sb.ai_status).toLowerCase() === "error"
                                  ? "red"
                                  : "neutral"
                              }
                              title={r.sb?.ai_error ?? ""}
                            >
                              AI: {safeStr(r.sb.ai_status).toUpperCase()}
                            </Pill>
                          ) : (
                            <Pill>AI: —</Pill>
                          )}
                        </div>
                      </td>

                      <td style={td}>
                        <Pill tone={outcomeTone} title="AI outcome">
                          {r.callOutcome ? safeStr(r.callOutcome).toUpperCase() : "—"}
                        </Pill>
                      </td>

                      <td style={td}>
                        <Pill
                          tone={
                            r.buyProbabilityPct == null
                              ? "neutral"
                              : r.buyProbabilityPct >= 70
                              ? "green"
                              : r.buyProbabilityPct >= 40
                              ? "amber"
                              : "red"
                          }
                        >
                          {r.buyProbabilityPct == null ? "—" : `${r.buyProbabilityPct}%`}
                        </Pill>
                      </td>

                      <td style={td}>
                        <div style={{ display: "grid", gap: 4 }}>
                          <div style={{ fontWeight: 1100 }}>{formatWhen(r.scheduledFor)}</div>
                          <div style={{ fontSize: 11, fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>
                            Created {formatWhen(r.createdAt)}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {filtered.length === 0 ? (
                  <tr>
                    <td style={{ padding: 14, color: "rgba(17,24,39,0.55)", fontWeight: 950 }} colSpan={7}>
                      No rows
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <div style={card}>
            <div
              style={{
                padding: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                borderBottom: "1px solid rgba(0,0,0,0.08)",
              }}
            >
              <div style={sectionTitle}>Live Activity</div>
              <button
                type="button"
                onClick={() => revalidator.revalidate()}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 950,
                  fontSize: 12,
                }}
              >
                Refresh
              </button>
            </div>

            <div style={{ padding: 10, display: "grid", gap: 10 }}>
              {liveActivity.map((r) => {
                const t = statusToneFromJobStatus(r.status);
                const label =
                  safeStr(r.status).toUpperCase() === "CALLING"
                    ? "Calling"
                    : safeStr(r.status).toUpperCase() === "COMPLETED"
                    ? "Ended"
                    : safeStr(r.status).toUpperCase() === "QUEUED"
                    ? "Queued"
                    : safeStr(r.status).toUpperCase() === "FAILED"
                    ? "Failed"
                    : safeStr(r.status).toUpperCase();

                return (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: 10,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(0,0,0,0.02)",
                    }}
                  >
                    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <SmallStatusDot tone={t} />
                        <div style={{ fontWeight: 1150, color: "rgba(17,24,39,0.90)" }}>
                          {label} • {safeStr(r.checkoutId)}
                        </div>
                      </div>
                      <div style={{ fontWeight: 900, color: "rgba(17,24,39,0.60)", fontSize: 12 }}>
                        {r.customerName ?? "-"} • {formatWhen(r.createdAt)}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {r.callOutcome ? (
                        <Pill tone={toCallOutcomeTone(r.callOutcome)}>{safeStr(r.callOutcome).toUpperCase()}</Pill>
                      ) : (
                        <Pill>—</Pill>
                      )}
                      {r.isRecovered ? <Pill tone="green">RECOVERED</Pill> : null}
                    </div>
                  </div>
                );
              })}

              {liveActivity.length === 0 ? (
                <div style={{ padding: 10, color: "rgba(17,24,39,0.55)", fontWeight: 950 }}>
                  No activity
                </div>
              ) : null}
            </div>
          </div>

          <div style={card}>
            <div style={{ padding: 12, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
              <div style={sectionTitle}>Top Reasons (AI)</div>
            </div>

            <div style={{ padding: 12, display: "grid", gap: 10 }}>
              {topReasons.map(([tag, count]) => {
                const pretty = tag.replace(/_/g, " ");
                return (
                  <div
                    key={tag}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: 10,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "white",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <div
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 999,
                          border: "1px solid rgba(0,0,0,0.10)",
                          background: "rgba(59,130,246,0.08)",
                          display: "grid",
                          placeItems: "center",
                          fontWeight: 1150,
                          color: "rgba(30,58,138,0.92)",
                        }}
                      >
                        i
                      </div>
                      <div style={{ fontWeight: 1100, color: "rgba(17,24,39,0.85)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {pretty}
                      </div>
                    </div>
                    <Pill title="Count">{count}</Pill>
                  </div>
                );
              })}

              {topReasons.length === 0 ? (
                <div style={{ padding: 10, color: "rgba(17,24,39,0.55)", fontWeight: 950 }}>
                  No tags yet
                </div>
              ) : null}
            </div>
          </div>

          <div style={card}>
            <div style={{ padding: 12, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
              <div style={sectionTitle}>Controls</div>
            </div>
            <div style={{ padding: 12, display: "grid", gap: 10 }}>
              <Form method="post">
                <input type="hidden" name="intent" value="run_jobs" />
                <button
                  type="submit"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(59,130,246,0.25)",
                    background: "rgba(59,130,246,0.10)",
                    cursor: "pointer",
                    fontWeight: 1100,
                  }}
                >
                  Run queued jobs
                </button>
              </Form>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Pill title="Provider">{vapiConfigured ? "Vapi ready" : "Sim mode"}</Pill>
                <Pill title="Queued">{stats.queuedCalls}</Pill>
                <Pill title="Calling">{stats.callingNow}</Pill>
                <Pill title="Completed (7d)">{stats.completedCalls7d}</Pill>
              </div>

              <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(17,24,39,0.55)", lineHeight: 1.4 }}>
                ENV required: VAPI_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID, VAPI_SERVER_URL.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
