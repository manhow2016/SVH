import { describe, expect, it } from 'vitest';

import { formatDuration, formatRelativeTime } from '../src/lib/format.js';

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');

  it('一分钟内显示「刚刚」', () => {
    expect(formatRelativeTime('2026-09-12T11:59:30.000Z', now)).toBe('刚刚');
  });

  it('一小时内显示分钟数', () => {
    expect(formatRelativeTime('2026-09-12T11:30:00.000Z', now)).toBe('30 分钟前');
  });

  it('一天内显示小时数', () => {
    expect(formatRelativeTime('2026-09-12T06:00:00.000Z', now)).toBe('6 小时前');
  });

  it('超过一天显示日期', () => {
    expect(formatRelativeTime('2026-09-01T12:00:00.000Z', now)).toBe('2026-09-01');
  });

  it('时间在未来时退化为「刚刚」而不是负数', () => {
    // 客户端时钟略快于服务端是常见现象，不该显示「-1 分钟前」
    expect(formatRelativeTime('2026-09-12T12:00:30.000Z', now)).toBe('刚刚');
  });

  it('无法解析的输入返回空串而不是 Invalid Date', () => {
    expect(formatRelativeTime('不是时间', now)).toBe('');
  });
});

describe('formatDuration', () => {
  it('小于一秒显示毫秒', () => {
    expect(formatDuration(320)).toBe('320ms');
  });

  it('小于一分钟显示秒', () => {
    expect(formatDuration(4500)).toBe('4.5s');
  });

  it('超过一分钟显示分秒', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
