/**
 * 分镜仓储集成测试（连真库）
 *
 * 覆盖三件只有真库才能证明的事：
 * 1. 打乱顺序后的重排不会撞 `@@unique([contentId, index])`
 * 2. 删镜头会级联删掉它的时间线片段，并把剩余 index 重排连续
 * 3. 镜头内的资产引用（复用 asset_references）能反查到镜头
 *
 * ── 为什么 fixture 全部在 beforeAll 里建 ──
 * 最初的计划把「建 12 个镜头」放在第一个 `it` 里，后面的用例默认它已经跑过 ——
 * 这种隐式依赖在 `-t` 过滤或将来重排用例顺序时会静默失效（前一个用例没跑，
 * 后面全部拿到空数组）。这里改为 beforeAll 一次性建好，每个用例只读它需要的东西。
 *
 * ── 两处 Ruling 6 补强 ──
 * 见文件末尾的 `领域契约护栏`：`updateShotSchema` 必须继续拒绝未知 camera 键
 * （`updateShot` 的深合并正依赖这个 strict），以及 `storyboardShotSchema` 必须
 * 能解析一条真实的数据库行（schema 与库列漂移时立刻红灯）。
 *
 * ── 两处「宣称了保护但保护不住」的修补（Ruling 22）──
 * 1. 重排拒绝用例的正则收紧为 `/集合不相等/`：`rewriteIndices` 的兜底文案也含
 *    「数量不一致」，宽正则会替被删掉的集合校验「代跑通过」；
 * 2. 另有一条「同数量但含外来 id」的用例专门钉 `sameMembers` 分支 —— 它是唯一
 *    能拦「把别的内容的镜头搬进本内容」的守卫。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { storyboardShotSchema, updateShotSchema } from '@svh/domain';

import { disconnectPrisma, prisma } from '../src/index.js';
import {
  assertIndexOffsetSufficient,
  createShot,
  deleteShot,
  INDEX_OFFSET,
  listShots,
  listShotsReferencingAsset,
  reorderShots,
  syncShotAssetRefs,
  updateShot,
} from '../src/storyboard.js';

/** beforeAll 一次建好的镜头数；后续用例只在此基础上增删 */
const SHOT_COUNT = 12;

/** 外来内容里的镜头数（只用于「同数量但含外来 id」的重排用例） */
const FOREIGN_SHOT_COUNT = 4;

let projectId = '';
let contentId = '';
let assetId = '';
/** 第二个 content：只用来提供「外来镜头 id」，验证重排不能跨内容搬运 */
let foreignContentId = '';
/** beforeAll 建出来的镜头 id，按创建顺序（= 初始 index 升序） */
const shotIds: string[] = [];
const foreignShotIds: string[] = [];

beforeAll(async () => {
  const project = await prisma.project.create({ data: { name: `分镜测试-${Date.now()}` } });
  projectId = project.id;
  const content = await prisma.content.create({
    data: { projectId, type: 'advertisement', title: '测试内容' },
  });
  contentId = content.id;
  const asset = await prisma.asset.create({
    data: { projectId, type: 'character', name: '苏晚', slug: `suwan-${Date.now()}` },
  });
  assetId = asset.id;

  for (let i = 0; i < SHOT_COUNT; i += 1) {
    const shot = await createShot({ contentId, durationSeconds: 2, description: `镜头 ${i}` });
    shotIds.push(shot.id);
  }

  // 外来内容也走同一个仓储建镜头（顺带多覆盖一条 createShot 路径）
  const foreignContent = await prisma.content.create({
    data: { projectId, type: 'advertisement', title: '外来内容（重排越界用）' },
  });
  foreignContentId = foreignContent.id;
  for (let i = 0; i < FOREIGN_SHOT_COUNT; i += 1) {
    const shot = await createShot({
      contentId: foreignContentId,
      durationSeconds: 1,
      description: `外来镜头 ${i}`,
    });
    foreignShotIds.push(shot.id);
  }
});

afterAll(async () => {
  // 只删本次测试自建的 project：其下 content / asset / shot / clip / reference
  // 都由外键 ON DELETE CASCADE 一并清除，不触碰库里任何既有数据。
  if (projectId) {
    await prisma.project.delete({ where: { id: projectId } });
  }
  await disconnectPrisma();
});

describe('分镜仓储', () => {
  it('建 12 个镜头后 index 为 0..11 且顺序稳定', async () => {
    const shots = await listShots(contentId);
    expect(shots).toHaveLength(SHOT_COUNT);
    expect(shots.map((shot) => shot.index)).toEqual([...Array(SHOT_COUNT).keys()]);
    // 顺序稳定：返回顺序必须与创建顺序一致（orderBy index asc 的真实效果）
    expect(shots.map((shot) => shot.id)).toEqual(shotIds);
  });

  it('打乱顺序后重排成功且集合不变', async () => {
    const before = await listShots(contentId);
    const shuffled = [...before].reverse().map((shot) => shot.id);

    const after = await reorderShots({ contentId, orderedShotIds: shuffled });

    expect(after.map((shot) => shot.id)).toEqual(shuffled);
    expect(after.map((shot) => shot.index)).toEqual([...Array(SHOT_COUNT).keys()]);
    // 再独立读一次：证明是落库结果，而不只是事务内的返回值
    expect((await listShots(contentId)).map((shot) => shot.id)).toEqual(shuffled);
  });

  it('重排拒绝集合不相等的请求', async () => {
    const shots = await listShots(contentId);
    const missingOne = shots.slice(1).map((shot) => shot.id);
    // 只认集合校验那条文案：`rewriteIndices` 的兜底「index 重写后镜头数量不一致…」
    // 也含「数量不一致」字样，宽正则会把它判为通过，从而掩盖集合校验被整段删掉的事实
    await expect(reorderShots({ contentId, orderedShotIds: missingOne })).rejects.toThrow(
      /集合不相等/,
    );
  });

  it('重排拒绝「同数量但含外来 id」的请求，且不碰任何一侧内容', async () => {
    const shots = await listShots(contentId);
    const foreign = foreignShotIds[0];
    if (!foreign) throw new Error('beforeAll 没建出外来镜头');

    // 长度与现有集合完全相同，只把最后一个换成别的内容的镜头：集合大小校验看不出
    // 问题，只有 sameMembers 分支能拦住它 —— 而它拦的是「把别的内容的镜头搬进来」
    // 这种真实破坏，不能只靠 rewriteIndices 的数量兜底。
    const swapped = shots.map((shot) => shot.id);
    swapped[swapped.length - 1] = foreign;

    await expect(reorderShots({ contentId, orderedShotIds: swapped })).rejects.toThrow(
      /集合不相等/,
    );

    // 失败请求不得改动任何一侧：本内容与外来内容的顺序、index 都要原样
    expect((await listShots(contentId)).map((shot) => shot.id)).toEqual(
      shots.map((shot) => shot.id),
    );
    expect((await listShots(foreignContentId)).map((shot) => shot.id)).toEqual(foreignShotIds);
    expect((await listShots(foreignContentId)).map((shot) => shot.index)).toEqual([
      ...Array(foreignShotIds.length).keys(),
    ]);
  });

  it('重排拒绝含重复 id 的请求，且失败后库里顺序不变', async () => {
    const shots = await listShots(contentId);
    const first = shots[0];
    const second = shots[1];
    if (!first || !second) throw new Error('缺少测试镜头');

    // 集合视角下 {first, second, ...} 与现有镜头完全相等，只有「列表里有重复」
    // 这一个破绽 —— 不挡住的话 index 会缺号，且报错信息指向 index 重写而不是入参
    const duplicated = [first.id, first.id, second.id, ...shots.slice(2).map((shot) => shot.id)];
    await expect(reorderShots({ contentId, orderedShotIds: duplicated })).rejects.toThrow(/重复/);

    // 守卫在**写库之前**抛出，所以这里验证的是「拒绝请求没有产生任何副作用」，
    // 而不是「事务回滚」—— 这条路径压根没有走到写库，回滚无从谈起。
    expect((await listShots(contentId)).map((shot) => shot.id)).toEqual(
      shots.map((shot) => shot.id),
    );
    expect((await listShots(contentId)).map((shot) => shot.index)).toEqual(
      [...Array(SHOT_COUNT).keys()],
    );
  });

  it('更新只改传入字段，camera 深合并不抹掉其他键', async () => {
    const shots = await listShots(contentId);
    const target = shots[0];
    if (!target) throw new Error('缺少测试镜头');

    await updateShot(target.id, { camera: { shotType: '中景' } });
    const updated = await updateShot(target.id, { camera: { movement: '推进' } });

    expect(updated.camera).toEqual({ shotType: '中景', movement: '推进' });
    // 未传的字段必须原样保留（patch 里没有 description）
    expect(updated.description).toBe(target.description);
  });

  it('镜头引用资产后可反查（§37 一致性检查的地基）', async () => {
    const shots = await listShots(contentId);
    const first = shots[0];
    const second = shots[1];
    if (!first || !second) throw new Error('缺少测试镜头');

    await syncShotAssetRefs(first.id, [assetId]);
    await syncShotAssetRefs(second.id, [assetId]);

    const referencing = await listShotsReferencingAsset(assetId);
    expect(referencing.sort()).toEqual([first.id, second.id].sort());

    await syncShotAssetRefs(second.id, []);
    expect(await listShotsReferencingAsset(assetId)).toEqual([first.id]);
  });

  it('删镜头级联删片段并把剩余 index 重排连续', async () => {
    const shots = await listShots(contentId);
    const fifth = shots[4];
    if (!fifth) throw new Error('缺少第 5 个镜头');
    // 删前记录剩余镜头的**相对顺序**：只断言 index 连续是抓不到「重排时把顺序搞乱」的，
    // 而顺序正是分镜列表的全部意义（前面的重排已把逻辑顺序与物理顺序倒过来）。
    const survivorsBefore = shots
      .filter((shot) => shot.id !== fifth.id)
      .map((shot) => shot.id);

    const track = await prisma.timelineTrack.create({
      data: { contentId, kind: 'video', label: '画面', order: 99 },
    });
    await prisma.timelineClip.create({
      data: { trackId: track.id, shotId: fifth.id, startSeconds: 0, durationSeconds: 2 },
    });
    // 先给被删镜头挂一条资产引用：否则「引用被清掉」这条断言在 0 == 0 上空转，
    // 把 deleteShot 里的清理步骤删掉也照样绿。
    await syncShotAssetRefs(fifth.id, [assetId]);

    // 反空转：确认待删的东西真的存在
    expect(await prisma.timelineClip.count({ where: { trackId: track.id } })).toBe(1);
    expect(
      await prisma.assetReference.count({ where: { refType: 'shot', refId: fifth.id } }),
    ).toBe(1);
    expect(shots).toHaveLength(SHOT_COUNT);

    await deleteShot(fifth.id);

    const rest = await listShots(contentId);
    expect(rest).toHaveLength(SHOT_COUNT - 1);
    expect(rest.map((shot) => shot.index)).toEqual([...Array(SHOT_COUNT - 1).keys()]);
    // 相对顺序必须与删除前完全一致（这依赖 deleteShot 里 rest 查询的 orderBy）
    expect(rest.map((shot) => shot.id)).toEqual(survivorsBefore);
    expect(rest.map((shot) => shot.id)).not.toContain(fifth.id);
    // 片段由数据库级联删除，引用由仓储显式清理
    expect(await prisma.timelineClip.count({ where: { trackId: track.id } })).toBe(0);
    expect(
      await prisma.assetReference.count({ where: { refType: 'shot', refId: fifth.id } }),
    ).toBe(0);
  });

  it('createShot 可插到指定镜头之后，并把后续镜头顺移', async () => {
    const before = await listShots(contentId);
    const anchor = before[0];
    if (!anchor) throw new Error('缺少锚点镜头');

    const inserted = await createShot({
      contentId,
      durationSeconds: 3,
      description: '插到第 1 个之后的镜头',
      afterShotId: anchor.id,
    });

    // 紧随锚点：index 恰好是 anchor.index + 1
    expect(inserted.index).toBe(anchor.index + 1);

    const after = await listShots(contentId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.map((shot) => shot.index)).toEqual([...Array(before.length + 1).keys()]);
    // 集合 = 原有镜头 + 新镜头，且锚点的后继确实被顺移（不是被覆盖）
    expect(after.map((shot) => shot.id)).toEqual([
      anchor.id,
      inserted.id,
      ...before.slice(1).map((shot) => shot.id),
    ]);
  });
});

/**
 * index 平移区间的前置条件
 *
 * 两阶段重排只有在「平移区间 `[OFFSET, OFFSET+n-1]` 与目标区间 `[0, n-1]` 不相交」，
 * 也就是 `n ≤ OFFSET` 时才成立。超过之后阶段一自己就会撞唯一约束并回滚 —— 报错会
 * 指向唯一约束，没人会联想到「镜头数超过了偏移量」。这条守卫必须在写库前把话说清楚。
 *
 * 真库用例造不出十万个镜头，所以断言落在守卫函数本身（而不是靠堆数据）。
 */
describe('index 平移区间前置条件', () => {
  it('n ≤ INDEX_OFFSET 放行，n > INDEX_OFFSET 明确拒绝', () => {
    expect(() => assertIndexOffsetSufficient(SHOT_COUNT)).not.toThrow();
    // 边界：n 恰好等于偏移量时仍然安全（平移区间从 OFFSET 起，与 0..OFFSET-1 不相交）
    expect(() => assertIndexOffsetSufficient(INDEX_OFFSET)).not.toThrow();
    // 反空转：越界必须真的被拦下，否则上面的「放行」可能只是函数什么都没做
    expect(() => assertIndexOffsetSufficient(INDEX_OFFSET + 1)).toThrow(
      /超过 index 平移区间上限/,
    );
  });
});

/**
 * Ruling 6 补强断言
 *
 * ── 为什么这两条必须留在库里跑 ──
 * 第一条守的是 `updateShot` 深合并的**前提**：`cameraSchema.partial()` 一旦被换成
 * 非 strict 写法（`.passthrough()` / 去掉 `.strict()`），拼错的键会被静默写进
 * `camera` JSON，深合并反而成了把脏数据永久留在库里的帮凶 —— 而仓储层的其它用例
 * 全都不会红。
 * 第二条守的是领域读模型与数据库列的一致性：`storyboardShotSchema` 是 API / Web
 * 共用的契约，只有拿真实 DB 行去 parse，才能证明「库列的类型、可空性、枚举取值」
 * 没有与 schema 漂移。
 */
describe('领域契约护栏（Ruling 6）', () => {
  it('updateShotSchema 拒绝未知 camera 键', () => {
    expect(() => updateShotSchema.parse({ camera: { shotSize: '中景' } })).toThrow(
      /Unrecognized key/i,
    );
    // 反空转：合法键必须能通过，否则上面的 toThrow 可能只是「这份 schema 拒绝一切」
    expect(updateShotSchema.parse({ camera: { shotType: '中景' } })).toEqual({
      camera: { shotType: '中景' },
    });
  });

  it('storyboardShotSchema 能解析完整的数据库行', async () => {
    const anchorId = shotIds[0];
    if (!anchorId) throw new Error('beforeAll 没建出镜头');

    // 1) 仓储返回行（toRow 之后）：不能丢列，也不能把可空列换成别的形状
    const repoRow = (await listShots(contentId)).find((shot) => shot.id === anchorId);
    if (!repoRow) throw new Error('beforeAll 建的第一个镜头已不在库中');
    expect(storyboardShotSchema.parse(repoRow)).toEqual(repoRow);

    // 2) 原始 Prisma 行：schema 直接吃数据库值（含 Json 默认值与可空列）。
    //    注意 index 不断言具体值 —— 前面的用例已经重排/删除/插入过，这里只断言
    //    「解析结果 == 库里的真实值」，避免把用例间的状态依赖写死成脆弱的常数。
    const rawRows = await prisma.storyboardShot.findMany({
      where: { contentId },
      orderBy: { index: 'asc' },
    });
    expect(rawRows.length).toBeGreaterThan(0);
    const rawRow = rawRows.find((row) => row.id === anchorId);
    if (!rawRow) throw new Error('原始行里找不到 beforeAll 建的第一个镜头');

    const parsed = storyboardShotSchema.parse(rawRow);
    expect(parsed.id).toBe(anchorId);
    expect(parsed.contentId).toBe(contentId);
    expect(parsed.index).toBe(rawRow.index);
    expect(parsed.description).toMatch(/^镜头 \d+$/);
    expect(parsed.camera).toEqual(rawRow.camera);
    expect(parsed.status).toBe('draft');
    expect(parsed.episodeId).toBeNull();
    expect(parsed.imageAssetId).toBeNull();
    expect(parsed.videoAssetId).toBeNull();
    expect(parsed.dialogue).toEqual([]);

    // 该内容下的每一行都必须能被读模型解析（不是只挑一条特殊的行）
    expect(rawRows.map((row) => storyboardShotSchema.parse(row).id)).toEqual(
      rawRows.map((row) => row.id),
    );
  });
});
