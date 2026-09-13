import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { ToastProvider } from './components/Toast.js';
import { AgentWorkspace } from './features/agent/AgentWorkspace.js';
import { ProjectListPage } from './features/projects/ProjectListPage.js';
import { ProviderSettingsPage } from './features/settings/ProviderSettingsPage.js';
import styles from './App.module.css';

/**
 * 应用外框：全局导航 + 内容区。
 *
 * ── 为什么导航放在这里，而不是塞进项目列表页 ──
 * 「模型服务」是全局设置入口，只长在某一个页面里的话，用户从别处就找不到它；
 * 而 `features/projects/**` 在本任务里是冻结的，改不了那个页面。
 * 路由表这一层是唯一能同时覆盖两个页面的位置。
 *
 * 工作台（`/projects/:projectId`）刻意**不套外框**：它是 100dvh 的沉浸式布局，
 * 上方再压一条导航会把输入区挤出首屏，也会和它自己的头部重复。
 */
function AppShell() {
  return (
    <>
      <nav className={styles.nav} aria-label="主导航">
        <Link className={styles.link} to="/projects">
          项目
        </Link>
        <Link className={styles.link} to="/settings/providers">
          模型服务
        </Link>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}

/**
 * 路由表。
 *
 * `AppErrorBoundary` 包在**最外层**（连 `ToastProvider` 一起覆盖）：
 * React 19 没有错误边界时会卸载整棵根树，任何一个页面组件在渲染期抛错
 * 都会变成整站白屏。逐条消息的 `MessageBoundary` 只管得住对话流那一条链路。
 */
export function App() {
  return (
    <AppErrorBoundary>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route element={<AppShell />}>
            <Route path="/projects" element={<ProjectListPage />} />
            <Route path="/settings/providers" element={<ProviderSettingsPage />} />
          </Route>
          <Route path="/projects/:projectId" element={<AgentWorkspace />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
