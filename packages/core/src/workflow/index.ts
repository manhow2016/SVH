/**
 * @svh/core 的 Workflow 引擎（文档 §11）。
 *
 * 纯状态机 + 事件流：不依赖 DB/HTTP/Agent，节点能力通过 NodeExecutor 注入。
 */
export * from "./workflow-types";
export * from "./workflow-events";
export * from "./workflow-node";
export * from "./workflow-executor";
export * from "./workflow-engine";
