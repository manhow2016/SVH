import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider, App as AntdApp, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { WorkbenchPage } from "./pages/WorkbenchPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { MembershipPage } from "./pages/MembershipPage";
import { AccountPage } from "./pages/AccountPage";
import { AdminPage } from "./pages/admin/AdminPage";
import { ProductionPage } from "./pages/ProductionPage";
import { ProductionDetailPage } from "./pages/ProductionDetailPage";
import { useAuthStore } from "./stores/auth-store";
import { useMembershipStore } from "./stores/membership-store";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/** 应用主体：认证门 + 轻量 hash 路由 + 会员状态加载 */
function Root() {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // 启动恢复会话（token → /api/auth/me）
  useEffect(() => {
    void useAuthStore.getState().load();
  }, []);

  const { status } = useAuthStore();

  // 退出登录后清空查询缓存，防止跨用户数据泄漏（缓存按查询键共享）
  useEffect(() => {
    if (status === "anonymous") {
      queryClient.clear();
    }
  }, [status]);

  // 登录后拉取会员信息（功能权限 UI 展示，§32/§33；后端仍做权威校验）
  useEffect(() => {
    if (status === "authenticated") {
      void useMembershipStore.getState().load();
    }
  }, [status]);

  const route = hash.replace(/^#\/?/, "").split("?")[0] ?? "";

  if (status === "loading") {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--color-bg)",
        }}
      >
        <span style={{ color: "var(--color-text-tertiary)", fontSize: 13 }}>加载中…</span>
      </div>
    );
  }

  if (status !== "authenticated") {
    return route === "register" ? <RegisterPage /> : <LoginPage />;
  }

  // 已登录访问登录/注册页 → 回工作台
  if (route === "login" || route === "register") {
    return <WorkbenchPage />;
  }

  // 制作中心（列表 / 详情：hash 不支持查询参数，项目 id 走路径段）
  if (route === "production") {
    return <ProductionPage />;
  }
  if (route.startsWith("production/")) {
    return <ProductionDetailPage projectId={route.slice("production/".length)} />;
  }

  switch (route) {
    case "membership":
      return <MembershipPage />;
    case "account":
      return <AccountPage />;
    case "admin":
      return <AdminPage />;
    default:
      return <WorkbenchPage />;
  }
}

/**
 * SVH Web 根组件：Dark First、Compact、Developer Tool 风格。
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: theme.defaultAlgorithm,
          token: {
            colorPrimary: "#3b6fe0",
            colorBgBase: "#ffffff",
            colorBgContainer: "#ffffff",
            colorBgElevated: "#ffffff",
            colorBorder: "#e0e3e9",
            colorBorderSecondary: "#eaecef",
            colorText: "#20242b",
            colorTextSecondary: "#5b6472",
            colorTextTertiary: "#8b93a1",
            colorError: "#d64545",
            colorSuccess: "#2e9e62",
            colorWarning: "#d98407",
            borderRadius: 6,
            fontSize: 13,
          },
          components: {
            Tree: { titleHeight: 22, indentSize: 22, nodeSelectedBg: "#e8effd" },
            Button: { controlHeightSM: 26 },
          },
        }}
      >
        <AntdApp>
          <Root />
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
