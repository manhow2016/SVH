/**
 * Production 仓储适配层（drizzle + better-sqlite3 实现 @svh/production 的 Port）。
 *
 * drizzle 适配器与领域包同包维护（server 与 worker 共用）。本层是领域与数据库之间的 Adapter：
 * - 只做「行 ↔ 实体」映射与查询，不包含领域规则（规则在 ProductionService）
 * - JSON 列（settings/appearance/characters/metadata/generation）由 drizzle
 *   mode:"json" 自动序列化/反序列化
 */
import { and, asc, eq } from "drizzle-orm";
import { randomId } from "@svh/shared";
import type { SVHDatabase } from "@svh/database";
import {
  productionAssets,
  productionCharacters,
  productionProjects,
  productionScenes,
  productionScripts,
  productionShots,
  productionStoryboards,
  workspaces,
  type ProductionAssetRow,
  type ProductionCharacterRow,
  type ProductionProjectRow,
  type ProductionSceneRow,
  type ProductionScriptRow,
  type ProductionShotRow,
  type ProductionStoryboardRow,
} from "@svh/database";
import type { ProductionProject } from "./project/project-types";
import type { ProductionScript } from "./script/script-types";
import type { Character } from "./character/character-types";
import type { ProductionScene } from "./scene/scene-types";
import type { Storyboard } from "./storyboard/storyboard-types";
import type { ProductionShot } from "./shot/shot-types";
import type { ProductionAsset, AssetType } from "./asset/asset-types";
import type {
  NewAsset,
  NewCharacter,
  NewProject,
  NewScene,
  NewScript,
  NewShot,
  NewStoryboard,
  AssetFieldsPatch,
  ProductionRepository,
  ProjectPatch,
  ScenePatch,
  ScriptPatch,
  ShotPatch,
  StoryboardPatch,
  WorkspaceOwner,
} from "./repository";

/** 行 → 领域实体（枚举/JSON/可空字段做显式映射：null → undefined） */
function toProject(row: ProductionProjectRow): ProductionProject {
  return {
    ...row,
    type: row.type as ProductionProject["type"],
    status: row.status as ProductionProject["status"],
    description: row.description ?? undefined,
    settings: row.settings as ProductionProject["settings"],
  };
}

function toScript(row: ProductionScriptRow): ProductionScript {
  return { ...row, status: row.status as ProductionScript["status"] };
}

function toCharacter(row: ProductionCharacterRow): Character {
  return {
    ...row,
    appearance: row.appearance as Character["appearance"],
    personality: row.personality ?? undefined,
    referenceAssetId: row.referenceAssetId ?? undefined,
  };
}

function toScene(row: ProductionSceneRow): ProductionScene {
  return {
    ...row,
    scriptId: row.scriptId ?? undefined,
    location: row.location ?? undefined,
    time: row.time ?? undefined,
    characters: row.characters as ProductionScene["characters"],
  };
}

function toStoryboard(row: ProductionStoryboardRow): Storyboard {
  return {
    ...row,
    status: row.status as Storyboard["status"],
    cameraMovement: row.cameraMovement ?? undefined,
    imagePrompt: row.imagePrompt ?? undefined,
    videoPrompt: row.videoPrompt ?? undefined,
  };
}

function toShot(row: ProductionShotRow): ProductionShot {
  return {
    ...row,
    status: row.status as ProductionShot["status"],
    framing: row.framing ?? undefined,
    cameraMovement: row.cameraMovement ?? undefined,
    action: row.action ?? undefined,
    dialogue: row.dialogue ?? undefined,
    imageAssetId: row.imageAssetId ?? undefined,
    videoAssetId: row.videoAssetId ?? undefined,
  };
}

function toAsset(row: ProductionAssetRow): ProductionAsset {
  return {
    ...row,
    type: row.type as ProductionAsset["type"],
    url: row.url ?? undefined,
    workspacePath: row.workspacePath ?? undefined,
    mimeType: row.mimeType ?? undefined,
    metadata: row.metadata ?? undefined,
    generation: row.generation ?? undefined,
  };
}

export class DrizzleProductionRepository implements ProductionRepository {
  constructor(private readonly db: SVHDatabase) {}

  // ================= 工作区归属 =================

  async getWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwner | null> {
    const row = this.db
      .select({ workspaceId: workspaces.id, userId: workspaces.userId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get();
    if (!row) return null;
    return { workspaceId: row.workspaceId, userId: row.userId };
  }

  // ================= Project =================

  async createProject(data: NewProject): Promise<ProductionProject> {
    const row = this.db
      .insert(productionProjects)
      .values({ ...data, id: randomId("prj"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toProject(row);
  }

  async getProject(id: string): Promise<ProductionProject | null> {
    const row = this.db.select().from(productionProjects).where(eq(productionProjects.id, id)).get();
    return row ? toProject(row) : null;
  }

  async listProjects(workspaceId: string): Promise<ProductionProject[]> {
    return this.db
      .select()
      .from(productionProjects)
      .where(eq(productionProjects.workspaceId, workspaceId))
      .orderBy(asc(productionProjects.updatedAt), asc(productionProjects.id))
      .all()
      .map(toProject);
  }

  async updateProject(id: string, patch: ProjectPatch): Promise<ProductionProject> {
    const row = this.db
      .update(productionProjects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionProjects.id, id))
      .returning()
      .get();
    return toProject(row);
  }

  // ================= Script =================

  async createScript(data: NewScript): Promise<ProductionScript> {
    const row = this.db
      .insert(productionScripts)
      .values({ ...data, id: randomId("sct"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toScript(row);
  }

  async getScript(id: string): Promise<ProductionScript | null> {
    const row = this.db.select().from(productionScripts).where(eq(productionScripts.id, id)).get();
    return row ? toScript(row) : null;
  }

  async listScripts(projectId: string): Promise<ProductionScript[]> {
    return this.db
      .select()
      .from(productionScripts)
      .where(eq(productionScripts.projectId, projectId))
      .orderBy(asc(productionScripts.createdAt), asc(productionScripts.id))
      .all()
      .map(toScript);
  }

  async updateScript(id: string, patch: ScriptPatch): Promise<ProductionScript> {
    const row = this.db
      .update(productionScripts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionScripts.id, id))
      .returning()
      .get();
    return toScript(row);
  }

  // ================= Character =================

  async createCharacter(data: NewCharacter): Promise<Character> {
    const row = this.db
      .insert(productionCharacters)
      .values({ ...data, id: randomId("chr"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toCharacter(row);
  }

  async getCharacter(id: string): Promise<Character | null> {
    const row = this.db.select().from(productionCharacters).where(eq(productionCharacters.id, id)).get();
    return row ? toCharacter(row) : null;
  }

  async listCharacters(projectId: string): Promise<Character[]> {
    return this.db
      .select()
      .from(productionCharacters)
      .where(eq(productionCharacters.projectId, projectId))
      .orderBy(asc(productionCharacters.createdAt), asc(productionCharacters.id))
      .all()
      .map(toCharacter);
  }

  async updateCharacter(id: string, patch: Partial<NewCharacter>): Promise<Character> {
    const row = this.db
      .update(productionCharacters)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionCharacters.id, id))
      .returning()
      .get();
    return toCharacter(row);
  }

  // ================= Scene =================

  async createScene(data: NewScene): Promise<ProductionScene> {
    const row = this.db
      .insert(productionScenes)
      .values({ ...data, id: randomId("scn"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toScene(row);
  }

  async getScene(id: string): Promise<ProductionScene | null> {
    const row = this.db.select().from(productionScenes).where(eq(productionScenes.id, id)).get();
    return row ? toScene(row) : null;
  }

  async listScenes(projectId: string): Promise<ProductionScene[]> {
    return this.db
      .select()
      .from(productionScenes)
      .where(eq(productionScenes.projectId, projectId))
      .orderBy(asc(productionScenes.order), asc(productionScenes.id))
      .all()
      .map(toScene);
  }

  async updateScene(id: string, patch: ScenePatch): Promise<ProductionScene> {
    const row = this.db
      .update(productionScenes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionScenes.id, id))
      .returning()
      .get();
    return toScene(row);
  }

  // ================= Storyboard =================

  async createStoryboard(data: NewStoryboard): Promise<Storyboard> {
    const row = this.db
      .insert(productionStoryboards)
      .values({ ...data, id: randomId("sbd"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toStoryboard(row);
  }

  async getStoryboard(id: string): Promise<Storyboard | null> {
    const row = this.db.select().from(productionStoryboards).where(eq(productionStoryboards.id, id)).get();
    return row ? toStoryboard(row) : null;
  }

  async listStoryboards(projectId: string): Promise<Storyboard[]> {
    return this.db
      .select()
      .from(productionStoryboards)
      .where(eq(productionStoryboards.projectId, projectId))
      .orderBy(asc(productionStoryboards.order), asc(productionStoryboards.id))
      .all()
      .map(toStoryboard);
  }

  async listStoryboardsByScene(sceneId: string): Promise<Storyboard[]> {
    return this.db
      .select()
      .from(productionStoryboards)
      .where(eq(productionStoryboards.sceneId, sceneId))
      .orderBy(asc(productionStoryboards.order), asc(productionStoryboards.id))
      .all()
      .map(toStoryboard);
  }

  async updateStoryboard(id: string, patch: StoryboardPatch): Promise<Storyboard> {
    const row = this.db
      .update(productionStoryboards)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionStoryboards.id, id))
      .returning()
      .get();
    return toStoryboard(row);
  }

  // ================= Shot =================

  async createShot(data: NewShot): Promise<ProductionShot> {
    const row = this.db
      .insert(productionShots)
      .values({ ...data, id: randomId("sht"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toShot(row);
  }

  async getShot(id: string): Promise<ProductionShot | null> {
    const row = this.db.select().from(productionShots).where(eq(productionShots.id, id)).get();
    return row ? toShot(row) : null;
  }

  async listShots(projectId: string): Promise<ProductionShot[]> {
    return this.db
      .select()
      .from(productionShots)
      .where(eq(productionShots.projectId, projectId))
      .all()
      .map(toShot);
  }

  async listShotsByStoryboard(storyboardId: string): Promise<ProductionShot[]> {
    return this.db
      .select()
      .from(productionShots)
      .where(eq(productionShots.storyboardId, storyboardId))
      .all()
      .map(toShot);
  }

  async updateShot(id: string, patch: ShotPatch): Promise<ProductionShot> {
    const row = this.db
      .update(productionShots)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productionShots.id, id))
      .returning()
      .get();
    return toShot(row);
  }

  // ================= Asset =================

  async createAsset(data: NewAsset): Promise<ProductionAsset> {
    const row = this.db
      .insert(productionAssets)
      .values({ ...data, id: randomId("ast"), createdAt: new Date(), updatedAt: new Date() })
      .returning()
      .get();
    return toAsset(row);
  }

  async getAsset(id: string): Promise<ProductionAsset | null> {
    const row = this.db.select().from(productionAssets).where(eq(productionAssets.id, id)).get();
    return row ? toAsset(row) : null;
  }

  async listAssets(projectId: string, type?: AssetType): Promise<ProductionAsset[]> {
    const where =
      type === undefined
        ? eq(productionAssets.projectId, projectId)
        : and(eq(productionAssets.projectId, projectId), eq(productionAssets.type, type));
    return this.db
      .select()
      .from(productionAssets)
      .where(where)
      .orderBy(asc(productionAssets.createdAt), asc(productionAssets.id))
      .all()
      .map(toAsset);
  }

  async updateAssetFields(id: string, patch: AssetFieldsPatch): Promise<ProductionAsset | null> {
    // 只带 patch 中出现的键（undefined 表示不动；null 由 drizzle 写成 SQL NULL）
    const set: Partial<typeof productionAssets.$inferInsert> = { updatedAt: new Date() };
    if (patch.workspacePath !== undefined) set.workspacePath = patch.workspacePath;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;
    if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
    const row = this.db
      .update(productionAssets)
      .set(set)
      .where(eq(productionAssets.id, id))
      .returning()
      .get();
    return row ? toAsset(row) : null;
  }

  async deleteAsset(id: string): Promise<void> {
    this.db.delete(productionAssets).where(eq(productionAssets.id, id)).run();
  }

  // ================= 事务 =================

  async transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T> {
    // 说明：drizzle better-sqlite3 的事务回调只支持同步（不会 await async 回调），
    // 因此使用底层连接手动 BEGIN/COMMIT/ROLLBACK，保证 async 事务语义正确。
    const sqlite = this.db.$client;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(new DrizzleProductionRepository(this.db));
      sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}
