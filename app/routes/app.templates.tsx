// app/routes/app.templates.tsx
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export default function TemplatesRoute() {
  return <div style={{ padding: 16, fontWeight: 900, fontSize: 18 }}>Templates</div>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
