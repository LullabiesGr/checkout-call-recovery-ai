import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop };
};

export default function Settings() {
  const { shop } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Call recovery configuration">
        <s-card padding="base">
          <s-stack gap="base">
            <s-paragraph>
              Store: <s-badge>{shop}</s-badge>
            </s-paragraph>

            <s-inline-grid columns={{ xs: 1, md: 2 }} gap="base">
              <s-text-field
                label="Delay before first call (minutes)"
                value="10"
                help-text="Default: 10 minutes after abandonment (v1 placeholder)."
              />
              <s-text-field
                label="Max call attempts"
                value="2"
                help-text="Default: 2 attempts (v1 placeholder)."
              />
              <s-text-field
                label="Call window (start)"
                value="09:00"
                help-text="Local store time (v1 placeholder)."
              />
              <s-text-field
                label="Call window (end)"
                value="19:00"
                help-text="Local store time (v1 placeholder)."
              />
            </s-inline-grid>

            <s-divider />

            <s-stack direction="inline" gap="base">
              <s-button disabled>Save</s-button>
              <s-badge tone="warning">UI-only (no backend yet)</s-badge>
            </s-stack>
          </s-stack>
        </s-card>
      </s-section>

      <s-section heading="Next build step">
        <s-card padding="base">
          <s-paragraph>
            Next: fetch abandoned checkouts or recent orders from Admin API and
            write them into Prisma (Checkout + CallJob).
          </s-paragraph>
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
