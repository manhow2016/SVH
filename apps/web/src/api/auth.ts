import { get, post } from "./client";
import type { PublicUser } from "../types/membership-types";

/** 认证 API（文档 §22） */
export const authApi = {
  register(input: { username: string; email: string; password: string }) {
    return post<{ token: string; user: PublicUser }>("/api/auth/register", input);
  },
  login(input: { identifier: string; password: string }) {
    return post<{ token: string; user: PublicUser }>("/api/auth/login", input);
  },
  me() {
    return get<{ user: PublicUser }>("/api/auth/me");
  },
  changePassword(input: { oldPassword: string; newPassword: string }) {
    return post<{ ok: true }>("/api/auth/change-password", input);
  },
};
