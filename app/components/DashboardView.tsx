// app/components/dashboard/DashboardView.tsx
import * as React from "react";
import { Form } from "react-router";

type ReasonRow = { label: string; pct: number };
type LiveRow = { label: string; whenText: string; tone: "green" | "blue" | "amber" | "red" };

export type DashboardViewProps = {
  title: string;
  kpis: Array<{
    label: string;
    value: string;
    sub?: string;
    tone: "green" | "blue" | "amber" | "red" | "neutral";
    barPct?: number | null;
  }>;
  pipeline: Array<{ label: string; value: number; tone: "green" | "blue" | "amber" | "red" }>;
  live: LiveRow[];
  reasons: ReasonRow[];
  canCreateTestCall: boolean;
};

function toneColors(tone: string) {
  if (tone === "green") return { bar: "#2ecc71", glow: "rgba(46,204,113,0.35)" };
  if (tone === "blue") return { bar: "#3498db", glow: "rgba(52,152,219,0.35)" };
  if (tone === "amber") return { bar: "#f1c40f", glow: "rgba(241,196,15,0.35)" };
  if (tone === "red") return { bar: "#e74c3c", glow: "rgba(231,76,60,0.35)" };
  return { bar: "#bfc7d1", glow: "rgba(191,199,209,0.25)" };
}

function CardShell(props: { children: any; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.95), rgba(250,251,252,0.95))",
        border: "1px solid rgba(0,0,0,0.10)",
        borderRadius: 10,
        boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

function KpiCard(props: { label: string; value: string; sub?: string; tone: any; barPct?: number | null }) {
  const c = toneColors(props.tone);
  const pct = typeof props.barPct === "number" ? Math.max(0, Math.min(100, props.barPct)) : null;

  return (
    <CardShell style={{ padding: 14, minWidth: 0 }}>
      <div style={{ fontWeight: 800, fontSize: 13, color: "rgba(0,0,0,0.70)" }}>{props.label}</div>
      <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontWeight: 900, fontSize: 28, color: "rgba(0,0,0,0.86)", lineHeight: 1 }}>
          {props.value}
        </div>
        {props.sub ? (
          <div style={{ fontWeight: 800, fontSize: 13, color: "rgba(0,0,0,0.55)" }}>{props.sub}</div>
        ) : null}
      </div>

      <div
        style={{
          marginTop: 10,
          height: 6,
          borderRadius: 999,
          background: "rgba(0,0,0,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: pct == null ? "40%" : `${pct}%`,
            height: "100%",
            background: c.bar,
            boxShadow: `0 0 18px ${c.glow}`,
          }}
        />
      </div>
    </CardShell>
  );
}

function LiveDot(props: { tone: "green" | "blue" | "amber" | "red" }) {
  const c = toneColors(props.tone);
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: c.bar,
        boxShadow: `0 0 12px ${c.glow}`,
        display: "inline-block",
      }}
    />
  );
}

export function DashboardView(props: DashboardViewProps) {
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg, #f5f7fa, #eef2f6)" }}>
      {/* Top dark header bar (όμοιο ύφος με screenshot) */}
      <div
        style={{
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          color: "white",
          background: "linear-gradient(180deg, #3b4a59, #25313c)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 6,
              background: "rgba(255,255,255,0.14)",
              display: "grid",
              placeItems: "center",
              fontWeight: 900,
            }}
          >
            S
          </div>
          <div style={{ fontWeight: 900, fontSize: 18 }}>{props.title}</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Form method="post">
            <input type="hidden" name="intent" value="sync_now" />
            <button
              type="submit"
              style={{
                height: 34,
                padding: "0 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.10)",
                color: "white",
                fontWeight: 900,
                cursor: "pointer",
              }}
            >
              Sync now
            </button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="create_test_call" />
            <button
              type="submit"
              disabled={!props.canCreateTestCall}
              style={{
                height: 34,
                padding: "0 12px",
                borderRadius: 8,
                border: "1px solid rgba(0,0,0,0.25)",
                background: props.canCreateTestCall ? "linear-gradient(180deg, #2f7cf6, #1f5fcc)" : "rgba(255,255,255,0.10)",
                color: "white",
                fontWeight: 900,
                cursor: props.canCreateTestCall ? "pointer" : "not-allowed",
                opacity: props.canCreateTestCall ? 1 : 0.55,
              }}
            >
              Create Test Call
            </button>
          </Form>

          <button
            type="button"
            style={{
              height: 34,
              width: 38,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(255,255,255,0.10)",
              color: "white",
              fontWeight: 900,
            }}
            aria-label="More"
          >
            …
          </button>
        </div>
      </div>

      <div style={{ padding: 16, maxWidth: 1240 }}>
        {/* KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12 }}>
          {props.kpis.map((k) => (
            <KpiCard key={k.label} label={k.label} value={k.value} sub={k.sub} tone={k.tone} barPct={k.barPct ?? null} />
          ))}
        </div>

        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 14 }}>
          {/* Pipeline */}
          <CardShell style={{ padding: 14 }}>
            <div style={{ fontWeight: 900, fontSize: 16, color: "rgba(0,0,0,0.80)" }}>Recovery Pipeline</div>

            <div style={{ marginTop: 10, borderRadius: 10, border: "1px solid rgba(0,0,0,0.10)", overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${props.pipeline.length}, 1fr)` }}>
                {props.pipeline.map((p, idx) => {
                  const c = toneColors(p.tone);
                  return (
                    <div
                      key={p.label}
                      style={{
                        background: c.bar,
                        color: "white",
                        padding: "10px 12px",
                        fontWeight: 900,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        borderRight: idx === props.pipeline.length - 1 ? "none" : "1px solid rgba(255,255,255,0.25)",
                      }}
                    >
                      <span>{p.label}</span>
                      <span style={{ opacity: 0.95 }}>{p.value}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardShell>

          {/* Live Activity */}
          <CardShell style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 16, color: "rgba(0,0,0,0.80)" }}>Live Activity</div>
              <div style={{ color: "rgba(0,0,0,0.45)", fontWeight: 900 }}>⚙</div>
            </div>

            <div style={{ marginTop: 10, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
              {props.live.length === 0 ? (
                <div style={{ padding: "12px 4px", color: "rgba(0,0,0,0.55)", fontWeight: 800 }}>
                  No recent activity.
                </div>
              ) : (
                props.live.map((r, i) => (
                  <div
                    key={`${r.label}-${i}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "10px 2px",
                      borderBottom: "1px solid rgba(0,0,0,0.06)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <LiveDot tone={r.tone} />
                      <div style={{ fontWeight: 900, color: "rgba(0,0,0,0.78)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r.label}
                      </div>
                    </div>
                    <div style={{ fontWeight: 900, color: "rgba(0,0,0,0.45)" }}>{r.whenText}</div>
                  </div>
                ))
              )}
            </div>
          </CardShell>
        </div>

        {/* Top reasons */}
        <div style={{ marginTop: 14 }}>
          <CardShell style={{ padding: 14 }}>
            <div style={{ fontWeight: 900, fontSize: 16, color: "rgba(0,0,0,0.80)" }}>Top Reasons (AI)</div>
            <div style={{ marginTop: 10, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
              {props.reasons.length === 0 ? (
                <div style={{ padding: "12px 4px", color: "rgba(0,0,0,0.55)", fontWeight: 800 }}>
                  No AI reason data yet.
                </div>
              ) : (
                props.reasons.map((r) => (
                  <div
                    key={r.label}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "26px minmax(0, 1fr) 60px",
                      gap: 10,
                      alignItems: "center",
                      padding: "10px 2px",
                      borderBottom: "1px solid rgba(0,0,0,0.06)",
                    }}
                  >
                    <div
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 999,
                        border: "1px solid rgba(0,0,0,0.10)",
                        display: "grid",
                        placeItems: "center",
                        fontWeight: 900,
                        color: "rgba(0,0,0,0.65)",
                        background: "rgba(0,0,0,0.03)",
                      }}
                    >
                      •
                    </div>
                    <div style={{ fontWeight: 900, color: "rgba(0,0,0,0.78)" }}>{r.label}</div>
                    <div style={{ fontWeight: 900, color: "rgba(0,0,0,0.55)", textAlign: "right" }}>{r.pct}%</div>
                  </div>
                ))
              )}
            </div>
          </CardShell>
        </div>
      </div>
    </div>
  );
}
