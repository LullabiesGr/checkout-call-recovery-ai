// app/routes/app.checkouts.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

import {
  buildCartPreview,
  fetchSupabaseSummaries,
  formatWhen,
  pickLatestJobByCheckout,
  pickRecordingUrl,
  safeStr,
} from "../lib/callInsights.server";

type Row = {
  checkoutId: string;
  status: string;
  updatedAt: string;
  abandonedAt: string | null;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  value: number;
  currency: string;
  cartPreview: string | null;

  callStatus: string | null;
  callOutcome: string | null;
  aiStatus: string | null;
  buyProbabilityPct: number | null;
  recordingUrl: string | null;
};

type LoaderData = {
  shop: string;
  rows: Row[];
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureSettings(shop);

  const [checkouts, jobs] = await Promise.all([
    db.checkout.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 300,
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
      take: 800,
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

  const latestJobMap = pickLatestJobByCheckout(jobs);

  const checkoutIds = checkouts.map((c) => String(c.checkoutId)).filter(Boolean);

  const callIds = checkouts
    .map((c) => {
      const j = latestJobMap.get(String(c.checkoutId)) ?? null;
      return j?.providerCallId ? String(j.providerCallId) : "";
    })
    .filter(Boolean);

  const jobIds = checkouts
    .map((c) => {
      const j = latestJobMap.get(String(c.checkoutId)) ?? null;
      return j?.id ? String(j.id) : "";
    })
    .filter(Boolean);

  const sbMap = await fetchSupabaseSummaries({
    shop,
    callIds: Array.from(new Set(callIds)),
    callJobIds: Array.from(new Set(jobIds)),
    checkoutIds: Array.from(new Set(checkoutIds)),
  });

  const rows: Row[] = checkouts.map((c) => {
    const checkoutId = String(c.checkoutId);
    const j = latestJobMap.get(checkoutId) ?? null;

    const callId = j?.providerCallId ? String(j.providerCallId) : "";
    const jobId = j?.id ? String(j.id) : "";

    const sb =
      (callId ? sbMap.get(`call:${callId}`) : null) ||
      (jobId ? sbMap.get(`job:${jobId}`) : null) ||
      (checkoutId ? sbMap.get(`co:${checkoutId}`) : null) ||
      null;

    const buyProbabilityPct =
      typeof sb?.buy_probability === "number" && Number.isFinite(sb.buy_probability)
        ? Math.round(sb.buy_probability)
        : null;

    return {
      checkoutId,
      status: String(c.status),
      updatedAt: new Date(c.updatedAt).toISOString(),
      abandonedAt: c.abandonedAt ? new Date(c.abandonedAt).toISOString() : null,
      customerName: c.customerName ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
      value: Number(c.value ?? 0),
      currency: String(c.currency ?? "USD"),
      cartPreview: buildCartPreview(c.itemsJson ?? null),

      callStatus: j ? String(j.status) : null,
      callOutcome: sb?.call_outcome ? String(sb.call_outcome) : null,
      aiStatus: sb?.ai_status ? String(sb.ai_status) : null,
      buyProbabilityPct,
      recordingUrl: (pickRecordingUrl(sb) ?? (j?.recordingUrl ? String(j.recordingUrl) : null)) ?? null,
    };
  });

  return { shop, rows } satisfies LoaderData;
};

export default function Checkouts() {
  const { shop, rows } = useLoaderData<typeof loader>();
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    if (!q) return rows;
    return rows.filter((c) => {
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
  }, [rows, q]);

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
    <div style={{ padding: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Checkouts</div>
          <div style={{ fontWeight: 850, fontSize: 12, color: "rgba(17,24,39,0.55)" }}>{shop}</div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid rgba(0,0,0,0.10)",
            background: "rgba(0,0,0,0.02)",
            borderRadius: 12,
            padding: "8px 10px",
            minWidth: 320,
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
                <tr key={c.checkoutId}>
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
                  <td style={cell}>{c.callStatus ? <Pill>{c.callStatus}</Pill> : <Pill>—</Pill>}</td>
                  <td style={cell}>{c.aiStatus ? <Pill>{`AI: ${c.aiStatus.toUpperCase()}`}</Pill> : <Pill>AI: —</Pill>}</td>
                  <td style={cell}>
                    <Pill tone={c.callOutcome?.toLowerCase().includes("recovered") ? "green" : "neutral"}>
                      {c.callOutcome ? c.callOutcome.toUpperCase() : "—"}
                    </Pill>
                  </td>
                  <td style={cell}>{c.buyProbabilityPct == null ? <Pill>—</Pill> : <Pill>{c.buyProbabilityPct}%</Pill>}</td>
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
                            fontWeight: 1000,
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
                          background: "rgba(0,0,0,0.03)",
                          fontWeight: 1000,
                          fontSize: 12,
                          opacity: 0.6,
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
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
