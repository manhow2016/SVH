/**
 * 执行护栏：每个「已实现」的技能都必须能真的跑到底。
 *
 * ── 为什么需要它 ──
 * `skill-catalog.test.ts` 只校验**目录元数据**（id 唯一、队列绑定、风险标记……），
 * 从来不执行技能体。于是 7 个生成类技能里有 5 个把 schema 不认识的键写进了
 * 资产 metadata，一直没人发现 —— 因为 `.strict()` 只在**任务执行的最后一步
 * （登记资产）**才报错，而前面模型调用、进度上报全都正常。
 * 表现是「视频生成跑了 10 秒然后失败」，错误信息指向 schema，
 * 排查时很难联想到是技能写错了字段。
 *
 * 本文件补上那道网：给每个已实现技能喂一份最小合法输入，用一个内存版
 * `SkillAssetPort` 承接它的写入 —— 而这个端口在 `create` / `update` 时
 * **调用 domain 的真实 schema**（与生产路径 `buildAssetData` 同一套规则）。
 * 技能一旦写了 schema 不认的键，这里立刻失败，并直接指出是哪个技能、哪个字段。
 *
 * ── 它不替代什么 ──
 * 这里用的是假模型（按能力返回固定的结构化结果），所以它验证的是
 * **「技能 → 资产 schema」这段契约**，不是模型适配器。真实 Provider 的
 * 协议差异仍由 apps/worker 的集成测试覆盖。
 *
 * 维护约定：新增已实现技能时，在 `SKILL_INPUTS` 里补一行最小输入。
 * 少一行会由下面的「清单完备性」用例直接指出来，不会静默漏掉。
 */
import { describe, expect, it } from 'vitest';

import { resolveAssetMetadata, type AssetType } from '@svh/domain';

import { SKILL_IMPLEMENTATIONS } from '../src/implementations/index.js';

import type {
  SkillAssetPort,
  SkillContentPort,
  SkillDeps,
  SkillExecutionContext,
  SkillLogger,
  SkillModelPort,
  SkillProjectPort,
  SkillProjectWritePort,
} from '../src/runtime/ports.js';
import type { ModelInvokeRequest, ModelInvokeResult } from '@svh/domain';

/* ─────────────────────────── 内存端口 ─────────────────────────── */

interface 资产行 {
  id: string;
  projectId: string;
  type: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
  files: unknown[];
  version: number;
}

const 日志: SkillLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 按能力返回固定结构；技能读哪个字段由它自己决定，这里只保证「有东西可读」 */
function 假模型结果(request: ModelInvokeRequest): ModelInvokeResult {
  const base = {
    modelId: 'fakemodel0001',
    providerId: 'fakeprov00001',
    fallbackUsed: false,
    latencyMs: 1,
    // `attempts` 是「尝试链路」记录数组，不是次数
    attempts: [],
  };
  const 通用用量 = { seed: 42, units: 1 };

  switch (request.capability) {
    case 'subtitle':
      return {
        ...base,
        data: {
          cues: [
            { index: 1, start: 0, end: 2.4, text: '雨夜的长安城' },
            { index: 2, start: 2.4, end: 5, text: '一个人影走过' },
          ],
        },
        usage: 通用用量,
      };
    case 'text':
    case 'script':
      return {
        ...base,
        text: '一段用于测试的文案。',
        data: {
          shots: [
            { index: 1, description: '窗台上的猫，晨光', duration: 3 },
            { index: 2, description: '猫伸了个懒腰', duration: 2 },
          ],
          title: '测试脚本',
          duration: 5,
          aspectRatio: '9:16',
        },
        usage: 通用用量,
      };
    default:
      return {
        ...base,
        text: '已生成。',
        files: [
          {
            url: 'http://127.0.0.1:18080/stub/video.mp4',
            storageKey: 'stub/media',
            mimeType: 'video/mp4',
            width: 1024,
            height: 1024,
            duration: 5,
          },
        ],
        usage: 通用用量,
      };
  }
}

interface 测试台 {
  deps: SkillDeps;
  rows: 资产行[];
  /** 每次资产写入的日志，便于断言「确实写了」 */
  writes: Array<{ skill: string; type: string; metadata: Record<string, unknown> }>;
}

function 建测试台(): 测试台 {
  const rows: 资产行[] = [];
  const writes: 测试台['writes'] = [];
  let seq = 0;
  const 下一个Id = (): string => `cmtzfake${String((seq += 1)).padStart(4, '0')}`;

  /*
   * 关键：写入时走 domain 的真实 schema。
   * 生产路径（packages/database 的 buildAssetData）用的是同一个 assetSchema，
   * 所以这里拦得住的东西，线上也一定会炸。
   */
  const 校验 = (type: string, metadata: unknown): Record<string, unknown> =>
    resolveAssetMetadata(type as AssetType, metadata ?? {}) as Record<string, unknown>;

  const assets: SkillAssetPort = {
    async create(input) {
      const metadata = 校验(input.type, input.metadata);
      const row: 资产行 = {
        id: 下一个Id(),
        projectId: input.projectId,
        type: input.type,
        name: input.name,
        slug: input.slug ?? input.name,
        metadata,
        files: input.files ?? [],
        version: 1,
      };
      rows.push(row);
      writes.push({ skill: '', type: input.type, metadata });
      return { id: row.id, slug: row.slug, version: row.version };
    },

    async update(input) {
      const row = rows.find((r) => r.id === input.assetId);
      if (row === undefined) throw new Error(`资产 ${input.assetId} 不存在`);
      if (input.patch.metadata !== undefined) {
        row.metadata = 校验(row.type, input.patch.metadata);
        writes.push({ skill: '', type: row.type, metadata: row.metadata });
      }
      row.version += 1;
      return { id: row.id, version: row.version };
    },

    async findBySlug(projectId, slug) {
      const row = rows.find((r) => r.projectId === projectId && r.slug === slug);
      return row === undefined
        ? null
        : { id: row.id, slug: row.slug, name: row.name, type: row.type, metadata: row.metadata };
    },

    async listByProject(projectId, filter) {
      return rows
        .filter((r) => r.projectId === projectId)
        .filter((r) => filter?.type === undefined || r.type === filter.type)
        .slice(0, filter?.limit ?? rows.length)
        .map((r) => ({ id: r.id, slug: r.slug, name: r.name, type: r.type, metadata: r.metadata }));
    },
  };

  const models: SkillModelPort = {
    invoke: async (request) => Promise.resolve(假模型结果(request)),
    listModels: () => [],
  };

  const contents: SkillContentPort = {
    get: async (contentId) =>
      Promise.resolve({
        id: contentId,
        projectId: PROJECT_ID,
        type: 'advertisement',
        title: '测试内容',
        brief: '30 秒护肤品广告',
        metadata: { duration: 30, aspectRatio: '9:16', platform: 'xiaohongshu' },
        status: 'draft',
      }),
    update: async () => Promise.resolve(),
    addOutput: async () => Promise.resolve({ outputId: 'cmtzoutput01' }),
  };

  // 必须是 `SkillProjectPort & SkillProjectWritePort`：SkillDeps.projects 是两者的交叉
  const projects: SkillProjectPort & SkillProjectWritePort = {
    getMemory: async () =>
      Promise.resolve({
        goals: { objective: '验证技能可执行', platforms: ['xiaohongshu'] },
        visual: { style: '电影感、冷调', styleKeywords: ['电影感', '冷调'] },
        brand: { tone: '克制、专业' },
      }),
    mergeMemory: async () => Promise.resolve(),
  };

  return { deps: { models, assets, contents, projects }, rows, writes };
}

const PROJECT_ID = 'cmtzproject1';
const CONTENT_ID = 'cmtzcontent01';

/** 每个技能的最小合法输入；`assetId` 之类的引用在 runSkill 里按种子资产替换 */
const SKILL_INPUTS: Record<string, Record<string, unknown>> = {
  'text.generate': { prompt: '写一句护肤品广告语' },
  'script.generate': { brief: '30 秒护肤品广告', duration: 30, shotCount: 2 },
  'requirement.analyze': { brief: '30 秒护肤品广告，面向年轻女性' },

  'image.generate': { prompt: '晨光下的窗台，一只猫' },
  'image.edit': { assetId: 'SEED_IMAGE', instruction: '把猫改成橘色' },

  'video.generate': { prompt: '一只猫在窗台上打盹', duration: 5, aspectRatio: '9:16' },
  'video.extend': { assetId: 'SEED_VIDEO', extraSeconds: 3 },

  'audio.generate': { prompt: '轻快、克制的背景音乐' },
  'voice.generate': { text: '雨夜的长安城，一个人影走过' },
  'subtitle.generate': { script: '雨夜的长安城，一个人影走过' },

  // 上游产出按 extractAssetIds 认识的形状给：它读的是 assetId / assetIds / files，
  // 不是裸字符串数组（第一版就是这里写错了，技能报「缺少视频素材」）
  'edit.video': { video: { assetIds: ['SEED_VIDEO'] } },
  'edit.brand_overlay': { video: { assetIds: ['SEED_VIDEO'] } },
  'output.publish': { title: '30 秒护肤品广告', platform: 'xiaohongshu' },

  'asset.create': {
    type: 'character',
    name: '苏晚',
    metadata: { appearance: { hair: '黑色长直发' }, role: '女主' },
  },
  'asset.update': { assetId: 'SEED_CHARACTER', patch: { description: '更新后的描述' } },
};

/* ─────────────────────────── 执行 ─────────────────────────── */

/** 预置种子资产：让依赖上游产物的技能（image.edit / video.extend / edit.video …）有东西可用 */
function 播种(testbed: 测试台): Record<string, string> {
  const 造 = (type: string, name: string, metadata: Record<string, unknown>): string => {
    const id = `cmtzseed${type}`;
    testbed.rows.push({
      id,
      projectId: PROJECT_ID,
      type,
      name,
      slug: name,
      metadata: resolveAssetMetadata(type as AssetType, metadata) as Record<string, unknown>,
      files: [{ url: 'http://127.0.0.1:18080/stub/video.mp4', storageKey: 'stub/seed' }],
      version: 1,
    });
    return id;
  };

  return {
    SEED_IMAGE: 造('image', '种子画面', { width: 1024, height: 1536, format: 'png' }),
    SEED_VIDEO: 造('video', '种子视频', { duration: 5, aspectRatio: '9:16', shotCount: 1 }),
    SEED_VOICE: 造('voice', '种子音色', { language: 'zh-CN' }),
    SEED_CHARACTER: 造('character', '种子角色', { appearance: { hair: '黑色长发' } }),
  };
}

function 解析引用(input: Record<string, unknown>, 种子: Record<string, string>): Record<string, unknown> {
  const 替换 = (value: unknown): unknown => {
    if (typeof value === 'string' && 种子[value] !== undefined) return 种子[value];
    if (Array.isArray(value)) return value.map(替换);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, 替换(v)]));
    }
    return value;
  };
  return 替换(input) as Record<string, unknown>;
}

async function 跑技能(skillId: string): Promise<{ 资产写入数: number; 产出: unknown }> {
  const implementation = SKILL_IMPLEMENTATIONS.find((s) => s.id === skillId);
  if (implementation === undefined) throw new Error(`没有已实现的技能 ${skillId}`);
  const 输入 = SKILL_INPUTS[skillId];
  if (输入 === undefined) throw new Error(`SKILL_INPUTS 缺少 ${skillId} 的输入`);

  const testbed = 建测试台();
  const 种子 = 播种(testbed);
  const 写入前 = testbed.writes.length;

  const ctx: SkillExecutionContext = {
    taskId: 'cmtzfaketask1',
    projectId: PROJECT_ID,
    contentId: CONTENT_ID,
    sessionId: 'cmtzfakesess1',
    attempt: 1,
    deps: testbed.deps,
    logger: 日志,
    signal: new AbortController().signal,
    reportProgress: async () => Promise.resolve(),
    step: async () => Promise.resolve(),
  };

  const 结果 = await implementation.execute(
    解析引用(输入, 种子) as never,
    ctx,
  );

  // 把技能 id 补进写入日志，失败时能直说是谁写的
  for (let i = 写入前; i < testbed.writes.length; i += 1) {
    const entry = testbed.writes[i];
    if (entry !== undefined) entry.skill = skillId;
  }

  return { 资产写入数: testbed.writes.length - 写入前, 产出: 结果 };
}

/* ─────────────────────────── 用例 ─────────────────────────── */

describe('每个已实现的技能都能真的跑到终态', () => {
  it('清单完备：每个已实现技能都在 SKILL_INPUTS 里有输入', () => {
    const 缺输入 = SKILL_IMPLEMENTATIONS.map((s) => s.id).filter((id) => SKILL_INPUTS[id] === undefined);
    expect(缺输入, '新增已实现技能时必须在 SKILL_INPUTS 里补一行最小输入').toEqual([]);
  });

  // 逐条 it 而不是循环里一个 it：失败时报告直接指出是哪个技能
  for (const implementation of SKILL_IMPLEMENTATIONS) {
    it(`${implementation.id} 执行成功且写入的 metadata 合法`, async () => {
      const { 产出 } = await 跑技能(implementation.id);
      // 技能必须给出产出（任务终态 success 的前提）
      expect(产出, `${implementation.id} 返回了空产出`).toBeTruthy();
      expect(产出, `${implementation.id} 没有 output 字段`).toHaveProperty('output');
    });
  }
});

/**
 * 反向验证：这道护栏**真的会拦**。
 *
 * 如果 `resolveAssetMetadata` 被误改成永不放行或永远放行，上面 15 条会一起
 * 变得没有意义。这里用一个「故意写错键」的场景把护栏本身钉住。
 */
describe('护栏自检', () => {
  it('技能写出 schema 不认识的键时，护栏会失败并指出字段名', async () => {
    const testbed = 建测试台();
    await expect(
      testbed.deps.assets.create({
        projectId: PROJECT_ID,
        type: 'video',
        name: '故意写错的视频',
        metadata: { duration: 5, shotCounts: 3 },
      }),
      // 期望的是 zod 的「不认识这个键」，而不是「没报错」
    ).rejects.toThrow(/shotCounts/);
  });

  it('合法的 metadata 正常通过', async () => {
    const testbed = 建测试台();
    const created = await testbed.deps.assets.create({
      projectId: PROJECT_ID,
      type: 'video',
      name: '合法视频',
      metadata: { duration: 5, aspectRatio: '9:16', shotCount: 2 },
    });
    expect(created.id).toBeTruthy();
  });
});
