import path from "node:path";
import { promises as fs } from "node:fs";
import { FileManager, resolveSafeWorkspacePath } from "./file-manager";
import {
  DEFAULT_ASSET_DIRS,
  DEFAULT_ASSET_FOLDER,
  WorkspaceError,
  type FileEntry,
} from "./workspace-types";

export interface AssetsManagerOptions {
  /** 全局资产库根目录（data/assets） */
  assetsRoot: string;
}

/** 校验资产文件夹名：仅允许普通名称（禁止路径分隔符与 . / ..） */
function assertValidAssetName(name: string): void {
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new WorkspaceError("INVALID_WORKSPACE_PATH", `Invalid asset folder name: ${name}`);
  }
}

/**
 * 全局资产库（跨工作区共享）：
 * 每个资产文件夹固定包含「角色 / 场景 / 道具 / 音色」四个资源类型子目录。
 *
 * 复用 FileManager 的文件操作安全边界；「默认」为系统保护文件夹。
 */
export class AssetsManager {
  private readonly fm: FileManager;
  private readonly assetsRoot: string;

  constructor(options: AssetsManagerOptions) {
    this.assetsRoot = path.resolve(options.assetsRoot);
    this.fm = new FileManager("__assets__", this.assetsRoot);
  }

  /** 列出资产库内容（relativePath 缺省为根：资源文件夹；也可传 "文件夹/类型"） */
  async list(relativePath = "."): Promise<FileEntry[]> {
    return this.fm.list(relativePath);
  }

  /** 创建资产文件夹：自动生成四个资源类型子目录 */
  async create(name: string): Promise<{ path: string }> {
    const folderName = name.trim();
    assertValidAssetName(folderName);
    const target = resolveSafeWorkspacePath(this.assetsRoot, folderName);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      // 不存在，允许创建
    }
    if (stat) {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", `资产文件夹已存在：${folderName}`);
    }
    return this.fm.mkdir(folderName, [...DEFAULT_ASSET_DIRS]);
  }

  /** 重命名资产文件夹（「默认」禁止重命名） */
  async rename(oldName: string, newName: string): Promise<{ path: string }> {
    const from = oldName.trim();
    const to = newName.trim();
    assertValidAssetName(from);
    assertValidAssetName(to);
    if (from === DEFAULT_ASSET_FOLDER || to === DEFAULT_ASSET_FOLDER) {
      throw new WorkspaceError(
        "PROTECTED_DIRECTORY",
        "「默认」为系统资产文件夹，不允许重命名",
      );
    }
    if (from === to) return { path: to };
    const fromPath = resolveSafeWorkspacePath(this.assetsRoot, from);
    const toPath = resolveSafeWorkspacePath(this.assetsRoot, to);
    try {
      await fs.stat(toPath);
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", `资产文件夹已存在：${to}`);
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      // 目标不存在，继续
    }
    await fs.rename(fromPath, toPath);
    return { path: to };
  }

  /** 删除资产文件夹（递归；「默认」为系统保护文件夹禁止删除） */
  async delete(name: string): Promise<{ path: string }> {
    const folderName = name.trim();
    assertValidAssetName(folderName);
    if (folderName === DEFAULT_ASSET_FOLDER) {
      throw new WorkspaceError("PROTECTED_DIRECTORY", "「默认」为系统资产文件夹，不允许删除");
    }
    return this.fm.delete(folderName);
  }

  /** 幂等初始化：确保资产根目录及「默认」资产文件夹（含四个资源类型）存在 */
  async ensureDefault(): Promise<void> {
    await fs.mkdir(this.assetsRoot, { recursive: true });
    await this.fm.mkdir(DEFAULT_ASSET_FOLDER, [...DEFAULT_ASSET_DIRS]);
  }
}
