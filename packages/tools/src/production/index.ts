/**
 * Production Tools（文档 §10）：Agent 通过工具操作生产领域数据。
 *
 * 全部工具以工厂函数创建（依赖注入 ProductionService，组合根在 app.ts），
 * 与 builtin 工具一样注册进 ToolRegistry 后被 Agent 可见。
 */
export * from "./utils";
export * from "./create-project";
export * from "./get-project";
export * from "./update-project";
export * from "./list-projects";
export * from "./create-script";
export * from "./create-episode";
export * from "./list-episodes";
export * from "./get-script";
export * from "./update-script";
export * from "./list-scripts";
export * from "./create-character";
export * from "./update-character";
export * from "./list-characters";
export * from "./create-scene";
export * from "./create-storyboard";
export * from "./update-storyboard";
export * from "./create-shot";
export * from "./update-shot";
export * from "./timeline-utils";
export * from "./create-timeline";
export * from "./get-timeline";
export * from "./auto-create-timeline";
export * from "./add-timeline-track";
export * from "./add-timeline-clip";
export * from "./update-timeline-clip";
export * from "./delete-timeline-clip";
