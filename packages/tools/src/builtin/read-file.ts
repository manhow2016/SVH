import { FileManager } from "@svh/workspace";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "../tool";

interface ReadFileInput {
  path: string;
}

/**
 * read_file：读取文本文件内容（文档 §17.2）。
 * 输入 { "path": "script.md" }；输出 { path, content }。
 */
export const readFileTool: Tool = {
  name: "read_file",
  description: "读取工作区内的文本文件内容。参数 path 为相对工作区根目录的文件路径。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: '文件相对路径，如 "script.md"' },
    },
    required: ["path"],
  },
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { path } = assertInput(input);
    const fm = new FileManager(context.workspaceId, context.workspaceRoot);
    const file = await fm.read(path);
    return { output: file };
  },
};

function assertInput(input: unknown): ReadFileInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.trim() === "") {
    throw new ToolError("INVALID_INPUT", 'read_file: "path" 必填且必须为字符串');
  }
  return { path: obj.path };
}
