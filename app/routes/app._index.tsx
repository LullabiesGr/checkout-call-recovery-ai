// app/routes/app._index.tsx
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

type Row = {
  id: string;
  checkoutId: string;
  status: string;
  scheduledFor: string;
  createdAt: string;
  attempts: number;

  customerName?: string | null;
  cartPreview?: string | null;

  // raw fields
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

  // derived UI
  answered: "answered" | "no_answer" | "unknown";
  disposition:
    | "interested"
    | "needs_support"
    | "call_back_later"
    | "not_interested"
    | "wrong_number"
    | "unknown";
  buyProbability: number | null; // 0..1
  churnProbability: number | null; // 0..1
  tags: string[];
  summaryReason: string | null;
  summaryNextAction: string | null;
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

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function clamp01(n: number) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function stripFences(s: string) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  if (t.startsWith("```")) return t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  return t;
}

function tryParseJsonObject(s: string): any | null {
  const raw = stripFences(String(s ?? "").trim());
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
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
}

function cleanSentiment(v?: string | null) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "positive" || s === "neutral" || s === "negative") return s as any;
  return null;
}

function splitTags(csv?: string | null): string[] {
  const raw = String(csv ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeTag(t: string) {
  return String(t ?? "").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
}

function deriveFromJob(j: any): Pick<
  Row,
  "answered" | "disposition" | "buyProbability" | "churnProbability" | "tags" | "summaryReason" | "summaryNextAction"
> {
  const aj = j.analysisJson ? tryParseJsonObject(j.analysisJson) : null;
  const fromReason = !aj && j.reason ? tryParseJsonObject(j.reason) : null;
  const fromOutcome = !aj && !fromReason && j.outcome ? tryParseJsonObject(j.outcome) : null;
  const obj = aj ?? fromReason ?? fromOutcome;

  const sentiment = cleanSentiment(obj?.sentiment ?? j.sentiment);
  const rawTags: string[] = Array.isArray(obj?.tags)
    ? obj.tags.map((x: any) => normalizeTag(x)).filter(Boolean).slice(0, 12)
    : splitTags(j.tagsCsv).map(normalizeTag).filter(Boolean).slice(0, 12);

  const reason =
    typeof obj?.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : j.reason && !tryParseJsonObject(j.reason)
        ? String(j.reason).trim()
        : null;

  const nextAction =
    typeof obj?.nextAction === "string" && obj.nextAction.trim()
      ? obj.nextAction.trim()
      : j.nextAction
        ? String(j.nextAction).trim()
        : null;

  // Answered heuristic (Vapi endedReason patterns)
  const ended = String(j.endedReason ?? "").toLowerCase();
  const answered: Row["answered"] =
    ended.includes("customer-ended") || ended.includes("connected") || ended.includes("human")
      ? "answered"
      : ended.includes("no-answer") || ended.includes("voicemail") || ended.includes("busy") || ended.includes("failed")
        ? "no_answer"
        : "unknown";

  // Disposition heuristic from tags
  const has = (t: string) => rawTags.includes(t);
  const disposition: Row["disposition"] =
    has("wrong_number") ? "wrong_number" :
    has("not_interested") ? "not_interested" :
    has("call_back_later") ? "call_back_later" :
    has("needs_support") ? "needs_support" :
    sentiment === "positive" ? "interested" :
    "unknown";

  // Buy probability heuristic
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

  // If not answered, chance drops
  if (answered === "no_answer") p -= 0.20;

  p = clamp01(p);

  // Churn probability (risk of losing) heuristic
  let c = 1 - p;
  if (has("not_interested")) c = clamp01(c + 0.15);
  if (has("wrong_number")) c = 1;
  if (has("call_back_later")) c = clamp01(c - 0.08);
  if (sentiment === "positive") c = clamp01(c - 0.10);

  const buyProbability = Number.isFinite(p) ? p : null;
  const churnProbability = Number.isFinite(c) ? c : null;

  return {
    answered,
    disposition,
    buyProbability,
    churnProbability,
    tags: rawTags,
    summaryReason: reason,
    summaryNextAction: nextAction,
  };
}

function Pill(props: { children: any; tone?: "neutral" | "green" | "blue" | "amber" | "red" }) {
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
  const s = String(status || "").toUpperCase();
  const tone =
    s === "COMPLETED" ? "green" :
    s === "CALLING" ? "blue" :
    s === "QUEUED" ? "amber" :
    s === "FAILED" ? "red" :
    "neutral";
  return <Pill tone={tone as any}>{s}</Pill>;
}

function AnsweredPill({ answered }: { answered: Row["answered"] }) {
  if (answered === "answered") return <Pill tone="green">Answered</Pill>;
  if (answered === "no_answer") return <Pill tone="amber">No answer</Pill>;
  return <Pill>Unknown</Pill>;
}

function DispositionPill({ d }: { d: Row["disposition"] }) {
  if (d === "interested") return <Pill tone="green">Interested</Pill>;
  if (d === "needs_support") return <Pill tone="blue">Needs support</Pill>;
  if (d === "call_back_later") return <Pill tone="amber">Call back</Pill>;
  if (d === "not_interested") return <Pill tone="red">Not interested</Pill>;
  if (d === "wrong_number") return <Pill tone="red">Wrong number</Pill>;
  return <Pill>Unknown</Pill>;
}

function PercentPill({ label, value, tone }: { label: string; value: number | null; tone?: any }) {
  if (value == null) return <Pill>—</Pill>;
  const pct = Math.round(value * 100);
  return <Pill tone={tone}>{label} {pct}%</Pill>;
}

function ColumnHeader(props: { title: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, lineHeight: 1.1 }}>
      <div style={{ fontWeight: 900 }}>{props.title}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(0,0,0,0.55)" }}>{props.subtitle}</div>
    </div>
  );
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
      take: 15,
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
    const derived = deriveFromJob(j);
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
                  fontWeight: 900,
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

          {recentJobs.length === 0 ? (
            <s-text as="p" tone="subdued">No call jobs yet.</s-text>
          ) : (
            <s-table>
              <s-table-head>
                <s-table-row>
                  <s-table-header-cell>
                    <ColumnHeader title="Checkout" subtitle="Abandoned checkout ID" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Customer" subtitle="Name (if available)" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Cart" subtitle="Top items preview" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Status" subtitle="Pipeline state" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Timing" subtitle="Scheduled / created" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Attempts" subtitle="Times dialed" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Answered" subtitle="Customer picked up" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Disposition" subtitle="Outcome category" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Buy chance" subtitle="Estimated conversion" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Churn risk" subtitle="Risk of losing" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Next action" subtitle="What to do now" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Tags" subtitle="Detected topics" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Tools" subtitle="Recording / transcript" />
                  </s-table-header-cell>
                  <s-table-header-cell>
                    <ColumnHeader title="Manual" subtitle="Call now (queued)" />
                  </s-table-header-cell>
                </s-table-row>
              </s-table-head>

              <s-table-body>
                {recentJobs.map((j) => (
                  <s-table-row key={j.id}>
                    <s-table-cell>{j.checkoutId}</s-table-cell>

                    <s-table-cell>{j.customerName ?? "-"}</s-table-cell>

                    <s-table-cell title={j.cartPreview ?? ""}>
                      <span style={{ display: "inline-block", maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {j.cartPreview ?? "-"}
                      </span>
                    </s-table-cell>

                    <s-table-cell>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <StatusPill status={j.status} />
                        {cleanSentiment(j.sentiment) ? (
                          <Pill>
                            {String(cleanSentiment(j.sentiment)).toUpperCase()}
                          </Pill>
                        ) : null}
                      </div>
                    </s-table-cell>

                    <s-table-cell>
                      <div style={{ display: "grid", gap: 4 }}>
                        <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.65)" }}>
                          Scheduled: {formatWhen(j.scheduledFor)}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(0,0,0,0.45)" }}>
                          Created: {formatWhen(j.createdAt)}
                        </div>
                      </div>
                    </s-table-cell>

                    <s-table-cell>{j.attempts}</s-table-cell>

                    <s-table-cell>
                      <AnsweredPill answered={j.answered} />
                    </s-table-cell>

                    <s-table-cell>
                      <DispositionPill d={j.disposition} />
                    </s-table-cell>

                    <s-table-cell>
                      <PercentPill label="" value={j.buyProbability} tone="green" />
                    </s-table-cell>

                    <s-table-cell>
                      <PercentPill label="" value={j.churnProbability} tone="red" />
                    </s-table-cell>

                    <s-table-cell title={j.summaryNextAction ?? ""}>
                      {j.summaryNextAction ? (
                        <div style={{ display: "grid", gap: 6 }}>
                          <Pill tone="blue">Next</Pill>
                          <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.70)", maxWidth: 260 }}>
                            <span style={{ display: "inline-block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 }}>
                              {j.summaryNextAction}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <Pill>—</Pill>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      {j.tags.length ? (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxWidth: 220 }}>
                          {j.tags.slice(0, 4).map((t) => (
                            <Pill key={t}>{t}</Pill>
                          ))}
                          {j.tags.length > 4 ? <Pill>+{j.tags.length - 4}</Pill> : null}
                        </div>
                      ) : (
                        <Pill>—</Pill>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {j.recordingUrl ? (
                          <a href={String(j.recordingUrl)} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                            <SoftButton type="button" tone="primary">Recording</SoftButton>
                          </a>
                        ) : (
                          <SoftButton type="button" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                            Recording
                          </SoftButton>
                        )}

                        {j.transcript ? (
                          <SoftButton type="button" onClick={() => copy(String(j.transcript))}>
                            Copy transcript
                          </SoftButton>
                        ) : (
                          <SoftButton type="button" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                            Copy transcript
                          </SoftButton>
                        )}
                      </div>
                    </s-table-cell>

                    <s-table-cell>
                      <Form method="post">
                        <input type="hidden" name="intent" value="manual_call" />
                        <input type="hidden" name="callJobId" value={j.id} />
                        <button
                          type="submit"
                          disabled={j.status !== "QUEUED"}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 10,
                            border: "1px solid rgba(0,0,0,0.12)",
                            background: j.status === "QUEUED" ? "white" : "#f3f3f3",
                            cursor: j.status === "QUEUED" ? "pointer" : "not-allowed",
                            fontWeight: 900,
                          }}
                        >
                          Call now
                        </button>
                      </Form>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
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
