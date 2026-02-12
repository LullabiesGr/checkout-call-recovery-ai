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

  // pull due jobs
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
  let skipped = 0;

  for (const job of jobs) {
    // light lock: μην κάνεις attempts++ εδώ
    const locked = await db.callJob.updateMany({
      where: { id: job.id, status: "QUEUED", providerCallId: null },
      data: ({ status: "CALLING", outcome: null } as any),
    });
    if (locked.count === 0) {
      skipped += 1;
      continue;
    }

    processed += 1;

    const settings = await ensureSettings(job.shop);

    try {
      const res = await startVapiCallForJob({
        shop: job.shop,
        callJobId: job.id,
      });

      await db.callJob.update({
        where: { id: job.id },
        data: ({
          provider: "vapi",
          providerCallId: res.providerCallId ?? null,
          outcome: "VAPI_CALL_STARTED",
          // status μένει CALLING — θα το γυρίσει το webhook σε COMPLETED/FAILED
        } as any),
      });

      started += 1;
    } catch (e: any) {
      // διάβασε πραγματικό attempts μετά το hard-lock increment
      const fresh = await db.callJob.findFirst({ where: { id: job.id } });
      const attemptsAfter = Number((fresh as any)?.attempts ?? (job as any)?.attempts ?? 0);
      const maxAttempts = Number((settings as any)?.maxAttempts ?? 2);

      if (attemptsAfter >= maxAttempts) {
        await db.callJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            outcome: `ERROR: ${String(e?.message ?? e)}`.slice(0, 2000),
          },
        });
        failed += 1;
      } else {
        const retryMinutes = Number((settings as any)?.retryMinutes ?? 180);
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
    JSON.stringify({ ok: true, processed, started, failed, skipped }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
