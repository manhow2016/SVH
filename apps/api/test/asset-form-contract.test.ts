/**
 * 资产表单 ↔ 领域 schema 契约测试
 * ==============================
 *
 * ── 为什么需要它 ──
 * 资产库的 metadata 表单是前端**手写的一张字段表**
 * （`apps/web/src/features/assets/metadata/specs.ts`），后端校验用的是
 * `@svh/domain` 的 `characterMetadataSchema` 等 schema。两者之间没有任何
 * 编译期联系：
 *
 *   · 表单写了一个 schema 不认的字段 → 提交必然 400；
 *   · 表单把数字渲染成文本框   → 提交必然 400；
 *   · 下拉框少一个枚举值       → 用户永远选不到那个值。
 *
 * 而**所有组件测试都会是绿的** —— jsdom 里的 fetch 是假的，没有任何东西会去问
 * 后端「这个字段你认不认」。这正是本轮之前 `video.generate` 那类缺陷的形状：
 * 技能写了 schema 不认的 metadata，跑起来才发现。
 *
 * ── 手法 ──
 * 与 `api-contract.test.ts` 同一手法：用 TypeScript 编译器 API 把前端源文件的
 * **静态字面量**读成数据结构，再拿 `@svh/domain` 的真实 schema 比对。
 * 刻意不 import 前端源文件：`apps/api` 的 tsconfig 是 NodeNext + `rootDir: "."`，
 * 跨包 import 一个 .tsx 工程下的文件会同时破坏类型检查与构建。
 *
 * ── 覆盖边界（说清楚，不含糊）──
 * 覆盖：`METADATA_SPECS` 的每一个叶子字段（键存在、控件类型与 zod 类型一致、
 *       select 的选项与枚举完全一致、标签非空），以及 14 类清单 / 可创建清单 /
 *       中文标签与 domain 的逐字一致。
 * **不覆盖**：表单的渲染行为（见 `apps/web/test/metadata-form.test.tsx`），
 *       以及 specs.ts 里**有意未纳入**的字段（那份清单在 specs.ts 的注释里）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  CREATIVE_ASSET_TYPES,
  brandMetadataSchema,
  characterMetadataSchema,
  costumeMetadataSchema,
  digitalHumanMetadataSchema,
  mediaMetadataSchema,
  productMetadataSchema,
  propMetadataSchema,
  sceneMetadataSchema,
} from '@svh/domain';

/* ─────────────────────── 用编译器 API 读前端字面量 ─────────────────────── */

const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src');
const SPECS_PATH = resolve(WEB_SRC, 'features/assets/metadata/specs.ts');
const LABELS_PATH = resolve(WEB_SRC, 'features/assets/assetLabels.ts');
const API_TYPES_PATH = resolve(WEB_SRC, 'lib/api-types.ts');

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** 剥掉 `as const` / `satisfies T` / 括号，拿到真正的字面量节点 */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** 取顶层 `const X = …` 的初始化表达式；找不到就抛错，绝不当成空集合放过 */
function topLevelConst(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (declaration.initializer === undefined) {
        throw new Error(`${name} 没有初始化表达式，契约测试无法解析`);
      }
      return unwrap(declaration.initializer);
    }
  }
  throw new Error(`源码里找不到顶层常量 ${name}`);
}

/**
 * 读对象字面量。
 *
 * 遇到展开、计算键、简写、方法等任何非「属性赋值」成员都**直接抛错**：
 * 静默跳过会让这条契约测试在重构之后变成空转绿灯。
 */
function objectEntries(node: ts.Expression, where: string): Map<string, ts.Expression> {
  const literal = unwrap(node);
  if (!ts.isObjectLiteralExpression(literal)) {
    throw new Error(`${where} 必须是对象字面量（实际是 ${ts.SyntaxKind[literal.kind]}）`);
  }
  const entries = new Map<string, ts.Expression>();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        `${where} 里出现非属性赋值成员（${ts.SyntaxKind[property.kind]}）：契约测试只认静态字面量`,
      );
    }
    const { name } = property;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
      throw new Error(`${where} 里有无法解析的键名`);
    }
    entries.set(name.text, unwrap(property.initializer));
  }
  return entries;
}

function stringValue(node: ts.Expression, where: string): string {
  const literal = unwrap(node);
  if (!ts.isStringLiteral(literal)) {
    throw new Error(`${where} 必须是字符串字面量（实际是 ${ts.SyntaxKind[literal.kind]}）`);
  }
  return literal.text;
}

/**
 * 读数组。允许两种形态：
 *   1. 数组字面量；
 *   2. **指向同文件顶层 `const` 的标识符**（如 `fields: APPEARANCE_FIELDS`）。
 *
 * 第二种是必要的：角色的外观有 12 个字段，数字人用的是同一套
 * （domain 侧两个类型共用 `appearanceSchema`）。禁止引用等于把同一份描述抄两遍，
 * 而抄两遍之后漏改一处是**静默**的 —— 契约测试只做「表单 → schema」的单向检查，
 * 不会发现某个类型少了一个可填字段。
 *
 * **刻意不解析跨文件的 import**：那要实现模块解析，成本远超收益。
 * 跨文件共享的选项数组请直接定义在 `specs.ts` 里。
 */
function arrayItems(
  node: ts.Expression,
  where: string,
  source: ts.SourceFile,
  seen: readonly string[] = [],
): ts.Expression[] {
  const value = unwrap(node);

  if (ts.isIdentifier(value)) {
    // 成环会让解析器无限递归：`const A = B; const B = A` 必须显式报错
    if (seen.includes(value.text)) {
      throw new Error(`${where} 的引用成环：${[...seen, value.text].join(' -> ')}`);
    }
    return arrayItems(
      topLevelConst(source, value.text),
      `${value.text}（被 ${where} 引用）`,
      source,
      [...seen, value.text],
    );
  }

  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(
      `${where} 必须是数组字面量或同文件顶层常量（实际是 ${ts.SyntaxKind[value.kind]}）`,
    );
  }
  return [...value.elements].map((element) => unwrap(element));
}

function need(entries: Map<string, ts.Expression>, where: string, key: string): ts.Expression {
  const value = entries.get(key);
  if (value === undefined) throw new Error(`${where} 缺少 ${key}`);
  return value;
}

function stringArray(node: ts.Expression, where: string, source: ts.SourceFile): string[] {
  return arrayItems(node, where, source).map((item, index) =>
    stringValue(item, `${where}[${index}]`),
  );
}

/* ─────────────────────────── 字段表的结构 ─────────────────────────── */

interface FieldNode {
  kind: string;
  /** 完整点分路径，如 `appearance.hair` */
  path: string;
  label: string;
  /** 仅 select 有 */
  options: string[];
  children: FieldNode[];
}

/** 渲染器认得的 6 种控件；多一种少一种都必须在这里显式改 */
const WIDGET_KINDS = new Set(['text', 'textarea', 'number', 'select', 'tags', 'group']);

function readField(
  node: ts.Expression,
  where: string,
  prefix: string,
  source: ts.SourceFile,
): FieldNode {
  const entries = objectEntries(node, where);
  const kind = stringValue(need(entries, where, 'kind'), `${where}.kind`);
  const key = stringValue(need(entries, where, 'key'), `${where}.key`);
  const label = stringValue(need(entries, where, 'label'), `${where}.label`);
  const path = prefix === '' ? key : `${prefix}.${key}`;

  const options =
    kind === 'select'
      ? arrayItems(need(entries, where, 'options'), `${where}.options`, source).map(
          (option, index) => {
            const at = `${where}.options[${index}]`;
            return stringValue(need(objectEntries(option, at), at, 'value'), `${at}.value`);
          },
        )
      : [];

  const children =
    kind === 'group'
      ? arrayItems(need(entries, where, 'fields'), `${where}.fields`, source).map((child, index) =>
          readField(child, `${where}.fields[${index}]`, path, source),
        )
      : [];

  return { kind, path, label, options, children };
}

function readFieldTable(source: ts.SourceFile, constName: string): Map<string, FieldNode[]> {
  const entries = objectEntries(topLevelConst(source, constName), constName);
  const table = new Map<string, FieldNode[]>();
  for (const [type, node] of entries) {
    table.set(
      type,
      arrayItems(node, `${constName}.${type}`, source).map((item, index) =>
        readField(item, `${constName}.${type}[${index}]`, '', source),
      ),
    );
  }
  return table;
}

/** 所有节点（含 group 自身） */
function allNodes(nodes: readonly FieldNode[]): FieldNode[] {
  return nodes.flatMap((node) => [node, ...allNodes(node.children)]);
}

/** 叶子节点（group 不是叶子） */
function leaves(nodes: readonly FieldNode[]): FieldNode[] {
  return nodes.flatMap((node) => (node.children.length > 0 ? leaves(node.children) : [node]));
}

/* ─────────────────────── 拿 domain 的真实 schema 比对 ─────────────────────── */

/**
 * 14 类的 metadata 分支，全部是 asset.ts 的公开导出。
 *
 * 7 类生成产物（图片 / 视频 / 音频 / 音色 / 音乐 / 标识 / 字体）在
 * `METADATA_SPECS` 里是空表，domain 侧统一走 `mediaMetadataSchema`
 * （`asset.ts` 里 `const genericMetadataSchema = mediaMetadataSchema;`）。
 * 这 7 个分支必须显式列上 —— `checkFieldTable` 遍历的是字段表的**每一个**
 * 类型，少一个分支它就报「本测试没有它的 schema 分支」。那条报错是留给
 * 「新增了资产类型却忘了在这里补分支」的，不该被这 7 个已知类型触发；
 * 列全之后，哪天有人往空表里填字段，也一样会被逐个比对。
 */
const SCHEMA_BY_TYPE: Readonly<Record<string, z.ZodTypeAny>> = {
  character: characterMetadataSchema,
  digital_human: digitalHumanMetadataSchema,
  product: productMetadataSchema,
  brand: brandMetadataSchema,
  scene: sceneMetadataSchema,
  prop: propMetadataSchema,
  costume: costumeMetadataSchema,
  image: mediaMetadataSchema,
  video: mediaMetadataSchema,
  audio: mediaMetadataSchema,
  voice: mediaMetadataSchema,
  music: mediaMetadataSchema,
  logo: mediaMetadataSchema,
  font: mediaMetadataSchema,
};

/** 解包 `.optional()` / `.default()`，拿到真正的类型 */
function unwrapModifiers(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    return current;
  }
}

/** 按点分路径在 schema 分支里取字段；任何一段不存在都返回 null */
function schemaAtPath(root: z.ZodTypeAny, path: string): z.ZodTypeAny | null {
  let current: z.ZodTypeAny = root;
  for (const segment of path.split('.')) {
    const object = unwrapModifiers(current);
    if (!(object instanceof z.ZodObject)) return null;
    const shape = object.shape as Record<string, z.ZodTypeAny>;
    const next = shape[segment];
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

/** 控件类型 ↔ zod 类型。返回 null 表示匹配，否则是一句人话的原因 */
function kindMismatch(kind: string, schema: z.ZodTypeAny): string | null {
  const actual = unwrapModifiers(schema);
  switch (kind) {
    case 'text':
    case 'textarea':
      return actual instanceof z.ZodString
        ? null
        : `控件是 ${kind}（字符串），schema 是 ${actual.constructor.name}`;
    case 'number':
      return actual instanceof z.ZodNumber
        ? null
        : `控件是 number，schema 是 ${actual.constructor.name}`;
    case 'select':
      return actual instanceof z.ZodEnum
        ? null
        : `控件是 select，schema 却是 ${actual.constructor.name}（不是枚举）`;
    case 'tags':
      if (!(actual instanceof z.ZodArray)) {
        return `控件是 tags（字符串数组），schema 是 ${actual.constructor.name}`;
      }
      return unwrapModifiers(actual.element) instanceof z.ZodString
        ? null
        : 'tags 的元素在 schema 里不是字符串';
    default:
      return `渲染器不认识的控件类型 ${kind}`;
  }
}

/**
 * 校验一张字段表，返回全部问题（空数组 = 通过）。
 *
 * 抽成纯函数是为了能拿**被污染的副本**再跑一次 —— 见下面的反向验证用例：
 * 一个恒定返回空数组的校验器也能让「真实表」那条用例通过，
 * 只有反向用例能证明它真的在检查。
 */
function checkFieldTable(table: ReadonlyMap<string, readonly FieldNode[]>): string[] {
  const problems: string[] = [];

  for (const [type, nodes] of table) {
    const schema = SCHEMA_BY_TYPE[type];
    if (schema === undefined) {
      problems.push(`${type}: 本测试没有它的 schema 分支（新增类型时请补上）`);
      continue;
    }

    for (const node of allNodes(nodes)) {
      if (!WIDGET_KINDS.has(node.kind)) {
        problems.push(`${type}.${node.path}: 渲染器不认识的控件类型 ${node.kind}`);
      }
      if (node.label.trim() === '') {
        problems.push(`${type}.${node.path}: 没有中文标签`);
      }
    }

    for (const leaf of leaves(nodes)) {
      const target = schemaAtPath(schema, leaf.path);
      if (target === null) {
        problems.push(`${type}.${leaf.path}: schema 里不存在这个字段（提交必然 400）`);
        continue;
      }

      const mismatch = kindMismatch(leaf.kind, target);
      if (mismatch !== null) {
        problems.push(`${type}.${leaf.path}: ${mismatch}`);
        continue;
      }

      if (leaf.kind === 'select') {
        const actual = unwrapModifiers(target);
        if (actual instanceof z.ZodEnum) {
          const declared = [...leaf.options].sort();
          const allowed = [...(actual.options as string[])].sort();
          if (declared.join('\u0000') !== allowed.join('\u0000')) {
            problems.push(
              `${type}.${leaf.path}: 下拉选项与 schema 枚举不一致` +
                `（表单 ${declared.join('/')}，schema ${allowed.join('/')}）`,
            );
          }
        }
      }
    }
  }

  return problems;
}

/* ────────────────────────────── 用例 ────────────────────────────── */

const specs = readFieldTable(parseSource(SPECS_PATH), 'METADATA_SPECS');

describe('解析器自检（防止空转通过）', () => {
  it('读出了真实的字段表，而不是空集合', () => {
    const character = specs.get('character') ?? [];
    expect(character.length).toBeGreaterThan(0);
    expect(character.map((node) => node.path)).toContain('appearance');
    expect(leaves(character).length).toBeGreaterThanOrEqual(15);
  });

  it('读得出 select 的选项值', () => {
    const appearance = (specs.get('character') ?? []).find((node) => node.path === 'appearance');
    const gender = appearance?.children.find((node) => node.path === 'appearance.gender');
    expect(gender?.kind).toBe('select');
    expect(gender?.options).toEqual(['male', 'female', 'other', 'unspecified']);
  });

  it('常量引用成环时直接抛错，而不是无限递归到栈溢出', () => {
    // 同文件引用是解析器新支持的能力，它引入了一个新风险：环。
    // 这里刻意不走真实源文件 —— 往 specs.ts 里塞一个环就等于把测试数据写进产品代码。
    const 建源码 = (text: string): ts.SourceFile =>
      ts.createSourceFile('成环.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    // 形态一：`fields` 指向一个直接自引用的常量
    const 自引用 = 建源码(
      [
        'const SELF = SELF;',
        "const METADATA_SPECS = { character: [{ kind: 'group', key: 'g', label: '外观', fields: SELF }] };",
      ].join('\n'),
    );
    expect(() => readFieldTable(自引用, 'METADATA_SPECS')).toThrow(/成环/);

    // 形态二：A → B → A。只比较「当前名字与上一跳」的实现能挡住形态一，
    // 却会在形态二上无限递归 —— `seen` 必须逐层累积，这条用例就是在钉这一点
    const 互相引用 = 建源码(
      [
        'const A = B;',
        'const B = A;',
        "const METADATA_SPECS = { character: [{ kind: 'group', key: 'g', label: '外观', fields: A }] };",
      ].join('\n'),
    );
    expect(() => readFieldTable(互相引用, 'METADATA_SPECS')).toThrow(/成环：A -> B -> A/);
  });
});

describe('表单 ↔ schema 机械对齐', () => {
  it('每个叶子字段都能在 schema 里找到，且控件类型匹配', () => {
    expect(checkFieldTable(specs)).toEqual([]);
  });

  it('加一个 schema 不认的字段就必然报错（反向验证，防止永远绿灯）', () => {
    const polluted = new Map(specs);
    polluted.set('character', [
      ...(specs.get('character') ?? []),
      {
        kind: 'text',
        path: 'nonexistentField',
        label: '并不存在的字段',
        options: [],
        children: [],
      },
    ]);
    expect(checkFieldTable(polluted)).toEqual([
      'character.nonexistentField: schema 里不存在这个字段（提交必然 400）',
    ]);
  });

  it('把数字字段写成文本框也必然报错（反向验证）', () => {
    const polluted = new Map(specs);
    const appearance = (specs.get('character') ?? []).find((node) => node.path === 'appearance');
    polluted.set(
      'character',
      (specs.get('character') ?? []).map((node) =>
        node.path === 'appearance' && appearance !== undefined
          ? {
              ...node,
              children: node.children.map((child) =>
                child.path === 'appearance.age' ? { ...child, kind: 'text' } : child,
              ),
            }
          : node,
      ),
    );
    expect(checkFieldTable(polluted)).toEqual([
      'character.appearance.age: 控件是 text（字符串），schema 是 ZodNumber',
    ]);
  });
});

describe('字段表的覆盖面', () => {
  it('14 类都有条目：7 类创作实体非空，7 类生成产物为空表', () => {
    expect([...specs.keys()].sort()).toEqual([...ASSET_TYPES].sort());
    for (const type of CREATIVE_ASSET_TYPES) {
      expect(leaves(specs.get(type) ?? []).length, `${type} 的字段表是空的`).toBeGreaterThan(0);
    }
    for (const type of ASSET_TYPES) {
      if ((CREATIVE_ASSET_TYPES as readonly string[]).includes(type)) continue;
      expect(specs.get(type) ?? [], `${type} 是生成产物，metadata 不该由用户手填`).toEqual([]);
    }
  });
});

describe('前端手写副本 ↔ domain', () => {
  it('ASSET_TYPES 与 CREATIVE_ASSET_TYPES 逐字一致', () => {
    const apiTypes = parseSource(API_TYPES_PATH);
    expect(
      stringArray(topLevelConst(apiTypes, 'ASSET_TYPES'), 'ASSET_TYPES', apiTypes),
    ).toEqual([...ASSET_TYPES]);
    expect(
      stringArray(
        topLevelConst(apiTypes, 'CREATIVE_ASSET_TYPES'),
        'CREATIVE_ASSET_TYPES',
        apiTypes,
      ),
    ).toEqual([...CREATIVE_ASSET_TYPES]);
  });

  it('中文标签与 domain 的 ASSET_TYPE_LABELS 完全一致', () => {
    const entries = objectEntries(
      topLevelConst(parseSource(LABELS_PATH), 'ASSET_TYPE_LABELS'),
      'ASSET_TYPE_LABELS',
    );
    const webLabels: Record<string, string> = {};
    for (const [type, node] of entries) {
      webLabels[type] = stringValue(node, `ASSET_TYPE_LABELS.${type}`);
    }
    expect(webLabels).toEqual({ ...ASSET_TYPE_LABELS });
  });
});
