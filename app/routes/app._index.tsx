// app/routes/app._index.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
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
      .map((it: any) => `${String(it?.title ?? "").trim()} x${Number(it?.quantity ?? 1)}`)
      .filter((s: string) => s.trim() && !s.includes("undefined"))
      .join(", ");
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

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

  const [abandonedCount7d, potentialAgg, queuedCalls, completedCalls7d, recentJobs] =
    await Promise.all([
      db.checkout.count({
        where: { shop, status: "ABANDONED", abandonedAt: { gte: since } },
      }),
      db.checkout.aggregate({
        where: { shop, status: "ABANDONED", abandonedAt: { gte: since } },
        _sum: { value: true },
      }),
      db.callJob.count({ where: { shop, status: "QUEUED" } }),
      db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
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

  // Run queued (automation simulation -> now real Vapi create)
  if (intent === "run_jobs") {
    const settings = await ensureSettings(shop);

    const jobs = await db.callJob.findMany({
      where: { shop, status: "QUEUED" },
      orderBy: { scheduledFor: "asc" },
      take: 10,
    });

    let processed = 0;

    for (const job of jobs) {
      // If Vapi not configured, keep old simulated behavior
      const hasVapi = Boolean((settings as any).vapiAssistantId && (settings as any).vapiPhoneNumberId);

      if (!hasVapi) {
        const locked = await db.callJob.updateMany({
          where: { id: job.id, shop, status: "QUEUED" },
          data: { status: "CALLING", attempts: { increment: 1 }, provider: "sim" },
        });
        if (locked.count === 0) continue;

        await db.callJob.update({
          where: { id: job.id },
          data: { status: "COMPLETED", outcome: `SIMULATED_CALL_OK phone=${job.phone}` },
        });

        processed += 1;
        continue;
      }

      // Real Vapi call create
      try {
        const r = await createVapiCallForJob({ shop, callJobId: job.id });
        if (r?.skipped) continue;
        processed += 1;
      } catch (e: any) {
        const attemptsAfter = (job.attempts ?? 0) + 1;
        const maxAttempts = settings.maxAttempts ?? 2;

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

    return new Response(JSON.stringify({ ok: true, processed }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Manual call for a specific job
  if (intent === "manual_call") {
    const callJobId = String(fd.get("callJobId") ?? "");
    if (!callJobId) {
      return new Response(JSON.stringify({ ok: false, error: "Missing callJobId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const r = await createVapiCallForJob({ shop, callJobId });
      return new Response(JSON.stringify({ ok: true, ...r }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, ignored: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export default function Dashboard() {
  const { shop, stats, recentJobs, currency } = useLoaderData<typeof loader>();

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
                  borderRadius: 8,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Run queued jobs
              </button>
            </Form>

            <s-text as="p" tone="subdued">
              If Vapi is configured, creates real calls. Otherwise simulates.
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
                  <s-table-header-cell>Outcome</s-table-header-cell>
                  <s-table-header-cell>Manual</s-table-header-cell>
                </s-table-row>
              </s-table-head>
              <s-table-body>
                {recentJobs.map((j) => (
                  <s-table-row key={j.id}>
                    <s-table-cell>{j.checkoutId}</s-table-cell>
                    <s-table-cell>{j.customerName ?? "-"}</s-table-cell>
                    <s-table-cell>{j.cartPreview ?? "-"}</s-table-cell>
                    <s-table-cell><s-badge>{j.status}</s-badge></s-table-cell>
                    <s-table-cell>{new Date(j.scheduledFor).toLocaleString()}</s-table-cell>
                    <s-table-cell>{j.attempts}</s-table-cell>
                    <s-table-cell>{j.outcome ?? "-"}</s-table-cell>
                    <s-table-cell>
                      <Form method="post">
                        <input type="hidden" name="intent" value="manual_call" />
                        <input type="hidden" name="callJobId" value={j.id} />
                        <button
                          type="submit"
                          disabled={j.status !== "QUEUED"}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 8,
                            border: "1px solid rgba(0,0,0,0.12)",
                            background: j.status === "QUEUED" ? "white" : "#f3f3f3",
                            cursor: j.status === "QUEUED" ? "pointer" : "not-allowed",
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

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
