/**
 * Agent Profile（文档 §8：一个统一 Runtime + 多个 Agent Profile）。
 *
 * Profile 是纯数据配置：角色提示词 + 工具白名单。
 * - 类型定义放在 core（运行时通用能力）
 * - 具体 Profile 定义（Director/Script/Storyboard）放在 server 层
 *   （apps/server/src/modules/agent/profiles.ts，内容属业务域）
 */
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  /** 角色系统提示词（叠加在 DEFAULT_SYSTEM_PROMPT 之后） */
  systemPrompt: string;
  /** 工具白名单（缺省 = 全部工具可用） */
  allowedTools?: string[];
}
