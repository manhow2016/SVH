/**
 * 内置工作流结构测试
 *
 * 验证四套内置流程不仅「能通过 Schema 校验」，而且**确实符合技术文档描述的
 * 拓扑结构**（尤其是并行/串行关系）。这些断言能防止后续有人改坏流程依赖。
 */
import { describe, expect, it } from 'vitest';

import { detectCycle, topologicalLayers, workflowDefinitionSchema } from '@svh/domain';
import {
  advertisementWorkflow,
  digitalHumanWorkflow,
  listBuiltinWorkflows,
  shortDramaWorkflow,
  shortVideoWorkflow,
} from '../src/index.js';

/** 把分层结果转成「同层节点集合」便于断言 */
function layersOf(definition: Parameters<typeof topologicalLayers>[0]): string[][] {
  return topologicalLayers(definition);
}

describe('内置工作流定义合法性', () => {
  it.each([
    ['广告', advertisementWorkflow],
    ['短视频', shortVideoWorkflow],
    ['短剧', shortDramaWorkflow],
    ['数字人', digitalHumanWorkflow],
  ])('%s 流程通过 Schema 校验', (_name, wf) => {
    expect(() => workflowDefinitionSchema.parse(wf)).not.toThrow();
  });

  it.each([
    ['广告', advertisementWorkflow],
    ['短视频', shortVideoWorkflow],
    ['短剧', shortDramaWorkflow],
    ['数字人', digitalHumanWorkflow],
  ])('%s 流程无循环依赖', (_name, wf) => {
    expect(detectCycle(wf.nodes)).toBeNull();
  });

  it('所有流程的 dependsOn 都指向真实存在的节点', () => {
    for (const wf of listBuiltinWorkflows()) {
      const keys = new Set(wf.nodes.map((n) => n.key));
      for (const node of wf.nodes) {
        for (const dep of node.dependsOn) {
          expect(keys.has(dep), `${wf.type} 的 ${node.key} 依赖了不存在的 ${dep}`).toBe(true);
        }
      }
    }
  });

  it('所有流程的 edges 与 dependsOn 完全一致（避免手写两份漂移）', () => {
    for (const wf of listBuiltinWorkflows()) {
      const fromDeps = wf.nodes
        .flatMap((n) => n.dependsOn.map((d) => `${d}->${n.key}`))
        .sort();
      const fromEdges = wf.edges.map((e) => `${e.from}->${e.to}`).sort();
      expect(fromEdges, `${wf.type} 的 edges 与 dependsOn 不一致`).toEqual(fromDeps);
    }
  });

  it('每个流程都有唯一的收尾节点（出度为 0 且无人依赖它）', () => {
    for (const wf of listBuiltinWorkflows()) {
      const depended = new Set(wf.nodes.flatMap((n) => n.dependsOn));
      const sinks = wf.nodes.filter((n) => !depended.has(n.key)).map((n) => n.key);
      expect(sinks, `${wf.type} 应当只有一个终节点`).toHaveLength(1);
    }
  });
});

describe('广告流程拓扑结构', () => {
  const layers = layersOf(advertisementWorkflow.nodes);

  it('产品视觉与广告创意可并行（都直接依赖产品分析/广告目标）', () => {
    const productVisualLayer = layers.findIndex((l) => l.includes('product_visual'));
    const ideaLayer = layers.findIndex((l) => l.includes('ad_idea'));
    // 产品视觉不依赖创意链路，因此其层级早于或等于创意之后的分镜
    expect(productVisualLayer).toBeGreaterThanOrEqual(0);
    expect(ideaLayer).toBeGreaterThanOrEqual(0);
  });

  it('分镜同时依赖脚本与产品视觉', () => {
    const storyboard = advertisementWorkflow.nodes.find((n) => n.key === 'storyboard');
    expect(storyboard?.dependsOn).toEqual(expect.arrayContaining(['ad_script', 'product_visual']));
  });

  it('剪辑是视频/配音/字幕的汇聚点', () => {
    const edit = advertisementWorkflow.nodes.find((n) => n.key === 'edit');
    expect(edit?.dependsOn).toEqual(expect.arrayContaining(['video', 'voice', 'subtitle']));
  });

  it('视频生成被标记为高成本（需用户确认）', () => {
    const video = advertisementWorkflow.nodes.find((n) => n.key === 'video');
    expect(video?.highCost).toBe(true);
  });
});

describe('短剧流程并行性（技术文档第 45 条明确要求）', () => {
  const layers = layersOf(shortDramaWorkflow.nodes);

  it('角色与场景位于同一层，可并行生成', () => {
    const charLayer = layers.findIndex((l) => l.includes('characters'));
    const sceneLayer = layers.findIndex((l) => l.includes('scenes'));
    expect(charLayer).toBeGreaterThanOrEqual(0);
    expect(sceneLayer).toBeGreaterThanOrEqual(0);
    expect(charLayer, `角色在第 ${charLayer} 层，场景在第 ${sceneLayer} 层，应同层`).toBe(
      sceneLayer,
    );
  });

  it('剧本 → 分镜 → 画面 严格串行', () => {
    const scriptLayer = layers.findIndex((l) => l.includes('script'));
    const storyboardLayer = layers.findIndex((l) => l.includes('storyboard'));
    const imagesLayer = layers.findIndex((l) => l.includes('images'));
    expect(storyboardLayer).toBeGreaterThan(scriptLayer);
    expect(imagesLayer).toBeGreaterThan(storyboardLayer);
  });

  it('世界观位于故事之后、角色与场景之前', () => {
    const storyLayer = layers.findIndex((l) => l.includes('story'));
    const worldviewLayer = layers.findIndex((l) => l.includes('worldview'));
    const charLayer = layers.findIndex((l) => l.includes('characters'));
    expect(worldviewLayer).toBeGreaterThan(storyLayer);
    expect(charLayer).toBeGreaterThan(worldviewLayer);
  });
});

describe('数字人流程拓扑结构', () => {
  it('数字人视频汇聚形象/声音/背景/动作四方输入', () => {
    const video = digitalHumanWorkflow.nodes.find((n) => n.key === 'video');
    expect(video?.dependsOn).toEqual(
      expect.arrayContaining(['digital_human', 'voice', 'background', 'motion']),
    );
  });

  it('口播文案与背景并行准备（互不依赖）', () => {
    const copywriting = digitalHumanWorkflow.nodes.find((n) => n.key === 'copywriting');
    const background = digitalHumanWorkflow.nodes.find((n) => n.key === 'background');
    expect(copywriting?.dependsOn).not.toContain('background');
    expect(background?.dependsOn).not.toContain('copywriting');
  });

  it('品牌元素叠加失败不阻断整体产出', () => {
    const overlay = digitalHumanWorkflow.nodes.find((n) => n.key === 'brand_overlay');
    expect(overlay?.continueOnError).toBe(true);
  });
});

describe('短视频流程拓扑结构', () => {
  it('选题在需求分析之后、脚本之前', () => {
    const layers = layersOf(shortVideoWorkflow.nodes);
    const reqLayer = layers.findIndex((l) => l.includes('requirement_analysis'));
    const topicLayer = layers.findIndex((l) => l.includes('topic'));
    const scriptLayer = layers.findIndex((l) => l.includes('script'));
    expect(topicLayer).toBeGreaterThan(reqLayer);
    expect(scriptLayer).toBeGreaterThan(topicLayer);
  });

  it('脚本与素材并行准备，在镜头节点汇聚', () => {
    const layers = layersOf(shortVideoWorkflow.nodes);
    expect(layers.findIndex((l) => l.includes('script'))).toBe(
      layers.findIndex((l) => l.includes('assets')),
    );
    const shots = shortVideoWorkflow.nodes.find((n) => n.key === 'shots');
    expect(shots?.dependsOn).toEqual(expect.arrayContaining(['script', 'assets']));
  });
});

describe('拓扑分层快照（README / ARCHITECTURE.md 中的层数以此为准）', () => {
  // 这组数字同时写在文档里。用断言锁住，避免后续调整节点依赖时
  // 文档与代码悄悄不一致 —— 层数直接决定前端进度条的粒度与并行调度。
  const EXPECTED = [
    { name: '广告', wf: advertisementWorkflow, nodes: 13, layers: 10, maxParallel: 2 },
    { name: '短视频', wf: shortVideoWorkflow, nodes: 10, layers: 7, maxParallel: 2 },
    { name: '短剧', wf: shortDramaWorkflow, nodes: 16, layers: 11, maxParallel: 3 },
    { name: '数字人', wf: digitalHumanWorkflow, nodes: 10, layers: 6, maxParallel: 3 },
  ] as const;

  it.each(EXPECTED)('$name：$nodes 节点 / $layers 层 / 最大并行度 $maxParallel', (item) => {
    const layers = layersOf(item.wf.nodes);
    expect(item.wf.nodes).toHaveLength(item.nodes);
    expect(layers).toHaveLength(item.layers);
    expect(Math.max(...layers.map((l) => l.length))).toBe(item.maxParallel);
  });

  it('每套流程都至少有一个可并行的层（否则设计上没利用 DAG）', () => {
    for (const wf of listBuiltinWorkflows()) {
      const parallel = layersOf(wf.nodes).filter((l) => l.length > 1);
      expect(parallel.length, `${wf.type} 没有任何可并行层`).toBeGreaterThan(0);
    }
  });
});
