// app/routes/app.settings.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

type Tone = "neutral" | "friendly" | "premium" | "urgent";
type Goal = "complete_checkout" | "qualify_and_follow_up" | "support_only";
type OfferRule = "ask_only" | "price_objection" | "after_first_objection" | "always";

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

    // playbook extras (stored as extra columns in public."Settings")
    tone: Tone;
    goal: Goal;
    maxCallSeconds: number;
    maxFollowupQuestions: number;

    discountEnabled: boolean;
    maxDiscountPercent: number;
    offerRule: OfferRule;
    minCartValueForDiscount: number | null;
    couponPrefix: string | null;
    couponValidityHours: number;
    freeShippingEnabled: boolean;

    followupEmailEnabled: boolean;
    followupSmsEnabled: boolean;

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
function toFloatOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function toBool(v: FormDataEntryValue | null) {
  return String(v ?? "") === "on" || String(v ?? "") === "true" || String(v ?? "") === "1";
}
function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function pickTone(v: any): Tone {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "friendly" || s === "premium" || s === "urgent" || s === "neutral") return s as Tone;
  return "neutral";
}
function pickGoal(v: any): Goal {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "qualify_and_follow_up" || s === "support_only" || s === "complete_checkout") return s as Goal;
  return "complete_checkout";
}
function pickOfferRule(v: any): OfferRule {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "price_objection" || s === "after_first_objection" || s === "always" || s === "ask_only") return s as OfferRule;
  return "ask_only";
}
function pickCurrency(v: any): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "USD" || s === "EUR" || s === "GBP") return s;
  // allow any 3-letter currency too (formatting only)
  if (/^[A-Z]{3}$/.test(s)) return s;
  return "USD";
}

function safeSearchFromRequest(request: Request) {
  try {
    const u = new URL(request.url);
    return u.search || "";
  } catch {
    return "";
  }
}

/* ---------------------------
   Extras in public."Settings"
   --------------------------- */

type ExtrasRow = {
  tone: string | null;
  goal: string | null;
  max_call_seconds: number | null;
  max_followup_questions: number | null;

  discount_enabled: boolean | null;
  max_discount_percent: number | null;
  offer_rule: string | null;
  min_cart_value_for_discount: number | null;
  coupon_prefix: string | null;
  coupon_validity_hours: number | null;
  free_shipping_enabled: boolean | null;

  followup_email_enabled: boolean | null;
  followup_sms_enabled: boolean | null;
};

async function readSettingsExtras(shop: string): Promise<ExtrasRow | null> {
  const rows = await (db as any).$queryRaw<ExtrasRow[]>`
    select
      tone,
      goal,
      max_call_seconds,
      max_followup_questions,
      discount_enabled,
      max_discount_percent,
      offer_rule,
      min_cart_value_for_discount,
      coupon_prefix,
      coupon_validity_hours,
      free_shipping_enabled,
      followup_email_enabled,
      followup_sms_enabled
    from public."Settings"
    where shop = ${shop}
    limit 1
  `;
  return rows?.[0] ?? null;
}

async function writeSettingsExtras(
  shop: string,
  data: {
    tone: Tone;
    goal: Goal;
    maxCallSeconds: number;
    maxFollowupQuestions: number;

    discountEnabled: boolean;
    maxDiscountPercent: number;
    offerRule: OfferRule;
    minCartValueForDiscount: number | null;
    couponPrefix: string | null;
    couponValidityHours: number;
    freeShippingEnabled: boolean;

    followupEmailEnabled: boolean;
    followupSmsEnabled: boolean;
  }
) {
  await (db as any).$executeRaw`
    update public."Settings"
    set
      tone = ${data.tone},
      goal = ${data.goal},
      max_call_seconds = ${data.maxCallSeconds},
      max_followup_questions = ${data.maxFollowupQuestions},
      discount_enabled = ${data.discountEnabled},
      max_discount_percent = ${data.maxDiscountPercent},
      offer_rule = ${data.offerRule},
      min_cart_value_for_discount = ${data.minCartValueForDiscount},
      coupon_prefix = ${data.couponPrefix},
      coupon_validity_hours = ${data.couponValidityHours},
      free_shipping_enabled = ${data.freeShippingEnabled},
      followup_email_enabled = ${data.followupEmailEnabled},
      followup_sms_enabled = ${data.followupSmsEnabled}
    where shop = ${shop}
  `;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const s = await ensureSettings(shop);
  const extras = await readSettingsExtras(shop);

  return {
    shop,
    settings: {
      enabled: Boolean(s.enabled),
      delayMinutes: Number(s.delayMinutes ?? 30),
      maxAttempts: Number(s.maxAttempts ?? 2),
      retryMinutes: Number(s.retryMinutes ?? 180),
      minOrderValue: Number(s.minOrderValue ?? 0),
      currency: pickCurrency(String(s.currency ?? "USD")),
      callWindowStart: String((s as any).callWindowStart ?? "09:00"),
      callWindowEnd: String((s as any).callWindowEnd ?? "19:00"),

      vapiAssistantId: ((s as any).vapiAssistantId ?? null) as string | null,
      vapiPhoneNumberId: ((s as any).vapiPhoneNumberId ?? null) as string | null,

      tone: pickTone(extras?.tone ?? "neutral"),
      goal: pickGoal(extras?.goal ?? "complete_checkout"),
      maxCallSeconds: clamp(Number(extras?.max_call_seconds ?? 120), 45, 300),
      maxFollowupQuestions: clamp(Number(extras?.max_followup_questions ?? 1), 0, 3),

      discountEnabled: Boolean(extras?.discount_enabled ?? false),
      maxDiscountPercent: clamp(Number(extras?.max_discount_percent ?? 10), 0, 50),
      offerRule: pickOfferRule(extras?.offer_rule ?? "ask_only"),
      minCartValueForDiscount:
        extras?.min_cart_value_for_discount == null ? null : Number(extras.min_cart_value_for_discount),
      couponPrefix: (extras?.coupon_prefix ?? "").trim() ? String(extras?.coupon_prefix).trim() : null,
      couponValidityHours: clamp(Number(extras?.coupon_validity_hours ?? 24), 1, 168),
      freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),

      followupEmailEnabled: Boolean(extras?.followup_email_enabled ?? true),
      followupSmsEnabled: Boolean(extras?.followup_sms_enabled ?? false),

      userPrompt: ((s as any).userPrompt ?? null) as string | null,
    },
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // ensure row exists
  const s = await ensureSettings(shop);
  const extras = await readSettingsExtras(shop);

  const fd = await request.formData();

  const enabled = String(fd.get("enabled") ?? "") === "on";
  const delayMinutes = toInt(fd.get("delayMinutes"), Number(s.delayMinutes ?? 30));
  const maxAttempts = toInt(fd.get("maxAttempts"), Number(s.maxAttempts ?? 2));
  const retryMinutes = toInt(fd.get("retryMinutes"), Number(s.retryMinutes ?? 180));
  const minOrderValue = toFloat(fd.get("minOrderValue"), Number(s.minOrderValue ?? 0));

  const currency = pickCurrency(fd.get("currency") ?? (s as any).currency ?? "USD");
  const callWindowStart = String(fd.get("callWindowStart") ?? (s as any).callWindowStart ?? "09:00").trim() || "09:00";
  const callWindowEnd = String(fd.get("callWindowEnd") ?? (s as any).callWindowEnd ?? "19:00").trim() || "19:00";

  const vapiAssistantId = String(fd.get("vapiAssistantId") ?? "").trim() || null;
  const vapiPhoneNumberId = String(fd.get("vapiPhoneNumberId") ?? "").trim() || null;
  const userPrompt = String(fd.get("userPrompt") ?? "").trim() || null;

  const tone = pickTone(fd.get("tone") ?? extras?.tone ?? "neutral");
  const goal = pickGoal(fd.get("goal") ?? extras?.goal ?? "complete_checkout");
  const maxCallSeconds = clamp(
    toInt(fd.get("maxCallSeconds"), Number(extras?.max_call_seconds ?? 120)),
    45,
    300
  );
  const maxFollowupQuestions = clamp(
    toInt(fd.get("maxFollowupQuestions"), Number(extras?.max_followup_questions ?? 1)),
    0,
    3
  );

  const discountEnabled = toBool(fd.get("discountEnabled"));
  const maxDiscountPercent = clamp(
    toInt(fd.get("maxDiscountPercent"), Number(extras?.max_discount_percent ?? 10)),
    0,
    50
  );
  const offerRule = pickOfferRule(fd.get("offerRule") ?? extras?.offer_rule ?? "ask_only");
  const minCartValueForDiscount = toFloatOrNull(fd.get("minCartValueForDiscount"));
  const couponPrefixRaw = String(fd.get("couponPrefix") ?? "").trim();
  const couponPrefix = couponPrefixRaw ? couponPrefixRaw.slice(0, 12) : null;
  const couponValidityHours = clamp(
    toInt(fd.get("couponValidityHours"), Number(extras?.coupon_validity_hours ?? 24)),
    1,
    168
  );
  const freeShippingEnabled = toBool(fd.get("freeShippingEnabled"));

  const followupEmailEnabled = toBool(fd.get("followupEmailEnabled"));
  const followupSmsEnabled = toBool(fd.get("followupSmsEnabled"));

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

  await writeSettingsExtras(shop, {
    tone,
    goal,
    maxCallSeconds,
    maxFollowupQuestions,
    discountEnabled,
    maxDiscountPercent,
    offerRule,
    minCartValueForDiscount,
    couponPrefix,
    couponValidityHours,
    freeShippingEnabled,
    followupEmailEnabled,
    followupSmsEnabled,
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
        <div style={{ fontWeight: 900, fontSize: 12, color: "rgba(17,24,39,0.45)", lineHeight: 1.35 }}>{props.hint}</div>
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

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
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

function SectionHeader(props: { title: string; subtitle?: string }) {
  return (
    <div style={{ display: "grid", gap: 4, padding: 14, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
      <div style={{ fontSize: 13, fontWeight: 1100, color: "rgba(17,24,39,0.85)" }}>{props.title}</div>
      {props.subtitle ? (
        <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>{props.subtitle}</div>
      ) : null}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />;
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
        <Form method="post">
          <SectionHeader title="Call recovery configuration" subtitle="Queue timing, retry policy, call window, Vapi identifiers." />

          <div style={{ padding: 14, display: "grid", gap: 14 }}>
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

              <Field label="Currency" hint="Formatting only. Example: USD, EUR.">
                <Input name="currency" defaultValue={settings.currency} />
              </Field>
            </div>

            <Divider />

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

            <Divider />

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
            </div>
          </div>

          <SectionHeader title="Agent playbook" subtitle="Behavior constraints that shape outcomes and call length." />

          <div style={{ padding: 14, display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <Field label="Goal" hint="What success means for the agent.">
                <Select name="goal" defaultValue={settings.goal}>
                  <option value="complete_checkout">Complete checkout</option>
                  <option value="qualify_and_follow_up">Qualify + follow-up</option>
                  <option value="support_only">Support only</option>
                </Select>
              </Field>

              <Field label="Tone" hint="How the agent sounds.">
                <Select name="tone" defaultValue={settings.tone}>
                  <option value="neutral">Neutral</option>
                  <option value="friendly">Friendly</option>
                  <option value="premium">Premium</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </Field>

              <Field label="Max call length (seconds)" hint="Hard cap. Keep short.">
                <Input name="maxCallSeconds" type="number" defaultValue={settings.maxCallSeconds} inputMode="numeric" />
              </Field>

              <Field label="Max follow-up questions" hint="0–3. Prevents interrogation.">
                <Input name="maxFollowupQuestions" type="number" defaultValue={settings.maxFollowupQuestions} inputMode="numeric" />
              </Field>
            </div>
          </div>

          <SectionHeader title="Discount policy" subtitle="Only relevant if you actually offer discounts." />

          <div style={{ padding: 14, display: "grid", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 1000 }}>
              <input name="discountEnabled" type="checkbox" defaultChecked={settings.discountEnabled} />
              Enable discounts
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <Field label="Max discount % (first call)" hint="0–50.">
                <Input name="maxDiscountPercent" type="number" defaultValue={settings.maxDiscountPercent} inputMode="numeric" />
              </Field>

              <Field label="When to offer" hint="Rule for discount offers.">
                <Select name="offerRule" defaultValue={settings.offerRule}>
                  <option value="ask_only">Only if customer asks</option>
                  <option value="price_objection">If price objection</option>
                  <option value="after_first_objection">After first objection</option>
                  <option value="always">Offer proactively</option>
                </Select>
              </Field>

              <Field label="Min cart value to allow discount" hint="Optional gate.">
                <Input
                  name="minCartValueForDiscount"
                  type="number"
                  step="0.01"
                  defaultValue={settings.minCartValueForDiscount ?? ""}
                  inputMode="decimal"
                />
              </Field>

              <Field label="Coupon validity (hours)" hint="1–168.">
                <Input name="couponValidityHours" type="number" defaultValue={settings.couponValidityHours} inputMode="numeric" />
              </Field>

              <Field label="Coupon prefix" hint="Optional. Up to 12 chars.">
                <Input name="couponPrefix" type="text" defaultValue={settings.couponPrefix ?? ""} />
              </Field>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 1000 }}>
              <input name="freeShippingEnabled" type="checkbox" defaultChecked={settings.freeShippingEnabled} />
              Allow free shipping as alternative offer
            </label>
          </div>

          <SectionHeader title="Follow-ups" subtitle="What the agent is allowed to propose after the call." />

          <div style={{ padding: 14, display: "grid", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 1000 }}>
              <input name="followupEmailEnabled" type="checkbox" defaultChecked={settings.followupEmailEnabled} />
              Allow follow-up email suggestion
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 1000 }}>
              <input name="followupSmsEnabled" type="checkbox" defaultChecked={settings.followupSmsEnabled} />
              Allow follow-up SMS suggestion
            </label>
          </div>

          <SectionHeader title="Merchant prompt" subtitle="Appended to default system prompt. Keep short and strict." />

          <div style={{ padding: 14, display: "grid", gap: 12 }}>
            <Field label="Merchant prompt" hint="Business style, strict rules, language, objections handling.">
              <TextArea name="userPrompt" defaultValue={settings.userPrompt ?? ""} rows={8} />
            </Field>

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
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
