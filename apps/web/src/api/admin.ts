import { del, get, patch, post, put } from "./client";
import type {
  MembershipFeatureView,
  MembershipTierView,
  PlanView,
  PromotionView,
  PublicUser,
  SubscriptionView,
  UserRole,
  UserStatus,
} from "../types/membership-types";
import type { ModelType } from "../types/api-types";

export interface AdminPlanInput {
  tierId?: string;
  tierCode?: string;
  name: string;
  description?: string;
  durationDays: number;
  originalPrice: number;
  currency?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export interface AdminPromotionInput {
  name: string;
  description?: string;
  discountType: "percentage" | "fixed_amount" | "fixed_price";
  discountValue: number;
  startedAt?: number;
  endedAt?: number | null;
  enabled?: boolean;
  priority?: number;
  planIds?: string[];
}

/** 管理员视图：模型（含供应商名与启用状态） */
export interface AdminModelView {
  id: string;
  providerId: string;
  providerName: string;
  modelName: string;
  type: ModelType;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
}

export interface AdminModelInput {
  providerId: string;
  modelName: string;
  type: ModelType;
  displayName: string;
  enabled?: boolean;
  sortOrder?: number;
}

/** 管理员 API（文档 §24/§26） */
export const adminApi = {
  // 用户
  listUsers(keyword?: string) {
    return get<{ users: PublicUser[] }>(
      keyword ? `/api/admin/users?keyword=${encodeURIComponent(keyword)}` : "/api/admin/users",
    );
  },
  updateUser(
    id: string,
    body: { status?: UserStatus; role?: UserRole },
  ) {
    return patch<{ user: PublicUser }>(`/api/admin/users/${id}`, body);
  },

  // 会员等级
  listTiers() {
    return get<{ tiers: MembershipTierView[] }>("/api/admin/membership/tiers");
  },
  createTier(body: {
    code: string;
    name: string;
    description?: string;
    sortOrder?: number;
    enabled?: boolean;
  }) {
    return post<{ tier: MembershipTierView }>("/api/admin/membership/tiers", body);
  },
  updateTier(
    id: string,
    body: { name?: string; description?: string; sortOrder?: number; enabled?: boolean },
  ) {
    return patch<{ tier: MembershipTierView }>(`/api/admin/membership/tiers/${id}`, body);
  },

  // 功能
  listFeatures() {
    return get<{ features: MembershipFeatureView[] }>("/api/admin/membership/features");
  },
  createFeature(body: { code: string; name: string; description?: string }) {
    return post<{ feature: MembershipFeatureView }>("/api/admin/membership/features", body);
  },
  updateFeature(id: string, body: { name?: string; description?: string }) {
    return patch<{ feature: MembershipFeatureView }>(
      `/api/admin/membership/features/${id}`,
      body,
    );
  },
  setTierFeatures(
    tierId: string,
    features: Array<{ code: string; enabled: boolean; config?: Record<string, unknown> }>,
  ) {
    return put<{ features: MembershipTierView["features"] }>(
      `/api/admin/membership/tiers/${tierId}/features`,
      { features },
    );
  },

  // 套餐
  listPlans() {
    return get<{ plans: PlanView[] }>("/api/admin/membership/plans");
  },
  createPlan(body: AdminPlanInput) {
    return post<{ plan: PlanView }>("/api/admin/membership/plans", body);
  },
  updatePlan(id: string, body: Partial<AdminPlanInput>) {
    return patch<{ plan: PlanView }>(`/api/admin/membership/plans/${id}`, body);
  },

  // 订阅
  listSubscriptions() {
    return get<{ subscriptions: SubscriptionView[] }>("/api/admin/subscriptions");
  },
  grantSubscription(userId: string, planId: string) {
    return post<{ subscription: SubscriptionView }>("/api/admin/subscriptions/grant", {
      userId,
      planId,
    });
  },

  // 活动
  listPromotions() {
    return get<{ promotions: PromotionView[] }>("/api/admin/promotions");
  },
  createPromotion(body: AdminPromotionInput) {
    return post<{ promotion: PromotionView }>("/api/admin/promotions", body);
  },
  updatePromotion(id: string, body: Partial<AdminPromotionInput>) {
    return patch<{ promotion: PromotionView }>(`/api/admin/promotions/${id}`, body);
  },

  // 可用模型（管理员维护：模型名 / 类型 / 显示名称）
  listModels() {
    return get<{ models: AdminModelView[] }>("/api/admin/models");
  },
  createModel(body: AdminModelInput) {
    return post<{ model: AdminModelView }>("/api/admin/models", body);
  },
  updateModel(id: string, body: Partial<AdminModelInput>) {
    return patch<{ model: AdminModelView }>(`/api/admin/models/${id}`, body);
  },
  deleteModel(id: string) {
    return del(`/api/admin/models/${id}`);
  },
};
