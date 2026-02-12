// app/routes/api.cron.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ensureSettings, markAbandonedByDelay, enqueueCallJobs } from "../callRecovery.server";

export async function action({ request }: ActionFunctionArgs) {
  const want = process.env.CRON_TOKEN || "";
  if (want) {
    const got = request.headers.get("x-cron-token") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  const shops = (await db.settings.findMany({ select: { shop: true } })).map((x) => x.shop);

  let markedTotal = 0;
  let enqueuedTotal = 0;

  const nowBefore = new Date();
  const queuedDueBefore = await db.callJob.count({
    where: { status: "QUEUED", scheduledFor: { lte: nowBefore } },
  });

  for (const shop of shops) {
    const settings = await ensureSettings(shop);

    const marked = await markAbandonedByDelay(shop, settings.delayMinutes);
    markedTotal += (marked as any)?.count ?? 0;

    const enq = await enqueueCallJobs({
      shop,
      enabled: settings.enabled,
      minOrderValue: settings.minOrderValue,
      callWindowStart: (settings as any).callWindowStart ?? "09:00",
      callWindowEnd: (settings as any).callWindowEnd ?? "19:00",
      delayMinutes: settings.delayMinutes,
      maxAttempts: settings.maxAttempts ?? 1,
      retryMinutes: settings.retryMinutes ?? 0,
    } as any);

    enqueuedTotal += (enq as any)?.enqueued ?? 0;
  }

  const nowAfter = new Date();
  const queuedDueAfter = await db.callJob.count({
    where: { status: "QUEUED", scheduledFor: { lte: nowAfter } },
  });

  // Kick dialer
  let runCallsStatus: number | null = null;
  let runCallsBody: any = null;

  const appUrl = String(process.env.APP_URL || "").replace(/\/$/, "");
  if (!appUrl) {
    runCallsBody = { error: "Missing APP_URL env" };
  } else {
    const res = await fetch(`${appUrl}/api/run-calls`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-run-calls-secret": process.env.RUN_CALLS_SECRET || "",
      },
      body: JSON.stringify({}),
    });

    runCallsStatus = res.status;

    const text = await res.text().catch(() => "");
    try {
      runCallsBody = text ? JSON.parse(text) : null;
    } catch {
      runCallsBody = { raw: text };
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      shops: shops.length,
      markedTotal,
      enqueuedTotal,
      queuedDueBefore,
      queuedDueAfter,
      runCallsStatus,
      runCallsBody,
      serverNow: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
