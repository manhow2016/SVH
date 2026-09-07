/**
 * Production API（制作中心 / 生产项目 / 工作流）。
 *
 * 遵循现有 api 模块惯例：平面对象 + client 装饰器 + ApiError。
 */
import { get, post, patch, del, apiUrl, getAuthToken } from "./client";
import type {
  AssetType,
  Character,
  ProductionAsset,
  ProductionGenerationTask,
  ProductionProject,
  ProductionScene,
  ProductionScript,
  ProductionShot,
  ProjectType,
  ScriptStatus,
  ShotStatus,
  Storyboard,
  StoryboardStatus,
  Workflow,
  WorkflowEvent,
  WorkflowNodeStatus,
} from "../types/production-types";

function enc(value: string): string {
  return encodeURIComponent(value);
}

export const productionApi = {
  // ---- 项目 ----
  listProjects: () => get<ProductionProject[]>("/api/productions"),
  createProject: (input: {
    workspaceId: string;
    name: string;
    type?: ProjectType;
    description?: string;
    duration?: number;
    style?: string;
  }) => post<ProductionProject>("/api/productions", input),
  getProject: (id: string) => get<ProductionProject>(`/api/productions/${enc(id)}`),
  updateProject: (
    id: string,
    input: { name?: string; type?: ProjectType; description?: string; duration?: number; style?: string },
  ) => patch<ProductionProject>(`/api/productions/${enc(id)}`, input),

  // ---- 剧本 ----
  listScripts: (projectId: string) =>
    get<ProductionScript[]>(`/api/projects/${enc(projectId)}/scripts`),
  createScript: (projectId: string, input: { title: string; content: string }) =>
    post<ProductionScript>(`/api/projects/${enc(projectId)}/scripts`, input),
  updateScript: (id: string, input: { title?: string; content?: string; status?: ScriptStatus }) =>
    patch<ProductionScript>(`/api/scripts/${enc(id)}`, input),

  // ---- 角色 ----
  listCharacters: (projectId: string) =>
    get<Character[]>(`/api/projects/${enc(projectId)}/characters`),
  createCharacter: (
    projectId: string,
    input: { name: string; description: string; appearance?: Record<string, unknown>; personality?: string },
  ) => post<Character>(`/api/projects/${enc(projectId)}/characters`, input),
  updateCharacter: (id: string, input: { name?: string; description?: string; personality?: string }) =>
    patch<Character>(`/api/characters/${enc(id)}`, input),

  // ---- 场景 ----
  listScenes: (projectId: string) =>
    get<ProductionScene[]>(`/api/projects/${enc(projectId)}/scenes`),
  createScene: (
    projectId: string,
    input: {
      name: string;
      description: string;
      scriptId?: string;
      location?: string;
      time?: string;
      characters?: string[];
    },
  ) => post<ProductionScene>(`/api/projects/${enc(projectId)}/scenes`, input),

  // ---- 分镜 ----
  listStoryboards: (projectId: string) =>
    get<Storyboard[]>(`/api/projects/${enc(projectId)}/storyboards`),
  createStoryboard: (
    projectId: string,
    input: {
      sceneId: string;
      description: string;
      duration: number;
      shotType: string;
      cameraMovement?: string;
      imagePrompt?: string;
      videoPrompt?: string;
    },
  ) => post<Storyboard>(`/api/projects/${enc(projectId)}/storyboards`, input),
  updateStoryboard: (
    id: string,
    input: { duration?: number; shotType?: string; cameraMovement?: string; imagePrompt?: string; videoPrompt?: string; status?: StoryboardStatus },
  ) => patch<Storyboard>(`/api/storyboards/${enc(id)}`, input),

  // ---- 镜头 ----
  listShots: (projectId: string) => get<ProductionShot[]>(`/api/projects/${enc(projectId)}/shots`),
  createShot: (
    projectId: string,
    input: { storyboardId: string; duration: number; framing?: string; cameraMovement?: string; action?: string; dialogue?: string },
  ) => post<ProductionShot>(`/api/projects/${enc(projectId)}/shots`, input),
  updateShot: (id: string, input: { status?: ShotStatus }) =>
    patch<ProductionShot>(`/api/shots/${enc(id)}`, input),

  // ---- 资产 ----
  listAssets: (projectId: string, type?: AssetType) =>
    get<ProductionAsset[]>(
      `/api/projects/${enc(projectId)}/assets${type ? `?type=${encodeURIComponent(type)}` : ""}`,
    ),
  deleteAsset: (id: string) => del<{ ok: boolean }>(`/api/assets/${enc(id)}`),

  // ---- 生成（图片同步返回资产；视频创建异步任务，轮询 getTask） ----
  generateImage: (
    projectId: string,
    input: { prompt: string; modelName?: string; size?: string },
  ) => post<{ asset: ProductionAsset; created?: number }>(`/api/projects/${enc(projectId)}/assets/generate-image`, input),
  generateVideo: (
    projectId: string,
    // prompt 与 imageUrl 至少提供一个（后端校验）
    input: { prompt?: string; imageUrl?: string; modelName?: string; duration?: number; resolution?: string },
  ) => post<ProductionGenerationTask>(`/api/projects/${enc(projectId)}/assets/generate-video`, input),
  getTask: (id: string) => get<ProductionGenerationTask>(`/api/tasks/${enc(id)}`),
  cancelTask: (id: string) => post<{ ok: boolean }>(`/api/tasks/${enc(id)}/cancel`),
};

export const workflowApi = {
  list: (projectId: string) => get<Workflow[]>(`/api/projects/${enc(projectId)}/workflows`),
  create: (projectId: string, input: { story?: string }) =>
    post<Workflow>(`/api/projects/${enc(projectId)}/workflows`, input),
  get: (id: string) => get<Workflow>(`/api/workflows/${enc(id)}`),
  run: (id: string, input: { sessionId: string }) =>
    post<Workflow>(`/api/workflows/${enc(id)}/run`, input),
  pause: (id: string) => post<{ ok: boolean }>(`/api/workflows/${enc(id)}/pause`),
  resume: (id: string) => post<{ ok: boolean }>(`/api/workflows/${enc(id)}/resume`),
  cancel: (id: string) => post<{ ok: boolean }>(`/api/workflows/${enc(id)}/cancel`),
  retryNode: (id: string, nodeId: string) =>
    post<Workflow>(`/api/workflows/${enc(id)}/nodes/${enc(nodeId)}/retry`),
};

/**
 * 订阅工作流事件（GET SSE；返回结束后自动停止）。
 * 需配合 AbortSignal 在组件卸载时中断。
 */
export async function subscribeWorkflowEvents(
  id: string,
  onEvent: (event: WorkflowEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getAuthToken();
  const response = await fetch(apiUrl(`/api/workflows/${enc(id)}/events`), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`工作流事件订阅失败（${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice("data:".length).trim()) as WorkflowEvent);
      } catch {
        // 忽略无法解析的分块
      }
    }
  }
}

/** 描述性工具：节点状态 → 中文文案 */
export const WORKFLOW_NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  pending: "待执行",
  queued: "排队中",
  running: "执行中",
  retrying: "重试中",
  waiting: "等待",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
};
