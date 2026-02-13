// app/routes/app.rules.tsx
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export default function RulesRoute() {
  return <div style={{ padding: 16, fontWeight: 900, fontSize: 18 }}>Rules</div>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
