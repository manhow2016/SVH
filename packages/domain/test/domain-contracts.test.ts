/**
 * 领域契约测试
 *
 * 覆盖三块最容易被改坏的领域规则：
 * 1. 资产元数据的按类型收窄（Asset System 的类型安全基础）
 * 2. 任务状态机白名单（防止非法状态转移写进数据库）
 * 3. 错误体系的双重信息（技术信息进日志、用户信息进 UI）
 */
import { describe, expect, it } from 'vitest';

import {
  assertTaskTransition,
  canTransitionTask,
  deepMerge,
  HTTP_STATUS_BY_CODE,
  isLeaseExpired,
  isSvhError,
  matchesFencing,
  ProviderUnavailableError,
  resolveAssetMetadata,
  toSvhError,
  USER_MESSAGE_BY_CODE,
  type UserFacingError,
  ValidationError,
  buildJobId,
  parseJobId,
  type ErrorCode,
} from '../src/index.js';

describe('resolveAssetMetadata —— 资产元数据按类型收窄', () => {
  it('角色元数据保留 appearance 结构', () => {
    const meta = resolveAssetMetadata('character', {
      appearance: { gender: 'female', age: 23, hair: '黑色长直发' },
      personality: '清冷',
    });
    expect(meta.appearance?.hair).toBe('黑色长直发');
    expect(meta.personality).toBe('清冷');
  });

  it('品牌元数据保留颜色与规范', () => {
    const meta = resolveAssetMetadata('brand', {
      colors: ['#111111', '#C8102E'],
      slogan: '让创作更简单',
      guidelines: { must: ['保留品牌留白'], forbidden: ['低饱和撞色'] },
    });
    expect(meta.colors).toHaveLength(2);
    expect(meta.guidelines?.must).toEqual(['保留品牌留白']);
  });

  it('数字人元数据保留音色与动作配置', () => {
    const meta = resolveAssetMetadata('digital_human', {
      gender: 'male',
      voice: { speed: 1.1, emotion: '亲切' },
      motion: { mode: 'talking_head' },
    });
    expect(meta.voice?.emotion).toBe('亲切');
    expect(meta.motion?.mode).toBe('talking_head');
  });

  it('素材类资产共用通用元数据结构', () => {
    const meta = resolveAssetMetadata('video', {
      width: 1080,
      height: 1920,
      duration: 5,
      generation: { prompt: '雨夜长安城', seed: 42 },
    });
    expect(meta.duration).toBe(5);
    expect(meta.generation?.seed).toBe(42);
  });

  it('空元数据返回带默认值的空对象（而非报错）', () => {
    expect(resolveAssetMetadata('product', undefined)).toEqual({});
    expect(resolveAssetMetadata('character', null)).toEqual({});
  });

  it('未知字段会被拒绝（strict 模式，防止拼写错误静默丢失）', () => {
    expect(() => resolveAssetMetadata('product', { unknowField: 'xxx' })).toThrow();
  });

  it('字段类型非法时抛错', () => {
    expect(() => resolveAssetMetadata('scene', { elements: 'not-an-array' })).toThrow();
  });

  it('不同类型对同一字段的解释互不干扰（角色 appearance 是对象，道具 appearance 是字符串）', () => {
    // 角色：appearance 必须是对象
    expect(() => resolveAssetMetadata('character', { appearance: '黑色长发' })).toThrow();
    // 道具：appearance 必须是字符串
    expect(() => resolveAssetMetadata('prop', { appearance: { hair: 'x' } })).toThrow();
    expect(resolveAssetMetadata('prop', { appearance: '青铜剑' }).appearance).toBe('青铜剑');
  });
});

describe('任务状态机白名单', () => {
  it('允许合法的正常流转', () => {
    expect(canTransitionTask('pending', 'running')).toBe(true);
    expect(canTransitionTask('running', 'success')).toBe(true);
    expect(canTransitionTask('running', 'waiting_user')).toBe(true);
    expect(canTransitionTask('waiting_user', 'running')).toBe(true);
  });

  it('允许任意非终态进入 cancelled', () => {
    expect(canTransitionTask('pending', 'cancelled')).toBe(true);
    expect(canTransitionTask('running', 'cancelled')).toBe(true);
    expect(canTransitionTask('waiting_user', 'cancelled')).toBe(true);
  });

  /*
   * 确认放行的**主路径**：waiting_user → pending。
   *
   * 这是产品里最核心的一次状态跃迁 —— `POST /api/agent/sessions/:id/confirm`
   * 把用户批准的高风险任务从 waiting_user 置回 pending（同一次写入里带上
   * `confirmedAt` 凭据），Worker 才能重新抢占它。
   *
   * 白名单漏掉 `pending` 时这条会立刻变红，也就把「白名单与产品主流程相左」
   * 这个缺陷挡在编译期之外：将来 confirm 若收进仓储层（写状态前统一调用
   * assertTaskTransition），漏掉的那条会直接抛「非法的任务状态转移：
   * waiting_user → pending」，用户点了确认却永远等不到结果。
   */
  it('waiting_user → pending 是确认放行的主路径，必须合法', () => {
    expect(canTransitionTask('waiting_user', 'pending')).toBe(true);
    expect(() => assertTaskTransition('waiting_user', 'pending')).not.toThrow();
  });

  it('终态不可再转移 —— 重试必须通过新 attempt 而非改回 running', () => {
    expect(canTransitionTask('success', 'running')).toBe(false);
    expect(canTransitionTask('failed', 'running')).toBe(false);
    expect(canTransitionTask('cancelled', 'running')).toBe(false);
  });

  it('不允许从 pending 直接跳到 success（必须经过 running）', () => {
    expect(canTransitionTask('pending', 'success')).toBe(false);
  });

  it('assertTaskTransition 在非法转移时抛错', () => {
    expect(() => assertTaskTransition('success', 'running')).toThrow(/非法的任务状态转移/);
    expect(() => assertTaskTransition('pending', 'running')).not.toThrow();
  });
});

describe('确定性 jobId（幂等三件套之一）', () => {
  it('相同任务与尝试序号生成相同 jobId', () => {
    expect(buildJobId('task_abc', 1)).toBe('task-task_abc-attempt-1');
    expect(buildJobId('task_abc', 1)).toBe(buildJobId('task_abc', 1));
  });

  it('不同尝试序号生成不同 jobId', () => {
    expect(buildJobId('t', 1)).not.toBe(buildJobId('t', 2));
  });

  it('可从 jobId 反解出任务 id 与尝试序号', () => {
    expect(parseJobId(buildJobId('abc123', 7))).toEqual({ taskId: 'abc123', attempt: 7 });
  });

  it('非法 jobId 返回 null 而不是抛错', () => {
    expect(parseJobId('random')).toBeNull();
    expect(parseJobId('task-abc')).toBeNull();
  });
});

describe('租约与 Fencing', () => {
  it('租约过期判定', () => {
    const now = new Date('2026-01-01T00:00:10Z');
    expect(isLeaseExpired({ leaseUntil: new Date('2026-01-01T00:00:05Z') }, now)).toBe(true);
    expect(isLeaseExpired({ leaseUntil: new Date('2026-01-01T00:00:20Z') }, now)).toBe(false);
  });

  it('Fencing 要求 workerId 与 leaseVersion 同时匹配', () => {
    const lease = { workerId: 'w1', leaseVersion: 3 };
    expect(matchesFencing(lease, { workerId: 'w1', leaseVersion: 3 })).toBe(true);
    // 旧 Worker 的租约版本已过期，拒绝写入
    expect(matchesFencing(lease, { workerId: 'w1', leaseVersion: 2 })).toBe(false);
    // 另一个 Worker 即使版本号相同也不能写
    expect(matchesFencing(lease, { workerId: 'w2', leaseVersion: 3 })).toBe(false);
  });
});

describe('错误体系', () => {
  it('每个错误码都有对应的 HTTP 状态码与用户文案', () => {
    for (const code of Object.keys(HTTP_STATUS_BY_CODE) as ErrorCode[]) {
      expect(HTTP_STATUS_BY_CODE[code], `${code} 缺少 HTTP 状态码`).toBeGreaterThanOrEqual(400);
      expect(USER_MESSAGE_BY_CODE[code], `${code} 缺少用户文案`).toBeTruthy();
    }
  });

  it('用户文案不包含技术术语（审计要求：禁止向用户暴露技术错误）', () => {
    const forbidden = ['AxiosError', 'ProviderError', 'stack', 'ECONNREFUSED', 'undefined'];
    for (const [code, message] of Object.entries(USER_MESSAGE_BY_CODE)) {
      for (const term of forbidden) {
        expect(message.includes(term), `${code} 的用户文案含技术术语「${term}」：${message}`).toBe(
          false,
        );
      }
    }
  });

  it('toUserResponse 只暴露用户需要的信息，不含技术细节', () => {
    const error = new ProviderUnavailableError('connect ECONNREFUSED 10.0.0.5:443', {
      context: { providerId: 'p1', modelId: 'm1' },
    });
    const response = error.toUserResponse();

    expect(response.code).toBe('PROVIDER_UNAVAILABLE');
    expect(response.message).toBe('模型服务暂时不可用。');
    expect(response.suggestions.length).toBeGreaterThan(0);
    expect(JSON.stringify(response)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(response)).not.toContain('10.0.0.5');
  });

  it('toLogObject 保留技术细节与上下文（便于排查）', () => {
    const error = new ProviderUnavailableError('connect ECONNREFUSED', {
      context: { providerId: 'p1' },
    });
    const log = error.toLogObject();
    expect(log.code).toBe('PROVIDER_UNAVAILABLE');
    expect(log.message).toContain('ECONNREFUSED');
    expect(log.context).toEqual({ providerId: 'p1' });
  });

  it('模型类错误默认标记为可重试（供 Agent 自动重试）', () => {
    expect(new ProviderUnavailableError('x').retryable).toBe(true);
  });

  it('参数校验错误默认不可重试', () => {
    expect(new ValidationError('x').retryable).toBe(false);
  });

  it('toSvhError 把普通异常归一化为 SvhError', () => {
    const wrapped = toSvhError(new Error('boom'));
    expect(isSvhError(wrapped)).toBe(true);
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    // 原始信息进 message（日志），但用户看到的是通用文案
    expect(wrapped.message).toBe('boom');
    expect(wrapped.userMessage).not.toContain('boom');
  });

  it('toSvhError 对已是 SvhError 的实例原样返回', () => {
    const original = new ValidationError('字段缺失');
    expect(toSvhError(original)).toBe(original);
  });

  it('UserFacingError 结构不含技术字段', () => {
    const response: UserFacingError = new ValidationError('x').toUserResponse();
    expect(Object.keys(response).sort()).toEqual(['code', 'message', 'retryable', 'suggestions']);
  });
});

describe('deepMerge —— 资产 metadata 的部分更新语义', () => {
  it('递归合并嵌套对象', () => {
    const merged = deepMerge(
      { appearance: { hair: '黑色', age: 23 }, tags: ['a'] },
      { appearance: { hair: '红色' } },
    );
    expect(merged).toEqual({ appearance: { hair: '红色', age: 23 }, tags: ['a'] });
  });

  it('数组整体替换而非逐项合并', () => {
    const merged = deepMerge({ colors: ['#111', '#222'] }, { colors: ['#333'] });
    expect(merged.colors).toEqual(['#333']);
  });

  it('null 表示显式删除该字段', () => {
    const merged = deepMerge({ a: 1, b: 2 }, { a: null });
    expect(merged).toEqual({ b: 2 });
  });

  it('不修改原始对象（纯函数）', () => {
    const base = { appearance: { hair: '黑色' } };
    deepMerge(base, { appearance: { hair: '红色' } });
    expect(base.appearance.hair).toBe('黑色');
  });
});
