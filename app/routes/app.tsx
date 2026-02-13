// app/routes/app.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function safeSearch(): string {
  if (typeof window === "undefined") return "";
  const s = window.location.search || "";
  return s.startsWith("?") ? s : s ? `?${s}` : "";
}

function withSearch(path: string): string {
  const s = safeSearch();
  if (!s) return path;
  if (path.includes("?")) return path;
  return `${path}${s}`;
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* Shopify classic left sidebar (Admin) */}
      <NavMenu>
        <a href={withSearch("/app")} rel="home">
          Dashboard
        </a>
        <a href={withSearch("/app/checkouts")}>Checkouts</a>
        <a href={withSearch("/app/calls")}>Calls</a>
        <a href={withSearch("/app/additional")}>Settings</a>
      </NavMenu>

      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
