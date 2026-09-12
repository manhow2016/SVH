import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { EmptyState, ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch, apiPost } from '../../lib/api.js';
import type { PageBody, Project } from '../../lib/api-types.js';
import { formatRelativeTime } from '../../lib/format.js';
import styles from './ProjectListPage.module.css';

/**
 * 页面状态。
 *
 * 用可辨识联合而不是 `{ loading, error, projects }` 三个独立字段：
 * 后者允许「同时在加载又有错误」这类自相矛盾的状态存在，界面只能靠 if 顺序兜底。
 */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; projects: Project[] }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

export function ProjectListPage() {
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const page = await apiFetch<PageBody<Project>>('/api/projects?pageSize=50');
      setState({ kind: 'ready', projects: page.items });
    } catch (err) {
      /*
       * 直接消费 ApiError 携带的后端文案：规范要求错误必须说明
       * 「发生了什么 / 可能原因 / 下一步怎么做」，而这三件事后端已经给了。
       * 在这里另编一句「加载失败」只会把信息量更少的文案盖在有信息量的上面。
       */
      const apiError = err instanceof ApiError ? err : null;
      setState({
        kind: 'error',
        message: apiError?.message ?? '加载项目失败。',
        suggestions: apiError?.suggestions ?? [],
        retryable: apiError?.retryable ?? false,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // 本地校验先挡住：空名字发到后端只会换来一次无意义的往返
      setNameError('项目名称不能为空');
      return;
    }

    setSubmitting(true);
    setNameError(undefined);
    try {
      const created = await apiPost<Project>('/api/projects', { name: trimmed });
      setDialogOpen(false);
      setName('');
      toast.show(`项目「${created.name}」已创建`, 'success');
      await load();
    } catch (err) {
      // 创建失败留在对话框里：用户刚输入的内容不能因为一次失败就丢掉
      setNameError(err instanceof ApiError ? err.message : '创建失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>项目</h1>
        {/*
         * 空列表时这里**不放**按钮：空状态自己就带「新建项目」主操作，
         * 两处同时出现会让一个区域出现两个 Primary Action，
         * 也会把空状态的引导作用稀释掉（同一个动作说两遍）。
         */}
        {state.kind === 'ready' && state.projects.length > 0 ? (
          <Button variant="primary" onClick={() => setDialogOpen(true)}>
            新建项目
          </Button>
        ) : null}
      </header>

      {state.kind === 'loading' ? <SkeletonLines lines={4} /> : null}

      {state.kind === 'error' ? (
        <ErrorState
          title="加载项目失败"
          reason={state.message}
          {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
          {...(state.retryable ? { onRetry: () => { void load(); } } : {})}
        />
      ) : null}

      {state.kind === 'ready' && state.projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="还没有项目"
          description="项目是创作的容器：角色、场景、脚本与成片都归属于它。创建第一个项目后就能开始对话创作。"
          action={
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              新建项目
            </Button>
          }
        />
      ) : null}

      {state.kind === 'ready' && state.projects.length > 0 ? (
        <nav className={styles.list}>
          {state.projects.map((project) => (
            <Link key={project.id} className={styles.item} to={`/projects/${project.id}`}>
              <span className={styles.itemMain}>
                <span className={styles.itemName}>{project.name}</span>
                <span className={styles.itemMeta}>
                  {/*
                   * 「更新于」与相对时间分成两个元素，而不是拼成一个字符串：
                   * 拼起来后相对时间就不是独立文本节点，读屏与自动化都更难单独定位。
                   * 间距交给 CSS（列表本身是 flex 容器），不靠字符串里的空格。
                   */}
                  <span>更新于</span>
                  <span>{formatRelativeTime(project.updatedAt)}</span>
                </span>
              </span>
              <Icon name="chevron-right" size={16} className={styles.itemArrow} />
            </Link>
          ))}
        </nav>
      ) : null}

      <Dialog
        open={dialogOpen}
        title="新建项目"
        onClose={() => {
          setDialogOpen(false);
          setName('');
          setNameError(undefined);
        }}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={submitting}
              onClick={() => {
                void submit();
              }}
            >
              创建
            </Button>
          </>
        }
      >
        {/* 用 fieldset 而非 div：提交期间 disabled 一次禁用整组控件，避免逐个补 disabled 漏掉一个 */}
        <fieldset className={styles.formGroup} disabled={submitting}>
          <Field
            label="项目名称"
            htmlFor="project-name"
            helper="例如「护肤品广告」「古装短剧」"
            {...(nameError !== undefined ? { error: nameError } : {})}
          >
            <input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // 回车提交是表单的默认预期；handler 显式返回 void，避免惰性 Promise 被当成返回值传递
                if (event.key === 'Enter') {
                  void submit();
                }
              }}
              autoFocus
            />
          </Field>
        </fieldset>
      </Dialog>
    </div>
  );
}
