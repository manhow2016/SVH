/**
 * 时间线仓储集成测试（连真库）
 *
 * 其中「CHECK 负向对照」是关键：它绕过仓储直接用 SQL 写入非法数据，
 * 证明那条约束真的在数据库里生效 —— 否则它只是一行没人执行的 SQL。
 *
 * ── 为什么还要有「读模型护栏」与「写边界校验」两组用例 ──
 * 1. 写边界（Ruling 10）：仓储原先直接吃裸 number。`JSON.parse('{"a":1e999}')`
 *    在 JS 里得到 `Infinity`，而 Fastify 默认就用 `JSON.parse` 解析请求体 ——
 *    它会一路写进 float8 列并污染时间线算术。这里的用例断言 `createClip` 在
 *    写库前就被 schema 拦下，且**库里没有多出任何行**。
 * 2. 读模型护栏：`getTimeline` 逐条 `timelineClipSchema.parse` 而不是 `as`
 *    断言。只有拿真实行去解析，schema 与库列漂移时才会立刻红灯。下面既断言
 *    返回行的键集合与读模型完全一致（`...row` 展开会把 createdAt/updatedAt
 *    漏出去），也用一条「数据库接受、读模型拒绝」的探针行证明解析真的在跑
 *    （退回 `as` 断言就会变红）。
 * 3. 来源分支：CHECK 的语义是「**恰好一个**来源」，只正例 shot 来源是钉不住的 ——
 *    一条误写成 `shotId IS NOT NULL AND assetId IS NULL` 的约束能让所有 shot 用例
 *    全绿却拒掉全部素材来源片段。因此 asset-only 在数据库层与仓储层各有一条正例。
 *
 * ── 为什么负向对照要单独用一个静默 client ──
 * 那两条用例**故意**触发数据库报错，而共享 client 的日志级别是 `['warn','error']`，
 * 会把 `prisma:error` 连同原始 SQL 打到测试输出里。这里用一个 `log: []` 的局部
 * client 跑这两条（断言一字不改，仍是真实的 23514 + 约束名），既不动共享 client，
 * 也让测试输出保持干净。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { timelineClipSchema, timelineSchema } from '@svh/domain';

import { disconnectPrisma, prisma, PrismaClient } from '../src/index.js';
import { createShot, deleteShot } from '../src/storyboard.js';
import {
  createClip,
  deleteClip,
  ensureDefaultTracks,
  getTimeline,
  moveClip,
  updateClip,
} from '../src/timeline.js';

/**
 * 只用于「故意触发数据库拒绝」的用例：`log: []` 让 Prisma 不打印 error 日志。
 * 它连的是同一个库，行为与共享 client 无异（错误照抛，只是不往 stdout 写）。
 */
const silent = new PrismaClient({ log: [] });

/** 读模型的字段清单：返回的片段必须与它完全一致（多一列少一列都算漂移） */
const CLIP_KEYS = [
  'assetId',
  'durationSeconds',
  'id',
  'shotId',
  'startSeconds',
  'trackId',
] as const;

/** CHECK 负向对照用的固定 id：用完必须确认没有残留 */
const ILLEGAL_CLIP_IDS = ['clip_both', 'clip_none'] as const;

let projectId = '';
let contentId = '';
let shotId = '';
/** 素材资产：供 asset-only 来源的正例使用（shot 与 asset 两条分支都要被证明） */
let assetId = '';
/** 完全空的 content：没有轨道也没有片段，用来钉「空时间线」的返回形状 */
let emptyContentId = '';

beforeAll(async () => {
  const project = await prisma.project.create({ data: { name: `时间线测试-${Date.now()}` } });
  projectId = project.id;
  const content = await prisma.content.create({
    data: { projectId, type: 'advertisement', title: '测试内容' },
  });
  contentId = content.id;
  const shot = await createShot({ contentId, durationSeconds: 2, description: '镜头 1' });
  shotId = shot.id;
  const asset = await prisma.asset.create({
    data: { projectId, type: 'audio', name: 'BGM', slug: `bgm-fixture-${Date.now()}` },
  });
  assetId = asset.id;
  const empty = await prisma.content.create({
    data: { projectId, type: 'advertisement', title: '空内容' },
  });
  emptyContentId = empty.id;
});

afterAll(async () => {
  // 只删本次测试自建的 project：其下 content / shot / asset / track / clip
  // 全部由外键 ON DELETE CASCADE 一并清除，不触碰库里任何既有数据。
  //
  // ── 为什么在删 project 之前仍显式删一次片段（Ruling 28 之后的选择）──
  // 级联策略其实已经修正：`timeline_clips.assetId` 由 SET NULL 改为 Cascade，
  // 所以 asset-only 片段不再会因「资产被删 → 来源被置空」而撞 CHECK。但这里仍然
  // 保留显式清理，理由是 **teardown 不该把「fixture 不泄漏」寄托在某条外键策略
  // 的正确性上** —— 上一轮就是这么泄漏的：策略一旦是 SET NULL，整笔 project
  // 删除会失败，而失败发生在「用例已经红了」之后，最不该再制造新垃圾的时刻。
  // 级联语义本身由「来源级联删除（Ruling 28）」的 ② 号用例正面证明，不靠这里兜。
  if (projectId) {
    await prisma.timelineClip.deleteMany({ where: { track: { content: { projectId } } } });
    await prisma.project.delete({ where: { id: projectId } });
  }
  await silent.$disconnect();
  await disconnectPrisma();
});

/** 取第 n 条默认轨；缺失时直接报错，避免用例在 `undefined` 上空转 */
async function trackAt(index: number, name: string) {
  const tracks = await ensureDefaultTracks(contentId);
  const track = tracks[index];
  if (!track) throw new Error(`缺少${name}轨`);
  return track;
}

/** 取画面轨上按起点排序的第 n 条片段 */
async function clipAt(trackId: string, index: number) {
  const clips = await prisma.timelineClip.findMany({
    where: { trackId },
    orderBy: { startSeconds: 'asc' },
  });
  const clip = clips[index];
  if (!clip) throw new Error(`片段不足：需要第 ${index + 1} 条，实际只有 ${clips.length} 条`);
  return clip;
}

describe('时间线仓储', () => {
  it('默认三条轨幂等创建', async () => {
    const first = await ensureDefaultTracks(contentId);
    const second = await ensureDefaultTracks(contentId);
    expect(first.map((track) => track.kind)).toEqual(['video', 'audio', 'subtitle']);
    expect(second.map((track) => track.id)).toEqual(first.map((track) => track.id));
    // 标签与顺序也是契约的一部分（brief 指定 画面/声音/字幕，order 0/1/2）
    expect(first.map((track) => [track.kind, track.label, track.order])).toEqual([
      ['video', '画面', 0],
      ['audio', '声音', 1],
      ['subtitle', '字幕', 2],
    ]);
    // 幂等不只是「返回同一批 id」：库里也不能多出第二套轨
    expect(await prisma.timelineTrack.count({ where: { contentId } })).toBe(3);
  });

  it('补齐默认轨时避开已占用的 order（不会撞 @@unique([contentId, order])）', async () => {
    // 单独的 content：直接建两条 order 不连续的轨（0 与 2），模拟「轨道不是默认那三条」
    const content = await prisma.content.create({
      data: { projectId, type: 'advertisement', title: '非连续 order 内容' },
    });
    await prisma.timelineTrack.create({
      data: { contentId: content.id, kind: 'video', label: '画面', order: 0 },
    });
    await prisma.timelineTrack.create({
      data: { contentId: content.id, kind: 'audio', label: '声音', order: 2 },
    });

    // 朴素的「order = 现有轨道数」会算出 2 —— 正好撞上已占用的 2 并整笔失败
    const tracks = await ensureDefaultTracks(content.id);
    expect(tracks.map((track) => [track.kind, track.order])).toEqual([
      ['video', 0],
      ['audio', 2],
      ['subtitle', 3],
    ]);
  });

  it('片段挂在镜头上，时间线按起点排序返回', async () => {
    const video = await trackAt(0, '画面');

    await createClip({ trackId: video.id, shotId, startSeconds: 4, durationSeconds: 2 });
    await createClip({ trackId: video.id, shotId, startSeconds: 0, durationSeconds: 4 });

    const timeline = await getTimeline(contentId);
    const clips = timeline.tracks.flatMap((track) => track.clips);
    expect(clips.map((clip) => clip.startSeconds)).toEqual([0, 4]);
    expect(timeline.durationSeconds).toBe(6);
    // 来源必须原样带回来（shot 来源的片段 assetId 为 null）
    expect(clips.map((clip) => [clip.shotId, clip.assetId])).toEqual([
      [shotId, null],
      [shotId, null],
    ]);
  });

  it('同轨重叠被拒绝', async () => {
    const video = await trackAt(0, '画面');
    // 报错必须可诊断：带轨道 id 与候选时间段，否则调用方只知道「重叠了」
    await expect(
      createClip({ trackId: video.id, shotId, startSeconds: 1, durationSeconds: 5 }),
    ).rejects.toThrow(/重叠/);
    await expect(
      createClip({ trackId: video.id, shotId, startSeconds: 1, durationSeconds: 5 }),
    ).rejects.toThrow(new RegExp(video.id));
  });

  it('不变量 4 的另一半：跨轨允许重叠（同一时间段放在两条轨上必须成功）', async () => {
    const video = await trackAt(0, '画面');
    const audio = await trackAt(1, '声音');

    // 与上面「同轨重叠被拒绝」完全相同的时间段，只把轨道换成另一条。
    // 不变量的完整表述是「同轨不重叠、**跨轨允许重叠**」：只测前半句的话，
    // 一个把轨道维度漏掉的「全局不重叠」实现也会全绿。
    const onVideo = await createClip({
      trackId: video.id,
      shotId,
      startSeconds: 60,
      durationSeconds: 2,
    });
    const onAudio = await createClip({
      trackId: audio.id,
      shotId,
      startSeconds: 60,
      durationSeconds: 2,
    });

    expect(onVideo.startSeconds).toBe(onAudio.startSeconds);
    expect(onVideo.trackId).not.toBe(onAudio.trackId);
    // 反空转：两条行都真的落库了，且各挂在自己的轨上
    expect(
      await prisma.timelineClip.count({ where: { id: { in: [onVideo.id, onAudio.id] } } }),
    ).toBe(2);
    expect(await prisma.timelineClip.count({ where: { trackId: video.id, startSeconds: 60 } })).toBe(1);
    expect(await prisma.timelineClip.count({ where: { trackId: audio.id, startSeconds: 60 } })).toBe(1);

    // 用完即删：后面的「总时长」用例依赖画面轨的最右端片段
    await deleteClip(onVideo.id);
    await deleteClip(onAudio.id);
  });

  it('移动片段到空位可行，移到重叠位被拒', async () => {
    const video = await trackAt(0, '画面');
    const first = await clipAt(video.id, 0);

    await expect(moveClip(first.id, { startSeconds: 10 })).resolves.toMatchObject({
      startSeconds: 10,
    });
    await expect(moveClip(first.id, { startSeconds: 4 })).rejects.toThrow(/重叠/);
    await expect(updateClip(first.id, { durationSeconds: 1 })).resolves.toMatchObject({
      durationSeconds: 1,
    });
  });

  it('moveClip 换轨时在目标轨上校验重叠', async () => {
    const video = await trackAt(0, '画面');
    const audio = await trackAt(1, '声音');

    const moving = await createClip({
      trackId: video.id,
      shotId,
      startSeconds: 20,
      durationSeconds: 1,
    });
    const blocker = await createClip({
      trackId: audio.id,
      shotId,
      startSeconds: 30,
      durationSeconds: 1,
    });

    // 目标轨上有东西挡路：必须在**目标轨**上判断，而不是只看来源轨
    await expect(moveClip(moving.id, { trackId: audio.id, startSeconds: 30 })).rejects.toThrow(
      /重叠/,
    );
    // 被拒后不得留下半成品：片段仍在画面轨原处
    const untouched = await prisma.timelineClip.findUniqueOrThrow({ where: { id: moving.id } });
    expect(untouched.trackId).toBe(video.id);
    expect(untouched.startSeconds).toBe(20);

    // 换到空位可行
    await expect(
      moveClip(moving.id, { trackId: audio.id, startSeconds: 5 }),
    ).resolves.toMatchObject({ trackId: audio.id, startSeconds: 5 });

    // 只用来挡路的 30 秒片段用完即删：留着它会让下面那条「总时长 ≤ 11」的
    // 断言（brief 给定的口径）失去意义
    await deleteClip(blocker.id);
  });

  it('CHECK 负向对照：双来源被数据库拒绝', async () => {
    const audio = await trackAt(1, '声音');

    // 绕过仓储、绕开 domain，直接写库：只有迁移里那条 CHECK 能挡住它。
    // 用静默 client（log: []）：这条用例故意触发数据库报错，不该把 prisma:error
    // 连同 SQL 打进测试输出；断言本身一字不改。
    const error = await silent
      .$executeRawUnsafe(
        `INSERT INTO "timeline_clips" ("id","trackId","shotId","assetId","startSeconds","durationSeconds","createdAt","updatedAt")
         VALUES ('clip_both', $1, $2, $3, 0, 1, NOW(), NOW())`,
        audio.id,
        shotId,
        assetId,
      )
      .then(
        () => null,
        (cause: unknown) => cause,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/check|约束|constraint/i);
    // 更强的锚点：报错点名了那条约束，说明拦下它的确实是 CHECK
    //（而不是 NOT NULL、外键或主键冲突）
    expect((error as Error).message).toMatch(/timeline_clips_exactly_one_source_check/);
  });

  it('CHECK 负向对照：无来源被数据库拒绝', async () => {
    const audio = await trackAt(1, '声音');

    const error = await silent
      .$executeRawUnsafe(
        `INSERT INTO "timeline_clips" ("id","trackId","shotId","assetId","startSeconds","durationSeconds","createdAt","updatedAt")
         VALUES ('clip_none', $1, NULL, NULL, 0, 1, NOW(), NOW())`,
        audio.id,
      )
      .then(
        () => null,
        (cause: unknown) => cause,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/check|约束|constraint/i);
    expect((error as Error).message).toMatch(/timeline_clips_exactly_one_source_check/);
  });

  it('对照组：同一条 SQL 只给一个来源时可插入（证明上面的报错来自 CHECK 而非语句本身）', async () => {
    const audio = await trackAt(1, '声音');

    // 与上面两条负向对照逐字相同的语句，只把来源改成「恰好一个」：
    // 它能插进去，才说明上面两条失败的原因是被约束拦下，而不是列名写错之类的自伤。
    await prisma.$executeRawUnsafe(
      `INSERT INTO "timeline_clips" ("id","trackId","shotId","assetId","startSeconds","durationSeconds","createdAt","updatedAt")
       VALUES ('clip_probe_ok', $1, $2, NULL, 0, 1, NOW(), NOW())`,
      audio.id,
      shotId,
    );
    expect(await prisma.timelineClip.count({ where: { id: 'clip_probe_ok' } })).toBe(1);

    await prisma.$executeRawUnsafe(`DELETE FROM "timeline_clips" WHERE "id" = 'clip_probe_ok'`);
  });

  it('两条非法插入没有留下任何残留行', async () => {
    const residue = await prisma.timelineClip.findMany({
      where: { id: { in: [...ILLEGAL_CLIP_IDS] } },
      select: { id: true },
    });
    expect(residue).toEqual([]);
    // 探针行同样不能留在库里
    expect(await prisma.timelineClip.count({ where: { id: 'clip_probe_ok' } })).toBe(0);
  });

  it('删片段后时间线变短', async () => {
    const video = await trackAt(0, '画面');
    const before = await getTimeline(contentId);
    const clips = await prisma.timelineClip.findMany({
      where: { trackId: video.id },
      orderBy: { startSeconds: 'asc' },
    });
    const last = clips[clips.length - 1];
    if (!last) throw new Error('缺少片段');
    await deleteClip(last.id);
    const timeline = await getTimeline(contentId);
    expect(timeline.durationSeconds).toBeLessThanOrEqual(11);
    // 反空转：不能只断言「≤ 11」——被删的必须真的是最右端那条，总时长要真的变短
    expect(timeline.durationSeconds).toBeLessThan(before.durationSeconds);
  });
});

/**
 * 空时间线的返回形状
 *
 * 「没有轨道」与「有轨道但没有片段」是两种不同的空：前者 `tracks` 是空数组，
 * 后者必须是三条默认轨、每条 `clips` 为空，而两者的 `durationSeconds` 都是 0。
 * 没有这两条，`getTimeline` 在空内容上返回什么形状是不受约束的。
 */
describe('空时间线', () => {
  it('没有任何轨道时返回空轨道数组与 0 时长', async () => {
    expect(await getTimeline(emptyContentId)).toEqual({
      contentId: emptyContentId,
      tracks: [],
      durationSeconds: 0,
    });
  });

  it('只有默认轨没有片段时，每条轨 clips 为空且总时长为 0', async () => {
    // 自建 content（不复用别的用例的副作用）：默认三轨 + 零片段
    const content = await prisma.content.create({
      data: { projectId, type: 'advertisement', title: '空轨内容' },
    });
    await ensureDefaultTracks(content.id);

    const timeline = await getTimeline(content.id);
    expect(timeline.durationSeconds).toBe(0);
    expect(timeline.tracks.map((track) => track.kind)).toEqual(['video', 'audio', 'subtitle']);
    expect(timeline.tracks.map((track) => track.clips)).toEqual([[], [], []]);
  });
});

/**
 * 读模型护栏
 *
 * 仓储的 `getTimeline` 先是逐列映射、再逐条 `timelineClipSchema.parse`。
 * 前者让「返回形状」可控，后者让「读模型」成为可执行契约 —— 缺一列会立刻
 * 抛错，多一列（比如 Prisma 的 createdAt/updatedAt）也进不了返回值。
 */
describe('读模型护栏', () => {
  it('返回的片段逐列映射且能被读模型解析（含整棵 Timeline）', async () => {
    const video = await trackAt(0, '画面');
    const timeline = await getTimeline(contentId);
    const clips = timeline.tracks.flatMap((track) => track.clips);
    expect(clips.length).toBeGreaterThan(0);

    for (const clip of clips) {
      // 键集合必须与读模型完全一致：多一列（`...row` 展开会带出 createdAt/updatedAt）
      // 或少一列（漏写某个字段）都在这里失败
      expect(Object.keys(clip).sort()).toEqual([...CLIP_KEYS].sort());
      expect(timelineClipSchema.parse(clip)).toEqual(clip);
    }

    // 整棵时间线也要能过 schema（轨道层同样不允许缺列 / 多列）
    expect(timelineSchema.parse(timeline)).toEqual(timeline);

    // 反空转：数据库裸行确实带 schema 之外的列，所以「逐列映射」这一步不是多余的
    const rawRow = await clipAt(video.id, 0);
    expect(Object.keys(rawRow)).toContain('createdAt');
    expect(Object.keys(rawRow)).toContain('updatedAt');
  });

  it('读路径真的在解析：数据库接受但读模型拒绝的行会让 getTimeline 报错', async () => {
    const video = await trackAt(0, '画面');
    const before = await prisma.timelineClip.count({ where: { trackId: video.id } });
    const probeId = 'probe_negative_start';

    // 负起点能通过数据库（那条 CHECK 只管「恰好一个来源」），
    // 因此它正是检验「读边界有没有在 parse」的探针：退回 `as` 断言就查不出来。
    await prisma.$executeRawUnsafe(
      `INSERT INTO "timeline_clips" ("id","trackId","shotId","assetId","startSeconds","durationSeconds","createdAt","updatedAt")
       VALUES ($1, $2, $3, NULL, -5, 1, NOW(), NOW())`,
      probeId,
      video.id,
      shotId,
    );

    try {
      expect(await prisma.timelineClip.count({ where: { id: probeId } })).toBe(1);
      await expect(getTimeline(contentId)).rejects.toThrow(/startSeconds/);
    } finally {
      // 探针行用完即删，不留残留、不影响其它用例
      await prisma.timelineClip.deleteMany({ where: { id: probeId } });
    }

    expect(await prisma.timelineClip.count({ where: { id: probeId } })).toBe(0);
    expect(await prisma.timelineClip.count({ where: { trackId: video.id } })).toBe(before);
  });

  it('带外写入的 Infinity 行必须让 getTimeline 报错（读边界的字面情形）', async () => {
    const video = await trackAt(0, '画面');
    const before = await prisma.timelineClip.count({ where: { trackId: video.id } });
    const probeId = 'probe_infinity_start';

    // 上面那条探针用的是「负起点」；这里补一条更字面的：库里真的躺着
    // `'Infinity'::float8`。写路径已经堵住（Ruling 10），但带外通道
    // （`$executeRaw`、脚本、将来的批量导入）仍能往 float8 列里塞进无穷大。
    // 让 Postgres 自己解析字面量，而不是把 JS 的 Infinity 当参数传进去 ——
    // 这样「库里的值」与「读模型要拒绝的值」是同一个东西。
    //
    // 实测补充：Prisma 的结果序列化会把非有限浮点转成 `null`（与 JSONB 写入时
    // 的静默转换同源），因此读模型拦下这一行时走的是「null 不是 number」这一支；
    // 读模型 `.finite()` 那一支由 domain 的 `timelineClipSchema` 用例直接钉住。
    await prisma.$executeRawUnsafe(
      `INSERT INTO "timeline_clips" ("id","trackId","shotId","assetId","startSeconds","durationSeconds","createdAt","updatedAt")
       VALUES ($1, $2, $3, NULL, 'Infinity'::float8, 1, NOW(), NOW())`,
      probeId,
      video.id,
      shotId,
    );

    try {
      // 反空转（在 SQL 侧证明）：库里存的确实是 float8 的无穷大 —— 用 `::text`
      // 取值，绕开 Prisma 结果序列化（它会把非有限浮点转成 null，见下）。
      const rawText = await prisma.$queryRawUnsafe<{ t: string }[]>(
        `SELECT "startSeconds"::text AS t FROM "timeline_clips" WHERE "id" = $1`,
        probeId,
      );
      expect(rawText[0]?.t).toBe('Infinity');

      // Prisma 的**模型读路径**自己就不肯把它物化成 number（用静默 client，
      // 沿用负向对照的惯例）：这一行不可能悄悄变成 Infinity 或 null 交给上层。
      await expect(
        silent.timelineClip.findUniqueOrThrow({ where: { id: probeId } }),
      ).rejects.toThrow(/Could not convert value inf/);

      // 真实读路径（getTimeline）同样必须响亮失败，报错里要能看出是哪一列。
      // 这里只能走共享 client（getTimeline 自己持有那个单例），因此会产生一条
      // `prisma:error` 日志 —— 这条噪声本身就是「真的在数据库读取处炸了」的证据，
      // 不是断言之外的意外。
      await expect(getTimeline(contentId)).rejects.toThrow(/startSeconds/);

      // 反空转：失败发生在读而不是插入：探针行仍在库里
      expect(await prisma.timelineClip.count({ where: { id: probeId } })).toBe(1);
    } finally {
      // 探针行用完即删，不留残留、不影响其它用例
      await prisma.timelineClip.deleteMany({ where: { id: probeId } });
    }

    expect(await prisma.timelineClip.count({ where: { id: probeId } })).toBe(0);
    expect(await prisma.timelineClip.count({ where: { trackId: video.id } })).toBe(before);
  });
});

/**
 * 写边界护栏（Ruling 10）
 *
 * 三条写路径都必须「先 parse 再写库」。用例特意用**不存在的 id** 去试空 patch：
 * 报错文案必须是 schema 的「至少需要一个字段」，而不是 Prisma 的「找不到记录」——
 * 这正好钉住「parse 在读写库之前」这个顺序。
 */
describe('写边界护栏（Ruling 10）', () => {
  it('createClip 拒绝 Infinity 起点，且一行都没写进去', async () => {
    const video = await trackAt(0, '画面');
    const before = await prisma.timelineClip.count({ where: { trackId: video.id } });

    // 反空转：Fastify 用 JSON.parse 解析请求体，1e999 得到的确实是 Infinity
    const fromJson = JSON.parse('{"startSeconds":1e999}') as { startSeconds: number };
    expect(fromJson.startSeconds).toBe(Number.POSITIVE_INFINITY);

    await expect(
      createClip({
        trackId: video.id,
        shotId,
        startSeconds: fromJson.startSeconds,
        durationSeconds: 2,
      }),
    ).rejects.toThrow(/finite/i);

    // 也被 schema 挡下的其它非法入参
    await expect(
      createClip({ trackId: video.id, shotId, startSeconds: -1, durationSeconds: 2 }),
    ).rejects.toThrow();
    await expect(
      createClip({
        trackId: video.id,
        shotId,
        assetId: 'asset1',
        startSeconds: 100,
        durationSeconds: 2,
      }),
    ).rejects.toThrow(/一个来源/);

    expect(await prisma.timelineClip.count({ where: { trackId: video.id } })).toBe(before);
  });

  it('updateClip / moveClip 的空 patch 被 schema 拒绝（parse 在读库之前）', async () => {
    // 用不存在的 id：若先读库会报 Prisma 的「找不到记录」，先 parse 才是 schema 文案
    await expect(updateClip('clip_missing', {})).rejects.toThrow(/至少/);
    await expect(moveClip('clip_missing', {})).rejects.toThrow(/至少/);

    const video = await trackAt(0, '画面');
    const clip = await clipAt(video.id, 0);
    await expect(updateClip(clip.id, { startSeconds: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /finite/i,
    );
    await expect(moveClip(clip.id, { trackId: video.id })).resolves.toMatchObject({
      trackId: video.id,
    });
    // 传了 trackId 就算「给了字段」：这条路径必须真的走到写库并读回
    await expect(moveClip(clip.id, { startSeconds: 0 })).resolves.toMatchObject({
      startSeconds: 0,
    });
  });
});

/**
 * 来源分支护栏（Ruling 26）
 *
 * ── 为什么只正例 shot 来源是不够的 ──
 * CHECK 的语义是「**恰好一个**来源」，它有两个正例分支：shot-only 与 asset-only。
 * 先前的用例只正例了 shot-only（`assetId` 处写的是字面量 `NULL`），于是把约束
 * 误写成 `"shotId" IS NOT NULL AND "assetId" IS NULL` 之后，所有用例仍然全绿 ——
 * 而那条约束会把**全部素材来源的片段**拒之门外（BGM、配音、贴图全是 asset 来源）。
 * 护栏没有钉住它声称的语义，这里在数据库层与仓储层各补一条 asset-only 正例。
 */
describe('来源分支护栏（Ruling 26）', () => {
  it('CHECK 正例：asset-only 片段可以插入（否则素材来源会被整类拒掉）', async () => {
    const audio = await trackAt(1, '声音');
    const probeId = 'clip_asset_only_probe';

    try {
      // 与两条负向对照逐字相同的语句，来源换成 asset-only
      await prisma.$executeRawUnsafe(
        `INSERT INTO "timeline_clips" ("id","trackId","shotId","assetId","startSeconds","durationSeconds","createdAt","updatedAt")
         VALUES ($1, $2, NULL, $3, 100, 1, NOW(), NOW())`,
        probeId,
        audio.id,
        assetId,
      );

      // 反空转：确认插进去的确实是「无 shot、有 asset」的那一行
      const row = await prisma.timelineClip.findUniqueOrThrow({ where: { id: probeId } });
      expect(row.shotId).toBeNull();
      expect(row.assetId).toBe(assetId);
    } finally {
      await prisma.timelineClip.deleteMany({ where: { id: probeId } });
    }

    expect(await prisma.timelineClip.count({ where: { id: probeId } })).toBe(0);
  });

  it('createClip 支持 asset 来源，并能从 getTimeline 原样读回', async () => {
    const video = await trackAt(0, '画面');
    const created = await createClip({
      trackId: video.id,
      assetId,
      startSeconds: 40,
      durationSeconds: 2,
    });

    // 仓储写出来的行形状：shotId 为 NULL、assetId 有值 —— 正是上面那条数据库层正例
    // 验证过的形状，也正是「误写成 shot-only 的约束」会整类拒掉的形状
    const row = await prisma.timelineClip.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.shotId).toBeNull();
    expect(row.assetId).toBe(assetId);

    // 读回：来源字段必须原样带出来，不能被读模型吞掉
    const timeline = await getTimeline(contentId);
    const readBack = timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === created.id);
    expect(readBack).toMatchObject({ shotId: null, assetId, startSeconds: 40, durationSeconds: 2 });

    await deleteClip(created.id);
    expect(await prisma.timelineClip.count({ where: { id: created.id } })).toBe(0);
  });

  it('来源分支用例没有留下残留行', async () => {
    expect(
      await prisma.timelineClip.findMany({
        where: { id: 'clip_asset_only_probe' },
        select: { id: true },
      }),
    ).toEqual([]);
    // 素材来源的片段一条都不该留下（仓储往返那条用例自己清理）
    expect(await prisma.timelineClip.count({ where: { assetId } })).toBe(0);
  });
});

/**
 * 来源级联删除（Ruling 28）
 *
 * ── 这条为什么必须由测试正面钉住 ──
 * `timeline_clips.assetId` 原来是 `ON DELETE SET NULL`，而 CHECK 要求片段
 * 「恰好一个来源」非空 —— 两者互斥：硬删一个被 asset-only 片段引用的资产时，
 * SET NULL 先把 `assetId` 置空，那一行立刻变成「无来源」，整笔事务撞 23514 失败。
 * 改成 `ON DELETE CASCADE`（与 shot 侧一致：片段随其来源消失）之后，下面 ①②
 * 两条必须真的通过；③ 则是不变量 7（镜头被删则片段随之消失）的回归。
 * 资产在应用里是软删归档，这条级联只在硬删 / 清理路径上生效。
 */
describe('来源级联删除（Ruling 28）', () => {
  /** 自建 content + 默认轨（随 fixture project 一起被清理，不干扰其它用例的状态） */
  async function scratchTracks(title: string) {
    const content = await prisma.content.create({
      data: { projectId, type: 'advertisement', title },
    });
    const tracks = await ensureDefaultTracks(content.id);
    const video = tracks[0];
    const audio = tracks[1];
    if (!video || !audio) throw new Error('默认轨不齐');
    return { scratchContentId: content.id, video, audio };
  }

  it('① 硬删被 asset-only 片段引用的资产：片段随之消失，不报 23514', async () => {
    const { audio } = await scratchTracks('级联-资产');
    const asset = await prisma.asset.create({
      data: { projectId, type: 'audio', name: '级联 BGM', slug: `cascade-asset-${Date.now()}` },
    });
    const clip = await createClip({
      trackId: audio.id,
      assetId: asset.id,
      startSeconds: 0,
      durationSeconds: 1,
    });
    // 反空转：删资产之前，片段必须真的在
    expect(await prisma.timelineClip.count({ where: { id: clip.id } })).toBe(1);

    // 这一步在 SET NULL 时代会抛 23514（片段被置成「无来源」）
    await expect(prisma.asset.delete({ where: { id: asset.id } })).resolves.toBeDefined();

    expect(await prisma.timelineClip.count({ where: { id: clip.id } })).toBe(0);
    expect(await prisma.timelineClip.count({ where: { assetId: asset.id } })).toBe(0);
  });

  it('② 含资产与 asset-only 片段的 project 可以整笔删除', async () => {
    // 独立的 project：这里要验证的正是「删 project 会不会被级联路径拖垮」
    const project = await prisma.project.create({ data: { name: `级联删除-${Date.now()}` } });
    const content = await prisma.content.create({
      data: { projectId: project.id, type: 'advertisement', title: '级联删除内容' },
    });
    const tracks = await ensureDefaultTracks(content.id);
    const audio = tracks[1];
    if (!audio) throw new Error('缺少声音轨');
    const asset = await prisma.asset.create({
      data: {
        projectId: project.id,
        type: 'audio',
        name: '级联 BGM',
        slug: `cascade-project-${Date.now()}`,
      },
    });
    await createClip({ trackId: audio.id, assetId: asset.id, startSeconds: 0, durationSeconds: 1 });
    expect(await prisma.timelineClip.count({ where: { trackId: audio.id } })).toBe(1);

    try {
      // 这就是 afterAll 里原先必须「先删片段」的原因：SET NULL 下这一步会整笔失败
      await expect(prisma.project.delete({ where: { id: project.id } })).resolves.toBeDefined();

      expect(await prisma.timelineTrack.count({ where: { contentId: content.id } })).toBe(0);
      expect(await prisma.timelineClip.count({ where: { trackId: audio.id } })).toBe(0);
      expect(await prisma.asset.count({ where: { id: asset.id } })).toBe(0);
    } finally {
      // 保险丝：即使上面的删除因回归而失败（这条用例变红），也不把 fixture 留在库里
      await prisma.timelineClip.deleteMany({
        where: { track: { content: { projectId: project.id } } },
      });
      await prisma.project.deleteMany({ where: { id: project.id } });
    }
  });

  it('③ 回归：删镜头仍级联删掉 shot-only 片段（不变量 7）', async () => {
    const { scratchContentId, video } = await scratchTracks('级联-镜头');
    const shot = await createShot({
      contentId: scratchContentId,
      durationSeconds: 1,
      description: '级联镜头',
    });
    const clip = await createClip({
      trackId: video.id,
      shotId: shot.id,
      startSeconds: 0,
      durationSeconds: 1,
    });
    expect(await prisma.timelineClip.count({ where: { id: clip.id } })).toBe(1);

    await deleteShot(shot.id);

    expect(await prisma.timelineClip.count({ where: { id: clip.id } })).toBe(0);
  });

  it('④ 约束仍在、语义未变，且迁移已记录（Ruling 28 的落库证据）', async () => {
    // 1) CHECK：仍然是「恰好一个来源」= 1（不是 <= 1，也没有被这次改动波及）
    const checks = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'timeline_clips_exactly_one_source_check'
    `;
    expect(checks).toHaveLength(1);
    expect(checks[0]?.def).toBe(
      'CHECK ((((("shotId" IS NOT NULL))::integer + (("assetId" IS NOT NULL))::integer) = 1))',
    );

    // 2) 外键删除策略：confdeltype 'c' = CASCADE（改动前是 'n' = SET NULL）
    const fk = await prisma.$queryRaw<{ confdeltype: string; def: string }[]>`
      SELECT confdeltype, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'timeline_clips_assetId_fkey'
    `;
    expect(fk[0]?.confdeltype).toBe('c');
    expect(fk[0]?.def).toMatch(/ON DELETE CASCADE/);

    // 3) 迁移记录：本次迁移已应用（finished_at 非空）
    const applied = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at FROM _prisma_migrations
      WHERE migration_name LIKE '%timeline_clip_asset_cascade'
    `;
    expect(applied).toHaveLength(1);
    expect(applied[0]?.finished_at).not.toBeNull();
  });
});
