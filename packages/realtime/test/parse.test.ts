/**
 * 事件解析边界测试
 *
 * 解析必须**防御式**：Redis 的返回结构在类型层面是宽松的，而事件推送
 * 属于增强能力 —— 一条结构异常的事件应当被丢弃，而不是抛异常打断整个推送。
 */
import { describe, expect, it } from 'vitest';

import { isStreamIdAfter, parseRangeReply, parseStreamEntry, parseXreadReply } from '../src/index.js';

/** 构造一条合法的原始流记录 */
function entry(id: string, overrides: Record<string, string> = {}): [string, string[]] {
  const fields = {
    type: 'task.progress',
    at: '2026-09-12T00:00:00.000Z',
    sessionId: 'sess_a',
    seq: '7',
    data: '{"progress":42}',
    ...overrides,
  };
  return [id, Object.entries(fields).flat()];
}

describe('parseStreamEntry', () => {
  it('解析合法的流记录', () => {
    const parsed = parseStreamEntry(entry('1700000000000-0'), 'sess_a');
    expect(parsed).not.toBeNull();
    expect(parsed?.streamId).toBe('1700000000000-0');
    expect(parsed?.seq).toBe(7);
    expect(parsed?.type).toBe('task.progress');
    expect(parsed?.data).toEqual({ progress: 42 });
  });

  it('以订阅的会话为准，忽略流内伪造的 sessionId', () => {
    // 这是会话隔离的关键：即便流里被写入了别的会话 id，也不能照单全收
    const parsed = parseStreamEntry(entry('1-0', { sessionId: 'sess_b' }), 'sess_a');
    expect(parsed?.sessionId).toBe('sess_a');
  });

  it('未知事件类型返回 null', () => {
    expect(parseStreamEntry(entry('1-0', { type: 'not.a.real.event' }), 'sess_a')).toBeNull();
  });

  it('data 不是合法 JSON 时退化为 null 而不抛异常', () => {
    const parsed = parseStreamEntry(entry('1-0', { data: '{不是 json' }), 'sess_a');
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toBeNull();
  });

  it('seq 缺失或非法时退化为 0', () => {
    expect(parseStreamEntry(entry('1-0', { seq: 'abc' }), 'sess_a')?.seq).toBe(0);
  });

  it('字段个数为奇数时不越界', () => {
    const broken: unknown = ['1-0', ['type', 'task.progress', 'seq']];
    expect(() => parseStreamEntry(broken, 'sess_a')).not.toThrow();
    expect(parseStreamEntry(broken, 'sess_a')?.seq).toBe(0);
  });

  it('结构完全异常时返回 null', () => {
    expect(parseStreamEntry(null, 'sess_a')).toBeNull();
    expect(parseStreamEntry('nope', 'sess_a')).toBeNull();
    expect(parseStreamEntry(['1-0'], 'sess_a')).toBeNull();
    expect(parseStreamEntry(['1-0', 'not-array'], 'sess_a')).toBeNull();
  });
});

describe('parseXreadReply', () => {
  it('展平 XREAD 的嵌套返回结构', () => {
    const reply: unknown = [
      ['svh:events:session:sess_a', [entry('1-0'), entry('2-0')]],
    ];
    expect(parseXreadReply(reply)).toHaveLength(2);
  });

  it('对 null 与结构异常返回空数组', () => {
    expect(parseXreadReply(null)).toEqual([]);
    expect(parseXreadReply('nope')).toEqual([]);
    expect(parseXreadReply([['key']])).toEqual([]);
    expect(parseXreadReply([['key', 'not-array']])).toEqual([]);
  });

  it('跳过结构异常的单条记录但保留其余', () => {
    const reply: unknown = [['key', [entry('1-0'), ['2-0'], entry('3-0')]]];
    expect(parseXreadReply(reply)).toHaveLength(2);
  });
});

describe('parseRangeReply', () => {
  it('解析 XRANGE 的返回结构', () => {
    expect(parseRangeReply([entry('1-0')])).toHaveLength(1);
  });

  it('对异常输入返回空数组', () => {
    expect(parseRangeReply(null)).toEqual([]);
    expect(parseRangeReply({})).toEqual([]);
  });
});

/*
 * `isStreamIdAfter` 是 SSE 路由「超前游标」守卫的判据（events.ts 的
 * parseLastEventId）。这里的重点是把**比较方式**钉死：必须按 ms / seq 分段做
 * 数值比较，不能按字符串比 —— 字符串比在序号位数变化时给出相反结论。
 */
describe('isStreamIdAfter', () => {
  it('毫秒段大即更晚', () => {
    expect(isStreamIdAfter('1700000000001-0', '1700000000000-9')).toBe(true);
    expect(isStreamIdAfter('1700000000000-9', '1700000000001-0')).toBe(false);
  });

  it('毫秒段相同时按 seq 做数值比较（不是字符串比较）', () => {
    // 字符串比会得出 "…-10" < "…-9"（'1' < '9'），正确结论是相反
    expect(isStreamIdAfter('1700000000000-10', '1700000000000-9')).toBe(true);
    expect(isStreamIdAfter('1700000000000-9', '1700000000000-10')).toBe(false);
    // 对照：字符串比较确实会给出错误答案，证明上一条不是同义反复
    expect('1700000000000-10' > '1700000000000-9').toBe(false);
  });

  it('相同 ID 不算更晚（严格大于）', () => {
    expect(isStreamIdAfter('1700000000000-3', '1700000000000-3')).toBe(false);
  });

  it('省略 seq 时按 0 处理', () => {
    expect(isStreamIdAfter('1700000000001', '1700000000000-9')).toBe(true);
    expect(isStreamIdAfter('1700000000000', '1700000000000-0')).toBe(false);
  });

  it('`$` 与非法值一律返回 false（由调用方另行校验格式）', () => {
    expect(isStreamIdAfter('$', '1700000000000-0')).toBe(false);
    expect(isStreamIdAfter('1700000000000-0', '$')).toBe(false);
    expect(isStreamIdAfter('not-a-stream-id', '1700000000000-0')).toBe(false);
    expect(isStreamIdAfter('1700000000000-0', 'not-a-stream-id')).toBe(false);
  });
});
