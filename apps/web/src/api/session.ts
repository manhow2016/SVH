import { get, post, patch, del } from "./client";
import type { Session, SessionMessage } from "../types/api-types";

export interface UpdateSessionInput {
  title?: string;
  modelProviderId?: string;
  modelId?: string;
}

export const sessionApi = {
  list: (workspaceId: string) => get<Session[]>(`/api/workspaces/${workspaceId}/sessions`),
  create: (workspaceId: string, title?: string) =>
    post<Session>(`/api/workspaces/${workspaceId}/sessions`, { title }),
  get: (id: string) => get<Session>(`/api/sessions/${id}`),
  update: (id: string, input: UpdateSessionInput) => patch<Session>(`/api/sessions/${id}`, input),
  remove: (id: string) => del<void>(`/api/sessions/${id}`),
  messages: (id: string) => get<SessionMessage[]>(`/api/sessions/${id}/messages`),
};
