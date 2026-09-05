import type { ReactNode } from "react";

/**
 * 登录 / 注册页共用外壳（干净、单列、信息层级清晰）。
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-bg)",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div
          style={{
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontWeight: 700,
            fontSize: 18,
            color: "var(--color-primary)",
            letterSpacing: 0.5,
            marginBottom: 16,
          }}
        >
          SVH
        </div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            margin: 0,
            color: "var(--color-text-primary)",
          }}
        >
          {title}
        </h1>
        <p
          style={{
            fontSize: 13,
            margin: "8px 0 20px",
            color: "var(--color-text-tertiary)",
            lineHeight: 1.6,
          }}
        >
          {subtitle}
        </p>
        <div
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 12,
            padding: 24,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
