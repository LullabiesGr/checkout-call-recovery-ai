// app/routes/app._index.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  ensureSettings,
  markAbandonedByDelay,
  syncAbandonedCheckoutsFromShopify,
  enqueueCallJobs,
} from "../callRecovery.server";
import {
  formatWhen,
  isVapiConfiguredFromEnv,
  readDashboardStats,
  safeStr,
} from "../callInsights.server";

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
  recentActivity: Array<{
    id: string;
    kind: "call" | "checkout";
    title: string;
    sub: string;
    whenIso: string;
    status: string;
  }>;
};

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

function toneFromStatus(s: string) {
  const x = safeStr(s).toUpperCase();
  if (x === "COMPLETED" || x === "CONVERTED") return "green";
  if (x === "CALLING") return "blue";
  if (x === "QUEUED" || x === "OPEN") return "amber";
  if (x === "FAILED" || x === "ABANDONED") return "red";
  return "neutral";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  // keep the operational side (sync + enqueue) here
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

  const stats = await readDashboardStats(shop);

  // very small payload: last 5 call jobs + last 5 checkouts
  const [jobs, cos] = await Promise.all([
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, status: true, createdAt: true, checkoutId: true },
    }),
    db.checkout.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { checkoutId: true, status: true, updatedAt: true, customerName: true },
    }),
  ]);

  const recentActivity: LoaderData["recentActivity"] = [
    ...jobs.map((j) => ({
      id: String(j.id),
      kind: "call" as const,
      title: `Call job ${String(j.checkoutId)}`,
      sub: `Job ${String(j.id).slice(0, 8)}…`,
      whenIso: new Date(j.createdAt).toISOString(),
      status: String(j.status),
    })),
    ...cos.map((c) => ({
      id: String(c.checkoutId),
      kind: "checkout" as const,
      title: `Checkout ${String(c.checkoutId)}`,
      sub: c.customerName ? `Customer ${String(c.customerName)}` : "Customer —",
      whenIso: new Date(c.updatedAt).toISOString(),
      status: String(c.status),
    })),
  ]
    .sort((a, b) => new Date(b.whenIso).getTime() - new Date(a.whenIso).getTime())
    .slice(0, 8);

  return {
    shop,
    currency: settings.currency || "USD",
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats,
    recentActivity,
  } satisfies LoaderData;
};

export default function Dashboard() {
  const { shop, currency, vapiConfigured, stats, recentActivity } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  React.useEffect(() => {
    const active = stats.callingNow > 0 || stats.queuedCalls > 0;
    if (!active) return;
    const id = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(id);
  }, [stats.callingNow, stats.queuedCalls, revalidator]);

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);

  const pageWrap: React.CSSProperties = { padding: 16, minWidth: 0 };

  return (
    <div style={pageWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Dashboard</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill title="Shop">{shop}</Pill>
            <Pill title="Currency">{currency}</Pill>
            <Pill title="Provider">{vapiConfigured ? "Vapi ready" : "Sim mode"}</Pill>
            {stats.callingNow > 0 ? <Pill tone="blue">{stats.callingNow} calling</Pill> : null}
            {stats.queuedCalls > 0 ? <Pill tone="amber">{stats.queuedCalls} queued</Pill> : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link to="/app/checkouts" style={{ textDecoration: "none" }}>
            <Pill tone="blue">Open Checkouts</Pill>
          </Link>
          <Link to="/app/calls" style={{ textDecoration: "none" }}>
            <Pill tone="blue">Open Calls</Pill>
          </Link>
          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            style={{
              padding: "8px 10px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "white",
              cursor: "pointer",
              fontWeight: 950,
              fontSize: 12,
            }}
          >
            Refresh
          </button>
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
        <StatCard label="Open" value={stats.openCount7d} sub="Created (7d)" icon="🟨" />
        <StatCard label="Abandoned" value={stats.abandonedCount7d} sub="Abandoned (7d)" icon="🛒" />
        <StatCard label="Recovered" value={stats.convertedCount7d} sub="Converted (7d)" icon="✅" />
        <StatCard label="Potential revenue" value={money(stats.potentialRevenue7d)} sub="Abandoned sum (7d)" icon="€" />
        <StatCard label="Calls queued" value={stats.queuedCalls} sub="Ready to dial" icon="☎" />
        <StatCard label="Completed calls" value={stats.completedCalls7d} sub="Finished (7d)" icon="✓" />
      </div>

      <div
        style={{
          marginTop: 12,
          border: "1px solid rgba(0,0,0,0.08)",
          background: "white",
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ padding: 12, borderBottom: "1px solid rgba(0,0,0,0.06)", fontWeight: 1000 }}>
          Recent activity
        </div>
        <div style={{ padding: 12, display: "grid", gap: 10 }}>
          {recentActivity.length === 0 ? (
            <div style={{ fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>No activity yet.</div>
          ) : (
            recentActivity.map((a) => (
              <div key={`${a.kind}:${a.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                  <div style={{ fontWeight: 1000, color: "rgba(17,24,39,0.85)" }}>{a.title}</div>
                  <div style={{ fontWeight: 900, fontSize: 12, color: "rgba(17,24,39,0.45)" }}>
                    {a.sub} · {formatWhen(a.whenIso)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Pill tone={toneFromStatus(a.status) as any}>{safeStr(a.status).toUpperCase()}</Pill>
                  <Link to={a.kind === "call" ? "/app/calls" : "/app/checkouts"} style={{ textDecoration: "none" }}>
                    <Pill>Open</Pill>
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

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
