import { Button, Tooltip } from "antd";
import { CopyOutlined, DownloadOutlined } from "@ant-design/icons";
import { message as antdMessage } from "antd";
import type { SkillMessageMeta } from "../../types/api-types";

interface SkillResultCardProps {
  meta: SkillMessageMeta;
  content: string;
  streaming?: boolean;
  /** 模型显示名（由父组件由 modelName 映射，缺省显示 modelName） */
  modelDisplayName?: string;
}

/**
 * 技能结果卡片：头部（技能名 + 模型 + 参数摘要）+ 正文（按 resultKind 渲染）。
 * V1：text 正文 + 复制 / 下载 .md；媒体 resultKind 为 V2 预留（占位提示）。
 */
export function SkillResultCard({ meta, content, streaming, modelDisplayName }: SkillResultCardProps) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      antdMessage.success("已复制到剪贴板");
    } catch {
      antdMessage.error("复制失败");
    }
  };
  const download = () => {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.skillName}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const paramSummary = Object.entries(meta.params)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 20)}`)
    .join(" · ");

  return (
    <div style={{ maxWidth: "92%", border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-surface)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--color-border)", background: "#fafafa" }}>
        <Tooltip title={paramSummary}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{meta.skillName}</span>
        </Tooltip>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{modelDisplayName ?? meta.modelName}</span>
        <div style={{ flex: 1 }} />
        {!streaming && meta.resultKind === "text" && (
          <>
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={copy}>复制</Button>
            <Button size="small" type="text" icon={<DownloadOutlined />} onClick={download}>下载 .md</Button>
          </>
        )}
      </div>
      <div style={{ padding: "10px 12px", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {streaming ? content + "▍" : content}
      </div>
    </div>
  );
}
