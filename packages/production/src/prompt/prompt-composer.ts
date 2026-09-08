/**
 * Prompt Composer（V0.3 Phase 2）。
 *
 * 统一所有 Image/Video 生成的提示词组合：
 * Final Prompt = Project Style + Scene + Character Prompt + Shot + Camera + Action + Raw
 * Negative = Global + Style + Character + Provider
 *
 * 本类是纯函数式组合（无 HTTP / 无生产实体依赖），由 server 层在入队前调用，
 * worker 只消费已组合好的 prompt，避免在任何一层散落拼 Prompt 逻辑。
 */
import type {
  CharacterPromptSnippet,
  ComposedPrompt,
  ImagePromptContext,
  ScenePromptSnippet,
  ShotPromptSnippet,
  VideoPromptContext,
} from "./prompt-types";
import { DEFAULT_PROMPT_TEMPLATE, type PromptTemplate } from "./prompt-template";

/** Prompt Composer 接口（实施文档 §16） */
export interface PromptComposer {
  composeImage(context: ImagePromptContext): ComposedPrompt;
  composeVideo(context: VideoPromptContext): ComposedPrompt;
}

// ================= 段落纯函数 =================

function sceneToString(scene?: ScenePromptSnippet): string | undefined {
  if (!scene) return undefined;
  const base = (scene.visualPrompt ?? scene.description ?? "").trim();
  if (!base) return undefined;
  const parts = [base];
  if (scene.location) parts.push(`in ${scene.location.trim()}`);
  if (scene.time) parts.push(`at ${scene.time.trim()}`);
  return parts.join(", ");
}

function characterToString(c: CharacterPromptSnippet): string | undefined {
  const anchor = (c.anchor ?? c.visualPrompt ?? c.description ?? "").trim();
  if (!anchor) return c.name ? c.name.trim() : undefined;
  return `${c.name}: ${anchor}`;
}

function charactersToString(characters?: CharacterPromptSnippet[]): string | undefined {
  if (!characters || characters.length === 0) return undefined;
  const parts = characters.map(characterToString).filter((s): s is string => Boolean(s));
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function shotToString(shot?: ShotPromptSnippet): string | undefined {
  if (!shot) return undefined;
  const base = (shot.description ?? shot.action ?? "").trim();
  if (!base) return undefined;
  const extra = [shot.framing, shot.dialogue].filter(Boolean).map((s) => s!.trim());
  return extra.length > 0 ? `${base} (${extra.join(", ")})` : base;
}

function cameraToString(ctx: ImagePromptContext & { actionPrompt?: string }): string | undefined {
  const camera = (ctx.shot?.cameraMovement ?? ctx.actionPrompt ?? "").trim();
  return camera || undefined;
}

function actionToString(ctx: ImagePromptContext & { actionPrompt?: string }): string | undefined {
  // 视频动作：优先显式 actionPrompt，其次镜头 action
  const action = (ctx.actionPrompt ?? ctx.shot?.action ?? "").trim();
  return action || undefined;
}

function rawToString(ctx: ImagePromptContext): string | undefined {
  const raw = (ctx.rawPrompt ?? "").trim();
  return raw || undefined;
}

// ================= 默认实现 =================

export class DefaultPromptComposer implements PromptComposer {
  constructor(private readonly template: PromptTemplate = DEFAULT_PROMPT_TEMPLATE) {}

  composeImage(context: ImagePromptContext): ComposedPrompt {
    const prompt = this.compose(this.template.imageOrder, context);
    return {
      prompt,
      negativePrompt: this.composeNegative(context),
      metadata: {
        templateId: this.template.id,
        projectId: context.projectId,
        shotId: context.shotId,
        sceneId: context.sceneId,
        characterIds: context.characterIds,
        providerId: context.providerId,
      },
    };
  }

  composeVideo(context: VideoPromptContext): ComposedPrompt {
    const prompt = this.compose(this.template.videoOrder, { ...context });
    return {
      prompt,
      negativePrompt: this.composeNegative(context),
      metadata: {
        templateId: this.template.id,
        projectId: context.projectId,
        shotId: context.shotId,
        sceneId: context.sceneId,
        characterIds: context.characterIds,
        providerId: context.providerId,
      },
    };
  }

  /** 按段顺序组合 prompt */
  private compose(order: PromptTemplate["imageOrder"], ctx: ImagePromptContext): string {
    const parts: string[] = [];
    for (const key of order) {
      const value = this.renderPart(key, ctx);
      if (value) parts.push(value);
    }
    return parts.join(this.template.separator);
  }

  private renderPart(key: PromptTemplate["imageOrder"][number], ctx: ImagePromptContext): string | undefined {
    switch (key) {
      case "style":
        return ctx.projectStyle?.trim() || undefined;
      case "scene":
        return sceneToString(ctx.scene);
      case "characters":
        return charactersToString(ctx.characters);
      case "shot":
        return shotToString(ctx.shot);
      case "camera":
        return cameraToString(ctx);
      case "action":
        return actionToString(ctx);
      case "raw":
        return rawToString(ctx);
    }
  }

  /** 组合 negative：全局 + 风格 + 角色 + 调用方，去重 */
  private composeNegative(ctx: ImagePromptContext): string | undefined {
    const pools = [
      ...this.template.globalNegative,
      ...(ctx.projectStyle ? [ctx.projectStyle] : []),
      ...(ctx.negativePrompt?.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean) ?? []),
    ];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of pools) {
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result.length > 0 ? result.join(", ") : undefined;
  }
}
