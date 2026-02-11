import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ensureSettings, markAbandonedByDelay, enqueueCallJobs } from "../callRecovery.server";

export async function action({ request }: ActionFunctionArgs) {
  const want = process.env.CRON_TOKEN || "";
  if (want) {
    const got = request.headers.get("x-cron-token") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  // shops = όλα τα εγκατεστημένα (Settings rows)
  const shops = (await db.settings.findMany({ select: { shop: true } })).map(x => x.shop);

  let markedTotal = 0;
  let enqueuedTotal = 0;

  for (const shop of shops) {
    const settings = await ensureSettings(shop);

    const marked = await markAbandonedByDelay(shop, settings.delayMinutes);
    markedTotal += marked.count ?? 0;

    const enq = await enqueueCallJobs({
      shop,
      enabled: settings.enabled,
      minOrderValue: settings.minOrderValue,
      callWindowStart: (settings as any).callWindowStart ?? "09:00",
      callWindowEnd: (settings as any).callWindowEnd ?? "19:00",
    });

    enqueuedTotal += enq.enqueued ?? 0;
  }

  // Τρέξε calls με το υπάρχον endpoint σου (/api/run-calls)
  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  if (appUrl) {
    await fetch(`${appUrl}/api/run-calls`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-run-calls-secret": process.env.RUN_CALLS_SECRET || "",
      },
      body: JSON.stringify({}),
    }).catch(() => null);
  }

  return new Response(JSON.stringify({ ok: true, shops: shops.length, markedTotal, enqueuedTotal }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
