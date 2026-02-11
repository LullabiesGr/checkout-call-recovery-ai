import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

type LoaderData = {
  shop: string;
  settings: {
    enabled: boolean;
    delayMinutes: number;
    maxAttempts: number;
    retryMinutes: number;
    minOrderValue: number;
    currency: string;
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

async function ensureSettings(shop: string) {
  const existing = await db.settings.findUnique({ where: { shop } });
  if (existing) return existing;

  return db.settings.create({
    data: {
      shop,
      enabled: true,
      delayMinutes: 30,
      maxAttempts: 2,
      retryMinutes: 180,
      minOrderValue: 0,
      currency: "USD",
    },
  });
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

  const currencyRaw = String(fd.get("currency") ?? current.currency).trim();
  const currency = currencyRaw || current.currency;

  await db.settings.update({
    where: { shop },
    data: {
      enabled,
      delayMinutes,
      maxAttempts,
      retryMinutes,
      minOrderValue,
      currency,
    },
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
                  label="Delay before first call (minutes)"
                  name="delayMinutes"
                  type="number"
                  defaultValue={String(settings.delayMinutes)}
                  help-text="How long after abandonment to consider it ABANDONED."
                />

                <s-text-field
                  label="Max call attempts"
                  name="maxAttempts"
                  type="number"
                  defaultValue={String(settings.maxAttempts)}
                />

                <s-text-field
                  label="Retry delay (minutes)"
                  name="retryMinutes"
                  type="number"
                  defaultValue={String(settings.retryMinutes)}
                />

                <s-text-field
                  label="Min order value"
                  name="minOrderValue"
                  type="number"
                  defaultValue={String(settings.minOrderValue)}
                />

                <s-text-field
                  label="Currency"
                  name="currency"
                  defaultValue={settings.currency}
                />
              </s-inline-grid>

              <s-divider />

              <s-stack direction="inline" gap="base">
                <s-button type="submit">Save</s-button>
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
