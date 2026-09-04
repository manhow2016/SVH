import path from "node:path";
import { promises as fs } from "node:fs";
import { WorkspaceError, type FileContent, type FileEntry } from "./workspace-types";

/**
 * 将任意相对路径安全地解析到 workspace root 内。
 *
 * 要求：最终路径必须位于 workspaceRoot 内（禁止 ../ 逃逸）。
 * 若超出则抛出 WorkspaceError("INVALID_WORKSPACE_PATH")。
 */
export function resolveSafeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new WorkspaceError("INVALID_WORKSPACE_PATH", "Invalid workspace path");
  }
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceError("INVALID_WORKSPACE_PATH", "Invalid workspace path");
  }
  return target;
}

/** 规范化相对路径（"./a/b" → "a/b"，"." → ""） */
export function normalizeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/\\/g, "/");
  if (normalized === ".") return "";
  return normalized.replace(/^\.\//, "");
}

/**
 * 系统内部文件：资产树/工具列表中不展示（保持工作区根目录初始状态纯净），
 * 但仍可被 read/write API 读写（Context Builder 依赖 VIDEO_AGENTS.md）。
 */
export const SYSTEM_FILES = new Set(["svh.project.json", "VIDEO_AGENTS.md"]);

/**
 * 文件管理器：所有操作严格限制在 workspace root 内。
 *
 * 只负责文件系统操作，不涉及数据库。
 */
export class FileManager {
  constructor(
    readonly workspaceId: string,
    readonly rootPath: string,
  ) {}

  /** 解析并在 root 校验相对路径 */
  resolve(relativePath: string): string {
    return resolveSafeWorkspacePath(this.rootPath, relativePath);
  }

  /** 列出目录内容（相对路径，"." 表示根目录） */
  async list(relativePath = "."): Promise<FileEntry[]> {
    const dir = this.resolve(relativePath);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", `Path not found: ${relativePath}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", `Not a directory: ${relativePath}`);
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      // 系统文件不展示（svh.project.json / VIDEO_AGENTS.md）
      if (!entry.isDirectory() && SYSTEM_FILES.has(entry.name)) continue;
      const rel = normalizeRelativePath(
        path.join(relativePath === "." ? "" : relativePath, entry.name),
      );
      const isDir = entry.isDirectory();
      // 目录附带「是否为空」（供前端初始即隐藏空目录的展开箭头）
      let isEmpty: boolean | undefined;
      if (isDir) {
        try {
          isEmpty = (await fs.readdir(path.join(dir, entry.name))).length === 0;
        } catch {
          isEmpty = false;
        }
      }
      result.push({
        name: entry.name,
        path: rel,
        type: isDir ? "directory" : "file",
        isEmpty,
      });
    }
    // 目录在前，按名称排序
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  }

  /** 读取文本文件内容 */
  async read(relativePath: string): Promise<FileContent> {
    const file = this.resolve(relativePath);
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", `File not found: ${relativePath}`);
    }
    return { path: normalizeRelativePath(relativePath), content };
  }

  /** 写入文件：自动创建不存在的父目录，覆盖已有文件 */
  async write(relativePath: string, content: string): Promise<{ path: string }> {
    const file = this.resolve(relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return { path: normalizeRelativePath(relativePath) };
  }

  /**
   * 创建目录（含可选一级子目录，如资产分类），父目录自动创建。
   * 若路径上已存在同名文件则报错；子目录名禁止含路径分隔符（防逃逸）。
   */
  async mkdir(relativePath: string, children: string[] = []): Promise<{ path: string }> {
    const dir = this.resolve(relativePath);
    let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      stat = await fs.stat(dir);
    } catch {
      // 不存在，正常创建
    }
    if (stat?.isFile()) {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", `Path is already a file: ${relativePath}`);
    }
    await fs.mkdir(dir, { recursive: true });
    for (const child of children) {
      if (
        typeof child !== "string" ||
        child.trim() === "" ||
        child === "." ||
        child === ".." ||
        child.includes("/") ||
        child.includes("\\")
      ) {
        throw new WorkspaceError("INVALID_WORKSPACE_PATH", `Invalid child name: ${child}`);
      }
      const childDir = this.resolve(path.join(relativePath, child));
      await fs.mkdir(childDir, { recursive: true });
    }
    return { path: normalizeRelativePath(relativePath) };
  }

  /**
   * 删除文件或目录（目录递归删除）。
   *
   * 保护规则：路径末段名为「默认」的目录为系统保护目录，禁止删除。
   */
  async delete(relativePath: string): Promise<{ path: string }> {
    const target = this.resolve(relativePath);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", `Path not found: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      const name = path.basename(target);
      if (name === "默认") {
        throw new WorkspaceError(
          "PROTECTED_DIRECTORY",
          "默认文件夹为系统目录，不允许删除",
        );
      }
      await fs.rm(target, { recursive: true, force: true });
    } else {
      await fs.unlink(target);
    }
    return { path: normalizeRelativePath(relativePath) };
  }

  /** 判断文件是否存在 */
  async exists(relativePath: string): Promise<boolean> {
    try {
      const file = this.resolve(relativePath);
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }
}
