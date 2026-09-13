import type {
  CardAction,
  MessagePayload,
  SessionMessage,
  ToolCallRecord,
} from '../../lib/api-types.js';
import { formatRelativeTime } from '../../lib/format.js';
import { MentionText } from '../assets/MentionText.js';
import { MessageNotice } from './MessageBoundary.js';
import { ConfirmationCard } from './renderers/ConfirmationCard.js';
import { ErrorCard } from './renderers/ErrorCard.js';
import { PlanCard } from './renderers/PlanCard.js';
import { ProgressLine } from './renderers/ProgressLine.js';
import { ResultCard } from './renderers/ResultCard.js';
import { ToolTrace } from './ToolTrace.js';
import styles from './MessageList.module.css';

export interface MessageItemProps {
  message: SessionMessage;
  /** 「回复」类动作：把文本作为下一条用户消息发出去 */
  onReply?: (message: string) => void;
  /** 放行任务：传 taskIds 表示只放行这些，不传表示放行该会话下全部等待任务 */
  onConfirm?: (input: { taskIds?: string[] }) => void;
  /** 结果卡与错误卡上的通用动作 */
  onAction?: (action: CardAction) => void;
  /** slug → 资产 id。空表示不做链接化（正文保持纯文本） */
  assetIndex?: ReadonlyMap<string, string>;
  /** 结果卡深链所需。缺省时不渲染「查看资产详情」 */
  projectId?: string;
}

/**
 * 编译期穷尽检查。
 *
 * 参数类型是 `never`：`MessagePayload` 每新增一类载荷，分发链上漏掉它的
 * `default` 分支就会**编译报错**，而不是等到线上才发现有一类卡片不渲染。
 *
 * 运行时它什么都不做 —— `default` 分支在旧 bundle 撞上新 API 时是**可达**的
 * （结构收窄只保证 `type` 是字符串），那里要给出可见提示，不能抛错。
 */
function exhaustive(value: never): void {
  void value;
}

/**
 * 数组字段的存在性兜底。
 *
 * `@svh/domain` 里 `impacts` / `planTaskIds` / `media` / `actions` / `suggestions`
 * 都带 `.default([])`：生产者**可以省略**它们，省略后到前端就是 `undefined`。
 * 而渲染器把它们当必填数组解引用（`.length` / `.map` / `.filter`），
 * 一处 `undefined` 就足以让 React 19 卸载整棵根树、整个工作台白屏。
 */
function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 补齐可省略的数组字段，让渲染器拿到的载荷「形状可信」。
 *
 * 兜底在这里**一次**做完，而不是把 `Array.isArray` 抄进五个渲染器：
 * 越过协议边界的数据只有这一个入口。
 *
 * 只补数组的**存在性**，不做元素级校验 —— 元素畸形（例如 `media: [null]`）
 * 由 `MessageBoundary` 兜住，不在这里复刻一份 schema。
 */
function withArrayDefaults(payload: MessagePayload): MessagePayload {
  switch (payload.type) {
    case 'plan':
      return { ...payload, tasks: asArray(payload.tasks) };
    case 'confirmation_request':
      return {
        ...payload,
        impacts: asArray(payload.impacts),
        planTaskIds: asArray(payload.planTaskIds),
      };
    case 'result_card':
      return { ...payload, media: asArray(payload.media), actions: asArray(payload.actions) };
    case 'error':
      return {
        ...payload,
        suggestions: asArray(payload.suggestions),
        actions: asArray(payload.actions),
      };
    case 'progress':
      // 进度载荷没有数组字段，原样返回
      return payload;
    default:
      // 未知类型原样放行：可见的降级提示由 PayloadView 的 default 分支给出。
      // 这里的 never 检查同时保证「新增载荷类型却忘了补数组兜底」会编译报错。
      exhaustive(payload);
      return payload;
  }
}

/** 结构收窄的结果：五类已知载荷，外加协议里的原始 `type` 串 */
interface NarrowedPayload {
  payload: MessagePayload;
  /** 原始 `type` 串：未知类型要把它显示出来，而那时 payload 已被收窄成 never */
  typeName: string;
}

/**
 * 把 unknown 的 payload 收窄为判别联合。
 *
 * 后端把 payload 存成 JSON，前端拿到的是 unknown；
 * 这里只做**结构校验**（有没有字符串型的 type）与数组字段的存在性兜底，
 * 不做完整 schema 校验 —— 完整校验的收益不足以抵消在前端重复维护一份协议的成本：
 * 协议已经在 `@svh/domain` 里定义过一次，前端再抄一份 schema，两边就会各自演化。
 * 真正的护栏是端到端验证；元素级畸形由 `MessageBoundary` 兜底。
 *
 * 未知 `type` 会落到分发链的 `default` 分支，在那里降级成一条可见提示。
 */
function asPayload(value: unknown): NarrowedPayload | null {
  if (value === null || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return { payload: withArrayDefaults(value as MessagePayload), typeName: type };
}

/**
 * 把 unknown 的 toolCalls 收窄为工具轨迹条目。
 *
 * 与 payload 同理：后端存的是 JSON，形状不符的条目**逐条丢弃**，
 * 一条坏记录不该让整条消息（乃至整段对话流）渲染不出来。
 * 只保留渲染真正用得上的字段，避免把未校验的任意对象透传进组件。
 */
function asToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) return [];
  // 显式断言为 unknown[]：Array.isArray 会把 value 收窄成 any[]，
  // 直接使用会引入未经校验的 any
  const items = value as unknown[];
  const calls: ToolCallRecord[] = [];

  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const raw = item as {
      name?: unknown;
      arguments?: unknown;
      status?: unknown;
      error?: unknown;
      durationMs?: unknown;
      requiresConfirmation?: unknown;
    };
    if (typeof raw.name !== 'string' || raw.name.length === 0) continue;

    const args = raw.arguments;
    const status = raw.status;
    calls.push({
      name: raw.name,
      arguments: args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {},
      status:
        status === 'success' || status === 'failed' || status === 'rejected' ? status : 'pending',
      requiresConfirmation: raw.requiresConfirmation === true,
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
      ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
    });
  }

  return calls;
}

/** 分发链上的三个出口 */
interface PayloadViewProps {
  payload: MessagePayload;
  typeName: string;
  onReply: (message: string) => void;
  onConfirm: (input: { taskIds?: string[] }) => void;
  onAction: (action: CardAction) => void;
  /** 结果卡深链所需，与 `MessageItemProps` 同义 */
  projectId?: string;
}

/**
 * 按 `payload.type` 渲染对应卡片。
 *
 * 判别联合的 `switch` 让每个分支里的 `payload` 自动收窄成对应类型，
 * 因此这里不需要任何 `as` 断言。
 *
 * 这里刻意**没有** `assetIndex`：卡片渲染的是结构化载荷，里面没有 `@引用` 可言，
 * 五个分支没有一个消费它 —— 声明一个没人读的入参，等于对外承诺一个静默失效的接口。
 */
function PayloadView({
  payload,
  typeName,
  onReply,
  onConfirm,
  onAction,
  projectId,
}: PayloadViewProps) {
  switch (payload.type) {
    case 'plan':
      return <PlanCard payload={payload} onReply={onReply} />;
    case 'confirmation_request':
      return <ConfirmationCard payload={payload} onConfirm={onConfirm} />;
    case 'result_card':
      return (
        <ResultCard
          payload={payload}
          onAction={onAction}
          {...(projectId !== undefined ? { projectId } : {})}
        />
      );
    case 'error':
      return <ErrorCard payload={payload} />;
    case 'progress':
      return <ProgressLine payload={payload} />;
    default:
      /*
       * 两个目的，缺一不可：
       *
       * 1) 编译期 —— `exhaustive` 的参数是 `never`，`MessagePayload` 新增第六类
       *    载荷时这一行直接编译报错（`noFallthroughCasesInSwitch` 之外的第二道闸）；
       * 2) 运行时 —— 旧 bundle 撞上新 API（滚动发布）时这里**可达**，必须降级出
       *    一条可见提示：静默 `return null` 会让纯载荷消息只剩一个时间戳，
       *    用户和日志都拿不到任何信号。
       */
      exhaustive(payload);
      return (
        <MessageNotice>{`收到一条暂不支持的卡片（类型：${typeName}），已跳过渲染`}</MessageNotice>
      );
  }
}

export function MessageItem({
  message,
  onReply = () => undefined,
  onConfirm = () => undefined,
  onAction = () => undefined,
  assetIndex = new Map<string, string>(),
  projectId,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const narrowed = asPayload(message.payload);
  // 工具轨迹只属于 Agent：用户消息里没有「Agent 执行了什么」可言
  const toolCalls = isUser ? [] : asToolCalls(message.toolCalls);

  return (
    <article className={`${styles.message} ${isUser ? styles.user : ''}`}>
      {isUser ? (
        <div className={styles.userBubble}>
          <MentionText text={message.content} assetIndex={assetIndex} projectId={projectId ?? ''} />
        </div>
      ) : (
        <div className={styles.agentText}>
          {/* 有载荷时正文可能为空（例如纯计划消息），此时不渲染空段落 */}
          {message.content.length > 0 ? (
            <p>
              <MentionText
                text={message.content}
                assetIndex={assetIndex}
                projectId={projectId ?? ''}
              />
            </p>
          ) : null}

          {/* 判别联合分发：五类载荷各自的渲染器 */}
          {narrowed !== null ? (
            <PayloadView
              payload={narrowed.payload}
              typeName={narrowed.typeName}
              onReply={onReply}
              onConfirm={onConfirm}
              onAction={onAction}
              projectId={projectId}
            />
          ) : null}

          {/* 审计视图：默认折叠，结果不对时展开就能看到 Agent 做了哪些调用 */}
          <ToolTrace calls={toolCalls} />
        </div>
      )}
      <span className={styles.meta}>{formatRelativeTime(message.createdAt)}</span>
    </article>
  );
}
