// app/routes/app.settings.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

import type { HeadersFunction } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

type LoaderData = {
  shop: string;
  settings: {
    enabled: boolean;
    delayMinutes: number;
    maxAttempts: number;
    retryMinutes: number;
    minOrderValue: number;
    currency: string;
    callWindowStart: string;
    callWindowEnd: string;
    vapiAssistantId: string | null;
    vapiPhoneNumberId: string | null;
    userPrompt: string | null;
  };
};

function toInt(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const s = await ensureSettings(shop);

  return {
    shop,
    settings: {
      enabled: s.enabled,
      delayMinutes: s.delayMinutes,
      maxAttempts: s.maxAttempts,
      retryMinutes: s.retryMinutes,
      minOrderValue: s.minOrderValue,
      currency: s.currency,
      callWindowStart: (s as any).callWindowStart ?? "09:00",
      callWindowEnd: (s as any).callWindowEnd ?? "19:00",
      vapiAssistantId: (s as any).vapiAssistantId ?? null,
      vapiPhoneNumberId: (s as any).vapiPhoneNumberId ?? null,
      userPrompt: (s as any).userPrompt ?? null,
    },
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const fd = await request.formData();

  const enabled = String(fd.get("enabled") ?? "") === "on";
  const delayMinutes = toInt(fd.get("delayMinutes"), 30);
  const maxAttempts = toInt(fd.get("maxAttempts"), 2);
  const retryMinutes = toInt(fd.get("retryMinutes"), 180);
  const minOrderValue = toFloat(fd.get("minOrderValue"), 0);

  const currency = String(fd.get("currency") ?? "USD").toUpperCase().trim() || "USD";
  const callWindowStart = String(fd.get("callWindowStart") ?? "09:00").trim() || "09:00";
  const callWindowEnd = String(fd.get("callWindowEnd") ?? "19:00").trim() || "19:00";

  const vapiAssistantId = String(fd.get("vapiAssistantId") ?? "").trim() || null;
  const vapiPhoneNumberId = String(fd.get("vapiPhoneNumberId") ?? "").trim() || null;
  const userPrompt = String(fd.get("userPrompt") ?? "").trim() || null;

  await db.settings.upsert({
    where: { shop },
    create: {
      shop,
      enabled,
      delayMinutes,
      maxAttempts,
      retryMinutes,
      minOrderValue,
      currency,
      callWindowStart,
      callWindowEnd,
      vapiAssistantId,
      vapiPhoneNumberId,
      userPrompt,
    } as any,
    update: {
      enabled,
      delayMinutes,
      maxAttempts,
      retryMinutes,
      minOrderValue,
      currency,
      callWindowStart,
      callWindowEnd,
      vapiAssistantId,
      vapiPhoneNumberId,
      userPrompt,
    } as any,
  });

  return new Response(null, { status: 302, headers: { Location: "/app/settings" } });
};

export default function SettingsRoute() {
  const { shop, settings } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-card padding="base">
        <s-stack gap="base">
          <s-text as="h2" variant="headingMd">Call recovery configuration</s-text>

          <s-paragraph>
            Store: <s-badge>{shop}</s-badge>
          </s-paragraph>

          <Form method="post">
            <s-stack gap="base">
              <label>
                <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
                {" "}Enable call recovery
              </label>

              <label>
                Delay before first call (minutes)
                <input name="delayMinutes" defaultValue={settings.delayMinutes} />
              </label>

              <label>
                Max call attempts
                <input name="maxAttempts" defaultValue={settings.maxAttempts} />
              </label>

              <label>
                Retry delay (minutes)
                <input name="retryMinutes" defaultValue={settings.retryMinutes} />
              </label>

              <label>
                Min order value
                <input name="minOrderValue" defaultValue={settings.minOrderValue} />
              </label>

              <label>
                Currency
                <input name="currency" defaultValue={settings.currency} />
              </label>

              <s-divider />

              <s-text as="h3" variant="headingSm">Call window</s-text>

              <label>
                Start (HH:MM)
                <input name="callWindowStart" defaultValue={settings.callWindowStart} />
              </label>

              <label>
                End (HH:MM)
                <input name="callWindowEnd" defaultValue={settings.callWindowEnd} />
              </label>

              <s-divider />

              <s-text as="h3" variant="headingSm">Vapi</s-text>

              <label>
                Assistant ID
                <input name="vapiAssistantId" defaultValue={settings.vapiAssistantId ?? ""} />
              </label>

              <label>
                Phone Number ID
                <input name="vapiPhoneNumberId" defaultValue={settings.vapiPhoneNumberId ?? ""} />
              </label>

              <label>
                Merchant prompt (added on top of our default preprompt)
                <textarea
                  name="userPrompt"
                  defaultValue={settings.userPrompt ?? ""}
                  rows={8}
                  style={{ width: "100%" }}
                />
              </label>

              <button type="submit">Save</button>
            </s-stack>
          </Form>
        </s-stack>
      </s-card>
    </s-page>
  );
}



export default function SettingsRoute() {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Settings</div>
      <div style={{ marginTop: 8, fontWeight: 900, color: "rgba(17,24,39,0.55)" }}>
        Replace this file with your existing settings screen.
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
