# 技能模块（Skills）V1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增内置技能（剧本拆解/分镜脚本），会话输入栏可选择技能与模型，技能按自身参数执行单轮文本模型调用并以结果卡片展示，技能消息与普通对话上下文隔离。

**Architecture:** 技能为服务端代码内置注册表（无 DB 表、无管理界面）。技能执行复用现有 OpenAI 兼容 Provider 与 SSE 事件协议（message.started/delta/completed + run.completed/error），消息写入现有 `messages` 表并以 `metadata.skill` 标记；ContextBuilder 跳过带该标记的消息实现隔离。前端输入栏新增技能 Select + 模型 Select + 内联参数控件行，结果以 `SkillResultCard` 展示（文本复制/下载 .md，媒体类型为 V2 预留）。

**Tech Stack:** Fastify / tsx / drizzle（现状），React + antd + @tanstack/react-query（现状），node:test（`node --import tsx --test` 运行，新增单元测试不引入框架）。

**Spec:** `docs/superpowers/specs/2026-09-06-skills-module-design.md`

## Global Constraints

- 所有代码注释使用简体中文。
- 不改数据库 schema（零新增表），仅扩展 `messages.metadata` 字段。
- 模型调用只允许 OpenAI 兼容 chat（V1 文本技能）。
- 技能消息隔离：ContextBuilder 跳过带 `metadata.skill` 的消息。
- 会员门禁沿用 `assertFeature(userId, "agent.basic")`。
- 错误统一用 `ERRORS.INVALID_INPUT(msg)`（400）。
- 提交前必须通过：`pnpm typecheck`、`pnpm lint`、`pnpm build`（web）。
- 提交信息中文，格式 `type(scope): 描述`。
- 单元测试文件放独立 `.test.ts` 文件（同目录），运行方式 `node --import tsx --test <file>`。

---

### Task 1: 内置技能定义模块 + 单元测试

**Files:**
- Create: `apps/server/src/modules/skills/definitions.ts`
- Test: `apps/server/src/modules/skills/definitions.test.ts`

**Interfaces:**
- Consumes: `ModelType`（来自 `../settings/model-catalog`）、`ERRORS`（`../../lib/errors`）。
- Produces:
  - `type SkillParamType = "text" | "textarea" | "number" | "select"`
  - `interface SkillParamDef { key; label; type: SkillParamType; primary?: boolean; required?: boolean; placeholder?: string; options?: Array<{label; value}>; default?: string|number }`
  - `type SkillResultKind = "text" | "image" | "video" | "audio"`
  - `interface SkillDefinition { id; name; description; modelTypes: ModelType[]; params: SkillParamDef[]; systemPrompt?: string; promptTemplate: string; resultKind: SkillResultKind }`
  - `interface SkillPublicView { id; name; description; modelTypes: ModelType[]; params: SkillParamDef[]; resultKind: SkillResultKind }`
  - `const BUILTIN_SKILLS: SkillDefinition[]`
  - `getSkillById(id: string): SkillDefinition | undefined`
  - `listSkillPublicViews(): SkillPublicView[]`
  - `validateSkillParams(skill: SkillDefinition, raw: Record<string, unknown>): Record<string, string | number>`（校验失败抛 `ERRORS.INVALID_INPUT`）
  - `renderSkillPrompt(skill: SkillDefinition, params: Record<string, string|number>): string`

- [ ] **Step 1: 写失败测试** — 创建 `apps/server/src/modules/skills/definitions.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKILLS, getSkillById, listSkillPublicViews, validateSkillParams, renderSkillPrompt } from "./definitions";

test("内置技能包含剧本拆解与分镜脚本，且各有一个 primary 参数", () => {
  assert.ok(getSkillById("script-breakdown"), "缺少剧本拆解");
  assert.ok(getSkillById("storyboard"), "缺少分镜脚本");
  for (const s of BUILTIN_SKILLS) {
    const primaries = s.params.filter((p) => p.primary);
    assert.equal(primaries.length, 1, `${s.id} 应有且仅有一个主参数`);
  }
});

test("公开视图不包含提示词模板", () => {
  const views = listSkillPublicViews();
  assert.equal(views.length, BUILTIN_SKILLS.length);
  for (const v of views) {
    assert.ok(!("systemPrompt" in v));
    assert.ok(!("promptTemplate" in v));
  }
});

test("参数校验：必填缺失 / 未知键 / 非法枚举被拒绝", () => {
  const skill = getSkillById("script-breakdown")!;
  assert.throws(() => validateSkillParams(skill, {}), /原始文本/);
  assert.throws(() => validateSkillParams(skill, { source_text: "x", unknown: 1 }), /未知参数/);
  assert.throws(
    () => validateSkillParams(skill, { source_text: "x", format: "not-exist" }),
    /格式/, // 非法枚举值
  );
});

test("参数校验：数字参数转换，缺省值生效", () => {
  const skill = getSkillById("script-breakdown")!;
  const out = validateSkillParams(skill, { source_text: "故事…", episodes: "10" });
  assert.equal(out.episodes, 10);
});

test("提示词渲染：占位符全部替换", () => {
  const skill = getSkillById("script-breakdown")!;
  const prompt = renderSkillPrompt(skill, { source_text: "S", episodes: 5, format: "script" });
  assert.ok(!prompt.includes("{{") && prompt.includes("S"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/server && node --import tsx --test src/modules/skills/definitions.test.ts`
Expected: 报 `Cannot find module './definitions'`（FAIL）。

- [ ] **Step 3: 实现 definitions.ts**

```ts
import { ERRORS } from "../../lib/errors";
import type { ModelType } from "../settings/model-catalog";

export type SkillParamType = "text" | "textarea" | "number" | "select";

/** 技能输入参数定义 */
export interface SkillParamDef {
  key: string;                         // 参数键（{{key}} 占位 / 校验用）
  label: string;                       // 中文标签
  type: SkillParamType;
  /** 主文本参数：输入栏直接输入（type 须为 text/textarea） */
  primary?: boolean;
  required?: boolean;
  placeholder?: string;
  /** select 专用选项 */
  options?: Array<{ label: string; value: string }>;
  default?: string | number;
}

/** 技能结果展示类型（V1 全 text，媒体为 V2 预留） */
export type SkillResultKind = "text" | "image" | "video" | "audio";

/** 完整技能定义（仅服务端内部使用，模板不下发前端） */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  /** 允许调用的模型类型（服务端严格校验） */
  modelTypes: ModelType[];
  params: SkillParamDef[];
  systemPrompt?: string;
  /** 用户消息模板，{{key}} 占位 */
  promptTemplate: string;
  resultKind: SkillResultKind;
}

/** 前端可见的技能视图（不含提示词模板） */
export interface SkillPublicView {
  id: string;
  name: string;
  description: string;
  modelTypes: ModelType[];
  params: SkillParamDef[];
  resultKind: SkillResultKind;
}

/** V1 内置技能注册表（无管理界面，代码维护） */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "script-breakdown",
    name: "剧本拆解",
    description: "将一段文字拆解为短剧剧本",
    modelTypes: ["text"],
    resultKind: "text",
    params: [
      { key: "source_text", label: "原始文本", type: "textarea", primary: true, required: true, placeholder: "粘贴要拆解的原始文本…" },
      { key: "episodes", label: "集数", type: "number", default: 5 },
      {
        key: "format",
        label: "输出格式",
        type: "select",
        default: "script",
        options: [
          { label: "短剧剧本", value: "script" },
          { label: "分镜大纲", value: "outline" },
        ],
      },
    ],
    systemPrompt: "你是资深短剧编剧，擅长将长篇内容拆解为结构清晰、节奏紧凑的短剧剧本。",
    promptTemplate: [
      "请将以下原始文本拆解为短剧剧本：",
      "",
      "{{source_text}}",
      "",
      "要求：",
      "1. 拆分为 {{episodes}} 集，每集有清晰的开端、冲突、转折与结尾。",
      "2. 保留原文核心剧情与人物关系，可适当增补对话。",
      "3. 输出格式：{{format}}。",
    ].join("\n"),
  },
  {
    id: "storyboard",
    name: "分镜脚本",
    description: "将剧本文本拆解为分镜脚本",
    modelTypes: ["text"],
    resultKind: "text",
    params: [
      { key: "script_text", label: "剧本文本", type: "textarea", primary: true, required: true, placeholder: "粘贴剧本文本…" },
      { key: "shots", label: "镜头数量", type: "number", default: 8 },
    ],
    systemPrompt: "你是影视分镜师，负责将剧本转化为可拍摄的分镜脚本。",
    promptTemplate: [
      "请将以下剧本文本拆解为分镜脚本：",
      "",
      "{{script_text}}",
      "",
      "要求：",
      "1. 输出约 {{shots}} 个镜头。",
      "2. 每个镜头包含：镜号、景别、画面内容、台词、时长。",
      "3. 使用表格形式输出。",
    ].join("\n"),
  },
];

export function getSkillById(id: string): SkillDefinition | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}

export function listSkillPublicViews(): SkillPublicView[] {
  return BUILTIN_SKILLS.map(({ id, name, description, modelTypes, params, resultKind }) => ({
    id, name, description, modelTypes, params, resultKind,
  }));
}

/**
 * 校验并规范化技能参数：
 * - 未知键拒绝；必填缺失拒绝；number 转数值；select 必须命中枚举。
 */
export function validateSkillParams(
  skill: SkillDefinition,
  raw: Record<string, unknown>,
): Record<string, string | number> {
  const known = new Map(skill.params.map((p) => [p.key, p]));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw ERRORS.INVALID_INPUT(`技能「${skill.name}」未知参数：${key}`);
    }
  }

  const out: Record<string, string | number> = {};
  for (const def of skill.params) {
    const rawValue = raw[def.key];
    if (rawValue === undefined || rawValue === null || rawValue === "") {
      if (def.primary || def.required) {
        throw ERRORS.INVALID_INPUT(`技能「${skill.name}」缺少必填参数：${def.label}`);
      }
      if (def.default !== undefined) {
        out[def.key] = def.default;
      }
      continue;
    }
    if (typeof rawValue !== "string" && typeof rawValue !== "number") {
      throw ERRORS.INVALID_INPUT(`技能「${skill.name}」参数类型不合法：${def.label}`);
    }
    if (def.type === "number") {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) {
        throw ERRORS.INVALID_INPUT(`技能「${skill.name}」参数应为数字：${def.label}`);
      }
      out[def.key] = num;
    } else if (def.type === "select") {
      const option = def.options?.find((o) => o.value === String(rawValue));
      if (!option) {
        throw ERRORS.INVALID_INPUT(`技能「${skill.name}」参数值不合法：${def.label}`);
      }
      out[def.key] = option.value;
    } else {
      out[def.key] = String(rawValue);
    }
  }
  return out;
}

/** 渲染用户消息模板（占位符替换；模板中未提供的占位符视为定义错误，直接抛错） */
export function renderSkillPrompt(
  skill: SkillDefinition,
  params: Record<string, string | number>,
): string {
  let rendered = skill.promptTemplate;
  const matches = rendered.matchAll(/\{\{(\w+)\}\}/g);
  for (const m of matches) {
    const key = m[1]!;
    if (!(key in params)) {
      throw ERRORS.INVALID_INPUT(`技能「${skill.name}」模板缺少参数：${key}`);
    }
    rendered = rendered.replaceAll(`{{${key}}}`, String(params[key]));
  }
  return rendered;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/server && node --import tsx --test src/modules/skills/definitions.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: typecheck 并提交**

Run: `cd apps/server && pnpm typecheck`（`tsc -p tsconfig.json` 包含 src 下测试文件）。

```bash
git add apps/server/src/modules/skills/definitions.ts apps/server/src/modules/skills/definitions.test.ts
git commit -m "feat(skills): 内置技能定义与参数校验（剧本拆解/分镜脚本）"
```

---

### Task 2: 模型服务按类型解析 + 技能模型配置

**Files:**
- Modify: `apps/server/src/modules/settings/model-service.ts:147-178`（resolveModel 增加 types 参数）
- Modify: `apps/server/src/modules/settings/service.ts`（新增 getSkillModelConfig，抽取 buildModelConfig）

**Interfaces:**
- Consumes: `ModelType`（model-catalog）。
- Produces:
  - `ModelService.resolveModel(modelName?: string, userEnabledIds?: string[] | null, types?: ModelType[]): Promise<{ providerId; modelName; type }>` —— 第三个参数默认 `["text"]`，行为与现状完全兼容
  - `SettingsService.getSkillModelConfig(modelName: string | undefined, userId: string, types: ModelType[]): Promise<ModelConfig>`

- [ ] **Step 1: 修改 model-service.ts 的 resolveModel**——签名增加 `types: ModelType[] = ["text"]`；显式模型名校验命中模型后检查 `types.includes(model.type)`，不命中报 `ERRORS.INVALID_INPUT(\`技能不支持该模型类型：${name}\`)`；默认分支查询改为 `inArray(modelsTable.type, types)`，无结果报 `系统未配置可用模型，请联系管理员在后台添加`：

```ts
  /**
   * 解析运行模型：会话/技能指定模型名（全局启用且用户启用）或默认模型
   * （全局启用的首个满足类型集合的模型中，用户启用的优先；userEnabledIds = null 表示全部启用）。
   */
  async resolveModel(
    modelName?: string,
    userEnabledIds?: string[] | null,
    types: ModelType[] = ["text"],
  ): Promise<{ providerId: string; modelName: string; type: ModelType }> {
    const name = modelName?.trim() ?? "";
    if (name !== "") {
      const row = await this.db
        .select()
        .from(modelsTable)
        .where(and(eq(modelsTable.modelName, name), eq(modelsTable.enabled, true)))
        .limit(1);
      if (!row[0]) {
        throw ERRORS.INVALID_INPUT(`模型不可用：${name}（请管理员在后台启用或更换模型）`);
      }
      if (!(types as string[]).includes(row[0].type)) {
        throw ERRORS.INVALID_INPUT(`技能不支持该模型类型：${name}`);
      }
      this.assertUserEnabled(row[0].id, userEnabledIds);
      return { providerId: row[0].providerId, modelName: row[0].modelName, type: row[0].type as ModelType };
    }
    const rows = await this.db
      .select()
      .from(modelsTable)
      .where(and(inArray(modelsTable.type, types), eq(modelsTable.enabled, true)))
      .orderBy(asc(modelsTable.sortOrder), asc(modelsTable.createdAt));
    if (rows.length === 0) {
      // 保持原文案兼容：默认文本场景提示「文本模型」，其余类型集合给通用文案
      const label = types.length === 1 && types[0] === "text" ? "文本模型" : "模型";
      throw ERRORS.INVALID_INPUT(`系统未配置可用${label}，请联系管理员在后台添加`);
    }
    const pick = rows.find((r) => this.isUserEnabled(r.id, userEnabledIds)) ?? rows[0]!;
    return { providerId: pick.providerId, modelName: pick.modelName, type: pick.type as ModelType };
  }
```

注意：默认分支无结果时的错误消息按集合区分，保持现有文案兼容（`types` 精确为 `["text"]` 时沿用原文案「系统未配置可用文本模型，请联系管理员在后台添加」；否则用「系统未配置可用模型，请联系管理员在后台添加」），实现时：

```ts
    if (rows.length === 0) {
      const label = types.length === 1 && types[0] === "text" ? "文本模型" : "模型";
      throw ERRORS.INVALID_INPUT(`系统未配置可用${label}，请联系管理员在后台添加`);
    }
```

注意 import 行补充 `inArray`（已存在），`types` 参数传给 `inArray` 需断言为 `readonly ModelType[]`——`inArray` 接受数组，直接传 `types` 即可（drizzle 类型兼容）。

- [ ] **Step 2: settings/service.ts 抽取 buildModelConfig 并新增 getSkillModelConfig**——在 `getEffectiveModelConfig` 下方新增：

```ts
  /**
   * 技能模型配置：按技能允许的类型集合解析模型（显式 modelName 或默认模型），
   * API Key / baseUrl 解析逻辑与 getEffectiveModelConfig 一致。
   */
  async getSkillModelConfig(
    modelName: string | undefined,
    userId: string,
    types: ModelType[],
  ): Promise<ModelConfig> {
    const s = await this.getModelSettings(userId);
    const resolved = await this.modelService.resolveModel(modelName, s.enabledModels, types);
    return this.buildModelConfig(resolved, s);
  }
```

并把 `getEffectiveModelConfig` 中构造 config 的部分改为调用私有方法（保持返回结构一致）：

```ts
  private buildModelConfig(
    resolved: { providerId: string; modelName: string },
    s: ModelSettings,
  ): ModelConfig {
    const provider = getProviderMeta(resolved.providerId);
    if (!provider) {
      throw new Error(`Unknown model provider: ${resolved.providerId}`);
    }
    const providerSettings = s.providers[resolved.providerId];
    const apiKey = providerSettings?.apiKey || this.envDefaults.apiKey;
    const baseUrl = this.envDefaults.baseUrl !== "" ? this.envDefaults.baseUrl : provider.baseUrl;
    return { providerId: "openai-compatible", baseUrl, apiKey, model: resolved.modelName };
  }
```

`getEffectiveModelConfig` 改为：

```ts
  async getEffectiveModelConfig(
    session: { modelId: string },
    userId: string,
  ): Promise<ModelConfig> {
    const s = await this.getModelSettings(userId);
    const resolved = await this.modelService.resolveModel(session.modelId, s.enabledModels);
    return this.buildModelConfig(resolved, s);
  }
```

import 增加 `type ModelType`（来自 `./model-catalog`）。

- [ ] **Step 3: typecheck**

Run: `cd apps/server && pnpm typecheck` — 预期通过（无行为变化，跑一次冒烟：GET /api/settings 正常）。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/modules/settings/model-service.ts apps/server/src/modules/settings/service.ts
git commit -m "feat(skills): 模型解析支持按类型集合筛选，新增技能模型配置方法"
```

---

### Task 3: SSE 工具抽取 + 技能执行服务

**Files:**
- Create: `apps/server/src/lib/sse.ts`
- Modify: `apps/server/src/modules/agent/run-service.ts:180-193`（删除本地 writeSSE/isErrorOutput，改 import）
- Create: `apps/server/src/modules/skills/skill-run-service.ts`
- Modify: `apps/server/src/modules/session/service.ts:108-111`（addUserMessage 支持 metadata）

**Interfaces:**
- Consumes: `AgentEvent`（@svh/core）、`LLMEvent`（@svh/providers）、`SkillDefinition/validateSkillParams/renderSkillPrompt/getSkillById`（Task 1）、`SettingsService.getSkillModelConfig`（Task 2）、`ModelType`。
- Produces:
  - `writeSSE(raw: ServerResponse, event: AgentEvent): void`
  - `isErrorOutput(output: unknown): boolean`
  - `class SkillRunService { constructor(deps: SkillRunDeps); streamRun(sessionId, skillId, params, modelName, userId, request, reply): Promise<void> }`
  - `interface SkillRunDeps { sessionService; workspaceService; settingsService; membershipService; providerRegistry; log }`
  - `SessionService.addUserMessage(sessionId: string, content: string, metadata?: MessageMetadata)`（保持旧调用兼容）

- [ ] **Step 1: 创建 sse.ts**——把 run-service.ts 中的 `writeSSE` 与 `isErrorOutput` 原样搬入并导出，run-service.ts 改为 `import { writeSSE, isErrorOutput } from "../../lib/sse";`（路径 `apps/server/src/modules/agent/run-service.ts` → `../../lib/sse`）。

- [ ] **Step 2: session/service.ts addUserMessage 增加 metadata 参数**：

```ts
  async addUserMessage(sessionId: string, content: string, metadata?: MessageMetadata) {
    return this.insertMessage(sessionId, "user", content, metadata);
  }
```

- [ ] **Step 3: 实现 skill-run-service.ts**

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import type { AgentEvent } from "@svh/core";
import { OpenAICompatibleProvider, type ChatMessage, type ProviderRegistry } from "@svh/providers";
import type { SessionService } from "../session/service";
import type { WorkspaceService } from "../workspace/service";
import type { SettingsService } from "../settings/service";
import type { MembershipService } from "../membership/service";
import type { ModelType } from "../settings/model-catalog";
import { ERRORS } from "../../lib/errors";
import { writeSSE } from "../../lib/sse";
import { getSkillById, renderSkillPrompt, validateSkillParams, type SkillResultKind } from "./definitions";

export interface SkillRunDeps {
  sessionService: SessionService;
  workspaceService: WorkspaceService;
  settingsService: SettingsService;
  membershipService: MembershipService;
  providerRegistry: ProviderRegistry;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/** 技能消息元数据（写入 messages.metadata.skill） */
export interface SkillMessageMeta {
  skillId: string;
  skillName: string;
  params: Record<string, string | number>;
  modelName: string;
  resultKind: SkillResultKind;
}

/**
 * 技能执行服务：校验 → 模型解析 → 单轮 LLM 补全（无 Tools / 无历史）
 * → 消息持久化 → SSE 转发。事件协议复用 AgentEvent（message.* / run.*）。
 */
export class SkillRunService {
  constructor(private readonly deps: SkillRunDeps) {}

  async streamRun(
    sessionId: string,
    skillId: string,
    params: Record<string, unknown>,
    modelName: string | undefined,
    userId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // ---- 前置校验（错误走 JSON 响应） ----
    await this.deps.membershipService.assertFeature(userId, "agent.basic");
    const session = await this.deps.sessionService.get(sessionId);
    if (session.status === "running") {
      throw ERRORS.SESSION_RUNNING();
    }
    await this.deps.workspaceService.getOwned(session.workspaceId, userId);

    const skill = getSkillById(skillId);
    if (!skill) {
      throw ERRORS.INVALID_INPUT(`技能不存在：${skillId}`);
    }
    const normalized = validateSkillParams(skill, params ?? {});
    const modelConfig = await this.deps.settingsService.getSkillModelConfig(
      modelName?.trim() || undefined,
      userId,
      skill.modelTypes as ModelType[],
    );
    const userPrompt = renderSkillPrompt(skill, normalized);

    // ---- 持久化用户消息（技能标记，内容为主参数原文或摘要） ----
    const primary = skill.params.find((p) => p.primary);
    const primaryValue = primary ? normalized[primary.key] : undefined;
    const userContent =
      typeof primaryValue === "string" && primaryValue !== ""
        ? primaryValue
        : `「${skill.name}」技能执行`;
    const meta: SkillMessageMeta = {
      skillId: skill.id,
      skillName: skill.name,
      params: normalized,
      modelName: modelConfig.model,
      resultKind: skill.resultKind,
    };
    await this.deps.sessionService.addUserMessage(sessionId, userContent, { skill: meta });

    // ---- 状态流转：Idle → Running ----
    await this.deps.sessionService.setStatus(sessionId, "running");
    this.deps.providerRegistry.register(
      new OpenAICompatibleProvider({ baseUrl: modelConfig.baseUrl, apiKey: modelConfig.apiKey }),
    );

    this.deps.log.info(
      { sessionId, skill: skill.id, model: modelConfig.model },
      "skill run started",
    );

    // ---- SSE 流 ----
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const controller = new AbortController();
    const onClose = () => controller.abort();
    request.raw.on("close", onClose);

    let terminalError = false;
    let assistantContent = "";
    const messageId = `skill_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    try {
      writeSSE(raw, { type: "run.started" });
      writeSSE(raw, { type: "message.started", messageId });

      const provider = this.deps.providerRegistry.get(modelConfig.providerId);
      const messages: ChatMessage[] = [
        ...(skill.systemPrompt ? [{ role: "system" as const, content: skill.systemPrompt }] : []),
        { role: "user", content: userPrompt },
      ];

      for await (const event of provider.chat(
        { model: modelConfig.model, messages },
        controller.signal,
      )) {
        if (event.type === "delta") {
          assistantContent += event.content;
          writeSSE(raw, { type: "message.delta", messageId, content: event.content });
        } else if (event.type === "done") {
          break;
        } else if (event.type === "error") {
          terminalError = true;
          writeSSE(raw, { type: "message.completed", messageId });
          writeSSE(raw, { type: "run.error", error: event.error });
          this.deps.log.error({ sessionId, skill: skill.id, error: event.error }, "skill run error");
          break;
        }
      }

      if (!terminalError) {
        await this.deps.sessionService.addAssistantMessage(sessionId, assistantContent, {
          skill: meta,
        });
        writeSSE(raw, { type: "message.completed", messageId });
        writeSSE(raw, { type: "run.completed" });
        this.deps.log.info({ sessionId, skill: skill.id }, "skill run completed");
      }
    } catch (err) {
      this.deps.log.error({ sessionId, skill: skill.id, error: (err as Error).message }, "skill run relay error");
    } finally {
      request.raw.removeListener("close", onClose);
      await this.deps.sessionService.setStatus(sessionId, terminalError ? "error" : "idle");
      if (!raw.destroyed) {
        try {
          raw.end();
        } catch {
          // 客户端已断开，忽略
        }
      }
    }
  }
}
```

> 注：`messages` 数组类型可直接用 `ChatMessage[]` 显式标注（`import type { ChatMessage } from "@svh/providers"`），System 消息的 role 字面量类型需符合 `ChatMessage["role"]`。

- [ ] **Step 4: typecheck**

Run: `cd apps/server && pnpm typecheck` — 预期通过。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/lib/sse.ts apps/server/src/modules/agent/run-service.ts apps/server/src/modules/skills/skill-run-service.ts apps/server/src/modules/session/service.ts
git commit -m "feat(skills): 技能执行服务（参数校验/模型解析/单轮LLM/SSE/消息持久化）"
```

---

### Task 4: 技能路由注册 + 上下文隔离

**Files:**
- Create: `apps/server/src/routes/skills.ts`
- Modify: `apps/server/src/app.ts`（构造 SkillRunService + 注册路由，位置参考现有 runService/registerAgentRoutes 段落）
- Modify: `packages/core/src/context/context-builder.ts:66-67`（历史消息循环跳过技能消息）

**Interfaces:**
- Consumes: `SkillRunService`（Task 3）、`listSkillPublicViews`（Task 1）。
- Produces: 路由 `GET /api/skills`、`POST /api/sessions/:id/skill`；`metadata.skill` 标记为用户/助手消息全部走隔离。

- [ ] **Step 1: 创建 routes/skills.ts**

```ts
import type { FastifyInstance } from "fastify";
import type { SkillRunService } from "../modules/skills/skill-run-service";
import { listSkillPublicViews } from "../modules/skills/definitions";
import { ERRORS } from "../lib/errors";

export interface SkillsRouteDeps {
  skillRunService: SkillRunService;
}

/** 技能 API：列表 + 执行（SSE，事件协议同 Agent run） */
export function registerSkillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  // 技能列表（公开视图，不含提示词模板）
  app.get("/api/skills", async () => listSkillPublicViews());

  // 技能执行
  app.post<{
    Params: { id: string };
    Body: { skillId?: string; params?: Record<string, unknown>; modelName?: string };
  }>("/api/sessions/:id/skill", async (req, reply) => {
    const skillId = req.body?.skillId?.trim();
    if (!skillId) {
      throw ERRORS.INVALID_INPUT("skillId is required");
    }
    await deps.skillRunService.streamRun(
      req.params.id,
      skillId,
      req.body?.params ?? {},
      req.body?.modelName,
      req.user!.userId,
      req,
      reply,
    );
  });
}
```

- [ ] **Step 2: app.ts 注册**——在 `registerAgentRoutes(app, { runService });` 附近新增：

```ts
  const skillRunService = new SkillRunService({
    sessionService,
    workspaceService,
    settingsService,
    membershipService,
    providerRegistry,
    log: app.log,
  });
```

并在路由注册段加入：

```ts
  registerSkillsRoutes(app, { skillRunService });
```

以及 import：`import { SkillRunService } from "./modules/skills/skill-run-service";`、`import { registerSkillsRoutes } from "./routes/skills";`

- [ ] **Step 3: context-builder.ts 跳过技能消息**——`build()` 中历史消息循环最开始插入：

```ts
    for (const msg of history) {
      // 技能消息（metadata.skill）不入上下文（设计 §5 隔离语义）
      const meta0 = (msg.metadata ?? {}) as { skill?: unknown };
      if (meta0.skill) continue;
      if (msg.role === "user") {
```

（原有循环体保留；变量名 `meta0` 仅为避免与循环内后续 `meta` 重名冲突，执行者可将此判断放循环首行。）

- [ ] **Step 4: typecheck + 重启服务冒烟**

Run: `cd apps/server && pnpm typecheck && pnpm build`
重启 server（沿用现有 nohup 命令，端口 3456），然后：

```bash
curl -s http://localhost:3456/api/skills -H "Authorization: Bearer <admin_token>" | head -c 600
curl -s -X POST http://localhost:3456/api/sessions/<session_id>/skill \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"skillId":"script-breakdown","params":{"source_text":"一个年轻人穿越回古代，凭借现代知识成为商业奇才。","episodes":"3","format":"script"}}' \
  | head -c 1200
```

Expected: 列表含两个技能；POST 返回 SSE（`event: run.started` → `message.delta` 若干 → `run.completed`）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/skills.ts apps/server/src/app.ts packages/core/src/context/context-builder.ts
git commit -m "feat(skills): 技能列表与执行路由接入，技能消息与对话上下文隔离"
```

---

### Task 5: 共享元数据类型 + 前端 API 层

**Files:**
- Modify: `packages/shared/src/index.ts:39-47`（MessageMetadata 增加 skill 字段）
- Modify: `packages/database/src/schema/message.ts:27-37`（MessageMetadata / ToolMessageMetadata 增加 skill 字段）
- Modify: `apps/web/src/types/api-types.ts`（新增 Skill 类型 + SessionMessage 元数据透传）
- Create: `apps/web/src/api/skills.ts`
- Modify: `apps/web/src/api/run.ts`（抽取 `ssePost` 供 runAgent / runSkill 复用）

**Interfaces:**
- Consumes: 无（纯类型与请求层）。
- Produces:
  - `MessageMetadata.skill?: SkillMessageMeta`（shared + database 两份类型同步）
  - `SkillParamType/SkillParamDef/SkillResultKind/SkillDefinitionView`（web api-types）
  - `skillsApi.list(): Promise<SkillDefinitionView[]>`
  - `runSkillRequest(sessionId, body: { skillId; params?; modelName? }, opts: { onEvent; signal? }): Promise<void>`
  - `ssePost(url, body, opts)`（run.ts 内部导出）

- [ ] **Step 1: shared/index.ts + schema/message.ts 增加 skill 元数据**（两处一致）：

```ts
/** 技能消息元数据（技能执行的用户消息与结果消息标记） */
export interface SkillMessageMeta {
  skillId: string;
  skillName: string;
  params: Record<string, string | number>;
  modelName: string;
  resultKind: "text" | "image" | "video" | "audio";
}
```

`MessageMetadata` 增加：`skill?: SkillMessageMeta;`（database 侧换成独立定义或直接内联同构类型，注释说明与 shared 保持一致）。

- [ ] **Step 2: api-types.ts 新增类型**：

```ts
/** 技能参数类型（与 /api/skills 返回一致） */
export type SkillParamType = "text" | "textarea" | "number" | "select";
export interface SkillParamDef {
  key: string;
  label: string;
  type: SkillParamType;
  primary?: boolean;
  required?: boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  default?: string | number;
}
export type SkillResultKind = "text" | "image" | "video" | "audio";
export interface SkillDefinitionView {
  id: string;
  name: string;
  description: string;
  modelTypes: string[];
  params: SkillParamDef[];
  resultKind: SkillResultKind;
}
export interface SkillMessageMeta {
  skillId: string;
  skillName: string;
  params: Record<string, string | number>;
  modelName: string;
  resultKind: SkillResultKind;
}
```

（`SessionMessage` 从 @svh/shared 复用，其 `metadata` 已带 `skill?: SkillMessageMeta`——确认 shared 导出类型包含新字段后，web 侧无需重复声明。）

- [ ] **Step 3: run.ts 抽取 ssePost**——把 `runAgent` 中 fetch + SSE 解析抽出为：

```ts
/** 通用 POST + SSE 解析（供 Agent run / 技能 run 复用） */
export async function ssePost(
  url: string,
  body: Record<string, unknown>,
  options: RunAgentOptions,
): Promise<void> {
  // 原 runAgent 的 fetch/解析逻辑，URL 与 body 参数化
}

export async function runAgent(sessionId, message, options) {
  await ssePost(apiUrl(`/api/sessions/${sessionId}/run`), { message }, options);
}
```

- [ ] **Step 4: 创建 api/skills.ts**

```ts
import { get } from "./client";
import { ssePost } from "./run";
import type { SkillDefinitionView } from "../types/api-types";
import type { RunAgentOptions } from "./run";

export const skillsApi = {
  list: () => get<SkillDefinitionView[]>("/api/skills"),
};

export function runSkillRequest(
  sessionId: string,
  body: { skillId: string; params?: Record<string, unknown>; modelName?: string },
  options: RunAgentOptions,
): Promise<void> {
  return ssePost(`/api/sessions/${sessionId}/skill`, body, options);
}
```

- [ ] **Step 5: typecheck + 提交**

Run: `cd apps/server && pnpm typecheck && cd apps/web && pnpm typecheck`

```bash
git add packages/shared/src/index.ts packages/database/src/schema/message.ts apps/web/src/types/api-types.ts apps/web/src/api/run.ts apps/web/src/api/skills.ts
git commit -m "feat(skills): 技能元数据类型与前端 API 层（列表/SSE 执行）"
```

---

### Task 6: useAgentRun 技能流式支持

**Files:**
- Modify: `apps/web/src/hooks/useAgentRun.ts`

**Interfaces:**
- Consumes: `runSkill`（Task 5）、`SkillMessageMeta`、`SkillDefinitionView`（api-types）。
- Produces:
  - `StreamItem` 的 user/assistant 变体增加可选 `skill?: SkillMessageMeta`
  - `UseAgentRunResult` 增加 `runSkill: (skill: SkillDefinitionView, params: Record<string, unknown>, modelName?: string) => Promise<void>`（hook 用 skill 的 id/name/resultKind 构造本地占位元数据）

- [ ] **Step 1: 类型扩展**（`useAgentRun.ts` 顶部）：

```ts
export type StreamItem =
  | { kind: "user"; id: string; content: string; skill?: SkillMessageMeta }
  | { kind: "assistant"; id: string; content: string; status: "streaming" | "done"; skill?: SkillMessageMeta }
  | { kind: "tool"; id: string; toolName: string; input: unknown; output?: unknown; status: "running" | "done" | "error" };
```

- [ ] **Step 2: 新增 runSkill**——与 `send` 平行，抽公共流处理。最小实现（复制 send 的骨架）：

```ts
  const runSkill = useCallback(
    async (skill: SkillDefinitionView, params: Record<string, unknown>, modelName?: string) => {
      if (!sessionId || isRunning) return;
      setError(null);
      // 本地占位：技能用户消息（完整元数据以服务端持久化数据为准）
      const skillMeta: SkillMessageMeta = {
        skillId: skill.id,
        skillName: skill.name,
        params: params as Record<string, string | number>,
        modelName: modelName ?? "",
        resultKind: skill.resultKind,
      };
      setStreamItems([{ kind: "user", id: `local_skill_${Date.now().toString(36)}`, content: `运行技能「${skill.name}」…`, skill: skillMeta }]);
      const controller = new AbortController();
      controllerRef.current = controller;
      setIsRunning(true);

      const onEvent = (event: AgentEvent) => {
        switch (event.type) {
          case "message.started":
            setStreamItems((items) => [
              ...items,
              { kind: "assistant", id: event.messageId, content: "", status: "streaming", skill: { ...skillMeta, modelName: modelName ?? skillMeta.modelName } },
            ]);
            break;
          case "message.delta":
            setStreamItems((items) =>
              items.map((item) =>
                item.kind === "assistant" && item.id === event.messageId
                  ? { ...item, content: item.content + event.content }
                  : item,
              ),
            );
            break;
          case "message.completed":
            setStreamItems((items) =>
              items.map((item) =>
                item.kind === "assistant" && item.id === event.messageId
                  ? { ...item, status: "done" as const }
                  : item,
              ),
            );
            break;
          case "run.error":
            setError(event.error);
            break;
          default:
            break;
        }
      };

      try {
        await runSkillRequest(sessionId, { skillId: skill.id, params, modelName: modelName ?? "" }, { onEvent, signal: controller.signal });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        controllerRef.current = null;
        setIsRunning(false);
        await queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
        setStreamItems([]);
      }
    },
    [sessionId, isRunning, queryClient, setIsRunning],
  );
```

> 实现注意：`runSkillRequest` 即 Task 5 的 `runSkillRequest`（api/skills.ts），import 时用别名避免与 hook 方法 `runSkill` 重名（如 `runSkillRequest as runSkillApi` 反向亦可）。Tool 分支与 workspace.changed 无需处理（技能执行无工具调用）。

- [ ] **Step 3: typecheck + 提交**

Run: `cd apps/web && pnpm typecheck`

```bash
git add apps/web/src/hooks/useAgentRun.ts
git commit -m "feat(skills): 会话 hook 支持技能流式运行（携带技能元数据）"
```

---

### Task 7: 输入栏技能/模型选择 + 内联参数行

**Files:**
- Modify: `apps/web/src/features/chat/ChatInput.tsx`

**Interfaces:**
- Consumes: `SkillDefinitionView`、`SkillParamDef`（api-types）；antd `Select` / `InputNumber`。
- Produces 扩展 props:

```ts
export interface ChatInputProps {
  disabled?: boolean;
  isRunning: boolean;
  /** 当前生效模型名（无技能时展示 / 模型 Select 值） */
  model?: string;
  /** 可选技能列表 */
  skills?: SkillDefinitionView[];
  /** 当前选中技能（null = 普通对话） */
  selectedSkill?: SkillDefinitionView | null;
  /** 当前模型名（会话 modelId） */
  selectedModel?: string;
  /** 可选模型（已按技能类型 + 用户启用过滤，由父组件计算） */
  modelOptions?: Array<{ label: string; value: string }>;
  /** 普通对话发送（输入框文本即消息） */
  onSend: (message: string) => void;
  /** 技能发送（主参数已并入 params[primary.key]，其余参数由本组件收集） */
  onRunSkill: (params: Record<string, unknown>) => void;
  onStop: () => void;
  onSkillChange?: (skillId: string | null) => void;
  onModelChange?: (modelName: string) => void;
}
```

- [ ] **Step 1: 参数状态 + 发送分支**——技能模式下 `send()` 组装全部参数（主参数 = 输入框文本）后调用 `onRunSkill`：

```tsx
  const [value, setValue] = useState("");
  // 其余参数值（非 primary），技能切换时按 default 重置
  const [paramValues, setParamValues] = useState<Record<string, string | number | undefined>>({});
  const otherParams = selectedSkill?.params.filter((p) => !p.primary) ?? [];

  useEffect(() => {
    const next: Record<string, string | number | undefined> = {};
    for (const p of otherParams) {
      if (p.default !== undefined) next[p.key] = p.default;
    }
    setParamValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSkill?.id]);

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    if (selectedSkill) {
      const primary = selectedSkill.params.find((p) => p.primary);
      const params: Record<string, unknown> = { ...paramValues };
      if (primary) params[primary.key] = text;
      onRunSkill(params);
    } else {
      onSend(text);
    }
    setValue("");
  };
```

- [ ] **Step 2: 内联参数控件行**——技能选中 && 存在非 primary 参数时，在输入行上方渲染（紧凑单行，可换行）：

```tsx
{selectedSkill && otherParams.length > 0 && (
  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px 0", flexWrap: "wrap" }}>
    {otherParams.map((p) => (
      <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{p.label}</span>
        {p.type === "number" ? (
          <InputNumber
            size="small"
            min={1}
            max={99}
            value={paramValues[p.key] as number}
            onChange={(v) => setParamValue(p.key, v !== null ? v : undefined)}
          />
        ) : (
          <Select
            size="small"
            style={{ minWidth: 110 }}
            value={paramValues[p.key]}
            options={p.options}
            onChange={(v) => setParamValue(p.key, v)}
          />
        )}
      </div>
    ))}
  </div>
)}
```

`otherParams` 定义见 Step 1；`paramValues` state 由 `selectedSkill` 变化时以 default 初始化。

- [ ] **Step 3: 底部信息行改为 技能 Select + 模型 Select + 提示**：

```tsx
<div style={{ padding: "0 14px 10px", fontSize: 11, color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", gap: 8 }}>
  <Select
    size="small"
    variant="borderless"
    style={{ minWidth: 96, fontSize: 11 }}
    placeholder="技能"
    allowClear
    value={selectedSkill?.id ?? undefined}
    options={(skills ?? []).map((s) => ({ label: s.name, value: s.id }))}
    onChange={(v: string | undefined) => onSkillChange?.(v ?? null)}
    popupMatchSelectWidth={false}
  />
  <Select
    size="small"
    variant="borderless"
    style={{ minWidth: 120, fontSize: 11 }}
    placeholder="模型"
    value={selectedModel}
    options={modelOptions}
    onChange={(v: string) => onModelChange?.(v)}
    popupMatchSelectWidth={false}
  />
  <span style={{ flex: 1, textAlign: "right" }}>Enter 发送 · Shift+Enter 换行</span>
</div>
```

- [ ] **Step 4: 主参数 placeholder 联动**——技能选中时 placeholder 用主参数 `placeholder`（无则 `输入技能参数…`），未选技能保持原文案。

- [ ] **Step 5: typecheck + 提交**

Run: `cd apps/web && pnpm typecheck`

```bash
git add apps/web/src/features/chat/ChatInput.tsx
git commit -m "feat(skills): 输入栏技能/模型选择与内联参数控件行"
```

---

### Task 8: 技能结果卡片 + 消息列表渲染

**Files:**
- Create: `apps/web/src/features/chat/SkillResultCard.tsx`
- Modify: `apps/web/src/features/chat/MessageList.tsx:73-130`

**Interfaces:**
- Consumes: `SkillMessageMeta`（api-types）、`SessionMessage`、`StreamItem`（含 skill 字段）。
- Produces: `<SkillResultCard meta={SkillMessageMeta} content={string} streaming?: boolean modelDisplayName?: string />`

- [ ] **Step 1: 创建 SkillResultCard.tsx**

```tsx
import { Button, Tooltip } from "antd";
import { CopyOutlined, DownloadOutlined } from "@ant-design/icons";
import { message as antdMessage } from "antd";
import type { SkillMessageMeta } from "../../types/api-types";

interface SkillResultCardProps {
  meta: SkillMessageMeta;
  content: string;
  streaming?: boolean;
  /** 模型显示名（由父组件由 modelName 映射，缺省显示 modelName） */
  modelDisplayName?: string;
}

/**
 * 技能结果卡片：头部（技能名 + 模型 + 参数摘要）+ 正文（按 resultKind 渲染）。
 * V1：text 正文 + 复制 / 下载 .md；媒体 resultKind 为 V2 预留（占位提示）。
 */
export function SkillResultCard({ meta, content, streaming, modelDisplayName }: SkillResultCardProps) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      antdMessage.success("已复制到剪贴板");
    } catch {
      antdMessage.error("复制失败");
    }
  };
  const download = () => {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.skillName}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const paramSummary = Object.entries(meta.params)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 20)}`)
    .join(" · ");

  return (
    <div style={{ maxWidth: "92%", border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-surface)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--color-border)", background: "#fafafa" }}>
        <Tooltip title={paramSummary}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{meta.skillName}</span>
        </Tooltip>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{modelDisplayName ?? meta.modelName}</span>
        <div style={{ flex: 1 }} />
        {!streaming && meta.resultKind === "text" && (
          <>
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={copy}>复制</Button>
            <Button size="small" type="text" icon={<DownloadOutlined />} onClick={download}>下载 .md</Button>
          </>
        )}
      </div>
      <div style={{ padding: "10px 12px", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {streaming ? content + "▍" : content}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: MessageList 渲染技能消息**——`renderMessage` 中：

```tsx
  if (message.role === "assistant") {
    if (!message.content && !meta.toolCalls?.length) return null;
    if (meta.skill) {
      return (
        <MessageRow key={message.id}>
          <SkillResultCard meta={meta.skill} content={message.content} />
        </MessageRow>
      );
    }
    return <MessageRow key={message.id}>{message.content ? <AssistantMessage content={message.content} /> : null}</MessageRow>;
  }
```

用户消息带 `meta.skill` 时在气泡上方加技能标识：

```tsx
  if (message.role === "user") {
    return (
      <MessageRow key={message.id}>
        {meta.skill && (
          <div style={{ textAlign: "right", fontSize: 11, color: "var(--color-text-tertiary)" }}>
            技能：{meta.skill.skillName}
          </div>
        )}
        <UserMessage content={message.content} />
      </MessageRow>
    );
  }
```

`renderStreamItem`：assistant 项带 `item.skill` → 渲染 `SkillResultCard streaming`；user 项带 `item.skill` → 同上带「技能：」标识（modelDisplayName 由父组件后续接线，此处可传 `item.skill.modelName`）。

- [ ] **Step 3: typecheck + 提交**

Run: `cd apps/web && pnpm typecheck`

```bash
git add apps/web/src/features/chat/SkillResultCard.tsx apps/web/src/features/chat/MessageList.tsx
git commit -m "feat(skills): 技能结果卡片（复制/下载）与消息列表渲染"
```

---

### Task 9: AgentChat 接线（技能数据流 + 模型联动）

**Files:**
- Modify: `apps/web/src/features/chat/AgentChat.tsx`

**Interfaces:**
- Consumes: `skillsApi.list`（Task 5）、`runSkill`（Task 6）、`sessionApi.update`、ChatInput 新 props（Task 7）、SettingsView。
- Produces: 完整技能交互闭环。

- [ ] **Step 1: 数据获取与状态**

```tsx
  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: () => skillsApi.list(),
  });
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const selectedSkill = skills?.find((s) => s.id === selectedSkillId) ?? null;
  const { runSkill, send, streamItems, isRunning, error, stop } = useAgentRun(session.id);
```

- [ ] **Step 2: 模型选项计算**——现有 `allModels/userEnabled` 之后：

```tsx
  // 技能未选：仅文本模型；选中技能：技能允许类型 ∩ 用户启用
  const allowedTypes = selectedSkill?.modelTypes ?? ["text"];
  const modelOptions = allModels
    .filter((m) => allowedTypes.includes(m.type) && userEnabled(m))
    .map((m) => ({ label: m.displayName, value: m.modelName }));
  const currentModelName = session.modelId?.trim() || modelOptions[0]?.value;
  const modelDisplayName =
    allModels.find((m) => m.modelName === currentModelName)?.displayName ?? currentModelName;
```

- [ ] **Step 3: 模型切换持久化 + 技能切换**

```tsx
  const handleModelChange = (modelName: string) => {
    void sessionApi.update(session.id, { modelId: modelName }).then(() => {
      // currentSession 缓存键为 ["session", id]（WorkbenchPage）；侧栏列表键 ["sessions"] 一并失效
      void queryClient.invalidateQueries({ queryKey: ["session", session.id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    });
  };
  const handleSkillChange = (skillId: string | null) => setSelectedSkillId(skillId);
```

> 组件内需引入 `useQueryClient`（`AgentChat` 目前未使用，从 `@tanstack/react-query` 引入）。

- [ ] **Step 4: onRunSkill 分支**（ChatInput 已组装完整 params，含主参数）

```tsx
  const handleRunSkill = (params: Record<string, unknown>) => {
    if (!selectedSkill) return;
    void runSkill(selectedSkill, params, currentModelName);
  };
```

> hooks 中已有变量与 state 重名时（如 `error`/`send`/`isRunning`），直接使用解构值即可，无需重命名（`runSkill` 无冲突）。

- [ ] **Step 5: 传入 ChatInput**

```tsx
  <ChatInput
    disabled={!session.id}
    isRunning={isRunning}
    model={modelDisplayName}
    skills={skills ?? []}
    selectedSkill={selectedSkill}
    selectedModel={currentModelName}
    modelOptions={modelOptions}
    onSend={(text) => void send(text)}
    onRunSkill={handleRunSkill}
    onStop={stop}
    onSkillChange={handleSkillChange}
    onModelChange={handleModelChange}
  />
```

- [ ] **Step 6: typecheck + eslint + build + 提交**

Run: `cd apps/web && pnpm typecheck && pnpm lint && pnpm vite build`（如 lint 对未使用变量报错，删除未用项）。

```bash
git add apps/web/src/features/chat/AgentChat.tsx
git commit -m "feat(skills): AgentChat 接入技能选择/模型联动/技能发送"
```

---

### Task 10: 全量验证与收尾

**Files:** 无新增（仅验证 + 需要时修复）。

- [ ] **Step 1: 全量静态检查**

Run: `cd /home/yesheng/projects/SVH && pnpm typecheck && pnpm lint && pnpm --filter @svh/web build`
Expected: 全部通过。

- [ ] **Step 2: 服务端接口回归（重启 server 后 curl）**

重启 server（3456），用 admin 登录取 token：

```bash
# 1) 技能列表
curl -s http://localhost:3456/api/skills -H "Authorization: Bearer $TOKEN"
# 2) 技能执行（正常）
curl -sN -X POST http://localhost:3456/api/sessions/$SID/skill -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"skillId":"script-breakdown","params":{"source_text":"测试文本","episodes":"3"}}'
# 3) 参数错误：缺必填
curl -s -X POST ... -d '{"skillId":"script-breakdown","params":{}}'   # 期望 400 含「缺少必填参数」
# 4) 未知参数
curl -s -X POST ... -d '{"skillId":"script-breakdown","params":{"source_text":"x","bad":1}}'  # 期望 400 含「未知参数」
# 5) 类型约束：指定图片模型（如 doubao-seedream 类模型名）
curl -s -X POST ... -d '{"skillId":"script-breakdown","params":{"source_text":"x"},"modelName":"<image模型名>"}'  # 期望 400 含「技能不支持该模型类型」
# 6) 未知技能
curl -s -X POST ... -d '{"skillId":"nope"}'  # 期望 400 含「技能不存在」
# 7) 消息持久化
curl -s http://localhost:3456/api/sessions/$SID/messages -H "Authorization: Bearer $TOKEN"  # 最后两条带 metadata.skill
# 8) 隔离验证：随后发起普通对话，观察普通对话请求/回复不含技能内容（mock-llm 日志或回复独立性）
```

- [ ] **Step 3: 前端手工流程**（浏览器 / web 端）：

1. 打开会话 → 输入栏选「剧本拆解」→ 看到参数行（集数、输出格式）+ placeholder 变更
2. 输入主文本 → Enter → 结果卡片流式出现（头部：技能名 + 模型）→ 结束后显示「复制」「下载 .md」
3. 技能切换回「普通对话」→ 模型下拉恢复文本模型 → 普通对话不受影响
4. 模型下拉选择其他文本模型 → 会话 modelId 持久化（刷新后仍生效）
5. 刷新页面 → 技能消息恢复为结果卡片形态
6. 停止按钮：执行中点击停止 → 会话状态回 idle

- [ ] **Step 4: 修复问题并推送**

若 Step 1-3 发现问题：修复 → 重复 Step 1 → 提交修复。

```bash
git add -A
git commit -m "feat(skills): 技能模块 V1 完成（内置技能/执行/展示/隔离）"
git push origin master
```
