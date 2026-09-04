import { get, post, del } from "./client";
import type { Workspace } from "../types/api-types";

export const workspaceApi = {
  list: () => get<Workspace[]>("/api/workspaces"),
  create: (name: string) => post<Workspace>("/api/workspaces", { name }),
  remove: (id: string) => del<void>(`/api/workspaces/${id}`),
};
