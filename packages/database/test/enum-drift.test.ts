/**
 * 枚举漂移测试
 * ============
 *
 * 为什么需要这个测试？
 * --------------------
 * Prisma 6 的 schema 解析器不支持 `import` TypeScript 枚举（该能力需 Prisma 7），
 * 因此 `prisma/schema.prisma` 中的枚举必须手写一遍，天然存在与
 * `packages/domain/src/enums.ts` 漂移的风险。
 *
 * 本测试把该风险变成**编译/测试期可发现的错误**：
 * 逐个比对每个 Prisma 枚举与对应的领域枚举数组，只要有一侧新增或删除了取值，
 * 测试立即失败并精确指出差异。
 *
 * 维护约定：新增枚举时，在 DOMAIN_ENUM_SOURCES 中补一行映射即可。
 */
import { describe, expect, it } from 'vitest';

import {
  ASSET_STATUSES,
  ASSET_TYPES,
  CONTENT_STATUSES,
  CONTENT_TYPES,
  DIRECTOR_ACTION_STATUSES,
  DIRECTOR_ACTION_TYPES,
  DIRECTOR_ACTORS,
  EXECUTION_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  MESSAGE_ROLES,
  MODEL_CAPABILITIES,
  MODEL_PROVIDER_KINDS,
  MODEL_TASK_STATUSES,
  OUTPUT_TYPES,
  PLAN_TIERS,
  PROJECT_ROLES,
  SESSION_STATUSES,
  SHOT_STATUSES,
  SKILL_ACCESS_TIERS,
  TASK_QUEUES,
  TASK_RISKS,
  TASK_STATUSES,
  TIMELINE_TRACK_KINDS,
  WORKFLOW_ORIGINS,
  WORKFLOW_RUN_STATUSES,
} from '@svh/domain';
import * as PrismaEnums from '../src/generated/prisma/enums.js';

/**
 * Prisma 枚举对象 → 领域枚举数组 的映射。
 *
 * 两侧都是 camelCase，例如 Prisma 的 `short_video` 对应领域数组中的
 * `'short_video'`，因此可以直接比对**键名**与**取值**。
 */
const DOMAIN_ENUM_SOURCES = {
  ContentType: CONTENT_TYPES,
  ContentStatus: CONTENT_STATUSES,
  AssetType: ASSET_TYPES,
  AssetStatus: ASSET_STATUSES,
  TaskStatus: TASK_STATUSES,
  TaskRisk: TASK_RISKS,
  ExecutionStatus: EXECUTION_STATUSES,
  WorkflowRunStatus: WORKFLOW_RUN_STATUSES,
  WorkflowOrigin: WORKFLOW_ORIGINS,
  SessionStatus: SESSION_STATUSES,
  MessageRole: MESSAGE_ROLES,
  MessageKind: MESSAGE_KINDS,
  MessageDirection: MESSAGE_DIRECTIONS,
  ProjectRole: PROJECT_ROLES,
  OutputType: OUTPUT_TYPES,
  SkillAccessTier: SKILL_ACCESS_TIERS,
  PlanTier: PLAN_TIERS,
  ModelProviderKind: MODEL_PROVIDER_KINDS,
  ModelCapability: MODEL_CAPABILITIES,
  ModelTaskStatus: MODEL_TASK_STATUSES,
  TaskQueue: TASK_QUEUES,
  ShotStatus: SHOT_STATUSES,
  TimelineTrackKind: TIMELINE_TRACK_KINDS,
  DirectorActor: DIRECTOR_ACTORS,
  DirectorActionType: DIRECTOR_ACTION_TYPES,
  DirectorActionStatus: DIRECTOR_ACTION_STATUSES,
} as const;

/** 排序工具，保证比对不受顺序影响 */
function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('Prisma 枚举与领域枚举一致性', () => {
  it('映射表覆盖了所有领域枚举（防止漏配）', () => {
    // 领域侧导出的 `*_STATUSES` / `*_TYPES` 常量应全部出现在映射中。
    // 这里做一次粗粒度检查：映射条目数量不少于 20 个核心枚举。
    expect(Object.keys(DOMAIN_ENUM_SOURCES).length).toBeGreaterThanOrEqual(20);
  });

  for (const [prismaName, domainValues] of Object.entries(DOMAIN_ENUM_SOURCES)) {
    it(`${prismaName} 与领域定义一致`, () => {
      const prismaEnum = (PrismaEnums as Record<string, unknown>)[prismaName];

      expect(
        prismaEnum,
        `Prisma schema 中缺少枚举 ${prismaName}，请在 schema.prisma 中补充`,
      ).toBeDefined();

      // Prisma 生成的是 { KEY: 'value' } 形式；键名与取值同名（均为 camelCase）
      const prismaValues = Object.keys(prismaEnum as Record<string, string>);

      // 分别比对，报错信息更精确
      const missingInPrisma = domainValues.filter(
        (v) => !prismaValues.includes(v),
      );
      const missingInDomain = prismaValues.filter(
        (v) => !(domainValues as readonly string[]).includes(v),
      );

      expect(
        missingInPrisma,
        `以下取值存在于 @svh/domain 但缺失于 prisma/schema.prisma 的 ${prismaName}：` +
          `${missingInPrisma.join(', ')}`,
      ).toEqual([]);
      expect(
        missingInDomain,
        `以下取值存在于 prisma/schema.prisma 的 ${prismaName} 但缺失于 @svh/domain：` +
          `${missingInDomain.join(', ')}`,
      ).toEqual([]);

      // 最终确认排序后完全一致
      expect(sorted(prismaValues)).toEqual(sorted(domainValues as readonly string[]));
    });
  }

  it('Prisma 导出枚举的数量与预期一致（新增枚举时需同步更新本测试）', () => {
    // 只统计运行时真正存在的枚举对象（值为 string 且非函数）
    const enumLikeKeys = Object.keys(PrismaEnums).filter((key) => {
      const value = (PrismaEnums as Record<string, unknown>)[key];
      return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
      );
    });

    // schema.prisma 中共声明 26 个枚举
    expect(enumLikeKeys.length).toBe(26);
  });
});
