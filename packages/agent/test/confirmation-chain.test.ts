/**
 * 确认链路测试
 *
 * 守护的是一个具体缺陷：高风险技能必须**创建真实的待确认任务**，
 * 否则用户点「确认执行」时后端无事可做，而界面显示已确认 ——
 * 这正是技术文档第 66、78 条禁止的「看似成功的失败」。
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentTaskPort } from '../src/ports.js';
import { buildAgentTools } from '../src/tools.js';
import { createTestDeps } from './helpers.js';

/**
 * 高成本技能目录项。
 *
 * `risk: 'high'` 是本条缺陷的触发条件；`queue` / `implemented` 与技能目录同形
 * （Agent 的技能端口不读这两项），其余字段是端口声明要求的必需字段。
 */
const HIGH_RISK_SKILL = {
  id: 'video.generate',
  name: '视频生成',
  description: '根据分镜画面生成视频片段',
  category: 'video',
  risk: 'high' as const,
  accessTier: 'pro' as const,
  capabilities: ['video'],
  aliases: ['生成视频'],
  queue: 'ai_video' as const,
  implemented: true,
};

describe('高风险技能的确认链路', () => {
  it('需要确认时会创建 waiting_user 任务，而不是凭空返回', async () => {
    const enqueue = vi.fn<AgentTaskPort['enqueue']>().mockResolvedValue({
      taskId: 'task_waiting_1',
      status: 'waiting_user',
      deduplicated: false,
    });

    const deps = createTestDeps({
      skills: {
        listImplemented: () => [HIGH_RISK_SKILL],
      },
      tasks: { enqueue },
    });

    const tools = buildAgentTools({ deps });
    const tool = tools.find((t) => t.name === 'skill.execute');
    expect(tool).toBeDefined();

    const result = await tool?.execute(
      { skillId: 'video.generate', input: { prompt: '一段测试视频' } },
      {
        sessionId: 'sess_1',
        projectId: 'proj_1',
        contentId: null,
        confirmationPolicy: 'reject',
        signal: new AbortController().signal,
        recordCall: () => undefined,
      },
    );

    // 必须要求确认
    expect(result?.requiresConfirmation).toBe(true);
    // 关键：必须真的创建了任务，并且以 waiting_user 落库
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].initialStatus).toBe('waiting_user');
    // 关键：taskId 要回传给上层，确认载荷才有真实对象
    expect((result?.result as { taskId?: string } | undefined)?.taskId).toBe('task_waiting_1');
  });

  it('confirmationPolicy 为 allow 时直接入队执行', async () => {
    const enqueue = vi.fn<AgentTaskPort['enqueue']>().mockResolvedValue({
      taskId: 'task_run_1',
      status: 'pending',
      deduplicated: false,
    });

    const deps = createTestDeps({
      skills: { listImplemented: () => [HIGH_RISK_SKILL] },
      tasks: { enqueue },
    });

    const tools = buildAgentTools({ deps });
    const tool = tools.find((t) => t.name === 'skill.execute');

    const result = await tool?.execute(
      { skillId: 'video.generate', input: {} },
      {
        sessionId: 'sess_1',
        projectId: 'proj_1',
        contentId: null,
        confirmationPolicy: 'allow',
        signal: new AbortController().signal,
        recordCall: () => undefined,
      },
    );

    expect(result?.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].initialStatus).toBeUndefined();
  });
});
