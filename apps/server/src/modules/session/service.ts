import { asc, eq } from "drizzle-orm";
import {
  messages,
  sessions,
  type MessageMetadata,
  type MessageRow,
  type SVHDatabase,
} from "@svh/database";
import { randomId, type MessageRole, type Session, type SessionStatus } from "@svh/shared";
import { ERRORS } from "../../lib/errors";

export interface CreateSessionInput {
  title?: string;
}

export interface UpdateSessionInput {
  title?: string;
  modelProviderId?: string;
  modelId?: string;
}

function toSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status as SessionStatus,
    modelProviderId: row.modelProviderId,
    modelId: row.modelId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: MessageRow) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as MessageRole,
    content: row.content,
    toolCallId: row.toolCallId ?? undefined,
    metadata: (row.metadata ?? undefined) as MessageMetadata | undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Session 服务：会话生命周期 + 消息持久化（文档 §21-§23）。
 */
export class SessionService {
  constructor(private readonly db: SVHDatabase) {}

  async create(workspaceId: string, input: CreateSessionInput): Promise<Session> {
    const now = new Date();
    const id = randomId("ses");
    const row: typeof sessions.$inferInsert = {
      id,
      workspaceId,
      title: input.title?.trim() || "新会话",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(sessions).values(row);
    return this.get(id);
  }

  async list(workspaceId: string): Promise<Session[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId))
      .orderBy(asc(sessions.createdAt));
    return rows.map(toSession);
  }

  async get(id: string): Promise<Session> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw ERRORS.SESSION_NOT_FOUND();
    return toSession(row);
  }

  async update(id: string, input: UpdateSessionInput): Promise<Session> {
    const current = await this.get(id);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title.trim() || current.title;
    if (input.modelProviderId !== undefined) patch.modelProviderId = input.modelProviderId;
    if (input.modelId !== undefined) patch.modelId = input.modelId;
    await this.db.update(sessions).set(patch).where(eq(sessions.id, id));
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  async setStatus(id: string, status: SessionStatus): Promise<void> {
    await this.db
      .update(sessions)
      .set({ status, updatedAt: new Date() })
      .where(eq(sessions.id, id));
  }

  // ---------------- 消息 ----------------

  async addUserMessage(sessionId: string, content: string) {
    return this.insertMessage(sessionId, "user", content);
  }

  /** 插入 assistant 消息（流式完成后调用），返回行记录 */
  async addAssistantMessage(sessionId: string, content: string, metadata: MessageMetadata = {}) {
    return this.insertMessage(sessionId, "assistant", content, metadata);
  }

  /** 为已插入的 assistant 消息补充 toolCalls 元数据（多次调用累加） */
  async addToolCallToAssistant(
    sessionId: string,
    assistantMessageId: string,
    toolCall: { id: string; name: string; arguments: string },
  ) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.id, assistantMessageId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const meta = (row.metadata ?? {}) as MessageMetadata;
    const toolCalls = meta.toolCalls ?? [];
    toolCalls.push(toolCall);
    await this.db
      .update(messages)
      .set({ metadata: { ...meta, toolCalls } })
      .where(eq(messages.id, assistantMessageId));
    return { ...row, metadata: { ...meta, toolCalls } };
  }

  async addToolMessage(sessionId: string, metadata: MessageMetadata, toolCallId: string) {
    const content =
      typeof metadata.output === "string"
        ? metadata.output
        : JSON.stringify(metadata.output ?? null);
    return this.insertMessage(sessionId, "tool", content, metadata, toolCallId);
  }

  async listMessages(sessionId: string) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    return rows.map(toMessage);
  }

  private async insertMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    metadata?: MessageMetadata,
    toolCallId?: string,
  ) {
    const row = await this.db
      .insert(messages)
      .values({
        id: randomId("msg"),
        sessionId,
        role,
        content,
        toolCallId,
        metadata,
        createdAt: new Date(),
      })
      .returning();
    return row[0]!;
  }
}
