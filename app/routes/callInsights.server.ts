// app/callInsights.server.ts
import db from "./db.server";

export type SupabaseCallSummary = {
  id?: string;
  shop?: string | null;

  call_id: string;
  call_job_id?: string | null;
  checkout_id?: string | null;

  received_at?: string | null;
  last_received_at?: string | null;
  ai_processed_at?: string | null;

  latest_status?: string | null;
  ended_reason?: string | null;

  recording_url?: string | null;
  stereo_recording_url?: string | null;
  log_url?: string | null;

  transcript?: string | null;
  end_of_call_report?: string | null;

  call_outcome?: string | null;
  disposition?: string | null;

  answered?: boolean | null;
  voicemail?: boolean | null;

  sentiment?: string | null;
  tone?: string | null;
  buy_probability?: number | null;
  customer_intent?: string | null;

  tags?: any;
  tagcsv?: string | null;

  summary?: string | null;
  summary_clean?: string | null;

  next_best_action?: string | null;
  best_next_action?: string | null;

  follow_up_message?: string | null;

  key_quotes?: any;
  key_quotes_text?: string | null;

  objections?: any;
  objections_text?: string | null;

  issues_to_fix?: any;
  issues_to_fix_text?: string | null;

  human_intervention?: boolean | null;
  human_intervention_reason?: string | null;

  discount_suggest?: boolean | null;
  discount_percent?: number | null;
  discount_rationale?: string | null;

  ai_status?: string | null;
  ai_error?: string | null;

  ai_result?: any;
  ai_insights?: any;
  payload?: any;
  structured_outputs?: any;
};

export function safeStr(v: any) {
  return v == null ? "" : String(v);
}

export function buildCartPreview(itemsJson?: string | null): string | null {
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

export function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function uniq(values: string[]) {
  const s = new Set(values.map((x) => x.trim()).filter(Boolean));
  return Array.from(s);
}

function cleanIdList(values: string[]) {
  return uniq(values).map((x) => x.replace(/[,"'()]/g, ""));
}

export function normalizeTag(t: string) {
  return safeStr(t).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60);
}

export function parseTags(sb: SupabaseCallSummary | null | undefined): string[] {
  if (!sb) return [];

  const raw = sb.tags;

  let arr: string[] = [];
  if (Array.isArray(raw)) {
    arr = raw.map((x) => safeStr(x)).filter(Boolean);
  } else if (typeof raw === "string" && raw.trim()) {
    arr = raw.split(",").map((x) => safeStr(x)).filter(Boolean);
  } else if (typeof sb.tagcsv === "string" && sb.tagcsv.trim()) {
    arr = sb.tagcsv.split(",").map((x) => safeStr(x)).filter(Boolean);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of arr.map(normalizeTag)) {
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

export function cleanSentiment(v?: string | null) {
  const s = safeStr(v).trim().toLowerCase();
  if (s === "positive" || s === "neutral" || s === "negative") return s as any;
  return null;
}

export function pickLatestJobByCheckout(jobs: Array<any>) {
  const map = new Map<string, any>();
  for (const j of jobs) {
    const key = String(j.checkoutId ?? "");
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, j);
      continue;
    }
    const a = new Date(prev.createdAt).getTime();
    const b = new Date(j.createdAt).getTime();
    if (Number.isFinite(b) && b > a) map.set(key, j);
  }
  return map;
}

export function parseTextList(v: any, fallbackText?: string | null, max = 8): string[] {
  if (Array.isArray(v)) return v.map((x) => safeStr(x)).filter(Boolean).slice(0, max);
  if (typeof v === "string" && v.trim())
    return v
      .split(/\r?\n|,/g)
      .map((x) => safeStr(x))
      .filter(Boolean)
      .slice(0, max);
  if (fallbackText && fallbackText.trim())
    return fallbackText
      .split(/\r?\n|,/g)
      .map((x) => safeStr(x))
      .filter(Boolean)
      .slice(0, max);
  return [];
}

export function pickSummary(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  const s = safeStr(sb.summary_clean || sb.summary).trim();
  return s ? s : null;
}

export function pickNextAction(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  const s = safeStr(sb.next_best_action || sb.best_next_action).trim();
  return s ? s : null;
}

export function pickRecordingUrl(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  return (sb.recording_url || sb.stereo_recording_url || sb.log_url) ?? null;
}

export function isVapiConfiguredFromEnv() {
  const assistantId = process.env.VAPI_ASSISTANT_ID?.trim();
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID?.trim();
  const apiKey = process.env.VAPI_API_KEY?.trim();
  const serverUrl = process.env.VAPI_SERVER_URL?.trim();
  return Boolean(apiKey) && Boolean(assistantId) && Boolean(phoneNumberId) && Boolean(serverUrl);
}

export async function fetchSupabaseSummaries(opts: {
  shop: string;
  callIds?: string[];
  callJobIds?: string[];
  checkoutIds?: string[];
}): Promise<Map<string, SupabaseCallSummary>> {
  const out = new Map<string, SupabaseCallSummary>();

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) return out;

  const shop = opts.shop;

  const callIds = cleanIdList(opts.callIds ?? []);
  const callJobIds = cleanIdList(opts.callJobIds ?? []);
  const checkoutIds = cleanIdList(opts.checkoutIds ?? []);

  if (callIds.length === 0 && callJobIds.length === 0 && checkoutIds.length === 0) {
    return out;
  }

  const select = [
    "id",
    "shop",
    "call_id",
    "call_job_id",
    "checkout_id",
    "received_at",
    "last_received_at",
    "latest_status",
    "ended_reason",
    "recording_url",
    "stereo_recording_url",
    "log_url",
    "transcript",
    "end_of_call_report",
    "call_outcome",
    "disposition",
    "answered",
    "voicemail",
    "sentiment",
    "tone",
    "buy_probability",
    "customer_intent",
    "tags",
    "tagcsv",
    "summary",
    "summary_clean",
    "next_best_action",
    "best_next_action",
    "follow_up_message",
    "key_quotes",
    "key_quotes_text",
    "objections",
    "objections_text",
    "issues_to_fix",
    "issues_to_fix_text",
    "human_intervention",
    "human_intervention_reason",
    "discount_suggest",
    "discount_percent",
    "discount_rationale",
    "ai_status",
    "ai_error",
    "ai_processed_at",
    "ai_result",
    "ai_insights",
    "payload",
    "structured_outputs",
  ].join(",");

  const orParts: string[] = [];
  if (callIds.length) orParts.push(`call_id.in.(${callIds.join(",")})`);
  if (callJobIds.length) orParts.push(`call_job_id.in.(${callJobIds.join(",")})`);
  if (checkoutIds.length) orParts.push(`checkout_id.in.(${checkoutIds.join(",")})`);

  const params = new URLSearchParams();
  params.set("select", select);
  params.set("or", `(${orParts.join(",")})`);

  const withShopParams = new URLSearchParams(params);
  withShopParams.set("shop", `eq.${shop}`);

  async function doFetch(p: URLSearchParams) {
    const endpoint = `${url}/rest/v1/vapi_call_summaries?${p.toString()}`;
    const r = await fetch(endpoint, {
      method: "GET",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("[SB] fetch failed", r.status, r.statusText, body.slice(0, 800));
      return null as any;
    }

    const data = (await r.json()) as SupabaseCallSummary[];
    return Array.isArray(data) ? data : [];
  }

  let data = await doFetch(withShopParams);
  if (data && data.length === 0) {
    data = await doFetch(params);
  }

  for (const row of data || []) {
    if (!row) continue;
    if (row.call_id) out.set(`call:${String(row.call_id)}`, row);
    if (row.call_job_id) out.set(`job:${String(row.call_job_id)}`, row);
    if (row.checkout_id) out.set(`co:${String(row.checkout_id)}`, row);
  }

  return out;
}

export async function readDashboardStats(shop: string) {
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
    db.checkout.aggregate({
      where: { shop, status: "ABANDONED", abandonedAt: { gte: since } },
      _sum: { value: true },
    }),
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
  ]);

  const potentialRevenue7d = Number((potentialAgg as any)?._sum?.value ?? 0);

  return {
    abandonedCount7d,
    convertedCount7d,
    openCount7d,
    potentialRevenue7d,
    queuedCalls,
    callingNow,
    completedCalls7d,
  };
}
