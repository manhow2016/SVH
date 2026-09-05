import type { FastifyInstance } from "fastify";
import type { AssetsManager } from "@svh/workspace";
import { ERRORS } from "../lib/errors";

export interface AssetsRouteDeps {
  assetsManager: AssetsManager;
}

/**
 * 全局资产库 API（跨工作区共享的角色/场景/道具/音色资源）。
 *
 * 每个资产文件夹固定包含四个资源类型子目录；「默认」为系统保护文件夹。
 */
export function registerAssetsRoutes(app: FastifyInstance, deps: AssetsRouteDeps): void {
  // 列出资产文件夹
  app.get("/api/assets", async () => deps.assetsManager.list());

  // 创建资产文件夹（自动生成四个资源类型子目录）
  app.post<{ Body: { name?: string } }>("/api/assets", async (req) => {
    const { name } = req.body ?? {};
    if (!name) throw ERRORS.INVALID_INPUT("name is required");
    return deps.assetsManager.create(name);
  });

  // 重命名资产文件夹
  app.patch<{ Body: { name?: string; newName?: string } }>("/api/assets", async (req) => {
    const { name, newName } = req.body ?? {};
    if (!name || !newName) throw ERRORS.INVALID_INPUT("name and newName are required");
    return deps.assetsManager.rename(name, newName);
  });

  // 删除资产文件夹（递归）
  app.delete<{ Querystring: { name: string } }>("/api/assets", async (req) => {
    if (!req.query.name) throw ERRORS.INVALID_INPUT("name is required");
    return deps.assetsManager.delete(req.query.name);
  });
}
