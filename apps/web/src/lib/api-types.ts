/**
 * 后端响应的前端类型。
 *
 * ── 为什么手写而不从后端 import ──
 * 前端构建不应把服务端代码（Prisma、Fastify）拉进 bundle。
 * 这些类型与 `@svh/domain` 的契约对齐，但只保留界面真正消费的字段 ——
 * **因此这里只声明「前端会去读」的字段，不追求与响应逐字段一致**。
 *
 * ── 漂移由谁守 ──
 * `apps/api/test/api-contract.test.ts`：它用 `app.inject()` 打真实端点，
 * 再从本文件解析出每个接口的**必填**字段名，逐个断言「声明了就必须真的存在」。
 *
 * 这条不变量是单向的，正好对应上面那句设计意图：
 *   · 声明了、响应里没有 → 前端读到 `undefined`，是缺陷，测试失败；
 *   · 响应里有、没声明   → 界面本来就不消费，属于设计允许。
 *
 * 之所以要有它：原注释写「护栏是端到端验证（验收标准第 1 条）」，而那条
 * 链路因后端既有缺陷当前**不可达**，等于这个接缝上一道护栏都没有。
 */

export interface PageBody<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  projectId: string | null;
  title: string;
  agentState: string;
  status: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /api/agent/sessions/:id`。
 *
 * 详情比列表摘要多带 `messages`，但**没有 `messageCount`** —— 两个形状
 * 不是包含关系，所以这里分开声明，不让详情去 extends 摘要。
 */
export interface SessionDetail {
  id: string;
  projectId: string | null;
  title: string;
  agentState: string;
  contentId: string | null;
  messages: SessionMessage[];
}

/** `POST /api/agent/sessions/:id/confirm` */
export interface ConfirmResponse {
  /** 真正放行（waiting_user → pending）的任务 id */
  resumed: string[];
  /** 没能放行的任务与原因 */
  skipped: Array<{ taskId: string; reason: string }>;
  message: string;
}

/** `GET /api/skills` 的列表项（补全列表只消费这三个字段） */
export interface SkillOption {
  id: string;
  name: string;
  category: string;
}

/** `GET /api/assets` 的列表项（`@引用` 补全用） */
export interface AssetOption {
  id: string;
  slug: string;
  name: string;
}

/**
 * `POST /api/assets/resolve-mentions`。
 *
 * `matched` 里带上 `slug`：前端据此把补全项与用户输入的那段文字对应起来。
 */
export interface ResolveMentionsResult {
  mentions: string[];
  matched: Array<{ id: string; slug: string; name: string }>;
  missing: string[];
}

/** 五类结构化载荷（与 @svh/domain 的 messagePayloadSchema 对齐） */
export interface PlanTask {
  id: string;
  title: string;
  skill?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  taskId?: string;
  estimate?: string;
  dependsOn: string[];
}

export interface PlanPayload {
  type: 'plan';
  goal: string;
  rationale?: string;
  tasks: PlanTask[];
  requiresApproval: boolean;
}

export interface CardAction {
  id: string;
  label: string;
  kind: 'reply' | 'primary' | 'secondary' | 'danger';
  message?: string;
  tool?: string;
  payload?: Record<string, unknown>;
}

export interface CardMedia {
  kind: 'image' | 'video' | 'audio' | 'text';
  url?: string;
  assetId?: string;
  thumbnailUrl?: string;
  caption?: string;
}

export interface ResultCardPayload {
  type: 'result_card';
  title: string;
  category:
    | 'character' | 'scene' | 'product' | 'brand' | 'digital_human'
    | 'script' | 'storyboard' | 'image' | 'video' | 'audio'
    | 'subtitle' | 'output' | 'asset' | 'info';
  subtitle?: string;
  attributes?: Array<[string, string]>;
  media: CardMedia[];
  assetId?: string;
  contentId?: string;
  taskId?: string;
  actions: CardAction[];
}

export interface ConfirmationRequestPayload {
  type: 'confirmation_request';
  summary: string;
  impacts: Array<[string, string]>;
  taskId?: string;
  planTaskIds: string[];
}

export interface ProgressPayload {
  type: 'progress';
  taskId?: string;
  progress: number;
  message: string;
}

export interface ErrorPayload {
  type: 'error';
  title: string;
  reason: string;
  suggestions: string[];
  recovered: boolean;
  recoveryNote?: string;
  actions: CardAction[];
  taskId?: string;
  code?: string;
}

export type MessagePayload =
  | PlanPayload
  | ResultCardPayload
  | ConfirmationRequestPayload
  | ProgressPayload
  | ErrorPayload;

export interface SessionMessage {
  id: string;
  role: 'user' | 'agent' | 'system' | 'tool';
  kind: 'text' | 'plan' | 'result_card' | 'confirmation_request' | 'progress' | 'error';
  content: string;
  payload: unknown;
  toolCalls?: unknown;
  /**
   * 产出这条消息的任务（Worker 追加结果卡时会写）。
   *
   * 会话详情端点返回的是完整消息行，这个列一直都在，只是此前前端没声明。
   * 界面用它做结果卡去重：刷新时先把历史里已落库的卡按 taskId 记账，
   * 再回捞补历史 —— 否则同一个任务会被补出第二张卡。
   */
  taskId?: string | null;
  createdAt: string;
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'success' | 'failed' | 'rejected';
  result?: unknown;
  error?: string;
  requiresConfirmation: boolean;
  durationMs?: number;
}

/**
 * `POST /api/agent/chat` 里的意图分析结果。
 *
 * 单独成接口（而不是内联在 `ChatResponse` 里）是为了让契约测试能按名字
 * 取到它 —— 内联对象类型解析不出来，也就无从比对。
 */
export interface ChatAnalysis {
  intent: string;
  confidence: number;
  contentType?: string;
  targets: Array<{ kind: string; index?: number; slug?: string; label: string }>;
  mentions: string[];
  rationale?: string;
}

export interface ChatResponse {
  sessionId: string;
  sessionCreated: boolean;
  message: string;
  payload?: MessagePayload;
  state: 'completed' | 'waiting_user' | 'failed';
  analysis: ChatAnalysis;
  toolCalls: ToolCallRecord[];
  contextNotes: string[];
  iterations: number;
}

/**
 * 任务行：`GET /api/tasks` 列表项与 `GET /api/tasks/:id` 的公共部分。
 *
 * 注意这里**没有 `terminal`** —— 终态标记只出现在轮询端点
 * `GET /api/tasks/:id/progress` 上。契约测试就是靠这条把两者分开的：
 * 早先把 `terminal` 声明在列表项上，前端若去读只会拿到 `undefined`。
 */
export interface TaskRow {
  id: string;
  status: string;
  progress: number;
  progressMessage: string | null;
  errorMessage: string | null;
  skillId: string;
  updatedAt: string;
}

/** `GET /api/tasks/:id/progress`：任务行 + 终态标记（前端据此停止轮询） */
export interface TaskProgress extends TaskRow {
  terminal: boolean;
}

/** `GET /api/tasks/:id`：任务行 + 产物 */
export interface TaskDetail extends TaskRow {
  output: unknown;
}

export interface ModelProviderView {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  health: 'healthy' | 'degraded' | 'down' | 'unknown';
  apiKeyMask: string | null;
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /api/models/providers/runtime`。
 *
 * 装配层在没有可用真实模型时会改用 Mock 以保证链路仍能跑通。界面据此
 * 明确告诉用户「现在看到的是占位内容」，而不是把占位文本当成模型答复呈现
 * （spec §10 第 4 条禁止的静默失败）。
 */
export interface ModelRuntimeStatus {
  /**
   * 当前**所有**可用模型是否都来自 Mock 类 Provider —— 为真时产出一定是占位内容。
   *
   * 判据刻意不是 `ModelRuntime.usingMock`：那个布尔只表示「一个可用模型都没有、
   * 装配层加了内置 Mock 兜底」，而库里那条 `kind='mock'` 的 Mock Provider 行
   * 自带模型，于是「只剩 Mock 可用」时它仍是 false。按 Provider 类型算才覆盖得住。
   */
  placeholderOnly: boolean;
  /** 来自真实（非 Mock）Provider 的已启用模型数；为 0 时界面引导去配置模型 */
  realModelCount: number;
  /** 已装配的 Provider 总数（含 Mock） */
  providerCount: number;
  /** 已装配的模型总数（含 Mock） */
  modelCount: number;
}

/**
 * `POST /api/models/providers/:id/test`。
 *
 * 早先这里声明的是 `{ ok?, health?, message?, latencyMs? }`，注释里写着
 * 「接口文档写的是 `{ ok, message }`，两种形态都读」—— 那是**猜的**：
 * 服务端从来不返回 `ok`（`HealthProbeResult` + `usedTemporaryConfig`），
 * 于是 `result.ok === true` 这个分支永远不成立。现在按实测形状声明，
 * 并由契约测试钉住。
 */
export interface TestConnectionResult {
  providerId: string;
  providerName: string;
  health: ModelProviderView['health'];
  /** 面向用户的说明；成功时为 null */
  message: string | null;
  /** 可操作的下一步建议 */
  suggestions: string[];
  latencyMs: number;
  /** 该服务商下已配置的模型数量 */
  modelCount: number;
  /** 本次探测是否用了未保存的临时密钥 */
  usedTemporaryConfig: boolean;
}
