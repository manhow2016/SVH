/**
 * Workspace 领域模型（与数据库行结构映射）
 *
 * Database = Metadata；Filesystem = Project Artifacts。
 */
export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  /** 所属用户 ID（文档 §20 数据隔离；NULL = 历史遗留工作区，启动时归属管理员） */
  userId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  /** 所属用户 ID（会员系统引入后由服务端传入） */
  userId?: string;
}

/** 文件浏览条目（list_files 工具与文件 API 输出） */
export interface FileEntry {
  name: string;
  /** 相对 workspace root 的路径，如 "script.md" 或 "assets/foo.png" */
  path: string;
  type: "file" | "directory";
  /** 目录是否为空（仅 type=directory 时有意义；前端据此隐藏空目录展开箭头） */
  isEmpty?: boolean;
}

/** 文件读取结果 */
export interface FileContent {
  path: string;
  content: string;
}

/** 工作区初始资产树的根目录名（系统保护目录，不可删除，始终置顶展示） */
export const DEFAULT_ASSET_FOLDER = "默认";

/** 工作区初始资产类别子目录（与前端资产树约定一致） */
export const DEFAULT_ASSET_DIRS = ["角色", "场景", "道具", "音色"] as const;

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
