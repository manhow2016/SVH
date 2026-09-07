import { test } from "node:test";
import assert from "node:assert/strict";
import { productionTasks } from "@svh/database";
import { eq } from "drizzle-orm";
import { claimTasks, heartbeat, finishTask, getTaskStatus, setTaskRunning } from "../src/queue";
import { createTestEnv, seedTask } from "./helpers/setup";

test("claim：queued 按 created_at 先进先出，limit 限流，认领后置 running/claimed_by/heartbeat", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const b = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const now = Date.now();
  const claimed = claimTasks(env.db, "wkr-1", { limit: 1, staleMs: 60_000, now });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.id, a); // 先建先领
  assert.equal(claimed[0]!.payload.model, "m");
  const row = env.db.select().from(productionTasks).where(eq(productionTasks.id, b)).get();
  assert.equal(row!.status, "queued", "第二条约满未领");
});

test("claim 原子性：两个 worker 连续认领不拿到同一任务；未知 kind 不认领", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const b = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "audio" });
  const one = claimTasks(env.db, "wkr-1", { limit: 5, staleMs: 60_000 });
  const two = claimTasks(env.db, "wkr-2", { limit: 5, staleMs: 60_000 });
  const ids = [...one, ...two].map((t) => t.id).sort();
  assert.deepEqual(ids, [a, b].sort(), "无重复认领且 audio 未被认领");
});

test("stale 回收：running 且心跳超时（含 NULL）可被其他 worker 接管", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId, status: "running", heartbeatAt: 1000 });
  seedTask(env.db, { projectId: env.projectId, userId: env.userId, status: "running", heartbeatAt: Date.now() }); // 新鲜心跳不抢
  const now = Date.now();
  const claimed = claimTasks(env.db, "wkr-2", { limit: 5, staleMs: 60_000, now });
  assert.deepEqual(claimed.map((t) => t.id), [a]);
});

test("坏 payload 直接置 failed 不阻塞队列；heartbeat/setTaskRunning/getTaskStatus/finishTask 语义", async () => {
  const env = await createTestEnv();
  seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: null });
  const good = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const claimed = claimTasks(env.db, "wkr-1", { limit: 5, staleMs: 60_000 });
  assert.deepEqual(claimed.map((t) => t.id), [good], "坏 payload 被跳过并落 failed");
  assert.equal(getTaskStatus(env.db, "ptk-not-exists"), null, "不存在的任务返回 null");

  heartbeat(env.db, "wkr-1", 12345);
  const owned = env.db.select().from(productionTasks).where(eq(productionTasks.id, good)).get();
  assert.equal(owned!.heartbeatAt, 12345);

  setTaskRunning(env.db, good, { providerTaskId: "pt-1", progress: 10 });
  assert.equal(getTaskStatus(env.db, good), "running");

  assert.equal(finishTask(env.db, good, { status: "completed", outputUrl: "u", progress: 100 }), true);
  assert.equal(finishTask(env.db, good, { status: "failed", error: "x" }), false, "非 running 不覆写（取消竞态守卫）");
  const done = env.db.select().from(productionTasks).where(eq(productionTasks.id, good)).get();
  assert.equal(done!.status, "completed");
  assert.equal(done!.error, null);
  env.cleanup();
});
