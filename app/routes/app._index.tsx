// app/routes/app._index.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError, useSubmit } from "react-router";
import { useEffect, useMemo, useState } from "react";
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
    recoveredCount7d: number;
    recoveredRevenue7d: number;
  };
  recentJobs: Array<{
    id: string;
    checkoutId: string;
    status: string;
    scheduledFor: string;
    attempts: number;
    createdAt: string;
    outcome?: string | null;

    attributedAt?: string | null;
    attributedOrderId?: string | null;
    attributedAmount?: number | null;

    customerName?: string | null;
    cartPreview?: string | null;

    sentiment?: string | null;
    tagsCsv?: string | null;
    reason?: string | null;
    nextAction?: string | null;
    followUp?: string | null;
    endedReason?: string | null;
    recordingUrl?: string | null;
    transcript?: string | null;

    answered?: boolean | null;
    voicemail?: boolean | null;
    buyProbability?: number | null;
    summary?: string | null;
    callOutcome?: string | null;
    customerIntent?: string | null;
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
  if (!/^[A-Z]{3}$/.test(v)) return "USD";
  return v;
}

function parseTags(tagsCsv?: string | null): string[] {
  if (!tagsCsv) return [];
  return String(tagsCsv)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function toneFromSentiment(s?: string | null): "success" | "warning" | "critical" | "info" {
  const v = String(s || "").toLowerCase();
  if (v.includes("positive") || v === "pos" || v === "yes") return "success";
  if (v.includes("negative") || v === "neg" || v === "no") return "critical";
  if (v.includes("neutral")) return "warning";
  return "info";
}

type OutcomeAnalysis = {
  sentiment?: string | null;
  tags?: string[] | null;
  reason?: string | null;
  nextAction?: string | null;
  followUp?: string | null;
  endedReason?: string | null;
  recordingUrl?: string | null;
  transcript?: string | null;

  answered?: boolean | null;
  voicemail?: boolean | null;
  buyProbability?: number | null;
  summary?: string | null;
  callOutcome?: string | null;
  customerIntent?: string | null;
};

function parseOutcomeJson(outcome?: string | null): OutcomeAnalysis {
  const raw = String(outcome ?? "").trim();
  if (!raw) return {};
  if (!raw.startsWith("{")) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};

    const tagsArr = Array.isArray((obj as any).tags)
      ? (obj as any).tags.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : null;

    const buyProb = Number((obj as any).buyProbability);
    const buyProbability = Number.isFinite(buyProb) ? buyProb : null;

    return {
      sentiment: (obj as any).sentiment ? String((obj as any).sentiment) : null,
      tags: tagsArr,
      reason: (obj as any).reason ? String((obj as any).reason) : null,
      nextAction: (obj as any).nextAction ? String((obj as any).nextAction) : null,
      followUp: (obj as any).followUp ? String((obj as any).followUp) : null,
      endedReason: (obj as any).endedReason ? String((obj as any).endedReason) : null,
      recordingUrl: (obj as any).recordingUrl ? String((obj as any).recordingUrl) : null,
      transcript: (obj as any).transcript ? String((obj as any).transcript) : null,

      answered: typeof (obj as any).answered === "boolean" ? (obj as any).answered : null,
      voicemail: typeof (obj as any).voicemail === "boolean" ? (obj as any).voicemail : null,
      buyProbability,
      summary: (obj as any).summary ? String((obj as any).summary) : null,
      callOutcome: (obj as any).callOutcome ? String((obj as any).callOutcome) : null,
      customerIntent: (obj as any).customerIntent ? String((obj as any).customerIntent) : null,
    };
  } catch {
    return {};
  }
}

function clamp01to100(n: any): number | null {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

function shortId(s: string, keep = 10) {
  const v = String(s || "");
  if (v.length <= keep) return v;
  return `${v.slice(0, keep)}…`;
}

function safeText(s?: string | null, max = 120) {
  const v = String(s ?? "").trim();
  if (!v) return null;
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
  await markAbandonedByDelay(shop, (settings as any).delayMinutes);

  await enqueueCallJobs({
    shop,
    enabled: Boolean((settings as any).enabled),
    minOrderValue: Number((settings as any).minOrderValue ?? 0),
    callWindowStart: (settings as any).callWindowStart ?? "09:00",
    callWindowEnd: (settings as any).callWindowEnd ?? "19:00",
    delayMinutes: Number((settings as any).delayMinutes ?? 0),
  } as any);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    abandonedCount7d,
    potentialAgg,
    queuedCalls,
    completedCalls7d,
    recoveredAgg,
    recoveredCount7d,
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
    db.callJob.aggregate({
      where: { shop, attributedAt: { gte: since } },
      _sum: { attributedAmount: true },
    }),
    db.callJob.count({
      where: { shop, attributedAt: { gte: since } },
    }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        attempts: true,
        createdAt: true,
        outcome: true,
        attributedAt: true,
        attributedOrderId: true,
        attributedAmount: true,
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
  const recoveredRevenue7d = Number(recoveredAgg._sum.attributedAmount ?? 0);

  return {
    shop,
    currency: normalizeCurrency((settings as any).currency || "USD"),
    vapiConfigured: isVapiConfiguredFromEnv(),
    stats: {
      abandonedCount7d,
      potentialRevenue7d,
      queuedCalls,
      completedCalls7d,
      recoveredCount7d,
      recoveredRevenue7d,
    },
    recentJobs: recentJobs.map((j) => {
      const c = cMap.get(j.checkoutId);
      const a = parseOutcomeJson(j.outcome ?? null);
      const tagsCsv = a.tags && a.tags.length ? a.tags.slice(0, 10).join(", ") : null;

      return {
        ...j,
        scheduledFor: j.scheduledFor.toISOString(),
        createdAt: j.createdAt.toISOString(),
        customerName: c?.customerName ?? null,
        cartPreview: buildCartPreview(c?.itemsJson ?? null),

        attributedAt: j.attributedAt ? j.attributedAt.toISOString() : null,
        attributedOrderId: j.attributedOrderId ?? null,
        attributedAmount: j.attributedAmount ?? null,

        sentiment: a.sentiment ?? null,
        tagsCsv,
        reason: a.reason ?? null,
        nextAction: a.nextAction ?? null,
        followUp: a.followUp ?? null,
        endedReason: a.endedReason ?? null,
        recordingUrl: a.recordingUrl ?? null,
        transcript: a.transcript ?? null,

        answered: a.answered ?? null,
        voicemail: a.voicemail ?? null,
        buyProbability: a.buyProbability ?? null,
        summary: a.summary ?? null,
        callOutcome: a.callOutcome ?? null,
        customerIntent: a.customerIntent ?? null,
      };
    }),
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  const redirectBack = () => new Response(null, { status: 303, headers: { Location: "/app" } });

  if (intent === "refresh") return redirectBack();

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
      // light lock: ΜΗΝ κάνεις attempts++ εδώ, ΜΗΝ βάζεις "as any" σε λάθος θέση
      const locked = await db.callJob.updateMany({
        where: { id: job.id, shop, status: "QUEUED", providerCallId: null },
        data: ({ status: "CALLING", provider: vapiOk ? "vapi" : "sim", outcome: null } as any),
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
      } catch (e: any) {
        const fresh = await db.callJob.findFirst({ where: { id: job.id, shop } });
        const attemptsAfter = Number((fresh as any)?.attempts ?? 0);
        const maxAttempts = Number((settings as any)?.maxAttempts ?? 2);

        if (attemptsAfter >= maxAttempts) {
          await db.callJob.update({
            where: { id: job.id },
            data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}`.slice(0, 2000) },
          });
        } else {
          const retryMinutes = Number((settings as any)?.retryMinutes ?? 180);
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

    try {
      await createVapiCallForJob({ shop, callJobId });
    } catch (e: any) {
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: { outcome: `ERROR: ${String(e?.message ?? e)}`.slice(0, 2000) },
      });
    }

    return redirectBack();
  }

  return redirectBack();
};

export default function Dashboard() {
  const { shop, stats, recentJobs, currency, vapiConfigured } = useLoaderData<typeof loader>();

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);

  const submit = useSubmit();

  useEffect(() => {
    const hasCalling = recentJobs.some((j) => j.status === "CALLING");
    if (!hasCalling) return;

    const id = setInterval(() => {
      const fd = new FormData();
      fd.set("intent", "refresh");
      submit(fd, { method: "post" });
    }, 5000);

    return () => clearInterval(id);
  }, [recentJobs, submit]);

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "QUEUED" | "CALLING" | "COMPLETED" | "FAILED" | "CANCELED"
  >("ALL");
  const [onlyEarned, setOnlyEarned] = useState(false);
  const [onlyAnswered, setOnlyAnswered] = useState(false);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();

    return recentJobs
      .filter((j) => {
        if (onlyEarned && j.attributedAmount == null) return false;
        if (onlyAnswered && j.answered !== true) return false;
        if (statusFilter !== "ALL" && String(j.status) !== statusFilter) return false;

        if (!query) return true;

        const hay = [
          j.checkoutId,
          j.customerName ?? "",
          j.cartPreview ?? "",
          j.tagsCsv ?? "",
          j.reason ?? "",
          j.nextAction ?? "",
          j.outcome ?? "",
          j.attributedOrderId ?? "",
        ]
          .join(" ")
          .toLowerCase();

        return hay.includes(query);
      })
      .slice();
  }, [recentJobs, q, statusFilter, onlyEarned, onlyAnswered]);

  const ui = {
    card: {
      border: "1px solid rgba(0,0,0,0.08)",
      borderRadius: 14,
      boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
    } as const,
    button: {
      padding: "8px 12px",
      borderRadius: 10,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "white",
      cursor: "pointer",
      fontWeight: 700,
    } as const,
    input: {
      padding: "8px 10px",
      borderRadius: 10,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "white",
      minWidth: 260,
      outline: "none",
    } as const,
    select: {
      padding: "8px 10px",
      borderRadius: 10,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "white",
      outline: "none",
    } as const,
    small: { fontSize: 12, opacity: 0.75 } as const,
    chip: {
      fontSize: 12,
      padding: "4px 8px",
      borderRadius: 999,
      border: "1px solid rgba(0,0,0,0.12)",
      background: "#fafafa",
      whiteSpace: "nowrap",
    } as const,
  };

  return (
    <s-page heading="Checkout Call Recovery AI">
      <s-stack gap="base">
        <s-card padding="base" style={ui.card as any}>
          <s-stack gap="base">
            <s-stack direction="inline" gap="base" align="center">
              <s-paragraph>
                Store: <s-badge>{shop}</s-badge>
              </s-paragraph>

              <Form method="post">
                <input type="hidden" name="intent" value="refresh" />
                <button type="submit" style={ui.button}>
                  Refresh
                </button>
              </Form>

              <Form method="post">
                <input type="hidden" name="intent" value="run_jobs" />
                <button type="submit" style={ui.button}>
                  Run queued jobs
                </button>
              </Form>

              <s-text as="p" tone="subdued">
                {vapiConfigured ? "Vapi enabled." : "Vapi not configured in ENV — calls will be simulated."}
              </s-text>
            </s-stack>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search: customer, checkout, tags, notes…"
                style={ui.input}
              />

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                style={ui.select}
              >
                <option value="ALL">All statuses</option>
                <option value="QUEUED">QUEUED</option>
                <option value="CALLING">CALLING</option>
                <option value="COMPLETED">COMPLETED</option>
                <option value="FAILED">FAILED</option>
                <option value="CANCELED">CANCELED</option>
              </select>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={onlyEarned}
                  onChange={(e) => setOnlyEarned(e.target.checked)}
                />
                <span style={{ fontSize: 13 }}>Only earned</span>
              </label>

              <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={onlyAnswered}
                  onChange={(e) => setOnlyAnswered(e.target.checked)}
                />
                <span style={{ fontSize: 13 }}>Only answered</span>
              </label>

              <span style={{ ...ui.small, alignSelf: "center" }}>
                Showing {rows.length} / {recentJobs.length}
              </span>
            </div>
          </s-stack>
        </s-card>

        <s-section heading="7-day snapshot">
          <s-inline-grid columns={{ xs: 1, sm: 2, md: 5 }} gap="base">
            <s-card padding="base" style={ui.card as any}>
              <s-stack gap="tight">
                <s-text as="h3" variant="headingSm">Abandoned</s-text>
                <s-text as="p" variant="headingLg">{stats.abandonedCount7d}</s-text>
                <s-text as="p" variant="bodySm" tone="subdued">Last 7 days</s-text>
              </s-stack>
            </s-card>

            <s-card padding="base" style={ui.card as any}>
              <s-stack gap="tight">
                <s-text as="h3" variant="headingSm">Potential</s-text>
                <s-text as="p" variant="headingLg">{money(stats.potentialRevenue7d)}</s-text>
                <s-text as="p" variant="bodySm" tone="subdued">Abandoned value</s-text>
              </s-stack>
            </s-card>

            <s-card padding="base" style={ui.card as any}>
              <s-stack gap="tight">
                <s-text as="h3" variant="headingSm">Queued</s-text>
                <s-text as="p" variant="headingLg">{stats.queuedCalls}</s-text>
                <s-text as="p" variant="bodySm" tone="subdued">Ready to dial</s-text>
              </s-stack>
            </s-card>

            <s-card padding="base" style={ui.card as any}>
              <s-stack gap="tight">
                <s-text as="h3" variant="headingSm">Completed</s-text>
                <s-text as="p" variant="headingLg">{stats.completedCalls7d}</s-text>
                <s-text as="p" variant="bodySm" tone="subdued">Calls completed</s-text>
              </s-stack>
            </s-card>

            <s-card padding="base" style={ui.card as any}>
              <s-stack gap="tight">
                <s-text as="h3" variant="headingSm">Earned</s-text>
                <s-text as="p" variant="headingLg">{money(stats.recoveredRevenue7d)}</s-text>
                <s-text as="p" variant="bodySm" tone="subdued">
                  Attributed · {stats.recoveredCount7d} orders
                </s-text>
              </s-stack>
            </s-card>
          </s-inline-grid>
        </s-section>

        <s-section heading="Recent call jobs">
          <s-card padding="base" style={ui.card as any}>
            {rows.length === 0 ? (
              <s-text as="p" tone="subdued">No matching jobs.</s-text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 10px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: 12, opacity: 0.75 }}>
                      <th style={{ padding: "0 10px" }}>Job</th>
                      <th style={{ padding: "0 10px" }}>Customer / Cart</th>
                      <th style={{ padding: "0 10px" }}>Schedule</th>
                      <th style={{ padding: "0 10px" }}>Call</th>
                      <th style={{ padding: "0 10px" }}>Insights</th>
                      <th style={{ padding: "0 10px" }}>Earned</th>
                      <th style={{ padding: "0 10px" }}>Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {rows.map((j) => {
                      const tags = parseTags(j.tagsCsv ?? null);
                      const tone = toneFromSentiment(j.sentiment ?? null);
                      const buyProbability = clamp01to100(j.buyProbability);

                      const answeredLabel =
                        j.answered === true ? "answered" : j.voicemail === true ? "voicemail" : "no_answer";

                      const hasDetails =
                        Boolean(j.summary) ||
                        Boolean(j.reason) ||
                        Boolean(j.transcript) ||
                        Boolean(j.endedReason) ||
                        Boolean(j.recordingUrl) ||
                        Boolean(j.followUp) ||
                        Boolean(j.customerIntent) ||
                        Boolean(j.callOutcome);

                      return (
                        <tr
                          key={j.id}
                          style={{
                            background: "white",
                            border: "1px solid rgba(0,0,0,0.08)",
                            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
                          }}
                        >
                          <td style={{ padding: "12px 10px", verticalAlign: "top" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <strong style={{ fontSize: 13 }}>{shortId(j.checkoutId, 18)}</strong>
                                <s-badge>{j.status}</s-badge>
                                {j.attributedAmount != null ? (
                                  <span
                                    style={{
                                      ...ui.chip,
                                      borderColor: "rgba(0,128,0,0.25)",
                                      background: "rgba(0,128,0,0.06)",
                                      fontWeight: 700,
                                    }}
                                  >
                                    earned
                                  </span>
                                ) : null}
                              </div>

                              <div style={{ fontSize: 12, opacity: 0.72 }}>
                                attempts: {j.attempts} · created: {new Date(j.createdAt).toLocaleString()}
                              </div>

                              {safeText(j.summary, 110) ? (
                                <div style={{ fontSize: 13, opacity: 0.9 }}>{safeText(j.summary, 110)}</div>
                              ) : null}
                            </div>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", minWidth: 260 }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ fontWeight: 700 }}>{j.customerName ?? "-"}</div>
                              <div style={{ fontSize: 13, opacity: 0.85 }}>{j.cartPreview ?? "-"}</div>

                              {tags.length ? (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                  {tags.slice(0, 6).map((t) => (
                                    <span key={t} style={ui.chip}>{t}</span>
                                  ))}
                                </div>
                              ) : (
                                <span style={{ ...ui.small }}>no tags</span>
                              )}
                            </div>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ fontWeight: 700 }}>{new Date(j.scheduledFor).toLocaleString()}</div>
                              <div style={ui.small}>scheduled</div>
                            </div>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", minWidth: 190 }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <s-badge tone={tone as any}>{j.sentiment ? String(j.sentiment) : "-"}</s-badge>
                                <span style={ui.chip}>{answeredLabel}</span>
                              </div>

                              {buyProbability != null ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                  <div style={{ fontSize: 12, opacity: 0.75 }}>buy probability</div>
                                  <div
                                    style={{
                                      height: 8,
                                      borderRadius: 999,
                                      border: "1px solid rgba(0,0,0,0.10)",
                                      background: "rgba(0,0,0,0.04)",
                                      overflow: "hidden",
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: `${buyProbability}%`,
                                        height: "100%",
                                        background: "rgba(0,0,0,0.35)",
                                      }}
                                    />
                                  </div>
                                  <div style={{ fontSize: 12, opacity: 0.8 }}>{buyProbability}%</div>
                                </div>
                              ) : (
                                <div style={ui.small}>no probability</div>
                              )}
                            </div>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", minWidth: 320 }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {safeText(j.reason, 140) ? (
                                <div style={{ fontSize: 13 }}>
                                  <strong>Reason:</strong> {safeText(j.reason, 140)}
                                </div>
                              ) : null}

                              {safeText(j.nextAction, 140) ? (
                                <div style={{ fontSize: 13 }}>
                                  <strong>Next:</strong> {safeText(j.nextAction, 140)}
                                </div>
                              ) : (
                                <div style={ui.small}>no next action</div>
                              )}

                              {safeText(j.followUp, 140) ? (
                                <div style={{ fontSize: 12, opacity: 0.8 }}>{safeText(j.followUp, 140)}</div>
                              ) : null}

                              {hasDetails ? (
                                <details>
                                  <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.8 }}>
                                    Details
                                  </summary>
                                  <div style={{ paddingTop: 10, fontSize: 13, lineHeight: 1.45 }}>
                                    {j.callOutcome ? (
                                      <div style={{ marginBottom: 8 }}>
                                        <strong>Outcome:</strong> {j.callOutcome}
                                      </div>
                                    ) : null}

                                    {j.customerIntent ? (
                                      <div style={{ marginBottom: 8 }}>
                                        <strong>Intent:</strong> {j.customerIntent}
                                      </div>
                                    ) : null}

                                    {j.endedReason ? (
                                      <div style={{ marginBottom: 8 }}>
                                        <strong>Ended:</strong> {j.endedReason}
                                      </div>
                                    ) : null}

                                    {j.recordingUrl ? (
                                      <div style={{ marginBottom: 8 }}>
                                        <strong>Recording:</strong>{" "}
                                        <a href={j.recordingUrl} target="_blank" rel="noreferrer">Open</a>
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
                                            maxWidth: 520,
                                          }}
                                        >
                                          {j.transcript}
                                        </pre>
                                      </div>
                                    ) : null}
                                  </div>
                                </details>
                              ) : null}
                            </div>
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                            {j.attributedAmount != null ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                <div style={{ fontWeight: 900, fontSize: 14 }}>{money(j.attributedAmount)}</div>
                                {j.attributedOrderId ? (
                                  <div style={{ fontSize: 12, opacity: 0.75 }}>order {j.attributedOrderId}</div>
                                ) : null}
                                {j.attributedAt ? (
                                  <div style={{ fontSize: 12, opacity: 0.75 }}>{new Date(j.attributedAt).toLocaleString()}</div>
                                ) : null}
                              </div>
                            ) : (
                              <span style={{ opacity: 0.6 }}>-</span>
                            )}
                          </td>

                          <td style={{ padding: "12px 10px", verticalAlign: "top" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              <Form method="post">
                                <input type="hidden" name="intent" value="manual_call" />
                                <input type="hidden" name="callJobId" value={j.id} />
                                <button
                                  type="submit"
                                  disabled={j.status !== "QUEUED"}
                                  style={{
                                    padding: "8px 10px",
                                    borderRadius: 10,
                                    border: "1px solid rgba(0,0,0,0.12)",
                                    background: j.status === "QUEUED" ? "white" : "#f3f3f3",
                                    cursor: j.status === "QUEUED" ? "pointer" : "not-allowed",
                                    fontWeight: 800,
                                  }}
                                >
                                  Call now
                                </button>
                              </Form>

                              {j.status !== "QUEUED" ? (
                                <div style={{ fontSize: 12, opacity: 0.7 }}>manual call only for queued</div>
                              ) : null}
                            </div>
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
