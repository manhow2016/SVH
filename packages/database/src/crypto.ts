/**
 * 密钥加解密（AES-256-GCM）
 *
 * 用途：加密用户自带的模型 API Key（`model_providers.apiKeyEncrypted`）。
 *
 * 三条约束：
 * 1. **认证加密**：使用 GCM 模式，密文被篡改时解密会失败而不是返回脏数据
 * 2. **随机 IV**：每次加密生成新 IV，相同明文产生不同密文（避免模式泄漏）
 * 3. **密钥来自配置**：`SECRET_ENCRYPTION_KEY` 由 @svh/config 校验
 *    （含弱默认值黑名单），不在代码中保留任何默认密钥
 *
 * 密文格式：`v1:<iv 的 hex>:<authTag 的 hex>:<密文的 hex>`
 * 带版本号是为了将来轮换算法时能识别并迁移旧密文。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const VERSION = 'v1';

/**
 * 由配置字符串派生出 32 字节密钥。
 *
 * 用 SHA-256 派生而非直接截断：允许用户提供任意长度的强随机字符串
 * （例如 `openssl rand -hex 32` 的 64 字符），同时保证密钥长度正确。
 */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** 加密明文 */
export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * 解密密文。
 *
 * @throws {Error} 格式非法、密钥不匹配或密文被篡改时抛出
 */
export function decryptSecret(ciphertext: string, secret: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('密文格式非法（期望 v1:<iv>:<tag>:<data>）');
  }

  const ivHex = parts[1];
  const tagHex = parts[2];
  const dataHex = parts[3];
  if (ivHex === undefined || tagHex === undefined || dataHex === undefined) {
    throw new Error('密文分段缺失');
  }

  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/**
 * 生成用于展示的密钥掩码。
 *
 * 只保留前 3 位与后 4 位 —— 足够让用户确认「是不是这把钥匙」，
 * 又不足以还原密钥。
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return `${plaintext.slice(0, 3)}****${plaintext.slice(-4)}`;
}

/**
 * 常量时间比较，用于校验密钥 / 令牌，避免时序侧信道。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
