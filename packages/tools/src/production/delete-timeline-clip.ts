/**
 * delete_timeline_clip 工具（V0.3 文档 Phase 6）。
 *
 * 删除剪辑后时间轴 duration 自动重算、version +1。
 */
import type { Tool } from "../tool";
import type { ProductionService, TimelineService } from "@svh/production";
import { asResult, inputRecord, requiredString } from "./utils";
import { requireClipInWorkspace } from "./timeline-utils";

export interface DeleteTimelineClipToolDeps {
  production: ProductionService;
  timeline: TimelineService;
}

export function deleteTimelineClipTool({ production, timeline }: DeleteTimelineClipToolDeps): Tool {
  return {
    name: "delete_timeline_clip",
    description: "删除剪辑（时间轴 duration/version 自动重算）。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "剪辑 id（必填）" },
      },
      required: ["clipId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const clipId = requiredString(raw, "clipId");
      await requireClipInWorkspace(production, timeline, clipId, context.workspaceId);
      await timeline.deleteClip(clipId);
      return asResult({ ok: true });
    },
  };
}
