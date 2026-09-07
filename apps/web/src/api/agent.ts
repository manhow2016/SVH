import { get } from "./client";
import type { AgentProfileView } from "../types/api-types";

/** Agent 角色（Profile）API */
export const agentApi = {
  /** 可选角色列表（导演 / 编剧 / 分镜师…；空列表时前端隐藏角色选择器） */
  profiles: () => get<AgentProfileView[]>("/api/agent/profiles"),
};
