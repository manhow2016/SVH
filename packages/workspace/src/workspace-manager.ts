import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { workspaces, type SVHDatabase } from "@svh/database";
import { randomId, toISO } from "@svh/shared";
import { FileManager } from "./file-manager";
import {
  WorkspaceError,
  type CreateWorkspaceInput,
  type ProjectManifest,
  type Workspace,
} from "./workspace-types";
import { DEFAULT_VIDEO_AGENTS_MD } from "./video-agents";

/** 工作区初始资产类别子目录（与前端资产树约定一致） */
export const DEFAULT_ASSET_DIRS = ["角色", "场景", "道具", "音色"] as const;

/** 工作区初始资产树的根目录名（系统保护目录，不可删除） */
export const DEFAULT_ASSET_FOLDER = "默认";

export interface WorkspaceManagerOptions {
  db: SVHDatabase;
  /** 工作区根目录（data/workspaces） */
  workspaceRoot: string;
}

/**
 * Workspace Manager：数据库元数据 + 文件系统项目文件的协调者。
 *
 * create 时自动生成：
 *  - data/workspaces/{id}/
 *  - svh.project.json（项目清单）
 *  - VIDEO_AGENTS.md（默认工作区指令）
 */
export class WorkspaceManager {
  private readonly db: SVHDatabase;
  private readonly workspaceRoot: string;

  constructor(options: WorkspaceManagerOptions) {
    this.db = options.db;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
  }

  /** 创建 Workspace：建目录 + 写清单文件 + 写数据库 */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const name = input.name.trim();
    if (name === "") {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", "Workspace name is required");
    }
    const id = randomId("ws");
    const now = new Date();
    const rootPath = path.join(this.workspaceRoot, id);

    await fs.mkdir(rootPath, { recursive: true });

    const manifest: ProjectManifest = {
      version: 1,
      id,
      name,
      createdAt: toISO(now),
      updatedAt: toISO(now),
    };
    await fs.writeFile(
      path.join(rootPath, "svh.project.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    await fs.writeFile(path.join(rootPath, "VIDEO_AGENTS.md"), DEFAULT_VIDEO_AGENTS_MD, "utf8");

    // 初始资产树：「默认」文件夹 + 四个资产类别空目录
    await this.ensureDefaultAssetsIn(rootPath);

    await this.db.insert(workspaces).values({
      id,
      name,
      rootPath,
      createdAt: now,
      updatedAt: now,
    });

    return this.get(id);
  }

  /** 列出全部 Workspace（按创建时间倒序） */
  async list(): Promise<Workspace[]> {
    const rows = await this.db.select().from(workspaces).orderBy(workspaces.createdAt);
    return rows.map((row) => this.toWorkspace(row));
  }

  /** 获取单个 Workspace，不存在则抛 WORKSPACE_NOT_FOUND */
  async get(id: string): Promise<Workspace> {
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found");
    }
    return this.toWorkspace(row);
  }

  /** 获取单个 Workspace 的行记录（供服务层复用） */
  async getRaw(id: string): Promise<Workspace> {
    return this.get(id);
  }

  /** 删除 Workspace：删除数据库记录（级联删除会话/消息）+ 删除目录 */
  async delete(id: string): Promise<void> {
    await this.get(id); // 校验存在
    const rootPath = path.join(this.workspaceRoot, id);
    await fs.rm(rootPath, { recursive: true, force: true });
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
  }

  /** 获取指定 Workspace 的文件管理器（安全边界 = workspace root） */
  async getFileManager(id: string): Promise<FileManager> {
    const ws = await this.get(id);
    return new FileManager(ws.id, ws.rootPath);
  }

  /**
   * 幂等迁移：为所有已有工作区补齐初始资产树（「默认」+ 四个资产类别）。
   * 服务启动时调用一次，兼容扩展现有新工作区。
   */
  async ensureDefaultAssets(): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true });
    } catch {
      return; // 根目录不存在，无工作区可迁移
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.ensureDefaultAssetsIn(path.join(this.workspaceRoot, entry.name));
    }
  }

  /** 在指定工作区根目录内创建（缺失时补齐）「默认」+ 四个资产类别目录 */
  private async ensureDefaultAssetsIn(rootPath: string): Promise<void> {
    for (const dir of DEFAULT_ASSET_DIRS) {
      await fs.mkdir(path.join(rootPath, DEFAULT_ASSET_FOLDER, dir), { recursive: true });
    }
  }

  private toWorkspace(row: {
    id: string;
    name: string;
    rootPath: string;
    createdAt: Date;
    updatedAt: Date;
  }): Workspace {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.rootPath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
