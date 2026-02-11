// app/routes/app.additional.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

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
  saved?: boolean;
};

function toInt(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function toStr(v: FormDataEntryValue | null) {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  return {
    shop,
    settings: {
      enabled: settings.enabled,
      delayMinutes: settings.delayMinutes,
      maxAttempts: settings.maxAttempts,
      retryMinutes: settings.retryMinutes,
      minOrderValue: settings.minOrderValue,
      currency: settings.currency,
      callWindowStart: (settings as any).callWindowStart ?? "09:00",
      callWindowEnd: (settings as any).callWindowEnd ?? "19:00",
      vapiAssistantId: (settings as any).vapiAssistantId ?? null,
      vapiPhoneNumberId: (settings as any).vapiPhoneNumberId ?? null,
      userPrompt: (settings as any).userPrompt ?? "",
    },
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  const fd = await request.formData();

  const enabled = String(fd.get("enabled") ?? "") === "on";

  const delayMinutes = toInt(fd.get("delayMinutes"), settings.delayMinutes);
  const maxAttempts = toInt(fd.get("maxAttempts"), settings.maxAttempts);
  const retryMinutes = toInt(fd.get("retryMinutes"), settings.retryMinutes);
  const minOrderValue = toFloat(fd.get("minOrderValue"), settings.minOrderValue);

  const currency = String(fd.get("currency") ?? settings.currency ?? "USD").toUpperCase().trim() || "USD";
  const callWindowStart = String(fd.get("callWindowStart") ?? (settings as any).callWindowStart ?? "09:00").trim() || "09:00";
  const callWindowEnd = String(fd.get("callWindowEnd") ?? (settings as any).callWindowEnd ?? "19:00").trim() || "19:00";

  const vapiAssistantId = toStr(fd.get("vapiAssistantId"));
  const vapiPhoneNumberId = toStr(fd.get("vapiPhoneNumberId"));
  const userPrompt = String(fd.get("userPrompt") ?? "").trim();

  await db.settings.update({
    where: { shop },
    data: {
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

  return {
    shop,
    settings: {
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
    },
    saved: true,
  } satisfies LoaderData;
};

export default function SettingsRoute() {
  const { shop, settings, saved } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Call recovery configuration">
        <s-card padding="base">
          <s-stack gap="base">
            <s-paragraph>
              Store: <s-badge>{shop}</s-badge>
            </s-paragraph>

            {saved ? (
              <s-banner tone="success">
                <s-text as="p">Saved.</s-text>
              </s-banner>
            ) : null}

            <Form method="post">
              <s-stack gap="base">
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input name="enabled" type="checkbox" defaultChecked={settings.enabled} />
                  <span>Enable call recovery</span>
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Delay before first call (minutes)</div>
                  <input name="delayMinutes" defaultValue={settings.delayMinutes} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }} />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Max call attempts</div>
                  <input name="maxAttempts" defaultValue={settings.maxAttempts} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }} />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Retry delay (minutes)</div>
                  <input name="retryMinutes" defaultValue={settings.retryMinutes} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }} />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Min order value</div>
                  <input name="minOrderValue" defaultValue={settings.minOrderValue} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }} />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Currency</div>
                  <input name="currency" defaultValue={settings.currency} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }} />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Call window (start)</div>
                  <input name="callWindowStart" defaultValue={settings.callWindowStart} placeholder="09:00" style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }} />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Call window (end)</div>
                  <input name="callWindowEnd" defaultValue={settings.callWindowEnd} placeholder="19:00" style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }} />
                </label>

                <s-divider />

                <s-text as="h3" variant="headingSm">Vapi</s-text>

                <label>
                  <div style={{ marginBottom: 6 }}>Vapi Assistant ID</div>
                  <input
                    name="vapiAssistantId"
                    defaultValue={settings.vapiAssistantId ?? ""}
                    placeholder="asst_..."
                    style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }}
                  />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Vapi Phone Number ID</div>
                  <input
                    name="vapiPhoneNumberId"
                    defaultValue={settings.vapiPhoneNumberId ?? ""}
                    placeholder="pn_..."
                    style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)" }}
                  />
                </label>

                <label>
                  <div style={{ marginBottom: 6 }}>Merchant prompt (appends to default preprompt)</div>
                  <textarea
                    name="userPrompt"
                    defaultValue={settings.userPrompt ?? ""}
                    rows={6}
                    placeholder="Your business style, offer rules, language, objections handling..."
                    style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)", resize: "vertical" }}
                  />
                </label>

                <div style={{ display: "flex", gap: 12 }}>
                  <button
                    type="submit"
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.15)",
                      background: "white",
                      cursor: "pointer",
                    }}
                  >
                    Save
                  </button>
                </div>
              </s-stack>
            </Form>
          </s-stack>
        </s-card>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
