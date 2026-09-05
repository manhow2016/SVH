import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  message,
} from "antd";
import {
  LeftOutlined,
  PlusOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { adminApi, type AdminModelInput, type AdminModelView } from "../../api/admin";
import { settingsApi } from "../../api/settings";
import { useAuthStore } from "../../stores/auth-store";
import type {
  MembershipFeatureView,
  MembershipTierView,
  PlanView,
  PromotionView,
  PublicUser,
  SubscriptionView,
} from "../../types/membership-types";
import type { UserRole } from "../../types/membership-types";
import type { ModelType } from "../../types/api-types";

const yuan = (cents: number) => `¥${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
const fmtDate = (ms: number) => dayjs(ms).format("YYYY-MM-DD HH:mm");

const DISCOUNT_TYPE_LABEL: Record<string, string> = {
  percentage: "百分比折扣",
  fixed_amount: "固定减免",
  fixed_price: "固定活动价",
};

/**
 * 管理员控制台（文档 §24/§26）：
 * 用户 / 会员等级 / 功能 / 套餐 / 活动 / 订阅（手动开通）。
 */
export function AdminPage() {
  const { user } = useAuthStore();
  const [tab, setTab] = useState("users");

  if (user?.role !== "admin") {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Alert type="warning" message="需要管理员权限" description="当前账号无权访问管理控制台。" />
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--color-bg)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 48,
          padding: "0 20px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          flexShrink: 0,
        }}
      >
        <a
          onClick={() => (window.location.hash = "")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          }}
        >
          <LeftOutlined /> 返回工作台
        </a>
        <span style={{ fontSize: 15, fontWeight: 600 }}>管理控制台</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 20px 40px" }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: "users", label: "用户", children: <UsersTab /> },
            { key: "models", label: "模型", children: <ModelsTab /> },
            { key: "tiers", label: "会员等级", children: <TiersTab /> },
            { key: "features", label: "功能", children: <FeaturesTab /> },
            { key: "plans", label: "套餐", children: <PlansTab /> },
            { key: "promotions", label: "活动", children: <PromotionsTab /> },
            { key: "subscriptions", label: "订阅", children: <SubscriptionsTab /> },
          ]}
        />
      </div>
    </div>
  );
}

/* ------------------------------ 用户 ------------------------------ */
function UsersTab() {
  const [keyword, setKeyword] = useState("");
  const [rows, setRows] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminApi.listUsers(keyword);
      setRows(r.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <Space style={{ marginBottom: 14 }}>
        <Input.Search
          placeholder="搜索用户名 / 邮箱"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={() => void load()}
          style={{ width: 260 }}
          allowClear
        />
      </Space>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}
      <Table<PublicUser>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 10 }}
        columns={[
          { title: "用户名", dataIndex: "username" },
          { title: "邮箱", dataIndex: "email" },
          {
            title: "角色",
            dataIndex: "role",
            width: 160,
            render: (role: string, record) => (
              <Select
                size="small"
                value={role}
                style={{ width: 120 }}
                options={[
                  { value: "user", label: "普通用户" },
                  { value: "admin", label: "管理员" },
                ]}
                onChange={async (v) => {
                  await adminApi.updateUser(record.id, { role: v as UserRole });
                  void load();
                }}
              />
            ),
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 140,
            render: (status: string, record) => (
              <Switch
                size="small"
                checked={status === "active"}
                checkedChildren="正常"
                unCheckedChildren="禁用"
                onChange={async (checked) => {
                  await adminApi.updateUser(record.id, { status: checked ? "active" : "disabled" });
                  void load();
                }}
              />
            ),
          },
          { title: "注册时间", dataIndex: "createdAt", width: 170, render: (v: string) => fmtDate(new Date(v).getTime()) },
        ]}
      />
    </div>
  );
}

/* ------------------------------ 会员等级 ------------------------------ */
function TiersTab() {
  const [rows, setRows] = useState<MembershipTierView[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<MembershipTierView | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const [featureModal, setFeatureModal] = useState<MembershipTierView | null>(null);
  const [featureList, setFeatureList] = useState<MembershipFeatureView[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await adminApi.listTiers();
      setRows(r.tiers);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const openFeature = async (tier: MembershipTierView) => {
    const r = await adminApi.listFeatures();
    setFeatureList(r.features);
    setFeatureModal(tier);
  };

  return (
    <div>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        style={{ marginBottom: 14 }}
        onClick={() => {
          setCreating(true);
          form.resetFields();
        }}
      >
        新建等级
      </Button>
      <Table<MembershipTierView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: "Code", dataIndex: "code", width: 120 },
          { title: "名称", dataIndex: "name", width: 120 },
          { title: "描述", dataIndex: "description", ellipsis: true },
          { title: "排序", dataIndex: "sortOrder", width: 80 },
          {
            title: "启用",
            dataIndex: "enabled",
            width: 80,
            render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: "操作",
            width: 220,
            render: (_, record) => (
              <Space>
                <Button size="small" onClick={() => void openFeature(record)}>
                  功能配置
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(record);
                    form.setFieldsValue({
                      name: record.name,
                      description: record.description,
                      sortOrder: record.sortOrder,
                      enabled: record.enabled,
                    });
                  }}
                >
                  编辑
                </Button>
              </Space>
            ),
          },
        ]}
      />

      {/* 创建 / 编辑 */}
      <Modal
        open={creating || editing !== null}
        title={creating ? "新建会员等级" : "编辑会员等级"}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        onOk={async () => {
          const values = await form.validateFields();
          if (creating) {
            await adminApi.createTier({ ...values });
            setCreating(false);
          } else if (editing) {
            await adminApi.updateTier(editing.id, values);
            setEditing(null);
          }
          void load();
          message.success("已保存");
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {creating && (
            <Form.Item label="Code" name="code" rules={[{ required: true }]}>
              <Input placeholder="如 power" />
            </Form.Item>
          )}
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="等级名称" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} placeholder="功能说明" />
          </Form.Item>
          <Form.Item label="排序" name="sortOrder" initialValue={0}>
            <InputNumber min={0} />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* 功能配置 */}
      <Modal
        open={featureModal !== null}
        title={`${featureModal?.name ?? ""} 功能配置`}
        width={720}
        onCancel={() => setFeatureModal(null)}
        footer={<Button onClick={() => setFeatureModal(null)}>完成</Button>}
        destroyOnHidden
      >
        <FeatureConfigEditor tier={featureModal!} features={featureList} onSaved={() => void load()} />
      </Modal>
    </div>
  );
}

function FeatureConfigEditor({
  tier,
  features,
  onSaved,
}: {
  tier: MembershipTierView;
  features: MembershipFeatureView[];
  onSaved: () => void;
}) {
  const [configs, setConfigs] = useState<Record<string, { enabled: boolean; config: string }>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const init: Record<string, { enabled: boolean; config: string }> = {};
    for (const f of tier.features ?? []) {
      init[f.code] = { enabled: f.enabled, config: JSON.stringify(f.config ?? {}, null, 2) };
    }
    setConfigs(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier.id]);

  const onSave = async () => {
    setSaving(true);
    try {
      await adminApi.setTierFeatures(
        tier.id,
        Object.entries(configs).map(([code, v]) => ({
          code,
          enabled: v.enabled,
          config: v.config ? JSON.parse(v.config) : {},
        })),
      );
      onSaved();
      message.success("功能配置已保存");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "var(--color-text-tertiary)",
          marginBottom: 12,
        }}
      >
        勾选该等级可用的功能；config 为 JSON 字符串，例如填写 maxWorkspaces: 3（-1 表示不限制）
      </div>
      {features.map((f) => {
        const state = configs[f.code] ?? { enabled: false, config: "{}" };
        return (
          <div
            key={f.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "8px 0",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <Checkbox
              checked={state.enabled}
              style={{ marginTop: 4 }}
              onChange={(e) =>
                setConfigs((prev) => ({ ...prev, [f.code]: { ...state, enabled: e.target.checked } }))
              }
            >
              <div>
                <div style={{ fontSize: 13 }}>{f.name}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{f.code}</div>
              </div>
            </Checkbox>
            <Input.TextArea
              style={{ flex: 1 }}
              autoSize={{ minRows: 1, maxRows: 4 }}
              value={state.config}
              placeholder='{"maxWorkspaces": 3}'
              onChange={(e) =>
                setConfigs((prev) => ({ ...prev, [f.code]: { ...state, config: e.target.value } }))
              }
            />
          </div>
        );
      })}
      <Button type="primary" loading={saving} onClick={() => void onSave()} style={{ marginTop: 14 }}>
        保存配置
      </Button>
    </div>
  );
}

/* ------------------------------ 功能 ------------------------------ */
function FeaturesTab() {
  const [rows, setRows] = useState<MembershipFeatureView[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<MembershipFeatureView | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const r = await adminApi.listFeatures();
      setRows(r.features);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        style={{ marginBottom: 14 }}
        onClick={() => {
          setCreating(true);
          form.resetFields();
        }}
      >
        新建功能
      </Button>
      <Table<MembershipFeatureView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: "Code", dataIndex: "code", width: 200 },
          { title: "名称", dataIndex: "name", width: 160 },
          { title: "描述", dataIndex: "description", ellipsis: true },
          {
            title: "操作",
            width: 100,
            render: (_, record) => (
              <Button
                size="small"
                onClick={() => {
                  setEditing(record);
                  form.setFieldsValue({ name: record.name, description: record.description });
                }}
              >
                编辑
              </Button>
            ),
          },
        ]}
      />
      <Modal
        open={creating || editing !== null}
        title={creating ? "新建功能" : "编辑功能"}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        onOk={async () => {
          const values = await form.validateFields();
          if (creating) {
            await adminApi.createFeature(values);
            setCreating(false);
          } else if (editing) {
            await adminApi.updateFeature(editing.id, values);
            setEditing(null);
          }
          void load();
          message.success("已保存");
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {creating && (
            <Form.Item label="Code" name="code" rules={[{ required: true }]}>
              <Input placeholder="如 agent.basic" />
            </Form.Item>
          )}
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/* ------------------------------ 套餐 ------------------------------ */
function PlansTab() {
  const [rows, setRows] = useState<PlanView[]>([]);
  const [tiers, setTiers] = useState<MembershipTierView[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<PlanView | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const [p, t] = await Promise.all([adminApi.listPlans(), adminApi.listTiers()]);
      setRows(p.plans);
      setTiers(t.tiers);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const tierOptions = tiers
    .filter((t) => t.enabled)
    .map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }));

  return (
    <div>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        style={{ marginBottom: 14 }}
        onClick={() => {
          setCreating(true);
          form.resetFields();
          form.setFieldsValue({ currency: "CNY", enabled: true, sortOrder: 0 });
        }}
      >
        新建套餐
      </Button>
      <Table<PlanView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: "名称", dataIndex: "name", width: 160 },
          {
            title: "等级",
            width: 120,
            render: (_, r) => r.tier.name,
          },
          { title: "天数", dataIndex: "durationDays", width: 80 },
          { title: "原价", dataIndex: "originalPrice", width: 100, render: (v: number) => yuan(v) },
          {
            title: "上架",
            dataIndex: "enabled",
            width: 80,
            render: (v: boolean) => (v ? <Tag color="green">上架</Tag> : <Tag>下架</Tag>),
          },
          {
            title: "操作",
            width: 100,
            render: (_, record) => (
              <Button
                size="small"
                onClick={() => {
                  setEditing(record);
                  form.setFieldsValue({
                    tierId: record.tierId,
                    name: record.name,
                    description: record.description,
                    durationDays: record.durationDays,
                    originalPrice: record.originalPrice,
                    currency: record.currency,
                    enabled: record.enabled,
                    sortOrder: record.sortOrder,
                  });
                }}
              >
                编辑
              </Button>
            ),
          },
        ]}
      />
      <Modal
        open={creating || editing !== null}
        title={creating ? "新建套餐" : "编辑套餐"}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        onOk={async () => {
          const values = await form.validateFields();
          if (creating) {
            await adminApi.createPlan(values);
            setCreating(false);
          } else if (editing) {
            await adminApi.updatePlan(editing.id, values);
            setEditing(null);
          }
          void load();
          message.success("已保存");
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="会员等级" name="tierId" rules={[{ required: true }]}>
            <Select options={tierOptions} placeholder="选择等级" />
          </Form.Item>
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="如 专业版月付" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="有效天数" name="durationDays" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="原价（分）" name="originalPrice" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="币种" name="currency">
            <Input />
          </Form.Item>
          <Form.Item label="排序" name="sortOrder" initialValue={0}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="上架" name="enabled" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/* ------------------------------ 活动 ------------------------------ */
function PromotionsTab() {
  const [rows, setRows] = useState<PromotionView[]>([]);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<PromotionView | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const [p, pl] = await Promise.all([adminApi.listPromotions(), adminApi.listPlans()]);
      setRows(p.promotions);
      setPlans(pl.plans);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setCreating(true);
    form.resetFields();
    form.setFieldsValue({
      discountType: "percentage",
      enabled: true,
      priority: 0,
      startedAt: dayjs(),
    });
  };

  const openEdit = (r: PromotionView) => {
    setEditing(r);
    form.setFieldsValue({
      name: r.name,
      description: r.description,
      discountType: r.discountType,
      discountValue: r.discountValue,
      startedAt: dayjs(r.startedAt),
      endedAt: r.endedAt ? dayjs(r.endedAt) : null,
      enabled: r.enabled,
      priority: r.priority,
      planIds: r.planIds,
    });
  };

  return (
    <div>
      <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 14 }} onClick={openCreate}>
        新建活动
      </Button>
      <Table<PromotionView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: "名称", dataIndex: "name", width: 160 },
          {
            title: "类型",
            dataIndex: "discountType",
            width: 110,
            render: (v: string) => DISCOUNT_TYPE_LABEL[v] ?? v,
          },
          { title: "值", dataIndex: "discountValue", width: 90 },
          {
            title: "时间",
            width: 210,
            render: (_, r) =>
              `${fmtDate(r.startedAt)} ~ ${r.endedAt ? fmtDate(r.endedAt) : "不限"}`,
          },
          { title: "优先级", dataIndex: "priority", width: 80 },
          {
            title: "启用",
            dataIndex: "enabled",
            width: 70,
            render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: "操作",
            width: 90,
            render: (_, record) => (
              <Button size="small" onClick={() => openEdit(record)}>
                编辑
              </Button>
            ),
          },
        ]}
      />
      <Modal
        open={creating || editing !== null}
        title={creating ? "新建活动" : "编辑活动"}
        width={640}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        onOk={async () => {
          const values = await form.validateFields();
          const payload = {
            ...values,
            startedAt: (values.startedAt as Dayjs).valueOf(),
            endedAt: values.endedAt ? (values.endedAt as Dayjs).valueOf() : null,
          };
          if (creating) {
            await adminApi.createPromotion(payload);
            setCreating(false);
          } else if (editing) {
            await adminApi.updatePromotion(editing.id, payload);
            setEditing(null);
          }
          void load();
          message.success("已保存");
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="如 专业版年付7折" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="折扣类型" name="discountType" rules={[{ required: true }]}>
            <Select
              options={Object.entries(DISCOUNT_TYPE_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="折扣值（百分比填 70 表示按原价 70% 支付；减免/固定价填金额，单位：分）"
            name="discountValue"
            rules={[{ required: true }]}
          >
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="开始时间" name="startedAt" rules={[{ required: true }]}>
            <DatePicker showTime style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="结束时间" name="endedAt">
            <DatePicker showTime style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="优先级（数字越大越优先）" name="priority">
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="关联套餐" name="planIds">
            <Select
              mode="multiple"
              options={plans.map((p) => ({ value: p.id, label: p.name }))}
              placeholder="选择套餐（不选则作用于所有套餐）"
            />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/* ------------------------------ 订阅 ------------------------------ */
function SubscriptionsTab() {
  const [rows, setRows] = useState<SubscriptionView[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [loading, setLoading] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantForm] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const [s, u, p] = await Promise.all([
        adminApi.listSubscriptions(),
        adminApi.listUsers(),
        adminApi.listPlans(),
      ]);
      setRows(s.subscriptions);
      setUsers(u.users);
      setPlans(p.plans.filter((pl) => pl.enabled));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const statusTag = (status: string) => {
    const map: Record<string, string> = {
      active: "green",
      expired: "default",
      cancelled: "orange",
      pending: "blue",
    };
    const label: Record<string, string> = {
      active: "生效中",
      expired: "已过期",
      cancelled: "已取消",
      pending: "待支付",
    };
    return <Tag color={map[status] ?? "default"}>{label[status] ?? status}</Tag>;
  };

  return (
    <div>
      <Button
        type="primary"
        icon={<UserAddOutlined />}
        style={{ marginBottom: 14 }}
        onClick={() => {
          grantForm.resetFields();
          setGrantOpen(true);
        }}
      >
        手动开通会员
      </Button>
      <Table<SubscriptionView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 10 }}
        columns={[
          { title: "用户", dataIndex: "username", width: 130 },
          { title: "套餐", dataIndex: "planName", width: 140 },
          {
            title: "等级",
            width: 100,
            render: (_, r) => r.tierName,
          },
          { title: "状态", dataIndex: "status", width: 90, render: (v: string) => statusTag(v) },
          {
            title: "开始",
            dataIndex: "startedAt",
            width: 150,
            render: (v: number) => fmtDate(v),
          },
          {
            title: "到期",
            dataIndex: "expiresAt",
            width: 150,
            render: (v: number) => fmtDate(v),
          },
          {
            title: "实付",
            dataIndex: "paidAmount",
            width: 100,
            render: (v: number) => yuan(v),
          },
        ]}
      />

      <Modal
        open={grantOpen}
        title="手动开通会员"
        onCancel={() => setGrantOpen(false)}
        onOk={async () => {
          const values = await grantForm.validateFields();
          await adminApi.grantSubscription(values.userId, values.planId);
          setGrantOpen(false);
          void load();
          message.success("开通成功，用户已立即获得对应功能权限");
        }}
        destroyOnHidden
      >
        <Form form={grantForm} layout="vertical">
          <Form.Item label="用户" name="userId" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={users.map((u) => ({ value: u.id, label: `${u.username}（${u.email}）` }))}
              placeholder="选择用户"
            />
          </Form.Item>
          <Form.Item label="套餐" name="planId" rules={[{ required: true }]}>
            <Select
              options={plans.map((p) => ({
                value: p.id,
                label: `${p.name}（${p.durationDays} 天，${yuan(p.originalPrice)}）`,
              }))}
              placeholder="选择套餐"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/* ------------------------------ 可用模型（管理员维护） ------------------------------ */
const MODEL_TYPE_OPTIONS: Array<{ value: ModelType; label: string }> = [
  { value: "text", label: "文本模型" },
  { value: "image", label: "图片模型" },
  { value: "video", label: "视频模型" },
  { value: "audio", label: "音频模型" },
];

const TYPE_TAG_COLOR: Record<ModelType, string> = {
  text: "blue",
  image: "green",
  video: "orange",
  audio: "default",
};

/**
 * 模型管理：可用模型列表（模型名 / 类型 / 显示名称）由管理员维护，
 * 用户设置页只读展示各供应商卡片及其模型清单。
 */
function ModelsTab() {
  const [rows, setRows] = useState<AdminModelView[]>([]);
  const [providerOptions, setProviderOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<AdminModelView | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([adminApi.listModels(), settingsApi.get()]);
      setRows(r.models);
      setProviderOptions(s.catalog.providers.map((p) => ({ value: p.id, label: p.name })));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true, sortOrder: 0, type: "text" });
  };
  const openEdit = (record: AdminModelView) => {
    setCreating(false);
    setEditing(record);
    form.setFieldsValue({
      providerId: record.providerId,
      modelName: record.modelName,
      type: record.type,
      displayName: record.displayName,
      enabled: record.enabled,
      sortOrder: record.sortOrder,
    });
  };

  return (
    <div>
      <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 14 }} onClick={openCreate}>
        新增模型
      </Button>
      <Table<AdminModelView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: "显示名称", dataIndex: "displayName", width: 180, ellipsis: true },
          { title: "模型名", dataIndex: "modelName", width: 220, ellipsis: true },
          { title: "供应商", dataIndex: "providerName", width: 120 },
          {
            title: "类型",
            dataIndex: "type",
            width: 100,
            render: (t: ModelType) => <Tag color={TYPE_TAG_COLOR[t]}>{MODEL_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t}</Tag>,
          },
          { title: "排序", dataIndex: "sortOrder", width: 70 },
          {
            title: "启用",
            dataIndex: "enabled",
            width: 70,
            render: (enabled: boolean, record) => (
              <Switch
                size="small"
                checked={enabled}
                onChange={async (checked) => {
                  await adminApi.updateModel(record.id, { enabled: checked });
                  void load();
                  message.success(checked ? "模型已启用" : "模型已停用");
                }}
              />
            ),
          },
          {
            title: "操作",
            width: 130,
            render: (_, record) => (
              <Space size={4}>
                <Button size="small" onClick={() => openEdit(record)}>
                  编辑
                </Button>
                <Popconfirm
                  title="确认删除该模型？"
                  description="删除后用户将无法使用该模型"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={async () => {
                    await adminApi.deleteModel(record.id);
                    void load();
                    message.success("已删除");
                  }}
                >
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={creating || editing !== null}
        title={creating ? "新增模型" : "编辑模型"}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        onOk={async () => {
          const values = (await form.validateFields()) as AdminModelInput;
          if (creating) {
            await adminApi.createModel(values);
            setCreating(false);
          } else if (editing) {
            await adminApi.updateModel(editing.id, values);
            setEditing(null);
          }
          void load();
          message.success("已保存");
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="显示名称"
            name="displayName"
            rules={[{ required: true, message: "请输入显示名称" }]}
          >
            <Input placeholder="如 豆包 Seed 1.6" />
          </Form.Item>
          <Form.Item
            label="模型名"
            name="modelName"
            rules={[{ required: true, message: "请输入模型名（供应商侧的模型 ID）" }]}
          >
            <Input placeholder="如 doubao-seed-1-6-250615" />
          </Form.Item>
          <Form.Item label="供应商" name="providerId" rules={[{ required: true, message: "请选择供应商" }]}>
            <Select options={providerOptions} placeholder="选择供应商" />
          </Form.Item>
          <Form.Item label="类型" name="type" rules={[{ required: true }]}>
            <Select options={MODEL_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item label="排序（越小越靠前）" name="sortOrder">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
