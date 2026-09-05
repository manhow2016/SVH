import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useAuthStore } from "../stores/auth-store";
import { ApiError } from "../api/client";
import { AuthShell } from "./AuthShell";

/**
 * 登录页（文档 §30）：用户名 / 邮箱 + 密码。
 */
export function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: { identifier: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.identifier, values.password);
      window.location.hash = "";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title="登录 SVH" subtitle="使用用户名或邮箱登录，进入你的 AI 工作空间。">
      <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
        {error && (
          <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
        )}
        <Form.Item
          label="用户名 / 邮箱"
          name="identifier"
          rules={[{ required: true, message: "请输入用户名或邮箱" }]}
        >
          <Input prefix={<UserOutlined />} placeholder="username 或 user@example.com" size="large" autoFocus />
        </Form.Item>
        <Form.Item
          label="密码"
          name="password"
          rules={[{ required: true, message: "请输入密码" }]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
          登录
        </Button>
        <div
          style={{
            marginTop: 16,
            fontSize: 13,
            textAlign: "center",
            color: "var(--color-text-secondary)",
          }}
        >
          还没有账号？{" "}
          <a onClick={() => (window.location.hash = "#/register")}>立即注册</a>
        </div>
      </Form>
    </AuthShell>
  );
}
