/**
 * 内存版 ProductionRepository 假实现（仅测试用）。
 *
 * 模拟 server 层 drizzle 仓储的语义：按 id 存内存 Map、
 * 创建时生成 id、更新时刷新 updatedAt、删除/查询按条件过滤。
 */
import { randomId } from "@svh/shared";
import type {
  Character,
  NewCharacter,
  CharacterPatch,
  NewProject,
  ProductionProject,
  ProjectPatch,
  ProductionScript,
  NewScript,
  ScriptPatch,
  ProductionScene,
  NewScene,
  ScenePatch,
  Storyboard,
  NewStoryboard,
  StoryboardPatch,
  ProductionShot,
  NewShot,
  ShotPatch,
  ProductionAsset,
  NewAsset,
  AssetType,
  ProductionRepository,
  WorkspaceOwner,
} from "../../src/index";

function now(): Date {
  return new Date();
}

export class FakeProductionRepository implements ProductionRepository {
  private owners = new Map<string, WorkspaceOwner>();
  private projects = new Map<string, ProductionProject>();
  private scripts = new Map<string, ProductionScript>();
  private characters = new Map<string, Character>();
  private scenes = new Map<string, ProductionScene>();
  private storyboards = new Map<string, Storyboard>();
  private shots = new Map<string, ProductionShot>();
  private assets = new Map<string, ProductionAsset>();

  // ---- 测试辅助：直接注入工作区归属 ----
  seedOwner(workspaceId: string, userId: string | null): void {
    this.owners.set(workspaceId, { workspaceId, userId });
  }

  async getWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwner | null> {
    return this.owners.get(workspaceId) ?? null;
  }

  async createProject(data: NewProject): Promise<ProductionProject> {
    const entity: ProductionProject = { ...data, id: randomId("prj"), createdAt: now(), updatedAt: now() };
    this.projects.set(entity.id, entity);
    return entity;
  }

  async getProject(id: string): Promise<ProductionProject | null> {
    return this.projects.get(id) ?? null;
  }

  async listProjects(workspaceId: string): Promise<ProductionProject[]> {
    return [...this.projects.values()].filter((p) => p.workspaceId === workspaceId);
  }

  async updateProject(id: string, patch: ProjectPatch): Promise<ProductionProject> {
    const current = this.requireExisting(this.projects.get(id), "项目");
    const updated: ProductionProject = { ...current, ...patch, updatedAt: now() };
    this.projects.set(id, updated);
    return updated;
  }

  async createScript(data: NewScript): Promise<ProductionScript> {
    const entity: ProductionScript = { ...data, id: randomId("sct"), createdAt: now(), updatedAt: now() };
    this.scripts.set(entity.id, entity);
    return entity;
  }

  async getScript(id: string): Promise<ProductionScript | null> {
    return this.scripts.get(id) ?? null;
  }

  async listScripts(projectId: string): Promise<ProductionScript[]> {
    return [...this.scripts.values()].filter((s) => s.projectId === projectId);
  }

  async updateScript(id: string, patch: ScriptPatch): Promise<ProductionScript> {
    const current = this.requireExisting(this.scripts.get(id), "剧本");
    const updated: ProductionScript = { ...current, ...patch, updatedAt: now() };
    this.scripts.set(id, updated);
    return updated;
  }

  async createCharacter(data: NewCharacter): Promise<Character> {
    const entity: Character = { ...data, id: randomId("chr"), createdAt: now(), updatedAt: now() };
    this.characters.set(entity.id, entity);
    return entity;
  }

  async getCharacter(id: string): Promise<Character | null> {
    return this.characters.get(id) ?? null;
  }

  async listCharacters(projectId: string): Promise<Character[]> {
    return [...this.characters.values()].filter((c) => c.projectId === projectId);
  }

  async updateCharacter(id: string, patch: CharacterPatch): Promise<Character> {
    const current = this.requireExisting(this.characters.get(id), "角色");
    const updated: Character = { ...current, ...patch, updatedAt: now() };
    this.characters.set(id, updated);
    return updated;
  }

  async createScene(data: NewScene): Promise<ProductionScene> {
    const entity: ProductionScene = { ...data, id: randomId("scn"), createdAt: now(), updatedAt: now() };
    this.scenes.set(entity.id, entity);
    return entity;
  }

  async getScene(id: string): Promise<ProductionScene | null> {
    return this.scenes.get(id) ?? null;
  }

  async listScenes(projectId: string): Promise<ProductionScene[]> {
    return [...this.scenes.values()].filter((s) => s.projectId === projectId);
  }

  async updateScene(id: string, patch: ScenePatch): Promise<ProductionScene> {
    const current = this.requireExisting(this.scenes.get(id), "场景");
    const updated: ProductionScene = { ...current, ...patch, updatedAt: now() };
    this.scenes.set(id, updated);
    return updated;
  }

  async createStoryboard(data: NewStoryboard): Promise<Storyboard> {
    const entity: Storyboard = { ...data, id: randomId("sbd"), createdAt: now(), updatedAt: now() };
    this.storyboards.set(entity.id, entity);
    return entity;
  }

  async getStoryboard(id: string): Promise<Storyboard | null> {
    return this.storyboards.get(id) ?? null;
  }

  async listStoryboards(projectId: string): Promise<Storyboard[]> {
    return [...this.storyboards.values()].filter((s) => s.projectId === projectId);
  }

  async listStoryboardsByScene(sceneId: string): Promise<Storyboard[]> {
    return [...this.storyboards.values()].filter((s) => s.sceneId === sceneId);
  }

  async updateStoryboard(id: string, patch: StoryboardPatch): Promise<Storyboard> {
    const current = this.requireExisting(this.storyboards.get(id), "分镜");
    const updated: Storyboard = { ...current, ...patch, updatedAt: now() };
    this.storyboards.set(id, updated);
    return updated;
  }

  async createShot(data: NewShot): Promise<ProductionShot> {
    const entity: ProductionShot = { ...data, id: randomId("sht"), createdAt: now(), updatedAt: now() };
    this.shots.set(entity.id, entity);
    return entity;
  }

  async getShot(id: string): Promise<ProductionShot | null> {
    return this.shots.get(id) ?? null;
  }

  async listShots(projectId: string): Promise<ProductionShot[]> {
    return [...this.shots.values()].filter((s) => s.projectId === projectId);
  }

  async listShotsByStoryboard(storyboardId: string): Promise<ProductionShot[]> {
    return [...this.shots.values()].filter((s) => s.storyboardId === storyboardId);
  }

  async updateShot(id: string, patch: ShotPatch): Promise<ProductionShot> {
    const current = this.requireExisting(this.shots.get(id), "镜头");
    const updated: ProductionShot = { ...current, ...patch, updatedAt: now() };
    this.shots.set(id, updated);
    return updated;
  }

  async createAsset(data: NewAsset): Promise<ProductionAsset> {
    const entity: ProductionAsset = { ...data, id: randomId("ast"), createdAt: now(), updatedAt: now() };
    this.assets.set(entity.id, entity);
    return entity;
  }

  async getAsset(id: string): Promise<ProductionAsset | null> {
    return this.assets.get(id) ?? null;
  }

  async listAssets(projectId: string, type?: AssetType): Promise<ProductionAsset[]> {
    return [...this.assets.values()].filter(
      (a) => a.projectId === projectId && (type === undefined || a.type === type),
    );
  }

  async deleteAsset(id: string): Promise<void> {
    this.assets.delete(id);
  }

  async transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T> {
    // 内存实现共享同一状态即可，无需真正隔离
    return fn(this);
  }

  private requireExisting<T>(row: T | undefined, entity: string): T {
    if (row === undefined) {
      throw new Error(`[Fake] ${entity} 不存在`);
    }
    return row;
  }
}
