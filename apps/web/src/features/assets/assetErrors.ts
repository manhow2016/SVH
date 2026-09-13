/**
 * 把后端返回的字段级错误落到具体输入框。
 *
 * ── 后端给的是什么 ──
 * `buildAssetData`（`apps/api/src/routes/assets.ts`）把 zod 的 issue 拼成
 * `appearance.hair: 字符串长度不能超过 200`，塞进 `suggestions`（最多 3 条）。
 * `parseOrThrow` 对请求体本身的问题也是同一形态。
 *
 * ── 为什么按前缀解析而不是原样显示 ──
 * 规范要求错误必须能指导下一步。把 `appearance.hair: …` 原样摊在页面顶部，
 * 用户还得自己找「appearance 是哪个框」。解析出路径就能把这句话挂到那个输入框
 * 下面，顶部只留没匹配上的部分。
 *
 * 匹配不上的一律进 `unmatched`，由调用方原样显示 —— 宁可显示得笨一点，
 * 也不能把一句看不懂的错误悄悄丢掉。
 */

/**
 * `字段.子字段: 说明`。
 *
 * 路径段限制为普通标识符：后端拼的是 zod 的 `issue.path.join('.')`，
 * 而本项目的 metadata 字段名全是 ASCII 标识符。用宽松的 `.*` 匹配冒号
 * 会把「检查请求体字段名称与类型是否正确」这类不含冒号的通用建议误判。
 */
const FIELD_ISSUE = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*):\s*([\s\S]+)$/;

export interface ParsedFieldErrors {
  /** 键是 `appearance.hair` 这样的点分路径 */
  fieldErrors: Record<string, string>;
  /** 没能匹配到任何输入框的原文（含通用建议），调用方应原样显示 */
  unmatched: string[];
}

export function parseFieldErrors(
  suggestions: readonly string[],
  paths: ReadonlySet<string>,
): ParsedFieldErrors {
  const fieldErrors: Record<string, string> = {};
  const unmatched: string[] = [];

  for (const suggestion of suggestions) {
    const matched = FIELD_ISSUE.exec(suggestion);
    const path = matched?.[1];
    const message = matched?.[2];
    // 只认表里真实存在的路径：后端可能报出一个表单没暴露的字段
    // （例如 appearanceFields.性别），把它挂到不存在的输入框上没有意义
    if (path !== undefined && message !== undefined && paths.has(path)) {
      fieldErrors[path] = message;
      continue;
    }
    unmatched.push(suggestion);
  }

  return { fieldErrors, unmatched };
}
