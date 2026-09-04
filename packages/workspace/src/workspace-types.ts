/**
 * Workspace 领域模型（与数据库行结构映射）
 *
 * Database = Metadata；Filesystem = Project Artifacts。
 */
export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceInput {
  name: string;
}

/** 文件浏览条目（list_files 工具与文件 API 输出） */
export interface FileEntry {
  name: string;
  /** 相对 workspace root 的路径，如 "script.md" 或 "assets/foo.png" */
  path: string;
  type: "file" | "directory";
}

/** 文件读取结果 */
export interface FileContent {
  path: string;
  content: string;
}

/** workspace 根目录下的项目管理文件 */
export interface ProjectManifest {
  version: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** workspace 专属错误码 */
export type WorkspaceErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "INVALID_WORKSPACE_PATH"
  | "WORKSPACE_ALREADY_EXISTS"
  | "PROTECTED_DIRECTORY";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}
