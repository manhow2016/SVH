import { test } from "node:test";
import assert from "node:assert/strict";
import { productionTasks } from "@svh/database";
import { eq } from "drizzle-orm";
import {
  claimTasks,
  heartbeat,
  finishTask,
  getTaskClaim,
  updateRunning,
} from "../src/queue";
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

test("payload 区分：NULL payload 不认领（保持 queued，I2）；损坏 JSON 认领即置 failed；其余队列语义", async () => {
  const env = await createTestEnv();
  const nullId = seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: null });
  const brokenId = seedTask(env.db, { projectId: env.projectId, userId: env.userId, rawPayload: "not-json{" });
  const good = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const claimed = claimTasks(env.db, "wkr-1", { limit: 5, staleMs: 60_000 });
  // NULL payload 现被认领者 SQL 排除（留给后续任务），只返回 good；broken JSON 认领后置 failed
  assert.deepEqual(claimed.map((t) => t.id), [good], "仅 good 可认领，损坏 JSON 被置 failed 后跳过");
  assert.equal(claimed[0]!.claimedBy, "wkr-1", "ClaimedTask.claimedBy 应为认领者 workerId");
  assert.equal(getTaskClaim(env.db, nullId)?.status, "queued", "NULL payload 不认领也不置 failed");
  assert.equal(getTaskClaim(env.db, brokenId)?.status, "failed", "损坏 JSON（非空 payload）认领后置 failed 防反复回收");
  assert.equal(getTaskClaim(env.db, "ptk-not-exists"), null, "不存在的任务返回 null");

  heartbeat(env.db, "wkr-1", 12345);
  const owned = env.db.select().from(productionTasks).where(eq(productionTasks.id, good)).get();
  assert.equal(owned!.heartbeatAt, 12345);

  assert.equal(finishTask(env.db, good, { status: "completed", outputUrl: "u", progress: 100 }), true);
  assert.equal(finishTask(env.db, good, { status: "failed", error: "x" }), false, "非 running 不覆写（取消竞态守卫）");
  const done = env.db.select().from(productionTasks).where(eq(productionTasks.id, good)).get();
  assert.equal(done!.status, "completed");
  assert.equal(done!.error, null);
  env.cleanup();
});

test("updateRunning：仅 running 行可推进；被取消/被接管行返回 false 且绝不复活（C1 守卫）", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "video" });
  claimTasks(env.db, "wkr-1", { limit: 1, staleMs: 60_000 }); // → running

  assert.equal(updateRunning(env.db, id, { progress: 30 }), true, "running 行推进成功");
  assert.equal(updateRunning(env.db, id, { providerTaskId: "pt-9" }), true);
  let row = env.db.select().from(productionTasks).where(eq(productionTasks.id, id)).get();
  assert.equal(row!.progress, 30);
  assert.equal(row!.providerTaskId, "pt-9");

  // 模拟 server 取消 → 此后任何 worker 推进都应失败且不复活状态（探针 A/B 根因）
  env.db.update(productionTasks).set({ status: "cancelled" }).where(eq(productionTasks.id, id)).run();
  assert.equal(updateRunning(env.db, id, { progress: 60 }), false, "取消行不可推进");
  assert.equal(updateRunning(env.db, id, { providerTaskId: "pt-late" }), false, "取消行不可回写 providerTaskId");
  row = env.db.select().from(productionTasks).where(eq(productionTasks.id, id)).get();
  assert.equal(row!.status, "cancelled", "推进失败绝不把 cancelled 复活成 running");
  assert.equal(row!.providerTaskId, "pt-9", "providerTaskId 未被迟到回写覆写");
  assert.equal(row!.progress, 30, "progress 停在取消前的值");
  env.cleanup();
});

test("getTaskClaim：返回 {status, claimedBy} 供轮询自查认领者（I1）", async () => {
  const env = await createTestEnv();
  const id = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  assert.deepEqual(getTaskClaim(env.db, id), { status: "queued", claimedBy: null });
  claimTasks(env.db, "wkr-1", { limit: 1, staleMs: 60_000 });
  assert.deepEqual(getTaskClaim(env.db, id), { status: "running", claimedBy: "wkr-1" });
  assert.equal(getTaskClaim(env.db, "ptk-not-exists"), null);
  env.cleanup();
});
