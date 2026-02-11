// app/callProvider.server.ts
import { VapiClient } from "@vapi-ai/server-sdk";
import db from "./db.server";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function buildCartPreview(itemsJson?: string | null): string {
  if (!itemsJson) return "";
  try {
    const items = JSON.parse(itemsJson);
    if (!Array.isArray(items)) return "";
    return items
      .slice(0, 6)
      .map((it: any) => `${String(it?.title ?? "").trim()} x${Number(it?.quantity ?? 1)}`)
      .filter(Boolean)
      .join(", ");
  } catch {
    return "";
  }
}

function buildDynamicPrompt(params: {
  basePreprompt: string;
  userPrompt?: string | null;
  shop: string;
  customerName?: string | null;
  cartPreview?: string;
  currency: string;
  value: number;
}) {
  const {
    basePreprompt,
    userPrompt,
    shop,
    customerName,
    cartPreview,
    currency,
    value,
  } = params;

  const parts: string[] = [];
  parts.push(basePreprompt.trim());

  parts.push(
    [
      `Context:`,
      `Store: ${shop}`,
      `Customer name: ${customerName || "unknown"}`,
      `Cart: ${cartPreview || "unknown"}`,
      `Cart value: ${value.toFixed(2)} ${currency}`,
      ``,
      `Rules:`,
      `- Be concise. One question at a time.`,
      `- If customer says they already ordered, end politely.`,
      `- Never mention internal tools or databases.`,
    ].join("\n")
  );

  if (userPrompt && userPrompt.trim()) {
    parts.push(`Merchant instructions:\n${userPrompt.trim()}`);
  }

  return parts.join("\n\n").trim();
}

export async function createVapiCallForJob(params: {
  shop: string;
  callJobId: string;
}) {
  const { shop, callJobId } = params;

  const token = requireEnv("VAPI_API_KEY");
  const vapi = new VapiClient({ token });

  const job = await db.callJob.findFirst({
    where: { id: callJobId, shop },
  });
  if (!job) throw new Error("CallJob not found");

  const settings = await db.settings.findUnique({ where: { shop } });
  if (!settings?.vapiAssistantId || !settings?.vapiPhoneNumberId) {
    throw new Error("Missing Vapi settings (assistantId/phoneNumberId)");
  }

  const checkout = await db.checkout.findFirst({
    where: { shop, checkoutId: job.checkoutId },
  });

  const basePreprompt =
    `You are a helpful phone agent calling an e-commerce customer about an incomplete checkout. ` +
    `Your goal is to help them complete the purchase or answer questions. Keep it natural, calm, and professional.`;

  const cartPreview = buildCartPreview(checkout?.itemsJson ?? null);

  const dynamicPrompt = buildDynamicPrompt({
    basePreprompt,
    userPrompt: settings.userPrompt,
    shop,
    customerName: checkout?.customerName ?? null,
    cartPreview,
    currency: checkout?.currency ?? settings.currency ?? "USD",
    value: checkout?.value ?? 0,
  });

  // Lock -> CALLING + attempts increment (atomic)
  const locked = await db.callJob.updateMany({
    where: { id: job.id, shop, status: "QUEUED" },
    data: {
      status: "CALLING",
      attempts: { increment: 1 },
      provider: "vapi",
    },
  });
  if (locked.count === 0) {
    return { ok: true, skipped: true };
  }

  // Create call
  const call = await vapi.calls.create({
    phoneNumberId: settings.vapiPhoneNumberId,
    assistantId: settings.vapiAssistantId,
    customer: {
      number: job.phone,
      name: checkout?.customerName ?? undefined,
    },
    metadata: {
      shop,
      callJobId: job.id,
      checkoutId: job.checkoutId,
    },
    // Override assistant behavior per-call (dynamic prompt)
    assistantOverrides: {
      model: {
        messages: [{ role: "system", content: dynamicPrompt }],
      },
    },
  } as any);

  await db.callJob.update({
    where: { id: job.id },
    data: {
      providerCallId: String((call as any)?.id ?? ""),
      outcome: "CALL_CREATED",
    },
  });

  return { ok: true, providerCallId: String((call as any)?.id ?? "") };
}
