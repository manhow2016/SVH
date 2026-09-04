import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider, App as AntdApp, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { WorkbenchPage } from "./pages/WorkbenchPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * SVH Web 根组件：Dark First、Compact、Developer Tool 风格。
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: theme.darkAlgorithm,
          token: {
            colorPrimary: "#5b8def",
            colorBgBase: "#16181d",
            colorBgContainer: "#1d2026",
            colorBgElevated: "#24272e",
            colorBorder: "#30343c",
            colorBorderSecondary: "#2a2e36",
            colorText: "#e8eaef",
            colorTextSecondary: "#9aa1ad",
            colorTextTertiary: "#6b7280",
            colorError: "#e06c75",
            colorSuccess: "#4cae74",
            colorWarning: "#d9a545",
            borderRadius: 6,
            fontSize: 13,
          },
          components: {
            Tree: { titleHeight: 26, nodeSelectedBg: "#2c3340" },
            Button: { controlHeightSM: 26 },
          },
        }}
      >
        <AntdApp>
          <WorkbenchPage />
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
