import { FileManager } from "@svh/workspace";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "../tool";

interface WriteFileInput {
  path: string;
  content: string;
}

/**
 * write_file：写入文件（文档 §17.3）。
 * - 自动创建不存在的父目录
 * - 覆盖已有文件
 * - 返回最终路径
 * 执行成功后触发 workspace.changed。
 */
export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "写入（创建或覆盖）工作区内的文本文件，父目录不存在时会自动创建。参数 path 为相对路径，content 为文件内容。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件相对路径，如 \"script.md\"" },
      content: { type: "string", description: "文件完整内容" },
    },
    required: ["path", "content"],
  },
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { path, content } = assertInput(input);
    const fm = new FileManager(context.workspaceId, context.workspaceRoot);
    const result = await fm.write(path, content);
    return { output: result, changedPath: result.path };
  },
};

function assertInput(input: unknown): WriteFileInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.trim() === "") {
    throw new ToolError("INVALID_INPUT", 'write_file: "path" 必填且必须为字符串');
  }
  if (typeof obj.content !== "string") {
    throw new ToolError("INVALID_INPUT", 'write_file: "content" 必填且必须为字符串');
  }
  return { path: obj.path, content: obj.content };
}
