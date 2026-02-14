// app/lib/callInsights.shared.ts

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

export function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
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

export function pickRecordingUrl(sb: SupabaseCallSummary | null): string | null {
  if (!sb) return null;
  return (sb.recording_url || sb.stereo_recording_url || sb.log_url) ?? null;
}
