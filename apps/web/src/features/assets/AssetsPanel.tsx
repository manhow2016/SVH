import React, { useEffect, useState, useCallback, useRef } from "react";
import { Button, Modal, Input, Select, Slider, Typography, message as antdMessage, Form, Dropdown } from "antd";
import type { MenuProps } from "antd";
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  AudioOutlined,
  BoxPlotOutlined,
  DownloadOutlined,
  DownOutlined,
  FolderOutlined,
  PictureOutlined,
  UserOutlined,
  PlusOutlined,
  RocketOutlined,
  ScanOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import type { AssetType } from "../../types/api-types";
import { assetsApi, assetLibraryRawUrl } from "../../api/assets";
import { getAuthToken } from "../../api/client";
import { productionApi } from "../../api/production";
import type { FileEntry } from "../../types/api-types";
import { useIsMobile } from "../../hooks/use-is-mobile";

const { TextArea } = Input;
const { Text } = Typography;

// ---------------------------------------------------------------------------
// 资产类型信息
// ---------------------------------------------------------------------------

/** 页签 / 彩色图标所需的最小信息 */
interface TabBase {
  label: string;
  color: string;
  /** 浅色底色（用于彩色图标背景 / 卡片强调区） */
  colorBg: string;
  Icon: React.ComponentType;
}

interface TypeInfo extends TabBase {
  type: AssetType;
  maxCount: number;
  defaultCount: number;
}

/** 类型分页签项（含「所有资产」汇总页签） */
interface TypeTabItem extends TabBase {
  key: string;
  count: number;
}

/** 立体卡片统一样式 */
const CARD: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 12,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 20px rgba(15, 23, 42, 0.08)",
};

const TYPE_MAP: Record<string, TypeInfo> = {
  character: { type: "character", label: "角色", Icon: UserOutlined,       color: "#3b82f6", colorBg: "#eaf2ff", maxCount: 6,  defaultCount: 4 },
  scene:     { type: "scene",     label: "场景", Icon: PictureOutlined,    color: "#22c55e", colorBg: "#e7f8ef", maxCount: 6,  defaultCount: 4 },
  prop:      { type: "prop",      label: "道具", Icon: BoxPlotOutlined,    color: "#d97706", colorBg: "#fdf1e0", maxCount: 6,  defaultCount: 4 },
  voice:     { type: "voice",     label: "音色", Icon: AudioOutlined,      color: "#f43f5e", colorBg: "#fdebec", maxCount: 10, defaultCount: 3 },
};

const ALL_TYPES: TypeInfo[] = Object.values(TYPE_MAP);

/** 英文类型 id → 资产库中文类型目录（与后端 DEFAULT_ASSET_DIRS 对齐） */
const TYPE_DIR: Record<AssetType, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  voice: "音色",
};

/** 图片扩展名集合（缩略图预览；其余按类型图标展示） */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** 生成任务状态（简版缓存：轮询 /api/tasks/:id 后写入） */
interface TaskStatusInfo {
  status: string;
  progress?: number | null;
  error?: string | null;
}

/** 状态展示元信息（标签 + 颜色） */
const TASK_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  queued:    { label: "排队中", color: "#64748b", bg: "#f1f5f9" },
  running:   { label: "生成中", color: "var(--color-primary)", bg: "var(--color-primary-bg, #e6f4ff)" },
  completed: { label: "已完成", color: "#16a34a", bg: "#eaf7ee" },
  failed:    { label: "失败",   color: "#dc2626", bg: "#fdecec" },
  cancelled: { label: "已取消", color: "#64748b", bg: "#f1f5f9" },
};

/** 任务是否到达终态（停止轮询与刷新判据） */
function isTaskTerminal(status?: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 彩色图标（圆角方形浅色底 + 同色图标） */
function ColoredIcon({ info, size = 36 }: { info: TabBase; size?: number }) {
  const radius = Math.round(size * 0.25);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, borderRadius: radius, background: info.colorBg, flexShrink: 0 }}>
      <span style={{ fontSize: Math.round(size * 0.55), color: info.color, lineHeight: 1, display: "inline-flex" }}>
        <info.Icon />
      </span>
    </span>
  );
}

/** 画面风格预设 */
export const IMAGE_STYLES = ["真人风格","动漫","二次元","3D","电影感","写实","插画","赛博朋克","古风","水彩"];

/** 音色预设选项 */
const VOICE_OPTS = [
  { value: "male_announcer", label: "男播音员" },
  { value: "gentle_female", label: "温柔女声" },
  { value: "mature_female", label: "成熟女声" },
  { value: "lively_girl", label: "活泼少女" },
  { value: "deep_male", label: "沉稳男声" },
  { value: "news_broadcast", label: "新闻播报" },
  { value: "documentary", label: "纪录片" },
];

type ModeType = "ai" | "reference";

const MAX_REF = 5;

/** ModeSelector 图标映射 */
const MODE_ICONS: Record<ModeType, React.ComponentType<{ style?: React.CSSProperties }>> = {
  ai: RocketOutlined,
  reference: ScanOutlined,
};

/** 安全计数的工具函数：list API 可能返回 undefined；类型目录为中文（角色/场景/道具/音色） */
async function countEntries(folder: string, type: AssetType): Promise<number> {
  const result = await assetsApi.list(`${folder}/${TYPE_DIR[type]}`);
  return (result ?? []).length;
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function AssetsPanel() {
  const isMobile = useIsMobile();
  const foldersElRef = useRef<HTMLDivElement>(null);

  /* ===== 状态 ===== */
  const [folders, setFolders] = useState<FileEntry[]>([]);
  const [selFolder, setSelFolder] = useState("默认");
  const [selType, setSelType] = useState<AssetType | "all">("character");
  const [counts, setCounts] = useState({ character: 0, scene: 0, prop: 0, voice: 0 });

  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");

  /* 新建资产弹窗 */
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [creatorType, setCreatorType] = useState<AssetType>("character");
  const [creatorMode, setCreatorMode] = useState<ModeType>("ai");
  /** 列表刷新版本（生成完成/删除后递增，驱动文件列表面板重取） */
  const [listVersion, setListVersion] = useState(0);

  /* ===== 生成任务追踪：提交后实时显示状态，全部终态自动刷新计数与列表 ===== */
  const [taskStatuses, setTaskStatuses] = useState<Record<string, TaskStatusInfo>>({});
  const [trackedTaskIds, setTrackedTaskIds] = useState<string[]>([]);

  // 登记新提交的任务（幂等：已追踪的不重复）
  const trackTasks = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setTrackedTaskIds(prev => [...prev, ...ids.filter(id => !prev.includes(id))]);
    setTaskStatuses(prev => {
      const next = { ...prev };
      for (const id of ids) next[id] = next[id] ?? { status: "queued" };
      return next;
    });
  }, []);

  // 轮询：存在未追踪完的任务时每 2.5s 拉一次状态（组件卸载即停）
  useEffect(() => {
    if (trackedTaskIds.length === 0) return;
    let alive = true;
    const poll = async () => {
      const results = await Promise.all(
        trackedTaskIds.map(id =>
          productionApi.getTask(id).then(t => ({ id, t })).catch(() => null),
        ),
      );
      if (!alive) return;
      setTaskStatuses(prev => {
        const next = { ...prev };
        for (const r of results) {
          if (r) next[r.id] = { status: r.t.status, progress: r.t.progress, error: r.t.error };
        }
        return next;
      });
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [trackedTaskIds]);

  // 页面挂载时加载文件夹（隐藏系统目录：refs 参考图暂存、点号开头目录）
  useEffect(() => {
    assetsApi.list()
      .then(fs => setFolders((fs ?? []).filter(f => f.type === "directory" && !f.name.startsWith(".") && f.name !== "refs")))
      .catch(() => setFolders([]));
  }, []);

  // 加载计数
  const refreshCounts = useCallback((f: string) => {
    void Promise.all(ALL_TYPES.map(t => countEntries(f, t.type))).then(([c, s, p, v]) => {
      setCounts({ character: c ?? 0, scene: s ?? 0, prop: p ?? 0, voice: v ?? 0 });
    });
  }, []);

  useEffect(() => { refreshCounts(selFolder); }, [selFolder, refreshCounts]);

  // 全部终态 → 刷新计数与列表、提示结果、停止追踪
  useEffect(() => {
    if (trackedTaskIds.length === 0) return;
    const statuses = trackedTaskIds.map(id => taskStatuses[id]?.status);
    if (!statuses.every(s => s === "completed" || s === "failed" || s === "cancelled")) return;
    refreshCounts(selFolder);
    setListVersion(v => v + 1);
    const done = statuses.filter(s => s === "completed").length;
    if (done > 0) antdMessage.success(`生成完成 ${done}/${trackedTaskIds.length}`);
    else antdMessage.error("生成失败，请检查模型设置或查看任务状态");
    setTrackedTaskIds([]);
  }, [taskStatuses, trackedTaskIds, refreshCounts, selFolder]);

  // 滚动选中文件夹到可视区域
  useEffect(() => {
    if (!foldersElRef.current || !selFolder) return;
    const btn = foldersElRef.current.querySelector(`[data-folder="${selFolder}"]`);
    btn?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selFolder]);

  /* ===== 操作 ===== */

  // 创建文件夹
  const doCreateFolder = async () => {
    const n = folderName.trim();
    if (!n) { antdMessage.warning("请输入名称"); return; }
    try {
      await assetsApi.create(n);
      antdMessage.success(`已创建「${n}」`);
      setFolderName(""); setFolderOpen(false);
      setFolders(p => [...p, { name: n, path: n, type: "directory" }]);
      setSelFolder(n);
      refreshCounts(n);
    } catch { antdMessage.error("创建失败"); }
  };

  // 删除文件夹：删除前询问用户；文件夹内资产被制作中心项目引用时禁止删除（后端 409）
  const doDeleteFolder = (n: string) => {
    Modal.confirm({
      title: `删除文件夹「${n}」？`,
      content: "将删除文件夹内的全部资产，删除后不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await assetsApi.remove(n);
          antdMessage.success(`已删除「${n}」`);
          setFolders(p => p.filter(f => f.name !== n));
          if (selFolder === n) {
            const rest = folders.filter(f => f.name !== n);
            setSelFolder(rest[0]?.name ?? "");
          }
        } catch (e) {
          const err = e as {
            code?: string;
            details?: { references?: Array<{ libPath: string; projectName: string; assetName: string }> };
          };
          if (err.code === "ASSET_LIBRARY_REFERENCED") {
            const refs = err.details?.references ?? [];
            Modal.warning({
              title: "无法删除：资产被项目引用",
              content: (
                <div>
                  <p style={{ margin: "0 0 8px" }}>
                    文件夹「{n}」中的以下资产仍被制作中心项目引用，请先前往对应项目解除引用：
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflow: "auto" }}>
                    {refs.map((r, i) => (
                      <li key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>
                        《{r.projectName}》引用了 {r.libPath}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
              okText: "知道了",
            });
            return;
          }
          antdMessage.error("删除失败");
        }
      },
    });
  };

  // 打开新建资产弹窗
  const openCreator = (t: AssetType) => { setCreatorType(t); setCreatorMode("ai"); setCreatorOpen(true); };
  const closeCreator = useCallback(() => setCreatorOpen(false), []);

  /* 所有类型页签（含「所有资产」汇总页签） */
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const tabItems: TypeTabItem[] = [
    { key: "all", label: "所有资产", color: "var(--color-primary)", colorBg: "var(--color-primary-bg, #e6f4ff)", Icon: AppstoreOutlined, count: totalCount },
    ...ALL_TYPES.map(info => ({ key: info.type, label: info.label, color: info.color, colorBg: info.colorBg, Icon: info.Icon, count: counts[info.type] })),
  ];

  /* 新建资产下拉菜单：按类型打开对应创建表单 */
  const newMenu: MenuProps = {
    items: ALL_TYPES.map(info => ({
      key: info.type,
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <ColoredIcon info={info} size={20} />
          {info.label}资产
        </span>
      ),
    })),
    onClick: ({ key }) => openCreator(key as AssetType),
  };

  return (
    <>
      {/* ===== 页头：标题 + 返回制作中心 ===== */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 8, background: "var(--color-primary-bg, #e6f4ff)" }}>
            <AppstoreOutlined style={{ fontSize: 16, color: "var(--color-primary)" }} />
          </span>
          <span style={{ fontSize: 16, fontWeight: 600 }}>我的资产</span>
        </span>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => { window.location.hash = "#/production"; }}>
          返回制作中心
        </Button>
      </div>

      {/* ===== 主体：左侧资源文件夹立体卡片 + 右侧类型分页夹与内容 ===== */}
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "flex-start", gap: 16, padding: "16px 0 0" }}>
          {/* 左：资源文件夹立体卡片 */}
          <FolderPanel
            folders={folders}
            sel={selFolder}
            onSelect={setSelFolder}
            onDelete={doDeleteFolder}
            onAdd={() => setFolderOpen(true)}
            listRef={foldersElRef}
            mobile={isMobile}
          />

          {/* 右：资源类型分页夹 + 内容区（整体一张立体卡片） */}
          <div style={{ flex: 1, minWidth: 0, ...CARD, overflow: "hidden" }}>
            {/* 类型分页夹 + 操作按钮（移动端：类型改为下拉菜单，按钮另起一行平分） */}
            <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "center",
              gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--color-border)",
              background: "var(--color-surface-secondary)" }}>
              {isMobile ? (
                <TypeSelect items={tabItems} sel={selType} onTab={k => setSelType(k as AssetType | "all")} />
              ) : (
                <TypeTabs items={tabItems} sel={selType} onTab={k => setSelType(k as AssetType | "all")} />
              )}
              <div style={{ display: "flex", gap: 8, ...(isMobile ? { width: "100%" } : { flexShrink: 0, marginLeft: "auto" }) }}>
                <Button style={isMobile ? { flex: 1, minWidth: 0 } : undefined} icon={<DownloadOutlined />} onClick={() => antdMessage.info("打包下载功能开发中，敬请期待")}>打包下载</Button>
                <Dropdown menu={newMenu}>
                  <Button type="primary" style={isMobile ? { flex: 1, minWidth: 0 } : undefined} icon={<PlusOutlined />}>
                    新建资产
                    <DownOutlined style={{ fontSize: 10, marginLeft: 4 }} />
                  </Button>
                </Dropdown>
              </div>
            </div>

            {/* 内容区：所选类型 / 全部资产概览 */}
            <div style={{ padding: "20px 20px 24px" }}>
              {selType === "all" ? (
                <AllPanel counts={counts} onPick={t => setSelType(t)} onNew={openCreator} />
              ) : (() => {
                const ti = TYPE_MAP[selType];
                if (!ti) return null;
                return <TypePanel info={ti} count={counts[ti.type]} folderName={selFolder} version={listVersion} onNew={() => openCreator(ti.type)} />;
              })()}
            </div>
          </div>
        </div>

      {/* ===== 新建文件夹弹窗 ===== */}
      <Modal open={folderOpen} onCancel={() => setFolderOpen(false)} onOk={doCreateFolder} title="新建资源文件夹" width={400} maskClosable={false}>
        <Input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="如：古装短剧" onPressEnter={doCreateFolder} autoFocus />
        <Text style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 4, display: "block" }}>自动生成四个类型子目录</Text>
      </Modal>

      {/* ===== 新建资产弹窗 ===== */}
      <CreatorModal open={creatorOpen} onClose={closeCreator} type={creatorType} mode={creatorMode} onModeChange={setCreatorMode}
        folder={selFolder}
        statuses={taskStatuses}
        onTracked={trackTasks}
        onSuccess={() => { refreshCounts(selFolder); setListVersion(v => v + 1); }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 左侧：资源文件夹立体卡片
// ---------------------------------------------------------------------------

function FolderPanel({ folders, sel, onSelect, onDelete, onAdd, listRef, mobile }: {
  folders: FileEntry[]; sel: string; onSelect: (n: string) => void; onDelete: (n: string) => void;
  onAdd: () => void; listRef: React.RefObject<HTMLDivElement>; mobile: boolean;
}) {
  return (
    <div style={{ ...CARD, width: mobile ? "100%" : 208, flexShrink: 0, padding: "12px", display: "flex", flexDirection: "column", gap: 4 }}>
      {/* 卡片标题：文件夹 + 新建入口 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 8px" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>文件夹</span>
        <button type="button" onClick={onAdd} aria-label="新建文件夹"
          style={{ width: 24, height: 24, borderRadius: "50%", border: "none", cursor: "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12,
            background: "var(--color-primary)", color: "#fff", boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
            transition: "transform 0.15s, opacity 0.15s" }}>
          <PlusOutlined />
        </button>
      </div>

      {/* 文件夹列表（桌面 / 移动端统一竖向列表） */}
      <div ref={listRef} className="hide-scrollbar" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {folders.map(f => {
          const active = f.name === sel;
          return (
            <button key={f.path} type="button" data-folder={f.name} onClick={() => onSelect(f.name)}
              style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, borderRadius: 8,
                border: "none", cursor: "pointer", textAlign: "left", whiteSpace: "nowrap",
                padding: "9px 10px",
                background: active ? "var(--color-primary-bg, #e6f4ff)" : "transparent",
                transition: "background 0.15s" }}
              onMouseEnter={e => { if (!active && !mobile) e.currentTarget.style.background = "rgba(0,0,0,0.03)"; }}
              onMouseLeave={e => { if (!active && !mobile) e.currentTarget.style.background = "transparent"; }}>
              <FolderOutlined style={{ fontSize: 15, color: active ? "var(--color-primary)" : "var(--color-text-tertiary)" }} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: active ? 600 : 400, color: active ? "var(--color-primary)" : "var(--color-text-secondary)", transition: "color 0.15s" }}>
                {f.name === "默认" ? "全部资产" : f.name}
              </span>
              {/* 删除（非默认文件夹；桌面选中/悬停显示，移动端常显，点击区加大） */}
              {f.name !== "默认" && (
                <span onClick={e => { e.stopPropagation(); onDelete(f.name); }}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: mobile ? 24 : 16, height: mobile ? 24 : 16, borderRadius: "50%",
                    cursor: "pointer", opacity: mobile ? 1 : (active ? 1 : 0), transition: "opacity 0.15s, background 0.15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,0,0,0.06)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                  <CloseOutlined style={{ fontSize: 10, color: "var(--color-text-tertiary)" }} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <Text style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "0 4px" }}>资产按文件夹归类存放</Text>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 资源类型分页签
// ---------------------------------------------------------------------------

/** 移动端类型切换：下拉菜单（图标 + 名称 + 数量徽标） */
function TypeSelect({ items, sel, onTab }: { items: TypeTabItem[]; sel: string; onTab: (k: string) => void }) {
  const cur = items.find(i => i.key === sel) ?? items[0]!;
  return (
    <Dropdown trigger={["click"]} placement="bottomLeft"
      menu={{
        selectable: true,
        selectedKeys: [sel],
        onClick: ({ key }) => onTab(key),
        items: items.map(i => ({
          key: i.key,
          label: (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 176 }}>
              <ColoredIcon info={i} size={16} />
              <span style={{ flex: 1, fontSize: 13 }}>{i.label}</span>
              <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 8, fontWeight: 600,
                background: "var(--color-surface-secondary)", color: "var(--color-text-tertiary)" }}>
                {i.count}
              </span>
            </span>
          ),
        })),
      }}>
      <Button style={{ width: "100%", justifyContent: "flex-start", padding: "0 12px" }}>
        <ColoredIcon info={cur} size={16} />
        <span style={{ flex: 1, textAlign: "left", fontSize: 13, fontWeight: 600 }}>{cur.label}</span>
        <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 8, fontWeight: 600, marginRight: 4,
          background: cur.colorBg, color: cur.color }}>
          {cur.count}
        </span>
        <DownOutlined style={{ fontSize: 10, color: "var(--color-text-tertiary)" }} />
      </Button>
    </Dropdown>
  );
}

/** 桌面类型页签（窄窗口横向滚动，滚动条隐藏） */
function TypeTabs({ items, sel, onTab }: { items: TypeTabItem[]; sel: string; onTab: (k: string) => void }) {
  return (
    <div className="hide-scrollbar" style={{ display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", flex: 1, minWidth: 0 }}>
      {items.map(info => {
        const active = info.key === sel;
        return (
          <button key={info.key} type="button" onClick={() => onTab(info.key)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 11px", borderRadius: 8,
              border: "none", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
              background: active ? "var(--color-surface)" : "transparent",
              boxShadow: active ? "0 1px 3px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}>
            <ColoredIcon info={info} size={18} />
            <span style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: active ? info.color : "var(--color-text-secondary)", transition: "color 0.15s" }}>
              {info.label}
            </span>
            <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 8,
              background: active ? info.colorBg : "var(--color-surface)",
              color: active ? info.color : "var(--color-text-tertiary)", fontWeight: 600 }}>
              {info.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 右侧：选中类型的卡片内容区
// ---------------------------------------------------------------------------

function TypePanel({ info, count, folderName, version, onNew }: {
  info: TypeInfo; count: number; folderName: string; version: number; onNew: () => void;
}) {
  const isMobile = useIsMobile();
  const cols = isMobile ? 2 : 3;
  const empty = count <= 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 类型标题条（窄屏允许换行，避免文件夹说明溢出） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <ColoredIcon info={info} size={30} />
        <Text style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>{info.label}资产</Text>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>· 当前「{folderName === "默认" ? "全部资产" : folderName}」</span>
      </div>

      {/* 内容网格 */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
        {/* 醒目的大计数卡 */}
        <HighlightCard info={info} count={count} />
        {empty ? (
          /* 空状态卡：图标 + 标题 + 引导 + 主操作 */
          <EmptyCard info={info} onNew={onNew} />
        ) : (
          <>
            {/* 资产列表卡（真实文件列表：缩略图/图标 + 名称，点击打开） */}
            <AssetListCard info={info} folderName={folderName} version={version} />
            {/* 新建入口卡 */}
            <NewCard info={info} onNew={onNew} />
          </>
        )}
      </div>
    </div>
  );
}

/** 醒目计数卡：彩色底 + 大字号数字 */
function HighlightCard({ info, count }: { info: TypeInfo; count: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, minHeight: 96, padding: "16px 18px",
      borderRadius: 12, background: info.colorBg, border: `1px solid ${info.color}22` }}>
      <Text style={{ fontSize: 12, color: info.color, fontWeight: 500 }}>已有{info.label}</Text>
      <Text style={{ fontSize: 30, fontWeight: 700, color: info.color, lineHeight: 1.1 }}>{count}</Text>
      <Text style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>个{info.label}资产</Text>
    </div>
  );
}

/** 新建入口卡 */
function NewCard({ info, onNew }: { info: TypeInfo; onNew: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 96,
      borderRadius: 12, border: `1.5px dashed ${info.color}55`, background: "var(--color-surface)", cursor: "pointer",
      transition: "border-color 0.15s, background 0.15s" }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = info.color; e.currentTarget.style.background = info.colorBg; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = `${info.color}55`; e.currentTarget.style.background = "var(--color-surface)"; }}
      onClick={onNew}>
      <PlusOutlined style={{ fontSize: 22, color: info.color }} />
      <Text style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>新建{info.label}</Text>
    </div>
  );
}

/** 资产列表卡：真实文件列表（缩略图/图标 + 名称；点击在新标签打开预览） */
function AssetListCard({ info, folderName, version }: { info: TypeInfo; folderName: string; version: number }) {
  const isMobile = useIsMobile();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // 加载所选文件夹 + 类型下的文件（counts 已保证目录存在；list 失败视为空）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    assetsApi.list(`${folderName}/${TYPE_DIR[info.type]}`)
      .then(fs => { if (alive) setFiles(fs ?? []); })
      .catch(() => { if (alive) setFiles([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [folderName, info.type, version]);

  if (loading) {
    return (
      <div style={{ minHeight: 152, borderRadius: 12, border: "1px solid var(--color-border)",
        background: "var(--color-surface)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>加载中...</Text>
      </div>
    );
  }

  const visible = files.filter(f => f.type !== "directory").reverse();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, minHeight: 152,
      borderRadius: 12, border: "1px solid var(--color-border)", background: "var(--color-surface)"
    }}>
      <Text style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)" }}>
        {visible.length > 0 ? `文件（${visible.length}）` : "文件"}
      </Text>
      {visible.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 12, color: "var(--color-text-tertiary)", textAlign: "center" }}>
            暂无文件{info.type === "voice" ? "（生成完成后自动出现在此处）" : ""}
          </Text>
        </div>
      ) : (
        <div className="hide-scrollbar" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
          {visible.map(f => <AssetFileRow key={f.path} info={info} file={f} mobile={isMobile} />)}
        </div>
      )}
    </div>
  );
}

/** 单个资产文件行：缩略图（图片类）/ 图标 + 文件名，点击打开（token query 鉴权） */
function AssetFileRow({ info, file, mobile }: { info: TypeInfo; file: FileEntry; mobile: boolean }) {
  const token = getAuthToken();
  const rawUrl = token ? assetLibraryRawUrl(file.path, token) : undefined;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isImage = IMAGE_EXTS.has(ext);
  const open = () => { if (rawUrl) window.open(rawUrl, "_blank", "noopener"); };

  return (
    <button type="button" onClick={open} title={rawUrl ? "点击打开" : "未登录，无法预览"}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8,
        border: "1px solid var(--color-border)", background: "var(--color-surface-secondary)",
        cursor: rawUrl ? "pointer" : "default", textAlign: "left", minWidth: 0,
        transition: "border-color 0.15s, background 0.15s" }}
      onMouseEnter={e => { if (rawUrl && !mobile) { e.currentTarget.style.borderColor = info.color; e.currentTarget.style.background = info.colorBg; } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--color-border)"; e.currentTarget.style.background = "var(--color-surface-secondary)"; }}>
      <span style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, overflow: "hidden", background: "var(--color-surface)",
        display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        {isImage && rawUrl ? (
          <img src={rawUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: 15, color: info.color }}><info.Icon /></span>
        )}
      </span>
      <span style={{ flex: 1, fontSize: 12, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {file.name}
      </span>
      {rawUrl && <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", flexShrink: 0 }}>打开</span>}
    </button>
  );
}

/** 空状态卡：图标 + 标题 + 引导文案 + 主操作 */
function EmptyCard({ info, onNew }: { info: TypeInfo; onNew: () => void }) {
  return (
    <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
      minHeight: 152, borderRadius: 12, border: "1.5px dashed var(--color-border)", background: "var(--color-surface-secondary)" }}>
      <PlusOutlined style={{ fontSize: 26, color: "var(--color-text-tertiary)" }} />
      <Text style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)" }}>暂无{info.label}资产</Text>
      <Text style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>点击上方「新建资产」选择{info.label}创建</Text>
      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onNew} style={{ marginTop: 6, borderRadius: 8 }}>新建{info.label}</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 「所有资产」汇总视图：四类彩色计数卡
// ---------------------------------------------------------------------------

function AllPanel({ counts, onPick, onNew }: {
  counts: Record<AssetType, number>; onPick: (t: AssetType) => void; onNew: (t: AssetType) => void;
}) {
  const isMobile = useIsMobile();
  const cols = isMobile ? 2 : 4;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ALL_INFO: TabBase = { label: "所有资产", color: "var(--color-primary)", colorBg: "var(--color-primary-bg, #e6f4ff)", Icon: AppstoreOutlined };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 标题条 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ColoredIcon info={ALL_INFO} size={24} />
        <Text style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>全部资产</Text>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>· 共 {total} 个</span>
      </div>

      {/* 四类彩色计数卡 */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
        {ALL_TYPES.map(t => (
          <div key={t.type} onClick={() => onPick(t.type)}
            style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px", borderRadius: 12, cursor: "pointer",
              background: t.colorBg, border: `1px solid ${t.color}22`,
              transition: "transform 0.15s, box-shadow 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 6px 16px rgba(0,0,0,0.08)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <ColoredIcon info={t} size={32} />
              <Text style={{ fontSize: 24, fontWeight: 700, color: t.color, lineHeight: 1 }}>{counts[t.type]}</Text>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{t.label}资产</Text>
              <button type="button" onClick={e => { e.stopPropagation(); onNew(t.type); }}
                style={{ padding: "4px 10px", borderRadius: 8, border: "none", cursor: "pointer",
                  fontSize: 12, fontWeight: 500, background: t.color, color: "#fff" }}>
                + 新建
              </button>
            </div>
            <Text style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>最多 {t.maxCount} 个 · 点击卡片查看</Text>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建资产弹窗 + 模式选择器
// ---------------------------------------------------------------------------

function CreatorModal({ open, onClose, type, mode, onModeChange, folder, statuses, onTracked, onSuccess }: {
  open: boolean; onClose: () => void; type: AssetType; mode?: ModeType;
  onModeChange?: (m: ModeType) => void; folder: string;
  /** 资产页级任务状态缓存（本次提交的任务 id → 状态；关闭弹窗仍继续轮询） */
  statuses: Record<string, TaskStatusInfo>;
  /** 登记新提交的任务（资产页级轮询与自动刷新） */
  onTracked: (ids: string[]) => void;
  onSuccess: () => void;
}) {
  const isChar = type === "character";
  return (
    <Modal open={open} onCancel={onClose} width={560} maskClosable={false} destroyOnClose
      title={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <FolderOutlined style={{ fontSize: 14, color: "var(--color-text-tertiary)" }} />
        新建{getLabel(type)}
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", fontWeight: 400 }}>
          · 存放于「{folder === "默认" ? "全部资产" : folder}」
        </span>
      </span>}
      footer={null}>
      {isChar && !!onModeChange && <ModeSelector selected={mode!} onChange={onModeChange} />}
      {isChar && <CharacterForm mode={mode as ModeType} folder={folder} statuses={statuses} onTracked={onTracked} onClose={onClose} onSuccess={onSuccess} />}
      {!isChar && <SimpleCreator type={type} folder={folder} statuses={statuses} onTracked={onTracked} onClose={onClose} onSuccess={onSuccess} />}
    </Modal>
  );
}

function getLabel(t: string): string {
  return { character: "角色", scene: "场景", prop: "道具", voice: "音色" }[t] ?? t;
}

/** 模式选项 */
const MODE_DATA: { mode: ModeType; title: string; desc: string }[] = [
  { mode: "ai",         title: "AI 生成",   desc: "根据文字描述生成" },
  { mode: "reference",  title: "参考图生成", desc: "根据参考图片生成" },
];

function ModeSelector({ selected, onChange }: { selected: ModeType; onChange: (m: ModeType) => void }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-tertiary)", marginBottom: 8 }}>创建方式</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {MODE_DATA.map(m => {
          const IconComp = MODE_ICONS[m.mode];
          const active = selected === m.mode;
          return (
            <button key={m.mode} type="button" onClick={() => onChange(m.mode)}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "16px 12px", borderRadius: 10,
                border: active ? "2px solid var(--color-primary)" : "1px solid var(--color-border)",
                background: active ? "var(--color-primary-bg, #e6f4ff)" : "var(--color-surface)", cursor: "pointer", transition: "all 0.15s", textAlign: "center" }}>
              <span style={{ fontSize: 22, color: active ? "var(--color-primary)" : "var(--color-text-secondary)" }}><IconComp /></span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{m.title}</span>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{m.desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 角色表单（支持 AI / 参考图两种模式）
// ---------------------------------------------------------------------------

/** 提交后展示的任务批次（id + 展示名） */
interface SubmittedBatch {
  id: string;
  label: string;
}

function CharacterForm({ mode, folder, statuses, onTracked, onClose, onSuccess }: {
  mode: ModeType; folder: string;
  statuses: Record<string, TaskStatusInfo>;
  onTracked: (ids: string[]) => void;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form] = Form.useForm();
  const [pending, setPending] = useState(false);
  const [refImgs, setRefImgs] = useState<{ dataUrl: string; name: string }[]>([]);
  /** 提交成功后的本批次任务（非空即切换到进度视图） */
  const [batch, setBatch] = useState<SubmittedBatch[] | null>(null);

  const submit = async () => {
    try {
      const v = await form.validateFields();
      setPending(true);
      const res = await assetsApi.generate({
        type: "character",
        mode: refImgs.length > 0 ? "reference" : "ai",
        name: v.name,
        style: v.style,
        description: v.description,
        referenceImages: refImgs.map(i => i.dataUrl),
        count: v.count ?? 4,
        folder,
      });
      antdMessage.success("任务已提交，正在生成...");
      // 登记任务（资产页级轮询）+ 弹窗内展示本批次进度
      onTracked(res.taskIds);
      setBatch(res.taskIds.map((id, i) => ({ id, label: `角色 ${v.name} #${i + 1}` })));
    } catch (err) {
      antdMessage.error(err instanceof Error ? err.message : "生成失败，请稍后重试");
    } finally { setPending(false); }
    onSuccess();
  };

  if (batch) {
    return <TaskStatusList batch={batch} statuses={statuses} onClose={onClose} />;
  }

  return (
    <Form form={form} initialValues={{ style: "真人风格", count: 4 }}>
      <Form.Item name="name" label="角色名" rules={[{ required: true, message: "请输入角色名" }]}>
        <Input placeholder="输入角色名称" maxLength={50} />
      </Form.Item>
      <Form.Item name="style" label="画面风格">
        <Select options={IMAGE_STYLES.map(s => ({ label: s, value: s }))} />
      </Form.Item>

      {mode === "ai" && (
        <Form.Item name="description" label="角色描述" rules={[{ required: true, message: "请输入角色描述" }]}>
          <TextArea placeholder="描述角色的外貌、年龄、服装、发型、气质、身份等" rows={4} maxLength={2000} showCount autoSize={{ minRows: 4, maxRows: 10 }} />
        </Form.Item>
      )}

      {mode === "reference" && <RefUploader images={refImgs} onChange={setRefImgs} />}

      <Form.Item name="count" label="生成数量" initialValue={4}
        rules={[{ validator: (_, v) => v >= 1 && v <= 6 ? Promise.resolve() : Promise.reject(new Error("数量为 1~6")) }]}>
        <Slider min={1} max={6} step={1} marks={{ 1: "1", 6: "6" }} />
      </Form.Item>

      <Actions onSubmit={submit} onCancel={onClose} pending={pending} />
    </Form>
  );
}

/** 参考图上传器 */
function RefUploader({ images, onChange }: { images: { dataUrl: string; name: string }[]; onChange: (i: typeof images) => void }) {
  const rem = MAX_REF - images.length;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    const added: { dataUrl: string; name: string }[] = [];
    for (const f of Array.from(files).slice(0, rem)) {
      const ext = f.type.split("/")[1] ?? "";
      if (!["jpg", "jpeg", "png", "webp"].includes(ext)) continue;
      const url = await new Promise<string>(r => { const rd = new FileReader(); rd.onload = () => r(rd.result as string); rd.readAsDataURL(f); });
      added.push({ dataUrl: url, name: f.name });
    }
    onChange([...images, ...added]);
    e.target.value = "";
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-tertiary)", marginBottom: 8 }}>参考图</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {images.map((img, i) => (
          <div key={i} style={{ position: "relative", width: 72, height: 72 }}>
            <img src={img.dataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }} />
            <button type="button" onClick={() => onChange(images.filter((_, j) => j !== i))}
              style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "none", cursor: "pointer" }}><CloseOutlined style={{ fontSize: 10, color: "#fff" }} /></button>
          </div>
        ))}
        {rem > 0 && (
          <label style={{ width: 72, height: 72, borderRadius: 8, border: "2px dashed var(--color-border)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--color-text-tertiary)", fontSize: 12 }}>
            <PlusOutlined style={{ fontSize: 16 }} />
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handleFile} style={{ display: "none" }} />
          </label>
        )}
      </div>
      <Text style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4, display: "block" }}>已上传 {images.length} / {MAX_REF} 张 · jpg/png/webp</Text>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通用表单（场景 / 道具 / 音色）
// ---------------------------------------------------------------------------

function SimpleCreator({ type, folder, statuses, onTracked, onClose, onSuccess }: {
  type: string; folder: string;
  statuses: Record<string, TaskStatusInfo>;
  onTracked: (ids: string[]) => void;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form] = Form.useForm();
  const [pending, setPending] = useState(false);
  /** 提交成功后的本批次任务（非空即切换到进度视图） */
  const [batch, setBatch] = useState<SubmittedBatch[] | null>(null);

  // 从 TYPE_MAP 获取类型信息；确保 type 值有效
  const infoEntry = TYPE_MAP[type] as TypeInfo | undefined;
  const resolvedInfo = (infoEntry ? infoEntry : TYPE_MAP["scene"] as TypeInfo) as TypeInfo;

  const submit = async () => {
    try {
      const v = await form.validateFields();
      setPending(true);
      let res;
      if (type === "voice") {
        res = await assetsApi.generate({ type: "voice", name: v.name, style: v.style, customDescription: v.customDescription, previewText: v.previewText, count: v.count, folder });
      } else {
        res = await assetsApi.generate({ type: type as "scene" | "prop", name: v.name, style: v.style, description: v.description, summary: v.summary, imageDescription: v.imageDescription, count: v.count ?? 4, folder });
      }
      antdMessage.success("任务已提交，正在生成...");
      const ids = res.taskIds;
      onTracked(ids);
      setBatch(ids.map((id, i) => ({ id, label: `${getLabel(type)} ${v.name} #${i + 1}` })));
    } catch (err) {
      antdMessage.error(err instanceof Error ? err.message : "生成失败，请稍后重试");
    } finally { setPending(false); }
    onSuccess();
  };

  if (batch) {
    return <TaskStatusList batch={batch} statuses={statuses} onClose={onClose} />;
  }

  // ── 音色 ──
  if (type === "voice") {
    return (
      <Form form={form} onFinish={submit} initialValues={{ previewText: "大家好，欢迎来到今天的故事。", count: 3 }}>
        <Form.Item name="name" label="音色名称" rules={[{ required: true, message: "请输入音色名称" }]}>
          <Input placeholder="为这个音色取个名字" maxLength={50} />
        </Form.Item>

        <Form.Item label="音色风格">
          <RadioGroup opts={VOICE_OPTS} />
        </Form.Item>

        <Form.Item name="customDescription" label="自定义描述">
          <TextArea placeholder="或自定义描述音色特点..." rows={3} maxLength={500} showCount />
        </Form.Item>

        <Form.Item name="previewText" label="预览文本" rules={[{ required: true, message: "请输入预览文本" }]}>
          <TextArea placeholder="此文本将用于试听音色效果" rows={3} maxLength={500} />
        </Form.Item>

        <Form.Item name="count" label="生成数量" initialValue={3}
          rules={[{ validator: (_, v) => v >= 1 && v <= 10 ? Promise.resolve() : Promise.reject(new Error("数量为 1~10")) }]}>
          <Slider min={1} max={10} step={1} marks={{ 1: "1", 5: "5", 10: "10" }} />
        </Form.Item>

        <Actions onSubmit={submit} onCancel={onClose} pending={pending} />
      </Form>
    );
  }

  // ── 场景 / 道具 ──
  const isScene = type === "scene";
  return (
    <Form form={form} onFinish={submit} initialValues={{ style: "真人风格", count: resolvedInfo.defaultCount }}>
      <Form.Item name="name" label={`${resolvedInfo.label}名称`} rules={[{ required: true, message: `请输入${resolvedInfo.label}名称` }]}>
        <Input placeholder={`请输入${resolvedInfo.label}名称`} maxLength={50} />
      </Form.Item>

      <Form.Item name="style" label="画面风格">
        <Select options={IMAGE_STYLES.map(s => ({ label: s, value: s }))} />
      </Form.Item>

      {isScene ? (
        <Form.Item name="description" label="场景描述" rules={[{ required: true, message: "请输入场景描述" }]}>
          <TextArea placeholder="描述场景环境、建筑、天气、时间、氛围、光线等" rows={4} maxLength={2000} showCount autoSize={{ minRows: 4, maxRows: 10 }} />
        </Form.Item>
      ) : (
        <>
          <Form.Item name="summary" label="简要说明" rules={[{ required: true, message: "请输入简要说明" }]}>
            <Input placeholder="简单介绍这个道具" maxLength={200} />
          </Form.Item>
          <Form.Item name="imageDescription" label="图片描述" rules={[{ required: true, message: "请输入图片描述" }]}>
            <TextArea placeholder="描述道具的外观、材质、颜色、结构、细节等" rows={4} maxLength={2000} showCount autoSize={{ minRows: 4, maxRows: 10 }} />
          </Form.Item>
        </>
      )}

      <Form.Item name="count" label="生成数量" initialValue={resolvedInfo.defaultCount}
        rules={[{ validator: (_, v) => v >= 1 && v <= resolvedInfo.maxCount ? Promise.resolve() : Promise.reject(new Error(`数量为 1~${resolvedInfo.maxCount}`)) }]}>
        <Slider min={1} max={resolvedInfo.maxCount} step={1} marks={{ 1: "1", [resolvedInfo.maxCount]: String(resolvedInfo.maxCount) }} />
      </Form.Item>

      <Actions onSubmit={submit} onCancel={onClose} pending={pending} />
    </Form>
  );
}

// ---------------------------------------------------------------------------
// 收音风格单选组（独立组件，避免 Radio.Group optionRender 类型问题）
// ---------------------------------------------------------------------------

function RadioGroup({ opts }: { opts: { value: string; label: string }[] }) {
  const [val, setVal] = useState(opts[0]?.value);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {opts.map(o => (
        <button key={o.value} type="button" onClick={() => setVal(o.value)}
          style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${val === o.value ? "var(--color-primary)" : "var(--color-border)"}`,
            background: val === o.value ? "var(--color-primary-bg, #e6f4ff)" : "var(--color-surface)",
            color: val === o.value ? "var(--color-primary)" : "var(--color-text-primary)", fontSize: 12, cursor: "pointer", transition: "all 0.15s" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 生成进度视图（提交后替换表单展示；关闭后任务在后台继续，计数/列表自动刷新）
// ---------------------------------------------------------------------------

function TaskStatusList({ batch, statuses, onClose }: {
  batch: SubmittedBatch[];
  statuses: Record<string, TaskStatusInfo>;
  onClose: () => void;
}) {
  const total = batch.length;
  const done = batch.filter(b => isTaskTerminal(statuses[b.id]?.status)).length;
  const allDone = done === total;
  const failed = batch.filter(b => statuses[b.id]?.status === "failed").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 汇总行：完成进度 + 失败数 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>生成进度</span>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {allDone
            ? failed > 0 ? `完成 ${done - failed} / ${total}，失败 ${failed}` : `全部完成 ${done} / ${total}`
            : `已完成 ${done} / ${total}`}
        </span>
      </div>

      {/* 任务行：名称 + 状态徽标 + 进度 / 失败时附真实错误原因 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
        {batch.map(b => {
          const st = statuses[b.id];
          const meta = TASK_STATUS_META[st?.status ?? ""] ?? TASK_STATUS_META.queued!;
          return (
            <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px",
              borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-secondary)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ flex: 1, fontSize: 12, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.label}
                </span>
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: meta.color, background: meta.bg,
                  padding: "2px 8px", borderRadius: 8 }}>
                  {meta.label}
                  {st?.status === "running" && typeof st.progress === "number" ? ` ${st.progress}%` : ""}
                </span>
              </div>
              {/* 失败原因（供应商真实错误，截断展示；hover 可看全文） */}
              {st?.status === "failed" && st.error ? (
                <span title={st.error} style={{ fontSize: 11, color: "#b91c1c", lineHeight: 1.5,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {st.error.length > 160 ? `${st.error.slice(0, 160)}…` : st.error}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 失败汇总（如有）：说明发生了什么 + 下一步 */}
      {failed > 0 && (
        <div style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2" }}>
          <span style={{ fontSize: 12, color: "#dc2626" }}>
            {failed} 个任务失败，具体原因见上方列表。多数情况是 API Key 填错/无效：
            请到「模型设置」重新填写对应供应商的 Key 并点「验证 Key」，通过后重新提交。
          </span>
        </div>
      )}

      {/* 操作：全部终态提供「完成」，其余仅可关闭（后台继续） */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        {allDone ? (
          <Button type="primary" onClick={onClose}>完成</Button>
        ) : (
          <>
            <Text style={{ fontSize: 11, color: "var(--color-text-tertiary)", alignSelf: "center", marginRight: "auto" }}>
              关闭后仍在后台生成，完成后自动刷新列表
            </Text>
            <Button onClick={onClose}>关闭</Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 按钮组
// ---------------------------------------------------------------------------

function Actions({ onSubmit, onCancel, pending }: { onSubmit: () => void; onCancel: () => void; pending?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
      <Button onClick={onCancel}>取消</Button>
      <Button type="primary" loading={pending} onClick={onSubmit}>开始生成</Button>
    </div>
  );
}
