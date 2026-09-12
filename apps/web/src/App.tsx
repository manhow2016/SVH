import { Navigate, Route, Routes } from 'react-router-dom';

import { ToastProvider } from './components/Toast.js';
import { AgentWorkspace } from './features/agent/AgentWorkspace.js';
import { ProjectListPage } from './features/projects/ProjectListPage.js';

/**
 * 路由表。
 *
 * 设置页在 Task 8 接入。
 */
export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectListPage />} />
        <Route path="/projects/:projectId" element={<AgentWorkspace />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </ToastProvider>
  );
}
