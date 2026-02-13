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

    // upgraded playbook fields (stored in settings table via Supabase SQL)
    tone: "neutral" | "friendly" | "premium" | "urgent";
    goal: "complete_checkout" | "qualify_and_follow_up" | "support_only";
    maxCallSeconds: number;
    maxFollowupQuestions: number;

    discountEnabled: boolean;
    maxDiscountPercent: number;
    offerRule: "ask_only" | "price_objection" | "after_first_objection" | "always";
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

function pickTone(v: any): LoaderData["settings"]["tone"] {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "friendly" || s === "premium" || s === "urgent" || s === "neutral") return s as any;
  return "neutral";
}

function pickGoal(v: any): LoaderData["settings"]["goal"] {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "qualify_and_follow_up" || s === "support_only" || s === "complete_checkout") return s as any;
  return "complete_checkout";
}

function pickOfferRule(v: any): LoaderData["settings"]["offerRule"] {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "price_objection" || s === "after_first_objection" || s === "always" || s === "ask_only") return s as any;
  return "ask_only";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  const s: any = settings as any;

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

      tone: pickTone(s.tone),
      goal: pickGoal(s.goal),
      maxCallSeconds: clamp(Number(s.maxCallSeconds ?? 120), 45, 300),
      maxFollowupQuestions: clamp(Number(s.maxFollowupQuestions ?? 1), 0, 3),

      discountEnabled: Boolean(s.discountEnabled ?? false),
      maxDiscountPercent: clamp(Number(s.maxDiscountPercent ?? 10), 0, 50),
      offerRule: pickOfferRule(s.offerRule),
      minCartValueForDiscount:
        s.minCartValueForDiscount == null ? null : Number(s.minCartValueForDiscount),
      couponPrefix: (s.couponPrefix ?? "").trim() ? String(s.couponPrefix).trim() : null,
      couponValidityHours: clamp(Number(s.couponValidityHours ?? 24), 1, 168),
      freeShippingEnabled: Boolean(s.freeShippingEnabled ?? false),

      followupEmailEnabled: Boolean(s.followupEmailEnabled ?? true),
      followupSmsEnabled: Boolean(s.followupSmsEnabled ?? false),

      userPrompt: s.userPrompt ?? "",
    },
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);
  const s: any = settings as any;

  const fd = await request.formData();

  const enabled = String(fd.get("enabled") ?? "") === "on";

  const delayMinutes = toInt(fd.get("delayMinutes"), settings.delayMinutes);
  const maxAttempts = toInt(fd.get("maxAttempts"), settings.maxAttempts);
  const retryMinutes = toInt(fd.get("retryMinutes"), settings.retryMinutes);
  const minOrderValue = toFloat(fd.get("minOrderValue"), settings.minOrderValue);

  const currency =
    String(fd.get("currency") ?? settings.currency ?? "USD").toUpperCase().trim() || "USD";

  const callWindowStart =
    String(fd.get("callWindowStart") ?? s.callWindowStart ?? "09:00").trim() || "09:00";
  const callWindowEnd =
    String(fd.get("callWindowEnd") ?? s.callWindowEnd ?? "19:00").trim() || "19:00";

  const tone = pickTone(fd.get("tone"));
  const goal = pickGoal(fd.get("goal"));
  const maxCallSeconds = clamp(toInt(fd.get("maxCallSeconds"), Number(s.maxCallSeconds ?? 120)), 45, 300);
  const maxFollowupQuestions = clamp(
    toInt(fd.get("maxFollowupQuestions"), Number(s.maxFollowupQuestions ?? 1)),
    0,
    3
  );

  const discountEnabled = toBool(fd.get("discountEnabled"));
  const maxDiscountPercent = clamp(toInt(fd.get("maxDiscountPercent"), Number(s.maxDiscountPercent ?? 10)), 0, 50);
  const offerRule = pickOfferRule(fd.get("offerRule"));
  const minCartValueForDiscount = toFloatOrNull(fd.get("minCartValueForDiscount"));
  const couponPrefixRaw = String(fd.get("couponPrefix") ?? "").trim();
  const couponPrefix = couponPrefixRaw ? couponPrefixRaw.slice(0, 12) : null;
  const couponValidityHours = clamp(toInt(fd.get("couponValidityHours"), Number(s.couponValidityHours ?? 24)), 1, 168);
  const freeShippingEnabled = toBool(fd.get("freeShippingEnabled"));

  const followupEmailEnabled = toBool(fd.get("followupEmailEnabled"));
  const followupSmsEnabled = toBool(fd.get("followupSmsEnabled"));

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
                    <input name="currency" defaultValue={settings.currency} style={inputStyle} />
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
