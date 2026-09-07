/**
 * handler + 主循环测试（task-5 简报 Step 1 + 评审修复轮1 探针）。
 *
 * 约定：假 Provider 工厂 + 0ms sleep 注入 + 真实临时 SQLite 库。
 * 覆盖：简报 6 条、评审承传 3 条、C1 取消竞态探针 A/B、
 * I1 claimed_by 接管自查、探针（completed 无 outputUrl / getTask 瞬态容忍）等。
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
  maxWaitMs: 900_000,
});

interface VideoCalls {
  create: number;
  get: number;
  cancel: string[];
}

/** 序列驱动的假视频 Provider（沿用 server 旧测试 videoBehavior 模式） */
function makeVideoProvider(opts: {
  sequence: VideoTask[];
  calls: VideoCalls;
  /** createTask 提交后（回写前）触发：模拟「往返窗口内 server 置 cancelled」 */
  onCreate?: (providerTaskId: string) => void;
  /** 首次 getTask 前触发：模拟「getTask 往返窗口内被取消」 */
  cancelDuringFirstGet?: () => void;
  /** 前 N 次 getTask 抛瞬态网络错 */
  getErrors?: number;
}): VideoProvider {
  let firstGet = true;
  return {
    id: "fake-video",
    async createTask() {
      opts.calls.create += 1;
      opts.onCreate?.("pt-9");
      return { providerTaskId: "pt-9" };
    },
    async getTask() {
      opts.calls.get += 1;
      if (firstGet) {
        firstGet = false;
        opts.cancelDuringFirstGet?.();
      }
      if (opts.getErrors && opts.getErrors > 0) {
        opts.getErrors -= 1;
        throw new Error("net flaky #3");
      }
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

test("video 全流程：createTask→updateRunning(providerTaskId)→轮询 running→completed 落资产", async () => {
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
  assert.equal(row.providerTaskId, "pt-9", "updateRunning 应已回写供应商任务 id");
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

// ==================== C1 评审承传：瞬态锁 + 取消竞态探针 ====================

test("C1 探针A：createTask 往返期间被置 cancelled → providerTaskId 回写守卫失败 → cancelTask、保持 cancelled、不落资产", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    log: () => {}, // 让位日志已由守卫断言验证，此处静音避免测试输出噪音
    sleep: async () => {},
    videoProviderFactory: () =>
      makeVideoProvider({
        calls,
        sequence: [],
        // createTask 返回后、回写 providerTaskId 前，行已被 server 取消
        onCreate: () => {
          env.db.update(productionTasks).set({ status: "cancelled" }).where(eq(productionTasks.id, id)).run();
        },
      }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "cancelled", "cancelled 不得被 providerTaskId 回写复活");
  assert.equal(row.providerTaskId, null, "回写守卫失败，providerTaskId 不应落库（不覆写）");
  assert.deepEqual(calls.cancel, ["pt-9"], "应尽力取消刚创建供应商任务，防孤儿扣费");
  assert.equal(calls.get, 0, "取消后立即退出，不进入轮询");
  assert.equal((await env.production.listAssets(env.projectId, "video")).length, 0);
  env.cleanup();
});

test("C1 探针B：getTask 往返期间被置 cancelled → progress 回写守卫失败 → cancelTask、保持 cancelled、不落资产", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    log: () => {}, // 静音 abandon 让位日志（评审 Minor1）
    sleep: async () => {},
    videoProviderFactory: () =>
      makeVideoProvider({
        calls,
        // 首轮 getTask 调用瞬间（往返窗口）行被取消；随后返回 running 快照
        cancelDuringFirstGet: () => {
          env.db.update(productionTasks).set({ status: "cancelled" }).where(eq(productionTasks.id, id)).run();
        },
        sequence: [{ id: "t", providerTaskId: "pt-9", status: "running", progress: 50 }],
      }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "cancelled", "progress 回写守卫失败，不得复活为 running");
  assert.equal(row.progress, null, "progress 未被无守卫写脏");
  assert.equal(calls.get, 1, "守卫失败后立即退出轮询");
  assert.deepEqual(calls.cancel, ["pt-9"], "往返窗口被取消：abandon 路径应尽力取消供应商任务（防孤儿扣费）");
  assert.equal((await env.production.listAssets(env.projectId, "video")).length, 0);
  env.cleanup();
});

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

test("承传#1b：heartbeat 瞬态抛锁错 → tick 记日志且本轮 claim 仍照常执行（不靠不命中的 Proxy）", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  let failHeartbeat = true;
  const target = env.db;
  const flakyDb = new Proxy(target, {
    get(t, key) {
      if (key === "$client") {
        return {
          prepare(sql: string) {
            if (failHeartbeat && sql.includes("SET heartbeat_at")) {
              failHeartbeat = false;
              throw new Error("database is locked");
            }
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

  loop.tick(); // heartbeat 抛错被吞，但 claim 应照常执行
  assert.ok(logs.some((m) => m.includes("transient 心跳锁冲突")), `缺少心跳瞬态日志：${logs.join(" | ")}`);
  assert.equal(loop.active(), 1, "心跳瞬态失败不应阻断本轮认领");
  await waitUntil(() => loop.active() === 0, "任务收尾");
  assert.equal(getRow(env.db, id).status, "completed");
  await loop.stop();
  env.cleanup();
});

// ==================== I1 评审承传：认领者自查 ====================

test("I1：video 轮询中 claimed_by 被改（模拟其他 worker 接管）→ 静默退出、finishTask 未调、行仍 running", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, {
    projectId: env.projectId,
    userId: env.userId,
    kind: "video",
    status: "running",
    heartbeatAt: 1000,
    providerTaskId: "pt-9",
  });
  const task = claimOne(env, id, "wkr-1"); // 认领者 wkr-1；接管后 claimed_by 变 wkr-2
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  let slept = 0;
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    // 第二轮 sleep：模拟 stale 回收后 wkr-2 抢走认领（claimed_by 改写，行仍 running）
    sleep: async () => {
      slept += 1;
      if (slept === 2) {
        env.db.update(productionTasks).set({ claimedBy: "wkr-2" }).where(eq(productionTasks.id, id)).run();
      }
    },
    videoProviderFactory: () =>
      makeVideoProvider({ calls, sequence: [{ id: "t", providerTaskId: "pt-9", status: "running", progress: 30 }] }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "running", "旧 worker 让位，不写终态（finishTask 未被调用）");
  assert.equal(row.claimedBy, "wkr-2");
  assert.equal(calls.get, 1, "认领者自查失败后立即停止轮询");
  assert.equal((await env.production.listAssets(env.projectId, "video")).length, 0);
  env.cleanup();
});

test("I1：image 写终态前二次自查 claimed_by 变更（被接管）→ 资产已落库、让位终态不覆写", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const task = claimOne(env, id, "wkr-1");
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    log: () => {}, // 静音「资产已落库但失去归属」让位日志（评审 Minor1）
    imageProviderFactory: () => ({
      id: "fake-image",
      async generate() {
        // 生成期间被其他 worker 判定 stale 接管
        env.db.update(productionTasks).set({ claimedBy: "wkr-2" }).where(eq(productionTasks.id, id)).run();
        return { images: [{ url: "https://x/a.png" }] };
      },
    }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "running", "claimed_by 已非本 worker：让位，不改终态");
  assert.equal(row.claimedBy, "wkr-2");
  assert.equal(
    (await env.production.listAssets(env.projectId, "image")).length,
    1,
    "生成已真实成功：资产照常落库，仅终态让位给接管者",
  );
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
          .set({ status: "completed", outputUrl: "https://takeover/v.mp4", claimedBy: "wkr-1" })
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

test("承传#3：payload 不完整（空 prompt / 缺 apiKey / 缺 model / 缺 assetName）→ 快速 failed 不发请求", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: { prompt: "" } });
  // 覆盖为 undefined：JSON.stringify 丢键 → 模拟 server 写入了缺字段的 payload
  const b = seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: { apiKey: undefined } });
  const c = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video", payload: { model: "" } });
  const d = seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: { assetName: "" } });
  const claimed = claimTasks(env.db, "wkr-1", { limit: 5, staleMs: 60_000 });
  const find = (taskId: string): ClaimedTask => {
    const t = claimed.find((x) => x.id === taskId);
    assert.ok(t, `任务 ${taskId} 应可被认领`);
    return t;
  };
  const ta = find(a);
  const tb = find(b);
  const tc = find(c);
  const td = find(d);
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
  await runTask(env.db, env.production, td, deps);

  for (const taskId of [a, b, c, d]) {
    const row = getRow(env.db, taskId);
    assert.equal(row.status, "failed", `任务 ${taskId} 应快速失败`);
    assert.equal(row.error, "任务参数不完整");
  }
  assert.equal(imageCalls, 0);
  assert.equal(videoCalls, 0);
  env.cleanup();
});

// ==================== Minor 健壮性 ====================

test("video completed 但无 outputUrl → 立即 failed「无输出地址」，不空转", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    sleep: async () => {},
    // completed 无 outputUrl：sequence 提供一条后即回落 running，若无修复将空转到超时
    videoProviderFactory: () =>
      makeVideoProvider({ calls, sequence: [{ id: "t", providerTaskId: "pt-9", status: "completed" }] }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /无输出地址/);
  assert.equal(calls.get, 1);
  env.cleanup();
});

test("video getTask 瞬态网络异常容忍：前 2 次抛错第 3 次成功 → 正常完成", async () => {
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
        getErrors: 2,
        sequence: [{ id: "t", providerTaskId: "pt-9", status: "completed", outputUrl: "https://x/v.mp4" }],
      }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "completed");
  assert.equal(row.outputUrl, "https://x/v.mp4");
  assert.equal((await env.production.listAssets(env.projectId, "video")).length, 1);
  env.cleanup();
});

test("video getTask 连续 3 次瞬态异常 → failed（带最后一次错误）", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  const task = claimOne(env, id);
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    sleep: async () => {},
    maxWaitMs: 60_000,
    videoProviderFactory: () => makeVideoProvider({ calls, getErrors: 3, sequence: [] }),
  };

  await runTask(env.db, env.production, task, deps);

  const row = getRow(env.db, id);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /net flaky #3/);
  assert.equal(calls.get, 3);
  env.cleanup();
});

test("video 入口自查：claim 后立即已 cancelled 且行带 providerTaskId → 取消供应商任务不进入轮询", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, {
    projectId: env.projectId,
    userId: env.userId,
    kind: "video",
    status: "running",
    heartbeatAt: 1000,
    providerTaskId: "pt-9",
  });
  const task = claimOne(env, id);
  // 认领后、runTask 前立即取消
  env.db.update(productionTasks).set({ status: "cancelled" }).where(eq(productionTasks.id, id)).run();
  const calls: VideoCalls = { create: 0, get: 0, cancel: [] };
  const deps: HandlerDeps = {
    pollIntervalMs: 0,
    log: () => {}, // 静音入口自查让位日志（评审 Minor1）
    sleep: async () => {},
    videoProviderFactory: () => makeVideoProvider({ calls, sequence: [] }),
  };

  await runTask(env.db, env.production, task, deps);

  assert.equal(calls.create, 0, "不重复提交");
  assert.deepEqual(calls.cancel, ["pt-9"], "取消已有供应商任务");
  assert.equal(calls.get, 0, "不进入轮询");
  assert.equal(getRow(env.db, id).status, "cancelled");
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
  const loop = createWorkerLoop(
    env.db,
    env.production,
    loopConfig("wkr-s"),
    { pollIntervalMs: 0, imageProviderFactory: neverImage },
    () => {},
  );
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
