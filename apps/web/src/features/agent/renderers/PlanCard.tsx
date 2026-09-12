import { Button } from '../../../components/Button.js';
import type { PlanPayload } from '../../../lib/api-types.js';
import { MessageNotice } from '../MessageBoundary.js';
import shared from './card.module.css';

export interface PlanCardProps {
  payload: PlanPayload;
  /** 发送一条回复消息（「开始制作」是新一轮对话，不是本地执行） */
  onReply: (message: string) => void;
}

/** 步骤状态的中文标签 */
const STATUS_LABEL: Record<PlanPayload['tasks'][number]['status'], string> = {
  pending: '待开始',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

/**
 * 状态 → 着色类名（可能为空：待开始 / 已跳过保持中性）。
 *
 * 中性状态不染色 —— 整张计划都带颜色会让人误以为「有很多事正在发生」。
 *
 * 返回值用 `string | undefined` 而不是预先拼好的字符串：
 * CSS Modules 的声明是 `Record<string, string>`，在 `noUncheckedIndexedAccess`
 * 下索引结果恒为 `string | undefined`，模板字符串会把它传染成 `string | undefined`。
 * 与 `Button` 一致，交给调用点 filter + join 处理空值。
 */
function statusAccent(status: PlanPayload['tasks'][number]['status']): string | undefined {
  if (status === 'done') return shared.statusDone;
  if (status === 'running') return shared.statusRunning;
  if (status === 'failed') return shared.statusFailed;
  return undefined;
}

export function PlanCard({ payload, onReply }: PlanCardProps) {
  return (
    <section className={shared.card} aria-label="制作计划">
      <header className={shared.header}>
        <h3 className={shared.title}>{payload.goal}</h3>
        {payload.rationale !== undefined ? (
          <p className={shared.subtitle}>{payload.rationale}</p>
        ) : null}
      </header>

      {payload.tasks.length > 0 ? (
        <ol className={shared.list}>
          {payload.tasks.map((task, index) => (
            <li key={task.id} className={shared.listItem}>
              <span className={shared.index}>{String(index + 1).padStart(2, '0')}</span>
              <span>{task.title}</span>
              <span
                className={[shared.status, statusAccent(task.status)]
                  .filter((name) => name !== undefined && name !== '')
                  .join(' ')}
              >
                {STATUS_LABEL[task.status]}
              </span>
              {task.estimate !== undefined ? (
                <span className={shared.estimate}>{task.estimate}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        /*
         * 步骤是协议里可省略的字段：省略后**不能**只留一个空列表 ——
         * 空白既不像「没有步骤」也不像「加载中」，等于什么都没说。
         */
        <MessageNotice>这条计划没有可展示的步骤</MessageNotice>
      )}

      {payload.requiresApproval ? (
        <div className={shared.actions}>
          {/*
            「开始制作」发送一条回复消息，触发新一轮 Agent 轮次。
            计划本身不是可执行的持久化对象，因此界面**不假装**它在逐步执行 ——
            这里没有进度条，只有一次对话往返。
          */}
          <Button variant="primary" onClick={() => onReply('开始制作')}>
            开始制作
          </Button>
          <Button onClick={() => onReply('我想调整一下方案')}>调整方案</Button>
        </div>
      ) : null}
    </section>
  );
}
