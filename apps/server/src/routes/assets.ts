import type { FastifyInstance } from "fastify";
import type { AssetsManager } from "@svh/workspace";
import type { MembershipService } from "../modules/membership/service";
import { requireFeature } from "../modules/auth/middleware";
import { ERRORS } from "../lib/errors";

export interface AssetsRouteDeps {
  assetsManager: AssetsManager;
  membershipService: MembershipService;
}

/**
 * 全局资产库 API（跨工作区共享的角色/场景/道具/音色资源）。
 *
 * 每个资产文件夹固定包含四个资源类型子目录；「默认」为系统保护文件夹。
 * 功能权限：assets.library（§9 免费版无资产库；后端校验，§33）。
 */
export function registerAssetsRoutes(app: FastifyInstance, deps: AssetsRouteDeps): void {
  const feature = requireFeature(deps.membershipService, "assets.library");

  // 列出资产内容（path 缺省为根：资源文件夹；也可传 "文件夹/类型" 查看资产内容）
  app.get<{ Querystring: { path?: string } }>(
    "/api/assets",
    { preHandler: [feature] },
    async (req) => deps.assetsManager.list(req.query.path ?? "."),
  );

  // 创建资产文件夹（自动生成四个资源类型子目录）
  app.post<{ Body: { name?: string } }>(
    "/api/assets",
    { preHandler: [feature] },
    async (req) => {
      const { name } = req.body ?? {};
      if (!name) throw ERRORS.INVALID_INPUT("name is required");
      return deps.assetsManager.create(name);
    },
  );

  // 重命名资产文件夹
  app.patch<{ Body: { name?: string; newName?: string } }>(
    "/api/assets",
    { preHandler: [feature] },
    async (req) => {
      const { name, newName } = req.body ?? {};
      if (!name || !newName) throw ERRORS.INVALID_INPUT("name and newName are required");
      return deps.assetsManager.rename(name, newName);
    },
  );

  // 写入资产文件（上传资源；路径如 "文件夹/类型/文件名"）
  app.post<{ Body: { path?: string; content?: string } }>(
    "/api/assets/file",
    { preHandler: [feature] },
    async (req) => {
      const { path, content } = req.body ?? {};
      if (!path) throw ERRORS.INVALID_INPUT("path is required");
      if (typeof content !== "string") throw ERRORS.INVALID_INPUT("content is required");
      return deps.assetsManager.writeFile(path, content);
    },
  );

  // 删除资产文件夹（递归）
  app.delete<{ Querystring: { name: string } }>(
    "/api/assets",
    { preHandler: [feature] },
    async (req) => {
      if (!req.query.name) throw ERRORS.INVALID_INPUT("name is required");
      return deps.assetsManager.delete(req.query.name);
    },
  );
}
