// app/routes/app._index.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  ensureSettings,
  markAbandonedByDelay,
  syncAbandonedCheckoutsFromShopify,
  enqueueCallJobs,
} from "../callRecovery.server";
import { isVapiConfiguredFromEnv } from "../lib/callInsights.server";

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
};

function safeSearch(): string {
  if (typeof window === "undefined") return "";
  const s = window.location.search || "";
  return s.startsWith("?") ? s : s ? `?${s}` : "";
}
function withSearch(path: string): string {
  const s = safeSearch();
  if (!s) return path;
  if (path.includes("?")) return path;
  return `${path}${s}`;
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
      <div style={{ marginTop: 8, fontWeight: 1000, fontSize: 22, color: "rgba(17,24,39,0.92)" }}>
        {props.value}
      </div>
      <div style={{ marginTop: 4, fontWeight: 850, fontSize: 12, color: "rgba(17,24,39,0.45)" }}>{props.sub}</div>
    </div>
  );
}

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
  ] = await Promise.all([
    db.checkout.count({ where: { shop, status: "ABANDONED", abandonedAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "CONVERTED", updatedAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "OPEN", createdAt: { gte: since } } }),
    db.checkout.aggregate({ where: { shop, status: "ABANDONED", abandonedAt: { gte: since } }, _sum: { value: true } }),
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
  ]);

  return {
    shop,
    currency: settings.currency || "USD",
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats: {
      abandonedCount7d,
      convertedCount7d,
      openCount7d,
      potentialRevenue7d: Number(potentialAgg._sum.value ?? 0),
      queuedCalls,
      callingNow,
      completedCalls7d,
    },
  } satisfies LoaderData;
};

export default function DashboardIndex() {
  const { shop, stats, currency, vapiConfigured } = useLoaderData<typeof loader>();

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);

  return (
    <div style={{ padding: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Dashboard</div>
          <div style={{ fontWeight: 900, fontSize: 12, color: "rgba(17,24,39,0.55)" }}>{shop}</div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "rgba(0,0,0,0.03)",
              fontWeight: 950,
              fontSize: 12,
              color: "rgba(17,24,39,0.75)",
              whiteSpace: "nowrap",
            }}
          >
            Provider: {vapiConfigured ? "Vapi ready" : "Sim mode"}
          </div>

          <Link
            to={withSearch("/app/checkouts")}
            style={{
              textDecoration: "none",
              fontWeight: 1000,
              fontSize: 13,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "white",
              color: "rgba(17,24,39,0.90)",
            }}
          >
            Open Checkouts
          </Link>

          <Link
            to={withSearch("/app/calls")}
            style={{
              textDecoration: "none",
              fontWeight: 1000,
              fontSize: 13,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(59,130,246,0.22)",
              background: "rgba(59,130,246,0.08)",
              color: "rgba(30,58,138,0.95)",
            }}
          >
            Open Calls
          </Link>
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
          gap: 12,
        }}
      >
        <StatCard label="Open" value={stats.openCount7d} sub="Created in last 7 days" icon="◻" />
        <StatCard label="Abandoned" value={stats.abandonedCount7d} sub="Abandoned in last 7 days" icon="🛒" />
        <StatCard label="Recovered" value={stats.convertedCount7d} sub="Converted in last 7 days" icon="✓" />
        <StatCard label="Potential revenue" value={money(stats.potentialRevenue7d)} sub="Sum of abandoned carts" icon="€" />
        <StatCard label="Calls queued" value={stats.queuedCalls} sub="Ready to dial" icon="☎" />
        <StatCard label="Calling now" value={stats.callingNow} sub="Live calls in progress" icon="•" />
      </div>

      <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
        <div
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 16,
            background: "white",
            padding: 14,
            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ fontWeight: 1100, fontSize: 13, color: "rgba(17,24,39,0.85)" }}>Where the work happens</div>
          <div style={{ marginTop: 6, fontWeight: 900, fontSize: 12, color: "rgba(17,24,39,0.55)", lineHeight: 1.4 }}>
            Checkouts: customer + cart + call status.
            <br />
            Calls: live calling, outcomes, AI summary, next action, manual dial + run queue.
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
