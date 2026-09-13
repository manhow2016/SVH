/**
 * API 侧的存储驱动
 *
 * ── 为什么 API 也要一份 ──
 * 落盘发生在 Worker（技能执行时），但**读文件与判定存在性**发生在 API：
 *   · `GET /files/*` 要把文件发出去；
 *   · `GET /api/assets/:id/media-health` 要告诉界面「这份媒体还在不在我们手里」。
 * 两边必须指向**同一个根目录**，否则「Worker 落盘成功、API 说文件不存在」
 * 会成为一个极难归因的现象。因此共用 `STORAGE_LOCAL_DIR` 与
 * `STORAGE_PUBLIC_BASE_URL` 两个配置，驱动实例在本进程内缓存一份。
 */
import { derivedConfig } from '@svh/config';
import { LocalStorageDriver, type StorageDriver } from '@svh/storage';

let cached: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  const config = derivedConfig();
  cached ??= new LocalStorageDriver({
    // 用解析好的绝对路径：相对路径会按各进程的 cwd 解析，API 与 Worker 会指向不同目录
    rootDir: config.storageLocalDir,
    publicBaseUrl: config.storagePublicBaseUrl,
  });
  return cached;
}

/** 重置缓存（测试用） */
export function __resetStorageDriver(): void {
  cached = null;
}
