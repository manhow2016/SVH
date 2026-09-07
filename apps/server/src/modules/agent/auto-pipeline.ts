/**
 * Chat → Workflow 自动串联（V0.2 收尾增强）。
 *
 * 目标：Director Agent 在一次 Run 内成功创建生产项目后，
 * 自动为该 projects 创建默认生产工作流并启动执行，
 * 用户无需再到制作中心手动点 Run。
 *
 * 设计约束（与文档分层一致）：
 * - 仅 server 侧编排，不侵入 Agent Runtime / 领域包；
 * - 会员门控：无 workflow.automation 的用户静默跳过（不向会话注入系统消息污染上下文）；
 * - 幂等：项目已有工作流则跳过，避免重复创建；
 * - 失败吞掉：自动串联任何异常只记日志，绝不影响用户已经收到的正常回复。
 */
import type { ModelConfig } from "@svh/providers";
import type { MembershipService } from "../membership/service";
import type { WorkflowService } from "../production/workflow-service";

export interface AutoPipelineLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface AutoPipelineDeps {
  workflowService: WorkflowService;
  membershipService: MembershipService;
  log: AutoPipelineLog;
}

/** streamRun 结束后传入的串联参数 */
export interface AutoPipelineParams {
  profileId: string | undefined;
  /** 本次 Run 中所有成功创建的 projectId（按调用顺序） */
  projectIds: string[];
  userId: string;
  workspaceId: string;
  sessionId: string;
  modelConfig: ModelConfig;
  /** 用户本轮输入，作为工作流剧本节点的初始 prompt */
  story: string;
}

/**
 * 从一次 tool.completed 事件抽取「新建项目」的 projectId（纯函数，便于单测）。
 *
 * create_project 成功时 output 为项目实体（含 id）；
 * 工具失败时 output 为 `{ error: string }`，需排除。
 * 返回 null 表示该事件不是成功的项目创建。
 */
export function extractCreatedProjectId(toolName: string, output: unknown): string | null {
  if (toolName !== "create_project") return null;
  if (typeof output !== "object" || output === null) return null;
  if (
    "error" in output &&
    typeof (output as { error: unknown }).error === "string"
  ) {
    return null;
  }
  const id = (output as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export class AutoPipelineService {
  constructor(private readonly deps: AutoPipelineDeps) {}

  /**
   * 满足条件时自动创建并启动生产工作流。
   * 内部吞掉所有异常（仅记日志），调用方可 fire-and-forget。
   */
  async maybeStart(p: AutoPipelineParams): Promise<void> {
    try {
      // 仅 Director 角色触发自动串联
      if (p.profileId !== "director") return;
      // 取最后一个成功创建的项目（Director 正常流程只建一个）
      const projectId = p.projectIds[p.projectIds.length - 1];
      if (!projectId) return;

      // 会员门控：无 workflow.automation 权限则静默跳过
      try {
        await this.deps.membershipService.assertFeature(p.userId, "workflow.automation");
      } catch {
        this.deps.log.info(
          { projectId, userId: p.userId },
          "auto workflow skipped (no workflow.automation feature)",
        );
        return;
      }

      // 幂等：项目已有工作流则跳过，不重复创建
      const existing = await this.deps.workflowService.listWorkflows(projectId);
      if (existing.length > 0) {
        this.deps.log.info({ projectId }, "auto workflow skipped (workflow already exists)");
        return;
      }

      const created = (await this.deps.workflowService.createWorkflow(projectId, p.userId, {
        story: p.story,
      })) as { id: string };
      await this.deps.workflowService.runWorkflow(created.id, {
        sessionId: p.sessionId,
        workspaceId: p.workspaceId,
        userId: p.userId,
        modelConfig: p.modelConfig,
      });
      this.deps.log.info(
        { projectId, workflowId: created.id, sessionId: p.sessionId },
        "auto workflow started",
      );
    } catch (err) {
      this.deps.log.error(
        { error: (err as Error).message, projectIds: p.projectIds },
        "auto workflow failed",
      );
    }
  }
}
