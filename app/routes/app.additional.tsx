// app/routes/app.additional.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
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

    // upgraded playbook fields (stored in Settings table via Supabase SQL)
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
  saved?: boolean;
};

function toInt(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloatOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toFloat(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
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
  return "USD";
}

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

async function writeSettingsExtras(shop: string, data: {
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
}) {
  // IMPORTANT: table name is "Settings" (capital S). Keep quoted.
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

  const settings = await ensureSettings(shop);
  const s: any = settings as any;

  const extras = await readSettingsExtras(shop);

  return {
    shop,
    settings: {
      enabled: settings.enabled,
      delayMinutes: settings.delayMinutes,
      maxAttempts: settings.maxAttempts,
      retryMinutes: settings.retryMinutes,
      minOrderValue: settings.minOrderValue,
      currency: settings.currency,
      callWindowStart: s.callWindowStart ?? "09:00",
      callWindowEnd: s.callWindowEnd ?? "19:00",

      tone: pickTone(extras?.tone ?? "neutral"),
      goal: pickGoal(extras?.goal ?? "complete_checkout"),
      maxCallSeconds: clamp(Number(extras?.max_call_seconds ?? 120), 45, 300),
      maxFollowupQuestions: clamp(Number(extras?.max_followup_questions ?? 1), 0, 3),

      discountEnabled: Boolean(extras?.discount_enabled ?? false),
      maxDiscountPercent: clamp(Number(extras?.max_discount_percent ?? 10), 0, 50),
      offerRule: pickOfferRule(extras?.offer_rule ?? "ask_only"),
      minCartValueForDiscount: extras?.min_cart_value_for_discount == null ? null : Number(extras.min_cart_value_for_discount),
      couponPrefix: (extras?.coupon_prefix ?? "").trim() ? String(extras?.coupon_prefix).trim() : null,
      couponValidityHours: clamp(Number(extras?.coupon_validity_hours ?? 24), 1, 168),
      freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),

      followupEmailEnabled: Boolean(extras?.followup_email_enabled ?? true),
      followupSmsEnabled: Boolean(extras?.followup_sms_enabled ?? false),

      userPrompt: s.userPrompt ?? "",
    },
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);
  const s: any = settings as any;

  const extras = await readSettingsExtras(shop);

  const fd = await request.formData();

  const enabled = String(fd.get("enabled") ?? "") === "on";

  const delayMinutes = toInt(fd.get("delayMinutes"), settings.delayMinutes);
  const maxAttempts = toInt(fd.get("maxAttempts"), settings.maxAttempts);
  const retryMinutes = toInt(fd.get("retryMinutes"), settings.retryMinutes);
  const minOrderValue = toFloat(fd.get("minOrderValue"), settings.minOrderValue);

  const currency = pickCurrency(fd.get("currency") ?? settings.currency ?? "USD");

  const callWindowStart =
    String(fd.get("callWindowStart") ?? s.callWindowStart ?? "09:00").trim() || "09:00";
  const callWindowEnd =
    String(fd.get("callWindowEnd") ?? s.callWindowEnd ?? "19:00").trim() || "19:00";

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

  const userPrompt = String(fd.get("userPrompt") ?? "").trim();

  // Keep the existing Prisma update for fields already in prisma schema
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
      userPrompt,
    } as any,
  });

  // Write the new SQL-added columns via raw SQL (no prisma schema change)
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

      userPrompt,
    },
    saved: true,
  } satisfies LoaderData;
};

export default function SettingsRoute() {
  const { shop, settings, saved } = useLoaderData<typeof loader>();

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: 10,
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,0.15)",
    fontWeight: 850,
  };

  const labelStyle: React.CSSProperties = { display: "grid", gap: 6 };

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
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                  <input name="enabled" type="checkbox" defaultChecked={settings.enabled} />
                  <span>Enable call recovery</span>
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={labelStyle}>
                    <div>Delay before first call (minutes)</div>
                    <input name="delayMinutes" defaultValue={settings.delayMinutes} style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>Max call attempts</div>
                    <input name="maxAttempts" defaultValue={settings.maxAttempts} style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>Retry delay (minutes)</div>
                    <input name="retryMinutes" defaultValue={settings.retryMinutes} style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>Min order value</div>
                    <input name="minOrderValue" defaultValue={settings.minOrderValue} style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>Currency</div>
                    <select name="currency" defaultValue={pickCurrency(settings.currency)} style={inputStyle}>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                      <option value="GBP">GBP</option>
                    </select>
                  </label>

                  <label style={labelStyle}>
                    <div>Call window (start)</div>
                    <input name="callWindowStart" defaultValue={settings.callWindowStart} placeholder="09:00" style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>Call window (end)</div>
                    <input name="callWindowEnd" defaultValue={settings.callWindowEnd} placeholder="19:00" style={inputStyle} />
                  </label>
                </div>

                <s-divider />

                <s-text as="h3" variant="headingSm">Agent playbook</s-text>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={labelStyle}>
                    <div>Goal</div>
                    <select name="goal" defaultValue={settings.goal} style={inputStyle}>
                      <option value="complete_checkout">Complete checkout</option>
                      <option value="qualify_and_follow_up">Qualify + follow-up</option>
                      <option value="support_only">Support only</option>
                    </select>
                  </label>

                  <label style={labelStyle}>
                    <div>Tone</div>
                    <select name="tone" defaultValue={settings.tone} style={inputStyle}>
                      <option value="neutral">Neutral</option>
                      <option value="friendly">Friendly</option>
                      <option value="premium">Premium</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </label>

                  <label style={labelStyle}>
                    <div>Max call length (seconds)</div>
                    <input name="maxCallSeconds" type="number" defaultValue={settings.maxCallSeconds} style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>Max follow-up questions</div>
                    <input name="maxFollowupQuestions" type="number" defaultValue={settings.maxFollowupQuestions} style={inputStyle} />
                  </label>
                </div>

                <s-divider />

                <s-text as="h3" variant="headingSm">Discount policy</s-text>

                <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                  <input name="discountEnabled" type="checkbox" defaultChecked={settings.discountEnabled} />
                  <span>Enable discounts</span>
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={labelStyle}>
                    <div>Max discount % (first call)</div>
                    <input name="maxDiscountPercent" type="number" defaultValue={settings.maxDiscountPercent} style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>When to offer</div>
                    <select name="offerRule" defaultValue={settings.offerRule} style={inputStyle}>
                      <option value="ask_only">Only if customer asks</option>
                      <option value="price_objection">If price objection</option>
                      <option value="after_first_objection">After first objection</option>
                      <option value="always">Offer proactively</option>
                    </select>
                  </label>

                  <label style={labelStyle}>
                    <div>Min cart value to allow discount (optional)</div>
                    <input
                      name="minCartValueForDiscount"
                      type="number"
                      step="0.01"
                      defaultValue={settings.minCartValueForDiscount ?? ""}
                      style={inputStyle}
                    />
                  </label>

                  <label style={labelStyle}>
                    <div>Coupon validity (hours)</div>
                    <input name="couponValidityHours" type="number" defaultValue={settings.couponValidityHours} style={inputStyle} />
                  </label>

                  <label style={labelStyle}>
                    <div>Coupon prefix (optional)</div>
                    <input name="couponPrefix" type="text" defaultValue={settings.couponPrefix ?? ""} style={inputStyle} />
                  </label>
                </div>

                <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                  <input name="freeShippingEnabled" type="checkbox" defaultChecked={settings.freeShippingEnabled} />
                  <span>Allow free shipping as alternative offer</span>
                </label>

                <s-divider />

                <s-text as="h3" variant="headingSm">Follow-ups</s-text>

                <div style={{ display: "grid", gap: 10 }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                    <input name="followupEmailEnabled" type="checkbox" defaultChecked={settings.followupEmailEnabled} />
                    <span>Allow follow-up email suggestion</span>
                  </label>

                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                    <input name="followupSmsEnabled" type="checkbox" defaultChecked={settings.followupSmsEnabled} />
                    <span>Allow follow-up SMS suggestion</span>
                  </label>
                </div>

                <s-divider />

                <s-text as="h3" variant="headingSm">Agent prompt</s-text>

                <label style={labelStyle}>
                  <div>Merchant prompt (appends to default preprompt)</div>
                  <textarea
                    name="userPrompt"
                    defaultValue={settings.userPrompt ?? ""}
                    rows={6}
                    placeholder="Your business style, offer rules, language, objections handling..."
                    style={{
                      width: "100%",
                      padding: 10,
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.15)",
                      resize: "vertical",
                      fontWeight: 800,
                    }}
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
                      fontWeight: 950,
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
