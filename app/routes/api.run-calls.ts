// app/routes/api.run-calls.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { createVapiCallForJob } from "../callProvider.server";

// POST /api/run-calls
export async function action({ request }: ActionFunctionArgs) {
  const want = process.env.RUN_CALLS_SECRET || "";
  if (want) {
    const got = request.headers.get("x-run-calls-secret") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  const jobs = await db.callJob.findMany({
    where: { status: "QUEUED", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: 25,
  });

  let processed = 0;
  let started = 0;
  let skipped = 0;
  let failed = 0;

  for (const job of jobs) {
    processed += 1;

    try {
      const r = await createVapiCallForJob({ shop: job.shop, callJobId: job.id });
      if ((r as any)?.skipped) skipped += 1;
      else started += 1;
    } catch (e) {
      failed += 1;
      // retries are handled by your /app action logic or cron pipeline; keep this endpoint lean
      await db.callJob.update({
        where: { id: job.id },
        data: { status: "FAILED", outcome: `ERROR: ${String((e as any)?.message ?? e)}`.slice(0, 2000) },
      });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, processed, started, skipped, failed }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
