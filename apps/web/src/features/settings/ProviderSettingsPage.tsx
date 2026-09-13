import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { EmptyState, ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch, apiPost } from '../../lib/api.js';
import type { ModelProviderView, PageBody, TestConnectionResult } from '../../lib/api-types.js';
import styles from './ProviderSettingsPage.module.css';

/**
 * 页面状态。
 *
 * 用可辨识联合而不是 `{ loading, error, providers }` 三个独立字段：
 * 后者允许「同时在加载又有错误」这类自相矛盾的状态存在，界面只能靠 if 顺序兜底。
 */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; providers: ModelProviderView[] }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

/** 健康状态 → 中文标签与样式。文字是必需的，颜色只是强化。 */
const HEALTH: Record<ModelProviderView['health'], { label: string; className: string }> = {
  healthy: { label: '正常', className: styles.healthy ?? '' },
  degraded: { label: '不稳定', className: styles.degraded ?? '' },
  down: { label: '不可用', className: styles.down ?? '' },
  unknown: { label: '未检测', className: styles.unknown ?? '' },
};

/** Provider 类型的中文标签 */
const KIND_LABEL: Record<string, string> = {
  openai_compatible: 'OpenAI 兼容',
  anthropic_compatible: 'Anthropic 兼容',
  gemini_compatible: 'Gemini 兼容',
  mock: '本地模拟',
  custom: '自定义',
};

/**
 * 模型服务配置页。
 *
 * ── 本页最硬的一条约束 ──
 * **密钥只写不读**：表单里输入一次，之后界面只显示服务端给的掩码
 * （`apiKeyMask`，如 `sk-****abcd`）。后端 `toProviderView` 的响应结构里
 * 根本没有密钥字段，这里也不再自行保存明文 —— 提交成功即清空输入。
 */
export function ProviderSettingsPage() {
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const page = await apiFetch<PageBody<ModelProviderView>>('/api/models/providers?pageSize=50');
      setState({ kind: 'ready', providers: page.items });
    } catch (err) {
      /*
       * 直接消费 ApiError 携带的后端文案：规范要求错误必须说明
       * 「发生了什么 / 可能原因 / 下一步怎么做」，而这三件事后端已经给了。
       */
      const apiError = err instanceof ApiError ? err : null;
      setState({
        kind: 'error',
        message: apiError?.message ?? '加载模型服务失败。',
        suggestions: apiError?.suggestions ?? [],
        retryable: apiError?.retryable ?? false,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 关闭表单并清空输入。
   * 密钥是敏感值：一旦关闭，明文就不该再留在组件状态里。
   */
  function closeDialog(): void {
    setDialogOpen(false);
    setName('');
    setBaseUrl('');
    setApiKey('');
    setFormError(undefined);
  }

  async function submit(): Promise<void> {
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim();

    if (trimmedName.length === 0 || trimmedUrl.length === 0) {
      setFormError('名称与服务地址都不能为空');
      return;
    }
    /*
     * 密钥在 `createModelProviderSchema` 里是必填（min 1），
     * 本地先挡住，免得用户拿到一句笼统的校验失败却不知道缺什么。
     */
    if (apiKey.trim().length === 0) {
      setFormError('API Key 不能为空');
      return;
    }

    setSubmitting(true);
    setFormError(undefined);
    try {
      await apiPost<ModelProviderView>('/api/models/providers', {
        kind: 'openai_compatible',
        name: trimmedName,
        baseUrl: trimmedUrl,
        // 密钥只在此处上行一次；服务端返回的视图里只有掩码
        apiKey,
      });
      closeDialog();
      toast.show('模型服务已添加', 'success');
      await load();
    } catch (err) {
      // 失败留在表单里：用户刚输入的地址与密钥不能因为一次失败就丢掉
      setFormError(err instanceof ApiError ? err.message : '添加失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  async function testConnection(provider: ModelProviderView): Promise<void> {
    setTesting(provider.id);
    try {
      /*
       * 后端在这里做的是**内存中覆盖凭据**的探测，不会把临时密钥写库、
       * 也不写回健康状态，因此结果只用于即时反馈，随后重新拉取列表。
       */
      const result = await apiPost<TestConnectionResult>(
        `/api/models/providers/${provider.id}/test`,
        {},
      );
      /*
       * 成败只认 `health`。
       *
       * 这里原本写的是 `result.ok === true || result.health === 'healthy'`，
       * 依据是「接口文档里写的是 `{ ok, message }`，两种形态都读」——
       * 而服务端从来不返回 `ok`，那个分支永远不会成立。`TestConnectionResult`
       * 现在是按实测形状声明的，并由 `apps/api/test/api-contract.test.ts` 钉住。
       */
      const succeeded = result.health === 'healthy';

      /*
       * 失败时把后端给出的**下一步建议**一并说出来。
       * 只讲「连接失败」等于把排查全丢回给用户，而 `suggestions` 存在的
       * 意义就是告诉他该动哪里 —— 声明了就该用上。
       */
      const suggestion = result.suggestions[0];
      const failureText = [result.message ?? '未通过连通性检测', suggestion]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' ');

      // 用临时密钥测出的结论只代表那份临时配置，必须说清楚，否则用户会以为已保存的配置没问题
      const scopeNote = result.usedTemporaryConfig ? '（用的是未保存的临时密钥）' : '';

      toast.show(
        succeeded
          ? `${provider.name} 连接成功（${String(result.latencyMs)}ms）${scopeNote}`
          : `${provider.name} 连接失败：${failureText}${scopeNote}`,
        succeeded ? 'success' : 'error',
      );
      await load();
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : '测试连接失败。', 'error');
    } finally {
      setTesting(null);
    }
  }

  const providers = state.kind === 'ready' ? state.providers : [];
  const isEmpty = state.kind === 'ready' && providers.length === 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>模型服务</h1>
        {/*
          空列表时页头不放按钮：空状态自己就带「添加模型服务」主操作，
          两处同时出现等于一个区域有两个 Primary Action。
        */}
        {isEmpty ? null : (
          <Button variant="primary" onClick={() => setDialogOpen(true)}>
            添加模型服务
          </Button>
        )}
      </header>

      {/*
        未配置任何 Provider 时，整个产品是「哑」的 —— Agent 会退回本地模拟。
        这条提示必须显眼，否则用户会以为是功能坏了。
      */}
      {isEmpty ? (
        <div className={styles.banner} role="status">
          <Icon name="alert" className={styles.bannerIcon} size={16} />
          <span>配置模型后才能开始生成内容。请先添加一个模型服务并测试连接。</span>
        </div>
      ) : null}

      {state.kind === 'loading' ? <SkeletonLines lines={4} /> : null}

      {state.kind === 'error' ? (
        <ErrorState
          title="加载模型服务失败"
          reason={state.message}
          {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
          {...(state.retryable
            ? {
                onRetry: () => {
                  void load();
                },
              }
            : {})}
        />
      ) : null}

      {isEmpty ? (
        <EmptyState
          icon="settings"
          title="还没有配置模型服务"
          description="SVH 不内置模型：你需要填入自己的 API 地址与密钥。密钥加密存储，界面上只显示掩码。"
          action={
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              添加模型服务
            </Button>
          }
        />
      ) : null}

      {providers.length > 0 ? (
        <div className={styles.list}>
          {providers.map((provider) => {
            const health = HEALTH[provider.health];
            return (
              <article key={provider.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.itemName}>{provider.name}</span>
                  {/* 文字 + 颜色双重表达：只靠颜色的状态对色觉障碍用户不可用 */}
                  <span
                    className={`${styles.badge} ${health.className}`}
                    data-health={provider.health}
                  >
                    {health.label}
                  </span>
                </div>
                <span className={styles.itemMeta}>
                  <span>{KIND_LABEL[provider.kind] ?? provider.kind}</span>
                  <span>{provider.baseUrl}</span>
                  <span>{provider.modelCount} 个模型</span>
                  {/* 只渲染掩码：完整密钥既不在响应里，也不在界面上 */}
                  {provider.apiKeyMask !== null && provider.apiKeyMask.length > 0 ? (
                    <>
                      <span>密钥</span>
                      <span>{provider.apiKeyMask}</span>
                    </>
                  ) : (
                    <span>未设置密钥</span>
                  )}
                </span>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    loading={testing === provider.id}
                    onClick={() => {
                      void testConnection(provider);
                    }}
                  >
                    测试连接
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        title="添加模型服务"
        onClose={closeDialog}
        footer={
          <>
            <Button onClick={closeDialog}>取消</Button>
            <Button
              variant="primary"
              loading={submitting}
              onClick={() => {
                void submit();
              }}
            >
              添加
            </Button>
          </>
        }
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            // 回车提交是表单的默认预期；这里不刷新页面，交给 submit()
            event.preventDefault();
            void submit();
          }}
        >
          {/*
            表单级错误：服务端拒绝的原因可能横跨多个字段（例如「名称重复」），
            挂在某一个输入框下面会把用户引向错误的字段。
          */}
          {formError !== undefined ? (
            <p className={styles.formError} role="alert">
              {formError}
            </p>
          ) : null}

          {/* 提交期间整组禁用，避免一边上行一边改值 */}
          <fieldset className={styles.formGroup} disabled={submitting}>
            <Field label="名称" htmlFor="provider-name" helper="自己认得出来即可，例如「主力中转站」">
              <input
                id="provider-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="服务地址"
              htmlFor="provider-url"
              helper="OpenAI 兼容协议的基础地址，例如 https://api.example.com/v1"
            >
              <input
                id="provider-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
            <Field
              label="API Key"
              htmlFor="provider-key"
              helper="加密存储，保存后界面只显示掩码（如 sk-****abcd）"
            >
              <input
                id="provider-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
              />
            </Field>
          </fieldset>
        </form>
      </Dialog>
    </div>
  );
}
