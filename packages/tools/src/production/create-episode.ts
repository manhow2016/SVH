/**
 * create_episode 工具（短剧多集，V0.3）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import {
  asResult,
  inputRecord,
  optionalNumber,
  optionalString,
  requireProjectInWorkspace,
  requiredString,
} from "./utils";

export interface CreateEpisodeToolDeps {
  production: ProductionService;
}

export function createEpisodeTool({ production }: CreateEpisodeToolDeps): Tool {
  return {
    name: "create_episode",
    description:
      "为短剧项目添加一集（集号自动递增，名称缺省「第 N 集」）。每集拥有独立的剧本/场景/分镜/镜头/成片时间轴；角色与媒体资产跨集共享。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
        name: { type: "string", description: "集名（缺省「第 N 集」）" },
        description: { type: "string", description: "集描述" },
        order: { type: "number", description: "集号（>= 1，缺省当前最大 + 1）" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      const episode = await production.createEpisode({
        projectId,
        name: optionalString(raw, "name"),
        description: optionalString(raw, "description"),
        order: optionalNumber(raw, "order"),
      });
      return asResult(episode);
    },
  };
}
