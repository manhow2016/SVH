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
import type { AssetFieldsPatch, AssetLibraryRefView, AssetPatch, ProductionRepository } from "./repository";
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
  defaultEpisodeName,
  validateEpisodeDescription,
  validateEpisodeName,
  validateEpisodeOrder,
} from "./episode/episode";
import type {
  CreateEpisodeInput,
  ProductionEpisode,
  UpdateEpisodeInput,
} from "./episode/episode-types";
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
  validateAssetLibPath,
  validateAssetName,
  validateAssetUrl,
  validateWorkspacePath,
  ASSET_LIBRARY_META_KEY,
} from "./asset/asset";
import type { AssetType, CreateAssetInput, ProductionAsset } from "./asset/asset-types";
import { normalizeVisualStyleProfile } from "./style/visual-style-types";
import type { CreateGenerationRecordInput, GenerationRecord } from "./generation/generation-record-types";
import { nextGenerationVersion } from "./generation/generation-record-types";
import { applyApprove, applyReject, applyReplace } from "./generation/generation-record";

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
    // 短剧多集（V0.3）：项目创建即含「第 1 集」（角色/资产跨集共享，无需每集初始化）
    return this.repo.transaction(async (repo) => {
      const project = await repo.createProject({
        workspaceId: input.workspaceId,
        userId: owner.userId ?? "",
        name,
        type,
        status: "draft",
        settings,
        description,
      });
      await repo.createEpisode({ projectId: project.id, order: 1, name: defaultEpisodeName(1) });
      return project;
    });
  }

  // ================= Episode（短剧多集，V0.3） =================

  async listEpisodes(projectId: string): Promise<ProductionEpisode[]> {
    await this.getProject(projectId);
    return this.repo.listEpisodes(projectId);
  }

  async createEpisode(input: CreateEpisodeInput): Promise<ProductionEpisode> {
    await this.getProject(input.projectId);
    const episodes = await this.repo.listEpisodes(input.projectId);
    const order = input.order === undefined ? nextOrder(episodes.map((e) => e.order), 1) : validateEpisodeOrder(input.order);
    return this.repo.createEpisode({
      projectId: input.projectId,
      order,
      name: validateEpisodeName(input.name ?? defaultEpisodeName(order)),
      description: validateEpisodeDescription(input.description),
    });
  }

  async updateEpisode(id: string, patch: UpdateEpisodeInput): Promise<ProductionEpisode> {
    await this.getEpisode(id); // 存在性校验（不存在抛 NOT_FOUND）
    const next: UpdateEpisodeInput = {};
    if (patch.name !== undefined) {
      next.name = validateEpisodeName(patch.name);
    }
    if (patch.description !== undefined) {
      next.description = validateEpisodeDescription(patch.description);
    }
    if (patch.order !== undefined) {
      next.order = validateEpisodeOrder(patch.order);
    }
    if (Object.keys(next).length === 0) {
      throw validationError("updateEpisode 至少需要一个可更新字段");
    }
    const updated = await this.repo.updateEpisode(id, next);
    if (!updated) {
      throw notFoundError("集");
    }
    return updated;
  }

  async deleteEpisode(id: string): Promise<void> {
    const episode = await this.getEpisode(id);
    const episodes = await this.repo.listEpisodes(episode.projectId);
    if (episodes.length <= 1) {
      throw validationError("项目至少保留一集，不能删除");
    }
    // 其下剧本/场景/时间轴由外键 SET NULL 解除挂载（数据保留，可从别集/新集重新挂载）
    await this.repo.deleteEpisode(id);
  }

  async getEpisode(id: string): Promise<ProductionEpisode> {
    const episode = await this.repo.getEpisode(id);
    if (!episode) {
      throw notFoundError("集");
    }
    return episode;
  }

  /** 归属校验：集必须属于该项目（创建剧本/场景/时间轴前调用） */
  async assertEpisodeInProject(episodeId: string, projectId: string): Promise<ProductionEpisode> {
    const episode = await this.getEpisode(episodeId);
    if (episode.projectId !== projectId) {
      throw validationError(`集 ${episodeId} 不属于项目 ${projectId}`);
    }
    return episode;
  }

  /** 集归属解析：指定集校验归属；未指定归入项目最小集号的一集（保证数据不落「无集」） */
  private async resolveEpisodeId(
    episodeId: string | undefined,
    projectId: string,
  ): Promise<string | undefined> {
    if (episodeId !== undefined) {
      await this.assertEpisodeInProject(episodeId, projectId);
      return episodeId;
    }
    const episodes = await this.repo.listEpisodes(projectId);
    return episodes.length > 0 ? episodes[0]!.id : undefined;
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
    // 多集（V0.3）：指定集则校验归属；未指定默认归入第 1 集
    const episodeId = await this.resolveEpisodeId(input.episodeId, input.projectId);
    return this.repo.createScript({
      projectId: input.projectId,
      episodeId,
      title: validateScriptTitle(input.title),
      content: validateScriptContent(input.content),
      version,
      status,
    });
  }

  async listScripts(projectId: string, episodeId?: string): Promise<ProductionScript[]> {
    return this.repo.listScripts(projectId, episodeId);
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

  async deleteScript(id: string): Promise<void> {
    await this.getScript(id);
    await this.repo.deleteScript(id);
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
      voice: normalizeOptionalText(input.voice, "voice"),
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
    if (patch.voiceAssetId !== undefined) {
      if (patch.voiceAssetId === null || patch.voiceAssetId.trim() === "") {
        // null / 空串显式清空（与 updateAssetFields 的 null = 清列语义一致；undefined = 不动）
        next.voiceAssetId = null;
      } else {
        const asset = await this.getAsset(patch.voiceAssetId.trim());
        if (asset.projectId !== (await this.getCharacter(id)).projectId || asset.type !== "audio") {
          throw validationError("音色资产不合法：必须属于该项目且类型为音频");
        }
        next.voiceAssetId = asset.id;
      }
    }
    if (patch.visualProfile !== undefined) {
      next.visualProfile = normalizeVisualProfile(patch.visualProfile);
    }
    if (patch.voice !== undefined) {
      next.voice = normalizeOptionalText(patch.voice, "voice");
    }
    return this.repo.updateCharacter(id, next);
  }

  async deleteCharacter(id: string): Promise<void> {
    await this.getCharacter(id);
    await this.repo.deleteCharacter(id);
  }

  // ================= Scene =================

  async createScene(input: CreateSceneInput): Promise<ProductionScene> {
    await this.getProject(input.projectId);
    if (input.scriptId !== undefined) {
      await this.assertScriptInProject(input.scriptId, input.projectId);
    }
    // 多集（V0.3）：指定集校验归属；未指定默认归入第 1 集
    const episodeId = await this.resolveEpisodeId(input.episodeId, input.projectId);
    const scenes = await this.repo.listScenes(input.projectId);
    const order =
      input.order === undefined ? nextOrder(scenes.map((s) => s.order)) : validateSceneOrder(input.order);
    return this.repo.createScene({
      projectId: input.projectId,
      episodeId,
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

  async listScenes(projectId: string, episodeId?: string): Promise<ProductionScene[]> {
    const scenes = await this.repo.listScenes(projectId, episodeId);
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

  async deleteScene(id: string): Promise<void> {
    await this.getScene(id);
    // 场景下的分镜/镜头由数据库外键级联删除（productionStoryboards.sceneId / productionShots.storyboardId
    // 均为 onDelete cascade，client.ts 已开启 foreign_keys）。
    await this.repo.deleteScene(id);
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

  async deleteStoryboard(id: string): Promise<void> {
    await this.getStoryboard(id);
    // 分镜下的镜头由外键级联删除；生成记录的 shotId/storyboardId 为非外键可空引用，保留为孤儿记录。
    await this.repo.deleteStoryboard(id);
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

  async listShots(projectId: string, episodeId?: string): Promise<ProductionShot[]> {
    return this.repo.listShots(projectId, episodeId);
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
    if (patch.audioAssetId !== undefined) {
      next.audioAssetId = patch.audioAssetId?.trim() || undefined;
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

  async deleteShot(id: string): Promise<void> {
    await this.getShot(id);
    await this.repo.deleteShot(id);
  }

  // ================= Asset =================

  async createAsset(input: CreateAssetInput): Promise<ProductionAsset> {
    const project = await this.getProject(input.projectId);
    if (!isAssetType(input.type)) {
      throw validationError(
        "资产类型不合法，可选：image / video / audio / document / subtitle / reference",
      );
    }
    const asset = await this.repo.createAsset({
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
    // 资产库引用：写引用行 + metadata.libraryPath（预览源由前端据 metadata 生成）
    if (input.assetLibPath !== undefined) {
      const libPath = validateAssetLibPath(input.assetLibPath);
      await this.repo.createAssetLibraryRef({
        projectId: input.projectId,
        assetId: asset.id,
        libPath,
      });
      const updated = await this.repo.updateAssetFields(asset.id, {
        metadata: { ...(asset.metadata ?? {}), [ASSET_LIBRARY_META_KEY]: libPath },
      });
      return updated ?? asset;
    }
    return asset;
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

  /** 按任务 id 反查产物资产（generation.taskId 匹配；无匹配返回 null） */
  async findAssetByTask(taskId: string): Promise<ProductionAsset | null> {
    if (typeof taskId !== "string" || taskId.trim() === "") {
      throw validationError("taskId 不能为空");
    }
    return this.repo.findAssetByTask(taskId);
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

  /**
   * 资产通用更新（制作中心人工编辑名称/类型/URL/媒体类型）。
   * 与窄更新 updateAssetFields 区分：后者只允许转存回写的三列。
   */
  async updateAsset(
    id: string,
    patch: { name?: string; type?: AssetType; url?: string; mimeType?: string },
  ): Promise<ProductionAsset> {
    await this.getAsset(id);
    const next: AssetPatch = {};
    if (patch.name !== undefined) {
      next.name = validateAssetName(patch.name);
    }
    if (patch.type !== undefined) {
      if (!isAssetType(patch.type)) {
        throw validationError("资产类型不合法");
      }
      next.type = patch.type;
    }
    if (patch.url !== undefined) {
      next.url = validateAssetUrl(patch.url);
    }
    if (patch.mimeType !== undefined) {
      next.mimeType = patch.mimeType?.trim() || undefined;
    }
    const updated = await this.repo.updateAsset(id, next);
    if (!updated) {
      throw notFoundError("资产");
    }
    return updated;
  }

  async deleteAsset(id: string): Promise<void> {
    await this.getAsset(id);
    await this.repo.deleteAsset(id);
    // 引用行由 DB 外键 ON DELETE CASCADE 自动清理（asset_id → production_asset_library_refs）
  }

  /** 列出引用指定资产库文件夹下文件的全部项目资产（文件夹删除前的引用检查数据源） */
  async listAssetLibraryRefsByFolder(folder: string): Promise<AssetLibraryRefView[]> {
    return this.repo.listAssetLibraryRefsByFolder(folder);
  }

  // ================= Character 方案（角色面板：形象方案批次） =================

  /** 方案元数据标记（与 worker/server 契约字面量一致） */
  static readonly SCHEME_META_KEY = "svhRole";
  static readonly SCHEME_META_ROLE = "character_scheme";

  /** 该角色的全部方案资产（跨批）：metadata 打标 svhRole=character_scheme 且 characterId 匹配的 image 资产 */
  private async listCharacterSchemeAssets(
    projectId: string,
    characterId: string,
  ): Promise<ProductionAsset[]> {
    const { SCHEME_META_KEY, SCHEME_META_ROLE } = ProductionService;
    const assets = await this.listAssets(projectId, "image");
    return assets.filter((a) => {
      const m = a.metadata ?? {};
      return m[SCHEME_META_KEY] === SCHEME_META_ROLE && m.characterId === characterId;
    });
  }

  /**
   * 角色当前方案批次：metadata 打标 svhRole=character_scheme 且 characterId 匹配的
   * image 资产，按 batchId 分组取「最新批」（批内 seq 升序）。无批次 → batchId=null。
   */
  async listCharacterSchemes(
    projectId: string,
    characterId: string,
  ): Promise<{ batchId: string | null; schemes: ProductionAsset[] }> {
    const tagged = await this.listCharacterSchemeAssets(projectId, characterId);
    if (tagged.length === 0) return { batchId: null, schemes: [] };
    const byBatch = new Map<string, ProductionAsset[]>();
    for (const a of tagged) {
      const batchId = String(a.metadata?.batchId ?? "");
      if (!batchId) continue;
      byBatch.set(batchId, [...(byBatch.get(batchId) ?? []), a]);
    }
    const latest = [...byBatch.entries()].sort((x, y) => {
      const ax = Math.max(...x[1].map((a) => a.createdAt.getTime()));
      const ay = Math.max(...y[1].map((a) => a.createdAt.getTime()));
      return ay - ax;
    })[0];
    if (!latest) return { batchId: null, schemes: [] };
    const schemes = latest[1].slice().sort((a, b) => {
      const sa = Number(a.metadata?.seq ?? 0);
      const sb = Number(b.metadata?.seq ?? 0);
      return sa - sb;
    });
    return { batchId: latest[0], schemes };
  }

  /**
   * 删除角色时清理其全部方案资产（跨批逐条删除；单条失败吞掉不阻断，残留可接受）。
   * 与 listCharacterSchemes 只返回「最新批」不同，此处理清全部批次（旧批同样为孤儿资产）。
   */
  async deleteCharacterSchemes(characterId: string): Promise<void> {
    // 角色所属项目：经角色反查
    const character = await this.getCharacter(characterId);
    const schemes = await this.listCharacterSchemeAssets(character.projectId, characterId);
    for (const s of schemes) {
      try {
        await this.repo.deleteAsset(s.id);
      } catch {
        /* 单条失败不阻断 */
      }
    }
  }

  // ================= Generation Record（V0.3 Phase 5：生成历史 + 审核） =================

  /** 创建生成记录：入队时登记；同 shot 内版本号自动递增 */
  async createGenerationRecord(input: CreateGenerationRecordInput): Promise<GenerationRecord> {
    const project = await this.getProject(input.projectId);
    let shot;
    if (input.shotId) {
      shot = await this.getShot(input.shotId);
      if (shot.projectId !== project.id) {
        throw notFoundError("镜头");
      }
    }
    let version = 1;
    if (input.shotId) {
      const existing = await this.repo.listGenerationRecordsByShot(input.shotId);
      version = nextGenerationVersion(existing);
    }
    return this.repo.createGenerationRecord({
      projectId: input.projectId,
      shotId: input.shotId,
      storyboardId: input.storyboardId,
      kind: input.kind,
      version,
      providerId: input.providerId,
      modelId: input.modelId,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      promptMetadata: input.promptMetadata,
      inputRef: input.inputRef,
      taskId: input.taskId,
      outputAssetId: undefined,
      status: "queued",
      reviewStatus: "pending",
      selected: false,
    });
  }

  async listGenerationRecords(
    projectId: string,
    filter?: Parameters<ProductionRepository["listGenerationRecords"]>[1],
  ): Promise<GenerationRecord[]> {
    await this.getProject(projectId);
    return this.repo.listGenerationRecords(projectId, filter);
  }

  async listGenerationsByShot(shotId: string): Promise<GenerationRecord[]> {
    await this.getShot(shotId);
    return this.repo.listGenerationRecordsByShot(shotId);
  }

  async getGenerationRecord(id: string): Promise<GenerationRecord> {
    const record = await this.repo.getGenerationRecord(id);
    if (!record) {
      throw notFoundError("生成记录");
    }
    return record;
  }

  /** 审核通过：标记 approved + selected，并把该镜头当前选中资产指向产出资产 */
  async approveGeneration(id: string): Promise<GenerationRecord> {
    const record = await this.getGenerationRecord(id);
    const patch = applyApprove(record);
    // 若关联镜头，则把「选中资产」指向本次产出（image/video 各按类型）
    if (record.shotId && record.outputAssetId) {
      const shot = await this.getShot(record.shotId);
      if (record.kind === "image") {
        await this.updateShot(record.shotId, { imageAssetId: record.outputAssetId });
      } else {
        await this.updateShot(record.shotId, { videoAssetId: record.outputAssetId });
      }
      void shot;
    }
    const updated = await this.repo.updateGenerationRecord(id, patch);
    if (!updated) {
      throw notFoundError("生成记录");
    }
    return updated;
  }

  /** 审核拒绝：标记 rejected（保留记录与资产，不覆盖） */
  async rejectGeneration(id: string): Promise<GenerationRecord> {
    const record = await this.getGenerationRecord(id);
    const patch = applyReject(record);
    const updated = await this.repo.updateGenerationRecord(id, patch);
    if (!updated) {
      throw notFoundError("生成记录");
    }
    return updated;
  }

  /** 替换资产：指定新的产出资产，标记 replaced + selected */
  async replaceGeneration(id: string, assetId: string): Promise<GenerationRecord> {
    const record = await this.getGenerationRecord(id);
    await this.getAsset(assetId);
    const patch = applyReplace(assetId);
    if (record.shotId) {
      const shot = await this.getShot(record.shotId);
      if (record.kind === "image") {
        await this.updateShot(record.shotId, { imageAssetId: assetId });
      } else {
        await this.updateShot(record.shotId, { videoAssetId: assetId });
      }
      void shot;
    }
    const updated = await this.repo.updateGenerationRecord(id, patch);
    if (!updated) {
      throw notFoundError("生成记录");
    }
    return updated;
  }

  /** worker 任务完成回写：按任务 id 将生成记录标记为 completed 并挂上产出资产（幂等；无匹配行静默） */
  async markGenerationRecordsCompletedByTask(taskId: string, outputAssetId: string): Promise<void> {
    if (typeof taskId !== "string" || taskId.trim() === "") {
      throw validationError("taskId 不能为空");
    }
    if (typeof outputAssetId !== "string" || outputAssetId.trim() === "") {
      throw validationError("outputAssetId 不能为空");
    }
    await this.repo.updateGenerationRecordsByTask(taskId, {
      status: "completed",
      outputAssetId: outputAssetId.trim(),
    });
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
