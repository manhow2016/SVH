/**
 * 生产项目详情面板：脚本 / 角色 / 场景 / 分镜 / 资产（V0.2 文档 §18 / §19）。
 *
 * 数据展示 + 创建/更新（Agent 是主要写入方，页面以查看与轻量操作为主）。
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Tag,
} from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { productionApi } from "../../api/production";
import type {
  AssetType,
  Character,
  ProductionAsset,
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

  const { data: assets, isLoading, error } = useQuery({
    queryKey: ["production-assets", projectId, type],
    queryFn: () => productionApi.listAssets(projectId, type),
  });

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

      {isLoading ? (
        panelLoading()
      ) : error ? (
        <Alert type="error" message="资产加载失败" description={(error as Error)?.message} />
      ) : !assets || assets.length === 0 ? (
        panelEmpty(
          "暂无资产",
          "生成图片/视频后会在此展示（V0.2 暂存供应商远程 URL）。",
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
