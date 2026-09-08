import { get, post, patch, del } from "./client";
import type { Session, SessionMessage } from "../types/api-types";

export interface UpdateSessionInput {
  title?: string;
  modelProviderId?: string;
  modelId?: string;
}

export const sessionApi = {
  // V0.3：会话与生产项目一对一绑定——按项目查询（projectId 必填）
  list: (projectId: string) => get<Session[]>(`/api/sessions?projectId=${encodeURIComponent(projectId)}`),
  /** 获取/创建项目绑定会话（幂等：项目已有会话则返回已有） */
  create: (projectId: string, title?: string) => post<Session>("/api/sessions", { projectId, title }),
  get: (id: string) => get<Session>(`/api/sessions/${id}`),
  update: (id: string, input: UpdateSessionInput) => patch<Session>(`/api/sessions/${id}`, input),
  remove: (id: string) => del<void>(`/api/sessions/${id}`),
  messages: (id: string) => get<SessionMessage[]>(`/api/sessions/${id}/messages`),
};
