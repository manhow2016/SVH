/**
 * Generation Plan 模块（V0.3 Phase 6）。
 *
 * 把一批镜头描述为批量生成计划（item：shotId/type/priority/dependencies/
 * providerPreference/status），供 server 编排器入队执行。
 */
export * from "./plan-types";
export * from "./build-generation-plan";
