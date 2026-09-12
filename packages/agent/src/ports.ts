/**
 * Agent 的依赖端口
 *
 * 与 `@svh/skills` 同样的思路（审计结论 ②：端口/适配器隔离）：
 * Agent 只依赖接口，不依赖 Prisma / Fastify。
 * 因此本包可以脱离数据库做完整的单测，而装配工作留给 apps/api。
 */
import type { ResolvedContext } from '@svh/domain';

/** 资产摘要（轻量，不含完整 metadata） */
export interface AssetSummary {
  id: string;
  slug: string;
  name: string;
  type: string;
  /** 一句话摘要，用于让模型知道这个资产是什么 */
  summary: string;
}

/** 项目记忆端口 */
export interface AgentProjectPort {
  getMemory(projectId: string): Promise<Record<string, unknown>>;
  /** 项目基本信息，用于让 Agent 知道自己在哪个项目里工作 */
  getProject(projectId: string): Promise<{ id: string; name: string; description: string } | null>;
  /** 合并项目记忆（Agent 学到的新偏好写回） */
  mergeMemory(projectId: string, patch: Record<string, unknown>): Promise<void>;
}

/** 资产端口 */
export interface AgentAssetPort {
  /** 按 slug 精确查找（@引用 解析） */
  findBySlugs(projectId: string, slugs: string[]): Promise<AssetSummary[]>;
  /** 列出项目资产摘要（供 Agent 了解可用素材） */
  listSummaries(
    projectId: string,
    filter?: { type?: string; limit?: number },
  ): Promise<AssetSummary[]>;
  /** 关键词搜索 */
  search(projectId: string, query: string, filter?: { type?: string; limit?: number }): Promise<AssetSummary[]>;
}

/** 内容端口 */
export interface AgentContentPort {
  get(contentId: string): Promise<ResolvedContext['content']>;
  list(
    projectId: string,
    filter?: { limit?: number; status?: string },
  ): Promise<Array<{ id: string; type: string; title: string; status: string; updatedAt: string }>>;
  /**
   * 创建内容。
   *
   * Agent 通过 `content.create` 工具调用它。注意它**只创建记录与参数**，
   * 不触发生成 —— 生成始终走 skill.execute 的任务链路。
   */
  create(input: {
    projectId: string;
    type: string;
    title: string;
    brief?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; type: string; title: string }>;
}

/** 会话端口 */
export interface AgentSessionPort {
  /** 取最近若干轮消息（**只取最近 N 条**，不加载整个会话） */
  recentMessages(
    sessionId: string,
    limit: number,
  ): Promise<Array<{ role: string; content: string; kind: string; createdAt: string }>>;
  /** 记录一条消息 */
  appendMessage(input: {
    sessionId: string;
    role: 'user' | 'agent' | 'system' | 'tool';
    direction: 'inbound' | 'outbound';
    kind: string;
    content: string;
    payload?: unknown;
    toolCalls?: unknown;
    tokens?: number;
    modelId?: string;
  }): Promise<void>;
  /** 更新会话状态 */
  updateState(sessionId: string, patch: { agentState?: string; contextSnapshot?: unknown }): Promise<void>;
  /** 确保会话存在（不存在则创建） */
  ensureSession(input: {
    sessionId?: string | null;
    projectId: string;
    contentId?: string | null;
    title?: string;
  }): Promise<{ id: string; created: boolean }>;
}

/** 技能端口：Agent 需要知道有哪些能力可用 */
export interface AgentSkillPort {
  /** 已实现的技能清单（供 Planner 规划与 LLM 选择） */
  listImplemented(): Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    risk: 'low' | 'medium' | 'high';
    accessTier: 'free' | 'pro' | 'enterprise';
    capabilities: readonly string[];
    aliases: readonly string[];
    userHint?: string;
  }>;
}

/** 任务端口：Agent 通过它把技能变成任务 */
export interface AgentTaskPort {
  /**
   * 创建并入队一个技能任务。
   *
   * `initialStatus` 为 `waiting_user` 时，任务会被创建但**不入队**，
   * 等待用户确认后由 `POST /api/agent/sessions/:id/confirm` 放行。
   */
  enqueue(input: {
    skillId: string;
    projectId: string;
    input: Record<string, unknown>;
    contentId?: string | null;
    sessionId?: string | null;
    idempotencyKey?: string | null;
    initialStatus?: 'pending' | 'waiting_user';
  }): Promise<{ taskId: string; status: string; deduplicated: boolean }>;
}

/** 模型端口 */
export interface AgentModelPort {
  /** 文本生成（可选带结构化输出约束） */
  generateText(input: {
    prompt: string;
    system?: string;
    responseSchema?: Record<string, unknown>;
    /** 温度；规划类任务应调低 */
    temperature?: number;
    taskId?: string | null;
    skillId?: string | null;
  }): Promise<{ text: string; data?: unknown; modelId: string; fallbackNote?: string }>;
}

/** Agent 的全部外部依赖 */
export interface AgentDeps {
  projects: AgentProjectPort;
  assets: AgentAssetPort;
  contents: AgentContentPort;
  sessions: AgentSessionPort;
  skills: AgentSkillPort;
  tasks: AgentTaskPort;
  models: AgentModelPort;
}

/** 日志接口 */
export interface AgentLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** 空日志器 */
export const NOOP_AGENT_LOGGER: AgentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
