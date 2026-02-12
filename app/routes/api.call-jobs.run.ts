import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * POST /api/call-jobs/run
 * Body: { shop?: string, limit?: number }
 *
 * v1: no dialer yet. Marks jobs as COMPLETED with a placeholder outcome.
 * Next step: replace simulateCall() with real provider call (Twilio/Vapi/Bland).
 */
export async function action({ request }: ActionFunctionArgs) {
  const body = (await request.json().catch(() => ({}))) as any;
  const shop = body?.shop ? String(body.shop) : null;
  const limit = Math.min(Math.max(Number(body?.limit ?? 10), 1), 50);

  const now = new Date();

  const jobs = await db.callJob.findMany({
    where: {
      ...(shop ? { shop } : {}),
      status: "QUEUED",
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: "asc" },
    take: limit,
  });

  let processed = 0;

  for (const job of jobs) {
    // lock the job
    const locked = await db.callJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: {
        status: "CALLING",
        attempts: { increment: 1 },
      },
    });

    if (locked.count === 0) continue;

    // v1 simulate
    const outcome = `SIMULATED_CALL_OK phone=${job.phone}`;

    await db.callJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        outcome,
      },
    });

    processed += 1;
  }

  return new Response(JSON.stringify({ ok: true, processed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
