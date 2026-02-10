import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function action({ request }: ActionFunctionArgs) {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const currentRaw = (payload as any)?.current;
  const scope = Array.isArray(currentRaw) ? currentRaw.join(",") : String(currentRaw ?? "");

  if (session && scope) {
    await db.session.update({
      where: { id: session.id },
      data: { scope },
    });
  }

  return new Response("OK", { status: 200 });
}
