import type { UserRow } from "@svh/database";

/** 用户角色（文档 §6） */
export type UserRole = "user" | "admin";

/** 用户状态（文档 §6） */
export type UserStatus = "active" | "disabled";

/** JWT Payload（文档 §23） */
export interface JwtPayload {
  userId: string;
  role: UserRole;
}

/** 认证成功后挂载到 request.user 的身份（文档 §23） */
export interface AuthUser {
  userId: string;
  role: UserRole;
  username: string;
}

/** 对外暴露的用户信息（不包含 passwordHash） */
export type PublicUser = Omit<UserRow, "passwordHash">;

declare module "fastify" {
  interface FastifyRequest {
    /** 由 authenticate 中间件挂载（仅认证后的路由存在） */
    user?: AuthUser;
  }
}
