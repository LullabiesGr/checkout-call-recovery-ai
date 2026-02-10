import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

type LoaderData = {
  shop: string;
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
  }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings =
    (await db.settings.findUnique({ where: { shop } })) ??
    (await db.settings.create({
      data: { shop, enabled: true, delayMinutes: 30, maxAttempts: 2, retryMinutes: 180, minOrderValue: 0, currency: "USD" },
    }));

  // 1) Mark abandoned candidates (OPEN older than delayMinutes and not converted)
  const cutoff = new Date(Date.now() - settings.delayMinutes * 60 * 1000);

  await db.checkout.updateMany({
    where: {
      shop,
      status: "OPEN",
      updatedAt: { lte: cutoff },
    },
    data: {
      status: "ABANDONED",
      abandonedAt: new Date(),
    },
  });

  // 2) Enqueue call jobs for ABANDONED checkouts (idempotent)
  if (settings.enabled) {
    const candidates = await db.checkout.findMany({
      where: {
        shop,
        status: "ABANDONED",
        phone: { not: null },
        value: { gte: settings.minOrderValue },
      },
      select: { checkoutId: true, phone: true },
      take: 50,
    });

    for (const c of candidates) {
      const phone = String(c.phone || "").trim();
      if (!phone) continue;

      const exists = await db.callJob.findFirst({
        where: {
          shop,
          checkoutId: c.checkoutId,
          status: { in: ["QUEUED", "CALLING"] },
        },
        select: { id: true },
      });

      if (!exists) {
        await db.callJob.create({
          data: {
            shop,
            checkoutId: c.checkoutId,
            phone,
            scheduledFor: new Date(Date.now() + 2 * 60 * 1000), // +2min (γρήγορο για dev)
            status: "QUEUED",
            attempts: 0,
          },
        });
      }
    }
  }

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
      db.callJob.count({
        where: { shop, status: "QUEUED" },
      }),
      db.callJob.count({
        where: { shop, status: "COMPLETED", createdAt: { gte: since } },
      }),
      db.callJob.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          checkoutId: true,
          status: true,
          scheduledFor: true,
          attempts: true,
          createdAt: true,
        },
      }),
    ]);

  const potentialRevenue7d = Number(potentialAgg._sum.value ?? 0);

  return {
    shop,
    stats: {
      abandonedCount7d,
      potentialRevenue7d,
      queuedCalls,
      completedCalls7d,
    },
    recentJobs: recentJobs.map((j) => ({
      ...j,
      scheduledFor: j.scheduledFor.toISOString(),
      createdAt: j.createdAt.toISOString(),
    })),
  } satisfies LoaderData;
};

export default function Dashboard() {
  const { shop, stats, recentJobs } = useLoaderData<typeof loader>();

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
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
          {recentJobs.length === 0 ? (
            <s-text as="p" tone="subdued">No call jobs yet.</s-text>
          ) : (
            <s-table>
              <s-table-head>
                <s-table-row>
                  <s-table-header-cell>Checkout</s-table-header-cell>
                  <s-table-header-cell>Status</s-table-header-cell>
                  <s-table-header-cell>Scheduled</s-table-header-cell>
                  <s-table-header-cell>Attempts</s-table-header-cell>
                </s-table-row>
              </s-table-head>
              <s-table-body>
                {recentJobs.map((j) => (
                  <s-table-row key={j.id}>
                    <s-table-cell>{j.checkoutId}</s-table-cell>
                    <s-table-cell><s-badge>{j.status}</s-badge></s-table-cell>
                    <s-table-cell>{new Date(j.scheduledFor).toLocaleString()}</s-table-cell>
                    <s-table-cell>{j.attempts}</s-table-cell>
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
