/**
 * 环境配置校验测试
 *
 * 重点验证审计结论 ⑪ 要求的两个能力：
 * 1. 弱默认值必须被拒绝（而不是像参考项目那样静默回落到不安全的值）
 * 2. 一次性收集全部问题，方便一次修完
 */
import { describe, expect, it } from 'vitest';

import { detectWeakSecret, EnvValidationError, parseEnv } from '../src/env.js';

/** 一份最小可用的合法配置 */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/svh_dev?schema=public',
    REDIS_URL: 'redis://127.0.0.1:6379/3',
    SECRET_ENCRYPTION_KEY: 'a'.repeat(48),
    ...overrides,
  };
}

describe('detectWeakSecret', () => {
  it.each([
    'change-me',
    'change_me_now',
    'changeme',
    'dev-jwt-secret-change-me',
    'dev-only-insecure-key',
    'minioadmin',
    'password',
    'please-change-this',
    'your-key-here',
    'xxxxxx',
  ])('拒绝弱默认值：%s', (value) => {
    expect(detectWeakSecret(value)).not.toBeNull();
  });

  it.each([
    'a'.repeat(64),
    'f3a91c0b7e2d4856a1b2c3d4e5f60718',
    'sk-proj-9f8a7b6c5d4e3f2a1b0c',
  ])('接受强随机值：%s', (value) => {
    expect(detectWeakSecret(value)).toBeNull();
  });
});

describe('parseEnv', () => {
  it('接受合法配置并填充默认值', () => {
    const env = parseEnv(validEnv());
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3030);
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(env.STORAGE_DRIVER).toBe('local');
    expect(env.WORKER_ENABLED).toBe(true);
  });

  it('将字符串端口强制转为数字', () => {
    const env = parseEnv(validEnv({ API_PORT: '4100' }));
    expect(env.API_PORT).toBe(4100);
  });

  it('DATABASE_URL 必须是 postgres 协议', () => {
    expect(() => parseEnv(validEnv({ DATABASE_URL: 'mysql://localhost:3306/db' }))).toThrow(
      EnvValidationError,
    );
  });

  it('REDIS_URL 必须是 redis 协议', () => {
    expect(() => parseEnv(validEnv({ REDIS_URL: 'http://localhost:6379' }))).toThrow(
      EnvValidationError,
    );
  });

  it('拒绝弱默认值的加密密钥', () => {
    expect(() =>
      parseEnv(validEnv({ SECRET_ENCRYPTION_KEY: 'dev-only-insecure-key-please-change-in-production-32bytes' })),
    ).toThrow(EnvValidationError);
  });

  it('拒绝过短的加密密钥', () => {
    expect(() => parseEnv(validEnv({ SECRET_ENCRYPTION_KEY: 'short-key-abcdefghij' }))).toThrow(
      EnvValidationError,
    );
  });

  it('缺失必填项时一次性报告全部问题', () => {
    let error: EnvValidationError | null = null;
    try {
      parseEnv({ NODE_ENV: 'development' });
    } catch (err) {
      // 用 instanceof 收窄，而不是类型断言 —— 断言会掩盖真实的类型错误
      if (err instanceof EnvValidationError) error = err;
    }

    expect(error).toBeInstanceOf(EnvValidationError);
    // DATABASE_URL / REDIS_URL / SECRET_ENCRYPTION_KEY 三项都应被报出
    expect(error?.issues.length).toBeGreaterThanOrEqual(3);
    const joined = error?.issues.join('\n') ?? '';
    expect(joined).toContain('DATABASE_URL');
    expect(joined).toContain('REDIS_URL');
    expect(joined).toContain('SECRET_ENCRYPTION_KEY');
  });

  it('生产环境必须使用 https 的 API_PUBLIC_URL', () => {
    expect(() =>
      parseEnv(
        validEnv({
          NODE_ENV: 'production',
          STORAGE_DRIVER: 's3',
          API_PUBLIC_URL: 'http://example.com',
        }),
      ),
    ).toThrow(/https/);
  });

  it('生产环境不允许本地磁盘存储', () => {
    expect(() =>
      parseEnv(
        validEnv({
          NODE_ENV: 'production',
          API_PUBLIC_URL: 'https://example.com',
          STORAGE_DRIVER: 'local',
        }),
      ),
    ).toThrow(EnvValidationError);
  });

  it('生产环境配置完整时通过', () => {
    const env = parseEnv(
      validEnv({
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'https://api.svh.example.com',
        STORAGE_DRIVER: 's3',
        SECRET_ENCRYPTION_KEY: 'f3a91c0b7e2d4856a1b2c3d4e5f60718',
      }),
    );
    expect(env.NODE_ENV).toBe('production');
  });

  it('共享 Provider 的 URL 与 Key 必须成对出现', () => {
    expect(() =>
      parseEnv(validEnv({ SHARED_OPENAI_BASE_URL: 'https://api.openai.com/v1' })),
    ).toThrow(/SHARED_OPENAI_API_KEY/);

    expect(() => parseEnv(validEnv({ SHARED_OPENAI_API_KEY: 'sk-abcdefghijklmnop' }))).toThrow(
      /SHARED_OPENAI_BASE_URL/,
    );
  });

  it('WORKER_ENABLED 支持多种真值写法', () => {
    expect(parseEnv(validEnv({ WORKER_ENABLED: 'false' })).WORKER_ENABLED).toBe(false);
    expect(parseEnv(validEnv({ WORKER_ENABLED: '0' })).WORKER_ENABLED).toBe(false);
    expect(parseEnv(validEnv({ WORKER_ENABLED: '1' })).WORKER_ENABLED).toBe(true);
    expect(parseEnv(validEnv({ WORKER_ENABLED: 'true' })).WORKER_ENABLED).toBe(true);
  });
});
