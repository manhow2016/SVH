/**
 * Prompt Compiler —— 提示词编译器
 *
 * 对应技术文档第 52 条：
 *
 * ```
 * User Prompt → Intent → Project Context → Asset Context → Task Context
 *             → Prompt Compiler → Model
 * ```
 *
 * ── 编译与「拼接」的区别 ──
 * 朴素的字符串拼接会把项目规范、资产描述、用户要求搅在一起，
 * 模型难以判断哪些是硬约束、哪些是本次的临时要求。
 * 编译则是**按语义分层**：硬约束（品牌规范）先说，本次任务居中，
 * 用户原始表述最后且原样保留 —— 因为用户的用词本身就是重要信号。
 *
 * 局部修改场景（技术文档第 52 条的示例）专门处理：把「改什么」
 * 与「保持什么」分开表达。这是角色一致性得以维持的关键。
 */
import type { IntentAnalysis, ResolvedContext } from '@svh/domain';

import { renderContext } from './context-resolver.js';

/** 编译请求 */
export interface CompilePromptRequest {
  /** 用户原始消息（**必须原样保留**） */
  message: string;
  /** 意图分析结果 */
  analysis: IntentAnalysis;
  /** 已装配的上下文 */
  context: ResolvedContext;
  /** 本轮追加的指令（如上一轮工具结果摘要） */
  extraInstructions?: string[];
}

/** 编译结果 */
export interface CompiledPrompt {
  system: string;
  user: string;
  /** 编译说明，便于调试「为什么模型这样理解」 */
  notes: string[];
}

/** Agent 的基础系统指令 */
const BASE_SYSTEM = `你是 SVH 的内容创作 Agent，负责把用户的创作意图变成可执行的内容生产计划与产物。

你的工作方式：
1. 理解用户想要什么，必要时先用工具了解项目和已有资产，再决定怎么做
2. 通过工具操作：查项目、搜资产、建内容、执行技能。不要凭空编造项目里不存在的东西
3. 需要真正产出内容（图片、视频、脚本、配音等）时，必须通过 skill.execute 提交任务
4. 一次只做用户要求的事，不要顺手扩大范围

表达要求：
- 用简体中文，简洁直接，不说客套话
- 不要暴露技术细节（模型名、参数名、工具名、报错堆栈）
- 需要用户确认时，说清楚「要做什么、大概影响多大」
- 用户的要求无法执行时，说明原因并给出可行的替代方案`;

export class PromptCompiler {
  /**
   * 编译一次调用的提示词。
   *
   * 结构（从硬到软）：
   *   1. 基础系统指令
   *   2. 项目规范（品牌 / 视觉 / 制作规则的硬约束）
   *   3. 当前任务与上下文（内容、@引用资产）
   *   4. 用户原始表述
   *   5. 本轮附加指令
   */
  compile(request: CompilePromptRequest): CompiledPrompt {
    const notes: string[] = [];

    const projectBlock = renderContext(request.context);
    if (projectBlock.length > 0) {
      notes.push('已注入项目规范与上下文');
    }

    // ── 局部修改的特殊表达 ──
    const modificationBlock = this.buildModificationBlock(request.analysis);
    if (modificationBlock !== null) {
      notes.push('按局部修改模式编译（区分「改什么」与「保持什么」）');
    }

    const system = [
      BASE_SYSTEM,
      projectBlock.length > 0 ? `\n${projectBlock}` : '',
      modificationBlock ?? '',
      request.extraInstructions !== undefined && request.extraInstructions.length > 0
        ? `\n## 本轮补充说明\n${request.extraInstructions.map((i) => `- ${i}`).join('\n')}`
        : '',
    ]
      .filter((part) => part.length > 0)
      .join('\n');

    // 用户原始消息原样保留：换词会丢掉用户真实的语感与强调点
    const user = request.message;

    return { system, user, notes };
  }

  /**
   * 局部修改指令块。
   *
   * 技术文档第 52 条的示例：用户说「把女主改成红色衣服」，
   * 编译后应当明确表达「改服装颜色」与「保持脸/发型/年龄/身材/画风」。
   * 这样模型才知道哪些不能动 —— 只说「改成红衣服」很容易连脸一起改掉。
   */
  private buildModificationBlock(analysis: IntentAnalysis): string | null {
    if (analysis.intent !== 'modify_content' && analysis.intent !== 'modify_asset') {
      return null;
    }

    const lines: string[] = ['## 局部修改要求', '这是一次**局部修改**，不是重新创作。'];

    if (analysis.targets.length > 0) {
      lines.push(`修改目标：${analysis.targets.map((t) => t.label).join('、')}`);
    }

    if (analysis.modification !== undefined && analysis.modification.length > 0) {
      lines.push(`修改内容：${analysis.modification}`);
    }

    lines.push(
      '必须遵守：',
      '- 只改动用户明确要求的部分',
      '- 其余部分（人物外观、场景、风格、画面构图）保持不变',
      '- 如果需要重新生成，也要带着原有设定重新生成，而不是从头创作',
    );

    return lines.join('\n');
  }
}

/* -------------------------------------------------------------------------- */
/* Agent 决策契约                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Agent 每轮的决策结构。
 *
 * ── 为什么用「结构化输出」而不是原生 Function Calling ──
 * 原生 Function Calling 需要把工具 Schema 塞进请求体，而三个 Provider
 * 的格式各不相同。改用统一的结构化输出契约后：
 *   - 一套 Schema 走通全部 Provider（JSON Schema / Tool Calling / responseSchema）
 *   - 决策过程可被记录与回放，便于排查「Agent 为什么这么做」
 *   - 不需要为每个适配器各写一遍工具调用协议
 * 代价是多一次文本解析，但换来的是确定性。
 */
export const AGENT_DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    /** 本轮的思考摘要（面向用户展示，不是内部独白） */
    thought: { type: 'string', description: '一句话说明本轮打算做什么' },
    /** 要调用的工具；为空表示直接回复用户 */
    toolCalls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工具名' },
          arguments: { type: 'object', description: '工具入参' },
        },
        required: ['name'],
      },
    },
    /** 面向用户的回复（不再调用工具时必填） */
    reply: { type: 'string', description: '给用户的回复' },
    /** 是否需要用户确认后才能继续 */
    requiresConfirmation: { type: 'boolean' },
    /** 计划（当本轮产出了制作计划时填写） */
    plan: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        rationale: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              skill: { type: 'string' },
              estimate: { type: 'string' },
            },
            required: ['id', 'title'],
          },
        },
      },
      required: ['goal', 'tasks'],
    },
  },
  required: ['thought'],
};

/** 计划中的一项任务 */
export interface DecisionPlanTask {
  id: string;
  title: string;
  skill?: string;
  estimate?: string;
}

/** 从模型返回中解析出的决策 */
export interface AgentDecision {
  thought: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  reply: string;
  requiresConfirmation: boolean;
  plan?: {
    goal: string;
    rationale?: string;
    tasks: DecisionPlanTask[];
  };
}

/**
 * 归一化模型的决策输出。
 *
 * 模型可能给出不完整的结构（缺 toolCalls、arguments 不是对象等），
 * 这里做严格收敛：宁可退化为「直接回复」，也不要带着半个工具调用去执行。
 */
export function normalizeDecision(raw: unknown): AgentDecision {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const thought =
    typeof record.thought === 'string' && record.thought.length > 0
      ? record.thought
      : '继续处理你的请求';

  const toolCalls: AgentDecision['toolCalls'] = [];
  if (Array.isArray(record.toolCalls)) {
    for (const item of record.toolCalls) {
      if (item === null || typeof item !== 'object') continue;
      const call = item as Record<string, unknown>;
      const name = call.name;
      if (typeof name !== 'string' || name.length === 0) continue;

      toolCalls.push({
        name,
        arguments:
          call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
            ? (call.arguments as Record<string, unknown>)
            : {},
      });
    }
  }

  const reply = typeof record.reply === 'string' ? record.reply : '';

  let plan: AgentDecision['plan'];
  if (record.plan !== null && typeof record.plan === 'object') {
    const rawPlan = record.plan as Record<string, unknown>;
    const goal = rawPlan.goal;
    const rawTasks = rawPlan.tasks;
    if (typeof goal === 'string' && Array.isArray(rawTasks)) {
      const tasks: DecisionPlanTask[] = [];
      for (const [index, item] of rawTasks.entries()) {
        if (item === null || typeof item !== 'object') continue;
        const task = item as Record<string, unknown>;
        const title = task.title;
        if (typeof title !== 'string' || title.length === 0) continue;
        tasks.push({
          id: typeof task.id === 'string' && task.id.length > 0 ? task.id : `task_${index + 1}`,
          title,
          ...(typeof task.skill === 'string' ? { skill: task.skill } : {}),
          ...(typeof task.estimate === 'string' ? { estimate: task.estimate } : {}),
        });
      }
      if (tasks.length > 0) {
        plan = {
          goal,
          ...(typeof rawPlan.rationale === 'string' ? { rationale: rawPlan.rationale } : {}),
          tasks,
        };
      }
    }
  }

  return {
    thought,
    toolCalls,
    reply,
    requiresConfirmation: record.requiresConfirmation === true,
    ...(plan !== undefined ? { plan } : {}),
  };
}
