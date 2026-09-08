/**
 * Production Context 模块（V0.3 Phase 1）。
 *
 * 提供面向 Agent 的生产上下文投影与解析器：
 * - `ProductionContextResolver`：按项目 + Agent 角色加载最小相关投影；
 * - `renderProductionContext`：把投影渲染为注入 System Prompt 的文本块；
 * - 投影类型 + 实体→投影映射函数（供上层测试/调用复用）。
 */
export * from "./production-context-types";
export * from "./production-context-resolver";
export * from "./render-production-context";
