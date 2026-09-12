import { Icon } from '../../../components/Icon.js';
import type { ErrorPayload } from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface ErrorCardProps {
  payload: ErrorPayload;
}

/**
 * 错误卡。
 *
 * 载荷已经带了标题、原因、建议与恢复说明，**直接消费**即可 ——
 * 界面重新编造文案只会与后端的判断脱节。
 *
 * 载荷里的 `actions` 本任务**刻意不渲染**：点击之后的发送链路要到 Task 7
 * 才接上，现在渲染一排点了没反应的按钮，等于制造假的可操作性；
 * 而 `suggestions` 已经足够让用户知道下一步做什么。
 */
export function ErrorCard({ payload }: ErrorCardProps) {
  return (
    <section className={shared.card} role="alert" aria-label="错误">
      <header className={shared.header}>
        <h3 className={shared.title}>
          <Icon name="alert" /> {payload.title}
        </h3>
        <p className={shared.subtitle}>{payload.reason}</p>
      </header>

      {/*
        已自动恢复时必须明确说出来，否则用户会以为这次生成失败了，
        进而重复发起 —— 那才是真正的浪费。
      */}
      {payload.recovered && payload.recoveryNote !== undefined ? (
        <p className={shared.recovery}>
          <Icon name="check" /> {payload.recoveryNote}
        </p>
      ) : null}

      {payload.suggestions.length > 0 ? (
        <ul className={shared.suggestions}>
          {payload.suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
