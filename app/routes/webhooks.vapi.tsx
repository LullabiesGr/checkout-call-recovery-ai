// app/routes/webhooks.vapi.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? "";
  if (!process.env.VAPI_WEBHOOK_SECRET || secret !== process.env.VAPI_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return new Response("Bad Request", { status: 400 });

  const metadata = payload?.metadata ?? payload?.assistant?.metadata ?? {};
  const shop = String(metadata?.shop ?? "");
  const callJobId = String(metadata?.callJobId ?? "");
  if (!shop || !callJobId) return new Response("OK", { status: 200 });

  const eventType = String(payload?.type ?? payload?.messageType ?? payload?.event ?? "");

  // Best-effort outcome text
  const summary =
    payload?.analysis?.summary ??
    payload?.summary ??
    payload?.endedReason ??
    payload?.status ??
    eventType ??
    "VAPI_EVENT";

  // Map statuses
  // Keep simple: when end-of-call-report arrives => COMPLETED unless explicitly failed
  let newStatus: "CALLING" | "COMPLETED" | "FAILED" | null = null;

  const lowered = JSON.stringify(payload).toLowerCase();
  if (lowered.includes("end-of-call-report") || lowered.includes("ended")) {
    newStatus = lowered.includes("error") ? "FAILED" : "COMPLETED";
  } else if (lowered.includes("in-progress") || lowered.includes("connected")) {
    newStatus = "CALLING";
  }

  await db.callJob.updateMany({
    where: { id: callJobId, shop },
    data: {
      status: newStatus ?? undefined,
      outcome: String(summary).slice(0, 2000),
    },
  });

  return new Response("OK", { status: 200 });
}
