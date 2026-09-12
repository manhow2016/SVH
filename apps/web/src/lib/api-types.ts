/**
 * 后端响应的前端类型。
 *
 * ── 为什么手写而不从后端 import ──
 * 前端构建不应把服务端代码（Prisma、Fastify）拉进 bundle。
 * 这些类型与 `@svh/domain` 的契约对齐，但只保留界面真正消费的字段。
 *
 * 注：这确实是一处「可能漂移」的接缝。它的护栏是端到端验证
 * （验收标准第 1 条会走完整链路），而不是编译期检查。
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

export interface ChatResponse {
  sessionId: string;
  sessionCreated: boolean;
  message: string;
  payload?: MessagePayload;
  state: 'completed' | 'waiting_user' | 'failed';
  analysis: {
    intent: string;
    confidence: number;
    contentType?: string;
    targets: Array<{ kind: string; index?: number; label: string }>;
    mentions: string[];
    rationale?: string;
  };
  toolCalls: ToolCallRecord[];
  contextNotes: string[];
  iterations: number;
}

export interface TaskProgress {
  id: string;
  status: string;
  progress: number;
  progressMessage: string | null;
  errorMessage: string | null;
  skillId: string;
  updatedAt: string;
  terminal: boolean;
}

export interface TaskDetail extends TaskProgress {
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
