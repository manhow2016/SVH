import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button } from '../../components/Button.js';
import { Drawer } from '../../components/Drawer.js';
import { Icon } from '../../components/Icon.js';
import { ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch, apiPost } from '../../lib/api.js';
import type {
  AssetSummary,
  CardAction,
  ChatResponse,
  ConfirmResponse,
  ModelRuntimeStatus,
  PageBody,
  SessionDetail,
  SessionMessage,
  SessionSummary,
  TaskDetail,
  TaskRow,
} from '../../lib/api-types.js';
import type { SseEnvelope } from '../../lib/sse.js';
import {
  exhaustive,
  isKnownEventType,
  isRecord,
  payloadKindOf,
  readTextField,
  resultCardOf,
  type KnownEventType,
} from './agentEvents.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { TaskPanel } from './TaskPanel.js';
import { useSessionStream } from './useSessionStream.js';
import styles from './AgentWorkspace.module.css';

/*
 * 会话详情与确认响应都收敛到 `api-types.ts` —— 那里现在是「后端响应类型」
 * 的唯一出处，契约测试也只解析那一个文件。散落在特性目录里的响应类型
 * 等于自动绕开护栏。
 */

/**
 * 页面状态。
 *
 * 用可辨识联合而不是 `{ loading, error }` 两个独立字段：
 * 后者允许「同时在加载又有错误」这类自相矛盾的状态存在。
 *
 * 对话流不放在这里：它会随 SSE 事件不断追加重建，而这个联合表达的是
 * **会话的加载状态**。两者混在一起会让每次追加消息都重建一次「加载态」。
 */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: SessionDetail }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

/**
 * 单次拉取历史消息的条数上限。
 *
 * 取值与端点的最大值一致（`limit` 上限 200）；默认值 50 会在长会话里
 * 静默截断历史，因此这里必须显式传。更早的消息要靠分页补齐。
 */
const SESSION_MESSAGE_LIMIT = 200;

/**
 * 加载会话后回捞结果卡时一次取多少个任务。
 *
 * 端点的 `pageSize` 上限是 200；这里取 50 是**代价与完整性之间的取舍**：
 * 回捞要对每个任务再拉一次详情（串行），取值越大，刷新后的等待越长。
 * 服务端按 `createdAt` 倒序返回，因此窗口内先保住的是**最近**的 50 个成功任务。
 */
const BACKFILL_TASK_LIMIT = 50;

/**
 * `@资产` 索引一次拉多少条。
 *
 * 与「回捞结果卡」的 50 条是同一类取舍：超出窗口的引用**保持纯文本**，而不是猜。
 * 200 是服务端 `pageSize` 的上限。
 */
const ASSET_INDEX_PAGE_SIZE = 200;

/**
 * 结果卡的稳定排序键：产出时间（`updatedAt`）+ 任务 id。
 *
 * 列表端点按 `createdAt` 排序，而同一毫秒创建的两个任务之间没有确定顺序；
 * 直接用返回顺序补卡，每次刷新看到的卡片次序都可能不同。
 * 加上 id 兜底后顺序完全确定 —— 补卡顺序因此可复现。
 *
 * 字段来自网络：缺失时降级为空串，不让一个缺字段的任务把整次回捞带崩。
 */
function compareByProducedAt(left: TaskRow, right: TaskRow): number {
  const leftKey = `${typeof left.updatedAt === 'string' ? left.updatedAt : ''}\u0000${left.id}`;
  const rightKey = `${typeof right.updatedAt === 'string' ? right.updatedAt : ''}\u0000${right.id}`;
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

/** 尚无会话时的占位会话：`id` 为空即表示「还没建会话」，此时不建立 SSE 连接 */
function emptySession(projectId: string | null): SessionDetail {
  return {
    id: '',
    projectId,
    title: '',
    agentState: 'idle',
    contentId: null,
    messages: [],
    hasMore: false,
  };
}

/** 把异常翻译成一句给用户看的话。后端已经给了完整文案，直接消费而不是另写一份 */
function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message.length > 0) return err.message;
  return '操作未能完成，请稍后重试。';
}

/**
 * 确认结果的提示文案。
 *
 * 不直接用后端的 `message`：`resumed` 为空而 `skipped` 非空时，
 * 后端只会说「没有等待确认的操作」，而真实原因是这次放行**没生效**
 * （并发确认、状态已变化、尝试次数耗尽）。照抄那句话会让用户以为无事可做。
 */
function confirmFeedback(result: ConfirmResponse): string {
  const resumed = Array.isArray(result.resumed) ? result.resumed : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];

  const parts: string[] = [];
  if (resumed.length > 0) parts.push(`已确认 ${String(resumed.length)} 个操作`);
  if (skipped.length > 0) {
    parts.push(
      `${String(skipped.length)} 个未能放行（${skipped[0]?.reason ?? '原因未知'}）`,
    );
  }
  if (parts.length === 0) {
    return typeof result.message === 'string' && result.message.length > 0
      ? result.message
      : '没有等待确认的操作。';
  }
  return `${parts.join('，')}。`;
}

/**
 * 窄屏断点。
 *
 * 必须与 `AgentWorkspace.module.css` 里 `@media (max-width: 1024px)` 的值一致：
 * CSS 收起侧区、JS 决定改挂抽屉，两边判据不同步会出现
 * 「侧区被 CSS 藏了但 JS 以为还在宽屏」——也就是任务面板彻底消失。
 */
const NARROW_QUERY = '(max-width: 1024px)';

/**
 * 是否窄屏。
 *
 * 用 `matchMedia` 而不是读一次 `window.innerWidth`：后者在用户旋转屏幕
 * 或拖动窗口时不会更新，界面会卡在错误的布局上（侧区永远消失，
 * 或者抽屉与侧区同时存在）。
 */
function useIsNarrow(query = NARROW_QUERY): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setNarrow(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return narrow;
}

/** 从这一轮对话里取出要展示的上下文说明 */
function contextNotesOf(response: ChatResponse): string[] {
  // 响应体是网络数据：字段缺失时降级为空，而不是让整个工作台白屏
  const notes = Array.isArray(response.contextNotes) ? [...response.contextNotes] : [];
  const mentions = Array.isArray(response.analysis?.mentions) ? response.analysis.mentions : [];
  // 让用户看见「Agent 把你的 @引用 理解成了谁」——引用解析错了，结果必然不对
  if (mentions.length > 0) notes.push(`已解析 @引用：${mentions.join('、')}`);
  return notes;
}

export function AgentWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const projectIdValue = projectId ?? '';
  const { show: toast } = useToast();
  const isNarrow = useIsNarrow();

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [contextNotes, setContextNotes] = useState<string[]>([]);
  /** 递增即要求任务面板重新拉取（面板自己没有事件源，只能被推着刷新） */
  const [taskRefreshSignal, setTaskRefreshSignal] = useState(0);
  /** 窄屏任务抽屉是否打开。宽屏下恒为 false（见下面的收拢 effect） */
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  /** 模型运行时状态：`null` 表示「还没拿到 / 拿不到」，此时不提示 */
  const [modelStatus, setModelStatus] = useState<ModelRuntimeStatus | null>(null);
  /** 当前已加载的消息之前是否还有更早的（服务端多取一条判定，见 SessionDetail.hasMore） */
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** 对话流滚动容器：前插历史时要靠它补偿滚动位置 */
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * 前插前的 `scrollHeight`，等 DOM 提交后再用它算补偿量。
   *
   * 为什么不能在前插的同一个回调里补：`setMessages` 之后 React 还没把新节点
   * 提交到 DOM，此时量到的 `scrollHeight` 仍是旧值，差值算出来是 0 —— 补偿静默失效。
   * 这是**间歇性**的（取决于 rAF 与 React 提交的先后），实测两次运行一次生效一次不生效。
   */
  const pendingScrollHeight = useRef<number | null>(null);

  /** 本地追加消息的自增 id：与 REST 的 id 不会撞（前缀不同） */

  /*
   * 拉一次模型运行时状态，用于提示「当前是 Mock 占位内容」。
   *
   * 单独一个 effect 而不是并进 `load()`：会话加载可能失败或重试，
   * 而「模型配没配」与某一次会话加载的成败无关，不该被它的重试拖着走。
   * 拉不到就保持 `null` —— 宁可不说，也不要把网络故障说成「你没配模型」。
   */
  useEffect(() => {
    const controller = new AbortController();
    apiFetch<ModelRuntimeStatus>('/api/models/providers/runtime', { signal: controller.signal })
      .then((status) => {
        setModelStatus(status);
      })
      .catch(() => {
        setModelStatus(null);
      });
    return () => {
      controller.abort();
    };
  }, []);

  const localSeq = useRef(0);
  /** 正在发送的请求：用户点「停止生成」时中止它 */
  const abortRef = useRef<AbortController | null>(null);
  /** 已有结果卡的任务：同一 taskId 只追加一次（见 pullResultCard） */
  const resultCardDone = useRef(new Set<string>());
  /** 正在拉取结果卡的任务：并发事件（task.status 与 asset.changed）不该打两次 */
  const resultCardLoading = useRef(new Set<string>());
  /** 本轮请求在途：见 handleEvent 里对「回显」的处理 */
  const roundInFlight = useRef(false);
  /** 刚由 POST 响应渲染过的那一轮的指纹 */
  const echoedRound = useRef<{ text: string; payloadKind: string | null } | null>(null);

  const appendMessage = useCallback((message: SessionMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const bumpTaskRefresh = useCallback(() => {
    setTaskRefreshSignal((prev) => prev + 1);
  }, []);

  /** 采纳后端返回的会话 id：第一条消息会创建会话，之后 SSE 才能订阅到它 */
  const adoptSession = useCallback((sessionId: string) => {
    setLoadState((prev) =>
      prev.kind === 'ready' ? { kind: 'ready', session: { ...prev.session, id: sessionId } } : prev,
    );
  }, []);

  /**
   * 拉取任务详情，把它产出的结果卡补进对话流。
   *
   * 结果卡不在 Agent 轮次的载荷里，而是任务成功后才写进 `task.output.card`
   * （见 apps/worker/src/runner.ts 的 handleSuccess），因此只能按 taskId 回捞。
   * 去重按 **taskId** 而不是消息内容：同一任务会被 `task.status` 与
   * `asset.changed` 指到两次，内容比对既不可靠（卡片可能被改写）也没必要。
   */
  const pullResultCard = useCallback(
    async (taskId: string): Promise<void> => {
      if (resultCardDone.current.has(taskId) || resultCardLoading.current.has(taskId)) return;
      resultCardLoading.current.add(taskId);
      try {
        const detail = await apiFetch<TaskDetail>(`/api/tasks/${taskId}`);
        const card = resultCardOf(detail.output);
        // 还没有卡片是正常情况（任务未产出可展示结果）：不记账，留给后续事件再试
        if (card === null || resultCardDone.current.has(taskId)) return;
        resultCardDone.current.add(taskId);
        appendMessage({
          id: `result-${taskId}`,
          role: 'agent',
          kind: 'result_card',
          content: '',
          payload: card,
          createdAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        /*
         * 拉取失败不记账，后续事件（或用户刷新页面走 REST 历史）还会再试。
         * 这里刻意不弹提示：任务面板已经显示任务成功了，
         * 为一张卡再报一次错只会让一次成功看起来像失败。
         *
         * 但**必须留日志**：结果卡是「任务成功」与「对话流里看得见结果」之间
         * 唯一的桥，它静默失败时用户只看到任务成功却没有卡，
         * 而排查者连一条线索都没有 —— 本文件对未知事件类型、缺失文本
         * 都留了 warn/error，这条路径不该是例外。
         */
        console.warn(
          `[AgentWorkspace] 结果卡拉取失败（taskId=${taskId}），交给后续事件或页面刷新重试：`,
          err,
        );
      } finally {
        resultCardLoading.current.delete(taskId);
      }
    },
    [appendMessage],
  );

  /**
   * 加载会话后回捞终态任务的结果卡。
   *
   * ── 为什么需要它 ──
   * 结果卡的唯一来源是 `task.output.card`（Worker 写入），而服务端只把
   * **Agent 轮次**的载荷落成会话消息 —— Worker 产出的卡没有任何落消息路径。
   * 于是刷新页面后：任务面板显示「已完成」，对话流里却找不到那张卡，
   * 前后不一致，看上去就是 bug。彻底修复要后端补一条消息落库（不在本任务范围内），
   * 这里用**加载后回捞**缓解。
   *
   * ── 为什么不会重复 ──
   * 与实时链路共用 `pullResultCard`，因此也共用 `resultCardDone` / `resultCardLoading`
   * 两个集合：同一 taskId 无论从 SSE 还是从这里到达，都只会补出一张卡。
   *
   * ── 为什么串行 ──
   * 一次刷新可能涉及几十个任务，并发拉详情会把后端在页面加载时打满；
   * 串行只多花几个来回，代价可接受。
   */
  const backfillResultCards = useCallback(
    async (sessionIdValue: string): Promise<void> => {
      try {
        /*
         * 服务端按 `status=success` 过滤后再分页：`success` 是唯一的
         * 「终态且成功」状态（见 packages/domain/src/task.ts 的 TERMINAL_TASK_STATUSES），
         * 因此分页窗口里不会混进失败 / 取消的任务，把成功的挤出去。
         * 下面仍逐条复核 `status`，不把协议正确性交给一个查询参数。
         */
        const page = await apiFetch<PageBody<TaskRow>>(
          `/api/tasks?sessionId=${sessionIdValue}&status=success&pageSize=${String(BACKFILL_TASK_LIMIT)}`,
        );
        const items = Array.isArray(page.items) ? page.items : [];
        const targets = items
          .filter((task) => task.status === 'success')
          .sort(compareByProducedAt);

        for (const task of targets) {
          await pullResultCard(task.id);
        }
      } catch (err: unknown) {
        /*
         * 回捞是「补历史」，不是用户当下请求的动作：清单拉不到时不该打断会话加载，
         * 也不该抢走注意力 —— 实时事件与下一次刷新都还会再试。
         *
         * 同样要留日志：整段回捞静默失败时，界面表现为「刷新后结果卡凭空少了」，
         * 与「本来就没有卡」无法区分，事后只能靠日志分辨。
         */
        console.warn(
          `[AgentWorkspace] 结果卡回捞失败（sessionId=${sessionIdValue}），下次刷新或事件到达时重试：`,
          err,
        );
      }
    },
    [pullResultCard],
  );

  /**
   * 往前翻一页历史。
   *
   * ── 游标为什么是 `createdAt` 的严格小于 ──
   * 服务端的 `before` 走 `createdAt: { lt }`，取的是**当前最早那条之前**的消息，
   * 因此不会把已经显示的第一条再取回来。理论上不会重复，但同毫秒写入的多条消息
   * 会让边界不稳，所以下面仍按 `id` 去重一次 —— 重复渲染比丢消息更烦人，
   * 而去重的代价只是一个 Set。
   *
   * ── 为什么要补偿滚动位置 ──
   * 在顶部前插内容会把整个列表往下推，而浏览器保持 `scrollTop` 不变，于是用户
   * 眼前的消息**跳走了**。把新增的高度补回 `scrollTop`，视觉上就停在原处 ——
   * 这是「加载更早」这类交互能不能用的关键，不是锦上添花。
   */
  const loadEarlier = useCallback(async (): Promise<void> => {
    if (loadState.kind !== 'ready' || loadingEarlier) return;

    const oldest = messages[0];
    // 没有消息就没有游标；`hasEarlier` 为假时入口本来也不渲染
    if (oldest === undefined) return;

    setLoadingEarlier(true);
    // 记下前插前的高度；真正的补偿在下面的 useLayoutEffect 里做
    pendingScrollHeight.current = scrollRef.current?.scrollHeight ?? null;

    try {
      const earlier = await apiFetch<SessionDetail>(
        `/api/agent/sessions/${loadState.session.id}` +
          `?limit=${String(SESSION_MESSAGE_LIMIT)}&before=${encodeURIComponent(oldest.createdAt)}`,
      );
      const fetched = Array.isArray(earlier.messages) ? earlier.messages : [];

      setMessages((prev) => {
        const known = new Set(prev.map((message) => message.id));
        return [...fetched.filter((message) => !known.has(message.id)), ...prev];
      });
      setHasEarlier(earlier.hasMore === true);
    } catch (err: unknown) {
      /*
       * 这是**用户主动点的动作**，失败必须可见 —— 与回捞（后台补历史、失败只记日志）
       * 不同：点了没反应会被当成「上面真的没有更多了」。
       */
      // 失败时清掉待补偿量，否则下次任意一次消息变化都会平白滚一下
      pendingScrollHeight.current = null;
      toast(errorText(err), 'error');
    } finally {
      setLoadingEarlier(false);
    }
  }, [loadState, messages, loadingEarlier, toast]);

  /*
   * 前插历史后把视口挪回原处。
   *
   * 用 `useLayoutEffect` 而不是在 `loadEarlier` 里 `requestAnimationFrame`：
   * 这个钩子在 DOM 提交后、浏览器绘制**前**同步执行，量到的一定是新高度，
   * 也不会有一帧的跳动。rAF 版本与 React 的提交时机存在竞态 ——
   * 实测两次运行里有一次量到旧高度、补偿静默失效，用户眼前的消息直接跳走。
   */
  useLayoutEffect(() => {
    const heightBefore = pendingScrollHeight.current;
    if (heightBefore === null) return;
    pendingScrollHeight.current = null;

    const container = scrollRef.current;
    if (container === null) return;
    container.scrollTop += container.scrollHeight - heightBefore;
  }, [messages]);

  const load = useCallback(async () => {
    setLoadState({ kind: 'loading' });
    setContextNotes([]);
    try {
      /*
       * 两步加载：先取会话列表（按 projectId 过滤，拿最新一条的 id），再取详情。
       *
       * 为什么不是一步：后端**没有**「按项目取最新会话」的专用端点，
       * 而列表端点已经支持 projectId 过滤与分页。
       */
      const page = await apiFetch<PageBody<SessionSummary>>(
        `/api/agent/sessions?projectId=${projectIdValue}&pageSize=1`,
      );

      const latest = page.items[0];
      if (latest === undefined) {
        // 该项目还没有会话：显示空对话流，等用户说出第一个需求时再创建
        setLoadState({ kind: 'ready', session: emptySession(projectId ?? null) });
        setMessages([]);
        return;
      }

      /*
       * 详情请求必须显式带 `limit`：端点的默认值是 50（上限 200，
       * 见 apps/api/src/routes/agent.ts 的 listMessagesQuerySchema）。
       * 会话按项目复用并长期累积，不带参数时刷新会**静默丢掉最早的一批消息**，
       * 与「REST 全量历史、刷新不丢消息」的承诺直接矛盾 —— Task 6 之后
       * 被丢掉的可能是早先的计划卡 / 确认卡。
       *
       * ── 已知限制 ──
       * 200 是当前端点允许的上限，也是这里能一次拿到的**全部**。
       * 超过 200 条消息的会话，更早的历史需要分页加载（端点已支持 `before` 游标），
       * 本任务尚未实现「加载更早的消息」入口 —— 这是明确的待办，不是「已经全量」。
       */
      const detail = await apiFetch<SessionDetail>(
        `/api/agent/sessions/${latest.id}?limit=${String(SESSION_MESSAGE_LIMIT)}`,
      );
      const loaded = Array.isArray(detail.messages) ? detail.messages : [];
      setLoadState({ kind: 'ready', session: detail });
      setMessages(loaded);
      setHasEarlier(detail.hasMore === true);

      /*
       * 把历史里**已经落库的结果卡**记进去重集合，再回捞。
       *
       * 结果卡现在由 Worker 落成会话消息（`appendSessionMessage`），所以
       * 「历史里没有卡」不再成立。不先记账的话，回捞会把同一个任务再补一张 ——
       * 刷新一次多一张，用户看到重复的结果卡。
       *
       * 判据用消息行自带的 `taskId` 列，而不是 `payload.taskId`：
       * 载荷由各技能自己构造，`asset.create` 之类的卡压根不带这个字段
       * （实测踩过），而 `taskId` 列是 Worker 写消息时一并落库的，一定在。
       *
       * 回捞本身保留：本次修复之前产生的会话确实没有落库的卡，
       * 对它们仍然只能靠任务列表补。
       */
      for (const message of loaded) {
        if (message.kind !== 'result_card') continue;
        if (typeof message.taskId === 'string' && message.taskId.length > 0) {
          resultCardDone.current.add(message.taskId);
        }
      }

      /*
       * 补历史：放在 setMessages 之后，补出来的卡接在历史末尾，顺序与对话流一致。
       */
      await backfillResultCards(latest.id);
    } catch (err) {
      // 直接消费 ApiError 携带的后端文案：规范要求错误说明
      // 「发生了什么 / 可能原因 / 下一步怎么做」，这三件事后端已经给了
      const apiError = err instanceof ApiError ? err : null;
      setLoadState({
        kind: 'error',
        message: apiError?.message ?? '加载会话失败。',
        suggestions: apiError?.suggestions ?? [],
        retryable: apiError?.retryable ?? false,
      });
    }
  }, [projectId, projectIdValue, backfillResultCards]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 项目资产的 slug → id 索引：把消息正文里的 @名字 链接化 */
  const [assetIndex, setAssetIndex] = useState<ReadonlyMap<string, string>>(new Map());
  /** 递增即重新拉索引（新建资产之后） */
  const [assetIndexToken, setAssetIndexToken] = useState(0);

  /*
   * 只在**项目切换**时清空索引。
   * `/projects/:projectId` 这条路由没有 key，同路由换项目不会 remount，旧索引会与新的
   * projectId 组合出 `/projects/p2/assets?asset=<p1 的 id>` —— 正是「宁可不可点，也不要链错」
   * 要避免的链接。
   *
   * 刻意**不放进下面那个拉取 effect**：那个 effect 的依赖还有 `assetIndexToken`
   * （新建资产后重拉），在那里清空会让已经可点的 @链接 每次新建都退回纯文本，
   * 而重拉一旦失败（`.catch` 是静默降级）就再也回不来。
   */
  useEffect(() => {
    setAssetIndex(new Map());
  }, [projectIdValue]);

  /*
   * 索引要**单独拉一次**，不能复用输入区的补全清单：补全是在用户敲下 `@`
   * 时才发的请求，而消息渲染发生在页面加载时 —— 两者时机不同，复用拿不到数据。
   */
  useEffect(() => {
    if (projectIdValue === '') return;
    let cancelled = false;
    void apiFetch<PageBody<AssetSummary>>(
      `/api/assets?projectId=${projectIdValue}&pageSize=${String(ASSET_INDEX_PAGE_SIZE)}`,
    )
      .then((body) => {
        if (cancelled) return;
        setAssetIndex(new Map(body.items.map((asset) => [asset.slug, asset.id])));
      })
      .catch(() => {
        /*
         * 拉不到索引是**降级**，不是失败：消息正文里的 @名字 保持纯文本，
         * 对话流照常可用。刻意不弹提示 —— 为了一条链接能不能点而打断阅读，
         * 代价大于收益；真正的故障（后端挂了）会由会话加载自己报出来。
         */
      });
    return () => {
      cancelled = true;
    };
  }, [projectIdValue, assetIndexToken]);

  /*
   * 历史与实时分工：REST 负责**全量历史**（刷新不丢消息），SSE 只接**增量**。
   * 因此这里把「还没有会话」表达为 null —— 没有会话就没有可订阅的连接。
   */
  const sessionId = loadState.kind === 'ready' && loadState.session.id.length > 0 ? loadState.session.id : null;

  /**
   * 判断事件是否只是「我刚渲染过的那一轮」的副本。
   *
   * ── 为什么需要它 ──
   * `POST /api/agent/chat` 在返回响应**之前**会把这一轮的 message 与载荷
   * 通过 SSE 广播出去（见 apps/api/src/routes/agent.ts）。也就是说同一条回复有
   * 两个副本：POST 响应与 SSE 事件。两个副本谁先到并不确定 ——
   * POST 直接回、SSE 要经 Redis 转发，因此两种顺序都要挡，
   * 否则用户每说一句话，界面上就会出现两条一模一样的回复。
   *
   * 判据刻意用「本轮在途 + 一次性指纹」而不是「比对历史里有没有相同文本」：
   * 后者会在「用户连发两条、Agent 回复措辞相同」时把真实消息误删。
   */
  function consumeOwnRoundEcho(type: KnownEventType, data: unknown): boolean {
    // 本轮还没结束：属于本轮的事件都会由 POST 响应统一渲染
    if (roundInFlight.current) return true;

    const echo = echoedRound.current;
    if (echo === null) return false;

    const payloadKind = payloadKindOf(type);
    const text = readTextField(data, 'message');
    const matched =
      (type === 'agent.message' && text !== null && text === echo.text) ||
      (payloadKind !== null && payloadKind === echo.payloadKind);

    // 指纹一次性：挡掉这一份副本后立刻失效，不会误伤后续事件
    if (matched) echoedRound.current = null;
    return matched;
  }

  /**
   * SSE 事件分派。
   *
   * 用 `switch` + `never` 穷尽检查而不是一长串 `if`：
   * 协议新增事件类型时，漏掉的分支会**编译报错**。
   */
  function handleEvent(envelope: SseEnvelope): void {
    /*
     * 未知事件类型必须留痕。旧 bundle 撞上新协议时这里可达 ——
     * 静默吞掉意味着「新事件推过来了但界面没反应」，而这个现象
     * 在日志里查不到任何线索。
     */
    if (!isKnownEventType(envelope.type)) {
      console.warn(`[AgentWorkspace] 收到未知的 SSE 事件类型：${envelope.type}，已忽略`);
      return;
    }

    const type = envelope.type;
    const payloadKind = payloadKindOf(type);

    // 消息类事件先过回显去重；task.* / asset.changed 不受影响
    // （它们不是本轮回复的副本，比如用户刚确认的任务会立刻推进度）
    if ((type === 'agent.message' || payloadKind !== null) && consumeOwnRoundEcho(type, envelope.data)) {
      return;
    }

    switch (type) {
      // ── 不产生消息的事件 ──
      case 'session.ready':
      case 'agent.state':
      case 'ping':
        // 建连确认、状态机与心跳：降级判据已由传输层与 hook 处理，这里无需动作
        return;

      // ── 追加消息的事件 ──
      case 'agent.message': {
        const text = readTextField(envelope.data, 'message');
        if (text === null) {
          // 空文本消息渲染出来只有一个时间戳，对用户毫无意义
          console.warn('[AgentWorkspace] agent.message 缺少文本，已忽略：', envelope.data);
          return;
        }
        appendMessage({
          id: `sse-${String(envelope.seq)}`,
          role: 'agent',
          kind: 'text',
          content: text,
          payload: null,
          createdAt: envelope.at,
        });
        return;
      }

      case 'agent.plan':
      case 'agent.confirmation':
      case 'agent.result_card':
      case 'error': {
        if (!isRecord(envelope.data)) {
          console.warn(`[AgentWorkspace] ${type} 的载荷不是对象，已忽略：`, envelope.data);
          return;
        }
        appendMessage({
          id: `sse-${String(envelope.seq)}`,
          role: 'agent',
          kind: payloadKind ?? 'text',
          // 载荷自带全部要展示的内容（计划目标、确认摘要、卡片标题），
          // 这里再编一句正文只会和卡片重复
          content: '',
          payload: envelope.data,
          createdAt: envelope.at,
        });
        return;
      }

      // ── 刷新任务面板 / 补拉结果卡 ──
      case 'task.progress':
        bumpTaskRefresh();
        return;

      case 'task.status': {
        bumpTaskRefresh();
        // 成功意味着结果可能已经产出：去把 output.card 捞回来
        const status = readTextField(envelope.data, 'status');
        const taskId = readTextField(envelope.data, 'taskId');
        if (status === 'success' && taskId !== null) void pullResultCard(taskId);
        return;
      }

      case 'asset.changed': {
        // 产出资产意味着任务刚写完结果，结果卡可能已经落库
        const taskId = readTextField(envelope.data, 'taskId');
        if (taskId !== null) void pullResultCard(taskId);
        return;
      }

      case 'content.changed':
      case 'workflow.advanced':
        // 内容与流程推进都可能改变任务列表，刷新面板即可
        bumpTaskRefresh();
        return;

      default:
        // 新增事件类型却漏了分支 → 这一行编译报错。
        // 运行时不可达：类型已在 isKnownEventType 那里收窄过。
        exhaustive(type);
        return;
    }
  }

  const stream = useSessionStream({ sessionId, onEvent: handleEvent });

  /**
   * 发送一条消息。
   *
   * 失败时**抛出**：输入区据此保留用户刚敲的内容；可见的错误提示在本函数里给出
   * （输入区不知道失败原因，也不该替调用方编一份文案）。
   */
  const sendMessage = useCallback(
    async (text: string, referencedAssetIds: string[]): Promise<void> => {
      if (loadState.kind !== 'ready') {
        toast('会话还没准备好，请稍候再试。', 'error');
        throw new Error('会话尚未就绪');
      }
      const currentSessionId = loadState.session.id;

      // 本轮开始：清掉上一轮遗留的回显指纹，并登记「本轮在途」
      echoedRound.current = null;
      roundInFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await apiFetch<ChatResponse>('/api/agent/chat', {
          method: 'POST',
          body: JSON.stringify({
            projectId: projectIdValue,
            message: text,
            // 没有会话时不传 sessionId：后端会按 projectId 建一个新会话
            ...(currentSessionId.length > 0 ? { sessionId: currentSessionId } : {}),
            referencedAssetIds,
          }),
          signal: controller.signal,
        });

        // 会话可能是这一轮才创建的：采纳它，SSE 才能订阅到后续事件
        if (response.sessionId.length > 0 && response.sessionId !== currentSessionId) {
          adoptSession(response.sessionId);
        }

        /*
         * 用户消息与回复一起追加，而不是发出去就先画一条：
         * 失败时对话流里不该留下一条后端并不存在的消息，
         * 而成功时用户的消息（服务端在跑 Agent 之前就落库了）必须看得见。
         */
        localSeq.current += 1;
        appendMessage({
          id: `local-u${String(localSeq.current)}`,
          role: 'user',
          kind: 'text',
          content: text,
          payload: null,
          createdAt: new Date().toISOString(),
        });

        localSeq.current += 1;
        const payload = response.payload;
        appendMessage({
          id: `local-a${String(localSeq.current)}`,
          role: 'agent',
          kind: payload !== undefined ? payload.type : 'text',
          content: response.message,
          payload: payload ?? null,
          ...(Array.isArray(response.toolCalls) && response.toolCalls.length > 0
            ? { toolCalls: response.toolCalls }
            : {}),
          createdAt: new Date().toISOString(),
        });

        // 这一轮的副本已渲染：记下指纹，挡掉随后（或稍早）到达的 SSE 回显
        echoedRound.current = {
          text: response.message,
          payloadKind: payload !== undefined ? payload.type : null,
        };

        setContextNotes(contextNotesOf(response));
        // 一轮对话可能刚创建了任务（例如计划已提交），面板立刻刷一次
        bumpTaskRefresh();
      } catch (err) {
        // 用户主动中断不是故障：报「无法连接到服务」会把人引向错误的方向
        if (!controller.signal.aborted) {
          toast(errorText(err), 'error');
        }
        // 继续抛给输入区：它据此保留用户刚敲的内容
        throw err;
      } finally {
        roundInFlight.current = false;
        abortRef.current = null;
      }
    },
    [loadState, projectIdValue, toast, adoptSession, appendMessage, bumpTaskRefresh],
  );

  /** 中断在途发送。请求被 abort 后 sendMessage 会走失败分支，输入内容因此保留 */
  const cancelSend = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /*
   * 卸载时中止在途的对话请求。
   *
   * 不清理的话，用户离开工作台后那次请求仍挂着：连接、模型额度与服务端
   * 那一轮的取消信号都还在。服务端把连接关闭当作取消（见 routes/agent.ts
   * 的 `request.raw.on('close')`），因此这里中止就是最准确的「用户走了」。
   */
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  /*
   * 从窄屏切回宽屏时收起抽屉。
   *
   * 不这么做的话，用户在窄屏打开抽屉、再把窗口拉宽，侧区与抽屉会**同时**
   * 渲染同一个 TaskPanel：两份任务轮询、两份 DOM，抽屉还盖在内容上。
   * 反向（宽 → 窄）不需要处理：窄屏下抽屉默认是关的，用户点按钮才开。
   */
  useEffect(() => {
    if (!isNarrow) setTaskDrawerOpen(false);
  }, [isNarrow]);

  /** 卡片上的「回复」类动作：把卡片带的话术作为下一条用户消息发出去 */
  const sendFromCard = useCallback(
    (text: string): void => {
      void sendMessage(text, []).catch(() => {
        // 失败提示已经在 sendMessage 里给过；卡片动作没有输入框可保留内容
      });
    },
    [sendMessage],
  );

  /**
   * 放行任务。
   *
   * 这是当前**唯一**能让高风险任务真正执行下去的入口：任务停在 `waiting_user`,
   * 只有确认接口会把它重新入队。
   */
  const confirmTasks = useCallback(
    async (input: { taskIds?: string[] }): Promise<void> => {
      const currentSessionId =
        loadState.kind === 'ready' && loadState.session.id.length > 0 ? loadState.session.id : null;
      if (currentSessionId === null) {
        toast('会话还没建立，无法确认。', 'error');
        return;
      }

      const taskIds = input.taskIds ?? [];
      try {
        const result = await apiPost<ConfirmResponse>(
          `/api/agent/sessions/${currentSessionId}/confirm`,
          /*
           * 拿得到精确 id 就一定要带上：不传 `taskIds` 时后端会放行该会话下
           * **全部** waiting_user 任务，而用户看到的并确认的只是眼前这一组。
           * 只有载荷里确实没有 id（旧数据）时才退化为「全部」。
           */
          taskIds.length > 0 ? { taskIds } : {},
        );
        toast(confirmFeedback(result), result.resumed.length > 0 ? 'success' : 'info');
        // 放行会立刻推进任务状态（waiting_user → pending），面板马上刷新
        bumpTaskRefresh();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
    [loadState, toast, bumpTaskRefresh],
  );

  /** 结果卡上的通用动作 */
  const handleAction = useCallback(
    (action: CardAction): void => {
      if (action.message !== undefined && action.message.length > 0) {
        sendFromCard(action.message);
        return;
      }
      /*
       * 没有配套话术的动作（例如「查看时间线」）前端无法凭空构造请求。
       * 明确说出来，而不是让按钮点了没反应。
       */
      toast(`「${action.label}」还没有对应的入口。`, 'info');
    },
    [sendFromCard, toast],
  );

  return (
    <div className={styles.workspace}>
      <div className={styles.main}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            {loadState.kind === 'ready' ? loadState.session.title || '新会话' : '工作台'}
          </h1>
          <div className={styles.headerActions}>
            {/*
              资产库入口：**始终显示**。
              窄屏那个「任务」按钮是另一回事（侧区被 CSS 收起时的补救入口），
              而资产库在这个页面上没有别的可达路径 —— 藏起来就等于没有。
            */}
            <Link className={styles.headerAction} to={`/projects/${projectIdValue}/assets`}>
              资产
            </Link>
            {/*
              窄屏才显示的任务入口。
              窄屏时侧区被 CSS 收起，没有这个按钮，用户就**永远看不到任务面板** ——
              进度、上下文说明、失败原因全都失去入口。
            */}
            {isNarrow ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setTaskDrawerOpen(true)}
                aria-expanded={taskDrawerOpen}
              >
                <Icon name="chevron-right" />
                任务
              </Button>
            ) : null}
          </div>
        </header>

        {/*
          降级提示：连接断了、或业务事件陈旧时都显示。
          绝不静默 —— 用户必须知道当前进度可能不是最新的。
        */}
        {stream.degraded ? (
          <div className={styles.banner} role="status">
            <Icon name="alert" />
            <span>实时连接已中断，正在重连。当前进度可能不是最新的。</span>
          </div>
        ) : null}

        {/*
          模型未配置：后端会回落 Mock，链路照常跑通但产出全是占位数据。
          不把这件事说出来，用户就会把「示例文本-878」当成模型答复 ——
          这正是 spec §10 第 4 条禁止的静默失败。
          `placeholderOnly === true` 才提示；状态没拉到（null）时**不**提示，
          把网络故障说成「你没配模型」会把人引到错误的排查方向。
        */}
        {modelStatus?.placeholderOnly === true ? (
          <div className={styles.banner} role="status">
            <Icon name="alert" />
            <span>当前没有可用的模型配置，Agent 的回复与生成结果都是占位内容。</span>
            <Link className={styles.bannerLink} to="/settings/providers">
              去配置模型
            </Link>
          </div>
        ) : null}

        <div className={styles.scroll} ref={scrollRef}>
          {loadState.kind === 'loading' ? <SkeletonLines lines={6} /> : null}
          {loadState.kind === 'error' ? (
            <ErrorState
              title="加载会话失败"
              reason={loadState.message}
              {...(loadState.suggestions.length > 0 ? { suggestions: loadState.suggestions } : {})}
              {...(loadState.retryable
                ? {
                    onRetry: () => {
                      void load();
                    },
                  }
                : {})}
            />
          ) : null}
          {loadState.kind === 'ready' && hasEarlier ? (
            <div className={styles.loadEarlier}>
              {/* 块体写法：`no-void` 只允许 void 作语句 */}
              <Button
                onClick={() => {
                  void loadEarlier();
                }}
                loading={loadingEarlier}
              >
                加载更早的消息
              </Button>
            </div>
          ) : null}
          {loadState.kind === 'ready' ? (
            <MessageList
              messages={messages}
              onSendMessage={sendFromCard}
              onConfirm={(input) => {
                void confirmTasks(input);
              }}
              onAction={handleAction}
              assetIndex={assetIndex}
              projectId={projectIdValue}
            />
          ) : null}
        </div>

        {loadState.kind === 'ready' ? (
          <div className={styles.composerSlot}>
            <Composer
              projectId={projectIdValue}
              onSend={sendMessage}
              disabled={projectIdValue.length === 0}
              onCancel={cancelSend}
              onAssetCreated={() => {
                // 新建之后项目里的资产清单变了：重建索引，让刚打的 @名字 立刻可点
                setAssetIndexToken((token) => token + 1);
              }}
            />
          </div>
        ) : null}
      </div>

      {/*
        侧区的两副形态二选一，**不同时存在**：
        - 宽屏：`.side` 常驻右栏
        - 窄屏：CSS 已把 `.side` 隐藏，改挂进抽屉，由顶部「任务」按钮唤出

        用 JS 二选一而不是「都渲染、靠 CSS 藏一个」：后者会让 TaskPanel
        同时存在两份，各自轮询一次 `/api/tasks`，白白翻倍请求。
      */}
      {isNarrow ? null : (
        <aside className={styles.side}>
          <TaskPanel
            sessionId={sessionId}
            degraded={stream.degraded}
            contextNotes={contextNotes}
            refreshSignal={taskRefreshSignal}
          />
        </aside>
      )}

      <Drawer
        open={isNarrow && taskDrawerOpen}
        title="任务"
        side="right"
        onClose={() => setTaskDrawerOpen(false)}
      >
        <TaskPanel
          sessionId={sessionId}
          degraded={stream.degraded}
          contextNotes={contextNotes}
          refreshSignal={taskRefreshSignal}
        />
      </Drawer>
    </div>
  );
}
