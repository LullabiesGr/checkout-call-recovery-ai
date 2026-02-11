// app/routes/api.run-calls.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";
import { placeCall } from "../callProvider.server";

function safeJsonParse<T>(s?: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// POST /api/run-calls
export async function action({ request }: ActionFunctionArgs) {
  // simple auth gate: require a shared secret header (set in ENV)
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
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    // lock
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

    // fetch checkout details for script
    const checkout = await db.checkout.findUnique({
      where: { shop_checkoutId: { shop: job.shop, checkoutId: job.checkoutId } },
      select: {
        customerName: true,
        itemsJson: true,
        value: true,
        currency: true,
      },
    });

    const items = safeJsonParse<Array<{ title: string; quantity?: number }>>(
      checkout?.itemsJson ?? null
    );

    try {
      const res = await placeCall({
        shop: job.shop,
        phone: job.phone,
        checkoutId: job.checkoutId,
        customerName: checkout?.customerName ?? null,
        items,
        amount: checkout?.value ?? null,
        currency: checkout?.currency ?? null,
      });

      await db.callJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          provider: res.provider,
          providerCallId: res.providerCallId,
          outcome: res.outcome,
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
    JSON.stringify({ ok: true, processed, completed, failed }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
