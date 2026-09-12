import { ProgressBar } from '../../../components/ProgressBar.js';
import type { ProgressPayload } from '../../../lib/api-types.js';

export interface ProgressLineProps {
  payload: ProgressPayload;
}

/**
 * 内联进度。
 *
 * 对话流里的进度不走卡片 —— 它没有独立操作边界，
 * 套上卡片只会让「正在发生的事」看起来像一个可操作的对象。
 */
export function ProgressLine({ payload }: ProgressLineProps) {
  return <ProgressBar value={payload.progress} label={payload.message} />;
}
