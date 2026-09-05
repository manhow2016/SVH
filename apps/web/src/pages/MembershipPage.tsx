import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Skeleton, Tag } from "antd";
import {
  CheckCircleFilled,
  CrownOutlined,
  LeftOutlined,
  MinusCircleOutlined,
} from "@ant-design/icons";
import { membershipApi } from "../api/membership";
import { useAuthStore } from "../stores/auth-store";
import { useMembershipStore } from "../stores/membership-store";
import type { PlanView } from "../types/membership-types";

/** 分 → 元 展示（整数金额，文档 §10.1） */
function formatPrice(cents: number): string {
  return `¥${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const FEATURE_LABELS: Record<string, string> = {
  "agent.basic": "基础智能体",
  "agent.advanced": "高级智能体",
  "workspace.basic": "基础工作区",
  "workspace.multi": "多工作区",
  "assets.library": "资产库",
  "workflow.automation": "工作流自动化",
  "team.workspace": "团队工作区",
  "team.member": "团队成员",
  "api.access": "API 访问",
  "enterprise.feature": "企业特性",
};

/**
 * 会员中心（文档 §31）：
 * 当前等级 / 订阅状态 / 可使用功能 / 升级套餐（活动价）。
 */
export function MembershipPage() {
  const { user } = useAuthStore();
  const { membership, loading } = useMembershipStore();
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<PlanView | null>(null);

  useEffect(() => {
    membershipApi
      .plans()
      .then((r) => setPlans(r.plans))
      .finally(() => setPlansLoading(false));
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, PlanView[]>();
    for (const plan of plans) {
      const key = plan.tier.code;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(plan);
    }
    return [...map.entries()];
  }, [plans]);

  const featureEntries = useMemo(
    () => (membership ? Object.entries(membership.features) : []),
    [membership],
  );

  const open = Boolean(membership?.subscription && membership.subscription?.expiresAt > Date.now());

  return (
    <div style={{ height: "100vh", overflow: "auto", background: "var(--color-bg)" }}>
      {/* 顶栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 48,
          padding: "0 20px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          position: "sticky",
          top: 0,
          zIndex: 10,
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
        <span style={{ fontSize: 15, fontWeight: 600 }}>会员中心</span>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          欢迎，{user?.username}
        </span>
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 20px 64px" }}>
        <Skeleton active loading={loading || plansLoading} paragraph={{ rows: 8 }}>
          {/* 当前会员 */}
          <section
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 12,
              padding: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CrownOutlined style={{ fontSize: 18, color: "var(--color-warning)" }} />
                <span style={{ fontSize: 17, fontWeight: 600 }}>
                  {membership?.tier.name ?? "免费版"}
                </span>
                {open && <Tag color="green">订阅生效中</Tag>}
              </div>
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                模型 API 费用由你自行承担，SVH 会员仅控制软件功能权限
              </span>
            </div>

            {membership?.subscription && (
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 24,
                  fontSize: 13,
                  color: "var(--color-text-secondary)",
                }}
              >
                <div>
                  <div style={{ color: "var(--color-text-tertiary)", fontSize: 12 }}>开始时间</div>
                  <div style={{ marginTop: 2 }}>{formatDate(membership.subscription.startedAt)}</div>
                </div>
                <div>
                  <div style={{ color: "var(--color-text-tertiary)", fontSize: 12 }}>到期时间</div>
                  <div style={{ marginTop: 2 }}>{formatDate(membership.subscription.expiresAt)}</div>
                </div>
              </div>
            )}

            {/* 功能权限 */}
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                当前等级可使用功能
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: 8,
                }}
              >
                {featureEntries.map(([code, permission]) => (
                  <div
                    key={code}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: permission.enabled
                        ? "var(--color-surface-secondary)"
                        : "transparent",
                      border: "1px solid var(--color-border)",
                      color: permission.enabled
                        ? "var(--color-text-primary)"
                        : "var(--color-text-tertiary)",
                      fontSize: 13,
                    }}
                  >
                    {permission.enabled ? (
                      <CheckCircleFilled style={{ color: "var(--color-success)" }} />
                    ) : (
                      <MinusCircleOutlined />
                    )}
                    {FEATURE_LABELS[code] ?? code}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 套餐 */}
          <section style={{ marginTop: 24 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>升级会员</div>
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 14 }}>
              可购买套餐如下；开通由管理员人工处理（V1 暂未接入在线支付）
            </div>

            {grouped.map(([tierCode, tierPlans]) => (
              <div key={tierCode} style={{ marginBottom: 20 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    marginBottom: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {tierCode === "pro" ? "专业版" : tierCode === "enterprise" ? "企业版" : tierCode}
                  {membership?.tier.code === tierCode && (
                    <Tag style={{ fontSize: 11 }}>当前等级</Tag>
                  )}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: 12,
                  }}
                >
                  {tierPlans.map((plan) => {
                    const price = plan.price!;
                    const hasDiscount = price.discountAmount > 0;
                    return (
                      <div
                        key={plan.id}
                        style={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          borderRadius: 10,
                          padding: 16,
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{plan.name}</span>
                          {hasDiscount && (
                            <Tag color="red" style={{ marginInlineEnd: 0 }}>
                              活动价
                            </Tag>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
                          有效期 {plan.durationDays} 天
                        </div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={{ fontSize: 20, fontWeight: 700 }}>
                            {formatPrice(price.finalPrice)}
                          </span>
                          {hasDiscount && (
                            <span
                              style={{
                                fontSize: 12,
                                textDecoration: "line-through",
                                color: "var(--color-text-tertiary)",
                              }}
                            >
                              {formatPrice(price.originalPrice)}
                            </span>
                          )}
                        </div>
                        {hasDiscount && (
                          <div style={{ fontSize: 12, color: "var(--color-error)" }}>
                            优惠 {formatPrice(price.discountAmount)}
                          </div>
                        )}
                        <Button
                          type="primary"
                          ghost
                          onClick={() => setSelectedPlan(plan)}
                          style={{ marginTop: "auto" }}
                        >
                          开通
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        </Skeleton>
      </div>

      {/* 开通说明（V1 无支付：管理员手动开通，§27） */}
      <Modal
        open={selectedPlan !== null}
        title="开通会员"
        onCancel={() => setSelectedPlan(null)}
        onOk={() => setSelectedPlan(null)}
        okText="我知道了"
      >
        <p>
          你选择开通 <b>{selectedPlan?.name}</b>（
          {selectedPlan ? formatPrice(selectedPlan.price!.finalPrice) : ""}，有效期{" "}
          {selectedPlan?.durationDays} 天）。
        </p>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
          V1 阶段暂未接入在线支付，会员开通由管理员人工处理。请联系管理员完成开通，开通后你将立即获得对应功能权限。
        </p>
      </Modal>
    </div>
  );
}

