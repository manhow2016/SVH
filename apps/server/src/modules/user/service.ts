import { and, desc, eq, like, or } from "drizzle-orm";
import { users, type SVHDatabase, type UserRow } from "@svh/database";
import type { PublicUser, UserRole, UserStatus } from "../auth/types";

/**
 * 用户数据访问服务（文档 §34 modules/user/service.ts）。
 *
 * 密码相关逻辑在 modules/auth/password.ts，本服务只做数据存取。
 */
export class UserService {
  constructor(private readonly db: SVHDatabase) {}

  toPublic(user: UserRow): PublicUser {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async getById(id: string): Promise<UserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getByUsername(username: string): Promise<UserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return rows[0] ?? null;
  }

  async getByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0] ?? null;
  }

  /** 登录账号：用户名 或 邮箱 */
  async findByIdentifier(identifier: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(or(eq(users.username, identifier), eq(users.email, identifier)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 管理员：用户列表（支持按关键字过滤） */
  async list(keyword?: string): Promise<UserRow[]> {
    const q = keyword?.trim();
    if (q) {
      return this.db
        .select()
        .from(users)
        .where(or(like(users.username, `%${q}%`), like(users.email, `%${q}%`)))
        .orderBy(desc(users.createdAt));
    }
    return this.db.select().from(users).orderBy(desc(users.createdAt));
  }

  /** 管理员：更新状态 / 角色 */
  async update(id: string, patch: { status?: UserStatus; role?: UserRole }): Promise<UserRow> {
    const now = new Date();
    const next: Partial<UserRow> = {};
    if (patch.status) next.status = patch.status;
    if (patch.role) next.role = patch.role;
    if (Object.keys(next).length === 0) {
      return (await this.getById(id))!;
    }
    await this.db
      .update(users)
      .set({ ...next, updatedAt: now })
      .where(and(eq(users.id, id)));
    return (await this.getById(id))!;
  }
}
