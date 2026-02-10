import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Optional: cleanup app data
  await db.callJob.deleteMany({ where: { shop } });
  await db.checkout.deleteMany({ where: { shop } });
  await db.order.deleteMany({ where: { shop } });
  await db.settings.deleteMany({ where: { shop } });

  return new Response("OK", { status: 200 });
}
