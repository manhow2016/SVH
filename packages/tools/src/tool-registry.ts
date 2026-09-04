import type { Tool } from "./tool";

/**
 * Tool Registry（文档 §20）。
 *
 * Agent Runtime 只能通过 ToolRegistry 调用 Tool，
 * 禁止 Agent Runtime 直接调用具体文件工具函数。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}
