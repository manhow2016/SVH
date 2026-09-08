/**
 * 配音节点执行器（audio.generate）：为带对白的镜头批量配音（TTS）。
 *
 * 语义（Phase C，简化版——幂等靠任务表 (workflowId,nodeId) 收养，不做扇出超时收割）：
 * - 项目全部分镜 → 镜头（对白非空）→ 逐个 enqueueAudio（音色取场景首角色 voice）；
 * - 收养既有任务（重复执行不重复入队）；等待循环 → completed 时按任务绑定
 *   shot.audioAssetId（findAssetByTask 反查）
 * - 输出 { items: { [shotId]: { taskId, status } }, summary }
 * - 无对白镜头 → 空输出（不抛错，与生成节点"0 合格分镜抛错"不同：配音可空跑）
 */
import type { WorkflowNode } from "@svh/core";

export interface AudioNodeContext {
  projectId: string;
  workflowId: string;
  userId: string;
}

/** 依赖端口（注入面；与 generation-node-executor 同纪律，只声明消费子集） */
export interface AudioNodeDeps {
  pollMs: number;
  maxWaitMs: number;
  listStoryboards(projectId: string): Promise<Array<{ id: string; sceneId: string; order: number }>>;
  listShotsByStoryboard(
    storyboardId: string,
  ): Promise<Array<{ id: string; dialogue?: string | null; duration: number }>>;
  /** 场景首角色的音色（无角色/未配置返回 undefined） */
  resolveSceneVoice(sceneId: string): Promise<string | undefined>;
  enqueueAudio(input: {
    projectId: string;
    userId: string;
    prompt: string;
    voice?: string;
    storyboardId: string;
    workflowId: string;
    nodeId: string;
    assetName: string;
  }): Promise<{ id: string }>;
  getTask(id: string): Promise<{ id: string; status: string }>;
  findAssetByTask(taskId: string): Promise<{ id: string } | null>;
  updateShotAudio(shotId: string, audioAssetId: string): Promise<void>;
  /** 按节点查询既有任务（收养：不重复入队） */
  listTasksByNode(
    workflowId: string,
    nodeId: string,
  ): Array<{ id: string; status: string; storyboardId?: string }>;
}

export interface AudioNodeOutputItem {
  taskId: string | null;
  status: "running" | "completed" | "failed" | "skipped";
  reason?: string;
}

export interface AudioNodeOutput {
  items: Record<string, AudioNodeOutputItem>;
  summary: { total: number; succeeded: number; failed: number; skipped: number };
}

export async function runAudioNode(opts: {
  ctx: AudioNodeContext;
  node: WorkflowNode;
  input: unknown;
  deps: AudioNodeDeps;
  signal?: AbortSignal;
}): Promise<AudioNodeOutput> {
  const { ctx, node, deps, signal } = opts;
  const items: Record<string, AudioNodeOutputItem> = {};
  const pending: Array<{ shotId: string; taskId: string }> = [];

  // 1) 收集带对白镜头
  const storyboards = await deps.listStoryboards(ctx.projectId);
  const existing = new Map<string, { id: string; status: string }>();
  for (const t of deps.listTasksByNode(ctx.workflowId, node.id)) {
    if (t.storyboardId) existing.set(t.storyboardId, { id: t.id, status: t.status });
  }
  // 镜头 → 所属分镜的既有任务（收养用）
  const taskByStoryboard = new Map<string, { id: string; status: string }>();
  for (const sb of storyboards) {
    const t = existing.get(sb.id);
    if (t) taskByStoryboard.set(sb.id, t);
  }

  for (const sb of storyboards) {
    const shots = await deps.listShotsByStoryboard(sb.id);
    // 已收养：running/queued 任务直接挂入等待集合
    const adopted = taskByStoryboard.get(sb.id);
    for (const shot of shots) {
      const dialogue = shot.dialogue?.trim();
      if (!dialogue) {
        items[shot.id] = { taskId: null, status: "skipped", reason: "无对白" };
        continue;
      }
      if (adopted && adopted.status !== "failed" && adopted.status !== "cancelled") {
        items[shot.id] = { taskId: adopted.id, status: "running" };
        pending.push({ shotId: shot.id, taskId: adopted.id });
        continue;
      }
      const voice = await deps.resolveSceneVoice(sb.sceneId);
      const task = await deps.enqueueAudio({
        projectId: ctx.projectId,
        userId: ctx.userId,
        prompt: dialogue,
        voice,
        storyboardId: sb.id,
        workflowId: ctx.workflowId,
        nodeId: node.id,
        assetName: `镜头${shot.duration}s·配音`,
      });
      items[shot.id] = { taskId: task.id, status: "running" };
      pending.push({ shotId: shot.id, taskId: task.id });
    }
  }

  // 2) 等待循环：轮询未终态任务；completed → 绑定音频资产，failed → 记为失败
  const deadline = Date.now() + deps.maxWaitMs;
  for (;;) {
    if (signal?.aborted) {
      for (const p of pending) {
        if (items[p.shotId]?.status === "running") {
          items[p.shotId] = { taskId: p.taskId, status: "failed", reason: "节点取消" };
        }
      }
      break;
    }
    const inflight = pending.filter((p) => items[p.shotId]?.status === "running");
    if (inflight.length === 0) break;
    if (Date.now() > deadline) {
      for (const p of inflight) {
        items[p.shotId] = { taskId: p.taskId, status: "failed", reason: "等待超时" };
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
    for (const p of inflight) {
      const t = await deps.getTask(p.taskId);
      if (t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled") continue;
      if (t.status === "completed") {
        const asset = await deps.findAssetByTask(p.taskId);
        if (asset) {
          await deps.updateShotAudio(p.shotId, asset.id);
          items[p.shotId] = { taskId: p.taskId, status: "completed" };
        } else {
          items[p.shotId] = { taskId: p.taskId, status: "failed", reason: "未找到产出资产" };
        }
      } else {
        items[p.shotId] = { taskId: p.taskId, status: "failed", reason: `任务${t.status}` };
      }
    }
  }

  const values = Object.values(items);
  return {
    items,
    summary: {
      total: values.length,
      succeeded: values.filter((v) => v.status === "completed").length,
      failed: values.filter((v) => v.status === "failed").length,
      skipped: values.filter((v) => v.status === "skipped").length,
    },
  };
}
