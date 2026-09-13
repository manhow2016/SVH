/**
 * 会话消息写入
 *
 * ── 为什么收在数据库包 ──
 * 会话消息有两个写入方：API（Agent 轮次的回复）与 **Worker**（任务成功后追加
 * 结果卡）。两边各写一份 `prisma.sessionMessage.create` 就会出现「kind 收敛」
 * 「payload 的 JSON 类型断言」这类细节的重复 —— 而重复的写入代码最危险的地方是
 * 它们会**慢慢分叉**：一边补了字段校验，另一边没有，产出的消息形状从此不一致，
 * 前端还得分两种情况解析。
 *
 * 因此落库的唯一入口是这里的 `appendSessionMessage`。
 */
import { MESSAGE_KINDS, type MessageKind } from '@svh/domain';

import { prisma } from './client.js';
import type { Prisma } from './generated/prisma/client.js';

/**
 * 追加会话消息的入参。
 *
 * 刻意**不**直接用领域层的 `AppendMessageInput`（那要求 `kind` 已是枚举、
 * `payload` 已是合法的结构化载荷）：调用方（Agent 端口、Worker）拿到的
 * `kind` 是宽松字符串、`payload` 是未经校验的对象，让它们各自先收窄一遍
 * 就又变成了「多处实现」。收敛放在这里，一处生效。
 */
export interface AppendSessionMessageInput {
  sessionId: string;
  role: 'user' | 'agent' | 'system' | 'tool';
  direction: 'inbound' | 'outbound';
  /** 宽松字符串；落库前收敛为领域枚举，未知值退回 text */
  kind: string;
  content: string;
  /** 结构化载荷（语义由调用方保证：计划、结果卡、确认请求……） */
  payload?: unknown;
  toolCalls?: unknown;
  taskId?: string;
  tokens?: number;
  modelId?: string;
}

export interface AppendSessionMessageResult {
  id: string;
}

/**
 * 追加一条会话消息。
 *
 * `kind` 在端口侧是宽松字符串（调用方只关心语义），落库前收敛为领域枚举；
 * 未知值退回 `text`，避免写入非法枚举把整条消息丢掉。
 */
export async function appendSessionMessage(
  input: AppendSessionMessageInput,
): Promise<AppendSessionMessageResult> {
  const kind = (MESSAGE_KINDS as readonly string[]).includes(input.kind)
    ? (input.kind as MessageKind)
    : 'text';

  const row = await prisma.sessionMessage.create({
    data: {
      sessionId: input.sessionId,
      role: input.role,
      direction: input.direction,
      kind,
      content: input.content,
      ...(input.payload !== undefined ? { payload: input.payload as Prisma.InputJsonValue } : {}),
      ...(input.toolCalls !== undefined
        ? { toolCalls: input.toolCalls as Prisma.InputJsonValue }
        : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    },
    select: { id: true },
  });

  return { id: row.id };
}
