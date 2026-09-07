/**
 * handler + 主循环测试（task-5 简报 Step 1）。
 *
 * 约定：假 Provider 工厂 + 0ms sleep 注入 + 真实临时 SQLite 库。
 * 除简报 6 条用例外，另覆盖 Task 4 评审承传三点：
 * claim 瞬态锁错误 catch、video 轮询行失活静默退出、payload 防御快速失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { productionTasks, type SVHDatabase } from "@svh/database";
import { eq } from "drizzle-orm";
import type { ImageProvider, VideoProvider, VideoTask } from "@svh/providers";
import { claimTasks, type ClaimedTask } from "../src/queue";
import { runTask, type HandlerDeps } from "../src/handlers";
import { createWorkerLoop } from "../src/index";
import type { WorkerConfig } from "../src/config";
import { createTestEnv, seedTask, type TestEnv } from "./helpers/setup";

/** 认领指定任务并返回 ClaimedTask（复用真实 claim，顺带验证集成） */
function claimOne(env: TestEnv, taskId: string, workerId = "wkr-1"): ClaimedTask {
  const claimed = claimTasks(env.db, workerId, { limit: 5, staleMs: 60_000 });
  const task = claimed.find((t) => t.id === taskId);
  assert.ok(task, `任务 ${taskId} 应可被认领（实领：${claimed.map((t) => t.id).join(",")}）`);
  return task;
}

function getRow(db: SVHDatabase, id: string) {
  const row = db.select().from(productionTasks).where(eq(productionTasks.id, id)).get();
  assert.ok(row, `任务行 ${id} 应存在`);
  return row;
}

/** 等待条件成立（异步 handler 收尾用，避免脆弱固定延时） */
async function waitUntil(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    assert.ok(Date.now() < deadline, `等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const loopConfig = (workerId: string, concurrency = 1): WorkerConfig => ({
  databaseUrl: "",
  workerId,
  concurrency,
  tickMs: 1000,
  pollMs: 0,
  staleMs: 60_000,
});

interface VideoCalls {
  create: number;
  get: number;
  cancel: string[];
}

/** 序列驱动的假视频 Provider（沿用 server 旧测试 videoBehavior 模式） */
function makeVideoProvider(opts: { sequence: VideoTask[]; calls: VideoCalls }): VideoProvider {
  return {
    id: "fake-video",
    async createTask() {
      opts.calls.create += 1;
      return { providerTaskId: "pt-9" };
    },
    async getTask() {
      opts.calls.get += 1;
      return opts.sequence.shift() ?? { id: "t", providerTaskId: "pt-9", status: "running" };
    },
    async cancelTask(providerTaskId) {
      opts.calls.cancel.push(providerTaskId);
    },
  };
}

const neverImage: () => ImageProvider = () => ({
  id: "never-image",
  async generate() {
    throw new Error("不应被调用");
  },
});

// ==================== 简报 Step 1 六条 ====================

test("image 成功：generate → 资产落库（含 generation 追踪）→ completed/progress=100/outputUrl", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: { prompt: "雨夜霓虹" } });
  const task = claimOne(env, id);
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    imageProviderFactory: () => ({
      id: "fake-image",
      async generate() {
        return { images: [{ url: "https://x/a.png" }], created: 1 };
      },
    }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "completed");
  assert.equal(row.progress, 100);
  assert.equal(row.outputUrl, "https://x/a.png");
  assert.equal(row.error, null);
  const assets = await env.production.listAssets(env.projectId, "image");
  assert.equal(assets.length, 1);
  assert.equal(assets[0]!.url, "https://x/a.png");
  assert.equal(assets[0]!.generation?.modelId, "m");
  assert.equal(assets[0]!.generation?.taskId, id);
  env.cleanup();
});

test("image 失败：generate 抛错 → failed 且 error 透传，不落资产", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const task = claimOne(env, id);
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    imageProviderFactory: () => ({
      id: "fake-image",
      async generate() {
        throw new Error("401 key invalid");
      },
    }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /401/);
  assert.equal((await env.production.listAssets(env.projectId, "image")).length, 0);
  env.cleanup();
});

test("video 全流程：createTask→setTaskRunning(providerTaskId)→轮询 running→completed 落资产", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    sleep: async () => {},
    videoProviderFactory: () =>
      makeVideoProvider({
        calls,
        sequence: [
          { id: "t", providerTaskId: "pt-9", status: "running", progress: 40 },
          { id: "t", providerTaskId: "pt-9", status: "completed", outputUrl: "https://x/v.mp4" },
        ],
      }),
  };

  await runTask(env.db, env.production, task, deps);

  assert.equal(calls.create, 1);
  const row = getRow(env.db, id);
  assert.equal(row.status, "completed");
  assert.equal(row.providerTaskId, "pt-9", "setTaskRunning 应已回写供应商任务 id");
  assert.equal(row.outputUrl, "https://x/v.mp4");
  assert.equal(row.progress, 100);
  const assets = await env.production.listAssets(env.projectId, "video");
  assert.equal(assets.length, 1);
  assert.equal(assets[0]!.generation?.taskId, id);
  env.cleanup();
});

test("video 取消：轮询间行被置 cancelled → cancelTask(pt-9)、保持 cancelled、不落资产", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  let slept = 0;
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    // 第一轮 sleep 时模拟 server 取消（提交后、首轮 getTask 前）
    sleep: async () => {
      slept += 1;
      if (slept === 1) {
        env.db.update(productionTasks).set({ status: "cancelled" }).where(eq(productionTasks.id, id)).run();
      }
    },
    videoProviderFactory: () => makeVideoProvider({ calls, sequence: [] }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.deepEqual(calls.cancel, ["pt-9"], "应对供应商 best-effort 取消");
  assert.equal(calls.get, 0, "取消后不再轮询");
  assert.equal(row.status, "cancelled");
  assert.equal((await env.production.listAssets(env.projectId, "video")).length, 0);
  env.cleanup();
});

test("video 供应商失败：getTask failed → task failed 不落资产", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    sleep: async () => {},
    videoProviderFactory: () =>
      makeVideoProvider({
        calls,
        sequence: [{ id: "t", providerTaskId: "pt-9", status: "failed", error: "quota" }],
      }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /quota/);
  assert.equal((await env.production.listAssets(env.projectId, "video")).length, 0);
  env.cleanup();
});

test("runTask 分发：白名单外 kind → failed「暂不支持的任务类型」", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const task = claimOne(env, id);
  const bogus: ClaimedTask = { ...task, kind: "audio" as unknown as ClaimedTask["kind"] };

  await runTask(env.db, env.production, bogus, { pollIntervalMs: 0, imageProviderFactory: neverImage });

  const row = getRow(env.db, id);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /暂不支持的任务类型/);
  env.cleanup();
});

// ==================== Task 4 评审承传三条 ====================

test("承传#1：claimTasks 抛「database is locked」→ tick 不上抛、记日志，下轮重试成功", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  let failClaim = true;
  const target = env.db;
  // 包一层 $client.prepare：认领语句（含 RETURNING）瞬态抛锁错
  const flakyDb = new Proxy(target, {
    get(t, key) {
      if (key === "$client") {
        return {
          prepare(sql: string) {
            if (failClaim && sql.includes("RETURNING")) throw new Error("database is locked");
            return t.$client.prepare(sql);
          },
        };
      }
      const value = Reflect.get(t, key, t) as unknown;
      return typeof value === "function" ? value.bind(t) : value;
    },
  }) as unknown as SVHDatabase;

  const logs: string[] = [];
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    imageProviderFactory: () => ({
      id: "fake-image",
      async generate() {
        return { images: [{ url: "https://x/a.png" }] };
      },
    }),
  };
  const loop = createWorkerLoop(flakyDb, env.production, loopConfig("wkr-t"), deps, (m) => logs.push(m));

  loop.tick(); // 第一轮：瞬态锁冲突
  assert.equal(loop.active(), 0, "锁冲突不应启动任务，也不应抛出/崩溃");
  assert.ok(logs.some((m) => m.includes("transient claim 锁冲突")), `缺少瞬态日志：${logs.join(" | ")}`);

  failClaim = false;
  loop.tick(); // 第二轮：认领成功并跑完
  assert.equal(loop.active(), 1);
  await waitUntil(() => loop.active() === 0, "任务收尾");
  assert.equal(getRow(env.db, id).status, "completed");
  await loop.stop();
  env.cleanup();
});

test("承传#2：video 轮询中行不再是 running（被接管写终态）→ 静默退出、不覆写不落资产", async () => {
  const env = await createTestEnv();
  // 已带 providerTaskId 的僵尸 running 行（心跳过期）→ claim 接管续轮询
  const id = seedTask(env.db, {
    projectId: env.projectId,
    userId: env.userId,
    kind: "video",
    status: "running",
    heartbeatAt: 1000,
    providerTaskId: "pt-9",
  });
  const task = claimOne(env, id);
  assert.equal(task.providerTaskId, "pt-9");
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  let slept = 0;
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    // 第二轮 sleep 前，模拟接管者已把行写成 completed
    sleep: async () => {
      slept += 1;
      if (slept === 2) {
        env.db
          .update(productionTasks)
          .set({ status: "completed", outputUrl: "https://takeover/v.mp4" })
          .where(eq(productionTasks.id, id))
          .run();
      }
    },
    videoProviderFactory: () =>
      makeVideoProvider({
        calls,
        sequence: [{ id: "t", providerTaskId: "pt-9", status: "running", progress: 50 }],
      }),
  };

  await runTask(env.db, env.production, task, deps);

  assert.equal(calls.create, 0, "已有 providerTaskId 不重复提交（防双扣费）");
  assert.equal(calls.get, 1, "行失活后不再轮询");
  assert.deepEqual(calls.cancel, []);
  const row = getRow(env.db, id);
  assert.equal(row.status, "completed");
  assert.equal(row.outputUrl, "https://takeover/v.mp4", "不得覆写接管者写的终态");
  assert.equal((await env.production.listAssets(env.projectId, "video")).length, 0);
  env.cleanup();
});

test("承传#3：payload 不完整（image 空 prompt / 缺 apiKey / video 缺 model）→ 快速 failed 不发请求", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: { prompt: "" } });
  // 覆盖为 undefined：JSON.stringify 丢键 → 模拟 server 写入了缺字段的 payload
  const b = seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: { apiKey: undefined } });
  const c = seedTask(env.db, {
    projectId: env.projectId,
    userId: env.userId,
    kind: "video",
    payload: { model: "" },
  });
  // 一次领完三条（三条 payload 均可解析，只是执行字段缺失）
  const claimed = claimTasks(env.db, "wkr-1", { limit: 5, staleMs: 60_000 });
  const find = (id: string): ClaimedTask => {
    const t = claimed.find((x) => x.id === id);
    assert.ok(t, `任务 ${id} 应可被认领`);
    return t;
  };
  const ta = find(a);
  const tb = find(b);
  const tc = find(c);
  let imageCalls = 0;
  let videoCalls = 0;
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    imageProviderFactory: () => {
      imageCalls += 1;
      return { id: "never", generate: async () => { throw new Error("不应发起生成"); } };
    },
    videoProviderFactory: () => {
      videoCalls += 1;
      throw new Error("不应发起生成");
    },
  };

  await runTask(env.db, env.production, ta, deps);
  await runTask(env.db, env.production, tb, deps);
  await runTask(env.db, env.production, tc, deps);

  for (const id of [a, b, c]) {
    const row = getRow(env.db, id);
    assert.equal(row.status, "failed", `任务 ${id} 应快速失败`);
    assert.equal(row.error, "任务参数不完整");
  }
  assert.equal(imageCalls, 0);
  assert.equal(videoCalls, 0);
  env.cleanup();
});

// ==================== 主循环其余行为 ====================

test("loop：concurrency=1 时限流，槽位释放后下一轮认领剩余任务", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const b = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    imageProviderFactory: () => ({
      id: "fake-image",
      async generate() {
        await gate;
        return { images: [{ url: "https://x/a.png" }] };
      },
    }),
  };
  const loop = createWorkerLoop(env.db, env.production, loopConfig("wkr-c", 1), deps, () => {});

  loop.tick();
  assert.equal(loop.active(), 1);
  loop.tick(); // 槽位已满：不再认领
  assert.equal(loop.active(), 1);

  release();
  await waitUntil(() => loop.active() === 0, "首个任务收尾");
  loop.tick(); // 认领第二条（gate 已决议，立即完成）
  assert.equal(loop.active(), 1);
  await waitUntil(() => loop.active() === 0, "次个任务收尾");
  assert.equal(getRow(env.db, a).status, "completed");
  assert.equal(getRow(env.db, b).status, "completed");
  await loop.stop();
  env.cleanup();
});

test("loop：stop 后 tick 不再认领", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const loop = createWorkerLoop(env.db, env.production, loopConfig("wkr-s"), { pollIntervalMs: 0, imageProviderFactory: neverImage }, () => {});
  await loop.stop();
  loop.tick();
  assert.equal(loop.active(), 0);
  assert.equal(getRow(env.db, id).status, "queued");
  env.cleanup();
});

test("video 等待超时：maxWaitMs 超限 → failed（超时文案）", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    sleep: async () => {},
    maxWaitMs: -1, // 首轮即判定超时
    videoProviderFactory: () => makeVideoProvider({ calls, sequence: [] }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /超时/);
  env.cleanup();
});
