import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function toFloat(v: any) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "CHECKOUTS_CREATE") return new Response("Ignored", { status: 200 });

  const c = payload as any;

  const checkoutId = c?.id != null ? String(c.id) : "";
  const value = toFloat(c?.total_price ?? c?.totalPrice ?? c?.total_price_set?.shop_money?.amount);
  const currency = String((c?.currency || c?.currency_code || "USD")).toUpperCase();

  if (!checkoutId || value == null) return new Response("Invalid payload", { status: 200 });

  const token = c?.token ? String(c.token) : null;
  const email = c?.email ? String(c.email) : null;
  const phone = c?.phone ? String(c.phone) : null;

  await db.checkout.upsert({
    where: { shop_checkoutId: { shop, checkoutId } },
    create: {
      shop,
      checkoutId,
      token,
      email,
      phone,
      value,
      currency,
      status: "OPEN",
      raw: JSON.stringify(c),
    },
    update: {
      token,
      email,
      phone,
      value,
      currency,
      status: "OPEN",
      raw: JSON.stringify(c),
    },
  });

  return new Response("OK", { status: 200 });
}
