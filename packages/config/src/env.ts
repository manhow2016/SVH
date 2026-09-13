/**
 * 环境配置 Schema
 *
 * ── 为什么必须有这个文件（审计结论 ⑪） ──
 * 参考项目 aiVideo **全仓没有 env 加载与校验机制**：各处在代码里写
 * `process.env.X ?? '默认值'`，dev 静默回落硬编码值。这直接导致一处真实的
 * 安全漏洞 —— JWT 密钥在两处以不同的默认值回落，使生产安全校验失效。
 *
 * SVH 的规则：
 * 1. **任何模块被 import 之前完成 parse**（fail-fast），配置不合法直接拒绝启动；
 * 2. **禁止在业务代码里出现 `process.env.X ?? 默认值`** —— 一律从 `getEnv()` 取；
 * 3. 不只在「空值」上失败，还显式拒绝 `minioadmin` / `change-me` 这类
 *    **弱默认值**（见 WEAK_SECRET_PATTERNS），且一次性收集全部问题再抛错。
 */
import { z } from 'zod';

/**
 * 弱默认值黑名单。
 *
 * 这些值常见于示例配置与文档，一旦被带到生产就是明确的凭据风险。
 * 用正则而非枚举，覆盖 `change-me` / `change_me` / `changeme` 等变体。
 */
export const WEAK_SECRET_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /change[-_]?me/i, reason: '示例占位值' },
  { pattern: /^(dev|test|local)[-_]?(secret|key|token)?/i, reason: '开发环境占位值' },
  { pattern: /^(minioadmin|admin|root|password|secret|123456|000000)$/i, reason: '常见弱口令' },
  { pattern: /(please[-_]?change|replace[-_]?me|your[-_]?key|xxx+)/i, reason: '待填写占位符' },
  { pattern: /^dev-only-/i, reason: '仅为开发准备的值' },
];

/**
 * 校验一个值是否为弱默认值。
 * @returns 命中时返回原因，否则返回 null
 */
export function detectWeakSecret(value: string): string | null {
  for (const { pattern, reason } of WEAK_SECRET_PATTERNS) {
    if (pattern.test(value)) return reason;
  }
  return null;
}

/** 运行环境 */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const STORAGE_DRIVERS = ['local', 's3'] as const;

/**
 * 密钥字段的通用校验：
 * - 生产环境要求足够长度
 * - 任何环境都拒绝弱默认值
 */
function secretField(options: { minLength: number }) {
  return z.string().min(1, '不能为空').superRefine((value, ctx) => {
    const weak = detectWeakSecret(value);
    if (weak) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `检测到弱默认值（${weak}），请替换为强随机值`,
      });
    }
    if (value.length < options.minLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `长度不足，至少需要 ${options.minLength} 个字符`,
      });
    }
  });
}

/** PostgreSQL 连接串 */
const postgresUrl = z
  .string()
  .min(1, 'DATABASE_URL 不能为空')
  .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
    message: 'DATABASE_URL 必须是 postgresql:// 或 postgres:// 开头的连接串',
  });

/** Redis 连接串 */
const redisUrl = z
  .string()
  .min(1, 'REDIS_URL 不能为空')
  .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
    message: 'REDIS_URL 必须是 redis:// 或 rediss:// 开头的连接串',
  });

/**
 * 完整环境变量 Schema。
 *
 * 约定：新增环境变量必须同时更新本 Schema 与仓库根目录 `.env.example`。
 */
export const envSchema = z
  .object({
    // ── 运行环境 ────────────────────────────────────────────────
    NODE_ENV: z.enum(NODE_ENVS).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

    // ── API 服务 ────────────────────────────────────────────────
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3030),
    /** 对外可访问的基础地址，用于拼接素材 URL 与回调地址 */
    API_PUBLIC_URL: z.string().url().default('http://127.0.0.1:3030'),

    // ── Web 前端 ────────────────────────────────────────────────
    WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5273),

    // ── 数据存储 ────────────────────────────────────────────────
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    /**
     * BullMQ 队列名前缀。
     *
     * ── 为什么必须可配 ──
     * 测试与开发期的 Worker 共用同一个 `REDIS_URL` 库。前缀写死成 `svh` 时，
     * 测试刚建出来的任务会被正在跑的 Worker **立刻抢走**并推到 `running`，
     * 表现为一堆看似与改动无关的断言失败（`expected 'running' to be 'pending'`、
     * `抢占失败：already_leased`）。改前缀是最小、最直接的隔离手段：
     * 测试用 `svh-test`，两边谁也看不见谁的作业。
     *
     * 对账循环（`reclaimExpiredTasks`）直接查库，但它只回收
     * **有租约且状态为 running** 的任务；测试建的任务拿不到租约，因此不受影响。
     */
    QUEUE_PREFIX: z
      .string()
      .min(1)
      .max(32)
      // BullMQ 的键名是 `<prefix>:<queue>:<id>`，冒号会破坏这个结构
      .regex(/^[A-Za-z0-9_-]+$/, 'QUEUE_PREFIX 只允许字母、数字、下划线与连字符')
      .default('svh'),

    // ── 加密 ────────────────────────────────────────────────────
    /**
     * 用于加密用户自带的模型 API Key（model_providers.apiKeyEncrypted）。
     * 生产环境必须为 32 字节以上的强随机值：`openssl rand -hex 32`
     */
    SECRET_ENCRYPTION_KEY: secretField({ minLength: 32 }),

    // ── 素材存储 ────────────────────────────────────────────────
    STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('local'),
    STORAGE_LOCAL_DIR: z.string().min(1).default('./storage'),
    STORAGE_PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:3030/files'),

    // ── 模型 Provider ───────────────────────────────────────────
    /*
     * 这里刻意**没有**「Mock / 真实」的开关。
     *
     * 早期版本有一个 `MODEL_PROVIDER_MODE`，但它会产生一个危险的组合：
     * 「已配置真实 Provider + mode=mock」会让真实配置被静默忽略，
     * 用户以为在用真实模型，实际拿到的是假数据。
     *
     * 现在改为自动判定：数据库里有可用的真实模型就用真实的，
     * 一个都没有才回落到 Mock（并记录警告）。行为更可预测，
     * 也不会出现「配置了却不生效」的情况。
     */

    /** 系统级共享 Provider（用户未自带 API 时可回落使用） */
    SHARED_OPENAI_BASE_URL: z.string().url().optional(),
    SHARED_OPENAI_API_KEY: z.string().min(1).optional(),

    // ── Worker ──────────────────────────────────────────────────
    /** Worker 标识；留空则由运行时自动生成（hostname + pid + 随机串） */
    WORKER_ID: z.string().min(1).max(128).optional(),
    /** 是否启用 Worker，便于只跑 API 的场景关闭消费 */
    WORKER_ENABLED: z
      .enum(['0', '1', 'true', 'false'])
      .default('true')
      .transform((v) => v === '1' || v === 'true'),

    // ── 可观测性 ────────────────────────────────────────────────
    /** 是否打印 Prisma 查询日志（含提示词，仅限本地调试） */
    PRISMA_LOG_QUERY: z
      .enum(['0', '1'])
      .default('0')
      .transform((v) => v === '1'),
  })
  .superRefine((env, ctx) => {
    // 生产环境的额外硬性要求
    if (env.NODE_ENV === 'production') {
      if (!env.API_PUBLIC_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['API_PUBLIC_URL'],
          message: '生产环境必须使用 https',
        });
      }
      if (env.STORAGE_DRIVER === 'local') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_DRIVER'],
          message: '生产环境不应使用本地磁盘存储，请改用 s3 兼容对象存储',
        });
      }
    }

    // 共享 Provider 的 URL 与 Key 必须同时提供
    if (env.SHARED_OPENAI_BASE_URL && !env.SHARED_OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARED_OPENAI_API_KEY'],
        message: '设置了 SHARED_OPENAI_BASE_URL 就必须同时设置 SHARED_OPENAI_API_KEY',
      });
    }
    if (env.SHARED_OPENAI_API_KEY && !env.SHARED_OPENAI_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARED_OPENAI_BASE_URL'],
        message: '设置了 SHARED_OPENAI_API_KEY 就必须同时设置 SHARED_OPENAI_BASE_URL',
      });
    }
  });

/** 解析后的环境配置类型 */
export type Env = z.infer<typeof envSchema>;

/** 配置校验失败时抛出的错误 */
export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `环境变量校验失败，共 ${issues.length} 项问题：\n` +
        issues.map((issue, i) => `  ${i + 1}. ${issue}`).join('\n') +
        '\n\n请参考仓库根目录的 .env.example 补全配置。',
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * 解析环境变量。
 *
 * 一次性收集**全部**问题再抛错，避免「修一个报一个」的糟糕体验。
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.') || '(根)';
    return `${path}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
