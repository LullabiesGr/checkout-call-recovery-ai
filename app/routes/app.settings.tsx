// app/routes/app.settings.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
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
};

function toInt(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}
function toFloat(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function safeSearchFromRequest(request: Request) {
  try {
    const u = new URL(request.url);
    return u.search || "";
  } catch {
    return "";
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const s = await ensureSettings(shop);

  return {
    shop,
    settings: {
      enabled: Boolean(s.enabled),
      delayMinutes: Number(s.delayMinutes ?? 30),
      maxAttempts: Number(s.maxAttempts ?? 2),
      retryMinutes: Number(s.retryMinutes ?? 180),
      minOrderValue: Number(s.minOrderValue ?? 0),
      currency: String(s.currency ?? "USD"),
      callWindowStart: String((s as any).callWindowStart ?? "09:00"),
      callWindowEnd: String((s as any).callWindowEnd ?? "19:00"),
      vapiAssistantId: ((s as any).vapiAssistantId ?? null) as string | null,
      vapiPhoneNumberId: ((s as any).vapiPhoneNumberId ?? null) as string | null,
      userPrompt: ((s as any).userPrompt ?? null) as string | null,
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

  const search = safeSearchFromRequest(request);
  return new Response(null, {
    status: 303,
    headers: { Location: `/app/settings${search}` },
  });
};

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 1000, fontSize: 12, color: "rgba(17,24,39,0.70)" }}>{props.label}</div>
      {props.children}
      {props.hint ? (
        <div style={{ fontWeight: 900, fontSize: 12, color: "rgba(17,24,39,0.45)", lineHeight: 1.35 }}>
          {props.hint}
        </div>
      ) : null}
    </div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.12)",
        background: "white",
        fontWeight: 900,
        color: "rgba(17,24,39,0.88)",
        outline: "none",
        ...(props.style as any),
      }}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.12)",
        background: "white",
        fontWeight: 900,
        color: "rgba(17,24,39,0.88)",
        outline: "none",
        resize: "vertical",
        ...(props.style as any),
      }}
    />
  );
}

function Pill(props: { children: any; tone?: "neutral" | "green" | "blue" | "amber" | "red"; title?: string }) {
  const tone = props.tone ?? "neutral";
  const t =
    tone === "green"
      ? { bg: "rgba(16,185,129,0.10)", bd: "rgba(16,185,129,0.25)", tx: "#065f46" }
      : tone === "blue"
      ? { bg: "rgba(59,130,246,0.10)", bd: "rgba(59,130,246,0.25)", tx: "#1e3a8a" }
      : tone === "amber"
      ? { bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.25)", tx: "#92400e" }
      : tone === "red"
      ? { bg: "rgba(239,68,68,0.10)", bd: "rgba(239,68,68,0.25)", tx: "#7f1d1d" }
      : { bg: "rgba(0,0,0,0.04)", bd: "rgba(0,0,0,0.10)", tx: "rgba(0,0,0,0.75)" };

  return (
    <span
      title={props.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 10px",
        borderRadius: 999,
        border: `1px solid ${t.bd}`,
        background: t.bg,
        color: t.tx,
        fontWeight: 950,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </span>
  );
}

export default function SettingsRoute() {
  const { shop, settings } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Settings</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill title="Shop">{shop}</Pill>
            <Pill tone={settings.enabled ? "green" : "neutral"} title="Enabled">
              {settings.enabled ? "Enabled" : "Disabled"}
            </Pill>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 16,
          overflow: "hidden",
          background: "white",
          boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          maxWidth: 980,
        }}
      >
        <div style={{ padding: 14, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 13, fontWeight: 1100, color: "rgba(17,24,39,0.85)" }}>Call recovery configuration</div>
          <div style={{ marginTop: 4, fontSize: 12, fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>
            Controls queue timing, retry policy, and Vapi identifiers.
          </div>
        </div>

        <div style={{ padding: 14 }}>
          <Form method="post">
            <div style={{ display: "grid", gap: 14 }}>
              <div
                style={{
                  border: "1px solid rgba(0,0,0,0.08)",
                  borderRadius: 14,
                  padding: 12,
                  background: "rgba(0,0,0,0.02)",
                }}
              >
                <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 1000 }}>
                  <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
                  Enable call recovery
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                <Field label="Delay before first call (minutes)" hint="After checkout becomes abandoned.">
                  <Input name="delayMinutes" defaultValue={settings.delayMinutes} inputMode="numeric" />
                </Field>

                <Field label="Min order value" hint="Skip carts below this value.">
                  <Input name="minOrderValue" defaultValue={settings.minOrderValue} inputMode="decimal" />
                </Field>

                <Field label="Max call attempts" hint="Per checkout.">
                  <Input name="maxAttempts" defaultValue={settings.maxAttempts} inputMode="numeric" />
                </Field>

                <Field label="Retry delay (minutes)" hint="Delay between attempts when call fails.">
                  <Input name="retryMinutes" defaultValue={settings.retryMinutes} inputMode="numeric" />
                </Field>

                <Field label="Currency" hint="Used for formatting only. Example: USD, EUR.">
                  <Input name="currency" defaultValue={settings.currency} />
                </Field>
              </div>

              <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />

              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ fontWeight: 1100, fontSize: 13, color: "rgba(17,24,39,0.85)" }}>Call window</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                  <Field label="Start (HH:MM)" hint="Local store time. Example: 09:00">
                    <Input name="callWindowStart" defaultValue={settings.callWindowStart} placeholder="09:00" />
                  </Field>

                  <Field label="End (HH:MM)" hint="Local store time. Example: 19:00">
                    <Input name="callWindowEnd" defaultValue={settings.callWindowEnd} placeholder="19:00" />
                  </Field>
                </div>
              </div>

              <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />

              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ fontWeight: 1100, fontSize: 13, color: "rgba(17,24,39,0.85)" }}>Vapi</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                  <Field label="Assistant ID" hint="Optional: store-level override.">
                    <Input name="vapiAssistantId" defaultValue={settings.vapiAssistantId ?? ""} />
                  </Field>

                  <Field label="Phone Number ID" hint="Optional: store-level override.">
                    <Input name="vapiPhoneNumberId" defaultValue={settings.vapiPhoneNumberId ?? ""} />
                  </Field>
                </div>

                <Field
                  label="Merchant prompt"
                  hint="Added on top of the default system prompt. Keep it short and strict."
                >
                  <TextArea name="userPrompt" defaultValue={settings.userPrompt ?? ""} rows={8} />
                </Field>
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button
                  type="submit"
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(59,130,246,0.30)",
                    background: "rgba(59,130,246,0.10)",
                    cursor: "pointer",
                    fontWeight: 1100,
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
