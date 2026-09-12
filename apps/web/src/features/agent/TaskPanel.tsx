import { useCallback, useEffect, useRef, useState } from 'react';

import { ProgressBar } from '../../components/ProgressBar.js';
import { EmptyState } from '../../components/StateBlock.js';
import { apiFetch } from '../../lib/api.js';
import type { PageBody, TaskProgress } from '../../lib/api-types.js';
import styles from './TaskPanel.module.css';

export interface TaskPanelProps {
  /**
   * 当前会话。还没有会话时为 `null`。
   *
   * 用 `null` 而不是空串：空串会被拼成 `sessionId=`，
   * 后端只会把「参数缺失」当成不过滤，于是面板会把**全部**任务当成这个会话的任务显示。
   */
  sessionId: string | null;
  /** 处于降级状态：SSE 不可靠，改用轮询 */
  degraded: boolean;
  contextNotes: string[];
  /**
   * 外部刷新信号：SSE 的 `task.progress` / `task.status` 到达时由工作台递增。
   *
   * 面板自己没有事件源，只能被推着刷新 —— 实时刷新与降级轮询是两条独立的路径，
   * 前者快且免费，后者是 SSE 不可用时的兜底，两者都必须能拿到最新进度。
   */
  refreshSignal?: number;
}

/** 降级时的轮询间隔。不能太密，否则降级本身会变成新的负担。 */
const POLL_INTERVAL_MS = 3000;

/** 任务状态的中文标签 */
const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '生成中',
  waiting_user: '等待确认',
  success: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

export function TaskPanel({ sessionId, degraded, contextNotes, refreshSignal = 0 }: TaskPanelProps) {
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  /**
   * 请求代次。
   *
   * 会话切换或刷新信号到来后，**在途的旧响应不得覆盖新面板** ——
   * 否则用户会看到上一个会话的任务，或者刚刷出来的新进度被迟到的旧快照盖回去。
   */
  const generation = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (sessionId === null) return;
    const current = generation.current;
    try {
      const page = await apiFetch<PageBody<TaskProgress>>(
        `/api/tasks?sessionId=${sessionId}&pageSize=20`,
      );
      if (generation.current !== current) return;
      setTasks(Array.isArray(page.items) ? page.items : []);
      setLoadFailed(false);
    } catch {
      /*
       * 面板拉取失败不该打断对话，但也不能假装没事：
       * 保留上一次的快照，同时明确告诉用户这份进度可能已经过时。
       */
      if (generation.current !== current) return;
      setLoadFailed(true);
    }
  }, [sessionId]);

  // 会话建立 / 切换 / 收到刷新信号：立刻拉一次
  useEffect(() => {
    generation.current += 1;
    if (sessionId === null) {
      setTasks([]);
      setLoadFailed(false);
      return;
    }
    void load();
  }, [sessionId, refreshSignal, load]);

  // 降级时主动轮询：SSE 已不可靠，不能指望它推送进度
  useEffect(() => {
    if (sessionId === null || !degraded) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [sessionId, degraded, load]);

  return (
    <div className={styles.panel}>
      {degraded ? (
        <p className={styles.polling} role="status">
          实时连接不可用，正在用轮询获取进度。
        </p>
      ) : null}

      {loadFailed ? (
        <p className={styles.loadFailed} role="status">
          任务列表暂时拉取失败，下面显示的是上一次的进度。
        </p>
      ) : null}

      <section className={styles.section}>
        <h2>任务</h2>
        {tasks.length === 0 ? (
          <EmptyState
            icon="play"
            title="还没有任务"
            description="当 Agent 开始生成内容时，任务会出现在这里并实时更新进度。"
          />
        ) : (
          <ul className={styles.list}>
            {tasks.map((task) => (
              <li key={task.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.skill}>{task.skillId}</span>
                  <span className={styles.status}>{STATUS_LABEL[task.status] ?? task.status}</span>
                </div>
                {task.status === 'running' || task.status === 'pending' ? (
                  <ProgressBar
                    value={task.progress}
                    {...(task.progressMessage !== null ? { label: task.progressMessage } : {})}
                  />
                ) : null}
                {task.errorMessage !== null ? (
                  <span className={styles.error}>{task.errorMessage}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {contextNotes.length > 0 ? (
        <section className={styles.section}>
          <h2>上下文</h2>
          <ul className={styles.notes}>
            {contextNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
