import { FileManager } from "@svh/workspace";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "../tool";

interface ListFilesInput {
  path: string;
}

/**
 * list_files：列出工作区目录内容（文档 §17.1）。
 * 输入 { "path": "." }；输出 FileEntry[]。
 */
export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "列出工作区目录中的文件和子目录。参数 path 为相对工作区根目录的目录路径（如 \".\" 或 \"assets\"）。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录相对路径，默认 \".\"" },
    },
    required: ["path"],
  },
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { path } = assertInput(input);
    const fm = new FileManager(context.workspaceId, context.workspaceRoot);
    const entries = await fm.list(path);
    return { output: entries };
  },
};

function assertInput(input: unknown): ListFilesInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.trim() === "") {
    throw new ToolError("INVALID_INPUT", 'list_files: "path" 必填且必须为字符串');
  }
  return { path: obj.path };
}
