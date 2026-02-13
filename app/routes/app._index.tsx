// app/routes/app._index.tsx
import * as React from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  ensureSettings,
  markAbandonedByDelay,
  syncAbandonedCheckoutsFromShopify,
} from "../callRecovery.server";
import { createVapiCallForJob } from "../callProvider.server";

type Analysis = {
  sentiment?: "positive" | "neutral" | "negative";
  tags?: string[];
  reason?: string;
  nextAction?: string;
  followUp?: string;
  confidence?: number;

  // pro fields
  answered?: boolean;
  disposition?:
    | "interested"
    | "needs_support"
    | "call_back_later"
    | "not_interested"
    | "wrong_number"
    | "unknown";
  buyProbability?: number; // 0..1
  churnProbability?: number; // 0..1
  shortSummary?: string;
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

  sentiment?: string | null;
  tagsCsv?: string | null;
  reason?: string | null;
  nextAction?: string | null;
  followUp?: string | null;
  analysisJson?: string | null;

  outcome?: string | null;

  // derived
  analysis: Analysis | null;
  answered: "answered" | "no_answer" | "unknown";
  disposition:
    | "interested"
    | "needs_support"
    | "call_back_later"
    | "not_interested"
    | "wrong_number"
    | "unknown";
  buyProbability: number | null;
  churnProbability: number | null;
  tags: string[];
  summaryReason: string | null;
  summaryNextAction: string | null;
  summaryText: string | null;
};

type LoaderData = {
  shop: string;
  currency: string;
  vapiConfigured: boolean;
  stats: {
    abandonedCount7d: number;
    potentialRevenue7d: number;
    queuedCalls: number;
    completedCalls7d: number;
  };
  recentJobs: Row[];
};

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
  return Boolean(apiKey) && Boolean(assistantId) && Boolean(phoneNumberId);
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function safeStr(v: any) {
  return v == null ? "" : String(v);
}

function stripFences(s: string) {
  const t = safeStr(s).trim();
  if (!t) return "";
  if (t.startsWith("```")) return t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  return t;
}

function tryParseJsonObject(s: string): any | null {
  const raw = stripFences(safeStr(s).trim());
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const chunk = raw.slice(start, end + 1);
    try {
      const parsed2 = JSON.parse(chunk);
      if (parsed2 && typeof parsed2 === "object") return parsed2;
    } catch {}
  }

  return null;
}

function normalizeTag(t: string) {
  return safeStr(t).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
}

function splitTags(csv?: string | null): string[] {
  const raw = safeStr(csv).trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => normalizeTag(x))
    .filter(Boolean)
    .slice(0, 12);
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function cleanSentiment(v?: string | null) {
  const s = safeStr(v).trim().toLowerCase();
  if (s === "positive" || s === "neutral" || s === "negative") return s as any;
  return null;
}

function pickAnalysis(j: any): Analysis | null {
  // Priority:
  // 1) analysisJson column (preferred structured)
  // 2) outcome column if it contains JSON (your current reality)
  // 3) reason/nextAction/followUp columns if they are plain strings (not JSON blobs)

  const a1 = j.analysisJson ? tryParseJsonObject(j.analysisJson) : null;
  const a2 = !a1 && j.outcome ? tryParseJsonObject(j.outcome) : null;
  const a = a1 || a2;

  // If we have any JSON object, normalize it to Analysis
  const fromJson = (obj: any): Analysis | null => {
    if (!obj || typeof obj !== "object") return null;

    const tags = Array.isArray(obj.tags)
      ? obj.tags.map(normalizeTag).filter(Boolean).slice(0, 12)
      : [];

    const sentiment = cleanSentiment(obj.sentiment) ?? undefined;
    const confidence = typeof obj.confidence === "number" ? clamp01(obj.confidence) : undefined;

    const buyProbability =
      typeof obj.buyProbability === "number" ? clamp01(obj.buyProbability) : undefined;

    const churnProbability =
      typeof obj.churnProbability === "number" ? clamp01(obj.churnProbability) : undefined;

    const dispositionRaw = safeStr(obj.disposition).trim().toLowerCase();
    const disposition =
      ["interested","needs_support","call_back_later","not_interested","wrong_number","unknown"].includes(dispositionRaw)
        ? (dispositionRaw as any)
        : undefined;

    return {
      sentiment,
      tags,
      reason: typeof obj.reason === "string" ? obj.reason.trim() : undefined,
      nextAction: typeof obj.nextAction === "string" ? obj.nextAction.trim() : undefined,
      followUp: typeof obj.followUp === "string" ? obj.followUp.trim() : undefined,
      confidence,
      answered: typeof obj.answered === "boolean" ? obj.answered : undefined,
      disposition,
      buyProbability,
      churnProbability,
      shortSummary: typeof obj.shortSummary === "string" ? obj.shortSummary.trim() : undefined,
    };
  };

  const parsed = a ? fromJson(a) : null;

  // If no JSON found, fall back to columns (ONLY if they are plain strings)
  if (!parsed) {
    const reasonPlain =
      j.reason && !tryParseJsonObject(j.reason) ? safeStr(j.reason).trim() : "";

    const nextActionPlain =
      j.nextAction && !tryParseJsonObject(j.nextAction) ? safeStr(j.nextAction).trim() : "";

    const followUpPlain =
      j.followUp && !tryParseJsonObject(j.followUp) ? safeStr(j.followUp).trim() : "";

    const tags = splitTags(j.tagsCsv);

    const sentiment = cleanSentiment(j.sentiment) ?? undefined;

    if (!reasonPlain && !nextActionPlain && !followUpPlain && tags.length === 0 && !sentiment) {
      return null;
    }

    return {
      sentiment,
      tags,
      reason: reasonPlain || undefined,
      nextAction: nextActionPlain || undefined,
      followUp: followUpPlain || undefined,
    };
  }

  return parsed;
}


function deriveFromJob(j: any, analysis: Analysis | null) {
  const ended = safeStr(j.endedReason).toLowerCase();

  const answeredByEndedReason =
    ended.includes("customer-ended") ||
    ended.includes("connected") ||
    ended.includes("human") ||
    ended.includes("in-progress");

  const noAnswerByEndedReason =
    ended.includes("no-answer") ||
    ended.includes("voicemail") ||
    ended.includes("busy") ||
    ended.includes("failed");

  const answered: Row["answered"] =
    analysis?.answered === true || answeredByEndedReason
      ? "answered"
      : analysis?.answered === false || noAnswerByEndedReason
        ? "no_answer"
        : "unknown";

  const sentiment = cleanSentiment(analysis?.sentiment ?? j.sentiment);
  const tags =
    (analysis?.tags?.length ? analysis.tags : splitTags(j.tagsCsv))
      .map(normalizeTag)
      .filter(Boolean)
      .slice(0, 12);

  const has = (t: string) => tags.includes(t);

  const dispositionFromAnalysis = safeStr(analysis?.disposition).trim() as any;

  const disposition: Row["disposition"] =
    dispositionFromAnalysis &&
    ["interested","needs_support","call_back_later","not_interested","wrong_number","unknown"].includes(dispositionFromAnalysis)
      ? dispositionFromAnalysis
      : has("wrong_number") ? "wrong_number"
        : has("not_interested") ? "not_interested"
          : has("call_back_later") ? "call_back_later"
            : has("needs_support") ? "needs_support"
              : sentiment === "positive" ? "interested"
                : "unknown";

  // buy/churn: prefer model outputs, else fallback heuristic
  let buy =
    typeof analysis?.buyProbability === "number"
      ? clamp01(analysis.buyProbability)
      : (() => {
          let p =
            sentiment === "positive" ? 0.75 :
            sentiment === "neutral" ? 0.45 :
            sentiment === "negative" ? 0.15 :
            0.35;

          if (has("call_back_later")) p += 0.10;
          if (has("needs_support")) p += 0.05;
          if (has("coupon_request")) p += 0.08;
          if (has("shipping")) p -= 0.05;
          if (has("price")) p -= 0.10;
          if (has("trust")) p -= 0.12;
          if (has("not_interested")) p -= 0.35;
          if (has("wrong_number")) p -= 0.60;
          if (answered === "no_answer") p -= 0.20;

          return clamp01(p);
        })();

  let churn =
    typeof analysis?.churnProbability === "number"
      ? clamp01(analysis.churnProbability)
      : clamp01(1 - buy);

  const reason =
    analysis?.shortSummary?.trim()
      ? analysis.shortSummary.trim()
      : analysis?.reason?.trim()
        ? analysis.reason.trim()
        : j.reason && !tryParseJsonObject(j.reason)
          ? safeStr(j.reason).trim()
          : null;

    const nextAction =
    analysis?.nextAction?.trim()
      ? analysis.nextAction.trim()
      : j.nextAction && !tryParseJsonObject(j.nextAction)
        ? safeStr(j.nextAction).trim()
        : null;


    const summaryText =
    analysis?.followUp?.trim()
      ? analysis.followUp.trim()
      : j.followUp && !tryParseJsonObject(j.followUp)
        ? safeStr(j.followUp).trim()
        : null;


  return {
    answered,
    disposition,
    buyProbability: Number.isFinite(buy) ? buy : null,
    churnProbability: Number.isFinite(churn) ? churn : null,
    tags,
    summaryReason: reason,
    summaryNextAction: nextAction,
    summaryText,
  };
}

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
        fontWeight: 900,
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
  const tone =
    s === "COMPLETED" ? "green" :
    s === "CALLING" ? "blue" :
    s === "QUEUED" ? "amber" :
    s === "FAILED" ? "red" :
    "neutral";
  return <Pill tone={tone as any}>{s}</Pill>;
}

function AnsweredPill({ answered }: { answered: Row["answered"] }) {
  if (answered === "answered") return <Pill tone="green" title="Customer picked up / engaged">Answered</Pill>;
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

function PercentPill({ label, value, tone }: { label: string; value: number | null; tone: "green" | "red" | "blue" | "amber" }) {
  if (value == null) return <Pill title="Not available">—</Pill>;
  const pct = Math.round(clamp01(value) * 100);
  return <Pill tone={tone} title={`${label} ${pct}%`}>{pct}%</Pill>;
}

function SoftButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" }) {
  const tone = props.tone ?? "ghost";
  const base: React.CSSProperties = {
    padding: "7px 10px",
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "white",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 12,
    lineHeight: 1,
  };
  const styles =
    tone === "primary"
      ? { ...base, border: "1px solid rgba(59,130,246,0.30)", background: "rgba(59,130,246,0.08)" }
      : base;

  const { tone: _tone, style, ...rest } = props as any;
  return <button {...rest} style={{ ...styles, ...(style ?? {}) }} />;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  // pipeline (NO enqueue here)
  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
  await markAbandonedByDelay(shop, settings.delayMinutes);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    abandonedCount7d,
    potentialAgg,
    queuedCalls,
    completedCalls7d,
    recentJobs,
  ] = await Promise.all([
    db.checkout.count({
      where: { shop, status: "ABANDONED", abandonedAt: { gte: since } },
    }),
    db.checkout.aggregate({
      where: { shop, status: "ABANDONED", abandonedAt: { gte: since } },
      _sum: { value: true },
    }),
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({
      where: { shop, status: "COMPLETED", createdAt: { gte: since } },
    }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 25,
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

        sentiment: true,
        tagsCsv: true,
        reason: true,
        nextAction: true,
        followUp: true,
        analysisJson: true,

        outcome: true,
      },
    }),
  ]);

  const ids = recentJobs.map((j) => j.checkoutId);
  const related =
    ids.length === 0
      ? []
      : await db.checkout.findMany({
          where: { shop, checkoutId: { in: ids } },
          select: { checkoutId: true, customerName: true, itemsJson: true },
        });

  const cMap = new Map(related.map((c) => [c.checkoutId, c]));
  const potentialRevenue7d = Number(potentialAgg._sum.value ?? 0);

  const rows: Row[] = recentJobs.map((j: any) => {
    const c = cMap.get(j.checkoutId);
    const analysis = pickAnalysis(j);
    const derived = deriveFromJob(j, analysis);
    return {
      id: j.id,
      checkoutId: j.checkoutId,
      status: j.status,
      scheduledFor: j.scheduledFor.toISOString(),
      createdAt: j.createdAt.toISOString(),
      attempts: j.attempts,

      customerName: c?.customerName ?? null,
      cartPreview: buildCartPreview(c?.itemsJson ?? null),

      providerCallId: j.providerCallId ?? null,
      recordingUrl: j.recordingUrl ?? null,
      endedReason: j.endedReason ?? null,
      transcript: j.transcript ?? null,

      sentiment: j.sentiment ?? null,
      tagsCsv: j.tagsCsv ?? null,
      reason: j.reason ?? null,
      nextAction: j.nextAction ?? null,
      followUp: j.followUp ?? null,
      analysisJson: j.analysisJson ?? null,

      outcome: j.outcome ?? null,

      analysis,
      ...derived,
    };
  });

  return {
    shop,
    currency: settings.currency || "USD",
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats: {
      abandonedCount7d,
      potentialRevenue7d,
      queuedCalls,
      completedCalls7d,
    },
    recentJobs: rows,
  } satisfies LoaderData;
};

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
          data: { status: "COMPLETED", outcome: `SIMULATED_CALL_OK phone=${job.phone}` },
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
            data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}` },
          });
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
        data: { outcome: "Missing Vapi ENV (VAPI_API_KEY/VAPI_ASSISTANT_ID/VAPI_PHONE_NUMBER_ID)" },
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
          data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}` },
        });
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

export default function Dashboard() {
  const { shop, stats, recentJobs, currency, vapiConfigured } =
    useLoaderData<typeof loader>();

  const [selectedId, setSelectedId] = React.useState<string | null>(
    recentJobs?.[0]?.id ?? null
  );

  React.useEffect(() => {
    if (!selectedId && recentJobs?.[0]?.id) setSelectedId(recentJobs[0].id);
  }, [selectedId, recentJobs]);

  const selected = React.useMemo(
    () => recentJobs.find((r) => r.id === selectedId) ?? null,
    [recentJobs, selectedId]
  );

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);

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
    fontWeight: 950,
    color: "rgba(0,0,0,0.70)",
    whiteSpace: "nowrap",
  };

  const cell: React.CSSProperties = {
    padding: "10px 10px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    verticalAlign: "top",
    fontSize: 13,
    fontWeight: 800,
    color: "rgba(0,0,0,0.78)",
  };

  return (
    <s-page heading="Checkout Call Recovery AI">
      <s-paragraph>
        Store: <s-badge>{shop}</s-badge>
      </s-paragraph>

      <s-section heading="7-day snapshot">
        <s-inline-grid columns={{ xs: 1, sm: 2, md: 4 }} gap="base">
          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">Abandoned checkouts</s-text>
              <s-text as="p" variant="headingLg">{stats.abandonedCount7d}</s-text>
              <s-text as="p" variant="bodySm" tone="subdued">Count in last 7 days</s-text>
            </s-stack>
          </s-card>

          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">Potential revenue</s-text>
              <s-text as="p" variant="headingLg">{money(stats.potentialRevenue7d)}</s-text>
              <s-text as="p" variant="bodySm" tone="subdued">Sum of abandoned carts</s-text>
            </s-stack>
          </s-card>

          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">Calls queued</s-text>
              <s-text as="p" variant="headingLg">{stats.queuedCalls}</s-text>
              <s-text as="p" variant="bodySm" tone="subdued">Ready to dial</s-text>
            </s-stack>
          </s-card>

          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">Completed calls</s-text>
              <s-text as="p" variant="headingLg">{stats.completedCalls7d}</s-text>
              <s-text as="p" variant="bodySm" tone="subdued">Finished in last 7 days</s-text>
            </s-stack>
          </s-card>
        </s-inline-grid>
      </s-section>

      <s-section heading="Recent call jobs">
        <s-card padding="base">
          <s-stack direction="inline" gap="base" align="center">
            <Form method="post">
              <input type="hidden" name="intent" value="run_jobs" />
              <button
                type="submit"
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 950,
                }}
              >
                Run queued jobs
              </button>
            </Form>

            <s-text as="p" tone="subdued">
              {vapiConfigured
                ? "Runs due queued jobs now (real Vapi calls)."
                : "Vapi not configured in ENV. Button will simulate calls."}
            </s-text>
          </s-stack>

          <s-divider />

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(720px, 1fr) 420px",
              gap: 14,
              alignItems: "start",
            }}
          >
            {/* LEFT: TABLE (full workspace, no tiny bar) */}
            <div
              style={{
                border: "1px solid rgba(0,0,0,0.10)",
                borderRadius: 14,
                overflow: "hidden",
                background: "white",
              }}
            >
              <div style={{ maxHeight: 420, overflow: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={headerCell} title="Abandoned checkout identifier">Checkout</th>
                      <th style={headerCell} title="Customer name if available">Customer</th>
                      <th style={headerCell} title="Top cart items preview">Cart</th>
                      <th style={headerCell} title="Job state in the pipeline">Status</th>
                      <th style={headerCell} title="Scheduled time (and created time in details)">Scheduled</th>
                      <th style={headerCell} title="Times dialed / attempted">Attempts</th>
                      <th style={headerCell} title="Did the customer engage?">Answered</th>
                      <th style={headerCell} title="Outcome category (from AI + tags)">Disposition</th>
                      <th style={headerCell} title="Estimated probability of purchase">Buy</th>
                      <th style={headerCell} title="Estimated risk of losing the sale">Churn</th>
                      <th style={headerCell} title="Recommended next step">Next action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {recentJobs.map((j) => {
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
                          <td style={cell}>{j.checkoutId}</td>

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
                                fontWeight: 850,
                              }}
                            >
                              {j.cartPreview ?? "-"}
                            </span>
                          </td>

                          <td style={cell}>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <StatusPill status={j.status} />
                              {cleanSentiment(j.analysis?.sentiment ?? j.sentiment) ? (
                                <Pill title="Sentiment">{String(cleanSentiment(j.analysis?.sentiment ?? j.sentiment)).toUpperCase()}</Pill>
                              ) : null}
                            </div>
                          </td>

                          <td style={cell}>
                            <div style={{ display: "grid", gap: 4 }}>
                              <div style={{ fontWeight: 950 }}>{formatWhen(j.scheduledFor)}</div>
                              <div style={{ fontSize: 11, fontWeight: 850, color: "rgba(0,0,0,0.45)" }}>
                                Created {formatWhen(j.createdAt)}
                              </div>
                            </div>
                          </td>

                          <td style={cell}>{j.attempts}</td>

                          <td style={cell}><AnsweredPill answered={j.answered} /></td>

                          <td style={cell}><DispositionPill d={j.disposition} /></td>

                          <td style={cell}><PercentPill label="Buy" value={j.buyProbability} tone="green" /></td>

                          <td style={cell}><PercentPill label="Churn" value={j.churnProbability} tone="red" /></td>

                          <td style={{ ...cell, maxWidth: 260 }}>
                            {j.summaryNextAction ? (
                              <span
                                title={j.summaryNextAction}
                                style={{
                                  display: "inline-block",
                                  maxWidth: 260,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  fontWeight: 900,
                                }}
                              >
                                {j.summaryNextAction}
                              </span>
                            ) : (
                              <span style={{ color: "rgba(0,0,0,0.35)", fontWeight: 900 }}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* RIGHT: DETAILS PANEL */}
            <div
              style={{
                position: "sticky",
                top: 12,
                border: "1px solid rgba(0,0,0,0.10)",
                borderRadius: 14,
                background: "white",
                overflow: "hidden",
              }}
            >
              <div style={{ padding: 14, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ display: "grid", gap: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 950, color: "rgba(0,0,0,0.75)" }}>
                      Call details
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 850, color: "rgba(0,0,0,0.45)" }}>
                      {selected ? `Created ${formatWhen(selected.createdAt)}` : "Select a row"}
                    </div>
                  </div>

                  {selected ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <StatusPill status={selected.status} />
                      <AnsweredPill answered={selected.answered} />
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={{ padding: 14, display: "grid", gap: 12 }}>
                {!selected ? (
                  <div style={{ color: "rgba(0,0,0,0.45)", fontWeight: 900 }}>
                    Select a job to see summary, tags, transcript and actions.
                  </div>
                ) : (
                  <>
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(0,0,0,0.55)" }}>Key</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Pill title="Checkout ID">{selected.checkoutId}</Pill>
                        {selected.providerCallId ? <Pill title="Provider call id">{selected.providerCallId.slice(0, 14)}…</Pill> : null}
                        {selected.endedReason ? <Pill title="Why call ended">{selected.endedReason}</Pill> : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(0,0,0,0.55)" }}>Insights</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <DispositionPill d={selected.disposition} />
                        <PercentPill label="Buy" value={selected.buyProbability} tone="green" />
                        <PercentPill label="Churn" value={selected.churnProbability} tone="red" />
                        {cleanSentiment(selected.analysis?.sentiment ?? selected.sentiment) ? (
                          <Pill title="Sentiment">{String(cleanSentiment(selected.analysis?.sentiment ?? selected.sentiment)).toUpperCase()}</Pill>
                        ) : null}
                        {typeof selected.analysis?.confidence === "number" ? (
                          <Pill title="Model confidence">{Math.round(clamp01(selected.analysis.confidence) * 100)}% conf</Pill>
                        ) : null}
                      </div>

                      {selected.tags.length ? (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {selected.tags.slice(0, 10).map((t) => (
                            <Pill key={t} title="Tag">{t}</Pill>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(0,0,0,0.55)" }}>What happened</div>
                      <div
                        style={{
                          border: "1px solid rgba(0,0,0,0.10)",
                          borderRadius: 12,
                          padding: 10,
                          fontWeight: 850,
                          color: "rgba(0,0,0,0.75)",
                          lineHeight: 1.35,
                          background: "rgba(0,0,0,0.02)",
                        }}
                      >
                        {selected.summaryReason ?? "—"}
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(0,0,0,0.55)" }}>Recommended next action</div>
                      <div
                        style={{
                          border: "1px solid rgba(59,130,246,0.20)",
                          borderRadius: 12,
                          padding: 10,
                          fontWeight: 900,
                          color: "rgba(30,58,138,0.90)",
                          lineHeight: 1.35,
                          background: "rgba(59,130,246,0.06)",
                        }}
                      >
                        {selected.summaryNextAction ?? "—"}
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(0,0,0,0.55)" }}>Suggested follow-up message</div>
                      <div
                        style={{
                          border: "1px solid rgba(0,0,0,0.10)",
                          borderRadius: 12,
                          padding: 10,
                          fontWeight: 850,
                          color: "rgba(0,0,0,0.75)",
                          lineHeight: 1.35,
                          background: "white",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {selected.summaryText ?? "—"}
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <SoftButton
                          type="button"
                          onClick={() => copy(selected.summaryText ?? "")}
                          disabled={!selected.summaryText}
                          style={!selected.summaryText ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                        >
                          Copy follow-up
                        </SoftButton>

                        <SoftButton
                          type="button"
                          onClick={() => copy(selected.transcript ?? "")}
                          disabled={!selected.transcript}
                          style={!selected.transcript ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                        >
                          Copy transcript
                        </SoftButton>

                        {selected.recordingUrl ? (
                          <a href={selected.recordingUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                            <SoftButton type="button" tone="primary">Open recording</SoftButton>
                          </a>
                        ) : (
                          <SoftButton type="button" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                            Open recording
                          </SoftButton>
                        )}
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(0,0,0,0.55)" }}>Manual</div>
                      <Form method="post">
                        <input type="hidden" name="intent" value="manual_call" />
                        <input type="hidden" name="callJobId" value={selected.id} />
                        <button
                          type="submit"
                          disabled={selected.status !== "QUEUED"}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(0,0,0,0.12)",
                            background: selected.status === "QUEUED" ? "white" : "#f3f3f3",
                            cursor: selected.status === "QUEUED" ? "pointer" : "not-allowed",
                            fontWeight: 950,
                            width: "100%",
                          }}
                        >
                          Call now
                        </button>
                      </Form>
                    </div>

                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 950, color: "rgba(0,0,0,0.55)" }}>Raw</div>
                      <div
                        style={{
                          border: "1px solid rgba(0,0,0,0.10)",
                          borderRadius: 12,
                          padding: 10,
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontSize: 11,
                          fontWeight: 800,
                          color: "rgba(0,0,0,0.65)",
                          background: "rgba(0,0,0,0.02)",
                          maxHeight: 140,
                          overflow: "auto",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {selected.analysisJson ?? selected.outcome ?? "—"}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </s-card>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
