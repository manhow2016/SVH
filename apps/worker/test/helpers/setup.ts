/** 临时库 + 用户/工作区/项目种子（worker 测试通用夹具） */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, productionTasks, users, workspaces, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import { ProductionService } from "@svh/production";
import { DrizzleProductionRepository } from "@svh/production";
import type { TaskPayload } from "../../src/queue";

export interface TestEnv {
  dir: string;
  db: SVHDatabase;
  userId: string;
  projectId: string;
  production: ProductionService;
  cleanup(): void;
}

export async function createTestEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "svh-worker-"));
  const db = createDatabase(join(dir, "test.db"));
  const userId = randomId("usr");
  db.insert(users)
    .values({ id: userId, username: "wk", email: "wk@test.local", passwordHash: "x",
      role: "user", status: "active", createdAt: new Date(), updatedAt: new Date() })
    .run();
  const wsId = randomId("ws");
  db.insert(workspaces)
    .values({ id: wsId, name: "wk-ws", rootPath: join(dir, wsId), userId,
      createdAt: new Date(), updatedAt: new Date() })
    .run();
  const production = new ProductionService(new DrizzleProductionRepository(db));
  const projectId = (await production.createProject({ workspaceId: wsId, name: "队列项目" })).id;
  return { dir, db, userId, projectId, production, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 插入一条 queued 图片任务（默认值可覆盖；payload 传 null 模拟损坏） */
export function seedTask(
  db: SVHDatabase,
  input: {
    projectId: string;
    userId: string;
    kind?: string;
    status?: string;
    payload?: Partial<TaskPayload> | null;
    providerTaskId?: string | null;
    heartbeatAt?: number | null;
  },
): string {
  const id = randomId("ptk");
  const now = new Date();
  const payload: TaskPayload = {
    v: 1, prompt: "p", providerId: "dashscope", model: "m", baseUrl: "", apiKey: "k", assetName: "任务",
    ...(input.payload ?? {}),
  };
  db.insert(productionTasks)
    .values({
      id,
      projectId: input.projectId,
      userId: input.userId,
      kind: input.kind ?? "image",
      status: input.status ?? "queued",
      providerTaskId: input.providerTaskId ?? null,
      heartbeatAt: input.heartbeatAt ?? null,
      payload: input.payload === null ? null : JSON.stringify(payload),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}
