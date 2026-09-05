/** 会员系统前后端共享类型（文档 §15/§25/§26） */

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export type TierCode = "free" | "pro" | "enterprise";
export type SubscriptionStatus = "pending" | "active" | "expired" | "cancelled";
export type DiscountType = "percentage" | "fixed_amount" | "fixed_price";

export interface FeaturePermission {
  enabled: boolean;
  config?: Record<string, unknown> | null;
}

export interface CurrentMembership {
  tier: { code: TierCode; name: string };
  /** 管理员账户（默认最高权限，无需订阅） */
  isAdmin?: boolean;
  subscription?: {
    id: string;
    status: SubscriptionStatus;
    startedAt: number;
    expiresAt: number;
  };
  features: Record<string, FeaturePermission>;
}

export interface PriceResult {
  originalPrice: number;
  discountAmount: number;
  finalPrice: number;
  promotionId?: string;
}

export interface PlanView {
  id: string;
  tierId: string;
  name: string;
  description: string;
  durationDays: number;
  originalPrice: number;
  currency: string;
  enabled: boolean;
  sortOrder: number;
  tier: { code: TierCode; name: string };
  price?: PriceResult;
}

export interface SubscriptionView {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  tierId: string;
  tierName: string;
  tierCode: string;
  status: SubscriptionStatus;
  startedAt: number;
  expiresAt: number;
  originalPrice: number;
  discountAmount: number;
  paidAmount: number;
  createdAt: number;
  updatedAt: number;
  username?: string;
}

export interface MembershipTierView {
  id: string;
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
  created_at?: string;
  features?: Array<{
    id: string;
    code: string;
    name: string;
    enabled: boolean;
    config: unknown;
  }>;
}

export interface MembershipFeatureView {
  id: string;
  code: string;
  name: string;
  description: string;
}

export interface PromotionView {
  id: string;
  name: string;
  description: string;
  discountType: DiscountType;
  discountValue: number;
  startedAt: number;
  endedAt: number | null;
  enabled: boolean;
  priority: number;
  planIds: string[];
  createdAt: number;
  updatedAt: number;
}
