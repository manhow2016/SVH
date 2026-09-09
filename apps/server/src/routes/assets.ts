import { randomId } from "@svh/shared";
import path from "node:path";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { AssetsManager } from "@svh/workspace";
import { resolveSafeWorkspacePath } from "@svh/workspace";
import type { MembershipService } from "../modules/membership/service";
import type { AuthService } from "../modules/auth/service";
import type { WorkspaceService } from "../modules/workspace/service";
import type { GenerationService } from "../modules/production/generation-service";
import type { ProductionService } from "@svh/production";
import { requireFeature } from "../modules/auth/middleware";
import { ERRORS, ServerError } from "../lib/errors";
import { MIME_BY_EXT, parseSingleRange } from "./media";

// ─── 类型定义 ────────────────────────────────────────────────────

/**
 * 「我的资产」生成任务的归属项目（V0.3 会话-项目一对一绑定后不再存在
 * 硬编码 "default" 项目，改为按用户幂等创建/复用的系统项目）。
 * 该项目隐藏于制作中心项目列表（见 production.ts），仅作为生产任务/资产
 * 行归属容器（production_tasks.project_id / production_assets.project_id 均
 * 为 NOT NULL 外键）；生成结果文件由 worker 发布到资产库文件夹。
 */
export const ASSET_LIBRARY_PROJECT_NAME = "我的资产";
/** 描述哨兵前缀：查找/隐藏系统资产库项目的稳定标识（用户改名仍可识别） */
export const ASSET_LIBRARY_PROJECT_DESC_PREFIX = "SVH 系统资产库项目";

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
  /** 资产库目标文件夹（「我的资产」页当前选中文件夹；缺省「默认」） */
  folder?: string;
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
  /** 制作中心项目服务（资产库引用检查数据源 + 系统资产库项目解析） */
  production?: ProductionService;
  /** 认证服务（/api/assets/raw 的 query token 自验，与 /api/media 同构） */
  authService?: AuthService;
  /** 工作区服务（解析用户默认工作区 → 系统资产库项目） */
  workspaceService?: WorkspaceService;
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
interface HandlerCtx {
  userId: string;
  assetsRoot: string;
  generationService: GenerationService;
  /** 系统资产库项目 id（任务/资产行归属；按用户幂等解析） */
  libraryProjectId: string;
  /** 资产库目标文件夹（「我的资产」页当前选中文件夹） */
  libraryFolder: string;
}

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
    if (!deps.production || !deps.workspaceService) {
      throw ERRORS.INTERNAL();
    }

    // 先校验目标文件夹（拒绝路径分隔/逃逸），再做其他编排
    const libraryFolder = normalizeLibraryFolder(input.folder);

    // 「我的资产」为全局资产库（不属任何生产项目）：任务/资产行归属系统资产库项目
    //（生产任务表 project_id 为 NOT NULL 外键，必须落到一个真实项目上）。
    const libraryProjectId = await ensureAssetLibraryProject(
      deps.production,
      deps.workspaceService,
      userId,
    );
    const ctx: HandlerCtx = {
      userId,
      assetsRoot,
      generationService: deps.generationService,
      libraryProjectId,
      libraryFolder,
    };

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
// 系统资产库项目（「我的资产」生成的归属容器）辅助
// ===========================================================================

/** 资产库目标文件夹校验：仅允许单段名称（禁止路径分隔/逃逸），缺省「默认」 */
export function normalizeLibraryFolder(raw?: string): string {
  const folder = (raw ?? "").trim() === "" ? "默认" : raw!.trim();
  if (folder === "." || folder === ".." || /[\\/]/.test(folder) || folder.length > 60) {
    throw ERRORS.INVALID_INPUT("资产文件夹不合法");
  }
  return folder;
}

/**
 * 按用户幂等解析系统资产库项目（用户默认工作区下）：
 * 优先按描述哨兵匹配（用户改名仍可识别）→ 再按名称匹配 → 都不存在则创建。
 */
async function ensureAssetLibraryProject(
  production: ProductionService,
  workspaceService: WorkspaceService,
  userId: string,
): Promise<string> {
  const workspace = await workspaceService.ensureDefault(userId);
  const projects = await production.listProjects(workspace.id);
  const found =
    projects.find(p => p.description?.startsWith(ASSET_LIBRARY_PROJECT_DESC_PREFIX)) ??
    projects.find(p => p.name === ASSET_LIBRARY_PROJECT_NAME);
  if (found) return found.id;
  const created = await production.createProject({
    workspaceId: workspace.id,
    name: ASSET_LIBRARY_PROJECT_NAME,
    description: `${ASSET_LIBRARY_PROJECT_DESC_PREFIX}——「我的资产」页生成的资产归属此项目；请勿删除。`,
  });
  return created.id;
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
      projectId: ctx.libraryProjectId,
      userId: ctx.userId,
      prompt,
      size: "1024x1024",
      assetName: `${assetLabels[input.genType]} ${input.name} #${i + 1}`,
      // 结果由 worker 发布到资产库文件夹（web「我的资产」按英文类型 id ↔ 中文目录映射）
      assetLibrary: { folder: ctx.libraryFolder, type: input.genType },
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
      projectId: ctx.libraryProjectId,
      userId: ctx.userId,
      prompt: previewText,
      assetName: `${input.name} #${i + 1}`,
      assetLibrary: { folder: ctx.libraryFolder, type: "voice" },
    });
    taskIds.push(task.id);
  }

  return { assetIds: [], taskIds, total: input.count };
}
