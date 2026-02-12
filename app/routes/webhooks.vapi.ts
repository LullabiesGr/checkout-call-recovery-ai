// app/routes/webhooks.vapi.ts
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

  // Tags might be array OR csv string depending on your schema experiments
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

  // objections can be array OR csv string
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

  const keyQuotes = Array.isArray(o.keyQuotes)
    ? o.keyQuotes.slice(0, 5)
    : asStr(o.keyQuotesText)
    ? String(o.keyQuotesText)
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const issuesToFix = Array.isArray(o.issuesToFix)
    ? o.issuesToFix.slice(0, 5)
    : asStr(o.issuesToFixText)
    ? String(o.issuesToFixText)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

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
    keyQuotes,
    issuesToFix,
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

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";
  const expected = requiredEnv("VAPI_WEBHOOK_SECRET");
  if (secret !== expected) return new Response("Unauthorized", { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });

  const { shop, callJobId, checkoutId, providerCallId } = pickMetadata(body);

  // Identify job (strong match -> weak match)
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

  // common fields
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

  // transcript can arrive in multiple events; keep appending
  const transcriptChunk =
    asStr(body?.transcript) ||
    asStr(body?.message?.transcript) ||
    asStr(body?.call?.transcript) ||
    null;

  // structured outputs
  const structured =
    body?.call?.analysis?.structuredOutput ??
    body?.call?.analysis?.structuredOutputs?.checkout_call_outcome ??
    body?.analysis?.structuredOutput ??
    body?.analysis?.structuredOutputs?.checkout_call_outcome ??
    body?.structuredOutput ??
    body?.structuredOutputs?.checkout_call_outcome ??
    null;

  // update status from call status
  const callStatus =
    asStr(body?.call?.status) ||
    asStr(body?.status) ||
    asStr(body?.message?.status) ||
    null;

  const patch: any = {
    provider: job.provider ?? "vapi",
    providerCallId: providerCallId ?? job.providerCallId ?? null,
  };

  if (endedReason) patch.endedReason = endedReason;
  if (recordingUrl) patch.recordingUrl = recordingUrl;

  if (transcriptChunk) {
    const prev = job.transcript ? String(job.transcript) : "";
    const merged =
      prev && !prev.endsWith("\n")
        ? `${prev}\n${transcriptChunk}`
        : `${prev}${transcriptChunk}`;
    patch.transcript = merged.slice(0, 20000);
  }

  // status mapping
  if (callStatus) {
    const s = callStatus.toUpperCase();
    if (s.includes("ENDED") || s.includes("COMPLETED") || s.includes("FINISHED")) {
      patch.status = "COMPLETED";
    } else if (s.includes("FAILED")) {
      patch.status = "FAILED";
    } else if (s.includes("IN_PROGRESS") || s.includes("CALLING")) {
      patch.status = "CALLING";
    }
  }

  // If structured output exists: map it into your DB columns + JSON outcome
  if (structured && typeof structured === "object") {
    const norm = normalizeOutcomeFromStructured(structured);

    patch.sentiment = norm.sentiment ?? undefined;
    patch.tagsCsv = norm.tagsCsv ?? undefined;
    patch.reason = norm.reason ?? undefined;
    patch.nextAction = norm.nextAction ?? undefined;
    patch.followUp = norm.followUp ?? undefined;

    // outcome stored as JSON string for your UI parseOutcomeJson()
    patch.outcome = safeJson(norm.outcomeJson, 2000) ?? patch.outcome;

    // keep full object too
    patch.analysisJson = safeJson(norm.outcomeJson, 9000) ?? undefined;
  }

  // if end-of-call-report arrives without structured output, store raw call analysis anyway
  const rawCallAnalysis = body?.call?.analysis ?? body?.analysis ?? body?.call?.callAnalysis ?? null;
  if (!structured && rawCallAnalysis) {
    patch.analysisJson = patch.analysisJson ?? safeJson(rawCallAnalysis, 9000) ?? undefined;
  }

  await db.callJob.update({
    where: { id: job.id },
    data: patch,
  });

  return new Response("OK", { status: 200 });
}
