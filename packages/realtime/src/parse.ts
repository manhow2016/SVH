/**
 * Redis Stream 返回结构的防御式解析
 *
 * Redis 客户端的返回类型在结构上是宽松的。事件推送是增强能力：
 * 一条结构异常的事件应当被**丢弃**，而不是抛异常打断整个推送循环，
 * 更不能因为一条坏数据让用户的任务列表卡住。
 */
import { SSE_EVENT_TYPES, type SseEventType } from '@svh/domain';

import type { StreamedEvent } from './ports.js';

/** 一条原始流记录：[id, [field, value, field, value, ...]] */
export type RawStreamEntry = [id: string, fields: string[]];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(SSE_EVENT_TYPES);

/** 是否为合法的事件类型（用类型守卫，避免 `as` 断言） */
function isSseEventType(value: string): value is SseEventType {
  return EVENT_TYPE_SET.has(value);
}

/** JSON 解析失败时返回 null，而不是抛异常 */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 把「字段数组」折成 Map；长度为奇数时忽略最后一个孤立字段 */
function toFieldMap(fields: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (typeof key === 'string' && typeof value === 'string') {
      map.set(key, value);
    }
  }
  return map;
}

/**
 * 解析一条原始流记录。
 *
 * @param entry 原始记录（结构不可信）
 * @param sessionId 订阅方声明的会话 id —— 作为事件的归属会话，
 *   而不是读取流内字段。这样即便流里被写入了别的会话 id，也不会被当真。
 */
export function parseStreamEntry(entry: unknown, sessionId: string): StreamedEvent | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;

  const rawId: unknown = entry[0];
  const rawFields: unknown = entry[1];
  if (typeof rawId !== 'string' || !Array.isArray(rawFields)) return null;

  const fields = toFieldMap(rawFields);

  const type = fields.get('type');
  if (type === undefined || !isSseEventType(type)) return null;

  const parsedSeq = Number.parseInt(fields.get('seq') ?? '', 10);
  const seq = Number.isFinite(parsedSeq) && parsedSeq >= 0 ? parsedSeq : 0;

  const rawData = fields.get('data');

  return {
    streamId: rawId,
    seq,
    type,
    at: fields.get('at') ?? new Date(0).toISOString(),
    sessionId,
    data: rawData === undefined ? null : safeParseJson(rawData),
  };
}

/** 从一条 XREAD / XRANGE 记录中提取 [id, fields]，结构异常返回 null */
function toRawEntry(value: unknown): RawStreamEntry | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const id: unknown = value[0];
  const fields: unknown = value[1];
  if (typeof id !== 'string' || !Array.isArray(fields)) return null;

  const stringFields: string[] = [];
  for (const field of fields) {
    if (typeof field !== 'string') return null;
    stringFields.push(field);
  }
  return [id, stringFields];
}

/**
 * 解析 XREAD 的返回结构：`[[key, [entry, ...]], ...]`，展平为记录数组。
 * 单条记录结构异常时跳过它，保留其余记录。
 */
export function parseXreadReply(raw: unknown): RawStreamEntry[] {
  if (!Array.isArray(raw)) return [];

  const out: RawStreamEntry[] = [];
  for (const stream of raw) {
    if (!Array.isArray(stream) || stream.length < 2) continue;
    const entries: unknown = stream[1];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const parsed = toRawEntry(entry);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

/** 解析 XRANGE / XREVRANGE 的返回结构：`[entry, ...]` */
export function parseRangeReply(raw: unknown): RawStreamEntry[] {
  if (!Array.isArray(raw)) return [];

  const out: RawStreamEntry[] = [];
  for (const entry of raw) {
    const parsed = toRawEntry(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
