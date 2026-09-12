/**
 * Agent Runtime —— 一轮对话的编排
 *
 * 技术文档第 7 条的完整链路：
 *
 * ```
 * User Message → Intent Analyzer → Context Resolver → Content Type Detection
 *   → Workflow Planner → Skill Selection → Skill Execution → Result → User Review
 * ```
 *
 * ── 多步工具循环 ──
 * 一次对话可能需要多轮「模型决策 → 执行工具 → 把结果回喂模型」，
 * 例如：先 asset.search 找角色，再 skill.execute 生成画面。
 * 因此这里实现一个有上限的循环，而不是一次调用就结束。
 *
 * ── 安全边界 ──
 * - 循环次数上限：防止模型陷入反复调用同一个工具的循环
 * - 单轮工具数上限：防止一次决策里塞进过多调用
 * - 需要确认的工具：不直接执行，转为向用户发出确认请求
 * - 取消信号：全程传导，用户取消后立即停止
 */
import {
  INTENT_LABELS,
  isSvhError,
  type AgentIntent,
  type AgentTool,
  type IntentAnalysis,
  type MessagePayload,
  type PlanPayload,
  type ResolvedContext,
  type ResultCardPayload,
  type ToolCallRecord,
  type ToolExecutionContext,
} from '@svh/domain';

import { ContextResolver } from './context-resolver.js';
import { IntentAnalyzer } from './intent-analyzer.js';
import {
  AGENT_DECISION_SCHEMA,
  PromptCompiler,
  normalizeDecision,
  type AgentDecision,
} from './prompt-compiler.js';
import type { AgentDeps, AgentLogger } from './ports.js';
import { WorkflowPlanner } from './workflow-planner.js';
import { NOOP_AGENT_LOGGER } from './ports.js';

/** 单轮对话的最大工具循环次数 */
const MAX_ITERATIONS = 6;

/** 单次决策允许的工具调用数上限 */
const MAX_TOOL_CALLS_PER_ITERATION = 3;

/** 一轮对话的请求 */
export interface RunTurnRequest {
  projectId: string;
  sessionId?: string | null;
  contentId?: string | null;
  message: string;
  referencedAssetIds?: string[];
  /** 用户会员等级，用于技能权限检查 */
  tier?: 'free' | 'pro' | 'enterprise';
  /** 高成本技能的确认策略；`allow` 仅用于自动化测试 */
  confirmationPolicy?: 'reject' | 'allow';
  /** 取消信号 */
  signal: AbortSignal;
}

/** 一轮对话的产出 */
export interface RunTurnResult {
  /** 面向用户的回复 */
  message: string;
  /** 结构化载荷（计划 / 结果卡片 / 确认请求） */
  payload?: MessagePayload;
  /** 本轮的工具调用记录 */
  toolCalls: ToolCallRecord[];
  /** 终态 */
  state: 'completed' | 'waiting_user' | 'failed';
  /** 意图分析结果（供上层落库到会话） */
  analysis: IntentAnalysis;
  /** 上下文装配说明 */
  contextNotes: string[];
  /** token 估算 */
  estimatedTokens: number;
  /** 使用过的模型 */
  modelIds: string[];
  /** 迭代轮数 */
  iterations: number;
}

/** Agent 运行时选项 */
export interface AgentRuntimeOptions {
  deps: AgentDeps;
  tools: AgentTool[];
  logger?: AgentLogger;
  /** 覆盖上下文解析参数（测试用） */
  contextOptions?: ConstructorParameters<typeof ContextResolver>[1];
}

export class AgentRuntime {
  private readonly deps: AgentDeps;
  private readonly tools: Map<string, AgentTool>;
  private readonly logger: AgentLogger;
  private readonly analyzer: IntentAnalyzer;
  private readonly resolver: ContextResolver;
  private readonly planner: WorkflowPlanner;
  private readonly compiler: PromptCompiler;

  constructor(options: AgentRuntimeOptions) {
    this.deps = options.deps;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.logger = options.logger ?? NOOP_AGENT_LOGGER;
    this.analyzer = new IntentAnalyzer(options.deps, this.logger);
    this.resolver = new ContextResolver(options.deps, options.contextOptions ?? {});
    this.planner = new WorkflowPlanner(options.deps, this.logger);
    this.compiler = new PromptCompiler();
  }

  /**
   * 执行一轮对话。
   *
   * **不抛异常**：任何失败都被转成 `state: 'failed'` 与面向用户的说明。
   * 理由与任务执行器一致：调用方（API）需要对不同终态做不同处理，
   * 用返回值比 try/catch 更能强制处理每种情况。
   */
  async runTurn(request: RunTurnRequest): Promise<RunTurnResult> {
    const toolCalls: ToolCallRecord[] = [];
    const modelIds: string[] = [];
    const confirmationPolicy = request.confirmationPolicy ?? 'reject';

    // 在 try 之外声明：后续步骤失败时仍要返回**已经算出来的**结果，
    // 否则前端看到的是「未识别 + 无上下文」——把「模型不可用」
    // 误报成「听不懂用户」，掩盖了真实原因。
    let analysis: IntentAnalysis = fallbackAnalysis(request.message);
    let contextNotes: string[] = [];
    let estimatedTokens = 0;

    try {
      // ── ⓪ 取消检查 ──
      // 必须在最前面：用户已经取消时不应当再发起任何模型调用或创建内容。
      // 早期实现只在工具循环里检查，导致「取消后仍创建了内容」。
      if (request.signal.aborted) {
        return {
          message: '已取消本次操作。',
          toolCalls: [],
          state: 'completed',
          analysis,
          contextNotes: [],
          estimatedTokens: 0,
          modelIds,
          iterations: 0,
        };
      }

      // ── ① 意图分析 ──
      analysis = await this.analyzer.analyze({
        projectId: request.projectId,
        sessionId: request.sessionId,
        contentId: request.contentId,
        message: request.message,
        ...(request.referencedAssetIds !== undefined
          ? { referencedAssetIds: request.referencedAssetIds }
          : {}),
      });

      this.logger.info('意图分析完成', {
        intent: analysis.intent,
        contentType: analysis.contentType,
        confidence: analysis.confidence,
      });

      // ── ② 信息不足时追问，不猜测 ──
      if (analysis.clarifyingQuestion !== undefined && analysis.clarifyingQuestion.length > 0) {
        // 即使用户意图不明，也要把 @引用 解析出来 ——
        // 追问时能说「我找到了 @苏晚，但不确定你想改什么」，
        // 比一句空泛的「没理解」有用得多。
        const partialContext = await this.resolver.resolve({
          projectId: request.projectId,
          sessionId: request.sessionId,
          contentId: request.contentId,
          message: request.message,
          ...(request.referencedAssetIds !== undefined
            ? { referencedAssetIds: request.referencedAssetIds }
            : {}),
        });

        // 优先告知「引用不存在」——这比「我没理解你的意图」具体得多，
        // 用户一看就知道该改什么。低于此优先级的才是泛泛的追问。
        const missing = extractMissingMentions(analysis.mentions, partialContext);
        if (missing.length > 0) {
          return {
            message:
              `我没有找到 ${missing.map((m) => `@${m}`).join('、')}。` +
              `请确认名称是否正确，或者先创建它。`,
            toolCalls: [],
            state: 'waiting_user',
            analysis,
            contextNotes: partialContext.notes,
            estimatedTokens: partialContext.estimatedTokens,
            modelIds,
            iterations: 0,
          };
        }

        const foundNames = partialContext.referencedAssets.map((a) => `@${a.slug}`).join('、');
        const message =
          foundNames.length > 0
            ? `我找到了 ${foundNames}。${analysis.clarifyingQuestion}`
            : analysis.clarifyingQuestion;

        return {
          message,
          toolCalls: [],
          state: 'waiting_user',
          analysis,
          contextNotes: partialContext.notes,
          estimatedTokens: partialContext.estimatedTokens,
          modelIds,
          iterations: 0,
        };
      }

      // ── ③ 上下文装配（按任务最小化） ──
      // 注意：以下**所有**分支都必须在返回值里带上 contextNotes。
      // 早期实现只在创作路径返回，导致修改类请求的前端拿不到
      // 「加载了哪些上下文」的说明，用户因此无法理解 Agent 的依据。
      const context = await this.resolver.resolve({
        projectId: request.projectId,
        sessionId: request.sessionId,
        contentId: request.contentId,
        message: request.message,
        ...(request.referencedAssetIds !== undefined
          ? { referencedAssetIds: request.referencedAssetIds }
          : {}),
      });
      // 记录到外层变量，异常时也能返回
      contextNotes = context.notes;
      estimatedTokens = context.estimatedTokens;

      // ── ③b 引用不存在时必须告知用户，而不是继续猜 ──
      const missingMentions = extractMissingMentions(analysis.mentions, context);
      if (missingMentions.length > 0) {
        return {
          message:
            `我没有找到 ${missingMentions.map((m) => `@${m}`).join('、')}。` +
            `请确认名称是否正确，或者先创建它。`,
          toolCalls,
          state: 'waiting_user',
          analysis,
          contextNotes: context.notes,
          estimatedTokens: context.estimatedTokens,
          modelIds,
          iterations: 0,
        };
      }

      // ── ④ 创作类意图：先规划流程，把计划呈现给用户 ──
      if (analysis.intent === 'create_content' && analysis.contentType !== undefined) {
        const planResult = await this.handleCreateContent(request, analysis);
        if (planResult !== null) {
          return {
            ...planResult,
            analysis,
            contextNotes: context.notes,
            estimatedTokens: context.estimatedTokens,
            modelIds,
          };
        }
      }

      // ── ⑤ 工具循环 ──
      return await this.runToolLoop({
        request,
        analysis,
        context,
        toolCalls,
        modelIds,
        confirmationPolicy,
      });
    } catch (err) {
      const error = isSvhError(err)
        ? err
        : {
            code: 'INTERNAL_ERROR',
            userMessage: '处理你的请求时出错了，请重试。',
            message: err instanceof Error ? err.message : String(err),
          };

      this.logger.error('Agent 轮次执行失败', {
        error: err instanceof Error ? err.message : String(err),
      });

      return {
        message: error.userMessage,
        toolCalls,
        state: 'failed',
        // 保留已算出的意图与上下文：让用户与前端知道
        // 「Agent 理解对了、上下文也装配了，只是执行阶段失败」
        analysis,
        contextNotes,
        estimatedTokens,
        modelIds,
        iterations: 0,
      };
    }
  }

  /**
   * 创作类意图的处理：规划并呈现计划。
   *
   * 返回 null 表示「不需要在这里停下」——让流程继续走工具循环，
   * 由模型决定下一步（例如用户只是问「帮我做广告要多久」）。
   */
  private async handleCreateContent(
    request: RunTurnRequest,
    analysis: IntentAnalysis,
  ): Promise<Omit<RunTurnResult, 'analysis' | 'contextNotes' | 'estimatedTokens' | 'modelIds'> | null> {
    if (analysis.contentType === undefined) return null;

    let plan;
    try {
      plan = await this.planner.plan({
        projectId: request.projectId,
        analysis,
        contentId: request.contentId,
      });
    } catch (err) {
      // 规划失败不该让整轮失败：退化到工具循环，让模型直接处理
      this.logger.warn('流程规划失败，转为直接处理', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // ── 创建内容记录 ──
    // 先建记录再给计划：用户点「开始制作」时才有明确的挂载对象
    const created = await this.deps.contents.create({
      projectId: request.projectId,
      type: analysis.contentType,
      title: buildContentTitle(analysis),
      // 原样保存用户表述：它是后续所有编译的语义来源
      brief: request.message,
      metadata: analysis.parameters,
    });

    const planPayload: PlanPayload = {
      type: 'plan',
      goal: planPayloadGoal(analysis),
      rationale: plan.rationale,
      tasks: plan.steps.map((step, index) => ({
        id: `task_${index + 1}`,
        title: step.title,
        ...(step.skill !== undefined ? { skill: step.skill } : {}),
        status: 'pending' as const,
        ...(step.estimate !== undefined ? { estimate: step.estimate } : {}),
        dependsOn: [],
      })),
      // 高成本节点较多时先让用户确认整体方案
      requiresApproval: plan.requiresApproval,
    };

    const message = buildPlanMessage(analysis, plan, created.title);

    return {
      message,
      payload: planPayload,
      toolCalls: [],
      state: plan.requiresApproval ? 'waiting_user' : 'completed',
      iterations: 0,
    };
  }

  /**
   * 工具循环：模型决策 → 执行工具 → 结果回喂 → 再决策。
   *
   * 终止条件（任一满足）：
   *   - 模型不再要求调用工具（给出最终回复）
   *   - 达到迭代上限
   *   - 有工具需要用户确认
   *   - 收到取消信号
   */
  private async runToolLoop(input: {
    request: RunTurnRequest;
    analysis: IntentAnalysis;
    context: ResolvedContext;
    toolCalls: ToolCallRecord[];
    modelIds: string[];
    confirmationPolicy: 'reject' | 'allow';
  }): Promise<RunTurnResult> {
    const { request, analysis, context, toolCalls, modelIds, confirmationPolicy } = input;

    // 工具结果累积：每一轮都把它们作为附加说明回喂给模型
    const observations: string[] = [];
    let iterations = 0;
    let lastDecision: AgentDecision | null = null;

    for (let round = 0; round < MAX_ITERATIONS; round += 1) {
      if (request.signal.aborted) {
        return {
          message: '已取消本次操作。',
          toolCalls,
          state: 'completed',
          analysis,
          contextNotes: context.notes,
          estimatedTokens: context.estimatedTokens,
          modelIds,
          iterations,
        };
      }

      iterations = round + 1;

      // ── 编译提示词并请求决策 ──
      const compiled = this.compiler.compile({
        message: request.message,
        analysis,
        context,
        extraInstructions: [
          ...observations,
          this.buildToolInstruction(),
        ],
      });

      const decision = await this.decide(compiled, modelIds);
      lastDecision = decision;

      // ── 模型给出最终回复 ──
      if (decision.toolCalls.length === 0) {
        return {
          message: decision.reply.length > 0 ? decision.reply : decision.thought,
          ...(decision.plan !== undefined
            ? { payload: buildPlanFromDecision(decision) }
            : {}),
          toolCalls,
          state: decision.requiresConfirmation ? 'waiting_user' : 'completed',
          analysis,
          contextNotes: context.notes,
          estimatedTokens: context.estimatedTokens,
          modelIds,
          iterations,
        };
      }

      // ── 执行工具 ──
      const calls = decision.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
      let pendingConfirmation: { tool: AgentTool; record: ToolCallRecord; taskId?: string } | null =
        null;

      for (const call of calls) {
        const tool = this.tools.get(call.name);
        if (tool === undefined) {
          const record: ToolCallRecord = {
            name: call.name,
            arguments: call.arguments,
            status: 'failed',
            error: `工具 ${call.name} 不存在`,
            requiresConfirmation: false,
          };
          toolCalls.push(record);
          observations.push(`工具 ${call.name} 不存在，请改用可用工具`);
          continue;
        }

        const startedAt = Date.now();
        const ctx = this.buildToolContext(request, toolCalls, confirmationPolicy);

        const result = await tool.execute(call.arguments, ctx);
        const durationMs = Date.now() - startedAt;

        const record: ToolCallRecord = {
          name: tool.name,
          arguments: call.arguments,
          status: result.requiresConfirmation === true ? 'rejected' : result.ok ? 'success' : 'failed',
          ...(result.result !== undefined ? { result: result.result } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          requiresConfirmation: result.requiresConfirmation === true,
          durationMs,
        };
        toolCalls.push(record);

        if (result.requiresConfirmation === true) {
          // 需要确认：停止本轮，向用户发出确认请求
          pendingConfirmation = {
            tool,
            record,
            ...(extractPendingTaskId(result.result) !== undefined
              ? { taskId: extractPendingTaskId(result.result) }
              : {}),
          };
          break;
        }

        observations.push(this.summarizeToolResult(tool.name, result));
      }

      if (pendingConfirmation !== null) {
        const { tool, record, taskId } = pendingConfirmation;
        return {
          message:
            record.error ??
            `「${tool.description.split('。')[0] ?? tool.name}」需要你确认后才会执行。`,
          payload: {
            type: 'confirmation_request',
            summary: `即将执行：${tool.name}`,
            impacts: [['操作', tool.name]],
            ...(taskId !== undefined ? { taskId } : {}),
            planTaskIds: taskId !== undefined ? [taskId] : [],
          },
          toolCalls,
          state: 'waiting_user',
          analysis,
          contextNotes: context.notes,
          estimatedTokens: context.estimatedTokens,
          modelIds,
          iterations,
        };
      }
    }

    // 达到迭代上限：给出当前进展而不是静默失败
    this.logger.warn('Agent 达到工具循环上限', { iterations, toolCalls: toolCalls.length });

    return {
      message:
        lastDecision?.reply !== undefined && lastDecision.reply.length > 0
          ? lastDecision.reply
          : '我已经完成了当前能做的步骤。你可以告诉我下一步要做什么。',
      toolCalls,
      state: 'completed',
      analysis,
      contextNotes: context.notes,
      estimatedTokens: context.estimatedTokens,
      modelIds,
      iterations,
    };
  }

  /** 请求模型做出本轮决策 */
  private async decide(
    compiled: { system: string; user: string },
    modelIds: string[],
  ): Promise<AgentDecision> {
    const result = await this.deps.models.generateText({
      prompt: compiled.user,
      system: compiled.system,
      responseSchema: AGENT_DECISION_SCHEMA,
      temperature: 0.3,
      skillId: 'agent.decide',
    });

    if (!modelIds.includes(result.modelId)) modelIds.push(result.modelId);

    return normalizeDecision(result.data);
  }

  /** 构造工具执行上下文 */
  private buildToolContext(
    request: RunTurnRequest,
    toolCalls: ToolCallRecord[],
    confirmationPolicy: 'reject' | 'allow',
  ): ToolExecutionContext {
    return {
      sessionId: request.sessionId ?? null,
      projectId: request.projectId,
      contentId: request.contentId ?? null,
      ...(request.tier !== undefined ? { tier: request.tier } : {}),
      confirmationPolicy,
      signal: request.signal,
      recordCall: (record) => {
        toolCalls.push(record);
      },
    };
  }

  /** 工具说明：让模型知道有哪些工具可用 */
  private buildToolInstruction(): string {
    const lines = ['## 可用工具', '需要操作项目时，在 toolCalls 中指定工具及参数：'];
    for (const tool of this.tools.values()) {
      const props = (tool.parameters.properties ?? {}) as Record<string, unknown>;
      const params = Object.keys(props);
      lines.push(
        `- ${tool.name}${tool.mutating ? '（写操作）' : ''}：${tool.description}` +
          (params.length > 0 ? `\n  参数：${params.join('、')}` : ''),
      );
    }
    lines.push(
      '',
      '若不需要调用工具，直接在 reply 中回复用户，并把 toolCalls 留空。',
      '需要产出图片 / 视频 / 脚本等内容时，必须通过 skill.execute 提交任务。',
    );
    return lines.join('\n');
  }

  /** 把工具结果压缩成一句可回喂给模型的观察 */
  private summarizeToolResult(name: string, result: { ok: boolean; result?: unknown; message?: string; error?: string }): string {
    if (!result.ok) {
      return `工具 ${name} 执行失败：${result.error ?? '未知原因'}`;
    }
    const serialized = result.result !== undefined ? JSON.stringify(result.result).slice(0, 800) : '';
    return `工具 ${name} 执行成功${result.message !== undefined ? `（${result.message}）` : ''}：${serialized}`;
  }
}

/* -------------------------------------------------------------------------- */
/* 文案构造                                                                    */
/* -------------------------------------------------------------------------- */

/** 由意图分析结果生成内容标题 */
function buildContentTitle(analysis: IntentAnalysis): string {
  const parts: string[] = [];
  const duration = analysis.parameters.duration;
  if (typeof duration === 'number') parts.push(`${duration} 秒`);

  const subject = analysis.parameters.subject;
  if (typeof subject === 'string' && subject.length > 0) parts.push(subject);

  parts.push(contentLabel(analysis.contentType));

  return parts.join(' ');
}

const CONTENT_LABELS: Record<string, string> = {
  advertisement: '广告',
  short_video: '短视频',
  short_drama: '短剧',
  digital_human: '数字人口播',
  promo: '宣传片',
  visual_content: '视觉内容',
};

/** 取内容类型的中文名，未知类型回退为「内容」而不是抛错 */
function contentLabel(type: string | undefined): string {
  if (type === undefined) return '内容';
  return CONTENT_LABELS[type] ?? '内容';
}

/** 计划的目标描述 */
function planPayloadGoal(analysis: IntentAnalysis): string {
  const label = contentLabel(analysis.contentType);
  const coverage = analysis.parameters.duration;
  return typeof coverage === 'number' ? `制作一条 ${coverage} 秒的${label}` : `制作一条${label}`;
}

/** 给用户看的一句话说明 */
function buildPlanMessage(
  analysis: IntentAnalysis,
  plan: { steps: Array<{ title: string }>; totalLayers: number; rationale: string; adjustments: string[] },
  title: string,
): string {
  const label = contentLabel(analysis.contentType);
  const lines = [`我理解这是一个${label}需求，已创建「${title}」。`, '', `我计划这样做（${plan.steps.length} 步）：`];

  for (const [index, step] of plan.steps.entries()) {
    lines.push(`${index + 1}. ${step.title}`);
  }

  if (plan.adjustments.length > 0) {
    lines.push('', `针对你的要求做了调整：${plan.adjustments.join('；')}`);
  }

  lines.push('', '确认后我就开始制作。');
  return lines.join('\n');
}

/** 把模型给出的计划转成结构化载荷 */
function buildPlanFromDecision(decision: AgentDecision): PlanPayload {
  const plan = decision.plan;
  return {
    type: 'plan',
    goal: plan?.goal ?? '继续制作',
    ...(plan?.rationale !== undefined ? { rationale: plan.rationale } : {}),
    tasks: (plan?.tasks ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      ...(task.skill !== undefined ? { skill: task.skill } : {}),
      status: 'pending' as const,
      ...(task.estimate !== undefined ? { estimate: task.estimate } : {}),
      dependsOn: [],
    })),
    requiresApproval: decision.requiresConfirmation,
  };
}

/**
 * 找出用户引用了但项目里不存在的资产。
 *
 * 为什么要显式检查：如果 @某某 没找到却继续执行，Agent 会基于
 * 「不存在的资产」做规划，产出的内容与用户预期完全不符。
 * 明确告知比默默猜测对用户更有用。
 */
function extractMissingMentions(
  mentions: string[],
  context: { referencedAssets: Array<{ slug: string }> },
): string[] {
  if (mentions.length === 0) return [];
  const found = new Set(context.referencedAssets.map((a) => a.slug));
  return mentions.filter((m) => !found.has(m));
}

/** 意图分析完全失败时的兜底（保证返回结构完整） */
function fallbackAnalysis(message: string): IntentAnalysis {
  return {
    intent: 'other',
    confidence: 0,
    parameters: {},
    targets: [],
    mentions: [],
    rationale: `无法分析这条消息：${message.slice(0, 50)}`,
  };
}

/** 从工具结果中取出待确认任务 id（高风险技能会先落一条 waiting_user 任务） */
function extractPendingTaskId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const taskId = (result as Record<string, unknown>).taskId;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined;
}

/** 供 API 与测试引用：意图的中文标签 */
export { INTENT_LABELS };
export type { AgentIntent, ResultCardPayload };
