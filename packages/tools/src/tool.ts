/**
 * Tool 抽象（文档 §18-§19）。
 *
 * Tool 只依赖纯数据上下文，禁止访问 HTTP / React / Fastify。
 */
export interface ToolContext {
  workspaceId: string;
  sessionId: string;
  /** workspace 根目录（由 Agent Runtime 从 Workspace Manager 解析） */
  workspaceRoot: string;
}

export interface ToolResult {
  output: unknown;
  /** 若工具修改了文件系统，返回受影响相对路径（触发 workspace.changed 事件） */
  changedPath?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema 输入定义 */
  inputSchema: object;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export type ToolErrorCode = "INVALID_INPUT" | "TOOL_EXECUTION_FAILED";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}
