import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // 忽略构建产物与配置文件本身
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.vite/**",
      "apps/web/vite.config.ts",
      "apps/web/postcss.config.js",
      "**/*.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  // Node 侧（server 与 packages）
  {
    files: ["apps/server/**/*.ts", "packages/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  // 浏览器侧（web）
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
