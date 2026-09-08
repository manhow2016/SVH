/**
 * StyleResolver（V0.3 Phase 4，实施文档 §25）。
 *
 * 职责：Project / Scene / Shot → 有效视觉风格（Shot > Scene > Project > Global）。
 * 供 server 层在组合生成 Prompt 前解析，保证同一项目跨镜头风格统一。
 */
import type { ProductionService } from "../service";
import type { EffectiveVisualStyle } from "./visual-style-types";
import { resolveVisualStyle, visualStyleToPrompt } from "./visual-style-types";

export interface ResolveStyleInput {
  projectId: string;
  /** 可选：当前场景 id（场景级覆盖） */
  sceneId?: string;
  /** 可选：当前镜头 id（镜头级覆盖，优先级最高） */
  shotId?: string;
}

export interface ResolvedStylePrompt {
  /** 注入 Prompt 的风格 Prompt 字符串（可能为空） */
  stylePrompt: string | undefined;
  negativePrompt: string | undefined;
  style: EffectiveVisualStyle;
}

export class StyleResolver {
  constructor(private readonly production: ProductionService) {}

  /** 解析有效视觉风格 */
  async resolve(input: ResolveStyleInput): Promise<EffectiveVisualStyle> {
    const project = await this.production.getProject(input.projectId);
    const scene = input.sceneId ? await this.production.getScene(input.sceneId) : undefined;
    const shot = input.shotId ? await this.production.getShot(input.shotId) : undefined;
    return resolveVisualStyle({ project, scene, shot });
  }

  /** 解析并渲染为可直接注入 Prompt Composer 的风格 Prompt */
  async resolveForPrompt(input: ResolveStyleInput): Promise<ResolvedStylePrompt> {
    const style = await this.resolve(input);
    return {
      stylePrompt: visualStyleToPrompt(style),
      negativePrompt: style.negativePrompt,
      style,
    };
  }
}
