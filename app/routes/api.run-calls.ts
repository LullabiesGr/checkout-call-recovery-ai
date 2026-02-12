// app/routes/api.run-calls.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";
import { startVapiCallForJob } from "../callProvider.server";

// POST /api/run-calls
export async function action({ request }: ActionFunctionArgs) {
  // Simple auth gate
  const want = process.env.RUN_CALLS_SECRET || "";
  if (want) {
    const got = request.headers.get("x-run-calls-secret") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  // === GRACE WINDOW (±2 minutes ahead safe, never misses late jobs) ===
  const GRACE_MS = 2 * 60 * 1000; // 2 minutes
  const upper = new Date(now.getTime() + GRACE_MS);

  // Pull due jobs (anything scheduled up to now + 2 minutes)
  const jobs = await db.callJob.findMany({
    where: {
      status: "QUEUED",
      scheduledFor: { lte: upper },
    },
    orderBy: { scheduledFor: "asc" },
    take: 25,
  });

  let processed = 0;
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    // Lock to prevent double processing
    const locked = await db.callJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: {
        status: "CALLING",
        attempts: { increment: 1 },
      },
    });

    if (locked.count === 0) continue;

    processed += 1;

    const settings = await ensureSettings(job.shop);

    try {
      const res = await startVapiCallForJob({
        shop: job.shop,
        callJobId: job.id,
      });

      await db.callJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          provider: "vapi",
          providerCallId: res.providerCallId ?? null,
          outcome: "VAPI_CALL_STARTED",
        },
      });

      completed += 1;
    } catch (e: any) {
      const attemptsAfter = (job.attempts ?? 0) + 1;
      const maxAttempts = settings.maxAttempts ?? 2;

      if (attemptsAfter >= maxAttempts) {
        await db.callJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            outcome: `ERROR: ${String(e?.message ?? e)}`,
          },
        });
        failed += 1;
      } else {
        const retryMinutes = settings.retryMinutes ?? 180;
        const next = new Date(Date.now() + retryMinutes * 60 * 1000);

        await db.callJob.update({
          where: { id: job.id },
          data: {
            status: "QUEUED",
            scheduledFor: next,
            outcome: `RETRY_SCHEDULED in ${retryMinutes}m`,
          },
        });
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      now: now.toISOString(),
      upper: upper.toISOString(),
      processed,
      completed,
      failed,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
