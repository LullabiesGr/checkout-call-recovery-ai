// app/callProvider.server.ts
import db from "./db.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildSystemPrompt(args: {
  merchantPrompt?: string | null;
  checkout: {
    checkoutId: string;
    customerName?: string | null;
    email?: string | null;
    phone?: string | null;
    value: number;
    currency: string;
    itemsJson?: string | null;
  };
}) {
  const { merchantPrompt, checkout } = args;

  const items = (() => {
    try {
      const arr = checkout.itemsJson ? JSON.parse(checkout.itemsJson) : [];
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, 10);
    } catch {
      return [];
    }
  })();

  const cartText =
    items.length === 0
      ? "No cart items available."
      : items
          .map((it: any) => `- ${it?.title ?? "Item"} x${Number(it?.quantity ?? 1)}`)
          .join("\n");

  const base = `
You are the merchant's AI phone agent. Your job: recover an abandoned checkout politely and efficiently.

Rules:
- Never be pushy. Confirm identity. Ask if it's a good time.
- Use the cart context and total value.
- If the customer objects, handle objections and offer help.
- If they want to buy: guide them to complete checkout (send link if available, or instruct steps).
- If they do not want to continue: end politely and mark as not interested.
- Keep calls short.

Context:
- Checkout ID: ${checkout.checkoutId}
- Customer name: ${checkout.customerName ?? "-"}
- Email: ${checkout.email ?? "-"}
- Cart total: ${checkout.value} ${checkout.currency}
- Cart items:
${cartText}
`.trim();

  const merchant = (merchantPrompt ?? "").trim();
  if (!merchant) return base;

  return `${base}\n\nMerchant instructions (must follow):\n${merchant}`.trim();
}

export async function startVapiCallForJob(params: { shop: string; callJobId: string }) {
  const VAPI_API_KEY = requiredEnv("VAPI_API_KEY");
  const VAPI_ASSISTANT_ID = requiredEnv("VAPI_ASSISTANT_ID");
  const VAPI_PHONE_NUMBER_ID = requiredEnv("VAPI_PHONE_NUMBER_ID");
  const APP_URL = requiredEnv("APP_URL");
  const VAPI_WEBHOOK_SECRET = requiredEnv("VAPI_WEBHOOK_SECRET");

  const job = await db.callJob.findFirst({
    where: { id: params.callJobId, shop: params.shop },
  });
  if (!job) throw new Error("CallJob not found");

  const checkout = await db.checkout.findFirst({
    where: { shop: params.shop, checkoutId: job.checkoutId },
  });
  if (!checkout) throw new Error("Checkout not found");

  const settings = await db.settings.findUnique({ where: { shop: params.shop } });

  const systemPrompt = buildSystemPrompt({
    merchantPrompt: (settings as any)?.userPrompt ?? "",
    checkout: {
      checkoutId: String(checkout.checkoutId),
      customerName: checkout.customerName,
      email: checkout.email,
      phone: checkout.phone,
      value: checkout.value,
      currency: checkout.currency,
      itemsJson: checkout.itemsJson,
    },
  });

  // DO NOT increment attempts here.
  // Attempts must be incremented exactly once in the runner lock (/api/run-calls).
  await db.callJob.update({
    where: { id: job.id },
    data: {
      status: "CALLING",
      provider: "vapi",
      outcome: null,
    },
  });

  const webhookUrl = `${APP_URL.replace(/\/$/, "")}/webhooks/vapi?secret=${encodeURIComponent(
    VAPI_WEBHOOK_SECRET
  )}`;

  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VAPI_API_KEY}`,
      Accept: "application/json",
    },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      assistantId: VAPI_ASSISTANT_ID,

      customer: {
        number: job.phone,
        name: checkout.customerName ?? undefined,
      },

      assistant: {
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content:
                "Start the call now. Greet the customer and mention you noticed they almost completed checkout. Ask if they need help finishing the order.",
            },
          ],
        },

        // webhook
        serverUrl: webhookUrl,
        serverMessages: [
          "status-update",
          "end-of-call-report",
          'transcript[transcriptType="final"]',
        ],

        metadata: {
          shop: params.shop,
          callJobId: job.id,
          checkoutId: job.checkoutId,
        },
      },

      metadata: {
        shop: params.shop,
        callJobId: job.id,
        checkoutId: job.checkoutId,
      },
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    await db.callJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        outcome: `VAPI_ERROR: ${JSON.stringify(json)}`,
      },
    });
    throw new Error(`Vapi create call failed: ${JSON.stringify(json)}`);
  }

  const providerCallId = String(json?.id ?? json?.call?.id ?? "");

  await db.callJob.update({
    where: { id: job.id },
    data: {
      providerCallId: providerCallId || null,
      outcome: `VAPI_CALL_CREATED`,
      status: "CALLING",
    },
  });

  return { ok: true, providerCallId, raw: json };
}

export async function createVapiCallForJob(params: { shop: string; callJobId: string }) {
  return startVapiCallForJob(params);
}

export async function placeCall(params: {
  shop: string;
  phone: string;
  checkoutId: string;
  customerName?: string | null;
  items?: Array<{ title: string; quantity?: number }> | null;
  amount?: number | null;
  currency?: string | null;
}) {
  throw new Error("placeCall not wired. Use CallJob pipeline + /api/run-calls.");
}
