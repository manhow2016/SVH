import { hash, verify } from "@node-rs/argon2";

/**
 * 密码哈希（Argon2，文档 §6 要求；禁止明文保存）。
 *
 * 参数采用 OWASP 建议的中等成本参数（适合交互式登录）。
 */
const ARGON2_OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** 生成密码哈希 */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** 校验密码（哈希非法时返回 false，不抛错） */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/** 密码强度校验（文档 §3.1：注册/改密统一策略） */
export function validatePassword(password: string): boolean {
  if (password.length < 8) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}
