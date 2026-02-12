// app/callRecovery.server.ts
import db from "./db.server";

type AdminClient = {
  graphql: (query: string, options?: any) => Promise<any>;
};

function parseHHMM(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function nextTimeWithinWindow(now: Date, startHHMM: string, endHHMM: string, leadMinutes: number) {
  const start = parseHHMM(startHHMM) ?? 9 * 60;
  const end = parseHHMM(endHHMM) ?? 19 * 60;

  const scheduled = new Date(now.getTime() + leadMinutes * 60 * 1000);

  const windowStart = Math.min(start, end);
  const windowEnd = Math.max(start, end);

  const minsScheduled = scheduled.getHours() * 60 + scheduled.getMinutes();
  if (minsScheduled >= windowStart && minsScheduled <= windowEnd) return scheduled;

  const minsNow = now.getHours() * 60 + now.getMinutes();

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(Math.floor(windowStart / 60), windowStart % 60, 0, 0);

  if (minsNow > windowEnd) next.setDate(next.getDate() + 1);
  else if (minsNow > windowStart) next.setDate(next.getDate() + 1);

  return next;
}

export async function syncAbandonedCheckoutsFromShopify(params: {
  admin: AdminClient;
  shop: string;
  limit?: number;
}) {
  const { admin, shop } = params;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

  const query = `
    query AbandonedCheckouts($first: Int!) {
      abandonedCheckouts(first: $first) {
        edges {
          node {
            id
            createdAt
            updatedAt
            completedAt
            email
            phone
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
            shippingAddress { firstName lastName }
            customer { firstName lastName }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                  variantTitle
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await admin.graphql(query, { variables: { first: limit } });
    const json = typeof (res as any)?.json === "function" ? await (res as any).json() : res;
    const edges = json?.data?.abandonedCheckouts?.edges ?? [];
    if (!Array.isArray(edges)) return { synced: 0 };

    let synced = 0;

    for (const e of edges) {
      const n = e?.node;
      const checkoutId = String(n?.id ?? "").trim();
      if (!checkoutId) continue;

      const firstName = String(n?.shippingAddress?.firstName ?? n?.customer?.firstName ?? "").trim();
      const lastName = String(n?.shippingAddress?.lastName ?? n?.customer?.lastName ?? "").trim();
      const customerName = `${firstName} ${lastName}`.trim() || null;

      const items = (n?.lineItems?.edges ?? [])
        .map((x: any) => x?.node)
        .filter(Boolean)
        .map((it: any) => ({
          title: it?.title ?? null,
          quantity: Number(it?.quantity ?? 1),
          variantTitle: it?.variantTitle ?? null,
          price: it?.originalUnitPriceSet?.shopMoney?.amount ?? null,
          currency: it?.originalUnitPriceSet?.shopMoney?.currencyCode ?? null,
        }))
        .filter((x: any) => x.title);

      const itemsJson = items.length ? JSON.stringify(items) : null;

      const amount = Number(n?.totalPriceSet?.shopMoney?.amount ?? 0);
      const currency = String(n?.totalPriceSet?.shopMoney?.currencyCode ?? "USD");
      const completedAt = n?.completedAt ? new Date(n.completedAt) : null;

      // IMPORTANT:
      // - Keep status ABANDONED (Shopify already considers it abandoned),
      // - Use abandonedAt = Shopify updatedAt/createdAt so delay can be enforced reliably.
      const abandonedAt = completedAt
        ? null
        : new Date(n?.updatedAt ?? n?.createdAt ?? Date.now());

      await db.checkout.upsert({
        where: { shop_checkoutId: { shop, checkoutId } },
        create: {
          shop,
          checkoutId,
          token: null,
          email: n?.email ?? null,
          phone: n?.phone ?? null,
          value: Number.isFinite(amount) ? amount : 0,
          currency,
          status: completedAt ? "CONVERTED" : "ABANDONED",
          abandonedAt,
          raw: JSON.stringify(n ?? null),
          customerName,
          itemsJson,
        },
        update: {
          email: n?.email ?? null,
          phone: n?.phone ?? null,
          value: Number.isFinite(amount) ? amount : 0,
          currency,
          status: completedAt ? "CONVERTED" : "ABANDONED",
          abandonedAt,
          raw: JSON.stringify(n ?? null),
          customerName,
          itemsJson,
        },
      });

      synced += 1;
    }

    return { synced };
  } catch {
    return { synced: 0 };
  }
}

export async function ensureSettings(shop: string) {
  return (
    (await db.settings.findUnique({ where: { shop } })) ??
    (await db.settings.create({
      data: {
        shop,
        enabled: true,
        delayMinutes: 30,
        maxAttempts: 2,
        retryMinutes: 180,
        minOrderValue: 0,
        currency: "USD",
        callWindowStart: "09:00",
        callWindowEnd: "19:00",
        vapiAssistantId: null,
        vapiPhoneNumberId: null,
        userPrompt: "",
      } as any,
    }))
  );
}

export async function markAbandonedByDelay(shop: string, delayMinutes: number) {
  // Legacy path (kept). Your pipeline uses status=ABANDONED directly from sync,
  // so this typically does nothing, but it’s harmless.
  const cutoff = new Date(Date.now() - delayMinutes * 60 * 1000);

  return db.checkout.updateMany({
    where: {
      shop,
      status: "OPEN",
      createdAt: { lte: cutoff },
    },
    data: {
      status: "ABANDONED",
      abandonedAt: new Date(),
    },
  });
}

export async function enqueueCallJobs(params: {
  shop: string;
  enabled: boolean;
  minOrderValue: number;
  callWindowStart: string;
  callWindowEnd: string;
  delayMinutes: number;
  maxAttempts: number;   // per-checkout cap
  retryMinutes: number;  // if you want re-queue after failures
}) {
  const {
    shop,
    enabled,
    minOrderValue,
    callWindowStart,
    callWindowEnd,
    delayMinutes,
    maxAttempts,
    retryMinutes,
  } = params;

  if (!enabled) return { enqueued: 0 };

  const now = new Date();
  const delayCutoff = new Date(now.getTime() - Math.max(0, Number(delayMinutes || 0)) * 60 * 1000);

  // Only ABANDONED checkouts whose abandonedAt is old enough (delay respected)
  const candidates = await db.checkout.findMany({
    where: {
      shop,
      status: "ABANDONED",
      phone: { not: null },
      value: { gte: minOrderValue },
      abandonedAt: { not: null, lte: delayCutoff },
    },
    select: { checkoutId: true, phone: true },
    take: 200,
  });

  let enqueued = 0;

  for (const c of candidates) {
    const phone = String(c.phone || "").trim();
    if (!phone) continue;

    // If there is already a queued/calling job, never create another.
    const inFlight = await db.callJob.findFirst({
      where: {
        shop,
        checkoutId: c.checkoutId,
        status: { in: ["QUEUED", "CALLING"] },
      },
      select: { id: true },
    });
    if (inFlight) continue;

    // Cap total call jobs per checkout (this is what stops “every 2 minutes forever”)
    const totalForCheckout = await db.callJob.count({
      where: { shop, checkoutId: c.checkoutId },
    });
    if (totalForCheckout >= Math.max(1, Number(maxAttempts || 1))) continue;

    // Optional: if last attempt failed recently, enforce retryMinutes
    const last = await db.callJob.findFirst({
      where: { shop, checkoutId: c.checkoutId },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true },
    });

    if (last && (last.status === "FAILED" || last.status === "COMPLETED")) {
      const retryMs = Math.max(0, Number(retryMinutes || 0)) * 60 * 1000;
      if (retryMs > 0) {
        const nextAllowed = new Date(new Date(last.createdAt).getTime() + retryMs);
        if (nextAllowed > now) continue;
      }
    }

    // Scheduling:
    // - delay is already enforced by abandonedAt cutoff
    // - so leadMinutes must be 0 (otherwise you “re-delay” from now every cron tick)
    const scheduledFor = nextTimeWithinWindow(now, callWindowStart, callWindowEnd, 0);

    await db.callJob.create({
      data: {
        shop,
        checkoutId: c.checkoutId,
        phone,
        scheduledFor,
        status: "QUEUED",
        attempts: 0,
      },
    });

    enqueued += 1;
  }

  return { enqueued };
}
