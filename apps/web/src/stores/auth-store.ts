import { create } from "zustand";
import { authApi } from "../api/auth";
import { ApiError, setAuthToken } from "../api/client";
import type { PublicUser } from "../types/membership-types";

type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthState {
  status: AuthStatus;
  token: string | null;
  user: PublicUser | null;
  /** 登录（用户名/邮箱 + 密码），成功后写入 token 与用户 */
  login: (identifier: string, password: string) => Promise<void>;
  /** 注册，成功后自动登录 */
  register: (input: { username: string; email: string; password: string }) => Promise<void>;
  /** 退出登录 */
  logout: () => void;
  /** 应用启动时恢复会话（token → /api/auth/me） */
  load: () => Promise<void>;
}

/**
 * 认证状态 Store（文档 §32）。
 * token 持久化在 localStorage（svh_token），由 api/client 统一注入请求头。
 */
export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  token: null,
  user: null,

  async login(identifier, password) {
    const { token, user } = await authApi.login({ identifier, password });
    setAuthToken(token);
    set({ status: "authenticated", token, user });
  },

  async register(input) {
    const { token, user } = await authApi.register(input);
    setAuthToken(token);
    set({ status: "authenticated", token, user });
  },

  logout() {
    setAuthToken(null);
    set({ status: "anonymous", token: null, user: null });
  },

  async load() {
    try {
      const { user } = await authApi.me();
      set({ status: "authenticated", user });
    } catch (err) {
      // 401 或网络错误：清除本地 token 回到登录页
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
        setAuthToken(null);
      }
      set({ status: "anonymous", token: null, user: null });
    }
  },
}));
