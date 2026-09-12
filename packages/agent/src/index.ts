/**
 * @svh/agent —— Creative Agent
 *
 * 技术文档第 6~8、50~56 条的落点。本包把前面阶段的成果串成一条链路：
 *
 * ```
 * 用户消息
 *   → IntentAnalyzer    识别意图与内容类型
 *   → ContextResolver   按任务最小化装配上下文（不加载整个项目）
 *   → WorkflowPlanner   基于模板动态规划制作流程
 *   → PromptCompiler    分层编译提示词
 *   → AgentRuntime      多步工具循环（模型决策 → 工具执行 → 结果回喂）
 *   → 结果 / 计划 / 确认请求
 * ```
 *
 * ── 设计边界 ──
 * 与 `@svh/skills` 一致：本包**不 import 数据库或 HTTP 框架**，
 * 只依赖 `AgentDeps` 注入的端口，因此可以脱离数据库做完整单测。
 * 装配工作留给 apps/api。
 */
export { AgentRuntime } from './runtime.js';
export type { AgentRuntimeOptions, RunTurnRequest, RunTurnResult } from './runtime.js';

export {
  ContextResolver,
  estimateTokens,
  parseMentions,
  renderContext,
  summarizeAsset,
} from './context-resolver.js';
export type { ContextResolverOptions, ResolveContextRequest } from './context-resolver.js';

export {
  IntentAnalyzer,
  extractAudience,
  extractDuration,
  extractEpisodes,
  extractIndex,
  extractStyle,
  matchByRules,
  normalizeModelAnalysis,
} from './intent-analyzer.js';
export type { AnalyzeIntentRequest } from './intent-analyzer.js';

export { WorkflowPlanner } from './workflow-planner.js';
export type { PlanStep, PlanWorkflowRequest, WorkflowPlan } from './workflow-planner.js';

export {
  AGENT_DECISION_SCHEMA,
  PromptCompiler,
  normalizeDecision,
} from './prompt-compiler.js';
export type { AgentDecision, CompiledPrompt, CompilePromptRequest, DecisionPlanTask } from './prompt-compiler.js';

export { AGENT_TOOL_NAMES, buildAgentTools } from './tools.js';
export type { BuildToolsOptions } from './tools.js';

export { NOOP_AGENT_LOGGER } from './ports.js';
export type {
  AgentAssetPort,
  AgentContentPort,
  AgentDeps,
  AgentLogger,
  AgentModelPort,
  AgentProjectPort,
  AgentSessionPort,
  AgentSkillPort,
  AgentTaskPort,
  AssetSummary,
} from './ports.js';
