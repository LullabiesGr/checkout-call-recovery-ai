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
  recentJobs: Array<{
    id: string;
    checkoutId: string;
    status: string;
    scheduledFor: string;
    attempts: number;
    createdAt: string;

    customerName?: string | null;
    cartPreview?: string | null;

    // provider + details
    providerCallId?: string | null;
    recordingUrl?: string | null;
    endedReason?: string | null;
    transcript?: string | null;

    // structured analysis (preferred)
    sentiment?: string | null;
    tagsCsv?: string | null;
    reason?: string | null;
    nextAction?: string | null;
    followUp?: string | null;
    analysisJson?: string | null;

    // legacy
    outcome?: string | null;
  }>;
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

function cleanSentiment(v?: string | null) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "positive" || s === "neutral" || s === "negative") return s;
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

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

// ---------------- UI primitives ----------------

function Pill(props: {
  children: any;
  tone?: "neutral" | "green" | "blue" | "amber" | "red";
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
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 10px",
        borderRadius: 999,
        border: `1px solid ${t.bd}`,
        background: t.bg,
        color: t.tx,
        fontWeight: 800,
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

function SentimentPill({ sentiment }: { sentiment: "positive" | "neutral" | "negative" }) {
  const tone = sentiment === "positive" ? "green" : sentiment === "negative" ? "red" : "neutral";
  const label = sentiment === "positive" ? "Positive" : sentiment === "negative" ? "Negative" : "Neutral";
  return <Pill tone={tone as any}>{label}</Pill>;
}

function SoftButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" }) {
  const tone = props.tone ?? "ghost";
  const base: React.CSSProperties = {
    padding: "7px 10px",
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "white",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 12,
    lineHeight: 1,
  };

  const styles =
    tone === "primary"
      ? {
          ...base,
          border: "1px solid rgba(59,130,246,0.30)",
          background: "rgba(59,130,246,0.08)",
        }
      : base;

  const { tone: _tone, style, ...rest } = props as any;
  return <button {...rest} style={{ ...styles, ...(style ?? {}) }} />;
}

function KeyValueRow(props: { label: string; value: any }) {
  if (!props.value) return null;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
      <div style={{ width: 110, fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.55)" }}>
        {props.label}
      </div>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,0.82)", lineHeight: 1.45, flex: 1 }}>
        {props.value}
      </div>
    </div>
  );
}

// ---------------- Robust analysis extraction ----------------

// Vapi/OpenAI sometimes returns fenced JSON (` ```json {...} ``` `) or plain JSON string.
// This normalizes it, parses when possible, and returns structured fields.
function stripFences(s: string) {
  const t = s.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
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
    // Try to salvage: find first { ... } block
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

function deriveSummary(j: LoaderData["recentJobs"][number]) {
  // Priority: analysisJson
  const aj = j.analysisJson ? tryParseJsonObject(j.analysisJson) : null;

  // Fallback: if reason/outcome contains JSON blob (your screenshot), parse it.
  const fromReason = !aj && j.reason ? tryParseJsonObject(j.reason) : null;
  const fromOutcome = !aj && !fromReason && j.outcome ? tryParseJsonObject(j.outcome) : null;

  const obj = aj ?? fromReason ?? fromOutcome;

  const sentiment = cleanSentiment(obj?.sentiment ?? j.sentiment);
  const tags =
    Array.isArray(obj?.tags)
      ? obj.tags.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
      : splitTags(j.tagsCsv);

  const reason =
    (typeof obj?.reason === "string" && obj.reason.trim()) ? obj.reason.trim() :
    (j.reason && !tryParseJsonObject(j.reason) ? j.reason : null);

  const nextAction =
    (typeof obj?.nextAction === "string" && obj.nextAction.trim()) ? obj.nextAction.trim() :
    (j.nextAction ?? null);

  const followUp =
    (typeof obj?.followUp === "string" && obj.followUp.trim()) ? obj.followUp.trim() :
    (j.followUp ?? null);

  const confidence =
    typeof obj?.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : null;

  return { sentiment, tags, reason, nextAction, followUp, confidence };
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div
        style={{
          height: 8,
          width: 120,
          borderRadius: 999,
          background: "rgba(0,0,0,0.08)",
          overflow: "hidden",
          border: "1px solid rgba(0,0,0,0.10)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "rgba(59,130,246,0.55)",
          }}
        />
      </div>
      <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.60)" }}>{pct}%</div>
    </div>
  );
}

function SummaryDrawer({ job }: { job: LoaderData["recentJobs"][number] }) {
  const s = deriveSummary(job);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  const status = String(job.status || "").toUpperCase();

  const headline =
    status === "COMPLETED" ? "Call summary" :
    status === "CALLING" ? "Call in progress" :
    status === "QUEUED" ? "Queued" :
    status === "FAILED" ? "Failed" :
    "Details";

  const subline =
    status === "QUEUED"
      ? `Scheduled for ${formatWhen(job.scheduledFor)}`
      : status === "CALLING"
        ? "Waiting for end-of-call report"
        : status === "FAILED"
          ? "Provider error or max attempts reached"
          : `Created at ${formatWhen(job.createdAt)}`;

  const hasStructured =
    Boolean(s.sentiment) || Boolean(s.tags.length) || Boolean(s.reason) || Boolean(s.nextAction) || Boolean(s.followUp);

  return (
    <details
      style={{
        borderRadius: 14,
        border: "1px solid rgba(0,0,0,0.10)",
        background: "white",
        overflow: "hidden",
        minWidth: 420,
      }}
    >
      <summary
        style={{
          listStyle: "none",
          cursor: "pointer",
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          background: "rgba(0,0,0,0.02)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 13, fontWeight: 900 }}>{headline}</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(0,0,0,0.55)" }}>{subline}</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {status === "COMPLETED" && s.sentiment ? <SentimentPill sentiment={s.sentiment as any} /> : null}
          {status === "COMPLETED" && s.tags.length ? <Pill>{s.tags.length} tags</Pill> : null}
          <SoftButton type="button">Open</SoftButton>
        </div>
      </summary>

      <div style={{ padding: 12, display: "grid", gap: 12 }}>
        {status === "COMPLETED" && s.confidence != null ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.55)" }}>Confidence</div>
            <ConfidenceBar value={s.confidence} />
          </div>
        ) : null}

        {status === "COMPLETED" && s.tags.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {s.tags.map((t) => (
              <Pill key={t}>{t}</Pill>
            ))}
          </div>
        ) : null}

        {status === "COMPLETED" && hasStructured ? (
          <div style={{ display: "grid", gap: 10 }}>
            <KeyValueRow label="What happened" value={s.reason ? String(s.reason) : "—"} />

            {s.nextAction ? (
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(59,130,246,0.22)",
                  background: "rgba(59,130,246,0.06)",
                  padding: 10,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.55)", marginBottom: 6 }}>
                  Recommended next action
                </div>
                <div style={{ fontSize: 13, fontWeight: 900, color: "rgba(0,0,0,0.85)", lineHeight: 1.45 }}>
                  {String(s.nextAction)}
                </div>
              </div>
            ) : null}

            {s.followUp ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(0,0,0,0.55)" }}>
                    Suggested follow-up
                  </div>
                  <SoftButton type="button" onClick={() => copy(String(s.followUp))}>
                    Copy
                  </SoftButton>
                </div>
                <div
                  style={{
                    marginTop: 8,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(0,0,0,0.03)",
                    padding: 10,
                    fontSize: 13,
                    color: "rgba(0,0,0,0.82)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.45,
                  }}
                >
                  {String(s.followUp)}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ borderTop: "1px solid rgba(0,0,0,0.06)", paddingTop: 12, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {job.recordingUrl ? (
                <a href={String(job.recordingUrl)} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                  <SoftButton type="button" tone="primary">Recording</SoftButton>
                </a>
              ) : null}
              {job.providerCallId ? <Pill>Call ID: {String(job.providerCallId).slice(0, 10)}…</Pill> : null}
              {job.endedReason ? <Pill>{String(job.endedReason)}</Pill> : null}
            </div>

            {job.transcript ? (
              <SoftButton type="button" onClick={() => copy(String(job.transcript))}>Copy transcript</SoftButton>
            ) : null}
          </div>

          {job.transcript ? (
            <pre
              style={{
                margin: 0,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.10)",
                background: "rgba(0,0,0,0.03)",
                padding: 10,
                fontSize: 12,
                color: "rgba(0,0,0,0.82)",
                whiteSpace: "pre-wrap",
                lineHeight: 1.45,
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {String(job.transcript)}
            </pre>
          ) : (
            <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(0,0,0,0.55)" }}>
              Transcript not available.
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

// ---------------- loader/action ----------------

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
    recentJobs: recentJobs.map((j) => {
      const c = cMap.get(j.checkoutId);
      return {
        ...j,
        scheduledFor: j.scheduledFor.toISOString(),
        createdAt: j.createdAt.toISOString(),
        customerName: c?.customerName ?? null,
        cartPreview: buildCartPreview(c?.itemsJson ?? null),
      };
    }),
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
      where: {
        shop,
        status: "QUEUED",
        scheduledFor: { lte: now },
      },
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
              <s-text as="p" variant="bodySm" tone="subdued">Last 7 days (DB)</s-text>
            </s-stack>
          </s-card>

          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">Potential revenue</s-text>
              <s-text as="p" variant="headingLg">{money(stats.potentialRevenue7d)}</s-text>
              <s-text as="p" variant="bodySm" tone="subdued">Last 7 days (DB)</s-text>
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
              <s-text as="p" variant="bodySm" tone="subdued">Last 7 days (DB)</s-text>
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
                  fontWeight: 700,
                }}
              >
                Run queued jobs
              </button>
            </Form>

            <s-text as="p" tone="subdued">
              {vapiConfigured
                ? "Creates real Vapi calls for due queued jobs."
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
                  <s-table-header-cell>Checkout</s-table-header-cell>
                  <s-table-header-cell>Customer</s-table-header-cell>
                  <s-table-header-cell>Cart</s-table-header-cell>
                  <s-table-header-cell>Status</s-table-header-cell>
                  <s-table-header-cell>Scheduled</s-table-header-cell>
                  <s-table-header-cell>Attempts</s-table-header-cell>
                  <s-table-header-cell>Summary</s-table-header-cell>
                  <s-table-header-cell>Manual</s-table-header-cell>
                </s-table-row>
              </s-table-head>

              <s-table-body>
                {recentJobs.map((j) => (
                  <s-table-row key={j.id}>
                    <s-table-cell>{j.checkoutId}</s-table-cell>
                    <s-table-cell>{j.customerName ?? "-"}</s-table-cell>
                    <s-table-cell>{j.cartPreview ?? "-"}</s-table-cell>

                    <s-table-cell>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <StatusPill status={j.status} />
                      </div>
                    </s-table-cell>

                    <s-table-cell>{formatWhen(j.scheduledFor)}</s-table-cell>
                    <s-table-cell>{j.attempts}</s-table-cell>

                    <s-table-cell>
                      <SummaryDrawer job={j} />
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
                            fontWeight: 700,
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
