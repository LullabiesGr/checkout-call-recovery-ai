// app/routes/webhooks.vapi.tsx
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json().catch(() => null);

  // Vapi sends { message: {...} } in many setups
  const message = body?.message ?? body;
  if (!message) return new Response("OK", { status: 200 });

  // Best effort: read metadata we set on create
  const call = message?.call;
  const meta = call?.metadata ?? {};
  const shop = String(meta.shop ?? "");
  const callJobId = String(meta.callJobId ?? "");
  const providerCallId = String(call?.id ?? "");

  if (!shop || !callJobId) return new Response("OK", { status: 200 });

  // status updates
  if (message.type === "status-update") {
    const status = String(call?.status ?? "").toUpperCase();

    // Map Vapi statuses to our statuses (best effort)
    let next: "CALLING" | "COMPLETED" | "FAILED" | "CANCELED" | null = null;

    if (status.includes("IN_PROGRESS") || status.includes("RINGING") || status.includes("QUEUED")) next = "CALLING";
    if (status.includes("ENDED") || status.includes("COMPLETED")) next = "COMPLETED";
    if (status.includes("FAILED")) next = "FAILED";
    if (status.includes("CANCELED")) next = "CANCELED";

    await db.callJob.update({
      where: { id: callJobId },
      data: {
        provider: "vapi",
        providerCallId,
        status: next ?? undefined,
        outcome: `VAPI_STATUS:${status}`,
      },
    });

    return new Response("OK", { status: 200 });
  }

  // transcript messages: append last line as outcome (optional lightweight)
  if (message.type === "transcript") {
    const role = String(message.role ?? "");
    const transcript = String(message.transcript ?? "").slice(0, 800);

    if (transcript) {
      await db.callJob.update({
        where: { id: callJobId },
        data: {
          provider: "vapi",
          providerCallId,
          outcome: `TRANSCRIPT_${role}:${transcript}`,
        },
      });
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
}
