/**
 * 生产工具公共辅助：输入解析与工作区隔离（文档 §10）。
 *
 * - 输入解析：工具从模型收到 JSON 参数（unknown），先做轻量类型检查，
 *   明显缺字段/类型错时抛 ToolError("INVALID_INPUT")；其余校验交给 ProductionService。
 * - 工作区隔离：Agent 只能操作其当前工作区（ToolContext.workspaceId）内的项目，
 *   跨工作区访问一律报「项目 不存在」（隐藏存在性，与路由层 getOwned 语义一致）。
 */
import { ToolError } from "../tool";
import { notFoundError, type ProductionProject, type ProductionService } from "@svh/production";

/** 将 unknown 输入解析为对象（否则 INVALID_INPUT） */
export function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolError("INVALID_INPUT", "输入必须为对象");
  }
  return input as Record<string, unknown>;
}

/** 必填非空字符串字段 */
export function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError("INVALID_INPUT", `${key} 必须为非空字符串`);
  }
  return value.trim();
}

/** 可选字符串字段（空串转 undefined） */
export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ToolError("INVALID_INPUT", `${key} 必须为字符串`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 可选字符串数组（元素必须为字符串） */
export function optionalStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolError("INVALID_INPUT", `${key} 必须为字符串数组`);
  }
  return value as string[];
}

/** 可选对象字段（非数组对象） */
export function optionalObject(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("INVALID_INPUT", `${key} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

/** 可选数值字段 */
export function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError("INVALID_INPUT", `${key} 必须为数值`);
  }
  return value;
}

/** 必填数值字段 */
export function requiredNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError("INVALID_INPUT", `${key} 必须为数值`);
  }
  return value;
}

/** 项目归属校验：项目必须属于 ToolContext 的当前工作区 */
export async function requireProjectInWorkspace(
  production: ProductionService,
  projectId: string,
  workspaceId: string,
): Promise<ProductionProject> {
  const project = await production.getProject(projectId);
  if (project.workspaceId !== workspaceId) {
    throw notFoundError("项目");
  }
  return project;
}

/** 工具输出包装：直接返回实体/数组（Agent Loop 会自动 JSON 序列化） */
export function asResult(output: unknown): { output: unknown } {
  return { output };
}
