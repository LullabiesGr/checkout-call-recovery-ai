// app/routes/webhooks.vapi.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

function safeStr(x: any) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function extractTranscript(payload: any): string | null {
  // Vapi payloads διαφέρουν. Πάρε best-effort από πολλά paths.
  const direct =
    payload?.transcript ??
    payload?.analysis?.transcript ??
    payload?.message?.transcript ??
    payload?.data?.transcript;

  if (typeof direct === "string" && direct.trim()) return direct.trim();

  // Αν έρθουν messages/turns
  const turns = payload?.conversation?.turns ?? payload?.turns ?? payload?.messages;
  if (Array.isArray(turns)) {
    const text = turns
      .map((t: any) => t?.text ?? t?.content ?? t?.message ?? "")
      .map((s: any) => safeStr(s).trim())
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text.trim();
  }

  return null;
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
You analyze a phone call between a merchant AI agent and a customer about an abandoned Shopify checkout.

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

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? "";
  if (!process.env.VAPI_WEBHOOK_SECRET || secret !== process.env.VAPI_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return new Response("Bad Request", { status: 400 });

  const metadata = payload?.metadata ?? payload?.assistant?.metadata ?? {};
  const shop = safeStr(metadata?.shop).trim();
  const callJobId = safeStr(metadata?.callJobId).trim();
  if (!shop || !callJobId) return new Response("OK", { status: 200 });

  // status mapping (best effort)
  const lowered = JSON.stringify(payload).toLowerCase();
  let newStatus: "CALLING" | "COMPLETED" | "FAILED" | null = null;

  if (lowered.includes("end-of-call-report") || lowered.includes("ended")) {
    newStatus = lowered.includes("error") ? "FAILED" : "COMPLETED";
  } else if (lowered.includes("in-progress") || lowered.includes("connected") || lowered.includes("status-update")) {
    newStatus = "CALLING";
  }

  // update quick outcome first
  const quickSummary =
    payload?.analysis?.summary ??
    payload?.summary ??
    payload?.endedReason ??
    payload?.status ??
    payload?.type ??
    "VAPI_EVENT";

  await db.callJob.updateMany({
    where: { id: callJobId, shop },
    data: {
      status: newStatus ?? undefined,
      outcome: safeStr(quickSummary).slice(0, 500),
    },
  });

  // If call ended OR final transcript arrived => analyze
  const isEnd = lowered.includes("end-of-call-report") || lowered.includes("ended");
  const transcript = extractTranscript(payload);

  if (isEnd && transcript) {
    const job = await db.callJob.findFirst({ where: { id: callJobId, shop } });
    const checkout = job
      ? await db.checkout.findFirst({ where: { shop, checkoutId: job.checkoutId } })
      : null;

    const analysis = await analyzeWithOpenAI({
      transcript,
      customerName: checkout?.customerName ?? null,
      checkoutId: job?.checkoutId ?? safeStr(metadata?.checkoutId ?? ""),
      shop,
    });

    if (analysis) {
      // store JSON into outcome (no migration needed)
      const packed = JSON.stringify({
        type: "analysis_v1",
        at: new Date().toISOString(),
        analysis,
      });

      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          status: "COMPLETED",
          outcome: packed.slice(0, 2000),
        },
      });
    } else {
      // fallback: store transcript trimmed
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          status: "COMPLETED",
          outcome: JSON.stringify({
            type: "analysis_fallback_v1",
            at: new Date().toISOString(),
            short_summary: safeStr(quickSummary).slice(0, 200),
            transcript: transcript.slice(0, 1400),
          }).slice(0, 2000),
        },
      });
    }
  }

  return new Response("OK", { status: 200 });
}
