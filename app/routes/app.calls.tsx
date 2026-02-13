// app/routes/app.calls.tsx
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const rows = await db.callJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, checkoutId: true, status: true, attempts: true, scheduledFor: true, createdAt: true, outcome: true },
  });

  return { shop, rows };
};

export default function CallsRoute() {
  const { rows } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 10 }}>Calls</div>

      <div style={{ border: "1px solid rgba(0,0,0,0.10)", borderRadius: 10, overflow: "hidden", background: "white" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "rgba(0,0,0,0.03)" }}>
              <th style={{ textAlign: "left", padding: 10, fontWeight: 900 }}>Checkout</th>
              <th style={{ textAlign: "left", padding: 10, fontWeight: 900 }}>Status</th>
              <th style={{ textAlign: "left", padding: 10, fontWeight: 900 }}>Attempts</th>
              <th style={{ textAlign: "left", padding: 10, fontWeight: 900 }}>Scheduled</th>
              <th style={{ textAlign: "left", padding: 10, fontWeight: 900 }}>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.id} style={{ borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                <td style={{ padding: 10, fontWeight: 800 }}>{r.checkoutId}</td>
                <td style={{ padding: 10, fontWeight: 800 }}>{r.status}</td>
                <td style={{ padding: 10, fontWeight: 800 }}>{r.attempts}</td>
                <td style={{ padding: 10, fontWeight: 800 }}>{new Date(r.scheduledFor).toLocaleString()}</td>
                <td style={{ padding: 10, fontWeight: 800, color: "rgba(0,0,0,0.65)" }}>{r.outcome ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
