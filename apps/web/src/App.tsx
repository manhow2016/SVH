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
            Tree: { titleHeight: 26, nodeSelectedBg: "#e8effd" },
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
