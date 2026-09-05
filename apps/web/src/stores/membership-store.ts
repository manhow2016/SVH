import { create } from "zustand";
import { membershipApi } from "../api/membership";
import type { CurrentMembership } from "../types/membership-types";

interface MembershipState {
  membership: CurrentMembership | null;
  loading: boolean;
  /** 拉取当前会员（等级 / 订阅 / 功能权限） */
  load: () => Promise<void>;
  /** 功能权限判断（文档 §32 membership.can） */
  can: (featureCode: string) => boolean;
  /** 获取功能配置（如 maxWorkspaces），未启用返回 null */
  getConfig: <T>(featureCode: string) => T | null;
  /** 当前等级的资源限制（软件资源限制，非 Token 限制，§21） */
  maxWorkspaces: () => number | undefined;
}

/**
 * 会员状态 Store（文档 §32）。
 *
 * 前端仅用于 UI 展示与提示；核心权限必须由后端校验（文档 §33）。
 */
export const useMembershipStore = create<MembershipState>((set, get) => ({
  membership: null,
  loading: false,

  async load() {
    set({ loading: true });
    try {
      const membership = await membershipApi.current();
      set({ membership, loading: false });
    } catch {
      // 登录态失效等情况：保持现状（由 auth 流程处理）
      set({ loading: false });
    }
  },

  can(featureCode) {
    const m = get().membership;
    if (!m) return false;
    return m.features[featureCode]?.enabled === true;
  },

  getConfig(featureCode) {
    const m = get().membership;
    const permission = m?.features[featureCode];
    if (!permission?.enabled) return null;
    return (permission.config as never) ?? null;
  },

  maxWorkspaces() {
    const m = get().membership;
    if (!m) return undefined;
    for (const permission of Object.values(m.features)) {
      if (!permission.enabled || !permission.config) continue;
      const value = permission.config["maxWorkspaces"];
      if (typeof value === "number") return value;
    }
    return undefined;
  },
}));
