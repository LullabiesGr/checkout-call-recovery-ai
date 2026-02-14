// app/lib/callInsights.server.ts
import type { SupabaseCallSummary } from "./callInsights.shared";

function uniq(values: string[]) {
  const s = new Set(values.map((x) => x.trim()).filter(Boolean));
  return Array.from(s);
}
function cleanIdList(values: string[]) {
  return uniq(values).map((x) => x.replace(/[,"'()]/g, ""));
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

  if (callIds.length === 0 && callJobIds.length === 0 && checkoutIds.length === 0) return out;

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
  if (data && data.length === 0) data = await doFetch(params);

  for (const row of data || []) {
    if (!row) continue;
    if (row.call_id) out.set(`call:${String(row.call_id)}`, row);
    if (row.call_job_id) out.set(`job:${String(row.call_job_id)}`, row);
    if (row.checkout_id) out.set(`co:${String(row.checkout_id)}`, row);
  }

  return out;
}
