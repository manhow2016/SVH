import type { FastifyInstance } from "fastify";
import type { AuthService } from "../modules/auth/service";
import type { UserService } from "../modules/user/service";
import { ERRORS } from "../lib/errors";

export interface AuthRouteDeps {
  authService: AuthService;
  userService: UserService;
}

/** 认证 API（文档 §22）：注册 / 登录 / 当前用户 / 修改密码 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  // 注册
  app.post<{ Body: { username?: string; email?: string; password?: string } }>(
    "/api/auth/register",
    async (req, reply) => {
      const { username, email, password } = req.body ?? {};
      const result = await deps.authService.register({
        username: username ?? "",
        email: email ?? "",
        password: password ?? "",
      });
      return reply.code(201).send(result);
    },
  );

  // 登录（用户名或邮箱）
  app.post<{ Body: { identifier?: string; password?: string } }>(
    "/api/auth/login",
    async (req) => {
      const { identifier, password } = req.body ?? {};
      if (!identifier || !password) throw ERRORS.INVALID_INPUT("请输入用户名/邮箱和密码");
      return deps.authService.login(identifier, password);
    },
  );

  // 当前用户信息
  app.get("/api/auth/me", async (req) => {
    const user = await deps.userService.getById(req.user!.userId);
    if (!user) throw ERRORS.UNAUTHORIZED();
    return { user: deps.userService.toPublic(user) };
  });

  // 修改密码
  app.post<{ Body: { oldPassword?: string; newPassword?: string } }>(
    "/api/auth/change-password",
    async (req) => {
      const { oldPassword, newPassword } = req.body ?? {};
      if (!oldPassword || !newPassword) throw ERRORS.INVALID_INPUT("参数不完整");
      await deps.authService.changePassword(req.user!.userId, oldPassword, newPassword);
      return { ok: true };
    },
  );
}
