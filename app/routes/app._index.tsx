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

    // legacy
    outcome?: string | null;

    // enriched UI fields
    endedReason?: string | null;
    recordingUrl?: string | null;
    sentiment?: string | null;
    tagsCsv?: string | null;
    reason?: string | null;
    nextAction?: string | null;
    followUp?: string | null;
    transcript?: string | null;

    customerName?: string | null;
    cartPreview?: string | null;
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

function StatusBadge({ status }: { status: string }) {
  const s = String(status || "").toUpperCase();

  const tone = (() => {
    if (s === "COMPLETED") return { bg: "rgba(16,185,129,0.12)", bd: "rgba(16,185,129,0.35)", tx: "#065f46" };
    if (s === "CALLING") return { bg: "rgba(59,130,246,0.12)", bd: "rgba(59,130,246,0.35)", tx: "#1e3a8a" };
    if (s === "QUEUED") return { bg: "rgba(245,158,11,0.12)", bd: "rgba(245,158,11,0.35)", tx: "#92400e" };
    if (s === "FAILED") return { bg: "rgba(239,68,68,0.12)", bd: "rgba(239,68,68,0.35)", tx: "#7f1d1d" };
    if (s === "CANCELED") return { bg: "rgba(107,114,128,0.12)", bd: "rgba(107,114,128,0.35)", tx: "#111827" };
    return { bg: "rgba(0,0,0,0.06)", bd: "rgba(0,0,0,0.14)", tx: "#111827" };
  })();

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        border: `1px solid ${tone.bd}`,
        background: tone.bg,
        color: tone.tx,
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: 0.2,
        whiteSpace: "nowrap",
      }}
    >
      {s}
    </span>
  );
}

function SentimentPill({ sentiment }: { sentiment: "positive" | "neutral" | "negative" }) {
  const t =
    sentiment === "positive"
      ? { bg: "rgba(16,185,129,0.10)", bd: "rgba(16,185,129,0.30)", tx: "#065f46", label: "Positive" }
      : sentiment === "negative"
        ? { bg: "rgba(239,68,68,0.10)", bd: "rgba(239,68,68,0.30)", tx: "#7f1d1d", label: "Negative" }
        : { bg: "rgba(107,114,128,0.10)", bd: "rgba(107,114,128,0.30)", tx: "#111827", label: "Neutral" };

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
        fontWeight: 700,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {t.label}
    </span>
  );
}

function TagPill({ tag }: { tag: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid rgba(0,0,0,0.10)",
        background: "rgba(0,0,0,0.04)",
        fontSize: 12,
        color: "rgba(0,0,0,0.75)",
        whiteSpace: "nowrap",
      }}
    >
      {tag}
    </span>
  );
}

function MiniLabel({ children }: { children: any }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "rgba(0,0,0,0.55)",
        fontWeight: 700,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function SoftButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" }) {
  const tone = props.tone ?? "ghost";
  const base: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "white",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  };

  const styles =
    tone === "primary"
      ? {
          ...base,
          border: "1px solid rgba(59,130,246,0.35)",
          background: "rgba(59,130,246,0.10)",
        }
      : base;

  const { tone: _tone, style, ...rest } = props as any;
  return <button {...rest} style={{ ...styles, ...(style ?? {}) }} />;
}

function CallOutcomeCard(props: {
  job: LoaderData["recentJobs"][number];
}) {
  const j = props.job;

  const sentiment = cleanSentiment(j.sentiment);
  const tags = splitTags(j.tagsCsv);

  const hasSummary =
    Boolean(sentiment) ||
    Boolean(j.reason) ||
    Boolean(j.nextAction) ||
    Boolean(j.followUp) ||
    Boolean(j.recordingUrl) ||
    Boolean(j.transcript) ||
    Boolean(j.endedReason);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  // Friendly status text when not completed
  if (String(j.status).toUpperCase() === "CALLING") {
    return (
      <div
        style={{
          border: "1px solid rgba(59,130,246,0.20)",
          background: "rgba(59,130,246,0.06)",
          borderRadius: 14,
          padding: 12,
          minWidth: 360,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13 }}>Call in progress</div>
          {j.providerCallId ? (
            <span style={{ fontSize: 12, color: "rgba(0,0,0,0.55)", fontWeight: 700 }}>
              Call ID: {String(j.providerCallId).slice(0, 10)}…
            </span>
          ) : null}
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(0,0,0,0.60)" }}>
          Waiting for the end-of-call report from Vapi.
        </div>
      </div>
    );
  }

  if (String(j.status).toUpperCase() === "QUEUED") {
    return (
      <div
        style={{
          border: "1px solid rgba(245,158,11,0.22)",
          background: "rgba(245,158,11,0.06)",
          borderRadius: 14,
          padding: 12,
          minWidth: 360,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 13 }}>Queued</div>
        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(0,0,0,0.60)" }}>
          Scheduled for {formatWhen(j.scheduledFor)}.
        </div>
      </div>
    );
  }

  if (String(j.status).toUpperCase() === "FAILED") {
    return (
      <div
        style={{
          border: "1px solid rgba(239,68,68,0.22)",
          background: "rgba(239,68,68,0.06)",
          borderRadius: 14,
          padding: 12,
          minWidth: 360,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 13 }}>Failed</div>
        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(0,0,0,0.65)" }}>
          {j.outcome ? String(j.outcome) : "Unknown error"}
        </div>
      </div>
    );
  }

  // COMPLETED or other: show structured summary (never raw JSON)
  if (!hasSummary) {
    return (
      <div
        style={{
          border: "1px solid rgba(0,0,0,0.10)",
          background: "rgba(0,0,0,0.03)",
          borderRadius: 14,
          padding: 12,
          minWidth: 360,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 13 }}>Completed</div>
        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(0,0,0,0.60)" }}>
          No summary available yet.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.10)",
        background: "white",
        borderRadius: 14,
        padding: 12,
        minWidth: 420,
        boxShadow: "0 1px 0 rgba(0,0,0,0.02)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 900, fontSize: 13 }}>Call summary</div>
            {sentiment ? <SentimentPill sentiment={sentiment} /> : null}
            {tags.length ? (
              <span style={{ fontSize: 12, color: "rgba(0,0,0,0.55)", fontWeight: 700 }}>
                {tags.length} tag{tags.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {tags.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {tags.map((t) => (
                <TagPill key={t} tag={t} />
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {j.recordingUrl ? (
            <a
              href={String(j.recordingUrl)}
              target="_blank"
              rel="noreferrer"
              style={{
                textDecoration: "none",
              }}
            >
              <SoftButton type="button" tone="primary">
                Recording
              </SoftButton>
            </a>
          ) : null}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {j.reason ? (
          <div style={{ marginBottom: 12 }}>
            <MiniLabel>What happened</MiniLabel>
            <div style={{ fontSize: 13, color: "rgba(0,0,0,0.80)", lineHeight: 1.45 }}>
              {String(j.reason)}
            </div>
          </div>
        ) : null}

        {j.nextAction ? (
          <div
            style={{
              borderRadius: 12,
              border: "1px solid rgba(59,130,246,0.20)",
              background: "rgba(59,130,246,0.06)",
              padding: 10,
              marginBottom: 12,
            }}
          >
            <MiniLabel>Recommended next action</MiniLabel>
            <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(0,0,0,0.85)", lineHeight: 1.45 }}>
              {String(j.nextAction)}
            </div>
          </div>
        ) : null}

        {j.followUp ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <MiniLabel>Suggested follow-up message</MiniLabel>
              <SoftButton type="button" onClick={() => copy(String(j.followUp))}>
                Copy
              </SoftButton>
            </div>
            <div
              style={{
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.10)",
                background: "rgba(0,0,0,0.03)",
                padding: 10,
                fontSize: 13,
                color: "rgba(0,0,0,0.80)",
                whiteSpace: "pre-wrap",
                lineHeight: 1.45,
              }}
            >
              {String(j.followUp)}
            </div>
          </div>
        ) : null}

        <details style={{ marginTop: 10 }}>
          <summary
            style={{
              cursor: "pointer",
              userSelect: "none",
              fontWeight: 800,
              fontSize: 12,
              color: "rgba(0,0,0,0.70)",
              listStyle: "none",
              outline: "none",
            }}
          >
            Details
          </summary>

          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {j.endedReason ? (
              <div>
                <MiniLabel>End reason</MiniLabel>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,0.75)" }}>{String(j.endedReason)}</div>
              </div>
            ) : null}

            {j.transcript ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <MiniLabel>Transcript</MiniLabel>
                  <SoftButton type="button" onClick={() => copy(String(j.transcript))}>
                    Copy
                  </SoftButton>
                </div>
                <pre
                  style={{
                    margin: 0,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(0,0,0,0.03)",
                    padding: 10,
                    fontSize: 12,
                    color: "rgba(0,0,0,0.80)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.45,
                    maxHeight: 220,
                    overflow: "auto",
                  }}
                >
                  {String(j.transcript)}
                </pre>
              </div>
            ) : null}

            {j.outcome ? (
              <div>
                <MiniLabel>System outcome</MiniLabel>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,0.65)" }}>{String(j.outcome)}</div>
              </div>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
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
        outcome: true,

        // summary fields (UI)
        endedReason: true,
        transcript: true,
        recordingUrl: true,
        sentiment: true,
        tagsCsv: true,
        reason: true,
        nextAction: true,
        followUp: true,
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
          data: {
            status: "CALLING",
            outcome: "VAPI_CALL_STARTED",
          },
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
            "Missing Vapi ENV (VAPI_API_KEY/VAPI_ASSISTANT_ID/VAPI_PHONE_NUMBER_ID)",
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
              <s-text as="h3" variant="headingSm">
                Abandoned checkouts
              </s-text>
              <s-text as="p" variant="headingLg">
                {stats.abandonedCount7d}
              </s-text>
              <s-text as="p" variant="bodySm" tone="subdued">
                Last 7 days (DB)
              </s-text>
            </s-stack>
          </s-card>

          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">
                Potential revenue
              </s-text>
              <s-text as="p" variant="headingLg">
                {money(stats.potentialRevenue7d)}
              </s-text>
              <s-text as="p" variant="bodySm" tone="subdued">
                Last 7 days (DB)
              </s-text>
            </s-stack>
          </s-card>

          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">
                Calls queued
              </s-text>
              <s-text as="p" variant="headingLg">
                {stats.queuedCalls}
              </s-text>
              <s-text as="p" variant="bodySm" tone="subdued">
                Ready to dial
              </s-text>
            </s-stack>
          </s-card>

          <s-card padding="base">
            <s-stack gap="tight">
              <s-text as="h3" variant="headingSm">
                Completed calls
              </s-text>
              <s-text as="p" variant="headingLg">
                {stats.completedCalls7d}
              </s-text>
              <s-text as="p" variant="bodySm" tone="subdued">
                Last 7 days (DB)
              </s-text>
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
                  fontWeight: 600,
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
            <s-text as="p" tone="subdued">
              No call jobs yet.
            </s-text>
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
                      <StatusBadge status={j.status} />
                    </s-table-cell>
                    <s-table-cell>{formatWhen(j.scheduledFor)}</s-table-cell>
                    <s-table-cell>{j.attempts}</s-table-cell>

                    <s-table-cell>
                      <CallOutcomeCard job={j} />
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
                            fontWeight: 600,
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
