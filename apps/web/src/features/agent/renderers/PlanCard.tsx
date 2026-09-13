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

      {/*
       * `requiresApproval` 只决定「要不要提示用户确认」，**不再决定有没有按钮**。
       *
       * 它表达的是「系统要不要先停下来等你」（Agent 轮次据此结束在
       * `waiting_user`），而按钮回答的是「界面上有没有动手的入口」—— 两件事。
       * 早先把两者绑在一起，判据是「模板里高成本节点 ≥ 3」
       * （`packages/agent/src/workflow-planner.ts` 的 `APPROVAL_NODE_THRESHOLD`），
       * 而广告模板只有 1 个高成本节点：计划消息写着「确认后我就开始制作」，
       * 卡片上却一个按钮都没有，用户只能自己猜到输入框里敲「开始制作」。
       *
       * 这不是「阈值调小一点」就能解决的 —— 换成任何高成本节点不到 3 个的模板
       * 都会中招，是判据用错了地方。
       */}
      {payload.requiresApproval ? (
        <p className={shared.subtitle}>这份计划包含多个高成本步骤，确认后才会开始执行。</p>
      ) : null}

      {/*
       * 操作区**始终**渲染。
       *
       * 计划产出之后不会自动执行任何东西（`buildPlanReply` 只构造载荷，
       * 不发任务），所以这个入口是唯一的下一步；一旦把它挂在某个可选字段上，
       * 那个字段缺失就等于把用户困在卡片上 —— 本项目已经因为「把协议里可省略
       * 的字段当必填」白屏过一次。
       *
       * 计划本身不是可执行的持久化对象，因此界面**不假装**它在逐步执行：
       * 这里没有进度条，只有一次对话往返。
       */}
      <div className={shared.actions}>
        <Button variant="primary" onClick={() => onReply('开始制作')}>
          开始制作
        </Button>
        <Button onClick={() => onReply('我想调整一下方案')}>调整方案</Button>
      </div>
    </section>
  );
}
