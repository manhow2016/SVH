import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.js';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  // 入口 HTML 缺 #root 属于构建配置错误，直接抛出比静默白屏好排查
  throw new Error('找不到挂载点 #root，请检查 index.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
