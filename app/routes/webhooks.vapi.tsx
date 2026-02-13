// app/routes/webhooks.vapi.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function pickMessage(payload: any) {
  // Vapi docs show { message: { type, ... } }, but keep compatibility with flatter payloads
  return payload?.message ?? payload ?? {};
}

function safeStr(v: any, max = 4000) {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function csvFromTags(tags: any): string | null {
  if (!Array.isArray(tags)) return null;
  const clean = tags
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 30);
  return clean.length ? clean.join(",") : null;
}

// --- NEW: robust JSON extraction without breaking anything else ---
function stripCodeFences(s: string) {
  const t = safeStr(s, 20000).trim();
  if (!t) return "";
  if (t.startsWith("```")) {
    return t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return t;
}

function tryParseJsonObject(text: string): any | null {
  const raw = stripCodeFences(text);
  if (!raw) return null;

  // 1) direct parse
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}

  // 2) attempt extract first {...} block
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const chunk = raw.slice(start, end + 1);
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  return null;
}

function clamp01(n: any) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeDisposition(v: any) {
  const s = String(v ?? "").trim().toLowerCase();
  if (
    s === "interested" ||
    s === "needs_support" ||
    s === "call_back_later" ||
    s === "not_interested" ||
    s === "wrong_number" ||
    s === "unknown"
  ) return s;
  return "unknown";
}

async function analyzeCallWithOpenAI(args: {
  transcript: string;
  endedReason?: string | null;
  shop: string;
  checkoutId: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // UPGRADE: still JSON, same flow, just richer keys
  const input = `
You are analyzing a phone call between a merchant AI agent and a customer who abandoned checkout.

Return STRICT JSON with exactly these keys:
{
  "answered": boolean,
  "sentiment": "positive" | "neutral" | "negative",
  "disposition": "interested" | "needs_support" | "call_back_later" | "not_interested" | "wrong_number" | "unknown",
  "tags": string[],
  "shortSummary": string,
  "reason": string,
  "nextAction": string,
  "followUp": string,
  "buyProbability": number,
  "churnProbability": number,
  "confidence": number
}

Rules:
- answered: true only if there is real engagement (not voicemail/no-answer/busy).
- tags must be short lowercase tokens (e.g. "price", "shipping", "payment", "timing", "trust", "not_interested", "wrong_number", "needs_support", "coupon_request", "call_back_later").
- shortSummary: one sentence, plain English.
- reason: 1-2 sentences, factual.
- nextAction: ONE concrete step the merchant should do next.
- followUp: text the merchant can send (SMS/email) in a friendly tone.
- buyProbability, churnProbability, confidence: 0..1.

Context:
- shop: ${args.shop}
- checkoutId: ${args.checkoutId}
- endedReason: ${args.endedReason ?? "-"}
Transcript:
${args.transcript}
`.trim();

  // OpenAI Responses API (unchanged)
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input,
      temperature: 0.15,
      max_output_tokens: 550,
    }),
  });

  if (!r.ok) return null;

  const json = await r.json().catch(() => null);
  if (!json) return null;

  const text =
    json?.output_text ??
    json?.output?.[0]?.content?.[0]?.text ??
    json?.output?.[0]?.content?.[0]?.value ??
    "";

  const raw = safeStr(text, 8000).trim();
  if (!raw) return null;

  // Robust parse
  const parsed = tryParseJsonObject(raw);
  if (!parsed) return { raw };

  // Normalize + clamp without changing callers
  const cleaned = {
    answered: Boolean((parsed as any).answered),
    sentiment: String((parsed as any).sentiment ?? "neutral").toLowerCase(),
    disposition: normalizeDisposition((parsed as any).disposition),
    tags: Array.isArray((parsed as any).tags) ? (parsed as any).tags : [],
    shortSummary: safeStr((parsed as any).shortSummary ?? "", 400),
    reason: safeStr((parsed as any).reason ?? "", 2000),
    nextAction: safeStr((parsed as any).nextAction ?? "", 500),
    followUp: safeStr((parsed as any).followUp ?? "", 1200),
    buyProbability: clamp01((parsed as any).buyProbability),
    churnProbability: clamp01((parsed as any).churnProbability),
    confidence: clamp01((parsed as any).confidence),
  };

  // fallback sentiment to allowed set
  if (cleaned.sentiment !== "positive" && cleaned.sentiment !== "neutral" && cleaned.sentiment !== "negative") {
    cleaned.sentiment = "neutral";
  }

  return cleaned;
}

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? "";
  if (!process.env.VAPI_WEBHOOK_SECRET || secret !== process.env.VAPI_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return new Response("Bad Request", { status: 400 });

  const msg = pickMessage(payload);

  const messageType = String(msg?.type ?? msg?.messageType ?? msg?.event ?? "");
  const call = msg?.call ?? payload?.call ?? null;

  const metadata = (call?.metadata ?? msg?.metadata ?? payload?.metadata ?? payload?.assistant?.metadata ?? {}) as any;
  const shop = String(metadata?.shop ?? "").trim();
  const callJobId = String(metadata?.callJobId ?? "").trim();
  const checkoutIdMeta = String(metadata?.checkoutId ?? "").trim();

  if (!shop || !callJobId) {
    return new Response("OK", { status: 200 });
  }

  // status updates (optional)
  if (messageType === "status-update") {
    const status = String(msg?.status ?? "").toLowerCase();
    const newStatus =
      status === "in-progress" || status === "connected"
        ? "CALLING"
        : status === "ended"
          ? "COMPLETED"
          : null;

    await db.callJob.updateMany({
      where: { id: callJobId, shop },
      data: {
        status: (newStatus as any) ?? undefined,
        outcome: safeStr(`VAPI_STATUS: ${status}`, 2000),
      },
    });

    return new Response("OK", { status: 200 });
  }

  // final transcript events
  if (messageType.startsWith("transcript")) {
    const transcriptType = String(msg?.transcriptType ?? "");
    const transcript = safeStr(msg?.transcript ?? "", 20000);

    const isFinal =
      transcriptType === "final" || messageType.includes('transcriptType="final"');

    if (isFinal && transcript) {
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          transcript,
          outcome: safeStr("VAPI_TRANSCRIPT_FINAL_RECEIVED", 2000),
        },
      });
    }

    return new Response("OK", { status: 200 });
  }

  // end-of-call-report (main value)
  if (messageType === "end-of-call-report") {
    const endedReason = safeStr(msg?.endedReason ?? "", 200);
    const artifact = msg?.artifact ?? {};
    const transcript = safeStr(artifact?.transcript ?? "", 20000);

    const recordingUrl =
      artifact?.recording?.url ??
      artifact?.recording?.downloadUrl ??
      artifact?.recording?.recordingUrl ??
      null;

    await db.callJob.updateMany({
      where: { id: callJobId, shop },
      data: {
        status: "COMPLETED",
        endedReason: endedReason || null,
        transcript: transcript || null,
        recordingUrl: recordingUrl ? safeStr(recordingUrl, 2000) : null,
        outcome: safeStr("VAPI_END_OF_CALL_REPORT", 2000),
      },
    });

    const analysis = transcript
      ? await analyzeCallWithOpenAI({
          transcript,
          endedReason: endedReason || null,
          shop,
          checkoutId: checkoutIdMeta || "",
        })
      : null;

    if (analysis) {
      const sentiment = safeStr((analysis as any)?.sentiment ?? "", 30) || null;
      const tagsCsv = csvFromTags((analysis as any)?.tags) ?? null;

      // keep your old fields, plus richer JSON inside analysisJson
      const reason = safeStr((analysis as any)?.reason ?? (analysis as any)?.raw ?? "", 2000) || null;
      const nextAction = safeStr((analysis as any)?.nextAction ?? "", 500) || null;
      const followUp = safeStr((analysis as any)?.followUp ?? "", 1200) || null;

      const shortSummary = safeStr((analysis as any)?.shortSummary ?? "", 400);
      const answered = (analysis as any)?.answered;
      const disposition = safeStr((analysis as any)?.disposition ?? "unknown", 30);
      const buyProbability = (analysis as any)?.buyProbability;
      const churnProbability = (analysis as any)?.churnProbability;
      const confidence = (analysis as any)?.confidence;

      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          sentiment,
          tagsCsv,
          reason,
          nextAction,
          followUp,
          analysisJson: safeStr(JSON.stringify(analysis), 8000),
          outcome: safeStr(
            `${sentiment ?? "unknown"} | ${tagsCsv ?? "-"} | ${shortSummary || reason || "no-reason"} | ${answered === true ? "answered" : answered === false ? "no_answer" : "unknown"} | ${disposition} | buy=${Math.round(clamp01(buyProbability) * 100)}%`,
            2000
          ),
        },
      });
    }

    return new Response("OK", { status: 200 });
  }

  // default: store event type for debugging
  await db.callJob.updateMany({
    where: { id: callJobId, shop },
    data: {
      outcome: safeStr(`VAPI_EVENT: ${messageType || "unknown"}`, 2000),
    },
  });

  return new Response("OK", { status: 200 });
}
