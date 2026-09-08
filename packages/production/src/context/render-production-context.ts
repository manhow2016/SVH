/**
 * Production Context 渲染（V0.3 Phase 1）。
 *
 * 把 `ProductionContext` 投影渲染为注入 System Prompt 的纯文本块。
 * 目标：
 * - 让 Agent 明确知道「当前生产项目是什么、有哪些既定事实（角色/场景/分镜）」；
 * - 控制 token：长字段（剧本正文）按上限截断，空字段不输出；
 * - 结构清晰、可被 LLM 直接引用。
 */
import type { ProductionContext } from "./production-context-types";

/** 剧本正文渲染上限（防止长剧本爆 context token） */
export const MAX_SCRIPT_CONTENT_CHARS = 6000;

/** 单个描述类字段渲染上限 */
export const MAX_DESCRIPTION_CHARS = 400;

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const normalized = text.trim();
  if (normalized === "") return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}\n（已截断，共 ${normalized.length} 字）` : normalized;
}

function nonEmpty<T>(items: T[], format: (item: T) => string[]): string[] {
  return items.flatMap((item) => format(item)).filter(Boolean);
}

/**
 * 渲染生产上下文为 System Prompt 追加块。
 * 若上下文为空（无可注入事实）则返回空字符串，调用方跳过注入。
 */
export function renderProductionContext(ctx: ProductionContext): string {
  const lines: string[] = [];

  // ---- Project ----
  const projectLines: string[] = [];
  projectLines.push(`项目名称：${ctx.project.name}`);
  projectLines.push(`项目类型：${ctx.project.type}`);
  if (ctx.project.description) projectLines.push(`项目简介：${clip(ctx.project.description, MAX_DESCRIPTION_CHARS)}`);
  if (ctx.project.targetDuration !== undefined) projectLines.push(`目标时长：${ctx.project.targetDuration} 秒`);
  if (ctx.project.visualStyle) projectLines.push(`视觉风格：${ctx.project.visualStyle}`);
  lines.push(`===== Production Context: Project =====\n${projectLines.join("\n")}`);

  // ---- Script ----
  if (ctx.script) {
    const scriptBox = [
      `===== Production Context: Script =====`,
      `标题：${ctx.script.title}`,
      `版本：v${ctx.script.version}（${ctx.script.status}）`,
      "",
      clip(ctx.script.content, MAX_SCRIPT_CONTENT_CHARS) ?? "（无正文）",
    ].join("\n");
    lines.push(scriptBox);
  }

  // ---- Characters ----
  if (ctx.characters.length > 0) {
    const chars = nonEmpty(ctx.characters, (c) => {
      const parts: string[] = [];
      // V0.3 Phase 3：优先输出稳定 Prompt Anchor，确保 Agent 生成时使用一致形象
      const anchor = c.anchor?.trim();
      if (anchor) parts.push(`形象锚点：${clip(anchor, MAX_DESCRIPTION_CHARS)}`);
      const appearance = c.appearance
        ? [
            c.appearance.gender && `性别 ${c.appearance.gender}`,
            c.appearance.age && `年龄 ${c.appearance.age}`,
            c.appearance.hairstyle && `发型 ${c.appearance.hairstyle}`,
            c.appearance.clothing && `服装 ${c.appearance.clothing}`,
            c.appearance.facialFeatures && `面部 ${c.appearance.facialFeatures}`,
            c.appearance.style && `风格 ${c.appearance.style}`,
          ]
            .filter(Boolean)
            .join("，")
        : "";
      const desc = clip(c.description, MAX_DESCRIPTION_CHARS);
      const pers = clip(c.personality, MAX_DESCRIPTION_CHARS);
      const meta = [desc, pers && `性格：${pers}`, appearance && `外观：${appearance}`].filter(Boolean).join("；");
      parts.push(`- ${c.name}${meta ? `：${meta}` : ""}`);
      return parts;
    });
    lines.push(`===== Production Context: Characters =====\n${chars.join("\n")}`);
  }

  // ---- Scenes ----
  if (ctx.scenes.length > 0) {
    const sceneBox = nonEmpty(ctx.scenes, (s) => {
      const meta = [
        clip(s.description, MAX_DESCRIPTION_CHARS),
        s.location && `地点：${s.location}`,
        s.time && `时间：${s.time}`,
        s.characters.length > 0 && `出场：${s.characters.join("、")}`,
      ]
        .filter(Boolean)
        .join("；");
      return [`${s.order + 1}. ${s.name}${meta ? `——${meta}` : ""}`];
    });
    lines.push(`===== Production Context: Scenes =====\n${sceneBox.join("\n")}`);
  }

  // ---- Storyboards ----
  if (ctx.storyboards.length > 0) {
    const sbBox = nonEmpty(ctx.storyboards, (s) => {
      const meta = [
        clip(s.description, MAX_DESCRIPTION_CHARS),
        `景别/运镜：${s.shotType}`,
        `时长：${s.duration}s`,
        s.cameraMovement && `运镜：${s.cameraMovement}`,
      ]
        .filter(Boolean)
        .join("；");
      return [`#${s.order + 1}（场景 ${s.sceneId}）：${meta}`];
    });
    lines.push(`===== Production Context: Storyboards =====\n${sbBox.join("\n")}`);
  }

  // ---- Shots ----
  if (ctx.shots.length > 0) {
    const shotBox = nonEmpty(ctx.shots, (s) => {
      const meta = [
        clip(s.action, MAX_DESCRIPTION_CHARS),
        s.framing && `景别：${s.framing}`,
        s.cameraMovement && `运镜：${s.cameraMovement}`,
      ]
        .filter(Boolean)
        .join("；");
      return [`#${s.order + 1}（分镜 ${s.storyboardId}）· ${s.duration}s${meta ? `——${meta}` : ``}`];
    });
    lines.push(`===== Production Context: Shots =====\n${shotBox.join("\n")}`);
  }

  if (lines.length === 0) return "";
  return `\n\n${lines.join("\n\n")}`;
}
