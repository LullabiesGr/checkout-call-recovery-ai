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

async function analyzeCallWithOpenAI(args: {
  transcript: string;
  endedReason?: string | null;
  shop: string;
  checkoutId: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const input = `
You are analyzing a phone call between a merchant AI agent and a customer who abandoned checkout.

Return STRICT JSON with exactly these keys:
{
  "sentiment": "positive" | "neutral" | "negative",
  "tags": string[],
  "reason": string,
  "nextAction": string,
  "followUp": string,
  "confidence": number
}

Rules:
- tags must be short lowercase tokens (e.g. "price", "shipping", "payment", "timing", "trust", "not_interested", "wrong_number", "needs_support", "coupon_request", "call_back_later").
- reason: 1-2 sentences, factual.
- nextAction: ONE concrete step the merchant should do next.
- followUp: text the merchant can send (SMS/email) in a friendly tone.
- confidence: 0..1.

Context:
- shop: ${args.shop}
- checkoutId: ${args.checkoutId}
- endedReason: ${args.endedReason ?? "-"}
Transcript:
${args.transcript}
`.trim();

  // OpenAI Responses API
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input,
      temperature: 0.2,
      max_output_tokens: 400,
    }),
  });

  if (!r.ok) return null;

  const json = await r.json().catch(() => null);
  if (!json) return null;

  // Pull text output (defensive; Responses output shape can vary by SDK)
  const text =
    json?.output_text ??
    json?.output?.[0]?.content?.[0]?.text ??
    json?.output?.[0]?.content?.[0]?.value ??
    "";

  const raw = safeStr(text, 6000).trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    // If model returned non-json, keep raw for debugging
    return { raw };
  }
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

    // store only final transcript chunks (or final-only event type)
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

    // Mark completed unless you detect error patterns
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

    // Post-call analysis -> tags + next action
    const analysis = transcript
      ? await analyzeCallWithOpenAI({
          transcript,
          endedReason: endedReason || null,
          shop,
          checkoutId: checkoutIdMeta || "",
        })
      : null;

    if (analysis) {
      const sentiment = safeStr(analysis?.sentiment ?? "", 30) || null;
      const tagsCsv = csvFromTags(analysis?.tags) ?? null;
      const reason = safeStr(analysis?.reason ?? analysis?.raw ?? "", 2000) || null;
      const nextAction = safeStr(analysis?.nextAction ?? "", 500) || null;
      const followUp = safeStr(analysis?.followUp ?? "", 1200) || null;

      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          sentiment,
          tagsCsv,
          reason,
          nextAction,
          followUp,
          analysisJson: safeStr(JSON.stringify(analysis), 6000),
          outcome: safeStr(
            `${sentiment ?? "unknown"} | ${tagsCsv ?? "-"} | ${reason ?? "no-reason"}`,
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
