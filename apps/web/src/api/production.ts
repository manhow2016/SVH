/**
 * Production API（制作中心 / 生产项目 / 工作流）。
 *
 * 遵循现有 api 模块惯例：平面对象 + client 装饰器 + ApiError。
 */
import { get, post, patch, del, apiUrl, getAuthToken } from "./client";
import { getAssetLocalization } from "../types/production-types";
import type {
  AssetType,
  Character,
  GenerationKind,
  GenerationPlan,
  GenerationRecord,
  GenerationReviewStatus,
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
  /**
   * 手动重试转存（spec §6）。同步等待下载落盘，最坏约 2 分钟（后端 4 次重试 + 退避 + 超时）：
   * 调用方必须 busy 态防连点。ready 幂等（返回当前资产，不重下）；
   * 422 LOCALIZE_FAILED 的 message 为后端脱敏原因原文（client 已 parse body.error.message）。
   */
  localizeAsset: (id: string) => post<{ asset: ProductionAsset }>(`/api/assets/${enc(id)}/localize`),

  // ---- 生成（图片/视频统一入队，worker 异步执行，轮询 getTask） ----
  generateImage: (
    projectId: string,
    input: { prompt: string; modelName?: string; size?: string },
  ) => post<{ task: ProductionGenerationTask }>(`/api/projects/${enc(projectId)}/assets/generate-image`, input),
  generateVideo: (
    projectId: string,
    // prompt 与 imageUrl 至少提供一个（后端校验）
    input: { prompt?: string; imageUrl?: string; modelName?: string; duration?: number; resolution?: string },
  ) => post<{ task: ProductionGenerationTask }>(`/api/projects/${enc(projectId)}/assets/generate-video`, input),
  getTask: (id: string) => get<ProductionGenerationTask>(`/api/tasks/${enc(id)}`),
  // 取消返回终态 task view（幂等语义：已终态则 409）
  cancelTask: (id: string) => post<ProductionGenerationTask>(`/api/tasks/${enc(id)}/cancel`),
};

/**
 * 生成审核 / 版本 / 批量（V0.3 Phase 5/6）。
 */
export const generationApi = {
  listByProject: (
    projectId: string,
    filter?: { shotId?: string; storyboardId?: string; kind?: GenerationKind; reviewStatus?: GenerationReviewStatus },
  ) => {
    const params = new URLSearchParams();
    if (filter?.shotId) params.set("shotId", filter.shotId);
    if (filter?.storyboardId) params.set("storyboardId", filter.storyboardId);
    if (filter?.kind) params.set("kind", filter.kind);
    if (filter?.reviewStatus) params.set("reviewStatus", filter.reviewStatus);
    const qs = params.toString();
    return get<GenerationRecord[]>(`/api/projects/${enc(projectId)}/generations${qs ? `?${qs}` : ""}`);
  },
  listByShot: (shotId: string) => get<GenerationRecord[]>(`/api/shots/${enc(shotId)}/generations`),
  create: (
    projectId: string,
    input: {
      shotId?: string;
      storyboardId?: string;
      kind: GenerationKind;
      prompt: string;
      negativePrompt?: string;
      promptMetadata?: Record<string, unknown>;
      inputRef?: { imageUrl?: string };
    },
  ) => post<GenerationRecord>(`/api/projects/${enc(projectId)}/generations`, input),
  approve: (id: string) => post<GenerationRecord>(`/api/generations/${enc(id)}/approve`),
  reject: (id: string) => post<GenerationRecord>(`/api/generations/${enc(id)}/reject`),
  replace: (id: string, assetId: string) =>
    post<GenerationRecord>(`/api/generations/${enc(id)}/replace`, { assetId }),
  /** 重新生成：基于既有记录创建 v+1 并入队（可用 prompt/negativePrompt 覆盖） */
  regenerate: (id: string, input?: { prompt?: string; negativePrompt?: string }) =>
    post<{ record: GenerationRecord; task: ProductionGenerationTask }>(
      `/api/generations/${enc(id)}/regenerate`,
      input ?? {},
    ),
  /** 批量生成（构建 Plan 并逐项入队） */
  batch: (projectId: string, input: { scope?: { shotIds?: string[]; storyboardId?: string; sceneId?: string }; includeVideo?: boolean }) =>
    post<{ projectId: string; plan: GenerationPlan; items: Array<{ id: string; kind: string; taskId?: string }> }>(
      `/api/projects/${enc(projectId)}/generations/batch`,
      input,
    ),
};

/**
 * 本地优先播放源（spec §7）：转存就绪时返回 `/api/media/<id>?token=`，否则 undefined
 * （undefined = 该资产无本地可用源，调用方回退远程 `url`）。
 *
 * ready 谓词与 server media 路由逐字一致（workspacePath 非空 + localization.state ===
 * "ready"，两判双保险：failed 行 path 恒 null，但 UI 不依赖这个不变量）。
 * token 走 query 是 media 路由唯一鉴权通路（`<img>` / `<video>` 带不上 Authorization 头），
 * 故在渲染期现拼——token 轮换后重渲染即重建 URL；无 token（未登录）不发注定 401 的请求。
 * ready 悬空（文件丢失 → media 410）时，server 手动重试已会自愈重下（终审 I1），
 * 调用方的 410→远程回退只兜用户重试前的展示窗口。
 */
export function assetLocalSrc(asset: ProductionAsset): string | undefined {
  const ready = Boolean(asset.workspacePath) && getAssetLocalization(asset.metadata)?.state === "ready";
  if (!ready) return undefined;
  const token = getAuthToken();
  if (!token) return undefined;
  return apiUrl(`/api/media/${enc(asset.id)}?token=${enc(token)}`);
}

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
