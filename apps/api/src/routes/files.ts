/**
 * 素材文件服务
 *
 * ── 这个路由为什么必须存在 ──
 * `STORAGE_PUBLIC_BASE_URL` 默认指向 `.../files`，而此前**没有任何路由**提供它，
 * API 也没依赖静态文件中间件 —— 于是这个配置项从建立起就是一句空话：
 * 即便产物真的落了盘，写出来的 URL 也是 404。
 *
 * ── 为什么手写而不是引 @fastify/static ──
 * 需要的能力只有两件：按扩展名给对 Content-Type、别让人读到根目录之外。
 * 为一个「发文件」的需求引入一个中间件，会把一个安全敏感面（路径解析）
 * 交给第三方默认行为，而这里恰好必须自己把路径穿越钉死。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { NotFoundError } from '@svh/domain';
import type { FastifyInstance } from 'fastify';

import { getStorageDriver } from '../core/storage.js';

/**
 * 扩展名 → Content-Type。
 *
 * 只列我们自己会写出去的那几种（见 `@svh/storage` 的 `EXT_BY_MIME`）。
 * **刻意不猜**：猜错比不写更糟 —— 浏览器按错误的类型处理，会把一个完好的
 * 文件报成「格式不支持」，正是我们要消除的那种误判。认不出来时退回
 * `application/octet-stream`（下载而不是误解析）。
 */
const CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 取一个素材文件。
   *
   * 通配参数用 `*`：存储键形如 `assets/<projectId>/<日期>/<哈希>.png`，带斜杠。
   * 合法性完全交给驱动去判 —— `resolvePath` 有两道防线（字符白名单 +
   * 解析后的前缀校验），这里**不重复实现**，否则两处判断迟早会分叉。
   */
  app.get('/*', async (request, reply) => {
    const key = (request.params as Record<string, string>)['*'] ?? '';
    if (key.length === 0) {
      throw new NotFoundError('缺少文件路径', { resourceLabel: '素材文件' });
    }

    const driver = getStorageDriver();

    let full: string;
    try {
      full = driver.resolvePath(key);
    } catch {
      // 键非法与越界都按「没有这个文件」处理：不回显内部路径，也不区分二者
      throw new NotFoundError(`素材文件 ${key} 不存在`, { resourceLabel: '素材文件' });
    }

    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new NotFoundError(`素材文件 ${key} 不存在`, { resourceLabel: '素材文件' });
    }

    const contentType = CONTENT_TYPE[extname(key).toLowerCase()] ?? 'application/octet-stream';

    /*
     * 内容哈希命名 ⇒ 同一个键的内容永不变化，可以放心让浏览器长期缓存。
     * `immutable` 让重复渲染结果卡时不再回源。
     */
    return reply
      .header('Content-Type', contentType)
      .header('Content-Length', String(info.size))
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(createReadStream(full));
  });
}
