/**
 * ProductionContextResolver（V0.3 Phase 1）。
 *
 * 职责：Project ID + Agent Role → 按角色加载「最小相关生产上下文投影」。
 * 满足实施文档 §45 要求：
 * - 不把整个 Production Project 全量序列化给 LLM；
 * - 按 Agent、按任务加载（Script Agent 只带项目+剧本+角色；Storyboard Agent
 *   带项目+剧本+角色+场景；Director 只带项目）。
 *
 * 实现说明：
 * - 依赖 ProductionService（纯领域编排，含存在性/归属/排序规则），不直接访问 DB；
 * - 角色决定加载范围，后续 Phase 3/4 会在此基础上叠加 Character Visual Profile
 *   / Visual Style Profile 投影（在此类内新增加载逻辑，不改调用方契约）。
 */
import type { ProductionScript } from "../script/script-types";
import type { ProductionService } from "../service";
import type {
  ProductionContext,
  ProductionContextRole,
  SceneContext,
  ScriptContext,
  StoryboardContext,
} from "./production-context-types";
import {
  buildCharacterNameMap,
  mapCharacterContext,
  mapProjectContext,
  mapSceneContext,
  mapScriptContext,
  mapStoryboardContext,
} from "./production-context-types";

/** 解析输入：项目 id + Agent 角色（决定加载范围） */
export interface ResolveProductionContextInput {
  projectId: string;
  role: ProductionContextRole;
}

/** 剧本选择：优先已审核（approved），否则取最新版本；无剧本返回 undefined */
function pickScript(scripts: ProductionScript[]): ProductionScript | undefined {
  if (scripts.length === 0) return undefined;
  const approved = scripts.find((s) => s.status === "approved");
  if (approved) return approved;
  return [...scripts].sort((a, b) => b.version - a.version || b.id.localeCompare(a.id))[0];
}

export class ProductionContextResolver {
  constructor(private readonly production: ProductionService) {}

  async resolve(input: ResolveProductionContextInput): Promise<ProductionContext> {
    const project = await this.production.getProject(input.projectId);
    const ctx: ProductionContext = {
      project: mapProjectContext(project),
      characters: [],
      scenes: [],
      storyboards: [],
      shots: [],
    };

    // 角色决定加载范围（无默认全量，避免 Context 爆炸）
    switch (input.role) {
      case "director":
        // 导演只需项目本身（生产计划/状态/风格）
        return ctx;

      case "script": {
        // 编剧：项目 + 当前剧本 + 出场角色
        const scripts = await this.production.listScripts(input.projectId);
        const script = pickScript(scripts);
        if (script) {
          ctx.script = mapScriptContext(script) as ScriptContext;
        }
        ctx.characters = (await this.production.listCharacters(input.projectId)).map(mapCharacterContext);
        return ctx;
      }

      case "storyboard": {
        // 分镜师：项目 + 当前剧本 + 角色 + 场景 + 已有分镜 + 已有镜头
        const scripts = await this.production.listScripts(input.projectId);
        const script = pickScript(scripts);
        if (script) {
          ctx.script = mapScriptContext(script) as ScriptContext;
        }
        const characters = await this.production.listCharacters(input.projectId);
        ctx.characters = characters.map(mapCharacterContext);
        const nameMap = buildCharacterNameMap(characters);
        const scenes = (await this.production.listScenes(input.projectId)).map((s) =>
          mapSceneContext(s, nameMap),
        );
        ctx.scenes = scenes as SceneContext[];
        ctx.storyboards = (await this.production.listStoryboards(input.projectId)).map(
          mapStoryboardContext,
        ) as StoryboardContext[];
        return ctx;
      }
    }
  }
}
