import { WorkspaceError, type Workspace, type WorkspaceManager } from "@svh/workspace";

/**
 * Workspace 服务（server 侧门面）。
 *
 * 直接复用 @svh/workspace 的 WorkspaceManager 与 FileManager，
 * 保持「文件系统 = 项目事实来源」原则。
 *
 * 文档 §20/§37：所有操作基于 userId 做 Ownership Check，
 * 不属于当前用户的工作区一律视为不存在（不泄漏存在性）。
 */
export class WorkspaceService {
  constructor(private readonly manager: WorkspaceManager) {}

  create(name: string, userId: string): Promise<Workspace> {
    return this.manager.create({ name, userId });
  }

  list(): Promise<Workspace[]> {
    return this.manager.list();
  }

  /** 当前用户的全部工作区 */
  listForUser(userId: string): Promise<Workspace[]> {
    return this.manager.listByUser(userId);
  }

  get(id: string): Promise<Workspace> {
    return this.manager.get(id);
  }

  /** 所有权校验后获取（他人工作区 → WORKSPACE_NOT_FOUND） */
  async getOwned(id: string, userId: string): Promise<Workspace> {
    const ws = await this.manager.get(id);
    if (ws.userId !== userId) {
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace not found");
    }
    return ws;
  }

  delete(id: string): Promise<void> {
    return this.manager.delete(id);
  }

  /** 所有权校验后删除 */
  async deleteOwned(id: string, userId: string): Promise<void> {
    await this.getOwned(id, userId);
    return this.manager.delete(id);
  }

  /** 历史遗留工作区归属管理员（启动时调用） */
  claimLegacy(userId: string): Promise<number> {
    return this.manager.claimLegacy(userId);
  }

  async listFiles(workspaceId: string, relativePath = ".") {
    const fm = await this.manager.getFileManager(workspaceId);
    return fm.list(relativePath);
  }

  async readFile(workspaceId: string, relativePath: string) {
    const fm = await this.manager.getFileManager(workspaceId);
    return fm.read(relativePath);
  }

  async writeFile(workspaceId: string, relativePath: string, content: string) {
    const fm = await this.manager.getFileManager(workspaceId);
    return fm.write(relativePath, content);
  }

  async createDirectory(workspaceId: string, relativePath: string, children: string[] = []) {
    const fm = await this.manager.getFileManager(workspaceId);
    return fm.mkdir(relativePath, children);
  }

  async deleteFile(workspaceId: string, relativePath: string) {
    const fm = await this.manager.getFileManager(workspaceId);
    return fm.delete(relativePath);
  }
}
