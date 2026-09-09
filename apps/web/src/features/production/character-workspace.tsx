/**
 * 角色工作台（角色页签重做，spec §五）。
 *
 * 交互闭环：角色切换器 → 生成形象方案批次 → 选主形象（referenceAssetId）→
 * 重新生成换批 → 配音音色三来源（已上传 / 资产库 / AI 智能设计）→ 试听 → 删除角色。
 *
 * 组件结构：
 *   CharacterWorkspacePanel（替换旧 CharactersPanel）
 *   ├─ CharacterSwitcher   顶部横向滚动角色标签 + 新建角色
 *   ├─ CharacterDetail     （key=characterId 切换即重置状态）
 *   │  ├─ CharacterHeader  主形象缩略 + 名称 + N个形象 + 导入/编辑/删除
 *   │  ├─ SchemeCard       形象方案（空态生成 / 方案网格选中 / 重新生成 + 任务追踪）
 *   │  └─ VoiceCard        配音音色（状态点 + 三来源弹窗 + 试听 + 更换）
 *   │     ├─ VoiceUploadModal   二进制上传（mp3/wav/m4a ≤50MB）
 *   │     ├─ VoiceLibraryModal  资产库 cascader（文件夹→类型→文件）
 *   │     └─ VoiceAIModal       AI 智能设计（试听文本 + VOICE_OPTS 风格 → TTS 任务）
 *   ├─ ImportImageModal    从资产中心导入（作为主形象）
 *   ├─ CreateCharacterModal 新建角色（沿用既有 createCharacter 表单字段）
 *   └─ EditCharacterModal   编辑角色（保留既有编辑弹窗 + 只读「当前音色」行）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Cascader,
  Empty,
  Form,
  Input,
  Modal,
  message,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Skeleton,
  Tag,
  Tooltip,
} from "antd";
import type { CascaderProps } from "antd";
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  ImportOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SwapOutlined,
  UploadOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { assetLibrarySrc, assetLocalSrc, productionApi } from "../../api/production";
import { assetsApi } from "../../api/assets";
import { useIsMobile } from "../../hooks/use-is-mobile";
import { VOICE_OPTS } from "../assets/AssetsPanel";
import type { Character, ProductionAsset } from "../../types/production-types";
import type { FileEntry } from "../../types/api-types";

// ---------------------------------------------------------------------------
// 任务追踪（复用 AssetsPanel 轮询模式：2.5s 轮询 getTask，终态驱动刷新）
// ---------------------------------------------------------------------------

interface TaskStatusInfo {
  status: string;
  progress?: number | null;
  error?: string | null;
}

function isTaskTerminal(status?: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * 任务批次追踪：登记 taskIds → 轮询状态缓存 → 全部终态时 allTerminal=true。
 * 不自动清空，由调用方在终态处理后 reset（或换角色时随组件 key 卸载）。
 */
function useTaskTracker() {
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TaskStatusInfo>>({});

  const track = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setTaskIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
    setStatuses((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = next[id] ?? { status: "queued" };
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setTaskIds([]);
    setStatuses({});
  }, []);

  useEffect(() => {
    if (taskIds.length === 0) return;
    let alive = true;
    const poll = async () => {
      const results = await Promise.all(
        taskIds.map((id) => productionApi.getTask(id).then((t) => ({ id, t })).catch(() => null)),
      );
      if (!alive) return;
      setStatuses((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r) next[r.id] = { status: r.t.status, progress: r.t.progress, error: r.t.error };
        }
        return next;
      });
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskIds]);

  const allTerminal =
    taskIds.length > 0 && taskIds.every((id) => isTaskTerminal(statuses[id]?.status));
  const active = taskIds.length > 0 && !allTerminal;

  return { taskIds, statuses, track, reset, allTerminal, active };
}

// ---------------------------------------------------------------------------
// 基础样式助手
// ---------------------------------------------------------------------------

function panelLoading() {
  return <Skeleton active paragraph={{ rows: 5 }} />;
}

function panelEmpty(title: string, description: string, action?: ReactNode) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{title}</span>
          <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", maxWidth: 320 }}>{description}</span>
        </div>
      }
    >
      {action}
    </Empty>
  );
}

/** 分区卡片（形象卡 / 音色卡共用容器） */
const SECTION_STYLE: CSSProperties = {
  borderRadius: 12,
  border: "1px solid var(--color-border)",
  background: "var(--color-surface)",
  padding: 16,
};

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function CharacterWorkspacePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);

  const { data: characters, isLoading, error } = useQuery({
    queryKey: ["production-characters", projectId],
    queryFn: () => productionApi.listCharacters(projectId),
  });

  // 默认选中第一个角色；列表变化（新建/删除）后校正
  const characterList = useMemo(() => characters ?? [], [characters]);
  useEffect(() => {
    if (characterList.length === 0) {
      setActiveCharacterId(null);
      return;
    }
    if (!characterList.some((c) => c.id === activeCharacterId)) {
      const first = characterList[0];
      if (first) setActiveCharacterId(first.id);
    }
  }, [characterList, activeCharacterId]);

  const active = characterList.find((c) => c.id === activeCharacterId) ?? null;

  // 全量资产：主形象缩略图 + 音色资产（名称/试听源）反查
  const { data: vaultAssets } = useQuery({
    queryKey: ["production-assets", projectId],
    queryFn: () => productionApi.listAssets(projectId),
    enabled: active != null,
  });
  const referenceAsset =
    active?.referenceAssetId != null
      ? (vaultAssets ?? []).find((a) => a.id === active.referenceAssetId) ?? null
      : null;
  const voiceAsset =
    active?.voiceAssetId != null
      ? (vaultAssets ?? []).find((a) => a.id === active.voiceAssetId) ?? null
      : null;

  const refetchCharacters = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: ["production-characters", projectId] });
  }, [queryClient, projectId]);
  const refetchAssets = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: ["production-assets", projectId] });
  }, [queryClient, projectId]);

  if (isLoading) return panelLoading();
  if (error) return <Alert type="error" message="角色加载失败" description={(error as Error)?.message} />;

  if (characterList.length === 0) {
    return (
      <div>
        {panelEmpty(
          "还没有角色",
          "让编剧 Agent 从剧本中抽取角色，或手动创建。",
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建角色
          </Button>,
        )}
        <CreateCharacterModal
          open={createOpen}
          projectId={projectId}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void refetchCharacters();
          }}
        />
      </div>
    );
  }

  const removeCharacter = (c: Character) => {
    Modal.confirm({
      title: `删除角色「${c.name}」？`,
      content: "将同时删除该角色的全部形象方案图片（含历史批次），删除后不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await productionApi.deleteCharacter(c.id);
        message.success("角色已删除");
        if (activeCharacterId === c.id) setActiveCharacterId(null);
        await refetchCharacters();
        await refetchAssets();
      },
    });
  };

  const editing = editingId != null ? characterList.find((c) => c.id === editingId) ?? null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <CharacterSwitcher
        characters={characterList}
        activeId={activeCharacterId}
        isMobile={isMobile}
        onSelect={setActiveCharacterId}
        onCreate={() => setCreateOpen(true)}
      />

      {active && (
        <CharacterDetail
          key={active.id}
          projectId={projectId}
          character={active}
          isMobile={isMobile}
          referenceAsset={referenceAsset}
          voiceAsset={voiceAsset}
          onImport={() => setImportOpen(true)}
          onEdit={() => setEditingId(active.id)}
          onDelete={() => removeCharacter(active)}
          onRefetch={() => {
            void refetchCharacters();
            void refetchAssets();
          }}
        />
      )}

      <CreateCharacterModal
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          void refetchCharacters();
        }}
      />
      <ImportImageModal
        open={importOpen}
        projectId={projectId}
        characterId={active?.id ?? ""}
        onClose={() => setImportOpen(false)}
        onDone={() => {
          void refetchCharacters();
          void refetchAssets();
        }}
      />
      {editing && (
        <EditCharacterModal
          open
          character={editing}
          referenceAssets={vaultAssets ?? []}
          voiceAsset={voiceAsset}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            void refetchCharacters();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 角色切换器（顶部横向滚动标签 + 新建角色）
// ---------------------------------------------------------------------------

function CharacterSwitcher({
  characters,
  activeId,
  isMobile,
  onSelect,
  onCreate,
}: {
  characters: Character[];
  activeId: string | null;
  isMobile: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        className="hide-scrollbar"
        style={{
          display: "flex",
          gap: 6,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          flex: 1,
          minWidth: 0,
        }}
      >
        {characters.map((c) => {
          const active = c.id === activeId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              style={{
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: isMobile ? 30 : 32,
                padding: "0 14px",
                borderRadius: 8,
                border: `1px solid ${active ? "var(--color-primary)" : "var(--color-border)"}`,
                background: active ? "var(--color-primary-bg, #e6f4ff)" : "var(--color-surface)",
                color: active ? "var(--color-primary)" : "var(--color-text-secondary)",
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "all 0.15s",
              }}
            >
              <UserOutlined style={{ fontSize: 12 }} />
              {c.name}
            </button>
          );
        })}
      </div>
      <Button size="small" icon={<PlusOutlined />} onClick={onCreate} style={{ flexShrink: 0 }}>
        新建角色
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 角色详情（key=characterId：切换角色即重置方案/音色页内状态）
// ---------------------------------------------------------------------------

function CharacterDetail({
  projectId,
  character,
  isMobile,
  referenceAsset,
  voiceAsset,
  onImport,
  onEdit,
  onDelete,
  onRefetch,
}: {
  projectId: string;
  character: Character;
  isMobile: boolean;
  referenceAsset: ProductionAsset | null;
  voiceAsset: ProductionAsset | null;
  onImport: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRefetch: () => Promise<void> | void;
}) {
  const queryClient = useQueryClient();
  const [voiceModal, setVoiceModal] = useState<"upload" | "library" | "ai" | null>(null);
  const closeVoiceModal = useCallback(() => setVoiceModal(null), []);

  const schemesQ = useQuery({
    queryKey: ["character-schemes", projectId, character.id],
    queryFn: () => productionApi.listCharacterSchemes(projectId, character.id),
  });

  const refetchSchemes = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: ["character-schemes", projectId, character.id] });
  }, [queryClient, projectId, character.id]);

  const saveVoice = useCallback(
    async (assetId: string, voiceTts?: string) => {
      await productionApi.updateCharacter(character.id, { voiceAssetId: assetId, voice: voiceTts });
      message.success("配音音色已更新");
      await onRefetch();
    },
    [character.id, onRefetch],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <CharacterHeader
        character={character}
        schemeCount={schemesQ.data?.schemes.length ?? 0}
        referenceAsset={referenceAsset}
        isMobile={isMobile}
        onImport={onImport}
        onEdit={onEdit}
        onDelete={onDelete}
      />

      <SchemeCard
        projectId={projectId}
        character={character}
        data={schemesQ.data}
        loading={schemesQ.isLoading}
        error={schemesQ.error}
        isMobile={isMobile}
        onRefetch={async () => {
          await refetchSchemes();
          await onRefetch();
        }}
      />

      <VoiceCard
        character={character}
        voiceAsset={voiceAsset}
        onPick={() => setVoiceModal("upload")}
        onLibrary={() => setVoiceModal("library")}
        onAI={() => setVoiceModal("ai")}
      />

      <VoiceUploadModal
        open={voiceModal === "upload"}
        projectId={projectId}
        onClose={closeVoiceModal}
        onSaved={saveVoice}
      />
      <VoiceLibraryModal
        open={voiceModal === "library"}
        projectId={projectId}
        onClose={closeVoiceModal}
        onSaved={saveVoice}
      />
      <VoiceAIModal
        open={voiceModal === "ai"}
        projectId={projectId}
        character={character}
        onClose={closeVoiceModal}
        onSaved={saveVoice}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 详情头：主形象缩略 + 名称 + N个形象 + 从资产中心导入 / 编辑 / 删除
// ---------------------------------------------------------------------------

function CharacterHeader({
  character,
  schemeCount,
  referenceAsset,
  isMobile,
  onImport,
  onEdit,
  onDelete,
}: {
  character: Character;
  schemeCount: number;
  referenceAsset: ProductionAsset | null;
  isMobile: boolean;
  onImport: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const avatarSrc = referenceAsset
    ? assetLocalSrc(referenceAsset) ?? assetLibrarySrc(referenceAsset) ?? referenceAsset.url
    : undefined;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
        padding: 14,
        borderRadius: 12,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--color-surface-secondary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: "var(--color-text-tertiary)",
        }}
      >
        {avatarSrc ? (
          <img
            src={avatarSrc}
            alt={character.name}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <UserOutlined style={{ fontSize: 20 }} />
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>
            {character.name}
          </span>
          <Tag style={{ marginInlineEnd: 0 }}>{schemeCount}个形象</Tag>
        </div>
        {character.description && (
          <div
            style={{
              marginTop: 3,
              fontSize: 12,
              color: "var(--color-text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: isMobile ? 200 : 480,
            }}
          >
            {character.description}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginLeft: "auto",
        }}
      >
        <Button size="small" icon={<ImportOutlined />} onClick={onImport}>
          从资产中心导入
        </Button>
        <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
          编辑角色
        </Button>
        <Button size="small" danger icon={<DeleteOutlined />} onClick={onDelete}>
          删除角色
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 形象方案卡（SchemeCard）
// ---------------------------------------------------------------------------

function SchemeCard({
  projectId,
  character,
  data,
  loading,
  error,
  isMobile,
  onRefetch,
}: {
  projectId: string;
  character: Character;
  data: { batchId: string | null; schemes: ProductionAsset[] } | undefined;
  loading: boolean;
  error: unknown;
  isMobile: boolean;
  onRefetch: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [count, setCount] = useState(3);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const tracker = useTaskTracker();
  // 终态批处理去重（statuses 更新会重复触发 allTerminal）
  const handledKeyRef = useRef<string | null>(null);

  const schemes = data?.schemes ?? [];
  const selectedId = character.referenceAssetId ?? null;
  const selectedInBatch = schemes.some((s) => s.id === selectedId);

  // 全部终态 → 刷新方案批次与资产、提示结果、清空追踪
  useEffect(() => {
    if (!tracker.allTerminal) return;
    const key = tracker.taskIds.join(",");
    if (handledKeyRef.current === key) return;
    handledKeyRef.current = key;
    const sts = tracker.taskIds.map((id) => tracker.statuses[id]);
    const ok = sts.filter((s) => s?.status === "completed").length;
    if (ok > 0) message.success(`形象方案生成完成（${ok}/${sts.length}）`);
    if (ok < sts.length) message.error("部分形象方案生成失败，可检查模型设置后重新生成");
    void queryClient.invalidateQueries({ queryKey: ["character-schemes", projectId, character.id] });
    void queryClient.invalidateQueries({ queryKey: ["production-assets", projectId] });
    tracker.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker.allTerminal]);

  const generate = async () => {
    if (submitting || tracker.active) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await productionApi.generateCharacterSchemes(projectId, character.id, count);
      tracker.track(res.taskIds);
    } catch (err) {
      setSubmitError((err as Error)?.message ?? "方案生成提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const selectScheme = async (scheme: ProductionAsset) => {
    if (scheme.id === selectedId || selectingId) return;
    setSelectingId(scheme.id);
    try {
      await productionApi.updateCharacter(character.id, { referenceAssetId: scheme.id });
      message.success("已设为主形象");
      await onRefetch();
    } catch (err) {
      message.error(`设置主形象失败：${(err as Error)?.message ?? "未知错误"}`);
    } finally {
      setSelectingId(null);
    }
  };

  return (
    <section style={SECTION_STYLE}>
      <SchemeCardHeader
        character={character}
        hasBatch={schemes.length > 0}
        selectedInBatch={selectedInBatch}
        isMobile={isMobile}
        count={count}
        onCountChange={setCount}
        onGenerate={() => void generate()}
        submitting={submitting}
        regenerating={tracker.active}
      />

      {tracker.active && (
        <SchemeTaskBar
          taskIds={tracker.taskIds}
          statuses={tracker.statuses}
          style={{ margin: "12px 0 0" }}
        />
      )}

      <div style={{ marginTop: 12 }}>
        {loading ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : error ? (
          <Alert type="error" showIcon message="形象方案加载失败" description={(error as Error)?.message} />
        ) : schemes.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
                  还没有形象
                </span>
                <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                  生成 1~6 张形象方案，选择一张作为主形象（用于一致性）
                </span>
              </div>
            }
          />
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(150px, 1fr))",
                gap: 10,
              }}
            >
              {schemes.map((s, i) => (
                <SchemeTile
                  key={s.id}
                  scheme={s}
                  index={i}
                  selected={s.id === selectedId}
                  busy={selectingId === s.id}
                  disabled={selectingId != null}
                  onSelect={() => void selectScheme(s)}
                />
              ))}
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "var(--color-text-tertiary)",
                textAlign: "center",
              }}
            >
              {selectedInBatch ? (
                <>已选择主形象，可重新生成或更换方案</>
              ) : (
                <>请选择一张图片；选择并确认后，可对图片进行编辑和修改</>
              )}
            </div>
          </>
        )}
      </div>

      {submitError && (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message="形象方案提交失败"
          description={submitError}
        />
      )}
    </section>
  );
}

/** 形象卡标签行 + 数量选择 + 生成/重新生成 */
function SchemeCardHeader({
  character,
  hasBatch,
  selectedInBatch,
  isMobile,
  count,
  onCountChange,
  onGenerate,
  submitting,
  regenerating,
}: {
  character: Character;
  hasBatch: boolean;
  selectedInBatch: boolean;
  isMobile: boolean;
  count: number;
  onCountChange: (n: number) => void;
  onGenerate: () => void;
  submitting: boolean;
  regenerating: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
        形象方案
      </span>
      {hasBatch && (
        <Tag style={{ marginInlineEnd: 0 }} color="default">
          初始形象
        </Tag>
      )}
      {hasBatch && selectedInBatch && (
        <Tag style={{ marginInlineEnd: 0 }} color="#2e9e62">
          主形象
        </Tag>
      )}
      {hasBatch && !selectedInBatch && character.referenceAssetId && (
        <Tag style={{ marginInlineEnd: 0 }} color="default">
          导入形象
        </Tag>
      )}
      {hasBatch && !selectedInBatch && !character.referenceAssetId && (
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>请选择一张图片</span>
      )}
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>数量</span>
      <Select
        size="small"
        value={count}
        onChange={(v: number) => onCountChange(v)}
        options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `${n}张` }))}
        popupMatchSelectWidth={false}
        style={{ width: 72 }}
        disabled={regenerating}
      />
      {hasBatch ? (
        <Popconfirm
          title="重新生成形象方案？"
          description="将生成新一批方案并替换当前展示（旧批次保留但不展示）。"
          okText="生成"
          cancelText="取消"
          disabled={regenerating}
          onConfirm={onGenerate}
        >
          <Button
            size="small"
            type="primary"
            icon={<ReloadOutlined />}
            loading={submitting}
            disabled={regenerating}
            style={{ marginLeft: isMobile ? 0 : undefined }}
          >
            重新生成
          </Button>
        </Popconfirm>
      ) : (
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          loading={submitting}
          disabled={regenerating}
          onClick={onGenerate}
        >
          生成形象
        </Button>
      )}
    </div>
  );
}

/** 单张方案缩略卡：右下 方案n + 右上 ✓（选中） */
function SchemeTile({
  scheme,
  index,
  selected,
  busy,
  disabled,
  onSelect,
}: {
  scheme: ProductionAsset;
  index: number;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const primary = assetLocalSrc(scheme) ?? assetLibrarySrc(scheme) ?? scheme.url;
  const [src, setSrc] = useState<string | undefined>(primary);
  useEffect(() => {
    setSrc(primary);
  }, [primary]);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      style={{
        position: "relative",
        aspectRatio: "3/4",
        borderRadius: 8,
        border: selected ? "2px solid #2e9e62" : "1px solid var(--color-border)",
        background: "var(--color-surface-secondary)",
        overflow: "hidden",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        transition: "all 0.15s",
      }}
    >
      {src ? (
        <img
          src={src}
          alt={`方案${index + 1}`}
          onError={() => {
            if (scheme.url && src !== scheme.url) setSrc(scheme.url);
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <span
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-text-tertiary)",
          }}
        >
          <PictureOutlined style={{ fontSize: 22 }} />
        </span>
      )}
      <span
        style={{
          position: "absolute",
          left: 6,
          bottom: 6,
          fontSize: 11,
          fontWeight: 600,
          padding: "2px 8px",
          borderRadius: 6,
          background: "rgba(15, 23, 42, 0.62)",
          color: "#fff",
          lineHeight: "16px",
        }}
      >
        方案{index + 1}
      </span>
      {selected && (
        <span
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "#2e9e62",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 1px 4px rgba(0, 0, 0, 0.25)",
          }}
        >
          <CheckOutlined style={{ fontSize: 12 }} />
        </span>
      )}
      {busy && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255, 255, 255, 0.55)",
            color: "var(--color-primary)",
            fontSize: 12,
          }}
        >
          设置中…
        </span>
      )}
    </button>
  );
}

/** 状态徽标元信息（任务追踪行；与 AssetsPanel TaskStatusList 同款） */
const SCHEME_TASK_META: Record<string, { label: string; color: string; bg: string }> = {
  queued: { label: "排队中", color: "#64748b", bg: "#f1f5f9" },
  running: { label: "生成中", color: "var(--color-primary)", bg: "var(--color-primary-bg, #e6f4ff)" },
  completed: { label: "已完成", color: "#16a34a", bg: "#eaf7ee" },
  failed: { label: "失败", color: "#dc2626", bg: "#fdecec" },
  cancelled: { label: "已取消", color: "#64748b", bg: "#f1f5f9" },
};

/** 方案生成任务追踪条（状态徽标 + 真实失败原因） */
function SchemeTaskBar({
  taskIds,
  statuses,
  style,
}: {
  taskIds: string[];
  statuses: Record<string, TaskStatusInfo>;
  style?: CSSProperties;
}) {
  const total = taskIds.length;
  const done = taskIds.filter((id) => isTaskTerminal(statuses[id]?.status)).length;
  const failed = taskIds.filter((id) => statuses[id]?.status === "failed").length;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-secondary)",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)" }}>
          形象方案生成中
        </span>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {failed > 0 ? `完成 ${done - failed} / ${total}，失败 ${failed}` : `已完成 ${done} / ${total}`}
        </span>
        <Progress
          style={{ flex: 1, minWidth: 120, margin: 0 }}
          percent={total > 0 ? Math.round((done / total) * 100) : 0}
          status="active"
          size="small"
        />
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
          完成后自动刷新方案
        </span>
      </div>
      {/* 任务行：方案n + 状态徽标（running 附进度）+ 失败原因截断展示（hover 全文） */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {taskIds.map((id, i) => {
          const st = statuses[id];
          const meta = SCHEME_TASK_META[st?.status ?? ""] ?? SCHEME_TASK_META.queued!;
          return (
            <div
              key={id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
                padding: "5px 8px",
                borderRadius: 6,
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: "var(--color-text-primary)",
                  flexShrink: 0,
                }}
              >
                方案{i + 1}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11,
                  fontWeight: 600,
                  color: meta.color,
                  background: meta.bg,
                  padding: "2px 8px",
                  borderRadius: 8,
                }}
              >
                {meta.label}
                {st?.status === "running" && typeof st.progress === "number" ? ` ${st.progress}%` : ""}
              </span>
              {st?.status === "failed" && st.error ? (
                <Tooltip title={st.error}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11,
                      color: "#b91c1c",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {st.error.length > 160 ? `${st.error.slice(0, 160)}…` : st.error}
                  </span>
                </Tooltip>
              ) : null}
            </div>
          );
        })}
      </div>
      {failed > 0 && (
        <div style={{ fontSize: 11, color: "#dc2626" }}>
          {failed} 个任务失败，具体原因见上方列表。多数情况是 API Key 填错/无效：请到「模型设置」检查对应供应商的 Key 后重新生成。
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 配音音色卡（VoiceCard）
// ---------------------------------------------------------------------------

const VOICE_MIMES = ["audio/mpeg", "audio/wav", "audio/mp4"] as const;
const VOICE_EXT_RE = /\.(mp3|wav|m4a)$/i;

function VoiceCard({
  character,
  voiceAsset,
  onPick,
  onLibrary,
  onAI,
}: {
  character: Character;
  voiceAsset: ProductionAsset | null;
  onPick: () => void;
  onLibrary: () => void;
  onAI: () => void;
}) {
  const hasVoice = character.voiceAssetId != null;
  const [choosing, setChoosing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const src = voiceAsset
    ? assetLocalSrc(voiceAsset) ?? assetLibrarySrc(voiceAsset) ?? voiceAsset.url
    : undefined;
  const canPlay = Boolean(src);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el || !src) return;
    if (playing) {
      el.pause();
    } else {
      void el
        .play()
        .then(() => setPlaying(true))
        .catch(() => {
          message.error("播放失败：音频源不可用");
          setPlaying(false);
        });
    }
  };

  const voiceName = voiceAsset?.name ?? (character.voice ? `TTS · ${character.voice}` : "未设置");

  return (
    <section style={SECTION_STYLE}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: hasVoice ? "#2e9e62" : "var(--color-text-tertiary)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>配音音色</span>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          {hasVoice ? voiceName : "尚未设置"}
        </span>
        <div style={{ flex: 1 }} />
        {hasVoice && (
          <Button
            size="small"
            icon={<SwapOutlined />}
            onClick={() => setChoosing((v) => !v)}
            style={{ marginLeft: "auto" }}
          >
            更换
          </Button>
        )}
      </div>

      {hasVoice ? (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button
            size="small"
            type={playing ? "default" : "primary"}
            icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            disabled={!canPlay}
            onClick={togglePlay}
          >
            {playing ? "暂停" : "试听音色"}
          </Button>
          {!canPlay && (
            <Tooltip title="该音色没有可用音频源（未本地化且无远程地址），试听不可用">
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>无可用音频源</span>
            </Tooltip>
          )}
          {(choosing || !voiceAsset) && (
            <SourceButtons onPick={onPick} onLibrary={onLibrary} onAI={onAI} />
          )}
          {voiceAsset && !choosing && (
            <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
              来源：{voiceAsset.generation?.taskId ? "AI 智能设计" : voiceAsset.metadata?.libraryPath ? "资产库" : "已上传"}
            </span>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <SourceButtons onPick={onPick} onLibrary={onLibrary} onAI={onAI} />
        </div>
      )}

      <audio
        ref={audioRef}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        style={{ display: "none" }}
      />
    </section>
  );
}

/** 音色三来源按钮组（空态显示；已选时由「更换」展开） */
function SourceButtons({
  onPick,
  onLibrary,
  onAI,
}: {
  onPick: () => void;
  onLibrary: () => void;
  onAI: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Button size="small" icon={<UploadOutlined />} onClick={onPick}>
        已上传
      </Button>
      <Button size="small" icon={<FolderOutlined />} onClick={onLibrary}>
        资产库
      </Button>
      <Button size="small" icon={<RocketOutlined />} onClick={onAI}>
        AI智能设计
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 音色三来源弹窗
// ---------------------------------------------------------------------------

/** 资产库级联选择（文件夹→类型→文件；与 panels.tsx 既有模式一致） */
function useLibraryPicker() {
  const [options, setOptions] = useState<NonNullable<CascaderProps["options"]>>([]);
  const [path, setPath] = useState<string | undefined>();

  useEffect(() => {
    assetsApi
      .list()
      .then((fs) =>
        setOptions(
          ((fs ?? []) as FileEntry[])
            .filter((f) => f.type === "directory")
            .map((f) => ({
              value: f.name,
              label: f.name === "默认" ? "全部资产" : f.name,
              isLeaf: false,
            })),
        ),
      )
      .catch(() => setOptions([]));
  }, []);

  const loadData: CascaderProps["loadData"] = async (selectedOptions) => {
    const target = selectedOptions[selectedOptions.length - 1];
    if (!target) return;
    if (selectedOptions.length === 1) {
      // 选文件夹 → 类型层（固定 4 类；值形如 "文件夹/类型"）
      const folder = String(target.value);
      target.children = ["角色", "场景", "道具", "音色"].map((t) => ({
        value: `${folder}/${t}`,
        label: t,
        isLeaf: false,
      }));
    } else if (selectedOptions.length === 2) {
      // 选类型 → 文件层
      const dir = String(target.value);
      const files = (await assetsApi.list(dir).catch(() => [])) ?? [];
      target.children = files
        .filter((f) => f.type !== "directory")
        .map((f) => ({ value: `${dir}/${f.name}`, label: f.name, isLeaf: true }));
    }
    setOptions((prev) => [...prev]);
  };

  const onChange: CascaderProps["onChange"] = (v) => {
    setPath(Array.isArray(v) && v.length > 0 ? String(v[v.length - 1]) : undefined);
  };

  const reset = useCallback(() => setPath(undefined), []);

  return {
    options,
    loadData,
    value: path ? path.split("/") : undefined,
    onChange,
    path,
    reset,
  };
}

/** 音色：已上传（mp3/wav/m4a ≤50MB → uploadAudioAsset → 设为角色音色） */
function VoiceUploadModal({
  open,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onSaved: (assetId: string) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setError(null);
  };

  const handleFile = (f: File | null) => {
    setFile(f);
    setError(null);
  };

  const submit = async () => {
    if (!file) {
      setError("请选择音频文件（mp3 / wav / m4a）");
      return;
    }
    if (!VOICE_MIMES.includes(file.type as (typeof VOICE_MIMES)[number]) && !VOICE_EXT_RE.test(file.name)) {
      setError("仅支持 mp3 / wav / m4a 音频文件");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError("文件超过 50MB 上限");
      return;
    }
    const mime = VOICE_MIMES.includes(file.type as (typeof VOICE_MIMES)[number])
      ? file.type
      : file.name.toLowerCase().endsWith(".wav")
        ? "audio/wav"
        : file.name.toLowerCase().endsWith(".m4a")
          ? "audio/mp4"
          : "audio/mpeg";
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const blob = new Blob([bytes], { type: mime });
      const { asset } = await productionApi.uploadAudioAsset(projectId, {
        name: file.name,
        mimeType: mime,
        data: blob,
      });
      await onSaved(asset.id);
      reset();
      onClose();
    } catch (err) {
      setError(`上传失败：${(err as Error)?.message ?? "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="上传配音音色"
      width={Math.min(560, window.innerWidth - 24)}
      okText="上传并设为音色"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => {
        reset();
        onClose();
      }}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          type="file"
          accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          style={{ fontSize: 13 }}
        />
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          支持 mp3 / wav / m4a，单个文件不超过 50MB；上传后立即设为该角色音色。
        </div>
        {error && <Alert type="error" showIcon message={error} />}
      </div>
    </Modal>
  );
}

/** 音色：资产库（cascader 选文件 → createAsset(type=audio) → 设为角色音色） */
function VoiceLibraryModal({
  open,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onSaved: (assetId: string) => Promise<void>;
}) {
  const picker = useLibraryPicker();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    picker.reset();
    setError(null);
  };

  const submit = async () => {
    if (!picker.path || picker.path.split("/").length < 3) {
      setError("请从资产库中选择具体音频文件");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const name = picker.path.split("/").pop() ?? picker.path;
      const asset = await productionApi.createAsset(projectId, {
        type: "audio",
        name,
        assetLibPath: picker.path,
      });
      await onSaved(asset.id);
      reset();
      onClose();
    } catch (err) {
      setError(`导入失败：${(err as Error)?.message ?? "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="从资产库选择音色"
      width={Math.min(560, window.innerWidth - 24)}
      okText="选用"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => {
        reset();
        onClose();
      }}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Cascader
          options={picker.options}
          loadData={picker.loadData}
          value={picker.value}
          onChange={picker.onChange}
          placeholder="文件夹 / 类型 / 文件"
          style={{ width: "100%" }}
          expandTrigger="hover"
          displayRender={(labels) => labels.join(" / ")}
        />
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          从「我的资产库」选择音频文件，导入为项目音色资产并设为该角色音色。
        </div>
        {error && <Alert type="error" showIcon message={error} />}
      </div>
    </Modal>
  );
}

/** 音色：AI 智能设计（文本 + VOICE_OPTS 风格 → TTS 任务 → 完成后按 generation.taskId 反查产物） */
function VoiceAIModal({
  open,
  projectId,
  character,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  character: Character;
  onClose: () => void;
  onSaved: (assetId: string, voiceTts?: string) => Promise<void>;
}) {
  const [text, setText] = useState(() => character.description || "大家好，欢迎来到今天的故事。");
  const [voice, setVoice] = useState<string>(VOICE_OPTS[0]?.value ?? "");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 解析并发守卫：用 ref 而非 state，避免 resolving 进入依赖导致自驱动重渲染循环
  const resolvingRef = useRef(false);
  // 已尝试解析的任务 id：effect 先判重，保证每个任务的「completed 翻转」只解析一次
  // （同时阻断重开弹窗时旧任务已完成 → 自动解析/自动保存）
  const resolvedTaskIdRef = useRef<string | null>(null);
  // 提交生成时锁定的风格：解析保存使用本次生成实际使用的 voice，而非解析瞬间的选中值
  const taskVoiceRef = useRef(voice);

  const { data: task } = useQuery({
    queryKey: ["generation-task", projectId, taskId],
    queryFn: () => productionApi.getTask(taskId as string),
    enabled: taskId != null && open,
    // 未终态每 2.5s 轮询；终态停止
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return isTaskTerminal(status) ? false : 2500;
    },
  });

  const reset = useCallback(() => {
    setTaskId(null);
    setError(null);
  }, []);

  const resolveResult = useCallback(
    async (id: string) => {
      if (resolvingRef.current) return;
      // 同步标记：无论成功或失败，本轮任务只解析一次；
      // 失败重试 = 重新生成新任务（新 taskId 走新一轮解析）
      resolvedTaskIdRef.current = id;
      resolvingRef.current = true;
      setResolving(true);
      try {
        const assets = await productionApi.listAssets(projectId, "audio");
        const found = assets.find((a) => a.generation?.taskId === id);
        if (found) {
          await onSaved(found.id, taskVoiceRef.current);
          reset(); // 清空 taskId：重开弹窗不会带着已完成任务再次自动解析
          onClose();
        } else {
          message.warning("生成完成但未取到音频，请重新生成");
        }
      } catch (err) {
        message.error(`获取生成结果失败：${(err as Error)?.message ?? "未知错误"}`);
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [projectId, onSaved, onClose, reset],
  );

  // 任务完成 → 反查产物资产并设为音色；resolvedTaskIdRef 判重保证只执行一次
  useEffect(() => {
    if (taskId == null || task?.status !== "completed") return;
    if (resolvedTaskIdRef.current === taskId) return;
    void resolveResult(taskId);
  }, [taskId, task?.status, resolveResult]);

  const submit = async () => {
    if (busy || (task?.status === "queued" || task?.status === "running")) return;
    if (!text.trim()) {
      setError("请输入试听文本");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { task: t } = await productionApi.generateAudio(projectId, {
        prompt: text.trim(),
        voice: voice || undefined,
      });
      // 记录本次任务实际使用的风格，供解析完成后回填 TTS 名
      taskVoiceRef.current = voice;
      setTaskId(t.id);
    } catch (err) {
      setError(`生成提交失败：${(err as Error)?.message ?? "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="AI 智能设计音色"
      width={Math.min(560, window.innerWidth - 24)}
      okText="生成并试听"
      cancelText="取消"
      confirmLoading={busy || resolving}
      okButtonProps={{ disabled: task != null && !isTaskTerminal(task.status) }}
      onOk={() => void submit()}
      onCancel={() => {
        reset();
        onClose();
      }}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)" }}>试听文本</div>
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="输入要试听的台词/旁白文本"
        />
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)" }}>风格</div>
        <Radio.Group
          value={voice}
          onChange={(e) => setVoice(e.target.value as string)}
          options={VOICE_OPTS}
          optionType="button"
          buttonStyle="solid"
          size="small"
        />
        {task &&
          (task.status === "failed" || task.status === "cancelled") && (
            <Alert
              type="error"
              showIcon
              message={task.status === "failed" ? "音色生成失败" : "任务已取消"}
              description={
                <>
                  {task.error ?? "无详细错误信息"}
                  <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                    请到「模型设置」检查音频模型 API Key 后重新生成。
                  </div>
                </>
              }
            />
          )}
        {task && !isTaskTerminal(task.status) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              background: "var(--color-surface-secondary)",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
              {task.status === "queued" ? "排队中" : "生成中"}
            </span>
            <Progress
              style={{ flex: 1, margin: 0 }}
              percent={task.progress ?? 0}
              status="active"
              size="small"
            />
            <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
              完成后自动设为音色
            </span>
          </div>
        )}
        {error && <Alert type="error" showIcon message={error} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 从资产中心导入（作为主形象）
// ---------------------------------------------------------------------------

function ImportImageModal({
  open,
  projectId,
  characterId,
  onClose,
  onDone,
}: {
  open: boolean;
  projectId: string;
  characterId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const picker = useLibraryPicker();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    picker.reset();
    setError(null);
  };

  const submit = async () => {
    if (!picker.path || picker.path.split("/").length < 3) {
      setError("请从资产库中选择具体图片文件");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const name = picker.path.split("/").pop() ?? picker.path;
      const asset = await productionApi.createAsset(projectId, {
        type: "image",
        name,
        assetLibPath: picker.path,
      });
      await productionApi.updateCharacter(characterId, { referenceAssetId: asset.id });
      message.success("已导入并设为主形象");
      reset();
      onClose();
      onDone();
    } catch (err) {
      setError(`导入失败：${(err as Error)?.message ?? "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="从资产中心导入"
      width={Math.min(560, window.innerWidth - 24)}
      okText="导入并设为主形象"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => {
        reset();
        onClose();
      }}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Cascader
          options={picker.options}
          loadData={picker.loadData}
          value={picker.value}
          onChange={picker.onChange}
          placeholder="文件夹 / 类型 / 文件"
          style={{ width: "100%" }}
          expandTrigger="hover"
          displayRender={(labels) => labels.join(" / ")}
        />
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          从「资产中心」选择任意图片，将其设为该角色的主形象（不生成新方案）。
        </div>
        {error && <Alert type="error" showIcon message={error} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 新建 / 编辑角色（沿用既有表单；编辑另含只读「当前音色」行）
// ---------------------------------------------------------------------------

const APPEARANCE_FIELDS = (
  <>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
      <Form.Item label="性别" name="gender">
        <Input maxLength={50} />
      </Form.Item>
      <Form.Item label="年龄" name="age">
        <Input maxLength={50} />
      </Form.Item>
      <Form.Item label="发型" name="hairstyle">
        <Input maxLength={50} />
      </Form.Item>
      <Form.Item label="服装" name="clothing">
        <Input maxLength={50} />
      </Form.Item>
    </div>
    <Form.Item label="配音音色" name="voice">
      <Input maxLength={100} placeholder="TTS voice 名（可留空用默认）" />
    </Form.Item>
  </>
);

function CreateCharacterModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form] = Form.useForm();

  return (
    <Modal
      open={open}
      title="新建角色"
      width={Math.min(560, window.innerWidth - 24)}
      okText="创建"
      cancelText="取消"
      onOk={async () => {
        const values = await form.validateFields();
        await productionApi.createCharacter(projectId, {
          name: values.name,
          description: values.description,
          personality: values.personality,
          appearance: {
            gender: values.gender,
            age: values.age,
            hairstyle: values.hairstyle,
            clothing: values.clothing,
          },
          voice: values.voice,
        });
        message.success("角色已创建");
        onClose();
        form.resetFields();
        onCreated();
      }}
      onCancel={() => {
        onClose();
        form.resetFields();
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item label="角色名" name="name" rules={[{ required: true, message: "请输入角色名" }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item label="角色描述" name="description" rules={[{ required: true, message: "请输入描述" }]}>
          <Input.TextArea rows={3} maxLength={2000} placeholder="身份、性格、作用" />
        </Form.Item>
        <Form.Item label="性格特点" name="personality">
          <Input maxLength={500} />
        </Form.Item>
        {APPEARANCE_FIELDS}
      </Form>
    </Modal>
  );
}

function EditCharacterModal({
  open,
  character,
  referenceAssets,
  voiceAsset,
  onClose,
  onSaved,
}: {
  open: boolean;
  character: Character;
  referenceAssets: ProductionAsset[];
  voiceAsset: ProductionAsset | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const currentVoiceLabel = voiceAsset
    ? voiceAsset.name
    : character.voice
      ? `TTS · ${character.voice}`
      : "未设置";

  return (
    <Modal
      open={open}
      title="编辑角色"
      width={Math.min(560, window.innerWidth - 24)}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
          await productionApi.updateCharacter(character.id, {
            name: values.name,
            description: values.description,
            personality: values.personality,
            appearance: {
              gender: values.gender,
              age: values.age,
              hairstyle: values.hairstyle,
              clothing: values.clothing,
            },
            referenceAssetId: values.referenceAssetId,
            voice: values.voice,
            visualProfile: {
              appearancePrompt: values.appearancePrompt,
              identityPrompt: values.identityPrompt,
              costumePrompt: values.costumePrompt,
              stylePrompt: values.stylePrompt,
              negativePrompt: values.negativePrompt,
            },
          });
          message.success("角色已保存");
          onClose();
          onSaved();
        } catch (err) {
          message.error(`保存失败：${(err as Error)?.message ?? "未知错误"}`);
        } finally {
          setSaving(false);
        }
      }}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: character.name,
          description: character.description,
          personality: character.personality,
          gender: character.appearance.gender,
          age: character.appearance.age,
          hairstyle: character.appearance.hairstyle,
          clothing: character.appearance.clothing,
          referenceAssetId: character.referenceAssetId,
          voice: character.voice,
          appearancePrompt: character.visualProfile?.appearancePrompt,
          identityPrompt: character.visualProfile?.identityPrompt,
          costumePrompt: character.visualProfile?.costumePrompt,
          stylePrompt: character.visualProfile?.stylePrompt,
          negativePrompt: character.visualProfile?.negativePrompt,
        }}
      >
        <Form.Item label="角色名" name="name" rules={[{ required: true, message: "请输入角色名" }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item label="角色描述" name="description" rules={[{ required: true, message: "请输入描述" }]}>
          <Input.TextArea rows={3} maxLength={2000} />
        </Form.Item>
        <Form.Item label="性格特点" name="personality">
          <Input maxLength={500} />
        </Form.Item>
        {APPEARANCE_FIELDS}
        <div
          style={{
            marginBottom: 16,
            padding: "8px 10px",
            borderRadius: 6,
            background: "var(--color-surface-secondary)",
            fontSize: 12,
            color: "var(--color-text-secondary)",
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>当前音色：</span>
          <span>{currentVoiceLabel}</span>
          <span style={{ color: "var(--color-text-tertiary)" }}>（试听与更换请到角色页签的音色卡）</span>
        </div>
        <Form.Item label="参考资产" name="referenceAssetId">
          <Select
            allowClear
            placeholder="选择角色参考图（一致性）"
            options={referenceAssets.map((a) => ({ value: a.id, label: a.name }))}
          />
        </Form.Item>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 8 }}>
          视觉档案（注入一致性的 Prompt）
        </div>
        <Form.Item label="外观 Prompt" name="appearancePrompt">
          <Input.TextArea rows={2} maxLength={2000} placeholder="角色外貌描述" />
        </Form.Item>
        <Form.Item label="身份 Prompt" name="identityPrompt">
          <Input.TextArea rows={2} maxLength={2000} placeholder="角色身份/设定" />
        </Form.Item>
        <Form.Item label="服装 Prompt" name="costumePrompt">
          <Input.TextArea rows={2} maxLength={2000} placeholder="服装/造型" />
        </Form.Item>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
          <Form.Item label="风格 Prompt" name="stylePrompt">
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item label="Negative Prompt" name="negativePrompt">
            <Input maxLength={2000} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
