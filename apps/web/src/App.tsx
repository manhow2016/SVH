import { Navigate, Route, Routes } from 'react-router-dom';

/**
 * 路由表。
 *
 * 本任务只建立骨架；项目列表与工作台分别在 Task 4、Task 5 接入。
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route
        path="/projects"
        element={<div style={{ padding: 'var(--space-6)' }}>项目入口将在 Task 4 接入</div>}
      />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}
