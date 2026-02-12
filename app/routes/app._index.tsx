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
  enqueueCallJobs,
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
    outcome?: string | null;

    // joined
    customerName?: string | null;
    cartPreview?: string | null;

    // analysis (optional columns)
    sentiment?: string | null;
    tagsCsv?: string | null;
    reason?: string | null;
    nextAction?: string | null;
    followUp?: string | null;
    endedReason?: string | null;
    recordingUrl?: string | null;
    transcript?: string | null;
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
  const assistantId = process.env.VAPI_ASSISTANT_ID?.trim() || "";
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID?.trim() || "";
  const apiKey = process.env.VAPI_API_KEY?.trim() || "";
  return Boolean(apiKey) && Boolean(assistantId) && Boolean(phoneNumberId);
}

function normalizeCurrency(code: string): string {
  const v = String(code || "USD").toUpperCase().trim();
  // Intl throws if invalid. Hard clamp to 3 letters A-Z.
  if (!/^[A-Z]{3}$/.test(v)) return "USD";
  return v;
}

function parseTags(tagsCsv?: string | null): string[] {
  if (!tagsCsv) return [];
  return String(tagsCsv)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function toneFromSentiment(s?: string | null): "success" | "warning" | "critical" | "info" {
  const v = String(s || "").toLowerCase();
  if (v.includes("positive") || v === "pos" || v === "yes") return "success";
  if (v.includes("negative") || v === "neg" || v === "no") return "critical";
  if (v.includes("neutral")) return "warning";
  return "info";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  // Pipeline
  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
  await markAbandonedByDelay(shop, settings.delayMinutes);

  await enqueueCallJobs({
    shop,
    enabled: settings.enabled,
    minOrderValue: settings.minOrderValue,
    callWindowStart: (settings as any).callWindowStart ?? "09:00",
    callWindowEnd: (settings as any).callWindowEnd ?? "19:00",
  });

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
      take: 20,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        attempts: true,
        createdAt: true,
        outcome: true,

        // analysis (may not exist in some envs; using "as any" at read time is OK)
        sentiment: true as any,
        tagsCsv: true as any,
        reason: true as any,
        nextAction: true as any,
        followUp: true as any,
        endedReason: true as any,
        recordingUrl: true as any,
        transcript: true as any,
      },
    }),
  ]);

  // Join Checkout => customer/cart
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
    currency: normalizeCurrency(settings.currency || "USD"),
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats: {
      abandonedCount7d,
      potentialRevenue7d,
      queuedCalls,
      completedCalls7d,
    },
    recentJobs: recentJobs.map((j: any) => {
      const c = cMap.get(j.checkoutId);
      return {
        ...j,
        scheduledFor: j.scheduledFor.toISOString(),
        createdAt: j.createdAt.toISOString(),
        customerName: c?.customerName ?? null,
        cartPreview: buildCartPreview(c?.itemsJson ?? null),
        sentiment: j.sentiment ?? null,
        tagsCsv: j.tagsCsv ?? null,
        reason: j.reason ?? null,
        nextAction: j.nextAction ?? null,
        followUp: j.followUp ?? null,
        endedReason: j.endedReason ?? null,
        recordingUrl: j.recordingUrl ?? null,
        transcript: j.transcript ?? null,
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

  // Refresh-only
  if (intent === "refresh") return redirectBack();

  // Run queued jobs
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
        } as any,
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
      } catch (e: any) {
        const attemptsAfter = (job.attempts ?? 0) + 1;
        const maxAttempts = settings.maxAttempts ?? 2;

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

  // Manual call
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

    try {
      await createVapiCallForJob({ shop, callJobId });
    } catch (e: any) {
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: { outcome: `ERROR: ${String(e?.message ?? e)}` },
      });
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
      <s-stack gap="base">
        <s-stack direction="inline" gap="base" align="center">
          <s-paragraph>
            Store: <s-badge>{shop}</s-badge>
          </s-paragraph>

          <Form method="post">
            <input type="hidden" name="intent" value="refresh" />
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
              Refresh
            </button>
          </Form>
        </s-stack>

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
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 10px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: 12, opacity: 0.7 }}>
                      <th style={{ padding: "0 10px" }}>Checkout</th>
                      <th style={{ padding: "0 10px" }}>Customer</th>
                      <th style={{ padding: "0 10px" }}>Cart</th>
                      <th style={{ padding: "0 10px" }}>Status</th>
                      <th style={{ padding: "0 10px" }}>Scheduled</th>
                      <th style={{ padding: "0 10px" }}>Result</th>
                      <th style={{ padding: "0 10px" }}>Tags</th>
                      <th style={{ padding: "0 10px" }}>Next action</th>
                      <th style={{ padding: "0 10px" }}>Manual</th>
                    </tr>
                  </thead>

                  <tbody>
                    {recentJobs.map((j) => {
                      const tags = parseTags(j.tagsCsv ?? null);
                      const tone = toneFromSentiment(j.sentiment ?? null);
                      const detailsId = `details-${j.id}`;

                      return (
                        <tr
                          key={j.id}
                          style={{
                            background: "white",
                            border: "1px solid rgba(0,0,0,0.08)",
                            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
                          }}
                        >
                          <td style={{ padding: "12px 10px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                            {j.checkoutId}
                            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
                              {j.outcome ?? "-"}
                            </div>

                            {(j.reason || j.transcript || j.endedReason || j.recordingUrl) ? (
                              <div style={{ marginTop: 10 }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const el = document.getElementById(detailsId) as HTMLDetailsElement | null;
                                    if (el) el.open = !el.open;
                                  }}
                                  style={{
                                    padding: "6px 10px",
                                    borderRadius: 10,
                                    border: "1px solid rgba(0,0,0,0.12)",
                                    background: "white",
                                    cursor: "pointer",
                                    fontWeight: 600,
                                  }}
                                >
                                  Details
                                </button>
                              </div>
                            ) : null}

                            <details id={detailsId} style={{ marginTop: 10 }}>
                              <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>
                                Expand
                              </summary>
                              <div style={{ paddingTop: 10, fontSize: 13, lineHeight: 1.4 }}>
                                {j.endedReason ? (
                                  <div style={{ marginBottom: 8 }}>
                                    <strong>Ended:</strong> {j.endedReason}
                                  </div>
                                ) : null}

                                {j.reason ? (
                                  <div style={{ marginBottom: 8 }}>
                                    <strong>Reason:</strong> {j.reason}
                                  </div>
                                ) : null}

                                {j.followUp ? (
                                  <div style={{ marginBottom: 8 }}>
                                    <strong>Follow-up:</strong> {j.followUp}
                                  </div>
                                ) : null}

                                {j.recordingUrl ? (
                                  <div style={{ marginBottom: 8 }}>
                                    <strong>Recording:</strong>{" "}
                                    <a href={j.recordingUrl} target="_blank" rel="noreferrer">
                                      Open
                                    </a>
                                  </div>
                                ) : null}

                                {j.transcript ? (
                                  <div style={{ marginBottom: 8 }}>
                                    <strong>Transcript:</strong>
                                    <pre
                                      style={{
                                        marginTop: 8,
                                        padding: 10,
                                        borderRadius: 10,
                                        background: "#f6f6f6",
                                        border: "1px solid rgba(0,0,0,0.08)",
                                        whiteSpace: "pre-wrap",
                                      }}
                                    >
                                      {j.transcript}
                                    </pre>
                                  </div>
                                ) : null}
                              </div>
                            </details>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top" }}>
                            {j.customerName ?? "-"}
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", minWidth: 220 }}>
                            {j.cartPreview ?? "-"}
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top" }}>
                            <s-badge>{j.status}</s-badge>
                            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
                              attempts: {j.attempts}
                            </div>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                            {new Date(j.scheduledFor).toLocaleString()}
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top" }}>
                            <s-badge tone={tone as any}>
                              {j.sentiment ? String(j.sentiment) : "-"}
                            </s-badge>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", minWidth: 200 }}>
                            {tags.length === 0 ? (
                              <span style={{ opacity: 0.6 }}>-</span>
                            ) : (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                {tags.map((t) => (
                                  <span
                                    key={t}
                                    style={{
                                      fontSize: 12,
                                      padding: "4px 8px",
                                      borderRadius: 999,
                                      border: "1px solid rgba(0,0,0,0.12)",
                                      background: "#fafafa",
                                    }}
                                  >
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", minWidth: 280 }}>
                            {j.nextAction ? (
                              <div>
                                <div style={{ fontWeight: 700 }}>{j.nextAction}</div>
                                {j.followUp ? (
                                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                                    {j.followUp}
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <span style={{ opacity: 0.6 }}>-</span>
                            )}
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top" }}>
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
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </s-card>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
