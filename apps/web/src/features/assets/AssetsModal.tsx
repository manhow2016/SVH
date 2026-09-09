import React, { useEffect, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Input, Select, Slider, Typography, message as antdMessage, Form } from "antd";
import {
  AppstoreOutlined,
  AudioOutlined,
  BoxPlotOutlined,
  FolderAddOutlined,
  FolderOutlined,
  PictureOutlined,
  UserOutlined,
  CloseOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import type { AssetType } from "../../types/api-types";
import { assetsApi } from "../../api/assets";
import type { FileEntry } from "../../types/api-types";
import { useIsMobile } from "../../hooks/use-is-mobile";

const { TextArea } = Input;
const { Text } = Typography;

// ---------------------------------------------------------------------------
// 资产类型信息
// ---------------------------------------------------------------------------

interface TypeInfo {
  type: AssetType;
  label: string;
  color: string;
  Icon: React.ComponentType;
  maxCount: number;
  defaultCount: number;
}

const TYPE_MAP: Record<string, TypeInfo> = {
  character: { type: "character", label: "角色", Icon: UserOutlined,       color: "#3b82f6", maxCount: 6,  defaultCount: 4 },
  scene:     { type: "scene",     label: "场景", Icon: PictureOutlined,    color: "#22c55e", maxCount: 6,  defaultCount: 4 },
  prop:      { type: "prop",      label: "道具", Icon: BoxPlotOutlined,    color: "#d97706", maxCount: 6,  defaultCount: 4 },
  voice:     { type: "voice",     label: "音色", Icon: AudioOutlined,      color: "#f43f5e", maxCount: 10, defaultCount: 3 },
};

const ALL_TYPES: TypeInfo[] = Object.values(TYPE_MAP);

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

const MODE_LIST: { mode: ModeType; icon: string; title: string; desc: string }[] = [
  { mode: "ai",         icon: "✨", title: "AI 生成",     desc: "根据文字描述生成" },
  { mode: "reference",  icon: "🖼️", title: "参考图生成",   desc: "根据参考图片生成" },
];

const MAX_REF = 5;

/** 安全计数的工具函数：list API 可能返回 undefined */
async function countEntries(path: string): Promise<number> {
  const result = await assetsApi.list(path);
  return (result ?? []).length;
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export interface AssetsModalProps { open: boolean; onClose: () => void; }

export function AssetsModal({ open, onClose }: AssetsModalProps) {
  const qc = useQueryClient();
  const isMobile = useIsMobile();

  const [folders, setFolders] = useState<FileEntry[]>([]);
  const [selFolder, setSelFolder] = useState("默认");
  const [counts, setCounts] = useState({ character: 0, scene: 0, prop: 0, voice: 0 });
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");

  /* 新建资产 Drawer */
  const [drawOpen, setDrawOpen] = useState(false);
  const [drawType, setDrawType] = useState<AssetType>("character");
  const [drawMode, setDrawMode] = useState<ModeType>("ai");

  // 加载文件夹
  useEffect(() => {
    if (!open) return;
    assetsApi.list().then(setFolders).catch(() => setFolders([]));
  }, [open]);

  // 加载计数
  const refreshCounts = useCallback((f: string) => {
    void Promise.all(ALL_TYPES.map(t => countEntries(`${f}/${t.type}`))).then(([c, s, p, v]) => {
      setCounts({ character: c ?? 0, scene: s ?? 0, prop: p ?? 0, voice: v ?? 0 });
    });
  }, []);

  useEffect(() => { refreshCounts(selFolder); }, [open, selFolder, refreshCounts]);

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

  // 删除文件夹
  const doDeleteFolder = async (n: string) => {
    try {
      await assetsApi.remove(n);
      antdMessage.success(`已删除「${n}」`);
      setFolders(p => p.filter(f => f.name !== n));
      if (selFolder === n) {
        const rest = folders.filter(f => f.name !== n);
        setSelFolder(rest[0]?.name ?? "");
      }
    } catch { antdMessage.error("删除失败"); }
  };

  // 打开新建资产 Drawer
  const openDrawer = (t: AssetType) => { setDrawType(t); setDrawMode("ai"); setDrawOpen(true); };
  const closeDrawer = useCallback(() => setDrawOpen(false), []);

  return (
    <>
      <Drawer open={open} onClose={onClose} width={isMobile ? "100%" : 960} height="100%" maskClosable={false} destroyOnHidden
        styles={{ body: { padding: 0 } }}>
        {/* ===== 头部 ===== */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 0" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <AppstoreOutlined style={{ fontSize: 16, color: "var(--color-primary)" }} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>我的资产</span>
          </span>
          <Button type="primary" icon={<FolderAddOutlined />} onClick={() => setFolderOpen(true)}>新建</Button>
        </div>

        {/* ===== 文件夹条 ===== */}
        <div style={{ margin: "12px 20px", padding: "8px 12px", background: "var(--color-surface-secondary)", borderRadius: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <FolderOutlined style={{ color: "var(--color-text-tertiary)", fontSize: 14 }} />
          {folders.map(f => {
            const active = f.name === selFolder;
            return (
              <button key={f.path} type="button" onClick={() => setSelFolder(f.name)}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400, color: active ? "var(--color-primary)" : "var(--color-text-primary)", background: active ? "var(--color-primary-bg, #e6f4ff)" : "transparent" }}>
                {f.name}
                {f.name !== "默认" && (
                  <span onClick={e => { e.stopPropagation(); doDeleteFolder(f.name); }}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", cursor: "pointer", color: "var(--color-text-tertiary)", fontSize: 10 }}>✕</span>
                )}
              </button>
            );
          })}
          {!folders.length && <Text style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>暂无资源文件夹</Text>}
        </div>

        {/* ===== 卡片网格 ===== */}
        <div style={{ padding: "0 20px 20px" }}>
          <TypeGrid counts={counts} onNew={openDrawer} />
        </div>
      </Drawer>

      {/* ===== 新建文件夹侧栏 ===== */}
      <Drawer open={folderOpen} onClose={() => setFolderOpen(false)} title="新建资源文件夹" width={400} placement="right">
        <Input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="如：古装短剧" onPressEnter={doCreateFolder} autoFocus />
        <Text style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 4, display: "block" }}>自动生成四个类型子目录</Text>
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={() => setFolderOpen(false)}>取消</Button>
          <Button type="primary" onClick={doCreateFolder}>创建</Button>
        </div>
      </Drawer>

      {/* ===== 新建资产侧栏 ===== */}
      <CreatorDrawer open={drawOpen} onClose={closeDrawer} type={drawType} mode={drawMode} onModeChange={setDrawMode}
        onSuccess={() => { refreshCounts(selFolder); }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 卡片网格
// ---------------------------------------------------------------------------

function TypeGrid({ counts, onNew }: { counts: { character: number; scene: number; prop: number; voice: number }; onNew: (t: AssetType) => void }) {
  const isMobile = useIsMobile();
  const cols = isMobile ? 2 : 4;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
      {ALL_TYPES.map(info => (
        <TypeCard key={info.label} info={info} count={counts[info.type]} onNew={() => onNew(info.type)} />
      ))}
    </div>
  );
}

function TypeCard({ info, count, onNew }: {
  info: TypeInfo; count: number; onNew: () => void;
}) {
  return (
    <div style={{ position: "relative", padding: "20px 16px 16px", borderRadius: 12, border: "1px solid var(--color-border)", background: "var(--color-surface)", transition: "transform 0.15s ease, box-shadow 0.15s ease" }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}>
      {/* 顶部色条 */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, borderRadius: "12px 12px 0 0", background: info.color }} />
      {/* 彩色图标区域 */}
      <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 10, background: `${info.color}15`, marginBottom: 12 }}>
        <span style={{ fontSize: 20, color: info.color }}><info.Icon /></span>
      </div>
      {/* 名称 + 计数 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 4 }}>{info.label}</div>
        <Text style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{count} 个资产</Text>
      </div>
      {/* 操作按钮 */}
      <div style={{ display: "flex", gap: 6 }}>
        <Button size="small" type="link" style={{ padding: "0 4px", fontSize: 12 }}>查看 →</Button>
        <Button size="small" type="link" onClick={onNew} style={{ padding: "0 4px", fontSize: 12 }}>+ 新建</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建资产侧栏 + 模式选择器
// ---------------------------------------------------------------------------

function CreatorDrawer({ open, onClose, type, mode, onModeChange, onSuccess }: {
  open: boolean; onClose: () => void; type: AssetType; mode?: ModeType;
  onModeChange?: (m: ModeType) => void; onSuccess: () => void;
}) {
  const isChar = type === "character";
  return (
    <Drawer open={open} onClose={onClose}
      title={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <CloseOutlined style={{ fontSize: 12, color: "var(--color-text-tertiary)" }} />
        新建{getLabel(type)}
      </span>}
      width={560} placement="right" maskClosable={false}>
      {isChar && !!onModeChange && <ModeSelector selected={mode!} onChange={onModeChange} />}
      {isChar && <CharacterForm mode={mode as ModeType} onSuccess={onSuccess} />}
      {!isChar && <SimpleCreator type={type} onSuccess={onSuccess} />}
    </Drawer>
  );
}

function getLabel(t: string): string {
  return { character: "角色", scene: "场景", prop: "道具", voice: "音色" }[t] ?? t;
}

function ModeSelector({ selected, onChange }: { selected: ModeType; onChange: (m: ModeType) => void }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-tertiary)", marginBottom: 8 }}>创建方式</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {MODE_LIST.map(m => (
          <button key={m.mode} type="button" onClick={() => onChange(m.mode)}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "16px 12px", borderRadius: 10,
              border: selected === m.mode ? "2px solid var(--color-primary)" : "1px solid var(--color-border)",
              background: selected === m.mode ? "var(--color-primary-bg, #e6f4ff)" : "var(--color-surface)", cursor: "pointer", transition: "all 0.15s", textAlign: "center" }}>
            <span style={{ fontSize: 20 }}>{m.icon}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{m.title}</span>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{m.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 角色表单（支持 AI / 参考图两种模式）
// ---------------------------------------------------------------------------

function CharacterForm({ mode, onSuccess }: { mode: ModeType; onSuccess: () => void }) {
  const [form] = Form.useForm();
  const [pending, setPending] = useState(false);
  const [refImgs, setRefImgs] = useState<{ dataUrl: string; name: string }[]>([]);

  const submit = async () => {
    try {
      const v = await form.validateFields();
      setPending(true);
      await assetsApi.generate({
        type: "character",
        mode: refImgs.length > 0 ? "reference" : "ai",
        name: v.name,
        style: v.style,
        description: v.description,
        referenceImages: refImgs.map(i => i.dataUrl),
        count: v.count ?? 4,
      });
      antdMessage.success("任务已提交，正在生成...");
    } catch (err) {
      antdMessage.error(err instanceof Error ? err.message : "生成失败，请稍后重试");
    } finally { setPending(false); }
    onSuccess();
  };

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

      <Actions onSubmit={submit} pending={pending} />
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
              style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer" }}>✕</button>
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

function SimpleCreator({ type, onSuccess }: { type: string; onSuccess: () => void }) {
  const [form] = Form.useForm();
  const [pending, setPending] = useState(false);

  // 从 TYPE_MAP 获取类型信息；确保 type 值有效
  const infoEntry = TYPE_MAP[type] as TypeInfo | undefined;
  const resolvedInfo = (infoEntry ? infoEntry : TYPE_MAP["scene"] as TypeInfo) as TypeInfo;

  const submit = async () => {
    try {
      const v = await form.validateFields();
      setPending(true);
      if (type === "voice") {
        await assetsApi.generate({ type: "voice", name: v.name, style: v.style, customDescription: v.customDescription, previewText: v.previewText, count: v.count });
      } else {
        await assetsApi.generate({ type: type as "scene" | "prop", name: v.name, style: v.style, description: v.description, summary: v.summary, imageDescription: v.imageDescription, count: v.count ?? 4 });
      }
      antdMessage.success("任务已提交，正在生成...");
    } catch (err) {
      antdMessage.error(err instanceof Error ? err.message : "生成失败，请稍后重试");
    } finally { setPending(false); }
    onSuccess();
  };

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

        <Actions onSubmit={submit} pending={pending} />
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

      <Actions onSubmit={submit} pending={pending} />
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
// 按钮组
// ---------------------------------------------------------------------------

function Actions({ onSubmit, pending }: { onSubmit: () => void; pending?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
      <Button onClick={() => {}}>取消</Button>
      <Button type="primary" loading={pending} onClick={onSubmit}>开始生成</Button>
    </div>
  );
}
