/**
 * Vitest 全局前置：在任何测试模块被 import 之前加载环境变量
 *
 * ── 为什么必须放在 setupFiles 而不是 beforeAll ──
 * ESM 的 import 会被提升到模块顶部执行。`@svh/database` 在**模块加载时**
 * 就构造了 PrismaClient，而 PrismaClient 会在构造时读取 `DATABASE_URL`。
 * 若把 `bootstrapConfig()` 写在 `beforeAll` 里，PrismaClient 早已带着空的
 * 环境变量初始化完毕 —— 表现为「测试全部失败并报 DATABASE_URL 未找到」。
 *
 * `setupFiles` 会在测试文件被 import 之前执行，因此是唯一正确的位置。
 */
import { loadEnvFile } from '@svh/config';

// 从当前工作目录向上查找唯一的 .env（monorepo 根目录那一份）
loadEnvFile(process.cwd());

/*
 * 把队列前缀改成测试专用的，**必须**放在 loadEnvFile 之后、任何模块 import 之前。
 *
 * 测试与 `pnpm worker:dev` 共用同一个 REDIS_URL 库。前缀一致时，正在跑的 Worker
 * 会抢走测试刚建出来的任务并推到 `running`，表现成一堆看似与改动无关的失败：
 *
 *   expected 'running' to be 'pending'
 *   expected '抢占失败：already_leased' to contain '等待用户确认'
 *   smoke：取消任务后…  expected 404 to be 204
 *
 * 实测：Worker 在跑时 @svh/api 有 5 条失败；停掉 Worker 后同一份代码 118/118 全过。
 * 加上这行之后两边再也看不见对方的作业，不必再「跑测试前先停 Worker」。
 *
 * 每个包用自己的前缀（api / worker / queue），因为 turbo 会并行跑它们的测试。
 */
process.env.QUEUE_PREFIX = 'svh-test-api';

/*
 * 强制 Agent 使用内置 Mock 模型。
 *
 * Agent 的模型运行时是从**数据库里已配置的 Provider** 装配的。不强制的话，
 * 测试就会去打开发者本机实际配置的那个服务：
 *   · 配了真实付费 API → 跑一次测试就是真实计费调用；
 *   · 配的是本地桩服务 → 测试会消耗它的一次性状态（「是否已提交工具调用」），
 *     随后的人工复现拿到的是预置回复而不是工具调用；
 *   · 什么都没配 → 走内置兜底。
 * 同一份测试在三种环境下走三条不同路径，测试就不再是确定的了。
 *
 * 同样放在 loadEnvFile 之后、任何 import 之前 —— 配置在模块加载时读取。
 */
process.env.AGENT_FORCE_MOCK = 'true';

// 缺少 DATABASE_URL 时直接给出可操作的提示，而不是让 20 个用例各自报错
if (!process.env.DATABASE_URL) {
  throw new Error(
    '测试环境缺少 DATABASE_URL。请先在仓库根目录创建 .env（可复制 .env.example）后重试。',
  );
}
