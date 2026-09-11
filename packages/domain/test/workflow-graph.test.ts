/**
 * 工作流图算法测试
 *
 * 这些纯函数是 Workflow Engine 的核心，API 与 Worker 共用。
 * 它们不依赖数据库，因此可以完整覆盖边界情况：
 * 环检测、拓扑分层、就绪判断、失败传播、整体完成判定。
 */
import { describe, expect, it } from 'vitest';

import {
  computeReadyNodes,
  detectCycle,
  initRunState,
  isRunFinished,
  topologicalLayers,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowNodeState,
  type WorkflowRunState,
} from '../src/index.js';

/**
 * 把某节点置为指定状态。
 *
 * 用显式辅助函数而非 `state.nodes.a!` 非空断言：
 * 断点会抹掉「节点可能不存在」的编译期保护，一旦 key 写错，
 * 报错会延迟到难以定位的地方。这里改为立即抛出并指明 key。
 */
function setNodeState(
  state: WorkflowRunState,
  key: string,
  next: WorkflowNodeState['state'],
): void {
  const node = state.nodes[key];
  if (!node) throw new Error(`测试用例引用了不存在的节点：${key}`);
  state.nodes[key] = { ...node, state: next };
}

/** 构造一个合法的最小工作流 */
function wf(nodes: Array<{ key: string; dependsOn?: string[]; continueOnError?: boolean }>): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    type: 'test',
    name: '测试流程',
    nodes: nodes.map((n) => ({
      key: n.key,
      title: n.key,
      dependsOn: n.dependsOn ?? [],
      continueOnError: n.continueOnError ?? false,
    })),
  });
}

describe('detectCycle', () => {
  it('无环时返回 null', () => {
    expect(detectCycle(wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]).nodes)).toBeNull();
  });

  it('自依赖被 Schema 拒绝', () => {
    expect(() => wf([{ key: 'a', dependsOn: ['a'] }])).toThrow(/不能依赖自身/);
  });

  it('检测出直接环', () => {
    // 直接构造节点绕过 Schema（Schema 会先拒绝环）
    const nodes = wf([{ key: 'a' }, { key: 'b' }]).nodes.map((n) =>
      n.key === 'a' ? { ...n, dependsOn: ['b'] } : { ...n, dependsOn: ['a'] },
    );
    const cycle = detectCycle(nodes);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });

  it('Schema 拒绝含环的定义', () => {
    expect(() =>
      workflowDefinitionSchema.parse({
        type: 'test',
        name: '环形流程',
        nodes: [
          { key: 'a', title: 'a', dependsOn: ['c'] },
          { key: 'b', title: 'b', dependsOn: ['a'] },
          { key: 'c', title: 'c', dependsOn: ['b'] },
        ],
      }),
    ).toThrow(/存在环/);
  });

  it('Schema 拒绝悬空依赖', () => {
    expect(() => wf([{ key: 'a', dependsOn: ['ghost'] }])).toThrow(/不存在的节点/);
  });

  it('Schema 拒绝重复 key', () => {
    expect(() => wf([{ key: 'a' }, { key: 'a' }])).toThrow(/key 重复/);
  });
});

describe('topologicalLayers', () => {
  it('串行链路产生与节点数相同的层数', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }, { key: 'c', dependsOn: ['b'] }]);
    expect(topologicalLayers(definition.nodes)).toEqual([['a'], ['b'], ['c']]);
  });

  it('无依赖的节点归入同一层（可并行）', () => {
    const definition = wf([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
    expect(topologicalLayers(definition.nodes)).toEqual([['a', 'b', 'c']]);
  });

  it('菱形依赖产生正确的三层结构', () => {
    const definition = wf([
      { key: 'root' },
      { key: 'left', dependsOn: ['root'] },
      { key: 'right', dependsOn: ['root'] },
      { key: 'join', dependsOn: ['left', 'right'] },
    ]);
    const layers = topologicalLayers(definition.nodes);
    expect(layers).toEqual([['root'], ['left', 'right'], ['join']]);
  });

  it('层内节点按字典序稳定排序（保证结果可复现）', () => {
    const definition = wf([{ key: 'zebra' }, { key: 'apple' }, { key: 'mango' }]);
    expect(topologicalLayers(definition.nodes)).toEqual([['apple', 'mango', 'zebra']]);
  });

  it('跨层依赖以最深层为准', () => {
    const definition = wf([
      { key: 'a' },
      { key: 'b', dependsOn: ['a'] },
      { key: 'c', dependsOn: ['a'] },
      { key: 'd', dependsOn: ['b', 'c'] },
    ]);
    const layers = topologicalLayers(definition.nodes);
    expect(layers).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});

describe('initRunState', () => {
  it('初始化所有节点为 pending 并记录总层数', () => {
    const definition = wf([
      { key: 'a' },
      { key: 'b', dependsOn: ['a'] },
      { key: 'c', dependsOn: ['a'] },
    ]);
    const state = initRunState(definition);
    expect(Object.keys(state.nodes).sort()).toEqual(['a', 'b', 'c']);
    expect(state.nodes.a?.state).toBe('pending');
    expect(state.totalLayers).toBe(2);
    expect(state.currentLayer).toBe(0);
  });
});

describe('computeReadyNodes', () => {
  it('初始状态只有无依赖节点就绪', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const state = initRunState(definition);
    expect(computeReadyNodes(definition, state).ready).toEqual(['a']);
  });

  it('上游成功后下游变为就绪', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'succeeded');
    expect(computeReadyNodes(definition, state).ready).toEqual(['b']);
  });

  it('多个上游全部成功后才就绪', () => {
    const definition = wf([
      { key: 'a' },
      { key: 'b' },
      { key: 'c', dependsOn: ['a', 'b'] },
    ]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'succeeded');
    expect(computeReadyNodes(definition, state).ready).toEqual(['b']);

    setNodeState(state, 'b', 'succeeded');
    expect(computeReadyNodes(definition, state).ready).toEqual(['c']);
  });

  it('上游失败且未配置 continueOnError 时下游被跳过', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'failed');
    const result = computeReadyNodes(definition, state);
    expect(result.ready).toEqual([]);
    expect(result.skipped).toEqual(['b']);
  });

  it('上游失败但配置了 continueOnError 时下游仍可执行', () => {
    const definition = wf([
      { key: 'a' },
      { key: 'b', dependsOn: ['a'], continueOnError: true },
    ]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'failed');
    expect(computeReadyNodes(definition, state).ready).toEqual(['b']);
  });

  it('上游 skipped 同样会传播跳过', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'skipped');
    expect(computeReadyNodes(definition, state).skipped).toEqual(['b']);
  });

  it('已完成的节点不会重复就绪（幂等）', () => {
    const definition = wf([{ key: 'a' }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'succeeded');
    expect(computeReadyNodes(definition, state).ready).toEqual([]);
  });

  it('running 状态的上游会阻塞下游', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'running');
    expect(computeReadyNodes(definition, state).ready).toEqual([]);
  });
});

describe('isRunFinished', () => {
  it('仍有 pending 节点时未完成', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const state = initRunState(definition);
    expect(isRunFinished(definition, state)).toEqual({ finished: false, success: false });
  });

  it('全部成功时完成且成功', () => {
    const definition = wf([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'succeeded');
    setNodeState(state, 'b', 'succeeded');
    expect(isRunFinished(definition, state)).toEqual({ finished: true, success: true });
  });

  it('存在失败节点时完成但判定失败', () => {
    const definition = wf([{ key: 'a' }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'failed');
    expect(isRunFinished(definition, state)).toEqual({ finished: true, success: false });
  });

  it('失败但允许继续的节点不影响整体成功判定', () => {
    const definition = wf([{ key: 'a', continueOnError: true }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'failed');
    expect(isRunFinished(definition, state)).toEqual({ finished: true, success: true });
  });

  it('running 节点视为未完成', () => {
    const definition = wf([{ key: 'a' }]);
    const state = initRunState(definition);
    setNodeState(state, 'a', 'running');
    expect(isRunFinished(definition, state).finished).toBe(false);
  });
});
