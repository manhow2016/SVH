import { randomId } from "@svh/shared";
import path from "node:path";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { AssetsManager } from "@svh/workspace";
import { resolveSafeWorkspacePath } from "@svh/workspace";
import type { MembershipService } from "../modules/membership/service";
import type { AuthService } from "../modules/auth/service";
import type { GenerationService } from "../modules/production/generation-service";
import type { ProductionService } from "@svh/production";
import { requireFeature } from "../modules/auth/middleware";
import { ERRORS, ServerError } from "../lib/errors";
import { MIME_BY_EXT, parseSingleRange } from "./media";

// ─── 类型定义 ────────────────────────────────────────────────────

export interface AssetGenerateInput {
  type: string;
  mode?: string;
  name: string;
  style?: string;
  description?: string;
  summary?: string;
  imageDescription?: string;
  referenceImages?: string[];
  customDescription?: string;
  previewText?: string;
  count?: number;
}

interface AssetGenResponse {
  assetIds: string[];
  taskIds: string[];
  total: number;
}

type GenType = "character" | "scene" | "prop" | "voice";

const MAX_COUNT: Record<GenType, number> = { character: 6, scene: 6, prop: 6, voice: 10 };

interface RouteDeps {
  assetsManager: AssetsManager;
  membershipService: MembershipService;
  generationService?: GenerationService;
  /** 全局资产库根目录 */
  assetsRoot?: string;
  /** 制作中心项目服务（资产库引用检查数据源） */
  production?: ProductionService;
  /** 认证服务（/api/assets/raw 的 query token 自验，与 /api/media 同构） */
  authService?: AuthService;
}

interface ImageInput {
  genType: GenType; label: string;
  name: string; style?: string; description?: string;
  summary?: string; imageDescription?: string;
  referenceImages?: string[];
  count: number; maxCount: number;
}

interface VoiceInput {
  genType: "voice"; label: string;
  name: string; style?: string;
  customDescription?: string; previewText?: string;
  count: number; maxCount: number;
}

/** 共享上下文：路由 handler 注入 user id + assets root + generation service */
interface HandlerCtx { userId: string; assetsRoot: string; generationService: GenerationService; }

// ===========================================================================
// 路由注册
// ===========================================================================

export function registerAssetsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const feature = requireFeature(deps.membershipService, "assets.library");

  // ---- 旧版文件系统 API ----

  app.get<{ Querystring: { path?: string } }>("/api/assets", { preHandler: [feature] }, async (req) =>
    deps.assetsManager.list(req.query.path ?? "."),
  );

  app.post<{ Body: { name?: string } }>("/api/assets", { preHandler: [feature] }, async (req) => {
    const { name } = req.body ?? {};
    if (!name) throw ERRORS.INVALID_INPUT("name is required");
    return deps.assetsManager.create(name);
  });

  app.patch<{ Body: { name?: string; newName?: string } }>("/api/assets", { preHandler: [feature] }, async (req) => {
    const { name, newName } = req.body ?? {};
    if (!name || !newName) throw ERRORS.INVALID_INPUT("name and newName are required");
    return deps.assetsManager.rename(name, newName);
  });

  app.post<{ Body: { path?: string; content?: string } }>("/api/assets/file", { preHandler: [feature] }, async (req) => {
    const { path: p, content } = req.body ?? {};
    if (!p) throw ERRORS.INVALID_INPUT("path is required");
    if (typeof content !== "string") throw ERRORS.INVALID_INPUT("content is required");
    return deps.assetsManager.writeFile(p, content);
  });

  app.delete<{ Querystring: { name: string } }>("/api/assets", { preHandler: [feature] }, async (req) => {
    const name = req.query.name;
    if (!name) throw ERRORS.INVALID_INPUT("name is required");

    // 引用检查（删除保护）：文件夹内仍有被制作中心项目引用的资产时禁止删除（409）。
    // 引用存在性结合文件系统实际文件过滤（引用行可能因历史原因指向已删除的文件）。
    if (deps.production && deps.assetsRoot) {
      const files = await collectFolderFiles(deps.assetsRoot, name);
      if (files.length > 0) {
        const fileSet = new Set(files);
        const refs = (await deps.production.listAssetLibraryRefsByFolder(name)).filter(
          r => fileSet.has(r.libPath),
        );
        if (refs.length > 0) {
          throw new ServerError(
            "ASSET_LIBRARY_REFERENCED",
            `文件夹「${name}」中有 ${refs.length} 个资产仍被制作中心项目引用，请先在项目中解除引用`,
            409,
            {
              references: refs.map(r => ({
                libPath: r.libPath,
                projectId: r.projectId,
                projectName: r.projectName,
                assetId: r.assetId,
                assetName: r.assetName,
              })),
            },
          );
        }
      }
    }
    return deps.assetsManager.delete(name);
  });

  // 资产库文件送达（「我的资产」→ 项目资产引用后的预览/播放地址）。
  // 与 /api/media 同构：`<img>/<audio>/<video>` 带不了 Authorization，token 走 query 自验；
  // 全局 auth 钩子对本前缀豁免（app.ts），由本路由验签 + 用户态检查。
  app.get<{ Querystring: { path?: string; token?: string } }>("/api/assets/raw", async (req, reply) => {
    const token = req.query.token;
    if (!token || !deps.authService) throw ERRORS.UNAUTHORIZED();
    const { userId } = await deps.authService.verifyToken(token);
    const user = await deps.authService.getUserForAuth(userId).catch(() => null);
    if (!user || user.status === "disabled") {
      throw ERRORS.UNAUTHORIZED("登录已过期，请重新登录");
    }
    const p = req.query.path;
    if (!p) throw ERRORS.INVALID_INPUT("path is required");
    if (!deps.assetsRoot) throw ERRORS.INTERNAL();
    const abs = resolveSafeWorkspacePath(deps.assetsRoot, p);

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new ServerError("NOT_FOUND", "资产文件不存在", 404);
    }
    if (!stat.isFile()) throw new ServerError("NOT_FOUND", "资产文件不存在", 404);
    const size = stat.size;

    // Content-Type：按扩展名兜底（资产库文件无 mime 记录）；未知 octet-stream
    const contentType =
      MIME_BY_EXT[path.extname(p).replace(".", "").toLowerCase()] || "application/octet-stream";

    const range = parseSingleRange(req.headers.range, size);
    if (range === "unsatisfiable") {
      reply.header("Content-Range", `bytes */${size}`);
      throw new ServerError("RANGE_NOT_SATISFIABLE", "Range 不可满足", 416);
    }
    reply.header("Content-Type", contentType);
    reply.header("Accept-Ranges", "bytes");
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    if (range) {
      reply.status(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    reply.header("Content-Length", String(length));
    if (size === 0) return reply.send();

    const stream = createReadStream(abs, { start, end });
    stream.on("error", () => stream.destroy());
    reply.raw.on("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    return reply.send(stream);
  });

  // ---- 新版 AI 生成 API ----

  // 获取计数
  app.get<{ Querystring: { folder?: string } }>("/api/assets/counts", { preHandler: [feature] }, async (req) => {
    const folder = req.query.folder ?? "默认";
    const paths = ["角色", "场景", "道具", "音色"];
    const counts: Record<string, number> = {};
    await Promise.all(paths.map(async (p) => {
      try { counts[p] = (await deps.assetsManager.list(`${folder}/${p}`)).length; } catch { counts[p] = 0; }
    }));
    return counts;
  });

  // 生成资产
  app.post<{ Body: AssetGenerateInput }>("/api/assets/generate", { preHandler: [feature] }, async (req) => {
    const input = req.body ?? {};
    const userId = req.user?.userId;
    if (!userId) throw ERRORS.UNAUTHORIZED("未登录");
    const assetsRoot = deps.assetsRoot;
    if (!assetsRoot || !deps.generationService) {
      throw new Error("Asset generation not supported in this deployment");
    }

    const ctx: HandlerCtx = { userId, assetsRoot, generationService: deps.generationService! };

    const validTypes: readonly GenType[] = ["character", "scene", "prop", "voice"];
    const t = input.type as GenType;
    if (!t || !validTypes.includes(t)) {
      throw ERRORS.INVALID_INPUT(`无效的资产类型，可选：${validTypes.join(", ")}`);
    }
    if (!input.name || input.name.trim() === "") {
      throw ERRORS.INVALID_INPUT("名称不能为空");
    }
    const genCount = Math.min(Math.max(input.count ?? 1, 1), MAX_COUNT[t]);

    const labels: Record<GenType, string> = { character: "角色", scene: "场景", prop: "道具", voice: "音色" };

    switch (t) {
      case "character":
      case "scene":
      case "prop":
        return handleImage(ctx, {
          genType: t, label: labels[t], name: input.name.trim(), style: input.style,
          description: input.description, summary: input.summary,
          imageDescription: input.imageDescription, referenceImages: input.referenceImages,
          count: genCount, maxCount: MAX_COUNT[t],
        });
      case "voice":
        return handleVoice(ctx, {
          genType: t, label: labels.voice, name: input.name.trim(), style: input.style,
          customDescription: input.customDescription, previewText: input.previewText,
          count: genCount, maxCount: MAX_COUNT.voice,
        });
      default:
        throw ERRORS.INVALID_INPUT(`不支持的资产类型：${t}`);
    }
  });
}

// ===========================================================================
// 资产库引用检查辅助
// ===========================================================================

/**
 * 递归收集资产库文件夹下全部文件的完整相对路径（相对资产根，POSIX / 分隔，
 * 形如 "文件夹/类型/文件名"，与引用记录 lib_path 同形，可直接比对）。
 * 目录不存在/不可读时返回空数组（删除时会报错，无需在此抛）。
 */
async function collectFolderFiles(assetsRoot: string, folder: string): Promise<string[]> {
  const base = resolveSafeWorkspacePath(assetsRoot, folder);
  const out: string[] = [];
  async function walk(rel: string, abs: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(childRel, path.join(abs, entry.name));
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk(folder, base);
  return out;
}

// ===========================================================================
// 图片资产生成（角色 AI/参考图、场景、道具）
// ===========================================================================

async function handleImage(ctx: HandlerCtx, input: ImageInput): Promise<AssetGenResponse> {
  const { generationService, assetsRoot } = ctx;
  if (!generationService) throw new Error("Asset generation not supported");

  const promptMap: Record<string, (i: typeof input) => string> = {
    character: (i) => i.description ?? `${i.name}，${i.style ?? ""}`,
    scene: (i) => i.description ?? `${i.name}，${i.style ?? ""}`,
    prop: (i) => i.imageDescription ?? `${i.summary ?? ""}，${i.name}，${i.style ?? ""}`,
  };
  const prompt = promptMap[input.genType]?.(input) ?? input.name;
  if (!prompt) throw ERRORS.INVALID_INPUT("请提供足够的描述信息");

  const assetLabels: Record<string, string> = { character: "角色", scene: "场景", prop: "道具" };
  const refFiles = await uploadReferenceImages(assetsRoot, input.referenceImages);

  const taskIds: string[] = [];
  for (let i = 0; i < input.count; i++) {
    const task = await generationService.enqueueImage({
      projectId: "default",
      userId: ctx.userId,
      prompt,
      size: "1024x1024",
      assetName: `${assetLabels[input.genType]} ${input.name} #${i + 1}`,
      ...(refFiles.length > 0 ? { referenceImageUrls: refFiles.slice(0, 5) } : {}),
    });
    taskIds.push(task.id);
  }

  return { assetIds: [], taskIds, total: input.count };
}

/** 上传参考图 data URL → 文件路径列表 */
async function uploadReferenceImages(assetsRoot: string, images?: string[]): Promise<string[]> {
  if (!images?.length) return [];
  const refs: string[] = [];
  const dir = path.join(assetsRoot, "refs");
  await fs.mkdir(dir, { recursive: true });

  for (let i = 0; i < images.length && i < 5; i++) {
    const dataUrl = images[i];
    if (!dataUrl) continue;
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx < 0) continue;
    const base64Data = dataUrl.slice(commaIdx + 1);
    if (!base64Data) continue;
    const buffer = Buffer.from(base64Data, "base64");
    const ext = dataUrl.startsWith("data:image/png") ? "png" : "jpeg";
    const fileName = `ref_${randomId("")}.${ext}`;
    await fs.writeFile(path.join(dir, fileName), buffer);
    refs.push(fileName);
  }
  return refs;
}

// ===========================================================================
// 音色资产生成（TTS）
// ===========================================================================

async function handleVoice(ctx: HandlerCtx, input: VoiceInput): Promise<AssetGenResponse> {
  const { generationService } = ctx;
  if (!generationService) throw new Error("Asset generation not supported");

  const previewText = input.previewText ?? "大家好，欢迎来到今天的故事。";
  if (!previewText) throw ERRORS.INVALID_INPUT("预览文本不能为空");

  const taskIds: string[] = [];
  for (let i = 0; i < input.count; i++) {
    const task = await generationService.enqueueAudio({
      projectId: "default",
      userId: ctx.userId,
      prompt: previewText,
      assetName: `${input.name} #${i + 1}`,
    });
    taskIds.push(task.id);
  }

  return { assetIds: [], taskIds, total: input.count };
}
