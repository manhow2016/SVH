/**
 * 资产 metadata 的字段描述表。
 *
 * ── 为什么是「一张数据表 + 一个渲染器」而不是 7 份手写表单 ──
 * 字段描述是**数据**，渲染器只认 6 种控件。新增类型或字段 = 往表里加一行；
 * 测试可以分开打（表的完备性 vs 渲染器的行为），而 7 份手写表单只能逐个测，
 * 且改一处控件行为要改 7 遍。
 *
 * ── 这张表是「可静态解析」的 ──
 * `apps/api/test/asset-form-contract.test.ts` 用 TypeScript 编译器 API 直接读
 * 这个文件。因此这里**只能**出现对象字面量、数组字面量、字符串字面量、
 * 标识符键 —— 不能有展开、计算键、变量引用、函数调用。改这里之前先看那个测试。
 *
 * 这条约束有一个直接后果：**共享片段只能展开写，不能抽成常量再引用**。
 * 解析器拿到 `fields: APPEARANCE_FIELDS` 这种写法时不会「顺着名字去找」，
 * 而是直接抛错（那正是它的设计：静默跳过会让契约变成空转绿灯）。于是
 * `character.appearance` 与 `digital_human.appearance` 虽共用同一份
 * `appearanceSchema`，也必须各写一遍；`options` 同理，只能内联，不能
 * `import` `assetLabels.ts` 里的 `GENDER_OPTIONS`。代价是改一处枚举 / 字段
 * 要改多处 —— 契约测试能保证每一份各自与 schema 对齐，保证不了两份彼此一致。
 *
 * ── 有意未纳入表单的字段（不是遗漏）──
 * 6 种控件表达不了下面这几类，硬塞进去只会产出 schema 不认的数据：
 *   · 跨资产引用 id：`digital_human.voice.voiceAssetId`、
 *     `digital_human.motion.backgroundAssetId`、`product.brandId`、
 *     `brand.logoAssetId`、`prop.ownerCharacterId`、`costume.forCharacterIds`
 *     —— 用户看不懂 id，需要的是「资产选择器」（后续任务）
 *   · 自由键值对：`product.specs`、`brand.guidelines.typography`
 *     —— 需要第 7 种控件「键值对编辑器」（后续任务）
 *   · 对象数组：`scene.elements`（`{name, description}[]`）—— 需要「重复条目编辑器」
 *   · 结构化引用：`character.reference_images`、`digital_human.reference`
 *   · 死字段：`character.appearanceFields`（全仓无人读，Spec §2 已登记）
 * 这些字段**不会被提交**（`diffMetadata` 只产出这张表里出现过的键），
 * 因此 Agent 写进去的内容不会因为用户编辑一次就被抹掉。
 */
import { CREATIVE_ASSET_TYPES, type AssetType, type CreativeAssetType } from '../../../lib/api-types.js';

/**
 * 字段描述。6 种控件：
 *
 * - `text` / `textarea` → `string`
 * - `number`            → `number`
 * - `select`            → 枚举字符串
 * - `tags`              → `string[]`（提交时**整体替换**，见 diffMetadata）
 * - `group`             → 嵌套对象（同一个键在不同类型下形状不同时就靠它区分：
 *                         `character.appearance` 是对象，`prop.appearance` 是字符串）
 */
export type FieldSpec =
  | { kind: 'text' | 'textarea'; key: string; label: string; help?: string }
  | { kind: 'number'; key: string; label: string; help?: string }
  | {
      kind: 'select';
      key: string;
      label: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      help?: string;
    }
  | { kind: 'tags'; key: string; label: string; help?: string }
  | { kind: 'group'; key: string; label: string; help?: string; fields: readonly FieldSpec[] };

/**
 * 7 类创作实体 + 7 类生成产物的字段表。
 *
 * 生成产物（图片 / 视频 / 音频 / 音色 / 音乐 / 标识 / 字体）一律是**空表**：
 * 它们的 metadata 是生成结果（`width` / `format` / `duration` / `generation`），
 * 让用户手填只会填出与实际文件不符的数据。详情抽屉照常**只读**展示它们。
 */
export const METADATA_SPECS: Record<AssetType, readonly FieldSpec[]> = {
  character: [
    {
      kind: 'group',
      key: 'appearance',
      label: '外观',
      // 与 digital_human.appearance 是同一份 appearanceSchema，但两份必须各写
      // 一遍：抽成常量再引用，契约测试的解析器会直接抛错（见文件头）
      fields: [
        {
          kind: 'select',
          key: 'gender',
          label: '性别气质',
          options: [
            { value: 'male', label: '男' },
            { value: 'female', label: '女' },
            { value: 'other', label: '其他' },
            { value: 'unspecified', label: '不指定' },
          ],
        },
        { kind: 'number', key: 'age', label: '年龄', help: '0 ~ 200 的整数' },
        { kind: 'text', key: 'ageRange', label: '年龄段', help: '如「二十出头」，与年龄二选一即可' },
        { kind: 'text', key: 'hair', label: '发型发色', help: '如「黑色长直发」' },
        { kind: 'text', key: 'eyeColor', label: '瞳色' },
        { kind: 'text', key: 'bodyType', label: '身材体型', help: '如「纤细高挑」' },
        { kind: 'number', key: 'heightCm', label: '身高（厘米）', help: '50 ~ 300 的整数' },
        {
          kind: 'textarea',
          key: 'facialFeatures',
          label: '面部特征',
          help: '如「鹅蛋脸、丹凤眼」。这一段会被 Agent 直接用于保持角色一致性',
        },
        { kind: 'text', key: 'vibe', label: '整体气质', help: '如「清冷疏离」' },
        { kind: 'textarea', key: 'costume', label: '服装描述', help: '如「月白色齐胸襦裙」' },
        { kind: 'tags', key: 'distinguishingFeatures', label: '辨识特征', help: '如「左眉尾有一道浅疤」，回车添加' },
        { kind: 'tags', key: 'accessories', label: '配饰', help: '回车添加一项' },
      ],
    },
    {
      kind: 'group',
      key: 'costume',
      label: '服装 / 造型方案',
      fields: [
        { kind: 'text', key: 'name', label: '造型名称' },
        { kind: 'textarea', key: 'description', label: '造型说明' },
        { kind: 'tags', key: 'colors', label: '配色', help: '回车添加一个颜色' },
      ],
    },
    { kind: 'text', key: 'role', label: '剧情定位', help: '如「女主」「反派」' },
    { kind: 'text', key: 'firstAppearance', label: '首次出场分集' },
    { kind: 'textarea', key: 'personality', label: '性格与人物小传' },
    { kind: 'textarea', key: 'backstory', label: '背景故事' },
  ],
  digital_human: [
    {
      kind: 'select',
      key: 'gender',
      label: '性别气质',
      options: [
        { value: 'male', label: '男' },
        { value: 'female', label: '女' },
        { value: 'other', label: '其他' },
        { value: 'unspecified', label: '不指定' },
      ],
    },
    {
      kind: 'group',
      key: 'appearance',
      label: '外观',
      // 与 character.appearance 内容相同，同样因为「只认字面量」而各写一遍
      fields: [
        {
          kind: 'select',
          key: 'gender',
          label: '性别气质',
          options: [
            { value: 'male', label: '男' },
            { value: 'female', label: '女' },
            { value: 'other', label: '其他' },
            { value: 'unspecified', label: '不指定' },
          ],
        },
        { kind: 'number', key: 'age', label: '年龄', help: '0 ~ 200 的整数' },
        { kind: 'text', key: 'ageRange', label: '年龄段', help: '如「二十出头」，与年龄二选一即可' },
        { kind: 'text', key: 'hair', label: '发型发色', help: '如「黑色长直发」' },
        { kind: 'text', key: 'eyeColor', label: '瞳色' },
        { kind: 'text', key: 'bodyType', label: '身材体型', help: '如「纤细高挑」' },
        { kind: 'number', key: 'heightCm', label: '身高（厘米）', help: '50 ~ 300 的整数' },
        {
          kind: 'textarea',
          key: 'facialFeatures',
          label: '面部特征',
          help: '如「鹅蛋脸、丹凤眼」。这一段会被 Agent 直接用于保持角色一致性',
        },
        { kind: 'text', key: 'vibe', label: '整体气质', help: '如「清冷疏离」' },
        { kind: 'textarea', key: 'costume', label: '服装描述', help: '如「月白色齐胸襦裙」' },
        { kind: 'tags', key: 'distinguishingFeatures', label: '辨识特征', help: '如「左眉尾有一道浅疤」，回车添加' },
        { kind: 'tags', key: 'accessories', label: '配饰', help: '回车添加一项' },
      ],
    },
    {
      kind: 'group',
      key: 'voice',
      label: '声音',
      help: '音色资产的选择需要「资产选择器」，本阶段先开放参数',
      fields: [
        { kind: 'number', key: 'speed', label: '语速', help: '0.5 ~ 2，1.0 为正常' },
        { kind: 'number', key: 'pitch', label: '音调', help: '0.5 ~ 2' },
        { kind: 'number', key: 'volume', label: '音量', help: '0 ~ 2' },
        { kind: 'text', key: 'emotion', label: '情绪', help: '如「亲切」「专业」' },
        { kind: 'text', key: 'language', label: '语言' },
      ],
    },
    {
      kind: 'group',
      key: 'motion',
      label: '动作驱动',
      fields: [
        {
          kind: 'select',
          key: 'mode',
          label: '驱动方式',
          options: [
            { value: 'talking_head', label: '口播（只动头肩）' },
            { value: 'half_body', label: '半身动作' },
            { value: 'full_body', label: '全身动作' },
          ],
        },
        { kind: 'text', key: 'template', label: '动作模板标识' },
      ],
    },
    { kind: 'text', key: 'driverModel', label: '驱动模型', help: '留空则由模型路由自动选择' },
  ],
  product: [
    { kind: 'text', key: 'category', label: '品类', help: '如「护肤品 / 精华」' },
    { kind: 'text', key: 'price', label: '价格文案', help: '如「¥299 / 30ml」' },
    { kind: 'textarea', key: 'targetAudience', label: '目标人群' },
    { kind: 'tags', key: 'sellingPoints', label: '核心卖点', help: '回车添加一条，改动时整体替换' },
    { kind: 'tags', key: 'usageScenarios', label: '使用场景', help: '回车添加一条' },
    { kind: 'textarea', key: 'visualNotes', label: '视觉规范补充' },
  ],
  brand: [
    { kind: 'tags', key: 'colors', label: '品牌色', help: '如 #1F6FEB，回车添加一个' },
    { kind: 'tags', key: 'fonts', label: '指定字体', help: '回车添加一个字体族' },
    { kind: 'textarea', key: 'tone', label: '品牌调性', help: 'Agent 写文案前会读这一段' },
    { kind: 'text', key: 'slogan', label: '品牌口号' },
    { kind: 'text', key: 'industry', label: '行业' },
    { kind: 'textarea', key: 'story', label: '品牌故事' },
    {
      kind: 'group',
      key: 'guidelines',
      label: '品牌规范',
      // 只含 6 种控件表达得了的部分；`typography` 是自由键值对，见文件头
      fields: [
        { kind: 'tags', key: 'must', label: '必须遵守', help: '回车添加一条规则' },
        { kind: 'tags', key: 'forbidden', label: '禁止出现', help: '回车添加一条禁忌' },
        { kind: 'textarea', key: 'visualStyle', label: '视觉风格', help: '如「低饱和、大量留白、真实质感」' },
        { kind: 'text', key: 'spacing', label: '版式留白规则' },
        { kind: 'textarea', key: 'compliance', label: '版权 / 合规说明' },
      ],
    },
  ],
  scene: [
    { kind: 'text', key: 'location', label: '地点', help: '如「长安城朱雀大街」' },
    { kind: 'text', key: 'timeOfDay', label: '时间', help: '如「夜」「黄昏」' },
    { kind: 'text', key: 'lighting', label: '光照', help: '如「月光」「暖色台灯」' },
    { kind: 'text', key: 'weather', label: '天气' },
    { kind: 'text', key: 'era', label: '时代背景' },
    { kind: 'textarea', key: 'atmosphere', label: '空间氛围' },
    { kind: 'tags', key: 'colorPalette', label: '主色调', help: '回车添加一个颜色' },
    { kind: 'text', key: 'cameraNotes', label: '镜头运动建议', help: '如「缓慢推近」' },
    { kind: 'text', key: 'ambientSound', label: '默认音效' },
  ],
  prop: [
    { kind: 'text', key: 'category', label: '类别' },
    { kind: 'text', key: 'material', label: '材质' },
    {
      kind: 'textarea',
      key: 'appearance',
      label: '外观描述',
      // 注意：这里刻意是**字符串**而不是 group —— 同一个键在 character 下是对象，
      // 在 prop 下是字符串，group 这个控件正好解决这种形状差异
    },
    { kind: 'textarea', key: 'storyMeaning', label: '剧情意义' },
  ],
  costume: [
    { kind: 'text', key: 'category', label: '类别' },
    { kind: 'text', key: 'primaryColor', label: '主色', help: '如「中国红」' },
    { kind: 'tags', key: 'colors', label: '配色', help: '回车添加一个颜色' },
    { kind: 'text', key: 'material', label: '材质' },
    { kind: 'text', key: 'era', label: '时代' },
    { kind: 'text', key: 'occasion', label: '穿着场合' },
  ],
  image: [],
  video: [],
  audio: [],
  voice: [],
  music: [],
  logo: [],
  font: [],
};

/** 该类型是否走 metadata 表单（可创建 / 可编辑 metadata） */
export function isCreativeAssetType(type: AssetType): type is CreativeAssetType {
  return (CREATIVE_ASSET_TYPES as readonly string[]).includes(type);
}

/**
 * 通用字段的键名（不走 `METADATA_SPECS`，所有类型都有）。
 *
 * 这张表**不是**渲染用的清单，而是给 `parseFieldErrors` 判断命中用的：
 * 后端对 `name` / `slug` 这些字段的报错路径与 metadata 的 `appearance.hair`
 * 是同一形态，两处都要能落到对应输入框。
 * 调用方应当只把自己**真正渲染了**的字段加进路径集合 —— 加进去却没渲染，
 * 那条错误就会被静默丢掉。
 */
export const GENERAL_FIELD_KEYS = ['name', 'slug', 'description', 'tags', 'coverUrl'] as const;

/* ─────────────────────────── 纯函数：脏值与路径 ─────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 结构相等（数组按元素、对象按键，其余用 `===`） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * 只提交改动过的字段。
 *
 * ── 为什么不能提交整份 metadata ──
 * 硬约束：表单只覆盖 7 个类型的一部分字段，而 Agent 会往 metadata 里写表单
 * 没有的东西（`generation`、`reference_images`、`cues`）。提交整份 = 把它们
 * 悄悄抹掉。服务端是「深合并之后再整体校验」（`routes/assets.ts` 的 PATCH），
 * 因此部分提交是安全的。
 *
 * 三条规则，缺一不可：
 * 1. 值与初始值相同      → 不提交
 * 2. 值被清空且原本有值  → 提交 `null`（服务端 `deepMerge` 的显式清除语义）
 * 3. 值被清空且原本就没有 → **不提交**。新建场景全是这种：zod 的 `.optional()`
 *    只接受 `undefined`，发 `null` 必然 400
 *
 * group **永远只向下递归**，绝不整体置 `null` —— 那会连 Agent 写入、
 * 表单没暴露的同名字段一起删掉。
 */
export function diffMetadata(
  specs: readonly FieldSpec[],
  initial: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const spec of specs) {
    const before = initial[spec.key];
    const next = current[spec.key];

    if (spec.kind === 'group') {
      const sub = diffMetadata(
        spec.fields,
        isPlainObject(before) ? before : {},
        isPlainObject(next) ? next : {},
      );
      // 组内没有任何改动就不提交这个组：提交 `{}` 没有意义
      if (Object.keys(sub).length > 0) patch[spec.key] = sub;
      continue;
    }

    if (next === undefined) {
      if (before !== undefined) patch[spec.key] = null;
      continue;
    }
    if (deepEqual(next, before)) continue;
    // 数组整体替换：调用方必须给出完整数组（见任务简报里的裁定 2）
    patch[spec.key] = next;
  }

  return patch;
}

/** 表里出现的全部点分路径（叶子 + group），供 `parseFieldErrors` 判断命中 */
export function fieldPaths(specs: readonly FieldSpec[]): Set<string> {
  const paths = new Set<string>();
  const walk = (nodes: readonly FieldSpec[], prefix: string): void => {
    for (const node of nodes) {
      const path = prefix === '' ? node.key : `${prefix}.${node.key}`;
      paths.add(path);
      if (node.kind === 'group') walk(node.fields, path);
    }
  };
  walk(specs, '');
  return paths;
}
