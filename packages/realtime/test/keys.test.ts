/**
 * Redis Key 约定测试
 *
 * 这些断言看起来琐碎，但它们是**会话隔离**的第一道防线：
 * 一旦两个会话的键发生碰撞，事件就会推送错人。
 */
import { describe, expect, it } from 'vitest';

import {
  eventSeqKey,
  eventStreamKey,
  READ_COUNT,
  STREAM_MAXLEN,
  STREAM_TTL_SECONDS,
} from '../src/index.js';

describe('事件总线的 Redis Key 约定', () => {
  it('不同会话的事件流键不同', () => {
    expect(eventStreamKey('sess_a')).not.toBe(eventStreamKey('sess_b'));
  });

  it('事件流键与序号键不冲突', () => {
    expect(eventStreamKey('sess_a')).not.toBe(eventSeqKey('sess_a'));
  });

  it('序号键与事件流键都带 svh 前缀，避免与同库其它项目冲突', () => {
    expect(eventStreamKey('x').startsWith('svh:')).toBe(true);
    expect(eventSeqKey('x').startsWith('svh:')).toBe(true);
  });

  it('会话 id 被完整保留在键中', () => {
    expect(eventStreamKey('sess_a')).toContain('sess_a');
    expect(eventSeqKey('sess_a')).toContain('sess_a');
  });

  it('裁剪与过期参数处于合理区间', () => {
    // 太小会导致断线重连取不到足够历史；太大则白白占内存
    expect(STREAM_MAXLEN).toBeGreaterThanOrEqual(100);
    expect(STREAM_TTL_SECONDS).toBeGreaterThanOrEqual(3600);
    expect(READ_COUNT).toBeGreaterThanOrEqual(10);
  });
});
