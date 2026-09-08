/**
 * list_episodes 工具（短剧多集，V0.3）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, requireProjectInWorkspace, requiredString } from "./utils";

export interface ListEpisodesToolDeps {
  production: ProductionService;
}

export function listEpisodesTool({ production }: ListEpisodesToolDeps): Tool {
  return {
    name: "list_episodes",
    description: "列出项目的全部集（按集号升序），用于了解项目分集情况。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "项目 id（必填）" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const projectId = requiredString(raw, "projectId");
      await requireProjectInWorkspace(production, projectId, context.workspaceId);
      return asResult(await production.listEpisodes(projectId));
    },
  };
}
