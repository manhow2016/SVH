// @ts-check
/**
 * ESLint 扁平配置（ESLint 9）
 *
 * Phase 0 审计结论 ⑩：「不要省略 lint」。
 * 参考项目全仓无 ESLint、无 Prettier，且显式关闭了 `noUncheckedIndexedAccess`，
 * 代码中因此出现大量 `!` 非空断言与 `as unknown as`。
 * SVH 把这两项都打开，并用本配置守住类型纪律。
 *
 * 用法：在各包目录执行 `eslint src test`（由各包 lint script 调用）。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 构建产物、依赖与 Prisma 生成代码不参与检查
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/src/generated/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // 使用 projectService 让类型感知规则能正确解析 monorepo 中的跨包引用
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── 类型纪律（审计结论 ⑩） ──────────────────────────────
      // 禁止非空断言：它会把「可能为 undefined」的编译期保护直接抹掉
      '@typescript-eslint/no-non-null-assertion': 'error',
      /*
       * 刻意**不启用** `no-unnecessary-type-assertion`。
       *
       * 原因：Prisma 的 JSON 输入类型（`JsonNull | InputJsonValue | undefined`）
       * 与 Zod 推断出的 `Record<string, unknown>` 不兼容 —— 后者的 value 是
       * `unknown`，无法赋给 `InputJsonValue`。因此 `as Prisma.InputJsonValue`
       * 是**必需**的（已隔离验证：不加断言 tsc 直接报 TS2322）。
       *
       * 但该规则会把它判为「多余」并建议删除，等于诱导开发者移除必需的类型
       * 收窄，进而在真正执行 typecheck 时引入编译错误。一个会给出错误修复
       * 建议的规则，比没有这条规则更危险。
       *
       * 非空断言（上面那条）才是审计真正要求禁止的写法，那条保持开启。
       */
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // 未使用变量：允许以 _ 开头显式表示忽略
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // 浮空 Promise：漏 await 是异步代码最常见的缺陷
      '@typescript-eslint/no-floating-promises': 'error',
      // 禁止把 Promise 当布尔值用
      '@typescript-eslint/no-misused-promises': 'error',
      /*
       * 关闭 require-await。
       *
       * Fastify 的插件与路由处理器**必须**是 async 函数（框架据此处理返回值
       * 与错误传播），但很多处理器内部只是同步返回数据、或直接返回一个
       * Promise。强行去掉 async 会破坏 Fastify 的约定，为满足 lint 而改坏
       * 框架契约是本末倒置。
       */
      '@typescript-eslint/require-await': 'off',
      // 显式 any 需要理由，通常是类型设计有问题的信号
      '@typescript-eslint/no-explicit-any': 'error',
      // 允许 void 表达式用于显式忽略返回值
      'no-void': ['error', { allowAsStatement: true }],
      // 与 TypeScript 重复，关闭以免误报
      'no-undef': 'off',
      // 生产代码禁止 console，统一走结构化日志
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ── 测试文件放宽部分规则 ────────────────────────────────────
  {
    // 前端（apps/web）的测试是 .tsx，只写 .ts 会让它们拿不到下面的放宽规则
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/test/**/*.tsx'],
    rules: {
      // 测试里用类型断言构造边界数据是合理的
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ── 构建脚本与生成产物 ──────────────────────────────────────
  {
    files: ['**/*.mjs', '**/*.js', 'scripts/**'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },
);
