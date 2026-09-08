# SVH V0.3 实施总结（AI 短剧智能生产系统）

> 本文档是对照「SVH V0.3 技术实施文档」的落地总结。V0.2 已具备 Production / Workflow / Worker / Provider 底座，V0.3 在其上增量实现了 **Production Context、Prompt Composition、Character Consistency、Visual Style、Generation Review、Generation Orchestration** 六块能力。
>
> 实施遵循「增量开发、禁止重写既有系统」原则：Agent Runtime / ContextBuilder / Provider Registry / Workflow / Worker / 生产领域包全部**扩展复用**，未新建平行系统。
>
> 说明：本仓库当前**同一 master 分支**上另有一并行的「工作流生成节点」开发任务（`docs/superpowers/plans/2026-09-08-workflow-generation-node.md`，实现工作流 `image.generate`/`video.generate` 批量扇出节点）。V0.3 与它按分工互补，见「§5 分工与边界」。

---

## 一、实现内容（按 Phase）

### Phase 1 — Production Context（生产上下文）
- `packages/production/src/context/`：`ProjectContext / ScriptContext / CharacterContext / SceneContext / StoryboardContext / ShotContext` 投影类型 + 实体→投影映射；`ProductionContextResolver`（按 director/script/storyboard 角色加载**最小相关**投影，剧本优先已审核）；`renderProductionContext`（渲染为 System Prompt 追加块，长内容截断防 token 爆炸）。
- Core 最小扩展：`AgentRunInput.productionContext?: string`，`ContextBuilder` 作为纯文本追加到 System Prompt（Core 不依赖生产领域，保持依赖方向）。
- server 工作流节点执行器：按 `workflow.projectId + 角色` 解析并注入生产上下文；失败降级不阻断。

### Phase 2 — Prompt Composition（提示词组合）
- `packages/production/src/prompt/`：`PromptComposer` 接口 + `DefaultPromptComposer`（composeImage/composeVideo）；组合规则 `Style + Scene + Character + Shot + Camera + Action + Raw`；Negative `Global + Style + Character + Provider`（去重）；`ComposedPrompt{ prompt, negativePrompt, metadata }`；`PromptTemplate`（段顺序/连接符/全局负面）。
- server 入队链路接入：`GenerationService` 注入 `promptComposer`，入队前组合并写入 `TaskPayload(composedPrompt/composedNegative/promptMetadata)`；worker 消费已组合提示词（不在 worker 拼 Prompt）。
- 保持 `payload.prompt` = 原始描述（向后兼容）。

### Phase 3 — Character Consistency（角色一致性）
- `Character` 扩展 `visualProfile?: CharacterVisualProfile`（appearancePrompt/identityPrompt/costumePrompt/stylePrompt/negativePrompt/referenceAssetIds）；DB `production_characters.visual_profile` 列（幂等迁移）。
- `deriveCharacterPromptAnchor`：确定性派生稳定 Prompt Anchor（无 visualProfile 时由结构化外观兜底组装），**同一角色跨镜头相同 Anchor**。
- `ReferenceResolver`（角色→参考资产→Provider 能力判定→支持注入参考图，否则回退 Anchor）；`toCharacterPromptSnippets`（角色→Composer 片段带 anchor）。
- `create_character`/`update_character` 工具支持 `visualProfile`。

### Phase 4 — Visual Style（视觉风格）
- `VisualStyleProfile`（styleName/visualPrompt/lighting/colorTone/cameraStyle/renderingStyle/negativePrompt）挂 `Project.settings.visualStyle`；场景/镜头支持 `visualStyle` 覆盖（`production_scenes/shots.visual_style` 列）。
- `resolveVisualStyle`：**Shot > Scene > Project > Global** 字段级覆盖继承；无结构化风格时回退 legacy `settings.style`。
- `StyleResolver`（按项目/场景/镜头解析有效风格）；`GenerationService` 入队前注入有效风格 Prompt + negative。

### Phase 5 — Generation Review（生成审核/版本）
- 新增 `generation_records` 表（一次生成 = 一行：provider/model/prompt/negative/promptMetadata/inputRef/taskId/输出资产/状态/审核状态/版本）；`GenerationReviewStatus` 与任务状态分离。
- service：`createGenerationRecord`（同 shot 版本递增）/list/`approve`（approved + selected + 镜头选中资产）/`reject`（保留不覆盖）/`replace`。
- 独立路由 `generation-review`：创建/列出/approve/reject/replace（与并行扇出/绑定互补）。
- `normalizeError` 补充 `ProductionError → HTTP` 映射（NOT_FOUND/VALIDATION/CONFLICT → 404/400/409）。

### Phase 6 — Generation Orchestration（生成编排）
- `GenerationPlan` 领域模型（planItem：shotId/type/priority/dependencies/providerPreference/status）+ `buildGenerationPlan`（每镜头 image 项；已有首帧图则追加依赖 image 的 video 项）。
- 批量生成端点 `POST /api/projects/:id/generations/batch`：按 scope 解析镜头→构建计划→逐项入队 + 登记 generation_record。
- **Provider fallback**：`TaskPayload.fallback` 备用供应商配置；`GenerationService` 支持 `fallbackModelName` 解析；worker `runImageTask`/`runVideoTask` 依次尝试 primary→fallback，全部失败才 failed（禁止无限重试）。

---

## 二、最终验收（对照实施文档 §50）

| 验收项 | 状态 |
|---|---|
| Agent 能够理解 Production Project | ✅ Phase 1 生产上下文注入 |
| Storyboard Agent 自动获得相关 Character Context | ✅ Phase 1 + 3（含 anchor） |
| Image Generation 自动注入 Character Prompt Anchor | ◑ Phase 2/3 组合链路已支持；需在 per-shot 生成时把角色 anchor 传入 Composer（当前批量端点以镜头动作/景别为描述，角色 anchor 注入待 per-shot 上下文完整接线） |
| Image Generation 自动注入 Project Visual Style | ✅ Phase 4 |
| Video Generation 自动获得 Shot Context | ✅ Phase 1/4/6（批量按镜头生成） |
| Prompt 可以查看 | ✅ 任务 payload `composedPrompt` + review 记录 prompt |
| Prompt 可以追踪来源 | ✅ `promptMetadata`（模板/项目/类型/供应商） |
| Prompt 可以重新编辑 | ◑ 支持重建生成记录；「编辑 prompt 后 regenerate」端点未单独提供（可经 batch/创建记录） |
| Generation 支持版本 | ✅ Phase 5（同 shot 版本递增） |
| Generation 支持 Regenerate | ◑ 域层支持创建 v+1 记录；「regenerate」端点 + 自动重入队未单独提供（由 batch/创建记录替代） |
| Generation 支持 Approve | ✅ Phase 5 |
| Generation 支持 Reject | ✅ Phase 5 |
| Generation 支持 Replace | ✅ Phase 5 |
| Shot 可以选择最终 Asset | ✅ Phase 5（approve/replace 设置 shot.imageAssetId/videoAssetId） |
| 支持批量生成 | ✅ Phase 6（batch 端点） |
| 支持 Provider Fallback | ✅ Phase 6 |
| 支持 Worker Concurrency | ◑ 未实现（按用户决策暂缓；worker 已有抓取 limit 基础） |
| Workflow 可以等待用户审核 | ✅ 本次（`review.generation` 节点：`waiting_user` 挂起 → 制作中心审核（approve/reject/replace）→ 自动续跑；引擎等待/恢复重入 + 审核裁定四态） |
| 工作流生成节点端到端接线 | ✅ 本次（`createWorkflow withGeneration` 追加 images/videos/review 节点、executorFactory 分发 `image.generate`/`video.generate`/`review.generation`、`SVH_WORKFLOW_GEN_POLL_MS/MAX_WAIT_MS`、WorkflowPanel 复选框/节点标签/摘要行/等待提示条） |
| 生成记录状态链路 | ✅ 本次（工作流入队自动登记生成记录；worker 完成后按 taskId 回写 `status=completed` + `outputAssetId`，制作中心审核按钮真实可用） |
| 成片组装（compose） | ✅ 本次（`video.compose` 节点：图片/视频段 ffmpeg 合成 mp4 落工作区；配音/字幕独立交付；@ffmpeg-installer 免系统安装） |
| 配音/字幕（TTS + SRT） | ✅ 本次（audio 任务 + openai-compatible TTS + 角色音色 + audio.generate/subtitle.generate 节点 + 音频转存） |
| 所有旧 Production 功能保持兼容 | ✅ 全量 typecheck / build / 测试通过 |

图例：✅ 已实现 ◑ 部分实现 / 待接线

---

## 三、验证

- `pnpm typecheck`：全 10 包通过。
- `pnpm build`：全包编译成功（含 web vite 构建）。
- `pnpm lint`：通过。
- 测试：`packages/production`(114)、`packages/core`(13)、`packages/database`(3)、`packages/providers`(21)、`apps/server`(122)、`apps/worker`(42)。
- 每次改动均按 Phase 单独 commit。

---

## 四、后续待办

1. **Worker Concurrency 分级预算**（global/provider/project）——用户决策暂缓。
2. **制作中心人工 CRUD 与审核 UI**：已完成（剧本/角色/场景/分镜/资产 编辑删除、镜头规格编辑、Prompt Inspector 可编辑重新生成、资产手动录入/编辑）。
3. **工作流人类审核节点**：已完成（见上表）。

> 说明：以上 2/3 项已在后续轮次实现并提交（制作中心 CRUD、Prompt Inspector 可编辑、工作流 waiting_user 审核门控 + 生成节点接线）。

---

## 五、分工与边界（与并行「工作流生成节点」代理）

- **并行代理**：工作流级别 `image.generate`/`video.generate` 节点——批量扇出分镜 → 队列 → 等待终态 → 绑定资产 → 幂等/取消/超时（新增 `workflowId/nodeId/storyboardId` 列、`generation-node-executor`、`findAssetByTask`）。
- **本 V0.3 实施（我）**：生产域**上下文/提示词组合/角色与风格一致性/生成审核与版本/生成计划与 Provider fallback**（新增 `generation_records`、`generation-review` 路由、`GenerationPlan`、worker fallback），并提供 `ProductionError→HTTP` 映射。两者互补，重叠处（生成记录/资产绑定）以「generation_records + 镜头选中资产」统一。
