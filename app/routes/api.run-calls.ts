// app/routes/api.run-calls.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";
import { startVapiCallForJob } from "../callProvider.server";

// POST /api/run-calls
export async function action({ request }: ActionFunctionArgs) {
  const want = process.env.RUN_CALLS_SECRET || "";
  if (want) {
    const got = request.headers.get("x-run-calls-secret") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  // DO NOT use grace window. It causes “early” calls and can look like spam loops.
  const jobs = await db.callJob.findMany({
    where: {
      status: "QUEUED",
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: "asc" },
    take: 25,
  });

  let processed = 0;
  let started = 0;
  let failed = 0;

  for (const job of jobs) {
    // Lock exactly once and increment attempts exactly once here.
    const locked = await db.callJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: {
        status: "CALLING",
        attempts: { increment: 1 },
        outcome: null,
      },
    });

    if (locked.count === 0) continue;

    processed += 1;

    const settings = await ensureSettings(job.shop);
    const maxAttempts = settings.maxAttempts ?? 1;

    try {
      const res = await startVapiCallForJob({
        shop: job.shop,
        callJobId: job.id,
      });

      // IMPORTANT:
      // keep status CALLING until webhook ends the call.
      await db.callJob.update({
        where: { id: job.id },
        data: {
          status: "CALLING",
          provider: "vapi",
          providerCallId: res.providerCallId ?? null,
          outcome: "VAPI_CALL_STARTED",
        },
      });

      started += 1;
    } catch (e: any) {
      const jobFresh = await db.callJob.findUnique({
        where: { id: job.id },
        select: { attempts: true },
      });
      const attemptsAfter = Number(jobFresh?.attempts ?? 0);

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
      processed,
      started,
      failed,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
