// app/routes/app.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function NavItem(props: { href: string; label: string; active?: boolean }) {
  const { href, label, active } = props;
  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 12,
        textDecoration: "none",
        color: active ? "rgba(17,24,39,0.95)" : "rgba(17,24,39,0.78)",
        background: active ? "rgba(59,130,246,0.10)" : "transparent",
        fontWeight: 950,
        fontSize: 13,
        border: active ? "1px solid rgba(59,130,246,0.18)" : "1px solid transparent",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: active ? "rgba(59,130,246,0.85)" : "rgba(17,24,39,0.20)",
        }}
      />
      <span>{label}</span>
    </a>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  // simple active detection (no hooks from router used to avoid breaking)
  const path =
    typeof window !== "undefined" ? window.location.pathname : "/app";
  const isDash = path === "/app" || path === "/app/";
  const isAdditional = path.startsWith("/app/additional");
  const isSettings = path.startsWith("/app/settings");

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div
        style={{
          height: "100vh",
          width: "100%",
          minWidth: 0,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "260px 1fr",
          background: "rgba(243,244,246,0.75)",
        }}
      >
        {/* Sidebar */}
        <div
          style={{
            borderRight: "1px solid rgba(0,0,0,0.08)",
            background: "white",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 10px 14px 10px",
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: "1px solid rgba(59,130,246,0.22)",
                background: "rgba(59,130,246,0.10)",
                display: "grid",
                placeItems: "center",
                fontWeight: 1000,
                color: "rgba(30,58,138,0.95)",
              }}
            >
              AI
            </div>
            <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <div style={{ fontWeight: 1000, fontSize: 13, color: "rgba(17,24,39,0.92)" }}>
                AI Checkout Call Recovery
              </div>
              <div style={{ fontWeight: 850, fontSize: 11, color: "rgba(17,24,39,0.45)" }}>
                Embedded Shopify app
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gap: 6, padding: "10px 6px" }}>
            <NavItem href="/app" label="Dashboard" active={isDash} />
            <NavItem href="/app" label="Call Insights" active={false} />
            <NavItem href="/app" label="Call Jobs" active={false} />
            <NavItem href="/app/additional" label="Settings" active={isAdditional || isSettings} />
          </div>

          <div style={{ marginTop: "auto", padding: 8 }}>
            <a
              href="/app/additional"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px 12px",
                borderRadius: 12,
                textDecoration: "none",
                border: "1px solid rgba(0,0,0,0.10)",
                background: "rgba(0,0,0,0.02)",
                color: "rgba(17,24,39,0.86)",
                fontWeight: 950,
                fontSize: 13,
              }}
            >
              Support
            </a>
          </div>
        </div>

        {/* Main */}
        <div
          style={{
            minWidth: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Top bar */}
          <div
            style={{
              height: 56,
              background: "white",
              borderBottom: "1px solid rgba(0,0,0,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 16px",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <div style={{ fontWeight: 1000, color: "rgba(17,24,39,0.92)" }}>
                Dashboard
              </div>
              <div
                style={{
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: "1px solid rgba(0,0,0,0.10)",
                  background: "rgba(0,0,0,0.03)",
                  fontWeight: 900,
                  fontSize: 12,
                  color: "rgba(17,24,39,0.70)",
                  whiteSpace: "nowrap",
                }}
              >
                Live
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  border: "1px solid rgba(0,0,0,0.10)",
                  background: "rgba(0,0,0,0.03)",
                }}
              />
              <div style={{ fontWeight: 950, fontSize: 13, color: "rgba(17,24,39,0.78)" }}>
                Account
              </div>
            </div>
          </div>

          {/* Content */}
          <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
            <Outlet />
          </div>
        </div>
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
