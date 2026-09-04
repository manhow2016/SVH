import type { FastifyInstance } from "fastify";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS } from "../lib/errors";

export interface FileRouteDeps {
  workspaceService: WorkspaceService;
}

/**
 * 文件 API（供 Workspace Explorer 与 File Viewer 使用）。
 *
 * 所有相对路径均受安全边界约束（禁止 ../ 逃逸）。
 */
export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  // 浏览目录
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/workspaces/:id/files",
    async (req) => deps.workspaceService.listFiles(req.params.id, req.query.path ?? "."),
  );

  // 读取文件内容
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/workspaces/:id/files/content",
    async (req) => {
      if (!req.query.path) throw ERRORS.INVALID_INPUT("path is required");
      return deps.workspaceService.readFile(req.params.id, req.query.path);
    },
  );

  // 写入文件
  app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>(
    "/api/workspaces/:id/files",
    async (req) => {
      const { path: relPath, content } = req.body ?? {};
      if (!relPath) throw ERRORS.INVALID_INPUT("path is required");
      if (typeof content !== "string") throw ERRORS.INVALID_INPUT("content is required");
      return deps.workspaceService.writeFile(req.params.id, relPath, content);
    },
  );

  // 删除文件
  app.delete<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/workspaces/:id/files",
    async (req) => {
      if (!req.query.path) throw ERRORS.INVALID_INPUT("path is required");
      return deps.workspaceService.deleteFile(req.params.id, req.query.path);
    },
  );
}
