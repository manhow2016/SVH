# 角色面板重构：形象方案 + 主形象 + 配音音色 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把制作中心「角色」页签重做为「角色切换 + 形象方案生成/选主形象 + 配音音色三来源/试听」的完整工作台。

**Architecture:** 零新表。方案图 = 项目 image 资产 + metadata 打标（`svhRole/characterId/batchId/seq`）；主形象 = 复用 `character.reference_asset_id`（一致性/参考图注入链路零改动）；音色 = 新增 `voice_asset_id` 列 + 三来源统一落地为项目 audio 资产。新端点 2 个（schemes 生成/列表、audio 二进制上传），其余复用既有 API。

**Tech Stack:** TypeScript / Fastify(5) / Drizzle + better-sqlite3（幂等迁移）/ tsx（dev）/ node:test（`node --import tsx --test <file>`）/ React18 + antd5 + TanStack Query。

**Spec:** [docs/superpowers/specs/2026-09-10-character-scheme-panel-design.md](../specs/2026-09-10-character-scheme-panel-design.md)

## Global Constraints

- 分层纪律：`packages/production` 纯领域（禁 SQL/HTTP/AI/React）；server ↔ worker 经手写 JSON 契约（`TaskPayload` 双端同步，加字段两侧同改，改注释）
- 幂等迁移：`migrateSchema` 内 `PRAGMA table_info` 探测 → `ALTER TABLE ... ADD COLUMN`（见 `packages/database/src/client.ts` migrateSchema 既有模式）
- 越权与不存在一律 404（`assertProjectOwned` / `ownedProjectOf`，不泄露存在性）
- 提交信息中文，格式 `type(scope): 描述`（feat/fix/docs/test 等）
- 所有新端点/服务方法必须有中文 JSDoc 注释
- 会员门控：角色相关数据接口不受 workflow 功能门控限制（既有行为，不新增门控）
- 测试运行方式：`cd apps/server && node --import tsx --test src/routes/<file>.test.ts`（其余包同理 `cd packages/<pkg> && node --import tsx --test <file>`）

---

### Task 1: 数据库 — character.voice_asset_id 列（幂等迁移 + 旧库升级测试）

**Files:**
- Modify: `packages/database/src/schema/production.ts`（productionCharacters 表，约 127 行 voice 列附近）
- Modify: `packages/database/src/client.ts`（migrateSchema 函数内）
- Test: `packages/database/test/session-binding.test.ts`（追加用例）——或新建 `packages/database/test/character-voice-migration.test.ts`

**Interfaces:**
- Produces: `productionCharacters.voiceAssetId: text("voice_asset_id")` 可写；`migrateSchema` 对旧库自动加列（幂等：已存在则跳过）

- [ ] **Step 1: 旧库升级用例先写（测试先行）**

参考 `session-binding.test.ts` 的「旧 schema 工厂」模式，新建 `packages/database/test/character-voice-migration.test.ts`：

```ts
/**
 * character.voice_asset_id 迁移测试（角色面板重构 · 配音音色）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDatabase, type SVHDatabase } from "../src/index";

test("旧 schema 升级：production_characters 无 voice_asset_id 列自动加列（幂等）", () => {
  const dir = mkdtempSync(join(tmpdir(), "svh-char-voice-mig-"));
  const dbPath = join(dir, "test.db");
  const now = Date.now();
  const raw = new Database(dbPath);
  // 最少依赖表（createDatabase 的 INIT_SQL 会对已存在表走幂等建表）
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE production_projects (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
      description TEXT, type TEXT NOT NULL, status TEXT NOT NULL, settings TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE production_characters (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', personality TEXT,
      appearance TEXT NOT NULL DEFAULT '{}', reference_asset_id TEXT,
      visual_profile TEXT, voice TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
      VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
    INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
      VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});
    INSERT INTO production_projects (id, workspace_id, user_id, name, description, type, status, settings, created_at, updated_at)
      VALUES ('prj1','ws1','u1','旧项目',NULL,'short_drama','draft','{}',${now},${now});
    INSERT INTO production_characters (id, project_id, name, description, personality, appearance, reference_asset_id, visual_profile, voice, created_at, updated_at)
      VALUES ('ch1','prj1','小明','测试',NULL,'{}',NULL,NULL,NULL,${now},${now});
  `);
  raw.close();

  const db: SVHDatabase = createDatabase(dbPath);
  try {
    const cols = (db.$client.prepare("PRAGMA table_info(production_characters)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.ok(cols.includes("voice_asset_id"), "旧角色表应自动加 voice_asset_id 列");
    // 幂等：二次启动不再报错（同进程再跑一次 createDatabase，走同一迁移探测）
    const db2: SVHDatabase = createDatabase(dbPath);
    db2.$client.close();
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd packages/database && node --import tsx --test test/character-voice-migration.test.ts`
Expected: FAIL（`voice_asset_id` 列不存在，`cols.includes(...)` 断言失败）

- [ ] **Step 3: schema 加列**

`packages/database/src/schema/production.ts`，`productionCharacters` 表 `voice` 列下追加：

```ts
  /** 角色面板 V0.3.1：配音音色资产引用（已上传/资产库/AI 生成统一为项目 audio 资产） */
  voiceAssetId: text("voice_asset_id"),
```

同时确认 `CharacterRow`/导出类型由 `$inferSelect` 派生（无需手动改）。

- [ ] **Step 4: migrateSchema 加幂等迁移**

`packages/database/src/client.ts` 的 `migrateSchema()` 内（`settings` 迁移之后）：

```ts
  if (!columns("production_characters").includes("voice_asset_id")) {
    sqlite.exec("ALTER TABLE production_characters ADD COLUMN voice_asset_id TEXT;");
  }
```

- [ ] **Step 5: 运行测试**

Run: `cd packages/database && node --import tsx --test test/character-voice-migration.test.ts test/session-binding.test.ts`
Expected: 全部 PASS（新增用例 + 既有迁移用例回归）

- [ ] **Step 6: 提交**

```bash
git add packages/database/src/schema/production.ts packages/database/src/client.ts packages/database/test/character-voice-migration.test.ts
git commit -m "feat(database): production_characters 新增 voice_asset_id 列（幂等迁移）"
```

---

### Task 2: production 包 — Character 类型 + updateCharacter 支持 voiceAssetId（含校验）

**Files:**
- Modify: `packages/production/src/character/character-types.ts`
- Modify: `packages/production/src/character/character.ts`（validate/normalize 所在文件按实际）
- Modify: `packages/production/src/service.ts`（updateCharacter，约 369 行）
- Test: `packages/production/test/character.test.ts`（按既有文件名添加/新建）

**Interfaces:**
- Produces: `Character.voiceAssetId?: string`；`updateCharacter(id, { voiceAssetId?: string|null })` 校验：目标资产存在、`asset.projectId === character.projectId`、`asset.type === "audio"`，否则 `throw validationError("音色资产不合法：必须属于该项目且类型为音频")`；置空用 `voiceAssetId: ""`（通 `? "" : undefined` 清空）——与 referenceAssetId 既有「空串清空」语义一致

- [ ] **Step 1: 先写类型的失败测试**

在 `packages/production/test/character.test.ts`（或新建）追加：

```ts
test("updateCharacter：voiceAssetId 对其它项目/非音频资产抛 VALIDATION", async () => {
  // 项目 A/B 各建资产；把 B 的资产或 image 资产设为 role→A 角色音色 → 抛 /音色资产不合法/
  // 成功路径：同项目 audio 资产 → character.voiceAssetId 写回
});
```

测试基建复用该文件既有的「临时库 + ProductionService」工厂（如有）；无则参考 `packages/production/test/generation-record.test.ts` 的 setup（临时库 + `DrizzleProductionRepository`）。用 `assert.rejects(service.updateCharacter(...), /音色资产不合法/)` 断言失败；成功路径 `assert.equal(updated.voiceAssetId, audioAsset.id)`；空串清空路径 `assert.equal(updated.voiceAssetId, undefined)`。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/production && node --import tsx --test test/character.test.ts`
Expected: FAIL（`voiceAssetId` 类型缺失 / 校验未实现）

- [ ] **Step 3: 类型扩展**

`character-types.ts`：

```ts
export interface Character {
  // ...既有字段
  /** 角色面板：配音音色资产引用（项目 audio 资产 id；空 = 未设置） */
  voiceAssetId?: string;
}

export interface UpdateCharacterInput {
  // ...既有键
  voiceAssetId?: string;
}
```

（`UpdateCharacterInput` 现有形态为 `Partial<Pick<...>>` 联合，把 `"voiceAssetId"` 并入该联合的键集合即可。）

- [ ] **Step 4: service.updateCharacter 实现**

`service.ts` `updateCharacter` 内（`patch.referenceAssetId` 分支后）：

```ts
    if (patch.voiceAssetId !== undefined) {
      const raw = patch.voiceAssetId?.trim() ?? "";
      if (raw === "") {
        next.voiceAssetId = undefined; // 空串清空（与 referenceAssetId 同语义）
      } else {
        const asset = await this.getAsset(raw);
        if (asset.projectId !== (await this.getCharacter(id)).projectId || asset.type !== "audio") {
          throw validationError("音色资产不合法：必须属于该项目且类型为音频");
        }
        next.voiceAssetId = asset.id;
      }
    }
```

- [ ] **Step 5: 运行测试**

Run: `cd packages/production && node --import tsx --test test/character.test.ts`
Expected: PASS（含新增用例；既有用例回归）

- [ ] **Step 6: 提交**

```bash
git add packages/production/src apps/ packages/production/test/character.test.ts
git commit -m "feat(production): Character 支持 voiceAssetId（音色资产引用 + 归属/类型校验）"
```

---

### Task 3: production 包 — listCharacterSchemes / deleteCharacterSchemes

**Files:**
- Modify: `packages/production/src/service.ts`
- Test: `packages/production/test/character.test.ts`（追加）

**Interfaces:**
- Produces:
  - `service.listCharacterSchemes(projectId: string, characterId: string): Promise<{ batchId: string | null; schemes: ProductionAsset[] }>`
    —— `listAssets(projectId, "image")` 后内存过滤 `meta.svhRole === "character_scheme" && meta.characterId === characterId`；按 `batchId` 分组，取 **createdAt 最大批**（批内按 `seq` 升序）；无 → `{ batchId: null, schemes: [] }`
  - `service.deleteCharacterSchemes(characterId: string): Promise<void>` —— 查其全部方案资产并逐条删除（`repo.deleteAsset`；任一失败吞掉继续，不抛）

- [ ] **Step 1: 写失败测试**

```ts
test("listCharacterSchemes：跨批分组取最新批，按 seq 排序；deleteCharacterSchemes 清理", async () => {
  // 构造角色 ch1；批 A：asset A1(seq1)/A2(seq2)；批 B（更新）：B1(seq1)；
  // 期望 { batchId: B, schemes: [B1] }；deleteCharacterSchemes(ch1) 后 schemes 空
});
```

（测试数据用 `service.createAsset` 直接建 image 资产 + `repo.updateAssetFields` 写 metadata 打标：`{ svhRole: "character_scheme", characterId, batchId, seq }`；批 B 的 createdAt 晚于批 A——真实库时间戳毫秒级可能相同，测试里给批 B 的某资产 `updateAssetFields` 前先 `await sleep(5)` 或用直接 SQL 写不同时间戳，稳妥起见在测试中写 `created_at = now + 1000` 的两批。实现用 `repo.updateAssetFields` 不更新时间；如需要可直接用 probe 库 SQL 改时间戳。）

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/production && node --import tsx --test test/character.test.ts`
Expected: FAIL（无该函数）

- [ ] **Step 3: 实现**

`service.ts`（Asset 区，`deleteShot` 之后新增）：

```ts
  // ================= Character 方案（角色面板：形象方案批次） =================

  /** 方案元数据标记（与 worker/server 契约字面量一致） */
  static readonly SCHEME_META_KEY = "svhRole";
  static readonly SCHEME_META_ROLE = "character_scheme";

  /**
   * 角色当前方案批次：metadata 打标 svhRole=character_scheme 且 characterId 匹配的
   * image 资产，按 batchId 分组取「最新批」（批内 seq 升序）。无批次 → batchId=null。
   */
  async listCharacterSchemes(
    projectId: string,
    characterId: string,
  ): Promise<{ batchId: string | null; schemes: ProductionAsset[] }> {
    const assets = await this.listAssets(projectId, "image");
    const tagged = assets.filter((a) => {
      const m = a.metadata ?? {};
      return m.svhRole === "character_scheme" && m.characterId === characterId;
    });
    if (tagged.length === 0) return { batchId: null, schemes: [] };
    const byBatch = new Map<string, ProductionAsset[]>();
    for (const a of tagged) {
      const batchId = String(a.metadata?.batchId ?? "");
      if (!batchId) continue;
      byBatch.set(batchId, [...(byBatch.get(batchId) ?? []), a]);
    }
    const latest = [...byBatch.entries()].sort((x, y) => {
      const ax = Math.max(...x[1].map((a) => a.createdAt.getTime()));
      const ay = Math.max(...y[1].map((a) => a.createdAt.getTime()));
      return ay - ax;
    })[0];
    if (!latest) return { batchId: null, schemes: [] };
    const schemes = latest[1].slice().sort((a, b) => {
      const sa = Number(a.metadata?.seq ?? 0);
      const sb = Number(b.metadata?.seq ?? 0);
      return sa - sb;
    });
    return { batchId: latest[0], schemes };
  }

  /** 删除角色时清理其全部方案资产（逐条删除；失败不阻断，残留可接受） */
  async deleteCharacterSchemes(characterId: string): Promise<void> {
    // 角色所属项目：经角色反查
    const character = await this.getCharacter(characterId);
    const { schemes } = await this.listCharacterSchemes(character.projectId, characterId);
    for (const s of schemes) {
      try {
        await this.repo.deleteAsset(s.id);
      } catch {
        /* 单条失败不阻断 */
      }
    }
  }
```

（若 `metadata` 在 `ProductionAsset` 类型中为 `Record<string, unknown> | null | undefined`，`a.metadata?.svhRole` 直接可读；若不可读先 `as Record<string, unknown>`。）

- [ ] **Step 4: 运行测试**

Run: `cd packages/production && node --import tsx --test test/character.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/production/src/service.ts packages/production/test/character.test.ts
git commit -m "feat(production): 角色方案批次查询/清理（listCharacterSchemes/deleteCharacterSchemes）"
```

---

### Task 4: worker — TaskPayload.transferMeta 落资产 metadata

**Files:**
- Modify: `apps/worker/src/queue.ts`（TaskPayload，voice 字段后）
- Modify: `apps/worker/src/handlers.ts`（runImageTask createAsset 调用，约 474 行）
- Test: `apps/worker/test/handlers.test.ts`（追加）

**Interfaces:**
- Consumes: server 侧 `TaskPayload.transferMeta?: Record<string, unknown>`（Task 5 产出；本任务先按契约手写字面量实现）
- Produces: image 资产 `metadata` = `{ ...(b64Json ? { b64Json } : {}), ...(p.transferMeta ?? {}) }`

- [ ] **Step 1: 写失败测试（追加到 handlers.test.ts）**

按该文件既有模式（fake provider + 临时库 + `runTask` 或直接 `runImageTask`），用例：

```ts
test("runImageTask：payload.transferMeta 合并进资产 metadata", async () => {
  // provider 返回 { images: [{ url: ... }] }；payload 含 transferMeta:
  //   { svhRole: "character_scheme", characterId: "ch1", batchId: "b1", seq: 1 }
  // 断言 production.getAsset(assetId).metadata 包含上述 4 键；
  // 再断言「无 transferMeta 的 payload」→ metadata 无该角色标记（回归不变）
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/worker && node --import tsx --test test/handlers.test.ts`
Expected: FAIL（payload 类型无 transferMeta / metadata 未合并）

- [ ] **Step 3: queue.ts 类型**

```ts
  /**
   * 角色面板方案打标（server 端填）：合并进资产 metadata
   *（svhRole=character_scheme / characterId / batchId / seq）。
   */
  transferMeta?: Record<string, unknown>;
```

- [ ] **Step 4: handlers.ts 合并**

`runImageTask` 内：

```ts
  const asset = await production.createAsset({
    projectId: task.projectId,
    type: "image",
    name: p.assetName,
    url: first.url,
    mimeType: "image/png",
    metadata: { ...(first.b64Json ? { b64Json: first.b64Json } : {}), ...(p.transferMeta ?? {}) },
    generation: { providerId: p.providerId, modelId: p.model, prompt: finalPrompt, taskId: task.id },
  });
```

（仅 image 任务；audio/video 不接此字段。）

- [ ] **Step 5: 运行测试**

Run: `cd apps/worker && node --import tsx --test test/handlers.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/worker/src/queue.ts apps/worker/src/handlers.ts apps/worker/test/handlers.test.ts
git commit -m "feat(worker): 生成任务 transferMeta 合并进资产 metadata（角色方案打标）"
```

---

### Task 5: server — GenerationService 支持 characterMeta（方案打标入队）

**Files:**
- Modify: `apps/server/src/modules/production/generation-service.ts`（TaskPayload + enqueueImage 入参）
- Test: `apps/server/src/modules/production/generation-service.test.ts`（追加）

**Interfaces:**
- Produces: `enqueueImage(input: { ..., characterMeta?: { characterId: string; batchId: string; seq: number } })`
  → payload 写入 `transferMeta: { svhRole: "character_scheme", characterId, batchId, seq }`
- Consumes: Task 4 的 worker 侧 `transferMeta`（契约同步注释）

- [ ] **Step 1: 写失败测试**

`generation-service.test.ts` 追加（复用其既有「临时库 + 探针读 payload」基建）：

```ts
test("enqueueImage：characterMeta → payload.transferMeta 落库（角色方案打标）", async () => {
  const view = await generation.enqueueImage({
    projectId, userId, prompt: "方案", characterMeta: { characterId: "ch1", batchId: "b1", seq: 2 },
  });
  const row = probe.select().from(tasksTable).where(eq(tasksTable.id, view.id)).get();
  const payload = JSON.parse(row!.payload) as { transferMeta?: Record<string, unknown> };
  assert.deepEqual(payload.transferMeta, {
    svhRole: "character_scheme", characterId: "ch1", batchId: "b1", seq: 2,
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && node --import tsx --test src/modules/production/generation-service.test.ts`
Expected: FAIL（类型/字段缺失）

- [ ] **Step 3: 实现**

`generation-service.ts`：

1. 模块顶部定义常量（与 production/service.ts 的字面量同构，注明「与 @svh/production SCHEME_META_* 手写同步」）：

```ts
/** 角色方案打标（metadata 角色键；与 production.service 字面量同步） */
const SCHEME_ROLE = "character_scheme";
```

2. `TaskPayload` 增加：

```ts
  /** 角色面板方案打标（worker 合并进资产 metadata） */
  transferMeta?: Record<string, unknown>;
```

3. `enqueueImage` 入参增加 `characterMeta?: { characterId: string; batchId: string; seq: number }`；
   payload 组装处（`assetLibrary` 之后）增加：

```ts
    if (input.characterMeta) {
      payload.transferMeta = {
        svhRole: SCHEME_ROLE,
        characterId: input.characterMeta.characterId,
        batchId: input.characterMeta.batchId,
        seq: input.characterMeta.seq,
      };
    }
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && node --import tsx --test src/modules/production/generation-service.test.ts`
Expected: PASS（含新增；既有 payload 字段断言回归）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/production/generation-service.ts apps/server/src/modules/production/generation-service.test.ts
git commit -m "feat(server): 生成入队支持 characterMeta（角色方案批次打标）"
```

---

### Task 6: server 路由 — schemes 生成/列表端点 + PATCH voiceAssetId + 删除清理

**Files:**
- Modify: `apps/server/src/routes/production.ts`（characters 段，约 234–302 行）
- Test: 新建 `apps/server/src/routes/production.schemes.test.ts`

**Interfaces:**
- Consumes: Task 2/3/5 的服务能力；`deriveCharacterPromptAnchor`（`@svh/production` 导出）
- Produces:
  - `POST /api/projects/:projectId/characters/:characterId/schemes` body `{ count?: number }` → `{ taskIds, batchId, total }`
  - `GET /api/projects/:projectId/characters/:characterId/schemes` → `{ batchId, schemes }`
  - `PATCH /api/characters/:id` body 支持 `voiceAssetId?: string`
  - `DELETE /api/characters/:id` → 先删方案资产再删角色

- [ ] **Step 1: 写失败测试**

新建 `apps/server/src/routes/production.schemes.test.ts`，骨架复用 `production.generation.test.ts`（temp 配置 + `buildApp` + probe）：

```ts
// 前置：register 用户 A/B；A 建项目、建角色 ch1；A 配 volcengine key（PUT /api/settings）
test("schemes 生成：count=3 → 200 { taskIds(3), batchId, total:3 }；DB payload 带 transferMeta", async () => {
  const res = await call("POST", `/api/projects/${projectId}/characters/ch1/schemes`, {
    token: tokenA, body: { count: 3 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { taskIds: string[]; batchId: string; total: number };
  assert.equal(body.taskIds.length, 3);
  assert.ok(body.batchId);
  // probe 读三条任务 payload：transferMeta.svhRole === "character_scheme"、batchId 相同、seq 1..3
});
test("schemes 生成：count 越界(0/7) → 400；跨用户 → 404；角色不存在 → 404", async () => { ... });
test("schemes 列表：空 → { batchId:null, schemes:[] }；有批次 → 最新批 + seq 排序", async () => {
  // 直接 probe 插生产任务并用 worker？——不启 worker。改用直接 service 造批次：
  // 简单起见：通过 probe 直接向 production_assets 插 image 行（metadata JSON 打标两批），
  // 再 GET schemes 断言只返回最新批、seq 升序。
});
test("PATCH voiceAssetId：同项目 audio 资产 → 200 且回读 voiceAssetId；image 资产 → 400", async () => { ... });
test("DELETE 角色：删除后其方案资产一并清理（probe 断言 production_assets 无该角色打标行）", async () => { ... });
```

（probe 直插资产行：`INSERT INTO production_assets(id, project_id, workspace_id, user_id, type, name, metadata, created_at, updated_at) VALUES (...)` —— 列名以 schema 为准；或调用 `productionApi` 等价服务方法经 `buildApp` 内 service 不可得时，用 `createDatabase(同一库)` 的第二个连接 + `DrizzleProductionRepository` 构造 `ProductionService` 造数。）

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && node --import tsx --test src/routes/production.schemes.test.ts`
Expected: FAIL（路由 404）

- [ ] **Step 3: 实现路由**

`production.ts` characters 段追加（放在 GET/POST characters 列表之后）：

```ts
  // ---- 角色形象方案（角色面板：生成批次 / 查询当前批次） ----
  const SCHEME_MAX_COUNT = 6;
  app.post<{ Params: { projectId: string; characterId: string }; Body: { count?: number } }>(
    "/api/projects/:projectId/characters/:characterId/schemes",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      const count = req.body?.count ?? 3;
      if (!Number.isInteger(count) || count < 1 || count > SCHEME_MAX_COUNT) {
        throw ERRORS.INVALID_INPUT("count 必须为 1~6 的整数");
      }
      const character = await deps.production.getCharacter(req.params.characterId);
      if (character.projectId !== req.params.projectId) throw new ServerError("NOT_FOUND", "角色不存在", 404);
      const batchId = randomId("");
      const anchor = deriveCharacterPromptAnchor(character);
      const prompt = `${character.name}，${anchor || character.description || "人物形象"}`;
      const taskIds: string[] = [];
      for (let seq = 1; seq <= count; seq++) {
        const task = await deps.generationService.enqueueImage({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          prompt,
          assetName: `${character.name} 形象方案${seq}`,
          characterMeta: { characterId: character.id, batchId, seq },
        });
        taskIds.push(task.id);
      }
      return { taskIds, batchId, total: taskIds.length };
    },
  );
  app.get<{ Params: { projectId: string; characterId: string } }>(
    "/api/projects/:projectId/characters/:characterId/schemes",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      const character = await deps.production.getCharacter(req.params.characterId);
      if (character.projectId !== req.params.projectId) throw new ServerError("NOT_FOUND", "角色不存在", 404);
      return deps.production.listCharacterSchemes(req.params.projectId, req.params.characterId);
    },
  );
```

（`randomId` 从 `@svh/shared` 导入（`production.ts` 当前未导入，需新增）；`deriveCharacterPromptAnchor` 从 `@svh/production` 导入。404 用既有 `ServerError("NOT_FOUND", ...)` 工厂形态——`lib/errors.ts` 无 `ERRORS.NOT_FOUND()`，与现有路径一致。）

`PATCH /api/characters/:id` 的 Body 与 `updateCharacter` 调用增加 `voiceAssetId`（Body 类型加 `voiceAssetId?: string;`，传给 service）。

`DELETE /api/characters/:id` 改为：

```ts
  app.delete<{ Params: { id: string } }>("/api/characters/:id", async (req) => {
    const character = await deps.production.getCharacter(req.params.id);
    await ownedProjectOf(character.projectId, req.user!.userId);
    await deps.production.deleteCharacterSchemes(req.params.id);
    await deps.production.deleteCharacter(req.params.id);
    return { ok: true };
  });
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && node --import tsx --test src/routes/production.schemes.test.ts src/routes/production.crud.test.ts`
Expected: PASS（新增 4 用例 + 角色 CRUD 回归）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/production.ts apps/server/src/routes/production.schemes.test.ts
git commit -m "feat(server): 角色方案生成/列表端点 + voiceAssetId 更新 + 删除清理方案资产"
```

---

### Task 7: server 路由 — 音色二进制上传（raw body）

**Files:**
- Modify: `apps/server/src/routes/production.ts`（或新建 `apps/server/src/routes/audio-upload.ts` 由 app.ts 挂载——推荐前者，复用 deps）
- Test: `apps/server/src/routes/production.schemes.test.ts` 追加

**Interfaces:**
- Produces: `POST /api/projects/:projectId/assets/audio-upload?name=<urlencoded>&mimeType=<audio/...>`
  → `200 { asset }`；白名单：`audio/mpeg, audio/wav, audio/mp4`；>50MB → 413；越权 → 404

- [ ] **Step 1: 写失败测试（追加到 schemes 测试文件）**

```ts
test("audio-upload：mp3 二进制 → 200，asset.type=audio 且 workspacePath ready；text/plain → 400；无权限 → 404", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/assets/audio-upload?name=${encodeURIComponent("旁白.mp3")}&mimeType=${encodeURIComponent("audio/mpeg")}`,
    headers: { authorization: `Bearer ${tokenA}`, "content-type": "audio/mpeg" },
    payload: Buffer.from("ID3FAKEBYTES"),
  });
  assert.equal(res.statusCode, 200);
  const { asset } = res.json() as { asset: { id: string; type: string; workspacePath: string | null } };
  assert.equal(asset.type, "audio");
  assert.ok(asset.workspacePath, "上传音频应已 ready（workspacePath 非空）");
  // 白名单外
  const bad = await app.inject({ method: "POST", url: `...audio-upload?...mimeType=${encodeURIComponent("text/plain")}`, headers: { authorization: `Bearer ${tokenA}`, "content-type": "text/plain" }, payload: Buffer.from("x") });
  assert.equal(bad.statusCode, 400);
  // 越权（B 用户）
  const foreign = await app.inject({ ..., headers: { authorization: `Bearer ${tokenB}`, ... } });
  assert.equal(foreign.statusCode, 404);
});
```

- [ ] **Step 2: 运行确认失败**（同上命令，预期新增用例 FAIL 404）

- [ ] **Step 3: 实现**

`production.ts` 顶部导入：`import { createWriteStream } from "node:fs"; import { mkdir } from "node:fs/promises";`（`resolveSafeWorkspacePath` 已导入；`LOCALIZE_DIR_PREFIX, LOCALIZE_METADATA_KEY` 从 `@svh/production` 导入）。deps 已含 `workspaceRoot`。

1) app.ts 注册（`registerProductionRoutes` 之前或 app.buildApp 内对应位置）raw 解析器——注意 raw 解析器是 Fastify 层面的，注册一次：

```ts
  // 音色二进制上传（chat 面板：audio/mpeg|wav|mp4 走 raw body，限 50MB）
  for (const type of ["audio/mpeg", "audio/wav", "audio/mp4"]) {
    app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => {
      done(null, body);
    });
  }
```

2) 路由（`assets/generate-audio` 段附近）：

```ts
  // ---- 音色二进制上传（角色面板「已上传」；raw body，白名单 + 大小上限） ----
  app.post<{ Params: { projectId: string }; Querystring: { name?: string; mimeType?: string } }>(
    "/api/projects/:projectId/assets/audio-upload",
    async (req) => {
      await assertProjectOwned(req.params.projectId, req.user!.userId);
      const mimeType = req.query.mimeType ?? "";
      if (!["audio/mpeg", "audio/wav", "audio/mp4"].includes(mimeType)) {
        throw ERRORS.INVALID_INPUT("仅支持 mp3 / wav / m4a 音频文件");
      }
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw ERRORS.INVALID_INPUT("音频内容不能为空");
      }
      const project = await deps.production.getProject(req.params.projectId);
      const workspaceId = project.workspaceId;
      const ext = mimeType === "audio/wav" ? "wav" : mimeType === "audio/mp4" ? "m4a" : "mp3";
      const assetId = randomId("ast_");
      const relativePath = `${LOCALIZE_DIR_PREFIX}${assetId}.${ext}`;
      const abs = resolveSafeWorkspacePath(
        path.join(deps.workspaceRoot!, workspaceId),
        relativePath,
      );
      await mkdir(path.dirname(abs), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(abs);
        ws.on("finish", resolve);
        ws.on("error", reject);
        ws.end(body);
      });
      const name = decodeURIComponent(req.query.name ?? "上传音色");
      const asset = await deps.production.createAsset({
        projectId: req.params.projectId,
        type: "audio",
        name,
        mimeType,
        workspacePath: relativePath,
        metadata: { [LOCALIZE_METADATA_KEY]: { state: "ready", bytes: body.length, at: new Date().toISOString() } },
      });
      return { asset };
    },
  );
```

（若 `deps.workspaceRoot` 可能为空则先判空 400/500；`path` 已在 production.ts 导入。）

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && node --import tsx --test src/routes/production.schemes.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/production.ts apps/server/src/app.ts apps/server/src/routes/production.schemes.test.ts
git commit -m "feat(server): 音色二进制上传端点（raw body 白名单 + 大小上限）"
```

---

### Task 8: web — API 层与类型（schemes / voiceAssetId / audio-upload）

**Files:**
- Modify: `apps/web/src/types/production-types.ts`（Character 增加 voiceAssetId）
- Modify: `apps/web/src/api/production.ts`（schemes API、updateCharacter body 类型、audioUpload）

**Interfaces:**
- Produces:
  - `productionApi.listCharacterSchemes(projectId, characterId)` → `{ batchId, schemes: ProductionAsset[] }`
  - `productionApi.generateCharacterSchemes(projectId, characterId, count)` → `{ taskIds, batchId, total }`
  - `productionApi.uploadAudioAsset(projectId, name, mimeType, blob)` → `{ asset }`
  - `productionApi.updateCharacter` body 增加 `voiceAssetId?`

- [ ] **Step 1: 类型**

`production-types.ts` `Character` 接口追加：

```ts
  /** 配音音色资产引用（项目 audio 资产 id；空 = 未设置） */
  voiceAssetId?: string;
```

- [ ] **Step 2: API 方法**

`api/production.ts`：

```ts
  /** 角色方案（形象方案批次） */
  listCharacterSchemes: (projectId: string, characterId: string) =>
    get<{ batchId: string | null; schemes: ProductionAsset[] }>(
      `/api/projects/${enc(projectId)}/characters/${enc(characterId)}/schemes`,
    ),
  generateCharacterSchemes: (projectId: string, characterId: string, count: number) =>
    post<{ taskIds: string[]; batchId: string; total: number }>(
      `/api/projects/${enc(projectId)}/characters/${enc(characterId)}/schemes`,
      { count },
    ),
  /** 音色二进制上传（raw body；Content-Type 由 fetch 自动按 Blob type 设置） */
  uploadAudioAsset: (projectId: string, input: { name: string; mimeType: string; data: Blob }) =>
    fetch(apiUrl(`/api/projects/${enc(projectId)}/assets/audio-upload?name=${enc(input.name)}&mimeType=${enc(input.mimeType)}`), {
      method: "POST",
      headers: { Authorization: `Bearer ${getAuthToken() ?? ""}` },
      body: input.data,
    }).then(async (r) => {
      if (!r.ok) throw await parseError(r);
      return (await r.json()) as { asset: ProductionAsset };
    }),
```

（`enc`/`apiUrl`/`getAuthToken` 已在 client.ts 导出；`parseError` 当前是 client.ts 模块私有函数——本任务需在 `apps/web/src/api/client.ts` 给它加 `export`，供 uploadAudioAsset 复用同一错误解析。）

`updateCharacter` 入参类型加 `voiceAssetId?: string`（其 body 透传）。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @svh/web typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/types/production-types.ts apps/web/src/api/production.ts apps/web/src/api/client.ts
git commit -m "feat(web): 角色方案/音色上传 API 与类型"
```

---

### Task 9: web — CharacterWorkspacePanel 重做（角色页签）

**Files:**
- Modify: `apps/web/src/features/production/panels.tsx`（替换 `CharactersPanel`，约 380–663 行；保留既有 `CharacterCard` 可移除）
- Modify: `apps/web/src/components/...`（若新建可复用组件则按项目习惯放 features/production/ 下）
- Test: 无单测（web 无测试基建）；以 typecheck/lint + 浏览器冒烟（Task 10）收口

**Interfaces:**
- Consumes: Task 8 API；`assetLibraryRawUrl`/`assetLibrarySrc`/`assetLocalSrc`（已有）；`productionApi.createAsset`（assetLibPath 导入）
- Produces: 替换后的「角色」页签交互（切换器 / 形象卡 / 音色卡 / 三来源弹窗 / 编辑弹窗保留）

- [ ] **Step 1: 组件骨架与状态**

新建 `CharacterWorkspacePanel({ projectId })`（文件内定位：`panels.tsx` 中替换 `CharactersPanel` 导出函数体；若文件过大按项目模式拆到 `features/production/character-workspace.tsx` 再由 panels.tsx 引入）：

```
状态：
  characters (useQuery)
  activeCharacterId（默认第一个角色）
  schemes: { batchId, schemes } | null（按 activeCharacterId useQuery）
  schemeTasks: taskIds → 轮询（复用 AssetsPanel 的任务追踪模式：排队/生成中%/完成/失败原因）
  voiceState: { assetId?, name } | null
  modals: create / import library / voice-upload / voice-library / voice-ai / edit
```

- [ ] **Step 2: 角色切换器 + 详情头**

顶部横向滚动标签（active 高亮）+「+ 新建角色」（弹窗沿用既有 `createCharacter` 表单字段）；
详情头：主形象缩略图（`assetLibrarySrc`/`assetLocalSrc` 复用；无则占位图标）+ 名称 + `N个形象`（N=最新批方案数）+ 按钮组：`从资产中心导入`（LibraryPickModal：cascader 文件夹→类型→文件，选中文件 → `createAsset({ type:"image", assetLibPath })` → `updateCharacter({ referenceAssetId })`）/ `编辑角色`（保留既有编辑弹窗内容，另加只读「当前音色」行）/ `删除角色`（Modal.confirm 提示会删除方案图 → `deleteCharacter` → 刷新与切换器）

- [ ] **Step 3: 形象卡（SchemeCard）**

```
空态： 「还没有形象」+ 数量选择器（1~6 默认 3）+ [生成形象]（primary）
有批次： 标签行【初始形象】（灰）/ 已选时【主形象】（绿）；
        提示「请选择一张图片」/「已选择主形象，可重新生成」；
        方案网格：grid auto-fill minmax(150px,1fr)，卡 = 缩略图 + 右下「方案n」
        + 右上 ✓（referenceAssetId === scheme.id）→ 点击 = updateCharacter({ referenceAssetId })
        + 底部 caption「选择并确认后，可对图片进行编辑和修改」
        + [重新生成]（confirm → generateCharacterSchemes(count) → 任务追踪 → 完成后 invalidate schemes）
任务追踪条：schemes 任务进行中时显示（进度徽标/失败原因），全部终态自动刷新
```

- [ ] **Step 4: 音色卡（VoiceCard）**

```
空态： 「配音音色」+ 绿点(已选)灰点(未选)；[已上传] [资产库] [AI智能设计] 三按钮
已选： 音色名 + [试听音色]（<audio> 播放/暂停切换；本地源 assetLocalSrc(asset) 优先，
        资产库引用 assetLibrarySrc；均无禁用并提示）+ [更换]（重新打开三来源）
已上传：UploadModal → uploadAudioAsset(projectId, { name, mimeType, data }) → updateCharacter({ voiceAssetId })
资产库：cascader（文件夹→音色→文件）→ createAsset({ type:"audio", assetLibPath }) → updateCharacter({ voiceAssetId })
AI 智能设计：试听文本（缺省角色描述/默认文案）+ 风格（复用 VOICE_OPTS 预设）+ [生成并试听]
        → `productionApi.generateAudio(projectId, { prompt: 试听文本, voice: 所选预设 })`
          （该 API 已存在：`apps/web/src/api/production.ts:229`，返回 `{ task }`）
        → productionApi.getTask 轮询至 completed → 取 audio 资产（schemes 同批处理思路：
          音频任务完成回写资产后，通过 `listAssets(projectId, "audio")` 按 generation.taskId
          反查产物，或直接用任务轮询返回后刷新资产列表按时间最新取一条 → 建议先断言
          有且仅一条无 voiceAssetId 关联的待选 audio 资产，从中取）→
          `updateCharacter({ voiceAssetId })` → 未取得产物时提示「生成完成但未取到音频，请重试」
```

- [ ] **Step 5: 移动端适配**

切换器横滚（hide-scrollbar）、方案网格 2 列、三弹窗 `width={Math.min(560, window.innerWidth - 24)}`、按钮不溢出（flex-wrap）。

- [ ] **Step 6: 验证**

Run:
```bash
pnpm --filter @svh/web typecheck
pnpm exec eslint apps/web/src/features/production/panels.tsx
```
Expected: PASS（无错误）

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/production/panels.tsx apps/web/src/features/production/character-workspace.tsx
git commit -m "feat(web): 角色页签重构——形象方案选主形象 + 配音音色三来源/试听"
```

---

### Task 10: 端到端验证与文档

**Files:**
- Modify: `docs/svh-v0.3-summary.md` / `docs/usage-guide.md`（角色面板段落更新，选一即可）
- Test: 手工冒烟清单（下方）

- [ ] **Step 1: 全量校验**

```bash
pnpm -r --workspace-concurrency=1 run typecheck
pnpm exec eslint apps packages
```

- [ ] **Step 2: 相关单测集合跑通（需询问用户后执行）**

```bash
cd packages/database && node --import tsx --test test/character-voice-migration.test.ts test/session-binding.test.ts
cd packages/production && node --import tsx --test test/character.test.ts
cd apps/worker && node --import tsx --test test/handlers.test.ts
cd apps/server && node --import tsx --test src/modules/production/generation-service.test.ts src/routes/production.schemes.test.ts
```

- [ ] **Step 3: 浏览器冒烟（服务已运行）**

1. 制作中心 → 打开项目 → 「角色」页签：切换器显示既有角色
2. 新建角色 小美 → 详情自动显示 → 空态「生成形象」（选 3）→ 任务进度 → 3 张方案出现
3. 点方案2 → ✓ 主形象 → 刷新后保持选中、方案区显示「已选择主形象」
4. 重新生成（数量 4）→ 新批次替换展示、旧批次消失
5. 从资产中心导入一张图 → 主形象立即替换
6. 音色：AI智能设计 → 试听文本+风格 → 生成 → 试听播放；资产库 → 选音色文件 → 选定；已上传 → 上传 mp3 → 试听
7. 编辑角色（视觉档案）仍可用；删除角色 → 方案图一并清理（资产面板数量减少）
8. 移动端（375px 宽）：网格 2 列、无横向溢出

- [ ] **Step 4: 文档更新**

`docs/svh-v0.3-summary.md` 增加一段「角色面板（方案+音色）」说明：方案=项目 image 资产 metadata 打标、主形象=referenceAssetId、音色=voice_asset_id 三来源、新增端点列表。

- [ ] **Step 5: 提交**

```bash
git add docs/
git commit -m "docs(production): 角色面板重构说明与使用文档更新"
```

---

## 验收对照（spec §7 测试矩阵 → 任务）

| spec 用例 | 任务 |
|---|---|
| voiceAssetId 校验（非本项目/非 audio → 400） | Task 2 |
| schemes 批次分组/seq 排序/空批次 | Task 3（service）+ Task 6（路由） |
| schemes count 越界 400 / 越权 404 / 成功 taskIds+batchId + payload.characterMeta | Task 5 + 6 |
| audio-upload 白名单 400 / 越权 404 / 成功 ready / 超大（413 探针待实现验证） | Task 7 |
| PATCH voiceAssetId 成功/校验失败 | Task 2 + 6 |
| worker transferMeta 合并 / 无标记回归 | Task 4 |
| web 交互冒烟（8 项） | Task 9 + 10 |

> 注：spec 中「→ 413 超大」用例在 Task 7 Step 3 中通过 bodyLimit 实现；如 Fastify 在测试注入下不触发 413（封装层返回 400），在测试中以「白名单外 400 + 成功路径」为准并记录差异到 spec 已知限制。
