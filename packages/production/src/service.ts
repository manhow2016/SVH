/**
 * ProductionService（文档 §6：领域编排 + 规则执行）。
 *
 * 只依赖 ProductionRepository Port 与领域规则，禁止：
 * - 直接访问数据库（SQL / drizzle）
 * - 发起 HTTP / 调用 AI API
 * - 依赖 server / web 层
 *
 * 所有实体 id 使用 @svh/shared randomId；校验失败抛 ProductionError。
 */
import type { AssetFieldsPatch, ProductionRepository } from "./repository";
import { notFoundError, conflictError, validationError } from "./errors";
import {
  applyProjectStatus,
  isProjectStatus,
  isProjectType,
  normalizeProjectSettings,
  validateProjectDescription,
  validateProjectName,
} from "./project/project";
import type {
  CreateProjectInput,
  ProductionProject,
  UpdateProjectInput,
} from "./project/project-types";
import {
  bumpScriptVersion,
  canTransitionScriptStatus,
  isScriptStatus,
  validateScriptContent,
  validateScriptTitle,
} from "./script/script";
import type {
  CreateScriptInput,
  ProductionScript,
  UpdateScriptInput,
} from "./script/script-types";
import {
  normalizeAppearance,
  normalizeOptionalText,
  normalizeVisualProfile,
  validateCharacterDescription,
  validateCharacterName,
} from "./character/character";
import type {
  Character,
  CreateCharacterInput,
  UpdateCharacterInput,
} from "./character/character-types";
import {
  nextOrder,
  normalizeCharacters,
  normalizeOptionalString,
  sortByOrder,
  validateSceneDescription,
  validateSceneName,
  validateSceneOrder,
} from "./scene/scene";
import type {
  CreateSceneInput,
  ProductionScene,
  UpdateSceneInput,
} from "./scene/scene-types";
import {
  isStoryboardStatus,
  normalizeOptionalPrompt,
  validateShotType,
  validateStoryboardDescription,
  validateStoryboardDuration,
} from "./storyboard/storyboard";
import type {
  CreateStoryboardInput,
  Storyboard,
  UpdateStoryboardInput,
} from "./storyboard/storyboard-types";
import {
  applyShotStatus,
  assertShotsWithinStoryboardDuration,
  normalizeOptionalShotText,
  validateShotDuration,
} from "./shot/shot";
import type { CreateShotInput, ProductionShot, UpdateShotInput } from "./shot/shot-types";
import {
  isAssetType,
  normalizeAssetMetadata,
  validateAssetGeneration,
  validateAssetName,
  validateAssetUrl,
  validateWorkspacePath,
} from "./asset/asset";
import type { AssetType, CreateAssetInput, ProductionAsset } from "./asset/asset-types";
import { normalizeVisualStyleProfile } from "./style/visual-style-types";

/** 项目默认类型（平台定位为短剧生产） */
const DEFAULT_PROJECT_TYPE = "short_drama" as const;

export class ProductionService {
  constructor(private readonly repo: ProductionRepository) {}

  // ================= Project =================

  /** 创建项目：从 workspace 推断归属用户，返回带 id/时间的完整实体 */
  async createProject(input: CreateProjectInput): Promise<ProductionProject> {
    const owner = await this.repo.getWorkspaceOwner(input.workspaceId);
    if (!owner) {
      throw notFoundError("工作区");
    }
    const name = validateProjectName(input.name);
    const type = input.type === undefined ? DEFAULT_PROJECT_TYPE : this.assertProjectType(input.type);
    const settings = normalizeProjectSettings(input.settings);
    const description = validateProjectDescription(input.description);
    return this.repo.createProject({
      workspaceId: input.workspaceId,
      userId: owner.userId ?? "",
      name,
      type,
      status: "draft",
      settings,
      description,
    });
  }

  async listProjects(workspaceId: string): Promise<ProductionProject[]> {
    return this.repo.listProjects(workspaceId);
  }

  async getProject(id: string): Promise<ProductionProject> {
    const project = await this.repo.getProject(id);
    if (!project) {
      throw notFoundError("项目");
    }
    return project;
  }

  /** 项目归属校验：确保项目属于指定工作区（工具/路由隔离用；不匹配时隐藏存在性，同样抛 NOT_FOUND） */
  async getProjectForWorkspace(id: string, workspaceId: string): Promise<ProductionProject> {
    const project = await this.getProject(id);
    if (project.workspaceId !== workspaceId) {
      throw notFoundError("项目");
    }
    return project;
  }

  async updateProject(id: string, patch: UpdateProjectInput): Promise<ProductionProject> {
    const current = await this.getProject(id);
    const next: UpdateProjectInput = {};
    if (patch.name !== undefined) {
      next.name = validateProjectName(patch.name);
    }
    if (patch.description !== undefined) {
      next.description = validateProjectDescription(patch.description);
    }
    if (patch.type !== undefined) {
      next.type = this.assertProjectType(patch.type);
    }
    if (patch.settings !== undefined) {
      next.settings = normalizeProjectSettings(patch.settings);
    }
    if (patch.status !== undefined) {
      if (!isProjectStatus(patch.status)) {
        throw validationError("项目状态不合法");
      }
      if (patch.status !== current.status) {
        next.status = applyProjectStatus(current.status, patch.status);
      }
    }
    return this.repo.updateProject(id, next);
  }

  // ================= Script =================

  async createScript(input: CreateScriptInput): Promise<ProductionScript> {
    await this.getProject(input.projectId);
    const version = 1;
    let status = input.status ?? "draft";
    if (!isScriptStatus(status)) {
      throw validationError("剧本状态不合法");
    }
    if (status === "approved") {
      // 首次创建不允许直接通过审核（需走 d→r→a 流程）
      status = "draft";
    }
    return this.repo.createScript({
      projectId: input.projectId,
      title: validateScriptTitle(input.title),
      content: validateScriptContent(input.content),
      version,
      status,
    });
  }

  async listScripts(projectId: string): Promise<ProductionScript[]> {
    return this.repo.listScripts(projectId);
  }

  async getScript(id: string): Promise<ProductionScript> {
    const script = await this.repo.getScript(id);
    if (!script) {
      throw notFoundError("剧本");
    }
    return script;
  }

  async updateScript(id: string, patch: UpdateScriptInput): Promise<ProductionScript> {
    const current = await this.getScript(id);
    const next: UpdateScriptInput = {};
    if (patch.title !== undefined) {
      next.title = validateScriptTitle(patch.title);
    }
    if (patch.content !== undefined) {
      next.content = validateScriptContent(patch.content);
      if (patch.content !== current.content) {
        // 内容变更：版本 +1 且回退为草稿（编辑使既有审核失效）
        next.version = bumpScriptVersion(current.version);
        next.status = "draft";
      }
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      if (!isScriptStatus(patch.status)) {
        throw validationError("剧本状态不合法");
      }
      if (!canTransitionScriptStatus(current.status, patch.status)) {
        throw conflictError(`剧本状态不允许从 ${current.status} 变更到 ${patch.status}`);
      }
      next.status = patch.status;
    }
    return this.repo.updateScript(id, next);
  }

  // ================= Character =================

  async createCharacter(input: CreateCharacterInput): Promise<Character> {
    await this.getProject(input.projectId);
    const referenceAssetId = input.referenceAssetId?.trim() || undefined;
    return this.repo.createCharacter({
      projectId: input.projectId,
      name: validateCharacterName(input.name),
      description: validateCharacterDescription(input.description),
      appearance: normalizeAppearance(input.appearance),
      personality: normalizeOptionalText(input.personality, "personality"),
      referenceAssetId,
      visualProfile: normalizeVisualProfile(input.visualProfile),
    });
  }

  async listCharacters(projectId: string): Promise<Character[]> {
    return this.repo.listCharacters(projectId);
  }

  async getCharacter(id: string): Promise<Character> {
    const character = await this.repo.getCharacter(id);
    if (!character) {
      throw notFoundError("角色");
    }
    return character;
  }

  async updateCharacter(id: string, patch: UpdateCharacterInput): Promise<Character> {
    const next: UpdateCharacterInput = {};
    if (patch.name !== undefined) {
      next.name = validateCharacterName(patch.name);
    }
    if (patch.description !== undefined) {
      next.description = validateCharacterDescription(patch.description);
    }
    if (patch.appearance !== undefined) {
      next.appearance = normalizeAppearance(patch.appearance);
    }
    if (patch.personality !== undefined) {
      next.personality = normalizeOptionalText(patch.personality, "personality");
    }
    if (patch.referenceAssetId !== undefined) {
      next.referenceAssetId = patch.referenceAssetId?.trim() || undefined;
    }
    if (patch.visualProfile !== undefined) {
      next.visualProfile = normalizeVisualProfile(patch.visualProfile);
    }
    return this.repo.updateCharacter(id, next);
  }

  // ================= Scene =================

  async createScene(input: CreateSceneInput): Promise<ProductionScene> {
    await this.getProject(input.projectId);
    if (input.scriptId !== undefined) {
      await this.assertScriptInProject(input.scriptId, input.projectId);
    }
    const scenes = await this.repo.listScenes(input.projectId);
    const order =
      input.order === undefined ? nextOrder(scenes.map((s) => s.order)) : validateSceneOrder(input.order);
    return this.repo.createScene({
      projectId: input.projectId,
      scriptId: normalizeOptionalString(input.scriptId, "scriptId"),
      order,
      name: validateSceneName(input.name),
      description: validateSceneDescription(input.description),
      location: normalizeOptionalString(input.location, "location"),
      time: normalizeOptionalString(input.time, "time"),
      characters: normalizeCharacters(input.characters),
      visualStyle: normalizeVisualStyleProfile(input.visualStyle),
    });
  }

  async listScenes(projectId: string): Promise<ProductionScene[]> {
    const scenes = await this.repo.listScenes(projectId);
    return sortByOrder(scenes);
  }

  async getScene(id: string): Promise<ProductionScene> {
    const scene = await this.repo.getScene(id);
    if (!scene) {
      throw notFoundError("场景");
    }
    return scene;
  }

  async updateScene(id: string, patch: UpdateSceneInput): Promise<ProductionScene> {
    const next: UpdateSceneInput = {};
    if (patch.name !== undefined) {
      next.name = validateSceneName(patch.name);
    }
    if (patch.description !== undefined) {
      next.description = validateSceneDescription(patch.description);
    }
    if (patch.location !== undefined) {
      next.location = normalizeOptionalString(patch.location, "location");
    }
    if (patch.time !== undefined) {
      next.time = normalizeOptionalString(patch.time, "time");
    }
    if (patch.characters !== undefined) {
      next.characters = normalizeCharacters(patch.characters);
    }
    if (patch.order !== undefined) {
      next.order = validateSceneOrder(patch.order);
    }
    if (patch.scriptId !== undefined) {
      const scriptId = normalizeOptionalString(patch.scriptId, "scriptId");
      if (scriptId !== undefined) {
        const current = await this.getScene(id);
        await this.assertScriptInProject(scriptId, current.projectId);
      }
      next.scriptId = scriptId;
    }
    if (patch.visualStyle !== undefined) {
      next.visualStyle = normalizeVisualStyleProfile(patch.visualStyle);
    }
    return this.repo.updateScene(id, next);
  }

  // ================= Storyboard =================

  async createStoryboard(input: CreateStoryboardInput): Promise<Storyboard> {
    await this.getProject(input.projectId);
    await this.assertSceneInProject(input.sceneId, input.projectId);
    const scenes = await this.repo.listStoryboardsByScene(input.sceneId);
    const order =
      input.order === undefined ? nextOrder(scenes.map((s) => s.order)) : validateSceneOrder(input.order);
    return this.repo.createStoryboard({
      projectId: input.projectId,
      sceneId: input.sceneId,
      order,
      description: validateStoryboardDescription(input.description),
      duration: validateStoryboardDuration(input.duration),
      shotType: validateShotType(input.shotType),
      cameraMovement: normalizeOptionalPrompt(input.cameraMovement, "cameraMovement"),
      imagePrompt: normalizeOptionalPrompt(input.imagePrompt, "imagePrompt"),
      videoPrompt: normalizeOptionalPrompt(input.videoPrompt, "videoPrompt"),
      status: input.status === undefined ? "draft" : this.assertStoryboardStatus(input.status),
    });
  }

  async listStoryboards(projectId: string): Promise<Storyboard[]> {
    return this.repo.listStoryboards(projectId);
  }

  async listStoryboardsByScene(sceneId: string): Promise<Storyboard[]> {
    return this.repo.listStoryboardsByScene(sceneId);
  }

  async getStoryboard(id: string): Promise<Storyboard> {
    const storyboard = await this.repo.getStoryboard(id);
    if (!storyboard) {
      throw notFoundError("分镜");
    }
    return storyboard;
  }

  async updateStoryboard(id: string, patch: UpdateStoryboardInput): Promise<Storyboard> {
    await this.getStoryboard(id);
    const next: UpdateStoryboardInput = {};
    if (patch.description !== undefined) {
      next.description = validateStoryboardDescription(patch.description);
    }
    if (patch.shotType !== undefined) {
      next.shotType = validateShotType(patch.shotType);
    }
    if (patch.cameraMovement !== undefined) {
      next.cameraMovement = normalizeOptionalPrompt(patch.cameraMovement, "cameraMovement");
    }
    if (patch.imagePrompt !== undefined) {
      next.imagePrompt = normalizeOptionalPrompt(patch.imagePrompt, "imagePrompt");
    }
    if (patch.videoPrompt !== undefined) {
      next.videoPrompt = normalizeOptionalPrompt(patch.videoPrompt, "videoPrompt");
    }
    if (patch.order !== undefined) {
      next.order = validateSceneOrder(patch.order);
    }
    if (patch.status !== undefined) {
      next.status = this.assertStoryboardStatus(patch.status);
    }
    if (patch.duration !== undefined) {
      const duration = validateStoryboardDuration(patch.duration);
      const shots = await this.repo.listShotsByStoryboard(id);
      const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
      assertShotsWithinStoryboardDuration(total, duration);
      next.duration = duration;
    }
    return this.repo.updateStoryboard(id, next);
  }

  // ================= Shot =================

  async createShot(input: CreateShotInput): Promise<ProductionShot> {
    const storyboard = await this.repo.getStoryboard(input.storyboardId);
    if (!storyboard) {
      throw notFoundError("分镜");
    }
    if (storyboard.projectId !== input.projectId) {
      throw notFoundError("分镜");
    }
    const duration = validateShotDuration(input.duration);
    const shots = await this.repo.listShotsByStoryboard(input.storyboardId);
    const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
    assertShotsWithinStoryboardDuration(total + duration, storyboard.duration);
    const order =
      input.order === undefined ? nextOrder(shots.map((s) => s.order)) : validateSceneOrder(input.order);
    return this.repo.createShot({
      projectId: input.projectId,
      storyboardId: input.storyboardId,
      order,
      duration,
      framing: normalizeOptionalShotText(input.framing, "framing"),
      cameraMovement: normalizeOptionalShotText(input.cameraMovement, "cameraMovement"),
      action: normalizeOptionalShotText(input.action, "action"),
      dialogue: normalizeOptionalShotText(input.dialogue, "dialogue"),
      visualStyle: normalizeVisualStyleProfile(input.visualStyle),
      status: "pending",
    });
  }

  async listShots(projectId: string): Promise<ProductionShot[]> {
    return this.repo.listShots(projectId);
  }

  async listShotsByStoryboard(storyboardId: string): Promise<ProductionShot[]> {
    return this.repo.listShotsByStoryboard(storyboardId);
  }

  async getShot(id: string): Promise<ProductionShot> {
    const shot = await this.repo.getShot(id);
    if (!shot) {
      throw notFoundError("镜头");
    }
    return shot;
  }

  async updateShot(id: string, patch: UpdateShotInput): Promise<ProductionShot> {
    const current = await this.getShot(id);
    const next: UpdateShotInput = {};
    if (patch.framing !== undefined) {
      next.framing = normalizeOptionalShotText(patch.framing, "framing");
    }
    if (patch.cameraMovement !== undefined) {
      next.cameraMovement = normalizeOptionalShotText(patch.cameraMovement, "cameraMovement");
    }
    if (patch.action !== undefined) {
      next.action = normalizeOptionalShotText(patch.action, "action");
    }
    if (patch.dialogue !== undefined) {
      next.dialogue = normalizeOptionalShotText(patch.dialogue, "dialogue");
    }
    if (patch.imageAssetId !== undefined) {
      next.imageAssetId = patch.imageAssetId?.trim() || undefined;
    }
    if (patch.videoAssetId !== undefined) {
      next.videoAssetId = patch.videoAssetId?.trim() || undefined;
    }
    if (patch.order !== undefined) {
      next.order = validateSceneOrder(patch.order);
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      next.status = applyShotStatus(current.status, patch.status);
    }
    if (patch.visualStyle !== undefined) {
      next.visualStyle = normalizeVisualStyleProfile(patch.visualStyle);
    }
    if (patch.duration !== undefined && patch.duration !== current.duration) {
      const duration = validateShotDuration(patch.duration);
      const storyboard = await this.repo.getStoryboard(current.storyboardId);
      if (!storyboard) {
        throw notFoundError("分镜");
      }
      const shots = await this.repo.listShotsByStoryboard(current.storyboardId);
      const otherTotal = shots.reduce((sum, shot) => (shot.id === id ? sum : sum + shot.duration), 0);
      assertShotsWithinStoryboardDuration(otherTotal + duration, storyboard.duration);
      next.duration = duration;
    }
    return this.repo.updateShot(id, next);
  }

  // ================= Asset =================

  async createAsset(input: CreateAssetInput): Promise<ProductionAsset> {
    const project = await this.getProject(input.projectId);
    if (!isAssetType(input.type)) {
      throw validationError(
        "资产类型不合法，可选：image / video / audio / document / subtitle / reference",
      );
    }
    return this.repo.createAsset({
      projectId: input.projectId,
      workspaceId: project.workspaceId,
      userId: project.userId,
      type: input.type,
      name: validateAssetName(input.name),
      url: validateAssetUrl(input.url),
      workspacePath: validateWorkspacePath(input.workspacePath),
      mimeType: input.mimeType?.trim() || undefined,
      metadata: normalizeAssetMetadata(input.metadata),
      generation: validateAssetGeneration(input.generation),
    });
  }

  async listAssets(projectId: string, type?: AssetType): Promise<ProductionAsset[]> {
    if (type !== undefined && !isAssetType(type)) {
      throw validationError("资产类型不合法");
    }
    return this.repo.listAssets(projectId, type);
  }

  async getAsset(id: string): Promise<ProductionAsset> {
    const asset = await this.repo.getAsset(id);
    if (!asset) {
      throw notFoundError("资产");
    }
    return asset;
  }

  /**
   * 资产窄更新（本地化转存回写专用，设计文档 §4）。
   *
   * 语义：只写 patch 中出现的键（null = 清列，键缺省 = 不动），其余列原样保留；
   * patch 无任何键视为调用方 bug（VALIDATION）。存在性校验与 getAsset 同款错误口径。
   */
  async updateAssetFields(id: string, patch: AssetFieldsPatch): Promise<ProductionAsset> {
    await this.getAsset(id);
    const next: AssetFieldsPatch = {};
    let touched = false;
    if (patch.workspacePath !== undefined) {
      next.workspacePath =
        patch.workspacePath === null ? null : (validateWorkspacePath(patch.workspacePath) ?? null);
      touched = true;
    }
    if (patch.metadata !== undefined) {
      next.metadata = patch.metadata === null ? null : (normalizeAssetMetadata(patch.metadata) ?? null);
      touched = true;
    }
    if (patch.mimeType !== undefined) {
      if (patch.mimeType !== null && typeof patch.mimeType !== "string") {
        throw validationError("mimeType 必须为字符串");
      }
      next.mimeType = patch.mimeType?.trim() || null;
      touched = true;
    }
    if (!touched) {
      throw validationError("updateAssetFields 至少需要一个待更新字段");
    }
    const updated = await this.repo.updateAssetFields(id, next);
    if (!updated) {
      throw notFoundError("资产");
    }
    return updated;
  }

  async deleteAsset(id: string): Promise<void> {
    await this.getAsset(id);
    await this.repo.deleteAsset(id);
  }

  // ================= 内部规则辅助 =================

  private assertProjectType(type: unknown): ProductionProject["type"] {
    if (!isProjectType(type)) {
      throw validationError("项目类型不合法，可选：short_video / short_drama / animation / advertisement");
    }
    return type;
  }

  private assertStoryboardStatus(status: unknown): Storyboard["status"] {
    if (!isStoryboardStatus(status)) {
      throw validationError("分镜状态不合法");
    }
    return status;
  }

  private async assertScriptInProject(scriptId: string, projectId: string): Promise<void> {
    const script = await this.repo.getScript(scriptId);
    if (!script || script.projectId !== projectId) {
      throw notFoundError("剧本");
    }
  }

  private async assertSceneInProject(sceneId: string, projectId: string): Promise<void> {
    const scene = await this.repo.getScene(sceneId);
    if (!scene || scene.projectId !== projectId) {
      throw notFoundError("场景");
    }
  }
}
