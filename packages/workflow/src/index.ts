/**
 * @svh/workflow —— SVH 内置工作流定义
 *
 * 本包只包含**纯数据**的 Workflow 定义（DAG 描述），不依赖数据库、不依赖
 * 队列、不依赖 Agent。执行推进由 Workflow Engine 完成
 * （见 @svh/domain 的 topologicalLayers / computeReadyNodes / isRunFinished）。
 *
 * 这样划分的原因（审计结论）：
 * - Workflow **必须独立于 Agent**，Agent 只负责规划出这份描述；
 * - 图算法收敛为一份**不依赖 DB 的纯函数核心**，避免出现重复实现与死代码。
 *
 * 四套内置流程对应技术文档第 24~27 条。
 */
export { advertisementWorkflow } from './advertisement.js';
export { shortVideoWorkflow } from './short-video.js';
export { shortDramaWorkflow } from './short-drama.js';
export { digitalHumanWorkflow } from './digital-human.js';
export { defineWorkflow } from './define.js';
export type { NodeSpec } from './define.js';

import { advertisementWorkflow } from './advertisement.js';
import { shortVideoWorkflow } from './short-video.js';
import { shortDramaWorkflow } from './short-drama.js';
import { digitalHumanWorkflow } from './digital-human.js';
import type { ContentType, WorkflowDefinition } from '@svh/domain';

/**
 * 内容类型 → 内置工作流模板。
 *
 * 说明：`visual_content`（海报 / Banner 等纯视觉内容）没有多阶段 DAG，
 * 走的是「直接生成视觉」的轻量路径，因此此处不提供模板 ——
 * 该类型的规划由 Agent 按需生成单节点工作流，而不是硬塞一套流程。
 */
export const BUILTIN_WORKFLOWS: Partial<Record<ContentType, WorkflowDefinition>> = {
  advertisement: advertisementWorkflow,
  short_video: shortVideoWorkflow,
  short_drama: shortDramaWorkflow,
  digital_human: digitalHumanWorkflow,
};

/** 按内容类型取内置工作流模板 */
export function getBuiltinWorkflow(type: ContentType): WorkflowDefinition | undefined {
  return BUILTIN_WORKFLOWS[type];
}

/** 全部内置工作流列表（用于 seed 与 `/技能` 展示） */
export function listBuiltinWorkflows(): WorkflowDefinition[] {
  return Object.values(BUILTIN_WORKFLOWS).filter(
    (wf): wf is WorkflowDefinition => wf !== undefined,
  );
}
