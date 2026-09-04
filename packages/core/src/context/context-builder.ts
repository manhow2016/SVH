import { desc, eq } from "drizzle-orm";
import { messages, type SVHDatabase } from "@svh/database";
import type { ChatMessage } from "@svh/providers";
import { FileManager, type WorkspaceManager } from "@svh/workspace";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/default-system-prompt";
import type { AgentRunInput } from "../agent/agent-types";
import type { BuiltContext } from "./context-types";

const DEFAULT_MAX_HISTORY_MESSAGES = 50;

export interface ContextBuilderOptions {
  db: SVHDatabase;
  workspaceManager: WorkspaceManager;
  /** 最近 N 条消息（文档 §27，默认 50） */
  maxHistoryMessages?: number;
}

/**
 * Context Builder（文档 §24、§26、§27）。
 *
 * 构建顺序：System Prompt → VIDEO_AGENTS.md → Workspace Summary
 * → 最近 50 条历史消息 → 当前用户消息。
 */
export class ContextBuilder {
  private readonly db: SVHDatabase;
  private readonly workspaceManager: WorkspaceManager;
  private readonly maxHistoryMessages: number;

  constructor(options: ContextBuilderOptions) {
    this.db = options.db;
    this.workspaceManager = options.workspaceManager;
    this.maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  }

  async build(input: AgentRunInput): Promise<BuiltContext> {
    const ws = await this.workspaceManager.get(input.workspaceId);

    // 1. System Prompt（默认）
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;

    // 2. VIDEO_AGENTS.md（若存在则作为工作区指令扩展）
    const fm = new FileManager(ws.id, ws.rootPath);
    let hasWorkspaceInstructions = false;
    if (await fm.exists("VIDEO_AGENTS.md")) {
      const file = await fm.read("VIDEO_AGENTS.md");
      hasWorkspaceInstructions = true;
      systemPrompt = `${systemPrompt}\n\n===== Workspace Instructions (VIDEO_AGENTS.md) =====\n\n${file.content}`;
    }

    // 3. Workspace Summary（根目录文件列表）
    const summary = await this.buildWorkspaceSummary(fm);
    systemPrompt = `${systemPrompt}\n\n===== Workspace Summary =====\n\n${summary}`;

    // 4. 最近 N 条历史消息
    const history = await this.loadHistory(input.sessionId);
    const built: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    for (const msg of history) {
      if (msg.role === "user") {
        built.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        const meta = (msg.metadata ?? {}) as {
          toolCalls?: Array<{ id: string; name: string; arguments: string }>;
        };
        built.push({
          role: "assistant",
          content: msg.content === "" ? null : msg.content,
          toolCalls: meta.toolCalls?.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
      } else if (msg.role === "tool") {
        const meta = (msg.metadata ?? {}) as { toolCallId?: string };
        built.push({
          role: "tool",
          content: msg.content,
          toolCallId: msg.toolCallId ?? meta.toolCallId,
        });
      }
      // system 角色历史消息跳过
    }

    // 5. 当前用户消息
    built.push({ role: "user", content: input.userMessage });

    return { messages: built, systemPrompt, hasWorkspaceInstructions };
  }

  /** 从数据库读取最近 N 条消息（恢复时间顺序） */
  private async loadHistory(sessionId: string) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(this.maxHistoryMessages);
    return rows.reverse();
  }

  /** 构造简洁的 Workspace Summary（根目录文件状态） */
  private async buildWorkspaceSummary(fm: FileManager): Promise<string> {
    let entriesText: string;
    try {
      const entries = await fm.list(".");
      if (entries.length === 0) {
        entriesText = "- (empty)";
      } else {
        entriesText = entries
          .map((e) => `- ${e.path}${e.type === "directory" ? "/" : ""} (${e.type})`)
          .join("\n");
      }
    } catch {
      entriesText = "- (unavailable)";
    }
    return `Current files in workspace root:\n${entriesText}`;
  }
}
