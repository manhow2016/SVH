/**
 * media 鉴权流式路由（资产本地化 spec §5）。
 *
 * `GET /api/media/:assetId?token=<JWT>`：本地化产物的唯一送达通道。
 * token 走 query 是因为 `<img>/<video>` 无法携带 Authorization 头；
 * 全局 auth 钩子对 /api/media 前缀豁免（app.ts），由本路由自验 query.token
 * ——与 Bearer 同一条 AuthService.verifyToken 验签路径 + getUserForAuth 用户态
 * 检查（终审 I2 同强度），不改 Bearer 行为。
 *
 * 语义钉（Task 2 入库契约，前端 Task 5 依赖）：
 * - ready 谓词：workspacePath != null && metadata.localization.state === "ready"，否则 404
 *   （failed/从未转存/越权/不存在一律 404，不泄露存在性）；
 * - 绝对路径 = resolveSafeWorkspacePath(join(workspaceRoot, asset.workspaceId), workspacePath)，
 *   root 带 wsId 段（与 WorkspaceManager 的 rootPath 同形），防 DB 被篡改后逃逸；
 * - Content-Type 以 DB assets.mimeType 为准（worker 契约：文件名按 kind 先行兜底，
 *   .png 名内可能是 jpeg）；mime 为空才按扩展名小表兜底；仍未知 → application/octet-stream；
 * - stat 失败或非普通文件 → 410（曾 ready 但文件丢失，前端据此引导重新转存/生成）；
 * - Range 仅支持标准单区间（206 + Content-Range）；多区间按无 Range 全量 200；
 *   start ≥ 文件长或语法坏 → 416（附 Content-Range 报告总大小）；
 * - 错误体走全局 normalizeError → ServerError 形状（web 端 error.code 兼容）。
 */
import path from "node:path";
import { createReadStream } from "node:fs";
import { promises as fsp } from "node:fs";
import type { FastifyInstance } from "fastify";
import { LOCALIZE_METADATA_KEY, type LocalizeMetadata, type ProductionService } from "@svh/production";
import { resolveSafeWorkspacePath } from "@svh/workspace";
import type { AuthService } from "../modules/auth/service";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS, ServerError } from "../lib/errors";

export interface MediaRouteDeps {
  production: ProductionService;
  authService: AuthService;
  workspaceService: WorkspaceService;
  workspaceRoot: string;
}

/** 资产不存在/不可见/无权限统一 404（不泄露存在性，与 spec §5 步骤 2 对齐） */
const MEDIA_NOT_FOUND = () => new ServerError("NOT_FOUND", "资产不存在或不可访问", 404);
/** 曾 ready 但文件已丢失：410 显式区别于 404，前端可提示「重新转存」 */
const MEDIA_GONE = () => new ServerError("MEDIA_FILE_GONE", "本地化文件已丢失，请重试转存或重新生成", 410);
/** 区间不可满足（RFC 7233：坏语法/start 越界） */
const RANGE_UNSATISFIABLE = (message = "Range 不可满足") =>
  new ServerError("RANGE_NOT_SATISFIABLE", message, 416);

/** mimeType 缺省时的扩展名兜底小表（只覆盖转存白名单，其余一律 octet-stream） */
const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
};

/** 单区间解析：仅接受 `bytes=a-b` / `bytes=a-` / `bytes=-n`（suffix）；其余（含多区间）返回 null=按无 Range 处理 */
function parseSingleRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header || !header.startsWith("bytes=")) return null;
  // 零字节文件退化态（修复轮 1 M2）：任何区间都不可满足；必须在 suffix 分支前拦截，
  // 否则 size-n 下溢产出 end=-1 → "bytes 0--1/0" 畸形 Content-Range。
  if (size === 0) return "unsatisfiable";
  const spec = header.slice("bytes=".length);
  if (spec.includes(",")) return null; // 多区间：本期不支持，按无 Range 全量送达
  const [rawStart, rawEnd, extra] = spec.split("-");
  if (extra !== undefined || (rawStart === "" && rawEnd === "")) return "unsatisfiable"; // 语法坏
  const digitsOk = (s: string) => s === "" || /^\d+$/.test(s);
  if (!digitsOk(rawStart ?? "") || !digitsOk(rawEnd ?? "")) return "unsatisfiable";
  if (rawStart === "") {
    // suffix 区间 `bytes=-n`：末尾 n 字节（n=0 无意义 → 坏）
    const n = Number(rawEnd);
    if (!n) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable"; // 空文件时任何 start 都越界
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  app.get<{ Params: { assetId: string }; Querystring: { token?: string } }>(
    "/api/media/:assetId",
    async (req, reply) => {
      // 1) 鉴权：query.token 验签（与 Bearer 同一 verifyToken 路径；失败即 401）。
      // 重复键（?token=a&token=b）运行态为 string[]：truthy 进入验签即抛 → 401（用例已钉）。
      const token = req.query.token;
      if (!token) throw ERRORS.UNAUTHORIZED();
      const { userId } = await deps.authService.verifyToken(token);
      // 用户态检查（终审 I2）：与 Bearer 中间件同强度（getUserForAuth + disabled 拒）——
      // 验签通过 ≠ 放行。disabled/不存在/DB 查失败一律 401，与坏 token 逐字同形
      //（Bearer 侧 403 USER_DISABLED 的对话方在 query-token 送达通道不存在，统一保守
      //  401，不新增探测差分；被禁用即刻断送达，无宽限期）。
      const user = await deps.authService.getUserForAuth(userId).catch(() => null);
      if (!user || user.status === "disabled") {
        throw ERRORS.UNAUTHORIZED("登录已过期，请重新登录");
      }

      // 2) 资产 + 归属（asset.projectId → 项目工作区 → 用户；越权与不存在同为 404）
      // catch-all 说明（修复轮 1 M4）：DB 故障同样收敛 404——media 是只读送达面，
      // 「查无/查炸」在响应上不区分反而消灭存在性探测差值；V1 接受该可用性取舍。
      const asset = await deps.production.getAsset(req.params.assetId).catch(() => {
        throw MEDIA_NOT_FOUND();
      });
      const project = await deps.production.getProject(asset.projectId).catch(() => {
        throw MEDIA_NOT_FOUND();
      });
      // 归属失败（他人工作区/工作区已删）必须同构 404：getOwned 的 WORKSPACE_NOT_FOUND
      // 裸透传会让「越权」与「不存在」响应体可辨，成为存在性 oracle（修复轮 1 I1）。
      await deps.workspaceService.getOwned(project.workspaceId, userId).catch(() => {
        throw MEDIA_NOT_FOUND();
      });

      // 3) ready 谓词（Task 2 契约：failed 行 workspacePath 恒 null，双保险仍需两判）
      const meta = asset.metadata?.[LOCALIZE_METADATA_KEY] as LocalizeMetadata | undefined;
      if (!asset.workspacePath || meta?.state !== "ready") throw MEDIA_NOT_FOUND();

      // 4) 安全绝对路径（root 带 wsId 段；越界抛 WorkspaceError → normalizeError → 400）
      const abs = resolveSafeWorkspacePath(
        path.join(deps.workspaceRoot, asset.workspaceId),
        asset.workspacePath,
      );

      // 5) stat 兜底：ready ≠ 文件在（误删/迁移丢盘），ENOENT 或非普通文件 → 410
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        throw MEDIA_GONE();
      }
      if (!stat.isFile()) throw MEDIA_GONE();
      const size = stat.size;

      // 6) Content-Type：DB mimeType 为权威；空才按扩展名兜底；未知 octet-stream
      const contentType =
        asset.mimeType?.trim() ||
        MIME_BY_EXT[path.extname(asset.workspacePath).replace(".", "").toLowerCase()] ||
        "application/octet-stream";

      // 7) Range（单区间 206；多区间/无 200；坏/越界 416）
      const range = parseSingleRange(req.headers.range, size);
      if (range === "unsatisfiable") {
        reply.header("Content-Range", `bytes */${size}`);
        throw RANGE_UNSATISFIABLE();
      }

      reply.header("Content-Type", contentType);
      reply.header("Accept-Ranges", "bytes");
      // 统一走带 end 的流式管道：end 固定为 size-1（200 全量同理），
      // 保证实际送达字节恒等于 Content-Length，防 stat 后文件截断导致悬垂连接
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      if (range) {
        reply.status(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      reply.header("Content-Length", String(length));

      if (size === 0) return reply.send(); // 空文件：只回头，无正文
      const stream = createReadStream(abs, { start, end });
      // 客户端断开/响应异常结束：销毁读流防句柄泄漏；错误后静默（此时多半已半截送达）
      stream.on("error", () => stream.destroy());
      reply.raw.on("close", () => {
        if (!stream.destroyed) stream.destroy();
      });
      return reply.send(stream);
    },
  );
}
