/**
 * Skill 运行时依赖（依赖注入容器）
 *
 * ── 为什么用注入而不是直接 import ──
 * Skill 需要数据库、模型路由、密钥、存储。若在 Skill 里直接 `import { prisma }`，
 * 会有两个后果：
 *   1. Skill 无法脱离真实数据库做单测（审计结论 ②：端口/适配器隔离）
 *   2. 换持久化或换模型层时要改所有 Skill
 *
 * 因此把能力收敛为一个 `SkillDeps` 对象，由 apps/worker 在启动时装配。
 * Skill 只依赖接口，不依赖具体实现。
 *
 * 注意：`@svh/skills` 对 database / model 的依赖是 **`import type` 与
 * devDependency**，运行时不绑定具体实例（见 package.json）。
 */
import type { ModelInvokeRequest, ModelInvokeResult } from '@svh/domain';
import type { ModelDescriptor } from '@svh/model';

/** 模型调用入口（由 Model Router 实现） */
export interface SkillModelPort {
  /**
   * 调用模型。
   *
   * @param context 业务上下文（taskId / skillId），由 Skill 传入以便
   *                `model_tasks` 能做成本归因。技能实现若不传，
   *                该次调用仍会记录，只是无法关联到具体任务。
   */
  invoke(
    request: ModelInvokeRequest,
    context?: { taskId?: string | null; skillId?: string | null; contentId?: string | null; projectId?: string | null },
  ): Promise<ModelInvokeResult>;
  /** 当前可用的模型目录快照，供 Skill 判断是否具备某能力 */
  listModels(): ModelDescriptor[];
}

/**
 * 资产端口。
 *
 * 用「窄接口」而不是把整个仓储对象塞进来：Skill 只能看到自己该用的能力，
 * 避免 Skill 越权操作不相关数据。
 */
export interface SkillAssetPort {
  create(input: {
    projectId: string;
    type: string;
    name: string;
    slug?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    files?: unknown[];
    coverUrl?: string | null;
    sourceContentId?: string | null;
    changelog?: string;
  }): Promise<{ id: string; slug: string; version: number }>;

  update(input: {
    assetId: string;
    patch: {
      name?: string;
      description?: string;
      metadata?: Record<string, unknown>;
      tags?: string[];
      files?: unknown[];
      coverUrl?: string | null;
      status?: 'active' | 'draft' | 'archived';
    };
    changelog?: string;
  }): Promise<{ id: string; version: number }>;

  /** 按 slug 在项目内查找（@引用 解析） */
  findBySlug(
    projectId: string,
    slug: string,
  ): Promise<{ id: string; slug: string; name: string; type: string; metadata: unknown } | null>;

  /** 按类型列出项目资产（供 Skill 复用已有角色 / 场景） */
  listByProject(
    projectId: string,
    filter?: { type?: string; limit?: number },
  ): Promise<Array<{ id: string; slug: string; name: string; type: string; metadata: unknown }>>;
}

/** 内容端口 */
export interface SkillContentPort {
  get(contentId: string): Promise<{
    id: string;
    projectId: string;
    type: string;
    title: string;
    brief: string;
    metadata: Record<string, unknown>;
    status: string;
  } | null>;

  /** 更新内容（含状态推进） */
  update(input: {
    contentId: string;
    patch: {
      title?: string;
      brief?: string;
      metadata?: Record<string, unknown>;
      status?: string;
    };
    changelog?: string;
  }): Promise<void>;

  /** 写入内容的产出物清单（成片 / 封面等） */
  addOutput(input: {
    contentId: string;
    projectId: string;
    name: string;
    type: 'image' | 'video' | 'audio' | 'subtitle' | 'project' | 'text';
    assetId?: string | null;
    storage?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  }): Promise<{ outputId: string }>;
}

/** 项目记忆端口：Skill 生成前需要读取品牌 / 视觉规范 */
export interface SkillProjectPort {
  getMemory(projectId: string): Promise<Record<string, unknown>>;
}

/** 项目记忆更新（受控：只允许 Skill 写入白名单内的片段） */
export interface SkillProjectWritePort {
  mergeMemory(projectId: string, patch: Record<string, unknown>): Promise<void>;
}

/** 时序记录端口：模型调用落库（model_tasks） */
export interface SkillModelRecordPort {
  record(input: {
    providerId: string;
    modelId: string;
    capability: string;
    prompt: string;
    params: Record<string, unknown>;
    status: 'succeeded' | 'failed';
    result?: Record<string, unknown>;
    error?: string;
    latencyMs: number;
    usage?: Record<string, unknown>;
    attempts: number;
    attemptChain: unknown[];
  }): Promise<void>;
}

/** Skill 可用的全部外部能力 */
export interface SkillDeps {
  models: SkillModelPort;
  assets: SkillAssetPort;
  contents: SkillContentPort;
  projects: SkillProjectPort & SkillProjectWritePort;
  /** 可选的模型调用记录（未提供时不记录） */
  modelRecords?: SkillModelRecordPort;
}

/** Skill 执行日志接口（由 Worker 注入，避免引入日志库耦合） */
export interface SkillLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** 执行上下文：由 Skill Executor 构造并传给 Skill 实现 */
export interface SkillExecutionContext {
  taskId: string;
  projectId: string;
  contentId?: string | null;
  sessionId?: string | null;
  /** 第几次尝试，从 1 开始 */
  attempt: number;
  /** 上一次尝试的失败原因（重试时回喂，让 Skill 有机会改变策略） */
  previousError?: string | null;
  deps: SkillDeps;
  logger: SkillLogger;
  signal: AbortSignal;
  /** 上报进度（0~100，单调不减由仓储层保证） */
  reportProgress(progress: number, message?: string): Promise<void>;
  /** 记录子步骤 */
  step(name: string, detail?: Record<string, unknown>): Promise<void>;
}
