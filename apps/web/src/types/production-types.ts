/**
 * Production 领域类型镜像（web 不依赖 server 包，与 @svh/production 同构）。
 * 服务端返回的 Date 序列化为 ISO 字符串。
 */

// ================= Project =================
export type ProjectType = "short_video" | "short_drama" | "animation" | "advertisement";
export type ProjectStatus = "draft" | "planning" | "producing" | "completed" | "archived";

export interface ProductionProjectSettings {
  duration?: number;
  style?: string;
  generation?: Record<string, unknown>;
}

export interface ProductionProject {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  description?: string;
  type: ProjectType;
  status: ProjectStatus;
  settings: ProductionProjectSettings;
  createdAt: string;
  updatedAt: string;
}

// ================= Script =================
export type ScriptStatus = "draft" | "reviewing" | "approved";
export interface ProductionScript {
  id: string;
  projectId: string;
  title: string;
  content: string;
  version: number;
  status: ScriptStatus;
  createdAt: string;
  updatedAt: string;
}

// ================= Character =================
export interface CharacterAppearance {
  gender?: string;
  age?: string;
  hairstyle?: string;
  clothing?: string;
  facialFeatures?: string;
  style?: string;
}
export interface Character {
  id: string;
  projectId: string;
  name: string;
  description: string;
  appearance: CharacterAppearance;
  personality?: string;
  referenceAssetId?: string;
  createdAt: string;
  updatedAt: string;
}

// ================= Scene =================
export interface ProductionScene {
  id: string;
  projectId: string;
  scriptId?: string;
  order: number;
  name: string;
  description: string;
  location?: string;
  time?: string;
  characters: string[];
  createdAt: string;
  updatedAt: string;
}

// ================= Storyboard =================
export type StoryboardStatus = "draft" | "approved";
export interface Storyboard {
  id: string;
  projectId: string;
  sceneId: string;
  order: number;
  description: string;
  duration: number;
  shotType: string;
  cameraMovement?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  status: StoryboardStatus;
  createdAt: string;
  updatedAt: string;
}

// ================= Shot =================
export type ShotStatus = "pending" | "generating" | "ready" | "failed";
export interface ProductionShot {
  id: string;
  projectId: string;
  storyboardId: string;
  order: number;
  duration: number;
  framing?: string;
  cameraMovement?: string;
  action?: string;
  dialogue?: string;
  imageAssetId?: string;
  videoAssetId?: string;
  status: ShotStatus;
  createdAt: string;
  updatedAt: string;
}

// ================= Asset =================
export type AssetType = "image" | "video" | "audio" | "document" | "subtitle" | "reference";
export interface AssetGeneration {
  providerId: string;
  modelId?: string;
  prompt?: string;
  taskId?: string;
}
export interface ProductionAsset {
  id: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  type: AssetType;
  name: string;
  url?: string;
  workspacePath?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  generation?: AssetGeneration;
  createdAt: string;
  updatedAt: string;
}

/**
 * metadata.localization 约定结构（资产本地化 spec §3；与 server 侧 LocalizeMetadata 同构）。
 * 无该键 = 从未尝试本地化（远程模式，旧资产不提示）。
 */
export interface AssetLocalizationInfo {
  state: "ready" | "failed";
  /** failed 时的脱敏原因（后端已剔除 URL query 中的密钥） */
  error?: string;
  bytes?: number;
  /** 状态落库时间（ISO） */
  at?: string;
}

const LOCALIZATION_KEY = "localization";

/** 从松散 metadata 中收窄本地化状态（异常形状一律按「未尝试」处理，不影响渲染） */
export function getAssetLocalization(
  metadata?: Record<string, unknown>,
): AssetLocalizationInfo | undefined {
  const raw = metadata?.[LOCALIZATION_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const state = (raw as { state?: unknown }).state;
  if (state !== "ready" && state !== "failed") return undefined;
  // 逐字段值级收窄（T5 Minor-1）：整对象断言会把 error=对象/bytes=字符串这类
  // 脏数据原样透到 UI（Tooltip 渲染对象炸 React、`xx ${bytes}` 出 "NaN"）。
  const r = raw as { error?: unknown; bytes?: unknown; at?: unknown };
  return {
    state,
    error: typeof r.error === "string" ? r.error : undefined,
    bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) ? r.bytes : undefined,
    at: typeof r.at === "string" ? r.at : undefined,
  };
}

// ================= 生成任务（视频异步任务） =================
export type ProductionTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface ProductionGenerationTask {
  id: string;
  projectId: string;
  kind: string;
  status: ProductionTaskStatus;
  progress?: number | null;
  outputUrl?: string | null;
  error?: string | null;
  providerId?: string | null;
}

// ================= Workflow =================
export type WorkflowStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "retrying"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  status: WorkflowNodeStatus;
  dependsOn: string[];
  input?: unknown;
  output?: unknown;
  retryCount: number;
  maxRetries: number;
  error?: string;
}

export interface Workflow {
  id: string;
  projectId: string;
  userId: string;
  status: WorkflowStatus;
  nodes: WorkflowNode[];
  createdAt: string;
  updatedAt: string;
}

/** 工作流 SSE 事件（与 @svh/core WorkflowEvent 同构） */
export type WorkflowEvent =
  | { type: "workflow.started"; workflowId: string }
  | { type: "workflow.completed"; workflowId: string }
  | { type: "workflow.failed"; workflowId: string; error: string }
  | { type: "workflow.cancelled"; workflowId: string }
  | { type: "workflow.paused"; workflowId: string }
  | { type: "workflow.resumed"; workflowId: string }
  | { type: "node.started"; workflowId: string; nodeId: string }
  | { type: "node.completed"; workflowId: string; nodeId: string; output?: unknown }
  | { type: "node.failed"; workflowId: string; nodeId: string; error: string; retryCount: number }
  | { type: "node.retrying"; workflowId: string; nodeId: string; attempt: number }
  | { type: "node.cancelled"; workflowId: string; nodeId: string }
  | { type: "workflow.snapshot"; workflowId: string; status: WorkflowStatus; nodes: WorkflowNode[] };

export function isTerminalWorkflowEvent(event: WorkflowEvent): boolean {
  return (
    event.type === "workflow.completed" ||
    event.type === "workflow.failed" ||
    event.type === "workflow.cancelled"
  );
}
