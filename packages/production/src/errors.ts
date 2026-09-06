/**
 * 生产领域错误（文档 §6：领域规则校验失败、实体不存在等）。
 *
 * Service 层校验失败抛 ProductionError，由上层（路由/工具）转为
 * `{ error: string }` 形状回传给模型或前端。
 */
export type ProductionErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class ProductionError extends Error {
  readonly code: ProductionErrorCode;

  constructor(code: ProductionErrorCode, message: string) {
    super(message);
    this.name = "ProductionError";
    this.code = code;
  }
}

/** 领域校验失败快捷构造 */
export function validationError(message: string): ProductionError {
  return new ProductionError("VALIDATION", message);
}

/** 领域冲突（状态机非法跳转、依赖约束不满足）快捷构造 */
export function conflictError(message: string): ProductionError {
  return new ProductionError("CONFLICT", message);
}

/** 实体不存在快捷构造 */
export function notFoundError(entity: string): ProductionError {
  return new ProductionError("NOT_FOUND", `${entity} 不存在`);
}
