import type { HeadersFunction } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export default function AuthLoginErrorRoute() {
  const err = useRouteError() as any;

  const msg =
    (err && (err.data || err.message)) ? String(err.data || err.message) : "Auth error";

  return (
    <s-page heading="Authentication error">
      <s-section>
        <s-card padding="base">
          <s-text as="p" tone="critical" variant="bodyMd">
            {msg}
          </s-text>
        </s-card>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
