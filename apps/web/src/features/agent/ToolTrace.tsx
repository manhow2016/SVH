import type { ToolCallRecord } from '../../lib/api-types.js';
import { formatDuration } from '../../lib/format.js';
import styles from './ToolTrace.module.css';

export interface ToolTraceProps {
  calls: ToolCallRecord[];
}

/**
 * 工具调用轨迹。
 *
 * 默认折叠：它是「Agent 做了什么」的审计视图，对结果满意时用户不需要看；
 * 但生成结果不对时，它是理解「为什么」的唯一入口，所以必须能展开。
 */
export function ToolTrace({ calls }: ToolTraceProps) {
  if (calls.length === 0) return null;

  const failed = calls.filter((call) => call.status === 'failed').length;

  return (
    <details className={styles.trace}>
      <summary className={styles.summary}>
        Agent 执行了 {calls.length} 步{failed > 0 ? `（${failed} 步失败）` : ''}
      </summary>
      <ul className={styles.list}>
        {calls.map((call, index) => (
          <li
            key={`${call.name}-${String(index)}`}
            className={
              call.status === 'failed'
                ? styles.failed
                : call.status === 'rejected'
                  ? styles.rejected
                  : ''
            }
          >
            <span className={styles.name}>{call.name}</span>
            {call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : ''}
            {call.error !== undefined ? ` · ${call.error}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
