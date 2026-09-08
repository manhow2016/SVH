import { get, post, patch, del } from "./client";
import type { Session, SessionMessage } from "../types/api-types";

export interface UpdateSessionInput {
  title?: string;
  modelProviderId?: string;
  modelId?: string;
}

export const sessionApi = {
  // V0.3：会话自动归属用户默认工作区（无 workspace 前缀）
  list: () => get<Session[]>("/api/sessions"),
  create: (title?: string) => post<Session>("/api/sessions", { title }),
  get: (id: string) => get<Session>(`/api/sessions/${id}`),
  update: (id: string, input: UpdateSessionInput) => patch<Session>(`/api/sessions/${id}`, input),
  remove: (id: string) => del<void>(`/api/sessions/${id}`),
  messages: (id: string) => get<SessionMessage[]>(`/api/sessions/${id}/messages`),
};
