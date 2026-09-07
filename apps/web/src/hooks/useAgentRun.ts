import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { runAgent } from "../api/run";
import { runSkillRequest } from "../api/skills";
import { useSessionStore } from "../stores/session-store";
import { useUIStore } from "../stores/ui-store";
import type { AgentEvent, SkillDefinitionView, SkillMessageMeta } from "../types/api-types";

/** 流式消息项（聊天 UI 渲染用的运行时状态） */
export type StreamItem =
  | { kind: "user"; id: string; content: string; skill?: SkillMessageMeta }
  | { kind: "assistant"; id: string; content: string; status: "streaming" | "done"; skill?: SkillMessageMeta }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      status: "running" | "done" | "error";
    };

export interface UseAgentRunResult {
  streamItems: StreamItem[];
  isRunning: boolean;
  error: string | null;
  send: (message: string, profileId?: string) => Promise<void>;
  /** 以流式方式运行技能（复用消息流 UI 状态并携带技能元数据） */
  runSkill: (skill: SkillDefinitionView, params: Record<string, unknown>, modelName?: string) => Promise<void>;
  stop: () => void;
}

/**
 * Agent Run Hook：负责 Message 发送、SSE 事件 → 流式 UI 状态、Stop（AbortController）。
 *
 * 运行结束后从服务器重新拉取消息（以持久化数据为准）并刷新文件列表。
 */
export function useAgentRun(sessionId: string | null): UseAgentRunResult {
  const queryClient = useQueryClient();
  const { isRunning, setIsRunning } = useSessionStore();
  const bumpFilesRevision = useUIStore((s) => s.bumpFilesRevision);
  const [streamItems, setStreamItems] = useState<StreamItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // 切换会话：清空流式状态，避免串台
  useEffect(() => {
    setStreamItems([]);
    setError(null);
    controllerRef.current?.abort();
  }, [sessionId]);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const send = useCallback(
    async (message: string, profileId?: string) => {
      if (!sessionId || isRunning) return;
      setError(null);
      // 本地占位显示用户消息（服务器持久化由 ContextBuilder 完成）
      setStreamItems([
        { kind: "user", id: `local_user_${Date.now().toString(36)}`, content: message },
      ]);
      const controller = new AbortController();
      controllerRef.current = controller;
      setIsRunning(true);

      const onEvent = (event: AgentEvent) => {
        switch (event.type) {
          case "run.started":
            break;
          case "message.started":
            setStreamItems((items) => [
              ...items,
              { kind: "assistant", id: event.messageId, content: "", status: "streaming" },
            ]);
            break;
          case "message.delta":
            setStreamItems((items) =>
              items.map((item) =>
                item.kind === "assistant" && item.id === event.messageId
                  ? { ...item, content: item.content + event.content }
                  : item,
              ),
            );
            break;
          case "message.completed":
            setStreamItems((items) =>
              items.map((item) =>
                item.kind === "assistant" && item.id === event.messageId
                  ? { ...item, status: "done" as const }
                  : item,
              ),
            );
            break;
          case "tool.called":
            setStreamItems((items) => [
              ...items,
              {
                kind: "tool",
                id: event.toolCallId,
                toolName: event.toolName,
                input: event.input,
                status: "running",
              },
            ]);
            break;
          case "tool.completed":
            setStreamItems((items) =>
              items.map((item) =>
                item.kind === "tool" && item.id === event.toolCallId
                  ? {
                      ...item,
                      output: event.output,
                      status: isErrorOutput(event.output) ? ("error" as const) : ("done" as const),
                    }
                  : item,
              ),
            );
            break;
          case "workspace.changed":
            bumpFilesRevision();
            break;
          case "run.completed":
            break;
          case "run.error":
            setError(event.error);
            break;
          default:
            break;
        }
      };

      try {
        await runAgent(sessionId, message, { onEvent, signal: controller.signal }, profileId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        controllerRef.current = null;
        setIsRunning(false);
        // 以服务器持久化数据为准刷新消息与文件
        await queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
        setStreamItems([]);
        bumpFilesRevision();
      }
    },
    [sessionId, isRunning, queryClient, setIsRunning, bumpFilesRevision],
  );

  const runSkill = useCallback(
    async (skill: SkillDefinitionView, params: Record<string, unknown>, modelName?: string) => {
      if (!sessionId || isRunning) return;
      setError(null);
      // 本地占位：技能用户消息（完整元数据以服务端持久化数据为准）
      const skillMeta: SkillMessageMeta = {
        skillId: skill.id,
        skillName: skill.name,
        params: params as Record<string, string | number>,
        modelName: modelName ?? "",
        resultKind: skill.resultKind,
      };
      setStreamItems([{ kind: "user", id: `local_skill_${Date.now().toString(36)}`, content: `运行技能「${skill.name}」…`, skill: skillMeta }]);
      const controller = new AbortController();
      controllerRef.current = controller;
      setIsRunning(true);

      const onEvent = (event: AgentEvent) => {
        switch (event.type) {
          case "message.started":
            setStreamItems((items) => [
              ...items,
              { kind: "assistant", id: event.messageId, content: "", status: "streaming", skill: { ...skillMeta, modelName: modelName ?? skillMeta.modelName } },
            ]);
            break;
          case "message.delta":
            setStreamItems((items) =>
              items.map((item) =>
                item.kind === "assistant" && item.id === event.messageId
                  ? { ...item, content: item.content + event.content }
                  : item,
              ),
            );
            break;
          case "message.completed":
            setStreamItems((items) =>
              items.map((item) =>
                item.kind === "assistant" && item.id === event.messageId
                  ? { ...item, status: "done" as const }
                  : item,
              ),
            );
            break;
          case "run.error":
            setError(event.error);
            break;
          default:
            break;
        }
      };

      try {
        await runSkillRequest(sessionId, { skillId: skill.id, params, modelName: modelName ?? "" }, { onEvent, signal: controller.signal });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        controllerRef.current = null;
        setIsRunning(false);
        await queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
        setStreamItems([]);
      }
    },
    [sessionId, isRunning, queryClient, setIsRunning],
  );

  return { streamItems, isRunning, error, send, runSkill, stop };
}

function isErrorOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "error" in output &&
    typeof (output as { error: unknown }).error === "string"
  );
}
