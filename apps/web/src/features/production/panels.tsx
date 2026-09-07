/**
 * 生产项目详情面板：脚本 / 角色 / 场景 / 分镜 / 资产（V0.2 文档 §18 / §19）。
 *
 * 数据展示 + 创建/更新（Agent 是主要写入方，页面以查看与轻量操作为主）。
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Skeleton,
  Tag,
} from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { productionApi } from "../../api/production";
import { settingsApi } from "../../api/settings";
import type {
  AssetType,
  Character,
  ProductionAsset,
  ProductionGenerationTask,
  ProductionScene,
  ProductionScript,
  ProductionShot,
  Storyboard,
} from "../../types/production-types";

export interface PanelProps {
  projectId: string;
}

const SCRIPT_STATUS: Record<string, { text: string; color: string }> = {
  draft: { text: "草稿", color: "default" },
  reviewing: { text: "审核中", color: "#3b6fe0" },
  approved: { text: "已通过", color: "#2e9e62" },
};

const SHOT_STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: "待生成", color: "default" },
  generating: { text: "生成中", color: "#3b6fe0" },
  ready: { text: "已就绪", color: "#2e9e62" },
  failed: { text: "失败", color: "#d64545" },
};

function panelLoading() {
  return <Skeleton active paragraph={{ rows: 5 }} />;
}

function panelEmpty(title: string, description: string, action?: React.ReactNode) {
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

// ================= 剧本 =================

export function ScriptsPanel({ projectId }: PanelProps) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const { data: scripts, isLoading, error } = useQuery({
    queryKey: ["production-scripts", projectId],
    queryFn: () => productionApi.listScripts(projectId),
  });

  const selected = scripts?.find((s) => s.id === selectedId) ?? null;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["production-scripts", projectId] });
  };

  if (isLoading) return panelLoading();
  if (error) return <Alert type="error" message="剧本加载失败" description={(error as Error)?.message} />;
  if (!scripts || scripts.length === 0) {
    return panelEmpty(
      "还没有剧本",
      "在对话中让编剧 Agent 根据故事生成剧本，或手动新建。",
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
        新建剧本
      </Button>,
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
          共 {scripts.length} 个版本，内容变更后版本号自动 +1
        </span>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建剧本
        </Button>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div
          style={{
            width: 220,
            flexShrink: 0,
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            overflow: "hidden",
          }}
        >
          {scripts.map((script) => {
            const st = SCRIPT_STATUS[script.status] ?? { text: script.status, color: "default" };
            const active = script.id === selectedId;
            return (
              <div
                key={script.id}
                onClick={() => setSelectedId(script.id)}
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--color-border)",
                  cursor: "pointer",
                  background: active ? "#e8effd" : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--color-text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {script.title}
                  </span>
                  <Tag style={{ marginInlineEnd: 0, marginLeft: "auto" }} color={st.color}>
                    {st.text}
                  </Tag>
                </div>
                <div style={{ marginTop: 2, fontSize: 12, color: "var(--color-text-tertiary)" }}>
                  v{script.version} · {new Date(script.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 280,
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            padding: 16,
          }}
        >
          {selected ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{selected.title}</span>
                <Tag color={(SCRIPT_STATUS[selected.status] ?? {}).color}>v{selected.version}</Tag>
                <div style={{ flex: 1 }} />
                {selected.status === "draft" && (
                  <Button
                    size="small"
                    onClick={async () => {
                      await productionApi.updateScript(selected.id, { status: "reviewing" });
                      await refresh();
                    }}
                  >
                    提交审核
                  </Button>
                )}
                {selected.status === "reviewing" && (
                  <Button
                    size="small"
                    type="primary"
                    onClick={async () => {
                      await productionApi.updateScript(selected.id, { status: "approved" });
                      await refresh();
                    }}
                  >
                    通过审核
                  </Button>
                )}
                {selected.status === "approved" && (
                  <Button
                    size="small"
                    onClick={async () => {
                      await productionApi.updateScript(selected.id, { status: "draft" });
                      await refresh();
                    }}
                  >
                    退回草稿
                  </Button>
                )}
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  borderRadius: 6,
                  background: "var(--color-surface-secondary)",
                  fontSize: 13,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 520,
                  overflow: "auto",
                }}
              >
                {selected.content || "（空）"}
              </pre>
            </>
          ) : (
            <div style={{ color: "var(--color-text-tertiary)", fontSize: 13, padding: 24, textAlign: "center" }}>
              从左侧选择一个剧本查看内容
            </div>
          )}
        </div>
      </div>

      <Modal
        open={createOpen}
        title="新建剧本"
        width={560}
        okText="创建"
        cancelText="取消"
        onOk={async () => {
          const values = await form.validateFields();
          await productionApi.createScript(projectId, {
            title: values.title,
            content: values.content,
          });
          setCreateOpen(false);
          form.resetFields();
          await refresh();
        }}
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="标题" name="title" rules={[{ required: true, message: "请输入标题" }]}>
            <Input maxLength={200} placeholder="如：第一集" />
          </Form.Item>
          <Form.Item label="内容" name="content" rules={[{ required: true, message: "请输入内容" }]}>
            <Input.TextArea
              rows={12}
              placeholder={"格式：SCENE 1 时间/地点\n动作描述\n角色名：对白"}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ================= 角色 =================

export function CharactersPanel({ projectId }: PanelProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const { data: characters, isLoading, error } = useQuery({
    queryKey: ["production-characters", projectId],
    queryFn: () => productionApi.listCharacters(projectId),
  });

  if (isLoading) return panelLoading();
  if (error) return <Alert type="error" message="角色加载失败" description={(error as Error)?.message} />;
  if (!characters || characters.length === 0) {
    return panelEmpty(
      "还没有角色",
      "让编剧 Agent 从剧本中抽取角色，或手动创建。",
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setCreateOpen(true)}
      >
        新建角色
      </Button>,
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>共 {characters.length} 个角色</span>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建角色
        </Button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
        {characters.map((character) => (
          <CharacterCard key={character.id} character={character} />
        ))}
      </div>

      <Modal
        open={createOpen}
        title="新建角色"
        width={520}
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
          });
          setCreateOpen(false);
          form.resetFields();
          await queryClient.invalidateQueries({ queryKey: ["production-characters", projectId] });
        }}
        onCancel={() => {
          setCreateOpen(false);
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
        </Form>
      </Modal>
    </div>
  );
}

function CharacterCard({ character }: { character: Character }) {
  const appearance = [
    character.appearance.gender && `性别 ${character.appearance.gender}`,
    character.appearance.age && `年龄 ${character.appearance.age}`,
    character.appearance.hairstyle && `发型 ${character.appearance.hairstyle}`,
    character.appearance.clothing && `服装 ${character.appearance.clothing}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        padding: 14,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>
        {character.name}
      </div>
      <div style={{ marginTop: 6, fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        {character.description}
      </div>
      {appearance && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--color-text-tertiary)" }}>{appearance}</div>
      )}
      {character.personality && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--color-text-tertiary)" }}>
          性格：{character.personality}
        </div>
      )}
    </div>
  );
}

// ================= 场景 =================

export function ScenesPanel({ projectId }: PanelProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const { data: scenes, isLoading, error } = useQuery({
    queryKey: ["production-scenes", projectId],
    queryFn: () => productionApi.listScenes(projectId),
  });
  const { data: scripts } = useQuery({
    queryKey: ["production-scripts", projectId],
    queryFn: () => productionApi.listScripts(projectId),
    enabled: createOpen,
  });
  const { data: characters } = useQuery({
    queryKey: ["production-characters", projectId],
    queryFn: () => productionApi.listCharacters(projectId),
    enabled: createOpen,
  });

  if (isLoading) return panelLoading();
  if (error) return <Alert type="error" message="场景加载失败" description={(error as Error)?.message} />;
  if (!scenes || scenes.length === 0) {
    return panelEmpty(
      "还没有场景",
      "让分镜师 Agent 根据剧本生成场景，或手动创建。",
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
        新建场景
      </Button>,
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>共 {scenes.length} 个场景</span>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建场景
        </Button>
      </div>

      {scenes.map((scene) => (
        <SceneCard key={scene.id} scene={scene} scripts={scripts ?? []} characters={characters ?? []} />
      ))}

      <Modal
        open={createOpen}
        title="新建场景"
        width={560}
        okText="创建"
        cancelText="取消"
        onOk={async () => {
          const values = await form.validateFields();
          await productionApi.createScene(projectId, {
            name: values.name,
            description: values.description,
            scriptId: values.scriptId,
            location: values.location,
            time: values.time,
            characters: values.characters,
          });
          setCreateOpen(false);
          form.resetFields();
          await queryClient.invalidateQueries({ queryKey: ["production-scenes", projectId] });
        }}
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="场景名称" name="name" rules={[{ required: true, message: "请输入名称" }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item label="场景描述" name="description" rules={[{ required: true, message: "请输入描述" }]}>
            <Input.TextArea rows={3} maxLength={2000} />
          </Form.Item>
          <Form.Item label="关联剧本" name="scriptId">
            <Select
              allowClear
              placeholder="选择剧本版本"
              options={(scripts ?? []).map((s: ProductionScript) => ({
                value: s.id,
                label: `${s.title}（v${s.version}）`,
              }))}
            />
          </Form.Item>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <Form.Item label="地点" name="location">
              <Input maxLength={500} />
            </Form.Item>
            <Form.Item label="时间" name="time">
              <Input maxLength={500} />
            </Form.Item>
          </div>
          <Form.Item label="出场角色" name="characters">
            <Select
              mode="multiple"
              placeholder="选择出场角色"
              options={(characters ?? []).map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function SceneCard({
  scene,
  scripts,
  characters,
}: {
  scene: ProductionScene;
  scripts: ProductionScript[];
  characters: Character[];
}) {
  const script = scripts.find((s) => s.id === scene.scriptId);
  const names = scene.characters
    .map((id) => characters.find((c) => c.id === id)?.name ?? id)
    .filter(Boolean);
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: "var(--color-surface-secondary)",
            color: "var(--color-text-secondary)",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {scene.order + 1}
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>{scene.name}</span>
        {script && (
          <Tag style={{ marginInlineEnd: 0 }} color="default">
            剧本：{script.title}
          </Tag>
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        {scene.description}
      </div>
      <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12, color: "var(--color-text-tertiary)" }}>
        {scene.location && <span>地点：{scene.location}</span>}
        {scene.time && <span>时间：{scene.time}</span>}
        {names.length > 0 && <span>出场：{names.join("、")}</span>}
      </div>
    </div>
  );
}

// ================= 分镜 =================

export function StoryboardsPanel({ projectId }: PanelProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const { data: storyboards, isLoading, error } = useQuery({
    queryKey: ["production-storyboards", projectId],
    queryFn: () => productionApi.listStoryboards(projectId),
  });
  const { data: scenes } = useQuery({
    queryKey: ["production-scenes", projectId],
    queryFn: () => productionApi.listScenes(projectId),
  });
  const { data: shots } = useQuery({
    queryKey: ["production-shots", projectId],
    queryFn: () => productionApi.listShots(projectId),
  });

  if (isLoading) return panelLoading();
  if (error) return <Alert type="error" message="分镜加载失败" description={(error as Error)?.message} />;
  if (!storyboards || storyboards.length === 0) {
    return panelEmpty(
      "还没有分镜",
      "让分镜师 Agent 根据剧本生成场景分镜（Shot List），或手动创建。",
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
        新建分镜
      </Button>,
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
          共 {storyboards.length} 个分镜 · 每个分镜可拆分为多个镜头（总时长不超过分镜时长）
        </span>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建分镜
        </Button>
      </div>

      {storyboards.map((storyboard) => (
        <StoryboardCard
          key={storyboard.id}
          storyboard={storyboard}
          sceneName={scenes?.find((s) => s.id === storyboard.sceneId)?.name ?? storyboard.sceneId}
          shots={(shots ?? []).filter((s) => s.storyboardId === storyboard.id)}
        />
      ))}

      <Modal
        open={createOpen}
        title="新建分镜"
        width={560}
        okText="创建"
        cancelText="取消"
        onOk={async () => {
          const values = await form.validateFields();
          await productionApi.createStoryboard(projectId, {
            sceneId: values.sceneId,
            description: values.description,
            duration: values.duration,
            shotType: values.shotType,
            cameraMovement: values.cameraMovement,
            imagePrompt: values.imagePrompt,
            videoPrompt: values.videoPrompt,
          });
          setCreateOpen(false);
          form.resetFields();
          await queryClient.invalidateQueries({ queryKey: ["production-storyboards", projectId] });
        }}
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="所属场景" name="sceneId" rules={[{ required: true, message: "请选择场景" }]}>
            <Select
              placeholder="选择场景"
              options={(scenes ?? []).map((s: ProductionScene) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item label="分镜描述" name="description" rules={[{ required: true, message: "请输入描述" }]}>
            <Input.TextArea rows={3} maxLength={2000} placeholder="画面内容：人物、动作、氛围" />
          </Form.Item>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <Form.Item label="时长（秒）" name="duration" rules={[{ required: true, message: "请输入时长" }]}>
              <Input type="number" min={1} />
            </Form.Item>
            <Form.Item label="景别/运镜" name="shotType" rules={[{ required: true, message: "请输入景别/运镜" }]}>
              <Input placeholder="如 medium_shot / slow_push_in" maxLength={100} />
            </Form.Item>
          </div>
          <Form.Item label="相机运动" name="cameraMovement">
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item label="文生图提示词" name="imagePrompt">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
          <Form.Item label="文生视频提示词" name="videoPrompt">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function StoryboardCard({
  storyboard,
  sceneName,
  shots,
}: {
  storyboard: Storyboard;
  sceneName: string;
  shots: ProductionShot[];
}) {
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: "var(--color-surface-secondary)",
            color: "var(--color-text-secondary)",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {storyboard.order + 1}
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>
          {sceneName}
        </span>
        <Tag color={storyboard.status === "approved" ? "#2e9e62" : "default"}>
          {storyboard.status === "approved" ? "已通过" : "草稿"}
        </Tag>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginLeft: "auto" }}>
          {storyboard.shotType} · {storyboard.duration}s
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        {storyboard.description}
      </div>
      {(storyboard.imagePrompt || storyboard.videoPrompt) && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--color-text-tertiary)" }}>
          {storyboard.imagePrompt && (
            <div>
              <span style={{ fontWeight: 600 }}>图：</span>
              {storyboard.imagePrompt}
            </div>
          )}
          {storyboard.videoPrompt && (
            <div>
              <span style={{ fontWeight: 600 }}>视频：</span>
              {storyboard.videoPrompt}
            </div>
          )}
        </div>
      )}
      {shots.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid var(--color-border)", paddingTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 6 }}>
            镜头（{shots.length}）
          </div>
          {shots.map((shot) => {
            const st = SHOT_STATUS[shot.status] ?? { text: shot.status, color: "default" };
            return (
              <div
                key={shot.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "var(--color-surface-secondary)",
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                  #{shot.order + 1} · {shot.duration}s
                </span>
                {shot.framing && (
                  <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{shot.framing}</span>
                )}
                {shot.action && (
                  <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{shot.action}</span>
                )}
                <Tag style={{ marginInlineEnd: 0, marginLeft: "auto" }} color={st.color}>
                  {st.text}
                </Tag>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ================= 资产 =================

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
  subtitle: "字幕",
  reference: "参考",
};

export function AssetsPanel({ projectId }: PanelProps) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<AssetType>("image");
  // 生成任务（图片/视频同队列）：提交后记录 taskId → 轮询状态 / 支持取消（结果自动入库资产）
  const [taskId, setTaskId] = useState<string | null>(null);

  const { data: assets, isLoading, error } = useQuery({
    queryKey: ["production-assets", projectId, type],
    queryFn: () => productionApi.listAssets(projectId, type),
  });

  const { data: task } = useQuery({
    queryKey: ["generation-task", projectId, taskId],
    queryFn: () => productionApi.getTask(taskId as string),
    enabled: taskId != null,
    // 未终态每 3s 轮询；终态停止
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "completed" || status === "failed" || status === "cancelled"
        ? false
        : 3000;
    },
  });

  // 生成完成（图片/视频）→ worker 已自动入库资产，刷新列表
  useEffect(() => {
    if (task?.status === "completed") {
      void queryClient.invalidateQueries({ queryKey: ["production-assets", projectId] });
    }
  }, [task?.status, projectId, queryClient]);

  const removeAsset = async (id: string) => {
    await productionApi.deleteAsset(id);
    await queryClient.invalidateQueries({ queryKey: ["production-assets", projectId] });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(Object.keys(ASSET_TYPE_LABELS) as AssetType[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setType(key)}
            style={{
              height: 26,
              padding: "0 12px",
              borderRadius: 6,
              border: "1px solid var(--color-border)",
              background: type === key ? "var(--color-primary)" : "var(--color-surface)",
              color: type === key ? "#fff" : "var(--color-text-secondary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {ASSET_TYPE_LABELS[key]}
          </button>
        ))}
      </div>

      {/* 生成区（任务流：输入 → 参数 → 生成 → 状态 → 结果，仅图片/视频支持生成） */}
      {(type === "image" || type === "video") && (
        <AssetGenerationForm
          projectId={projectId}
          kind={type}
          onTask={setTaskId}
          hasActiveTask={task?.status === "queued" || task?.status === "running"}
        />
      )}
      {(type === "image" || type === "video") && task && (
        <GenerationTaskBar
          kind={task.kind === "image" ? "image" : "video"}
          task={task}
          onCancel={async () => {
            await productionApi.cancelTask(task.id);
          }}
          onDismiss={() => setTaskId(null)}
        />
      )}

      {isLoading ? (
        panelLoading()
      ) : error ? (
        <Alert type="error" message="资产加载失败" description={(error as Error)?.message} />
      ) : !assets || assets.length === 0 ? (
        panelEmpty(
          "暂无资产",
          type === "image" || type === "video"
            ? "在上方输入描述后点击生成；V0.2 资产保存供应商远程 URL。"
            : "该类型资产暂由后续版本（音频 / 字幕）创建。",
        )
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {assets.map((asset) => (
            <AssetCard key={asset.id} asset={asset} onRemove={removeAsset} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 生成参数缺省选项（空 = 不传，使用供应商默认） */
const IMAGE_SIZE_OPTIONS = [
  { label: "默认尺寸", value: "" },
  { label: "1024 × 1024", value: "1024x1024" },
  { label: "1792 × 1024 横版", value: "1792x1024" },
  { label: "1024 × 1792 竖版", value: "1024x1792" },
];

/**
 * 资产生成表单（图片/视频统一入队，worker 异步执行）。
 * 模型下拉仅列出用户已启用的对应类型模型；不选 = 后端按目录顺序取默认模型。
 */
function AssetGenerationForm({
  projectId,
  kind,
  onTask,
  hasActiveTask = false,
}: {
  projectId: string;
  kind: "image" | "video";
  onTask: (taskId: string) => void;
  /** 当前已有排队/进行中的生成任务：禁止重复提交，避免误触发多任务扣费 */
  hasActiveTask?: boolean;
}) {
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
    staleTime: 60_000,
  });
  const enabledIds = settings?.enabledModels ?? null;
  const modelOptions = (settings?.providers ?? [])
    .flatMap((p) => p.models.map((m) => ({ ...m, providerName: p.name })))
    .filter((m) => m.type === kind && (enabledIds == null || enabledIds.includes(m.id)))
    .map((m) => ({ label: `${m.displayName} · ${m.providerName}`, value: m.modelName }));

  const [prompt, setPrompt] = useState("");
  const [modelName, setModelName] = useState<string | undefined>();
  const [size, setSize] = useState<string | undefined>();
  const [imageUrl, setImageUrl] = useState("");
  const [duration, setDuration] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = prompt.trim() !== "" || (kind === "video" && imageUrl.trim() !== "");

  const submit = async () => {
    if (busy || hasActiveTask || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "image") {
        const { task } = await productionApi.generateImage(projectId, {
          prompt: prompt.trim(),
          modelName,
          size: size === "" ? undefined : size,
        });
        // 入队即返回：资产在 worker 完成后入库，由任务条轮询驱动列表刷新
        onTask(task.id);
      } else {
        const created = await productionApi.generateVideo(projectId, {
          prompt: prompt.trim() || undefined,
          imageUrl: imageUrl.trim() || undefined,
          modelName,
          duration,
        });
        onTask(created.id);
      }
    } catch (err) {
      setError((err as Error)?.message ?? "未知错误");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
      }}
    >
      <Input.TextArea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        autoSize={{ minRows: 2, maxRows: 4 }}
        placeholder={
          kind === "image"
            ? "描述要生成的画面，例如：古风女侠立于飞檐之上，月光冷色调，电影感广角"
            : "描述视频内容与镜头运动；也可留空并填首帧图片 URL（图生视频）"
        }
        disabled={busy}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Select
          size="small"
          allowClear
          placeholder={modelOptions.length > 0 ? "默认模型" : "未启用该类型模型"}
          style={{ minWidth: 150 }}
          value={modelName}
          options={modelOptions}
          onChange={(v: string | undefined) => setModelName(v)}
          popupMatchSelectWidth={false}
          disabled={busy}
        />
        {kind === "image" ? (
          <Select
            size="small"
            placeholder="默认尺寸"
            style={{ minWidth: 120 }}
            value={size}
            options={IMAGE_SIZE_OPTIONS}
            onChange={(v: string | undefined) => setSize(v)}
            popupMatchSelectWidth={false}
            disabled={busy}
          />
        ) : (
          <>
            <Input
              size="small"
              style={{ width: 220 }}
              placeholder="首帧图片 URL（可选）"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              disabled={busy}
            />
            <InputNumber
              size="small"
              min={5}
              max={15}
              placeholder="时长(秒)"
              style={{ width: 96 }}
              value={duration}
              onChange={(v: number | null) => setDuration(v ?? undefined)}
              disabled={busy}
            />
          </>
        )}
        <Button
          type="primary"
          size="small"
          loading={busy}
          disabled={!canSubmit || hasActiveTask}
          onClick={() => void submit()}
        >
          {kind === "image" ? "生成图片" : "生成视频"}
        </Button>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
          {hasActiveTask
            ? "已有任务进行中，完成或取消后可再次生成"
            : kind === "image"
              ? "异步任务：排队后由 worker 执行，通常数秒到一分钟"
              : "异步任务，通常 1-5 分钟，可离开本页；万相 2.1 时长固定 5 秒"}
        </span>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={kind === "image" ? "图片生成失败" : "视频任务提交失败"}
          description={
            <>
              {error}
              <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                请检查「模型设置」：已启用{kind === "image" ? "图片" : "视频"}模型且供应商 API Key 配置正确{kind === "video" ? "（视频当前仅支持百炼 DashScope）" : ""}。
              </div>
            </>
          }
        />
      )}
    </section>
  );
}

const TASK_STATUS_LABELS: Record<ProductionGenerationTask["status"], string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 生成任务状态条（图片/视频共用）：进度 / 可离开提示 / 取消 / 终态结果说明 */
function GenerationTaskBar({
  kind,
  task,
  onCancel,
  onDismiss,
}: {
  kind: "image" | "video";
  task: ProductionGenerationTask;
  onCancel: () => Promise<void>;
  onDismiss: () => void;
}) {
  const typeLabel = kind === "image" ? "图片" : "视频";
  if (task.status === "completed") {
    return (
      <Alert
        type="success"
        showIcon
        message={`${typeLabel}生成完成`}
        description="已自动加入下方资产列表。"
        action={
          <Button size="small" type="text" onClick={onDismiss}>
            收起
          </Button>
        }
      />
    );
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return (
      <Alert
        type={task.status === "failed" ? "error" : "warning"}
        showIcon
        message={task.status === "failed" ? `${typeLabel}生成失败` : "任务已取消"}
        description={
          <>
            {task.error ?? "无详细错误信息"}
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
              可调整描述或参数后重新提交；若为模型或密钥类错误（如 401 / 未配置 API Key），请先到「模型设置」检查对应模型的 API Key。
            </div>
          </>
        }
        action={
          <Button size="small" type="text" onClick={onDismiss}>
            收起
          </Button>
        }
      />
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
        {TASK_STATUS_LABELS[task.status]}…
      </span>
      <Progress style={{ flex: 1, margin: 0 }} percent={task.progress ?? 0} status="active" size="small" />
      <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
        完成后自动出现在资产列表
      </span>
      <Popconfirm title="取消该生成任务？" okText="取消任务" cancelText="保留" onConfirm={() => void onCancel()}>
        <Button size="small" danger>
          取消
        </Button>
      </Popconfirm>
    </div>
  );
}

function AssetCard({ asset, onRemove }: { asset: ProductionAsset; onRemove: (id: string) => Promise<void> }) {
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        overflow: "hidden",
      }}
    >
      {asset.type === "image" && asset.url && (
        <img
          src={asset.url}
          alt={asset.name}
          style={{ width: "100%", height: 140, objectFit: "cover", display: "block", background: "var(--color-surface-secondary)" }}
        />
      )}
      {asset.type === "video" && asset.url && (
        <video src={asset.url} controls style={{ width: "100%", height: 140, objectFit: "cover", display: "block", background: "#000" }} />
      )}
      {asset.type !== "image" && asset.type !== "video" && (
        <div
          style={{
            height: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-text-tertiary)",
            fontSize: 24,
            background: "var(--color-surface-secondary)",
          }}
        >
          {ASSET_TYPE_LABELS[asset.type]}
        </div>
      )}
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {asset.name}
        </span>
        {asset.generation && (
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
            {asset.generation.providerId}
          </span>
        )}
        <Popconfirm
          title="删除资产"
          description="删除后不可恢复"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onRemove(asset.id)}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </div>
    </div>
  );
}
