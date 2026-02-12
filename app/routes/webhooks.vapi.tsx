// app/routes/webhooks.vapi.tsx
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function asStr(v: any): string | null {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  const t = s.trim();
  return t ? t : null;
}

function toCsv(arr: any): string | null {
  if (!Array.isArray(arr)) return null;
  const items = arr
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  return items.length ? items.join(", ") : null;
}

function safeJson(obj: any, max = 9000): string | null {
  try {
    const s = JSON.stringify(obj ?? null);
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
}

function pickMetadata(body: any) {
  const md =
    body?.assistant?.metadata ??
    body?.call?.assistant?.metadata ??
    body?.metadata ??
    body?.call?.metadata ??
    null;

  const shop = asStr(md?.shop);
  const callJobId = asStr(md?.callJobId);
  const checkoutId = asStr(md?.checkoutId);

  const providerCallId =
    asStr(body?.call?.id) ||
    asStr(body?.callId) ||
    asStr(body?.id) ||
    asStr(body?.call?.callId) ||
    null;

  return { shop, callJobId, checkoutId, providerCallId };
}

function normalizeOutcomeFromStructured(structured: any) {
  const o = structured ?? {};

  const tags = Array.isArray(o.tags)
    ? o.tags
    : asStr(o.tagsCsv)
    ? String(o.tagsCsv)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  const summary = asStr(o.summary) ?? "Call outcome received.";
  const nextAction = asStr(o.bestNextAction) ?? asStr(o.nextAction) ?? null;

  const sentiment = asStr(o.sentiment);
  const followUp = asStr(o.followUpMessage) ?? asStr(o.followUp) ?? null;

  const objections = Array.isArray(o.objections)
    ? o.objections
    : asStr(o.objectionsText)
    ? String(o.objectionsText)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  const intent = asStr(o.customerIntent) ?? null;
  const callOutcome = asStr(o.callOutcome) ?? null;

  const buyProbability =
    Number.isFinite(Number(o.buyProbability)) ? Number(o.buyProbability) : null;

  const reasonParts = [
    callOutcome ? `Outcome: ${callOutcome}` : null,
    intent ? `Intent: ${intent}` : null,
    objections.length ? `Objections: ${objections.join(", ")}` : null,
    buyProbability != null ? `Buy probability: ${buyProbability}%` : null,
  ].filter(Boolean);

  const reason = reasonParts.length ? reasonParts.join(" · ") : null;

  const outcomeJson = {
    sentiment,
    tags,
    reason,
    nextAction,
    followUp,
    summary,
    buyProbability,
    answered: !!o.answered,
    voicemail: !!o.voicemail,
    callOutcome,
    customerIntent: intent,
    tone: asStr(o.tone),
  };

  return {
    outcomeJson,
    tagsCsv: toCsv(tags),
    sentiment,
    reason,
    nextAction,
    followUp,
  };
}

async function analyzeWithOpenAI(args: {
  transcript: string;
  customerName?: string | null;
  checkoutId: string;
  shop: string;
}) {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) return null;

  const model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

  const system = `
Return STRICT JSON only. No markdown.

Schema:
{
  "sentiment": "positive" | "neutral" | "negative",
  "intent": "buy_now" | "buy_later" | "not_interested" | "needs_help" | "no_answer" | "wrong_number" | "other",
  "result": "recovered" | "not_recovered" | "unknown",
  "reasons": string[],
  "objections": string[],
  "tags": string[],
  "next_action": {
    "priority": "high" | "medium" | "low",
    "action": string,
    "channel": "call" | "sms" | "email" | "none",
    "when_minutes": number
  },
  "short_summary": string
}
`.trim();

  const user = `
Shop: ${args.shop}
CheckoutId: ${args.checkoutId}
Customer: ${args.customerName ?? "-"}
Transcript:
${args.transcript}
`.trim();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!r.ok) return null;

  const j = await r.json().catch(() => null);
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return null;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isEndedStatus(s: string | null): boolean {
  if (!s) return false;
  const u = s.toUpperCase();
  return u.includes("ENDED") || u.includes("COMPLETED") || u.includes("FINISHED");
}

function isFailedStatus(s: string | null): boolean {
  if (!s) return false;
  const u = s.toUpperCase();
  return u.includes("FAILED") || u.includes("ERROR");
}

function isCallingStatus(s: string | null): boolean {
  if (!s) return false;
  const u = s.toUpperCase();
  return (
    u.includes("IN_PROGRESS") ||
    u.includes("CALLING") ||
    u.includes("RINGING") ||
    u.includes("QUEUED") ||
    u.includes("INITIATED") ||
    u.includes("CONNECTED")
  );
}

function alreadyHasOpenAI(job: any): boolean {
  const blob = `${job?.analysisJson ?? ""} ${job?.outcome ?? ""}`;
  return blob.includes('"type":"analysis_v1"') || blob.includes('"type": "analysis_v1"');
}

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";
  const expected = requiredEnv("VAPI_WEBHOOK_SECRET");
  if (secret !== expected) return new Response("Unauthorized", { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });

  const { shop, callJobId, checkoutId, providerCallId } = pickMetadata(body);

  const job =
    (shop && callJobId
      ? await db.callJob.findFirst({ where: { shop, id: callJobId } })
      : null) ||
    (shop && checkoutId
      ? await db.callJob.findFirst({
          where: { shop, checkoutId },
          orderBy: { createdAt: "desc" },
        })
      : null) ||
    (shop && providerCallId
      ? await db.callJob.findFirst({ where: { shop, providerCallId } })
      : null);

  if (!job) return new Response("OK", { status: 200 });

  const callStatus =
    asStr(body?.call?.status) ||
    asStr(body?.status) ||
    asStr(body?.message?.status) ||
    null;

  // PHASE 1: FAST LIVE UPDATE (prevents scheduler spam + enables live UI)
  if (!isEndedStatus(callStatus)) {
    const fast: any = {
      provider: job.provider ?? "vapi",
      providerCallId: providerCallId ?? job.providerCallId ?? null,
    };

    if (isFailedStatus(callStatus)) fast.status = "FAILED";
    else if (isCallingStatus(callStatus)) fast.status = "CALLING";

    // never downgrade completed jobs
    if (job.status === "COMPLETED") delete fast.status;

    await db.callJob.update({ where: { id: job.id }, data: fast });

    // transcript chunks can still come while calling; append if present
    const transcriptChunk =
      asStr(body?.transcript) ||
      asStr(body?.message?.transcript) ||
      asStr(body?.call?.transcript) ||
      null;

    if (transcriptChunk) {
      const prev = job.transcript ? String(job.transcript) : "";
      const merged =
        prev && !prev.endsWith("\n") ? `${prev}\n${transcriptChunk}` : `${prev}${transcriptChunk}`;

      await db.callJob.update({
        where: { id: job.id },
        data: { transcript: merged.slice(0, 20000) },
      });
    }

    return new Response("OK", { status: 200 });
  }

  // PHASE 2: END-OF-CALL
  const endedReason =
    asStr(body?.call?.endedReason) ||
    asStr(body?.endedReason) ||
    asStr(body?.call?.endReason) ||
    null;

  const recordingUrl =
    asStr(body?.call?.recordingUrl) ||
    asStr(body?.recordingUrl) ||
    asStr(body?.call?.recording?.url) ||
    null;

  const transcriptChunk =
    asStr(body?.transcript) ||
    asStr(body?.message?.transcript) ||
    asStr(body?.call?.transcript) ||
    null;

  const structured =
    body?.call?.analysis?.structuredOutput ??
    body?.call?.analysis?.structuredOutputs?.checkout_call_outcome ??
    body?.analysis?.structuredOutput ??
    body?.analysis?.structuredOutputs?.checkout_call_outcome ??
    body?.structuredOutput ??
    body?.structuredOutputs?.checkout_call_outcome ??
    null;

  const patch: any = {
    provider: job.provider ?? "vapi",
    providerCallId: providerCallId ?? job.providerCallId ?? null,
    status: "COMPLETED",
  };

  if (endedReason) patch.endedReason = endedReason;
  if (recordingUrl) patch.recordingUrl = recordingUrl;

  if (transcriptChunk) {
    const prev = job.transcript ? String(job.transcript) : "";
    const merged =
      prev && !prev.endsWith("\n") ? `${prev}\n${transcriptChunk}` : `${prev}${transcriptChunk}`;
    patch.transcript = merged.slice(0, 20000);
  }

  if (structured && typeof structured === "object") {
    const norm = normalizeOutcomeFromStructured(structured);
    patch.sentiment = norm.sentiment ?? undefined;
    patch.tagsCsv = norm.tagsCsv ?? undefined;
    patch.reason = norm.reason ?? undefined;
    patch.nextAction = norm.nextAction ?? undefined;
    patch.followUp = norm.followUp ?? undefined;
    patch.outcome = safeJson(norm.outcomeJson, 2000) ?? patch.outcome;
    patch.analysisJson = safeJson(norm.outcomeJson, 9000) ?? undefined;
  }

  const rawCallAnalysis = body?.call?.analysis ?? body?.analysis ?? body?.call?.callAnalysis ?? null;
  if (!structured && rawCallAnalysis) {
    patch.analysisJson = patch.analysisJson ?? safeJson(rawCallAnalysis, 9000) ?? undefined;
  }

  // OpenAI post-processing ONLY at end, ONLY if no structured output, ONLY once
  if (!structured && !alreadyHasOpenAI(job)) {
    const transcript =
      (asStr(patch.transcript) || (job.transcript ? String(job.transcript) : "")).trim();

    if (transcript) {
      const checkout = await db.checkout
        .findFirst({ where: { shop: job.shop, checkoutId: job.checkoutId } })
        .catch(() => null);

      const analysis = await analyzeWithOpenAI({
        transcript: transcript.slice(0, 12000),
        customerName: checkout?.customerName ?? null,
        checkoutId: job.checkoutId,
        shop: job.shop,
      });

      if (analysis) {
        const packed = { type: "analysis_v1", at: new Date().toISOString(), analysis };
        patch.outcome = safeJson(packed, 2000) ?? patch.outcome;
        patch.analysisJson = safeJson(packed, 9000) ?? patch.analysisJson;
      }
    }
  }

  await db.callJob.update({ where: { id: job.id }, data: patch });

  return new Response("OK", { status: 200 });
}
