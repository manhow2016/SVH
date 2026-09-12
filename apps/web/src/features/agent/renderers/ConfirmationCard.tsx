import { Button } from '../../../components/Button.js';
import type { ConfirmationRequestPayload } from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface ConfirmationCardProps {
  payload: ConfirmationRequestPayload;
  /** 放行任务。传 taskIds 表示只放行这些；不传表示放行该会话下全部等待任务 */
  onConfirm: (input: { taskIds?: string[] }) => void;
}

export function ConfirmationCard({ payload, onConfirm }: ConfirmationCardProps) {
  /*
   * 优先精确放行：不传 taskIds 会把该会话下同源的多条等待任务一起放行，
   * 而用户看到并确认的只是这一条。
   *
   * `planTaskIds` 优先于单个 `taskId`：前者是这次确认覆盖的整组任务。
   */
  const taskIds =
    payload.planTaskIds.length > 0
      ? payload.planTaskIds
      : payload.taskId !== undefined
        ? [payload.taskId]
        : [];

  const precise = taskIds.length > 0;

  return (
    <section className={shared.card} aria-label="需要确认">
      <header className={shared.header}>
        <h3 className={shared.title}>需要你确认</h3>
        <p className={shared.subtitle}>{payload.summary}</p>
      </header>

      {payload.impacts.length > 0 ? (
        <dl className={shared.attributes}>
          {payload.impacts.map(([label, value]) => (
            <div key={`${label}-${value}`} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className={shared.actions}>
        {/*
          文案必须跟着放行范围走：载荷里没有任何 taskId 时只能退化为「放行全部」，
          那就得在按钮上说出来，否则用户以为只确认了眼前这一条。
        */}
        <Button variant="primary" onClick={() => onConfirm(precise ? { taskIds } : {})}>
          {precise ? '确认执行' : '确认全部执行'}
        </Button>
      </div>
    </section>
  );
}
