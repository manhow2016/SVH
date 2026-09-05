import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { LockOutlined, MailOutlined, UserOutlined } from "@ant-design/icons";
import { useAuthStore } from "../stores/auth-store";
import { ApiError } from "../api/client";
import { AuthShell } from "./AuthShell";

/**
 * 注册页：注册成功后自动登录并进入工作台。
 */
export function RegisterPage() {
  const register = useAuthStore((s) => s.register);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: {
    username: string;
    email: string;
    password: string;
    confirm: string;
  }) => {
    if (values.password !== values.confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await register({ username: values.username, email: values.email, password: values.password });
      window.location.hash = "";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "注册失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title="注册账号" subtitle="注册后即可创建自己的工作区；模型 API 由你自行配置与承担费用。">
      <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
        {error && (
          <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
        )}
        <Form.Item
          label="用户名"
          name="username"
          rules={[
            { required: true, message: "请输入用户名" },
            { min: 2, message: "用户名至少 2 个字符" },
          ]}
        >
          <Input prefix={<UserOutlined />} placeholder="用户名" size="large" autoFocus />
        </Form.Item>
        <Form.Item
          label="邮箱"
          name="email"
          rules={[
            { required: true, message: "请输入邮箱" },
            { type: "email", message: "邮箱格式不正确" },
          ]}
        >
          <Input prefix={<MailOutlined />} placeholder="user@example.com" size="large" />
        </Form.Item>
        <Form.Item
          label="密码"
          name="password"
          rules={[
            { required: true, message: "请输入密码" },
            { min: 8, message: "密码至少 8 位，且包含字母和数字" },
          ]}
          extra="至少 8 位，需包含字母和数字"
        >
          <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位，含字母和数字" size="large" />
        </Form.Item>
        <Form.Item
          label="确认密码"
          name="confirm"
          rules={[{ required: true, message: "请再次输入密码" }]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="再次输入密码" size="large" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
          注册并进入
        </Button>
        <div
          style={{
            marginTop: 16,
            fontSize: 13,
            textAlign: "center",
            color: "var(--color-text-secondary)",
          }}
        >
          已有账号？{" "}
          <a onClick={() => (window.location.hash = "#/login")}>直接登录</a>
        </div>
      </Form>
    </AuthShell>
  );
}
