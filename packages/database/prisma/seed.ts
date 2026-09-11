/**
 * 种子数据
 *
 * 目标：`pnpm db:seed` 之后，系统立刻处于「可探索」状态，
 * 而不是一个空数据库 —— 空库会让前端与 Agent 都无法验证任何东西。
 *
 * 写入内容：
 * 1. **技能目录**：把 @svh/skills 的代码定义同步进 skills 表
 *    （代码是唯一事实来源，表用于权限配置与外键关联）
 * 2. **四套内置工作流**：作为全局模板（isTemplate=true, projectId=null）
 * 3. **演示项目**：一个咖啡品牌广告项目，带项目记忆、产品 / 品牌 / 角色资产、
 *    一条广告内容及其版本
 *
 * 幂等：全部使用 upsert，可重复执行。
 */
// 必须在构造 PrismaClient 之前加载 .env：
// PrismaClient 会在构造时读取 DATABASE_URL，晚一步就会报「环境变量未找到」。
import { loadEnvFile } from '@svh/config';

loadEnvFile(process.cwd());

import { disconnectPrisma, prisma } from '../src/client.js';
import { listSkills } from '@svh/skills';
import { listBuiltinWorkflows } from '@svh/workflow';
import { resolveAssetMetadata } from '@svh/domain';

async function seedSkills(): Promise<number> {
  const definitions = listSkills();

  for (const definition of definitions) {
    const data = {
      name: definition.name,
      description: definition.description,
      version: definition.version,
      category: definition.category,
      capabilities: definition.capabilities as string[],
      inputSchema: definition.inputSchema as never,
      outputSchema: definition.outputSchema as never,
      risk: definition.risk,
      accessTier: definition.accessTier,
      estimatedSeconds: definition.estimatedSeconds ?? 0,
      cancellable: definition.cancellable,
      retryable: definition.retryable,
      requiresConfirmation: definition.requiresConfirmation,
      aliases: definition.aliases,
      userHint: definition.userHint ?? null,
      hidden: definition.hidden,
    };

    await prisma.skill.upsert({
      where: { id: definition.id },
      create: { id: definition.id, ...data },
      update: data,
    });
  }

  return definitions.length;
}

async function seedWorkflows(): Promise<number> {
  const definitions = listBuiltinWorkflows();
  let count = 0;

  for (const definition of definitions) {
    // 内置模板以 (type, name, isTemplate) 作为自然键做幂等
    const existing = await prisma.workflow.findFirst({
      where: { type: definition.type, name: definition.name, isTemplate: true, projectId: null },
      select: { id: true },
    });

    const data = {
      description: definition.description,
      version: definition.version,
      origin: definition.origin,
      nodes: definition.nodes as never,
      edges: definition.edges as never,
      metadata: definition.metadata as never,
      isTemplate: true,
    };

    if (existing) {
      await prisma.workflow.update({ where: { id: existing.id }, data });
    } else {
      await prisma.workflow.create({
        data: { type: definition.type, name: definition.name, ...data },
      });
    }
    count += 1;
  }

  return count;
}

async function seedDemoProject(): Promise<string> {
  const projectName = '品牌 A · 咖啡内容项目';

  const existing = await prisma.project.findFirst({
    where: { name: projectName },
    select: { id: true },
  });

  // Project Memory：Agent 每次规划都要读取的顶层约束
  const memory = {
    goals: {
      objective: '为冷萃咖啡新品建立年轻、时尚的品牌形象',
      keyResults: ['完成 1 支 30 秒品牌广告', '产出 3 张产品主视觉'],
      primaryContentTypes: ['advertisement', 'visual_content'],
      platforms: ['xiaohongshu', 'douyin'],
    },
    brand: {
      tone: '克制、专业，但不说教',
      must: ['保留大面积留白', '产品始终占据画面视觉中心'],
      forbidden: ['高饱和撞色', '夸张促销文案'],
    },
    visual: {
      style: '电影感、冷调、自然光',
      styleKeywords: ['电影感', '冷调', '质感', '自然光'],
      defaultAspectRatio: '16:9',
      negativePrompt: '过度锐化、塑料感、廉价金属反光',
    },
    production: {
      defaultShotDuration: 5,
      defaultContentDuration: 30,
      requireConfirmationForHighCost: true,
      highCostThreshold: 10,
    },
    preferences: { language: 'zh-CN', verbosity: 'standard' },
  };

  const project = existing
    ? await prisma.project.update({
        where: { id: existing.id },
        data: { memory: memory as never },
      })
    : await prisma.project.create({
        data: {
          name: projectName,
          description: '演示项目：展示 Content / Asset / Workflow / Project Memory 如何协同',
          memory: memory as never,
        },
      });

  return project.id;
}

/**
 * 创建演示资产。
 * 每种资产类型都经过 `resolveAssetMetadata` 校验 ——
 * 种子数据也必须遵守与运行时相同的类型约束，否则会把非法数据带进库。
 */
async function seedAssets(projectId: string): Promise<void> {
  const assets = [
    {
      type: 'brand' as const,
      name: '品牌A',
      slug: '品牌A',
      description: '精品冷萃咖啡品牌',
      metadata: {
        colors: ['#1B1B1B', '#C8A97E', '#F5F1EA'],
        fonts: ['思源宋体', 'Inter'],
        tone: '克制、专业',
        slogan: '慢一点，才尝得出',
        industry: '精品咖啡',
        guidelines: {
          must: ['保留大面积留白', 'Logo 保持最小安全边距'],
          forbidden: ['高饱和撞色', '促销爆炸贴'],
          visualStyle: '冷调电影感',
        },
      },
    },
    {
      type: 'product' as const,
      name: '冷萃咖啡液',
      slug: '产品A',
      description: '12 小时低温慢萃，无糖零添加',
      metadata: {
        sellingPoints: ['12 小时低温慢萃', '零糖零添加', '冷热皆宜'],
        category: '即饮咖啡',
        specs: { 净含量: '280ml', 保质期: '9 个月', 储存: '冷藏' },
        targetAudience: '22-30 岁都市女性',
        usageScenarios: ['办公室提神', '健身后', '周末早餐'],
      },
    },
    {
      type: 'character' as const,
      name: '苏晚',
      slug: '苏晚',
      description: '年轻女性，黑色长发，气质清冷',
      metadata: {
        appearance: {
          gender: 'female' as const,
          age: 25,
          hair: '黑色长直发',
          bodyType: '纤细高挑',
          costume: '米白色针织衫',
          vibe: '清冷疏离',
        },
        role: '广告女主',
        personality: '独立、安静、对生活有自己的讲究',
      },
    },
    {
      type: 'scene' as const,
      name: '晨光厨房',
      slug: '晨光厨房',
      description: '清晨的公寓厨房，自然光斜射',
      metadata: {
        timeOfDay: '清晨',
        lighting: '低角度自然光，柔和阴影',
        location: '城市公寓开放式厨房',
        atmosphere: '安静、干净、有生活痕迹',
        colorPalette: ['#F5F1EA', '#C8A97E', '#8A8A8A'],
        cameraNotes: '手持轻微晃动，浅景深',
      },
    },
  ];

  for (const asset of assets) {
    // 与运行时同一套校验：类型不符的 metadata 不允许入库
    const metadata = resolveAssetMetadata(asset.type, asset.metadata);

    await prisma.asset.upsert({
      where: { projectId_slug: { projectId, slug: asset.slug } },
      create: {
        projectId,
        type: asset.type,
        name: asset.name,
        slug: asset.slug,
        description: asset.description,
        metadata: metadata as never,
        tags: ['演示数据'],
        status: 'active',
      },
      update: {
        name: asset.name,
        description: asset.description,
        metadata: metadata as never,
      },
    });
  }
}

async function seedContent(projectId: string): Promise<void> {
  const title = '30 秒冷萃咖啡品牌广告';

  const existing = await prisma.content.findFirst({
    where: { projectId, title },
    select: { id: true, workflowId: true },
  });

  // 绑定内置的广告工作流，使内容一创建就有可执行的制作流程
  const adWorkflow = await prisma.workflow.findFirst({
    where: { type: 'advertisement', isTemplate: true },
    select: { id: true },
  });

  const metadata = {
    duration: 30,
    aspectRatio: '16:9',
    platform: 'xiaohongshu',
    audience: '22-30 岁都市女性',
    style: ['电影感', '冷调', '高级'],
    productSlugs: ['产品A'],
    brandSlug: '品牌A',
  };

  const content = existing
    ? await prisma.content.update({
        where: { id: existing.id },
        data: { metadata: metadata as never, workflowId: adWorkflow?.id ?? null },
      })
    : await prisma.content.create({
        data: {
          projectId,
          type: 'advertisement',
          title,
          brief: '面向年轻女性的冷萃咖啡品牌广告，整体高级、有质感，强调慢萃工艺',
          metadata: metadata as never,
          workflowId: adWorkflow?.id ?? null,
          status: 'draft',
        },
      });

  // 为内容建立资产引用关系，使「修改角色需要同步更新几处」可被查询
  const assetSlugs = ['品牌A', '产品A', '苏晚', '晨光厨房'];
  for (const slug of assetSlugs) {
    const asset = await prisma.asset.findUnique({
      where: { projectId_slug: { projectId, slug } },
      select: { id: true },
    });
    if (!asset) continue;

    await prisma.assetReference.upsert({
      where: {
        assetId_refType_refId_refPath: {
          assetId: asset.id,
          refType: 'content',
          refId: content.id,
          refPath: `content.${content.id}`,
        },
      },
      create: {
        assetId: asset.id,
        refType: 'content',
        refId: content.id,
        refPath: `content.${content.id}`,
        projectId,
        contentId: content.id,
        notes: '广告内容引用',
      },
      update: {},
    });
  }

  // 一条初始版本记录，使版本历史从创建即可见
  const versionCount = await prisma.contentVersion.count({ where: { contentId: content.id } });
  if (versionCount === 0) {
    await prisma.contentVersion.create({
      data: {
        contentId: content.id,
        version: 1,
        snapshot: {
          title: content.title,
          brief: content.brief,
          metadata,
          status: content.status,
        } as never,
        changelog: '创建内容',
      },
    });
  }
}

async function main(): Promise<void> {
  console.log('[seed] 开始写入种子数据…');

  const skillCount = await seedSkills();
  console.log(`[seed] 技能目录：${skillCount} 个`);

  const workflowCount = await seedWorkflows();
  console.log(`[seed] 内置工作流模板：${workflowCount} 套`);

  const projectId = await seedDemoProject();
  await seedAssets(projectId);
  await seedContent(projectId);
  console.log(`[seed] 演示项目已就绪：${projectId}`);
  console.log('[seed] 完成。可用 pnpm --filter @svh/api dev 启动 API 后访问 /api/projects 查看。');
}

main()
  .catch((err: unknown) => {
    console.error('[seed] 失败：', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
