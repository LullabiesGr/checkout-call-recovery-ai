import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
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
  };
};

function toInt(v: FormDataEntryValue | null, fallback: number) {
  const n = Number(v ?? "");
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

function toFloat(v: FormDataEntryValue | null, fallback: number) {
  const n = Number(v ?? "");
  return Number.isFinite(n) ? n : fallback;
}

function toHHMM(v: FormDataEntryValue | null, fallback: string) {
  const s = String(v ?? "").trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : fallback;
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
    },
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const current = await ensureSettings(shop);
  const fd = await request.formData();

  const enabled = fd.get("enabled") === "on";
  const delayMinutes = toInt(fd.get("delayMinutes"), current.delayMinutes);
  const maxAttempts = Math.max(
    1,
    toInt(fd.get("maxAttempts"), current.maxAttempts)
  );
  const retryMinutes = toInt(fd.get("retryMinutes"), current.retryMinutes);
  const minOrderValue = toFloat(fd.get("minOrderValue"), current.minOrderValue);
  const currency =
    String(fd.get("currency") ?? current.currency).trim() || current.currency;

  const callWindowStart = toHHMM(
    fd.get("callWindowStart"),
    (current as any).callWindowStart ?? "09:00"
  );
  const callWindowEnd = toHHMM(
    fd.get("callWindowEnd"),
    (current as any).callWindowEnd ?? "19:00"
  );

  await db.settings.update({
    where: { shop },
    data: {
      enabled,
      delayMinutes,
      maxAttempts,
      retryMinutes,
      minOrderValue,
      currency,
      callWindowStart: callWindowStart as any,
      callWindowEnd: callWindowEnd as any,
    } as any,
  });

  return { ok: true };
};

export default function Settings() {
  const { shop, settings } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Call recovery configuration">
        <s-card padding="base">
          <Form method="post">
            <s-stack gap="base">
              <s-paragraph>
                Store: <s-badge>{shop}</s-badge>
              </s-paragraph>

              <s-inline-grid columns={{ xs: 1, md: 2 }} gap="base">
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={settings.enabled}
                  />
                  <span>Enable call recovery</span>
                </label>

                <s-text-field
                  label="Min order value"
                  name="minOrderValue"
                  type="number"
                  value={String(settings.minOrderValue)}
                  help-text="Only enqueue calls for checkouts >= this amount."
                />

                <s-text-field
                  label="Delay before first call (minutes)"
                  name="delayMinutes"
                  type="number"
                  value={String(settings.delayMinutes)}
                  help-text="How long after abandonment to treat a checkout as ABANDONED."
                />

                <s-text-field
                  label="Max call attempts"
                  name="maxAttempts"
                  type="number"
                  value={String(settings.maxAttempts)}
                  help-text="v1 placeholder for dialer retry policy."
                />

                <s-text-field
                  label="Retry delay (minutes)"
                  name="retryMinutes"
                  type="number"
                  value={String(settings.retryMinutes)}
                  help-text="v1 placeholder for failed call retries."
                />

                <s-text-field
                  label="Currency"
                  name="currency"
                  value={settings.currency}
                  help-text="Used for formatting only."
                />

                <s-text-field
                  label="Call window (start)"
                  name="callWindowStart"
                  value={settings.callWindowStart}
                  help-text="Server-local time in v1. Format HH:MM."
                />

                <s-text-field
                  label="Call window (end)"
                  name="callWindowEnd"
                  value={settings.callWindowEnd}
                  help-text="Server-local time in v1. Format HH:MM."
                />
              </s-inline-grid>

              <s-divider />

              <s-stack direction="inline" gap="base">
                <s-button submit>Save</s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-card>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
