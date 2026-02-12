// app/routes/api.call-jobs.run.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { createVapiCallForJob } from "../callProvider.server";

/**
 * POST /api/call-jobs/run
 * Body: { shop?: string, limit?: number }
 *
 * Uses the real CallJob pipeline (hard-lock + no double calls is enforced inside callProvider).
 */
export async function action({ request }: ActionFunctionArgs) {
  const want = process.env.RUN_CALLS_SECRET || "";
  if (want) {
    const got = request.headers.get("x-run-calls-secret") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

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
    select: { id: true, shop: true },
  });

  let processed = 0;
  let started = 0;
  let skipped = 0;
  let failed = 0;

  for (const j of jobs) {
    processed += 1;
    try {
      const r = await createVapiCallForJob({ shop: j.shop, callJobId: j.id });
      if ((r as any)?.skipped || (r as any)?.alreadyCreated) skipped += 1;
      else started += 1;
    } catch (e: any) {
      failed += 1;
      await db.callJob
        .update({
          where: { id: j.id },
          data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}`.slice(0, 2000) },
        })
        .catch(() => null);
    }
  }

  return new Response(JSON.stringify({ ok: true, processed, started, skipped, failed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
