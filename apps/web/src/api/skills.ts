import { get } from "./client";
import { ssePost } from "./run";
import type { SkillDefinitionView } from "../types/api-types";
import type { RunAgentOptions } from "./run";

export const skillsApi = {
  list: () => get<SkillDefinitionView[]>("/api/skills"),
};

export function runSkillRequest(
  sessionId: string,
  body: { skillId: string; params?: Record<string, unknown>; modelName?: string },
  options: RunAgentOptions,
): Promise<void> {
  return ssePost(`/api/sessions/${sessionId}/skill`, body, options);
}
