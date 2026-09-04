/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  corePlugins: {
    // 与 Ant Design 的 reset 冲突，禁用 Tailwind preflight
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // 与 styles/tokens.css 中的 Design Token 保持一致
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        "surface-secondary": "var(--color-surface-secondary)",
        border: "var(--color-border)",
        "text-primary": "var(--color-text-primary)",
        "text-secondary": "var(--color-text-secondary)",
        "text-tertiary": "var(--color-text-tertiary)",
        primary: "var(--color-primary)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        error: "var(--color-error)",
      },
    },
  },
  plugins: [],
};
