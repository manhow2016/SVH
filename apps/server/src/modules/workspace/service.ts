import type { Workspace, WorkspaceManager } from "@svh/workspace";

/**
 * Workspace 服务（server 侧门面）。
 *
 * 直接复用 @svh/workspace 的 WorkspaceManager 与 FileManager，
 * 保持「文件系统 = 项目事实来源」原则。
 */
export class WorkspaceService {
  constructor(private readonly manager: WorkspaceManager) {}

  create(name: string): Promise<Workspace> {
    return this.manager.create({ name });
  }

  list(): Promise<Workspace[]> {
    return this.manager.list();
  }

  get(id: string): Promise<Workspace> {
    return this.manager.get(id);
  }

  delete(id: string): Promise<void> {
    return this.manager.delete(id);
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

  async deleteFile(workspaceId: string, relativePath: string) {
    const fm = await this.manager.getFileManager(workspaceId);
    return fm.delete(relativePath);
  }
}
