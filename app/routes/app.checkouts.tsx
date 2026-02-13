// app/routes/app.checkouts.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";
import {
  buildCartPreview,
  fetchSupabaseSummaries,
  formatWhen,
  isVapiConfiguredFromEnv,
  pickLatestJobByCheckout,
  pickRecordingUrl,
  safeStr,
} from "../callInsights.server";

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
};

type LoaderData = {
  shop: string;
  currency: string;
  vapiConfigured: boolean;
  stats: { queuedCalls: number; callingNow: number };
  allCheckouts: CheckoutUIRow[];
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

function CheckoutStatusPill({ status }: { status: string }) {
  const s = safeStr(status).toUpperCase();
  const tone = s === "CONVERTED" ? "green" : s === "ABANDONED" ? "red" : s === "OPEN" ? "amber" : "neutral";
  return <Pill tone={tone as any}>{s}</Pill>;
}

function StatusPill({ status }: { status: string }) {
  const s = safeStr(status).toUpperCase();
  const tone = s === "COMPLETED" ? "green" : s === "CALLING" ? "blue" : s === "QUEUED" ? "amber" : s === "FAILED" ? "red" : "neutral";
  return <Pill tone={tone as any}>{s}</Pill>;
}

function AiStatusPill({ status }: { status: string | null }) {
  const s = safeStr(status).toLowerCase();
  if (!s) return <Pill>AI: —</Pill>;
  if (s === "done") return <Pill tone="green">AI: DONE</Pill>;
  if (s === "processing") return <Pill tone="blue">AI: RUNNING</Pill>;
  if (s === "pending") return <Pill tone="amber">AI: PENDING</Pill>;
  if (s === "error") return <Pill tone="red">AI: ERROR</Pill>;
  return <Pill>AI: {s.toUpperCase()}</Pill>;
}

function OutcomeTone(outcome: string | null): "green" | "amber" | "red" | "neutral" {
  const s = safeStr(outcome).toLowerCase();
  if (!s) return "neutral";
  if (s.includes("recovered")) return "green";
  if (s.includes("needs_followup")) return "amber";
  if (s.includes("voicemail") || s.includes("no_answer")) return "amber";
  if (s.includes("not_recovered") || s.includes("wrong_number") || s.includes("not_interested")) return "red";
  return "neutral";
}

function OutcomePill({ outcome }: { outcome: string | null }) {
  const s = safeStr(outcome);
  if (!s) return <Pill>—</Pill>;
  return <Pill tone={OutcomeTone(s)}>{s.toUpperCase()}</Pill>;
}

function BuyPill({ pct }: { pct: number | null }) {
  if (pct == null) return <Pill>—</Pill>;
  const tone = pct >= 70 ? "green" : pct >= 40 ? "amber" : "red";
  return <Pill tone={tone as any}>{pct}%</Pill>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  const [queuedCalls, callingNow, allCheckoutsRaw, allJobsForMap] = await Promise.all([
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.checkout.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 350,
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
      take: 700,
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

  const sbMap = await fetchSupabaseSummaries({
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
      (callId ? sbMap.get(`call:${callId}`) : null) ||
      (jobId ? sbMap.get(`job:${jobId}`) : null) ||
      (checkoutId ? sbMap.get(`co:${checkoutId}`) : null) ||
      null;

    const recordingFromSb = pickRecordingUrl(sb);

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

      callOutcome: sb?.call_outcome ? String(sb.call_outcome) : null,
      sentiment: sb?.sentiment ? String(sb.sentiment) : sb?.tone ? String(sb.tone) : null,
      buyProbabilityPct:
        typeof sb?.buy_probability === "number" && Number.isFinite(sb.buy_probability) ? Math.round(sb.buy_probability) : null,
      disposition: sb?.disposition ? String(sb.disposition) : null,
      aiStatus: sb?.ai_status ? String(sb.ai_status) : null,
    };
  });

  return {
    shop,
    currency: settings.currency || "USD",
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats: { queuedCalls, callingNow },
    allCheckouts,
  } satisfies LoaderData;
};

export default function CheckoutsPage() {
  const { shop, currency, vapiConfigured, stats, allCheckouts } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  React.useEffect(() => {
    const active = stats.callingNow > 0 || stats.queuedCalls > 0;
    if (!active) return;
    const id = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(id);
  }, [stats.callingNow, stats.queuedCalls, revalidator]);

  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    if (!q) return allCheckouts;
    return allCheckouts.filter((c) => {
      return (
        safeStr(c.checkoutId).toLowerCase().includes(q) ||
        safeStr(c.customerName).toLowerCase().includes(q) ||
        safeStr(c.cartPreview).toLowerCase().includes(q) ||
        safeStr(c.status).toLowerCase().includes(q) ||
        safeStr(c.phone).toLowerCase().includes(q) ||
        safeStr(c.email).toLowerCase().includes(q) ||
        safeStr(c.callStatus).toLowerCase().includes(q) ||
        safeStr(c.callOutcome).toLowerCase().includes(q) ||
        safeStr(c.aiStatus).toLowerCase().includes(q)
      );
    });
  }, [allCheckouts, q]);

  const [isNarrow, setIsNarrow] = React.useState(false);
  React.useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 1180);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const pageWrap: React.CSSProperties = { padding: 16, minWidth: 0 };

  const headerCell: React.CSSProperties = {
    position: "sticky",
    top: 0,
    background: "white",
    zIndex: 1,
    borderBottom: "1px solid rgba(0,0,0,0.08)",
    padding: "10px 10px",
    fontSize: 12,
    fontWeight: 1000,
    color: "rgba(17,24,39,0.55)",
    whiteSpace: "nowrap",
  };

  const cell: React.CSSProperties = {
    padding: "10px 10px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    verticalAlign: "top",
    fontSize: 13,
    fontWeight: 900,
    color: "rgba(17,24,39,0.78)",
  };

  return (
    <div style={pageWrap}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Checkouts</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill title="Shop">{shop}</Pill>
            <Pill title="Currency">{currency}</Pill>
            <Pill title="Provider">{vapiConfigured ? "Vapi ready" : "Sim mode"}</Pill>
            {stats.callingNow > 0 ? <Pill tone="blue">{stats.callingNow} calling</Pill> : null}
            {stats.queuedCalls > 0 ? <Pill tone="amber">{stats.queuedCalls} queued</Pill> : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "white",
              cursor: "pointer",
              fontWeight: 1000,
            }}
          >
            Refresh
          </button>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "rgba(0,0,0,0.02)",
              borderRadius: 12,
              padding: "8px 10px",
              minWidth: 280,
            }}
          >
            <span style={{ fontWeight: 1000, color: "rgba(17,24,39,0.45)" }}>⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search checkouts..."
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
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 16,
          overflow: "hidden",
          background: "white",
          boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          minWidth: 0,
        }}
      >
        <div style={{ maxHeight: 720, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1320 }}>
            <thead>
              <tr>
                <th style={headerCell}>Checkout</th>
                <th style={headerCell}>Status</th>
                <th style={headerCell}>Customer</th>
                <th style={headerCell}>Phone</th>
                <th style={headerCell}>Value</th>
                <th style={headerCell}>Cart</th>
                <th style={headerCell}>Updated</th>
                <th style={headerCell}>Call</th>
                <th style={headerCell}>AI</th>
                <th style={headerCell}>Outcome</th>
                <th style={headerCell}>Buy</th>
                <th style={headerCell}>Recording</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.checkoutId} style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                  <td style={{ ...cell, color: "rgba(30,58,138,0.95)" }}>{c.checkoutId}</td>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <CheckoutStatusPill status={c.status} />
                      {c.abandonedAt ? <Pill title="Abandoned at">{formatWhen(c.abandonedAt)}</Pill> : null}
                    </div>
                  </td>
                  <td style={cell}>{c.customerName ?? "-"}</td>
                  <td style={cell}>{c.phone ?? "-"}</td>
                  <td style={cell}>
                    {c.value} {c.currency}
                  </td>
                  <td style={{ ...cell, maxWidth: 320 }}>
                    <span
                      title={c.cartPreview ?? ""}
                      style={{
                        display: "inline-block",
                        maxWidth: 320,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        fontWeight: 900,
                      }}
                    >
                      {c.cartPreview ?? "-"}
                    </span>
                  </td>
                  <td style={cell}>{formatWhen(c.updatedAt)}</td>
                  <td style={cell}>{c.callStatus ? <StatusPill status={c.callStatus} /> : <Pill>—</Pill>}</td>
                  <td style={cell}><AiStatusPill status={c.aiStatus} /></td>
                  <td style={cell}><OutcomePill outcome={c.callOutcome} /></td>
                  <td style={cell}><BuyPill pct={c.buyProbabilityPct} /></td>
                  <td style={cell}>
                    {c.recordingUrl ? (
                      <a href={c.recordingUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                        <button
                          type="button"
                          style={{
                            padding: "8px 10px",
                            borderRadius: 12,
                            border: "1px solid rgba(59,130,246,0.30)",
                            background: "rgba(59,130,246,0.10)",
                            cursor: "pointer",
                            fontWeight: 950,
                            fontSize: 12,
                          }}
                        >
                          Open
                        </button>
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled
                        style={{
                          padding: "8px 10px",
                          borderRadius: 12,
                          border: "1px solid rgba(0,0,0,0.10)",
                          background: "white",
                          fontWeight: 950,
                          fontSize: 12,
                          opacity: 0.5,
                          cursor: "not-allowed",
                        }}
                      >
                        Open
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
