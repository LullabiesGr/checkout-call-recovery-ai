// app/routes/app.calls.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  ensureSettings,
  markAbandonedByDelay,
  syncAbandonedCheckoutsFromShopify,
  enqueueCallJobs,
} from "../callRecovery.server";
import {
  buildCartPreview,
  fetchSupabaseSummaries,
  formatWhen,
  isVapiConfiguredFromEnv,
  pickRecordingUrl,
  safeStr,
} from "../callInsights.server";
import { createVapiCallForJob } from "../callProvider.server";

/* ---------- helpers (kept local to keep app._index light) ---------- */

function safeStr(v: any) {
  return v == null ? "" : String(v);
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function isVapiConfiguredFromEnv() {
  const assistantId = process.env.VAPI_ASSISTANT_ID?.trim();
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID?.trim();
  const apiKey = process.env.VAPI_API_KEY?.trim();
  const serverUrl = process.env.VAPI_SERVER_URL?.trim();
  return Boolean(apiKey) && Boolean(assistantId) && Boolean(phoneNumberId) && Boolean(serverUrl);
}

type SupabaseCallSummary = {
  call_id: string;
  call_job_id?: string | null;
  checkout_id?: string | null;
  latest_status?: string | null;
  ended_reason?: string | null;
  recording_url?: string | null;
  stereo_recording_url?: string | null;
  log_url?: string | null;
  transcript?: string | null;
  call_outcome?: string | null;
  disposition?: string | null;
  answered?: boolean | null;
  voicemail?: boolean | null;
  sentiment?: string | null;
  tone?: string | null;
  buy_probability?: number | null;
  tags?: any;
  tagcsv?: string | null;
  summary?: string | null;
  summary_clean?: string | null;
  next_best_action?: string | null;
  best_next_action?: string | null;
  follow_up_message?: string | null;
  ai_status?: string | null;
  ai_error?: string | null;
  ai_processed_at?: string | null;
};

function uniq(values: string[]) {
  const s = new Set(values.map((x) => x.trim()).filter(Boolean));
  return Array.from(s);
}

function cleanIdList(values: string[]) {
  return uniq(values).map((x) => x.replace(/[,"'()]/g, ""));
}

async function fetchSupabaseSummaries(opts: {
  shop: string;
  callIds?: string[];
  callJobIds?: string[];
  checkoutIds?: string[];
}): Promise<Map<string, SupabaseCallSummary>> {
  const out = new Map<string, SupabaseCallSummary>();

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return out;

  const callIds = cleanIdList(opts.callIds ?? []);
  const callJobIds = cleanIdList(opts.callJobIds ?? []);
  const checkoutIds = cleanIdList(opts.checkoutIds ?? []);
  if (!callIds.length && !callJobIds.length && !checkoutIds.length) return out;

  const select = [
    "call_id",
    "call_job_id",
    "checkout_id",
    "latest_status",
    "ended_reason",
    "recording_url",
    "stereo_recording_url",
    "log_url",
    "transcript",
    "call_outcome",
    "disposition",
    "answered",
    "voicemail",
    "sentiment",
    "tone",
    "buy_probability",
    "tags",
    "tagcsv",
    "summary",
    "summary_clean",
    "next_best_action",
    "best_next_action",
    "follow_up_message",
    "ai_status",
    "ai_error",
    "ai_processed_at",
  ].join(",");

  const orParts: string[] = [];
  if (callIds.length) orParts.push(`call_id.in.(${callIds.join(",")})`);
  if (callJobIds.length) orParts.push(`call_job_id.in.(${callJobIds.join(",")})`);
  if (checkoutIds.length) orParts.push(`checkout_id.in.(${checkoutIds.join(",")})`);

  const params = new URLSearchParams();
  params.set("select", select);
  params.set("or", `(${orParts.join(",")})`);

  const withShop = new URLSearchParams(params);
  withShop.set("shop", `eq.${opts.shop}`);

  async function doFetch(p: URLSearchParams) {
    const endpoint = `${url}/rest/v1/vapi_call_summaries?${p.toString()}`;
    const r = await fetch(endpoint, {
      method: "GET",
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    });
    if (!r.ok) return [];
    const data = (await r.json()) as any;
    return Array.isArray(data) ? (data as SupabaseCallSummary[]) : [];
  }

  let data = await doFetch(withShop);
  if (data.length === 0) data = await doFetch(params);

  for (const row of data) {
    if (row.call_id) out.set(`call:${String(row.call_id)}`, row);
    if (row.call_job_id) out.set(`job:${String(row.call_job_id)}`, row);
    if (row.checkout_id) out.set(`co:${String(row.checkout_id)}`, row);
  }

  return out;
}

function pickRecordingUrl(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  return (sb.recording_url || sb.stereo_recording_url || sb.log_url) ?? null;
}

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

function StatusPill({ status }: { status: string }) {
  const s = safeStr(status).toUpperCase();
  const tone =
    s === "COMPLETED" ? "green" : s === "CALLING" ? "blue" : s === "QUEUED" ? "amber" : s === "FAILED" ? "red" : "neutral";
  return <Pill tone={tone as any}>{s}</Pill>;
}

type CallRow = {
  id: string;
  checkoutId: string;
  status: string;
  scheduledFor: string;
  createdAt: string;
  attempts: number;
  providerCallId: string | null;
  callOutcome: string | null;
  aiStatus: string | null;
  summary: string | null;
  nextAction: string | null;
  followUp: string | null;
  recordingUrl: string | null;
};

type LoaderData = {
  shop: string;
  vapiConfigured: boolean;
  stats: { queued: number; calling: number; completed7d: number };
  rows: CallRow[];
};

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

  const [queued, calling, completed7d, jobs] = await Promise.all([
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: { id: true, checkoutId: true, status: true, scheduledFor: true, createdAt: true, attempts: true, providerCallId: true, recordingUrl: true },
    }),
  ]);

  const callIds = jobs.map((j) => String(j.providerCallId ?? "")).filter(Boolean);
  const jobIds = jobs.map((j) => String(j.id ?? "")).filter(Boolean);
  const checkoutIds = jobs.map((j) => String(j.checkoutId ?? "")).filter(Boolean);

  const sbMap = await fetchSupabaseSummaries({ shop, callIds, callJobIds: jobIds, checkoutIds });

  const rows: CallRow[] = jobs.map((j) => {
    const callId = j.providerCallId ? String(j.providerCallId) : "";
    const jobId = String(j.id);
    const coId = String(j.checkoutId);

    const sb =
      (callId ? sbMap.get(`call:${callId}`) : null) ||
      (jobId ? sbMap.get(`job:${jobId}`) : null) ||
      (coId ? sbMap.get(`co:${coId}`) : null) ||
      null;

    return {
      id: String(j.id),
      checkoutId: String(j.checkoutId),
      status: String(j.status),
      scheduledFor: new Date(j.scheduledFor).toISOString(),
      createdAt: new Date(j.createdAt).toISOString(),
      attempts: Number(j.attempts ?? 0),
      providerCallId: j.providerCallId ? String(j.providerCallId) : null,
      callOutcome: sb?.call_outcome ? String(sb.call_outcome) : null,
      aiStatus: sb?.ai_status ? String(sb.ai_status) : null,
      summary: safeStr(sb?.summary_clean || sb?.summary).trim() || null,
      nextAction: safeStr(sb?.next_best_action || sb?.best_next_action).trim() || null,
      followUp: safeStr(sb?.follow_up_message).trim() || null,
      recordingUrl: (pickRecordingUrl(sb) ?? (j.recordingUrl ? String(j.recordingUrl) : null)) ?? null,
    };
  });

  return {
    shop,
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats: { queued, calling, completed7d },
    rows,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  const redirectBack = () => new Response(null, { status: 303, headers: { Location: "/app/calls" } });

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
        data: { status: "CALLING", attempts: { increment: 1 }, provider: vapiOk ? "vapi" : "sim", outcome: null },
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
        await db.callJob.update({ where: { id: job.id }, data: { status: "CALLING", outcome: "VAPI_CALL_STARTED" } });
      } catch (e: any) {
        const maxAttempts = settings.maxAttempts ?? 2;
        const fresh = await db.callJob.findUnique({ where: { id: job.id }, select: { attempts: true } });
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
        data: { outcome: "Missing Vapi ENV (VAPI_API_KEY/VAPI_ASSISTANT_ID/VAPI_PHONE_NUMBER_ID/VAPI_SERVER_URL)" },
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

      const fresh = await db.callJob.findUnique({ where: { id: callJobId }, select: { attempts: true } });
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

export default function Calls() {
  const { shop, vapiConfigured, stats, rows } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  React.useEffect(() => {
    const active = stats.calling > 0 || stats.queued > 0;
    if (!active) return;
    const id = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(id);
  }, [stats.calling, stats.queued, revalidator]);

  const [selectedId, setSelectedId] = React.useState<string | null>(rows?.[0]?.id ?? null);
  React.useEffect(() => {
    if (!selectedId && rows?.[0]?.id) setSelectedId(rows[0].id);
  }, [selectedId, rows]);

  const selected = React.useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

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
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Calls</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill title="Shop">{shop}</Pill>
            <Pill title="Provider">{vapiConfigured ? "Vapi ready" : "Sim mode"}</Pill>
            {stats.calling > 0 ? <Pill tone="blue">{stats.calling} calling</Pill> : null}
            {stats.queued > 0 ? <Pill tone="amber">{stats.queued} queued</Pill> : null}
            <Pill title="Completed in 7d">{stats.completed7d} completed/7d</Pill>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Form method="post">
            <input type="hidden" name="intent" value="run_jobs" />
            <button
              type="submit"
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(59,130,246,0.30)",
                background: "rgba(59,130,246,0.10)",
                cursor: "pointer",
                fontWeight: 1000,
              }}
            >
              Run queued jobs →
            </button>
          </Form>

          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "white",
              cursor: "pointer",
              fontWeight: 1000,
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
          gridTemplateColumns: "minmax(0, 1fr) 420px",
          gap: 12,
          alignItems: "start",
          minWidth: 0,
        }}
      >
        <div
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 16,
            overflow: "hidden",
            background: "white",
            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
            minWidth: 0,
          }}
        >
          <div style={{ maxHeight: 650, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={headerCell}>Checkout</th>
                  <th style={headerCell}>Status</th>
                  <th style={headerCell}>Outcome</th>
                  <th style={headerCell}>AI</th>
                  <th style={headerCell}>Scheduled</th>
                  <th style={headerCell}>Attempts</th>
                  <th style={headerCell}>Recording</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isSel = r.id === selectedId;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      style={{ background: isSel ? "rgba(59,130,246,0.06)" : "white", cursor: "pointer" }}
                    >
                      <td style={{ ...cell, color: "rgba(30,58,138,0.95)" }}>{r.checkoutId}</td>
                      <td style={cell}>
                        <StatusPill status={r.status} />
                      </td>
                      <td style={cell}>
                        <Pill tone={r.callOutcome?.toLowerCase().includes("recovered") ? "green" : "neutral"}>
                          {r.callOutcome ? r.callOutcome.toUpperCase() : "—"}
                        </Pill>
                      </td>
                      <td style={cell}>
                        <Pill>{r.aiStatus ? `AI: ${r.aiStatus.toUpperCase()}` : "AI: —"}</Pill>
                      </td>
                      <td style={cell}>
                        <div style={{ display: "grid", gap: 4 }}>
                          <div style={{ fontWeight: 1000 }}>{formatWhen(r.scheduledFor)}</div>
                          <div style={{ fontSize: 11, fontWeight: 900, color: "rgba(17,24,39,0.40)" }}>
                            Created {formatWhen(r.createdAt)}
                          </div>
                        </div>
                      </td>
                      <td style={cell}>{r.attempts}</td>
                      <td style={cell}>
                        {r.recordingUrl ? (
                          <a href={r.recordingUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div
          style={{
            position: "sticky",
            top: 12,
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 16,
            background: "white",
            overflow: "hidden",
            minWidth: 0,
            width: 420,
            justifySelf: "stretch",
            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ padding: 14, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ fontSize: 13, fontWeight: 1000, color: "rgba(17,24,39,0.80)" }}>Call intelligence</div>
            <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>
              {selected ? `Checkout ${selected.checkoutId}` : "Select a row"}
            </div>
          </div>

          <div style={{ padding: 14, display: "grid", gap: 12 }}>
            {!selected ? (
              <div style={{ color: "rgba(17,24,39,0.45)", fontWeight: 950 }}>—</div>
            ) : (
              <>
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Summary</div>
                  <div
                    style={{
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 14,
                      padding: 10,
                      fontWeight: 900,
                      color: "rgba(17,24,39,0.78)",
                      lineHeight: 1.35,
                      background: "rgba(0,0,0,0.02)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {selected.summary ?? "—"}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Next action</div>
                  <div
                    style={{
                      border: "1px solid rgba(59,130,246,0.20)",
                      borderRadius: 14,
                      padding: 10,
                      fontWeight: 950,
                      color: "rgba(30,58,138,0.92)",
                      lineHeight: 1.35,
                      background: "rgba(59,130,246,0.06)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {selected.nextAction ?? "—"}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 1000, color: "rgba(17,24,39,0.55)" }}>Follow-up</div>
                  <div
                    style={{
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 14,
                      padding: 10,
                      fontWeight: 900,
                      color: "rgba(17,24,39,0.78)",
                      lineHeight: 1.35,
                      background: "white",
                      whiteSpace: "pre-wrap",
                      maxHeight: 220,
                      overflow: "auto",
                    }}
                  >
                    {selected.followUp ?? "—"}
                  </div>
                </div>

                <Form method="post">
                  <input type="hidden" name="intent" value="manual_call" />
                  <input type="hidden" name="callJobId" value={selected.id} />
                  <button
                    type="submit"
                    disabled={selected.status !== "QUEUED"}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.12)",
                      background: selected.status === "QUEUED" ? "white" : "#f3f3f3",
                      cursor: selected.status === "QUEUED" ? "pointer" : "not-allowed",
                      fontWeight: 1000,
                      width: "100%",
                    }}
                  >
                    Call now
                  </button>
                </Form>
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, fontWeight: 900, fontSize: 12, color: "rgba(17,24,39,0.45)" }}>
        Live updates every 5s when calls are active.
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
