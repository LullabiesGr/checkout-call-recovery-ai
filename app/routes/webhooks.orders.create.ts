import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function toFloat(v: any) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") return new Response("Ignored", { status: 200 });

  const o = payload as any;

  const orderId = o?.id != null ? String(o.id) : "";
  if (!orderId) return new Response("Invalid payload", { status: 200 });

  const checkoutId = o?.checkout_id != null ? String(o.checkout_id) : null;
  const checkoutToken = o?.checkout_token != null ? String(o.checkout_token) : null;

  const total =
    toFloat(o?.total_price ?? o?.totalPrice ?? o?.current_total_price ?? o?.total_price_set?.shop_money?.amount) ?? null;
  const currency = String((o?.currency || o?.currency_code || "USD")).toUpperCase();
  const financial = o?.financial_status ? String(o.financial_status) : null;

  await db.order.upsert({
    where: { shop_orderId: { shop, orderId } },
    create: {
      shop,
      orderId,
      checkoutId,
      checkoutToken,
      total,
      currency,
      financial,
      raw: JSON.stringify(o),
    },
    update: {
      checkoutId,
      checkoutToken,
      total,
      currency,
      financial,
      raw: JSON.stringify(o),
    },
  });

  // Mark checkout as converted and cancel queued/calling jobs
  if (checkoutId) {
    await db.checkout.updateMany({
      where: { shop, checkoutId },
      data: { status: "CONVERTED", abandonedAt: null },
    });

    await db.callJob.updateMany({
      where: {
        shop,
        checkoutId,
        status: { in: ["QUEUED", "CALLING"] },
      },
      data: { status: "CANCELED" },
    });
  }

  return new Response("OK", { status: 200 });
}
