import { eq } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { randomId } from "@svh/shared";
import { users, type SVHDatabase } from "@svh/database";
import { ERRORS } from "../../lib/errors";
import { hashPassword, verifyPassword, validatePassword } from "./password";
import type { JwtPayload, PublicUser, UserRole } from "./types";
import type { UserService } from "../user/service";

const TOKEN_TTL = "7d";

/**
 * 认证服务（文档 §22/§23）：
 * 注册 / 登录 / JWT 签发与验证 / 修改密码 / 管理员引导账号。
 */
export class AuthService {
  constructor(
    private readonly db: SVHDatabase,
    private readonly userService: UserService,
    private readonly jwtSecret: string,
  ) {}

  /** 注册 */
  async register(input: {
    username: string;
    email: string;
    password: string;
  }): Promise<{ token: string; user: PublicUser }> {
    const username = input.username?.trim();
    const email = input.email?.trim().toLowerCase();
    if (!username || username.length < 2) throw ERRORS.INVALID_INPUT("用户名至少 2 个字符");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw ERRORS.INVALID_INPUT("邮箱格式不正确");
    }
    if (!validatePassword(input.password ?? "")) throw ERRORS.WEAK_PASSWORD();

    if (await this.userService.getByUsername(username)) throw ERRORS.USERNAME_TAKEN();
    if (await this.userService.getByEmail(email)) throw ERRORS.EMAIL_TAKEN();

    const now = new Date();
    const passwordHash = await hashPassword(input.password);
    await this.db.insert(users).values({
      id: randomId("usr"),
      username,
      email,
      passwordHash,
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const user = await this.userService.getByUsername(username);
    const token = await this.signToken(user!.id, user!.role as UserRole);
    return { token, user: this.userService.toPublic(user!) };
  }

  /** 登录（用户名或邮箱 + 密码） */
  async login(identifier: string, password: string): Promise<{ token: string; user: PublicUser }> {
    const user = await this.userService.findByIdentifier(identifier.trim());
    if (!user || !(await verifyPassword(user.passwordHash, password ?? ""))) {
      throw ERRORS.INVALID_CREDENTIALS();
    }
    if (user.status === "disabled") throw ERRORS.USER_DISABLED();
    const token = await this.signToken(user.id, user.role as UserRole);
    return { token, user: this.userService.toPublic(user) };
  }

  /** JWT 签发 */
  async signToken(userId: string, role: UserRole): Promise<string> {
    const secret = new TextEncoder().encode(this.jwtSecret);
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(secret);
  }

  /** JWT 校验（失败抛 UNAUTHORIZED） */
  async verifyToken(token: string): Promise<JwtPayload> {
    try {
      const secret = new TextEncoder().encode(this.jwtSecret);
      const { payload } = await jwtVerify(token, secret);
      if (!payload.sub) throw new Error("missing sub");
      return { userId: payload.sub, role: (payload.role as UserRole) ?? "user" };
    } catch {
      throw ERRORS.UNAUTHORIZED("登录已过期，请重新登录");
    }
  }

  /** 认证中间件加载用户（含状态校验） */
  async getUserForAuth(userId: string) {
    return this.userService.getById(userId);
  }

  /** 修改密码（需校验旧密码） */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.userService.getById(userId);
    if (!user) throw ERRORS.UNAUTHORIZED();
    if (!(await verifyPassword(user.passwordHash, oldPassword ?? ""))) {
      throw ERRORS.INVALID_INPUT("原密码不正确");
    }
    if (!validatePassword(newPassword ?? "")) throw ERRORS.WEAK_PASSWORD();
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  /** 管理员引导账号（§24）：无引导账号时创建，并打印默认口令告警 */
  async ensureBootstrapAdmin(
    username: string,
    password: string,
    email: string,
  ): Promise<{ created: boolean; user: PublicUser }> {
    const existing = await this.userService.getByUsername(username);
    if (existing) {
      return { created: false, user: this.userService.toPublic(existing) };
    }
    const admin = await this.userService.getByEmail(email);
    if (admin) {
      // 邮箱冲突但用户名不同：复用该用户并提升为管理员
      await this.db.update(users).set({ role: "admin", updatedAt: new Date() }).where(eq(users.email, email));
      const updated = await this.userService.getByEmail(email);
      return { created: false, user: this.userService.toPublic(updated!) };
    }
    const now = new Date();
    const passwordHash = await hashPassword(password);
    await this.db.insert(users).values({
      id: randomId("usr"),
      username,
      email,
      passwordHash,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const user = await this.userService.getByUsername(username);
    return { created: true, user: this.userService.toPublic(user!) };
  }
}
