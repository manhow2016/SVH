import { Skeleton } from "antd";
import type { Session } from "@svh/shared";
import { AgentChat } from "./AgentChat";

/**
 * 会话模块（制作中心内容区「会话」页签）：
 * 会话与生产项目一对一绑定（项目创建时自动绑定，用户不可新建/切换），
 * 由详情页查询项目会话后注入，这里直接渲染对话。
 */
export function ChatModule({ session }: { session?: Session }) {
  if (!session) {
    return (
      <div style={{ height: "100%", padding: 16 }}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <AgentChat session={session} />
    </div>
  );
}
