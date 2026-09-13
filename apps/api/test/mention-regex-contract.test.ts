/**
 * `@引用` 正则三份拷贝的机械护栏
 * ==============================
 *
 * ── 它守的是什么 ──
 * `@引用` 的解析正则在仓里有**三份逐字相同的拷贝**，各自服务一处：
 *
 *   1. `apps/web/src/features/assets/MentionText.tsx` —— 前端把消息正文里的
 *      `@资产` 链接化；
 *   2. `apps/api/src/core/slug.ts` —— 后端 `parseAssetMentions` 解析消息 / 技能
 *      调用里的引用；
 *   3. `packages/agent/src/context-resolver.ts` —— Agent 侧在调用方没有给出明确
 *      引用时自行解析。
 *
 * 三者必须认同一批名字：后端认得的引用前端点不开（或反过来），是**用户可见**的
 * 缺陷 —— 正文里高亮了却点不动，或者话里明明提了角色，Agent 当没看见。
 *
 * ── 为什么值得一条机械测试 ──
 * 三份拷贝之间没有任何编译期联系：改一处、漏两处，**现有测试全绿**。
 * 三处各自的用例只验证自己那套解析行为，谁都不会去读另外两个文件，所以漂移是
 * 静默的。这条测试用 TypeScript 编译器 API 读三份源码里的正则**字面量文本**，
 * 逐字比对。手法与 `asset-form-contract.test.ts` 一致，同样刻意不 import 目标
 * 文件：`apps/api` 的 tsconfig 是 NodeNext + `rootDir: "."`，跨包 import
 * `.tsx` / `packages/agent` 下的源码会同时破坏类型检查与构建。
 *
 * ── 覆盖边界（说清楚，不含糊）──
 * 覆盖：三份正则的源码文本逐字相同（含 flag），以及「读不到正则」这种退化情形
 *       （文件改名 / 被换成 `new RegExp` 时必须报错，不许静默跳过）。
 * **不覆盖**：正则本身的语义正确性（由三处各自的行为用例负责）；也不覆盖
 *       「有人又抄了第四份」—— 真要再加一处，请把它登记进
 *       `MENTION_PATTERN_SOURCES`，这条护栏只认这张表。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** 本文件所在目录：`apps/api/test` */
const API_TEST_DIR = dirname(fileURLToPath(import.meta.url));

interface MentionPatternSource {
  /** 报错信息里的人话名字 */
  label: string;
  /** 源文件绝对路径（真实用例从磁盘读；反向用例只喂文本，路径仅用于报错） */
  path: string;
  /** 源码文本 */
  text: string;
}

/** 三份拷贝的登记表。新增第四份时必须在这里补一行，否则它不受护栏保护 */
const MENTION_PATTERN_SOURCES = [
  {
    label: 'web/MentionText',
    path: resolve(API_TEST_DIR, '../../web/src/features/assets/MentionText.tsx'),
  },
  {
    label: 'api/slug',
    path: resolve(API_TEST_DIR, '../src/core/slug.ts'),
  },
  {
    label: 'agent/context-resolver',
    path: resolve(API_TEST_DIR, '../../../packages/agent/src/context-resolver.ts'),
  },
] as const;

/** 从磁盘读三份真实源码 */
function readLiveSources(): MentionPatternSource[] {
  return MENTION_PATTERN_SOURCES.map((source) => ({
    label: source.label,
    path: source.path,
    text: readFileSync(source.path, 'utf8'),
  }));
}

/** `.tsx` 必须按 TSX 解析：当成 TS 的话 JSX 会被读成形如 `<div>…` 的类型断言 */
function scriptKindFor(path: string): ts.ScriptKind {
  return path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** 递归收集一份源码里全部正则字面量的文本（含两侧 `/` 与 flag，即源码原样） */
function collectRegexLiterals(node: ts.Node, into: string[]): void {
  if (ts.isRegularExpressionLiteral(node)) {
    into.push(node.text);
    return;
  }
  node.forEachChild((child) => collectRegexLiterals(child, into));
}

/**
 * 读出一份源码里的 `@引用` 正则字面量文本。
 *
 * 判据是「字面量文本以 `/@(` 开头」：`slug.ts` 里还有别的正则（slug 归一化、
 * `/技能` 指令），按「文件里唯一那条正则」去找在别处会失效。
 *
 * 找不到（文件被改名 / 换成了 `new RegExp`）或找到多条（无法确定是哪一份）
 * 都**直接抛错** —— 静默跳过会让这条护栏变成空转绿灯。
 */
function readMentionPattern(text: string, path: string, label: string): string {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const literals: string[] = [];
  collectRegexLiterals(source, literals);

  const matched = literals.filter((literal) => literal.startsWith('/@('));
  const [only] = matched;
  if (only === undefined) {
    throw new Error(
      `${label}（${path}）里找不到以 /@( 开头的正则字面量：文件被改名，或换成了 new RegExp？`,
    );
  }
  if (matched.length > 1) {
    throw new Error(
      `${label}（${path}）里有 ${matched.length} 条 /@( 开头的正则：${matched.join('，')}`,
    );
  }
  return only;
}

/**
 * 校验若干份源码里的 `@引用` 正则是否逐字相同，返回全部问题（空数组 = 通过）。
 *
 * 抽成纯函数是为了能拿**被污染的副本**再跑一次 —— 见下面的反向用例：
 * 一个恒定返回空数组的校验器也能让真实源码那条用例通过，
 * 只有反向用例能证明它真的在逐字比对。
 */
function checkMentionPatterns(sources: readonly MentionPatternSource[]): string[] {
  const patterns = sources.map((source) => ({
    label: source.label,
    pattern: readMentionPattern(source.text, source.path, source.label),
  }));

  const distinct = new Set(patterns.map((item) => item.pattern));
  if (distinct.size <= 1) return [];

  // 只报一条、把各份并排列出来：这样无论漂移的是哪一份，报告都能直接指出它
  return [
    `@引用 正则不一致（共 ${patterns.length} 份）：${patterns
      .map((item) => `${item.label}=${item.pattern}`)
      .join('；')}`,
  ];
}

describe('@引用 正则三份拷贝逐字一致', () => {
  it('三份源码里的正则字面量完全相同', () => {
    expect(checkMentionPatterns(readLiveSources())).toEqual([]);
  });

  it('解析器自检：真的读到了三份正则，而不是空集合', () => {
    const patterns = readLiveSources().map((source) =>
      readMentionPattern(source.text, source.path, source.label),
    );
    expect(patterns).toHaveLength(MENTION_PATTERN_SOURCES.length);
    for (const [index, pattern] of patterns.entries()) {
      expect(pattern.startsWith('/@('), `第 ${index + 1} 份读成了 ${pattern}`).toBe(true);
    }
  });

  it('其中一份漂移就必然报错（反向验证，防止校验器恒返回「一致」）', () => {
    // 只污染一份：把字符区间去掉，等价于有人只改了前端那一份
    const polluted = readLiveSources().map((source) =>
      source.label === 'web/MentionText'
        ? { ...source, text: source.text.replaceAll('\\u4e00-\\u9fa5', '') }
        : source,
    );

    const problems = checkMentionPatterns(polluted);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('web/MentionText');
    expect(problems[0]).toContain('/@([\\w-]+)/gu');
  });

  it('读不到正则字面量时直接抛错，而不是静默通过', () => {
    const 没有正则 = {
      label: 'web/MentionText',
      path: '/tmp/MentionText.tsx',
      text: 'const MENTION_PATTERN = new RegExp("@([\\\\w-]+)", "gu");\n',
    };
    expect(() => checkMentionPatterns([没有正则])).toThrow(/找不到/);
  });
});
