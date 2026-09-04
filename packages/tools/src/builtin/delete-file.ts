import { FileManager } from "@svh/workspace";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "../tool";

interface DeleteFileInput {
  path: string;
}

/**
 * delete_file：删除工作区内的文件（文档 §17.4）。
 * 删除成功后触发 workspace.changed。
 */
export const deleteFileTool: Tool = {
  name: "delete_file",
  description: "删除工作区内的文件（不允许删除目录）。参数 path 为相对工作区根目录的文件路径。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件相对路径，如 \"script.md\"" },
    },
    required: ["path"],
  },
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { path } = assertInput(input);
    const fm = new FileManager(context.workspaceId, context.workspaceRoot);
    const result = await fm.delete(path);
    return { output: result, changedPath: result.path };
  },
};

function assertInput(input: unknown): DeleteFileInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.trim() === "") {
    throw new ToolError("INVALID_INPUT", 'delete_file: "path" 必填且必须为字符串');
  }
  return { path: obj.path };
}
