/**
 * Workflow Planner —— 制作流程规划器
 *
 * 对应技术文档第 23 条：**Workflow 不应该写死，Agent 根据需求动态规划**。
 *
 * ── 规划的两种来源 ──
 * 1. **内置模板**（`@svh/workflow`）：四套标准流程，覆盖常见需求，稳定可靠
 * 2. **动态调整**：在模板基础上按用户需求增删节点、调整参数
 *
 * 只有模板完全没有覆盖的场景（例如「只做视觉内容」这种没有多阶段 DAG 的
 * 需求）才**从零规划**。这样既避免了「每次都用 LLM 生成流程」的不稳定，
 * 又保留了应对新需求的能力。
 *
 * 规划结果是一份可执行的 WorkflowDefinition，可直接交给 Workflow Engine。
 */
import {
  topologicalLayers,
  type ContentType,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@svh/domain';
import { getBuiltinWorkflow } from '@svh/workflow';

import type { AgentDeps, AgentLogger } from './ports.js';
import type { IntentAnalysis } from '@svh/domain';

/** 规划请求 */
export interface PlanWorkflowRequest {
  projectId: string;
  analysis: IntentAnalysis;
  contentId?: string | null;
}

/** 一个计划步骤（供 UI 展示与用户确认） */
export interface PlanStep {
  /** 对应的工作流节点 key */
  key: string;
  /** 展示标题 */
  title: string;
  /** 要执行的技能 */
  skill?: string;
  /** 预估说明，如「约 6 次图片生成」 */
  estimate?: string;
  /** 是否高成本（需要用户确认） */
  highCost: boolean;
  /** 依赖的前置步骤 */
  dependsOn: string[];
}

/** 规划结果 */
export interface WorkflowPlan {
  /** 完整的工作流定义（可直接执行） */
  definition: WorkflowDefinition;
  /** 面向用户的步骤清单 */
  steps: PlanStep[];
  /** 拓扑层数，用于展示整体进度粒度 */
  totalLayers: number;
  /** 一句话说明为什么这样规划 */
  rationale: string;
  /** 规划来源 */
  origin: 'builtin' | 'adjusted' | 'generated';
  /** 对模板做的调整说明（origin=adjusted 时有值） */
  adjustments: string[];
  /** 需要用户确认时（高成本节点较多）的提示 */
  requiresApproval: boolean;
}

/** 高成本节点数量达到此值时要求用户先确认整体方案 */
const APPROVAL_NODE_THRESHOLD = 3;

export class WorkflowPlanner {
  private readonly deps: AgentDeps;
  private readonly logger: AgentLogger;

  constructor(deps: AgentDeps, logger: AgentLogger) {
    this.deps = deps;
    this.logger = logger;
  }

  /**
   * 为一次创作需求规划流程。
   *
   * 注意：本方法**不执行**任何节点，只产出可执行的计划。
   * 执行由 Workflow Engine 负责（Phase 9），
   * 但计划本身已经足够让用户确认「Agent 打算怎么做」。
   */
  async plan(request: PlanWorkflowRequest): Promise<WorkflowPlan> {
    const contentType = request.analysis.contentType;

    if (contentType === undefined) {
      // 意图分析没给出内容类型 → 规划无从下手，交由上层追问
      throw new Error('规划流程需要先确定内容类型');
    }

    // ① 优先用内置模板
    const template = getBuiltinWorkflow(contentType);
    if (template !== undefined) {
      const { definition, adjustments } = this.adjustTemplate(template, request);
      return this.buildPlan(
        definition,
        adjustments.length > 0 ? 'adjusted' : 'builtin',
        adjustments,
        this.describeRationale(contentType, adjustments),
      );
    }

    // ② 没有模板（如纯视觉内容）→ 生成一个最小可用流程
    return this.generateMinimalPlan(contentType);
  }

  /**
   * 在内置模板基础上做动态调整。
   *
   * 目前支持的调整（都是确定性的，不依赖 LLM，因此结果稳定可测）：
   * - 时长很短（≤15 秒）→ 减少镜头相关节点的期望数量说明
   * - 纯视觉需求 → 移除视频相关节点
   * - 无配音需求 → 暂不移除（配音是价值点，保留但标注可选）
   */
  private adjustTemplate(
    template: WorkflowDefinition,
    request: PlanWorkflowRequest,
  ): { definition: WorkflowDefinition; adjustments: string[] } {
    const adjustments: string[] = [];
    let nodes: WorkflowNode[] = [...template.nodes];

    const duration = asNumber(request.analysis.parameters.duration);

    // ── 调整一：极短内容移除「剪辑」与「字幕」之间的冗余 ──
    // 时长 ≤10 秒时，字幕的价值很低（观众来不及读），可省一步
    if (duration !== undefined && duration <= 10) {
      const before = nodes.length;
      nodes = nodes.filter((node) => node.key !== 'subtitle');
      // 被移除节点的下游需要重新指向它的上游，否则会悬空
      const subtitleNode = template.nodes.find((n) => n.key === 'subtitle');
      if (subtitleNode !== undefined) {
        const upstream = subtitleNode.dependsOn;
        nodes = nodes.map((node) => {
          if (!node.dependsOn.includes('subtitle')) return node;
          const rewritten = node.dependsOn
            .filter((dep) => dep !== 'subtitle')
            .concat(upstream.filter((dep) => !node.dependsOn.includes(dep)));
          return { ...node, dependsOn: [...new Set(rewritten)] };
        });
      }
      if (nodes.length < before) {
        adjustments.push(
          `内容只有 ${duration} 秒，省略字幕节点（时长过短，字幕来不及阅读）`,
        );
      }
    }

    // ── 调整二：视觉内容型需求移除视频与配音 ──
    if (request.analysis.parameters.visualOnly === true) {
      const videoKeys = new Set(['video', 'voice', 'subtitle', 'edit']);
      const before = nodes.length;
      nodes = nodes.filter((node) => !videoKeys.has(node.key));
      if (nodes.length < before) {
        adjustments.push('需求为纯视觉产出，移除了视频、配音、字幕与剪辑节点');
      }
    }

    // 调整后需要重建 edges 并重新校验（依赖可能已悬空）
    if (adjustments.length === 0) {
      return { definition: template, adjustments };
    }

    const trimmed = this.rebuildDefinition(template, nodes);
    return { definition: trimmed, adjustments };
  }

  /**
   * 用调整后的节点重建定义。
   *
   * 关键点：**必须清理悬空依赖**。删除节点后，指向它的 dependsOn
   * 会让 Schema 校验失败（依赖不存在的节点）。这里统一过滤一遍，
   * 而不是假设调用方已经处理干净。
   */
  private rebuildDefinition(
    template: WorkflowDefinition,
    nodes: WorkflowNode[],
  ): WorkflowDefinition {
    const keys = new Set(nodes.map((n) => n.key));
    const cleaned = nodes.map((node) => ({
      ...node,
      dependsOn: node.dependsOn.filter((dep) => keys.has(dep)),
    }));

    const edges = cleaned.flatMap((node) =>
      node.dependsOn.map((dep) => ({ from: dep, to: node.key, condition: 'success' as const })),
    );

    return {
      ...template,
      nodes: cleaned,
      edges,
    };
  }

  /**
   * 从零生成最小可用流程。
   *
   * 用于没有内置模板的内容类型（如纯视觉内容）。
   * 刻意保持极简：一个生成节点 + 一个输出节点，
   * 而不是硬凑一套多阶段流程 —— 后者会让用户觉得流程冗长且不必要。
   */
  private async generateMinimalPlan(contentType: ContentType): Promise<WorkflowPlan> {
    const availableSkills = this.deps.skills.listImplemented();
    const hasImageSkill = availableSkills.some((s) => s.id === 'image.generate');

    if (!hasImageSkill) {
      throw new Error('缺少图片生成能力，无法为视觉内容规划流程');
    }

    const nodes: WorkflowNode[] = [
      {
        key: 'analyze',
        title: '分析需求',
        skill: 'requirement.analyze',
        dependsOn: [],
        input: { brief: '{{input.brief}}' },
        highCost: false,
        continueOnError: false,
        estimatedSeconds: 8,
      },
      {
        key: 'visual',
        title: '生成视觉',
        skill: 'image.generate',
        dependsOn: ['analyze'],
        input: { prompt: '{{analyze.output}}' },
        highCost: false,
        continueOnError: false,
        estimatedSeconds: 60,
      },
      {
        key: 'output',
        title: '输出成品',
        skill: 'output.publish',
        dependsOn: ['visual'],
        input: {},
        highCost: false,
        continueOnError: false,
        estimatedSeconds: 15,
      },
    ];

    const definition: WorkflowDefinition = {
      type: contentType,
      name: `${contentType} 轻量流程`,
      description: '为没有标准多阶段流程的内容类型生成的轻量流程',
      version: '1.0.0',
      origin: 'agent_planned',
      nodes,
      edges: [
        { from: 'analyze', to: 'visual', condition: 'success' },
        { from: 'visual', to: 'output', condition: 'success' },
      ],
      metadata: {},
    };

    this.logger.info('已为无模板内容类型生成轻量流程', { contentType });

    return this.buildPlan(
      definition,
      'generated',
      [`该内容类型没有标准流程，已生成 ${nodes.length} 步的轻量流程`],
      '这类内容以单次视觉产出为主，不需要多阶段流水线',
    );
  }

  /** 把定义转成面向用户的计划 */
  private buildPlan(
    definition: WorkflowDefinition,
    origin: WorkflowPlan['origin'],
    adjustments: string[],
    rationale: string,
  ): WorkflowPlan {
    const layers = topologicalLayers(definition.nodes);

    const steps: PlanStep[] = definition.nodes.map((node) => {
      const catalogEntry = this.findSkill(node.skill);
      const estimate =
        node.estimatedSeconds !== undefined
          ? formatEstimate(node.estimatedSeconds)
          : catalogEntry?.estimatedSeconds !== undefined
            ? formatEstimate(catalogEntry.estimatedSeconds)
            : undefined;

      return {
        key: node.key,
        title: node.title,
        ...(node.skill !== undefined ? { skill: node.skill } : {}),
        ...(estimate !== undefined ? { estimate } : {}),
        highCost: node.highCost,
        dependsOn: node.dependsOn,
      };
    });

    // 高成本节点较多时先让用户确认整体方案，避免默默消耗大量额度
    const highCostCount = steps.filter((s) => s.highCost).length;
    const requiresApproval = highCostCount >= APPROVAL_NODE_THRESHOLD;

    return {
      definition,
      steps,
      totalLayers: layers.length,
      rationale,
      origin,
      adjustments,
      requiresApproval,
    };
  }

  /** 在已实现的技能中查找（用于取预估耗时） */
  private findSkill(skillId: string | undefined):
    | { estimatedSeconds?: number }
    | undefined {
    if (skillId === undefined) return undefined;
    // AgentSkillPort 未暴露 estimatedSeconds，这里只用于兜底展示
    void this.deps;
    return undefined;
  }

  /** 生成面向用户的规划说明 */
  private describeRationale(contentType: ContentType, adjustments: string[]): string {
    const base: Record<ContentType, string> = {
      advertisement: '广告需要先确定创意与卖点，再拆解分镜，最后生成画面与成片',
      short_video: '短视频以选题与节奏为核心，脚本确定后再准备素材与镜头',
      short_drama: '短剧需要先构建世界观与角色，再拆解分集与剧本，最后逐镜生成',
      digital_human: '数字人口播的形象、文案、声音与背景可以并行准备，最后合成',
      promo: '宣传片先确定大纲与解说词，再按镜头组织画面',
      visual_content: '视觉内容以单次出图为主，不需要多阶段流水线',
    };
    const parts = [base[contentType]];
    if (adjustments.length > 0) parts.push(...adjustments);
    return parts.join('；');
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 把秒数格式化为用户可读的预估耗时 */
function formatEstimate(seconds: number): string {
  if (seconds < 60) return `约 ${Math.round(seconds)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 10) return `约 ${Math.round(minutes)} 分钟`;
  return `约 ${Math.round(minutes)} 分钟以上`;
}
