/**
 * update_shot 工具（文档 §10.4）。
 */
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
import { asResult, inputRecord, optionalNumber, optionalString, requireProjectInWorkspace, requiredString } from "./utils";

export interface UpdateShotToolDeps {
  production: ProductionService;
}

export function updateShotTool({ production }: UpdateShotToolDeps): Tool {
  return {
    name: "update_shot",
    description:
      "更新镜头（时长/景别/运镜/动作/对白/资产/状态）。状态流转：pending→generating→ready|failed，failed 可重置为 pending。",
    inputSchema: {
      type: "object",
      properties: {
        shotId: { type: "string", description: "镜头 id（必填）" },
        duration: { type: "number", description: "镜头时长（秒）" },
        framing: { type: "string" },
        cameraMovement: { type: "string" },
        action: { type: "string" },
        dialogue: { type: "string" },
        imageAssetId: { type: "string", description: "参考图资产 id" },
        videoAssetId: { type: "string", description: "生成结果视频资产 id" },
        order: { type: "number" },
        status: { type: "string", enum: ["pending", "generating", "ready", "failed"] },
      },
      required: ["shotId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const raw = inputRecord(input);
      const shotId = requiredString(raw, "shotId");
      const current = await production.getShot(shotId);
      await requireProjectInWorkspace(production, current.projectId, context.workspaceId);
      const shot = await production.updateShot(shotId, {
        duration: optionalNumber(raw, "duration"),
        framing: optionalString(raw, "framing"),
        cameraMovement: optionalString(raw, "cameraMovement"),
        action: optionalString(raw, "action"),
        dialogue: optionalString(raw, "dialogue"),
        imageAssetId: optionalString(raw, "imageAssetId"),
        videoAssetId: optionalString(raw, "videoAssetId"),
        order: optionalNumber(raw, "order"),
        status: optionalString(raw, "status") as "pending" | undefined,
      });
      return asResult(shot);
    },
  };
}
