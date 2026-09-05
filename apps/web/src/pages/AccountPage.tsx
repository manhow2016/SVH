import { useState } from "react";
import { Alert, Button, Form, Input, Descriptions, Tag } from "antd";
import { LeftOutlined } from "@ant-design/icons";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { useAuthStore } from "../stores/auth-store";

/**
 * 账户设置页：用户信息 + 修改密码 + 退出登录。
 */
export function AccountPage() {
  const { user, logout } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onChangePassword = async (values: { oldPassword: string; newPassword: string }) => {
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await authApi.changePassword(values);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "修改失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ height: "100vh", overflow: "auto", background: "var(--color-bg)" }}>
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
        <span style={{ fontSize: 15, fontWeight: 600 }}>账户设置</span>
      </div>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 20px 64px" }}>
        {/* 用户信息 */}
        <section
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>用户信息</div>
          <Descriptions column={1} size="small" labelStyle={{ width: 120 }}>
            <Descriptions.Item label="用户名">{user?.username}</Descriptions.Item>
            <Descriptions.Item label="邮箱">{user?.email}</Descriptions.Item>
            <Descriptions.Item label="角色">
              <Tag color={user?.role === "admin" ? "gold" : "default"}>
                {user?.role === "admin" ? "管理员" : "普通用户"}
              </Tag>
            </Descriptions.Item>
          </Descriptions>
          <Button danger type="text" onClick={logout} style={{ marginTop: 12 }}>
            退出登录
          </Button>
        </section>

        {/* 修改密码 */}
        <section
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>修改密码</div>
          <Form layout="vertical" onFinish={onChangePassword} requiredMark={false}>
            {error && (
              <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
            )}
            {success && (
              <Alert
                type="success"
                message="密码修改成功"
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}
            <Form.Item
              label="原密码"
              name="oldPassword"
              rules={[{ required: true, message: "请输入原密码" }]}
            >
              <Input.Password placeholder="当前密码" />
            </Form.Item>
            <Form.Item
              label="新密码"
              name="newPassword"
              rules={[
                { required: true, message: "请输入新密码" },
                { min: 8, message: "密码至少 8 位，且包含字母和数字" },
              ]}
              extra="至少 8 位，需包含字母和数字"
            >
              <Input.Password placeholder="至少 8 位，含字母和数字" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting}>
              保存修改
            </Button>
          </Form>
        </section>
      </div>
    </div>
  );
}
