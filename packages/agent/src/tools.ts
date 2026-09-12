/**
 * Agent 工具集
 *
 * 技术文档第 53、54 条：**Agent 不直接修改数据库**，一切经由工具完成。
 *
 * 工具的设计原则：
 * 1. **描述面向模型**：`description` 要写清楚「什么时候该用」，
 *    而不是只复述名字。模型靠它决定调不调。
 * 2. **参数尽量窄**：参数越少越不容易被模型填错。
 * 3. **写操作返回可核对的凭据**（如 taskId / contentId），
 *    让 Agent 能在下一轮告知用户具体发生了什么。
 * 4. **失败不抛异常**：返回结构化的失败结果，让模型有机会换一种做法。
 */

import {
  CONTENT_TYPES,
  ValidationError,
  type AgentTool,
  type ContentType,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from '@svh/domain';

import type { AgentDeps } from './ports.js';

/** 构造工具集合所需的依赖 */
export interface BuildToolsOptions {
  deps: AgentDeps;
}

/* -------------------------------------------------------------------------- */
/* project.get                                                                */
/* -------------------------------------------------------------------------- */

function projectGet(deps: AgentDeps): AgentTool {
  return {
    name: 'project.get',
    description:
      '获取当前项目的完整信息，包括项目名称、描述与项目记忆（品牌规范、视觉风格、制作规则、用户偏好）。' +
      '在需要了解项目的品牌调性、视觉风格或制作约束时调用。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    mutating: false,
    async execute(_args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const project = await deps.projects.getProject(ctx.projectId);
      if (project === null) {
        return { ok: false, error: '当前项目不存在或已被删除' };
      }
      const memory = await deps.projects.getMemory(ctx.projectId);
      return {
        ok: true,
        result: { ...project, memory },
        message: `已读取项目「${project.name}」的信息`,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* asset.search                                                               */
/* -------------------------------------------------------------------------- */

function assetSearch(deps: AgentDeps): AgentTool {
  return {
    name: 'asset.search',
    description:
      '在项目中搜索资产（角色、场景、产品、品牌、数字人、图片、视频、音频等）。' +
      '支持按关键词与类型筛选。在需要找到某个已有的角色、场景或素材时调用。' +
      '若用户用 @名称 引用了资产，优先直接用该名称搜索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词。留空则列出全部资产' },
        type: {
          type: 'string',
          description: '限定资产类型，如 character / scene / product / brand / image / video',
        },
        limit: { type: 'number', description: '返回数量上限，默认 10' },
      },
      required: [],
    },
    mutating: false,
    async execute(args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const type = typeof args.type === 'string' ? args.type : undefined;
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 50) : 10;

      const assets =
        query.length > 0
          ? await deps.assets.search(ctx.projectId, query, {
              limit,
              ...(type !== undefined ? { type } : {}),
            })
          : await deps.assets.listSummaries(ctx.projectId, {
              limit,
              ...(type !== undefined ? { type } : {}),
            });

      return {
        ok: true,
        result: {
          count: assets.length,
          assets: assets.map((a) => ({
            id: a.id,
            slug: a.slug,
            name: a.name,
            type: a.type,
            summary: a.summary,
          })),
        },
        message:
          assets.length > 0 ? `找到 ${assets.length} 个资产` : '没有找到匹配的资产',
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* asset.create                                                               */
/* -------------------------------------------------------------------------- */

function assetCreate(deps: AgentDeps): AgentTool {
  return {
    name: 'asset.create',
    description:
      '创建一个新资产并加入当前项目。适用于用户要求设计角色、场景、产品或品牌设定的场景。' +
      '注意：这里只创建**设定数据**；如果用户要的是画面/图片，应当改用 skill.execute 调用 image.generate。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '资产类型：character / scene / product / brand / digital_human / prop / costume',
        },
        name: { type: 'string', description: '资产名称，用户之后可用 @名称 引用它' },
        description: { type: 'string', description: '一句话描述' },
        metadata: {
          type: 'object',
          description:
            '类型化元数据。角色的外观写在 metadata.appearance（如 {gender, age, hair, costume}）；' +
            '场景写在 metadata（如 {timeOfDay, lighting, location}）；' +
            '品牌写在 metadata（如 {colors, tone, slogan}）',
        },
      },
      required: ['type', 'name'],
    },
    mutating: true,
    async execute(args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      // 资产创建本身是一个 Skill，因此走统一的任务链路：
      // 这样它同样享有幂等、重试、版本与审计能力，而不是一条旁路写入
      const type = typeof args.type === 'string' ? args.type : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (type.length === 0 || name.length === 0) {
        return { ok: false, error: '必须提供 type 与 name' };
      }

      const task = await deps.tasks.enqueue({
        skillId: 'asset.create',
        projectId: ctx.projectId,
        input: {
          type,
          name,
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(args.metadata !== null && typeof args.metadata === 'object'
            ? { metadata: args.metadata }
            : {}),
        },
        contentId: ctx.contentId,
        sessionId: ctx.sessionId,
      });

      return {
        ok: true,
        result: { taskId: task.taskId, status: task.status, deduplicated: task.deduplicated },
        message: `已提交创建${type}「${name}」的任务`,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* content.create                                                             */
/* -------------------------------------------------------------------------- */

function contentCreate(deps: AgentDeps): AgentTool {
  return {
    name: 'content.create',
    description:
      '在当前项目中创建一条新内容（一条广告、一期短视频、一集短剧、一条数字人口播等）。' +
      '创建后即可围绕它规划制作流程并执行技能。' +
      '注意：本工具只创建内容记录与创作参数，不执行生成。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [...CONTENT_TYPES],
          description: '内容类型：advertisement / short_video / short_drama / digital_human / promo / visual_content',
        },
        title: { type: 'string', description: '内容标题' },
        brief: { type: 'string', description: '需求描述，尽量保留用户的原始表述' },
        metadata: {
          type: 'object',
          description:
            '创作参数：duration（秒）、platform、audience、style（数组）、episodes（集数）、genre（题材）',
        },
      },
      required: ['type', 'title'],
    },
    mutating: true,
    async execute(args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const type = typeof args.type === 'string' ? args.type : '';
      const title = typeof args.title === 'string' ? args.title : '';
      if (!(CONTENT_TYPES as readonly string[]).includes(type)) {
        return {
          ok: false,
          error: `内容类型非法：${type}。可用值：${CONTENT_TYPES.join('、')}`,
        };
      }
      if (title.length === 0) return { ok: false, error: '必须提供 title' };

      try {
        const created = await deps.contents.create({
          projectId: ctx.projectId,
          type: type as ContentType,
          title,
          brief: typeof args.brief === 'string' ? args.brief : '',
          metadata:
            args.metadata !== null && typeof args.metadata === 'object'
              ? (args.metadata as Record<string, unknown>)
              : {},
        });

        return {
          ok: true,
          result: { contentId: created.id, type: created.type, title: created.title },
          message: `已创建内容「${created.title}」`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof ValidationError ? err.userMessage : '创建内容失败',
        };
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* content.get                                                                */
/* -------------------------------------------------------------------------- */

function contentGet(deps: AgentDeps): AgentTool {
  return {
    name: 'content.get',
    description:
      '读取一条内容的完整信息（创作参数、状态）。' +
      '在需要确认当前内容的时长、平台、受众等参数时调用。' +
      '不传 contentId 时返回项目下全部内容的清单。',
    parameters: {
      type: 'object',
      properties: {
        contentId: { type: 'string', description: '内容 id。留空则列出项目内全部内容' },
      },
      required: [],
    },
    mutating: false,
    async execute(args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const contentId = typeof args.contentId === 'string' ? args.contentId : ctx.contentId;

      if (contentId === null || contentId === undefined || contentId.length === 0) {
        const list = await deps.contents.list(ctx.projectId, { limit: 20 });
        return {
          ok: true,
          result: { count: list.length, contents: list },
          message: list.length > 0 ? `项目中有 ${list.length} 条内容` : '项目中还没有内容',
        };
      }

      const content = await deps.contents.get(contentId);
      if (content === null) return { ok: false, error: `内容 ${contentId} 不存在` };

      return { ok: true, result: content, message: `已读取内容「${content.title}」` };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* skill.list                                                                 */
/* -------------------------------------------------------------------------- */

function skillList(deps: AgentDeps): AgentTool {
  return {
    name: 'skill.list',
    description:
      '列出当前可执行的技能（能力清单）。' +
      '在不确定有哪些能力可用、或需要选择合适的技能时调用。' +
      '只会返回**已实现**的技能，未实现的不会出现。',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: '按类别筛选：text / script / image / video / audio / voice / digital_human / subtitle / edit / asset',
        },
      },
      required: [],
    },
    mutating: false,
    async execute(
      args: Record<string, unknown>,
      _ctx: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const category = typeof args.category === 'string' ? args.category : undefined;
      const all = deps.skills.listImplemented();
      const filtered =
        category !== undefined ? all.filter((s) => s.category === category) : all;

      return {
        ok: true,
        result: {
          count: filtered.length,
          skills: filtered.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            category: s.category,
            risk: s.risk,
            requiresConfirmation: s.risk === 'high',
            ...(s.userHint !== undefined ? { hint: s.userHint } : {}),
          })),
        },
        message: `共有 ${filtered.length} 个可用技能`,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* skill.execute                                                              */
/* -------------------------------------------------------------------------- */

function skillExecute(deps: AgentDeps): AgentTool {
  return {
    name: 'skill.execute',
    description:
      '执行一个技能。这是真正产生内容（图片、视频、脚本、配音等）的方式。' +
      '调用前应当先用 skill.list 确认技能存在，并把用户的意图转换成该技能需要的输入参数。' +
      '执行是异步的：本工具返回 taskId，任务会进入队列由后台完成。' +
      '对于高成本技能（如 video.generate），任务会先停在等待用户确认状态。',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能 id，如 image.generate / script.generate' },
        input: { type: 'object', description: '该技能需要的输入参数' },
        contentId: { type: 'string', description: '关联的内容 id（可选，默认用当前内容）' },
      },
      required: ['skillId'],
    },
    mutating: true,
    async execute(args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const skillId = typeof args.skillId === 'string' ? args.skillId : '';
      if (skillId.length === 0) return { ok: false, error: '必须提供 skillId' };

      // 先校验技能存在且已实现：避免把一个必然失败的任务塞进队列
      const available = deps.skills.listImplemented();
      const skill = available.find((s) => s.id === skillId);
      if (skill === undefined) {
        return {
          ok: false,
          error: `技能 ${skillId} 不存在或尚未实现。可用技能可用 skill.list 查询。`,
        };
      }

      const input =
        args.input !== null && typeof args.input === 'object'
          ? (args.input as Record<string, unknown>)
          : {};

      // 高成本技能：在保守策略下不直接执行，而是先落一条 waiting_user 任务，
      // 等用户确认后再入队。
      //
      // 为什么必须落库而不是直接返回：确认按钮需要一个真实对象。
      // 若只返回 requiresConfirmation 而不创建任务，
      // POST /api/agent/sessions/:id/confirm 会查不到任何等待中的任务，
      // 于是用户点了「确认执行」却什么都没发生 —— 这正是第 66、78 条
      // 禁止的「看似成功的失败」。
      if (skill.risk === 'high' && ctx.confirmationPolicy === 'reject') {
        const pending = await deps.tasks.enqueue({
          skillId,
          projectId: ctx.projectId,
          input,
          contentId: typeof args.contentId === 'string' ? args.contentId : ctx.contentId,
          sessionId: ctx.sessionId,
          idempotencyKey: undefined,
          initialStatus: 'waiting_user',
        });

        return {
          ok: false,
          requiresConfirmation: true,
          error: `「${skill.name}」属于高成本操作，需要你确认后才执行`,
          message: `「${skill.name}」需要你确认后才会执行`,
          result: {
            taskId: pending.taskId,
            status: pending.status,
            skillId,
            deduplicated: pending.deduplicated,
            requiresConfirmation: true,
          },
        };
      }

      const contentId =
        typeof args.contentId === 'string' ? args.contentId : ctx.contentId;

      const task = await deps.tasks.enqueue({
        skillId,
        projectId: ctx.projectId,
        input,
        contentId,
        sessionId: ctx.sessionId,
        idempotencyKey: undefined,
      });

      return {
        ok: true,
        result: {
          taskId: task.taskId,
          status: task.status,
          skillId,
          deduplicated: task.deduplicated,
        },
        message: task.deduplicated
          ? `「${skill.name}」已经在处理中`
          : `已提交「${skill.name}」任务`,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* memory.update                                                              */
/* -------------------------------------------------------------------------- */

function memoryUpdate(deps: AgentDeps): AgentTool {
  return {
    name: 'memory.update',
    description:
      '更新项目记忆（品牌规范、视觉风格、制作规则、用户偏好）。' +
      '当用户表达了**长期有效**的偏好或规则时调用，例如「以后所有画面都偏冷调」。' +
      '不要把一次性的具体要求写进项目记忆。',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description:
            '要合并进项目记忆的片段，可用键：goals / brand / visual / production / preferences / notes',
        },
      },
      required: ['patch'],
    },
    mutating: true,
    async execute(args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      if (args.patch === null || typeof args.patch !== 'object') {
        return { ok: false, error: '必须提供 patch 对象' };
      }
      await deps.projects.mergeMemory(ctx.projectId, args.patch as Record<string, unknown>);
      return {
        ok: true,
        result: { updated: Object.keys(args.patch as Record<string, unknown>) },
        message: '已更新项目记忆',
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 工具集装配                                                                  */
/* -------------------------------------------------------------------------- */

/** 构建全部 Agent 工具 */
export function buildAgentTools(options: BuildToolsOptions): AgentTool[] {
  const { deps } = options;
  return [
    projectGet(deps),
    assetSearch(deps),
    assetCreate(deps),
    contentCreate(deps),
    contentGet(deps),
    skillList(deps),
    skillExecute(deps),
    memoryUpdate(deps),
  ];
}

/** 工具名清单（供文档与测试） */
export const AGENT_TOOL_NAMES = [
  'project.get',
  'asset.search',
  'asset.create',
  'content.create',
  'content.get',
  'skill.list',
  'skill.execute',
  'memory.update',
] as const;
