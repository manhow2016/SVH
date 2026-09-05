/** 会员功能权限（文档 §8/§15） */
export interface FeaturePermission {
  enabled: boolean;
  /** 功能配置（JSON 字符串解析后），例如 { maxWorkspaces: 3 } */
  config?: Record<string, unknown> | null;
}

/** 会员等级 Code（文档 §3.2） */
export type TierCode = "free" | "pro" | "enterprise";

/** 当前会员（文档 §15 返回结构） */
export interface CurrentMembership {
  tier: {
    code: TierCode;
    name: string;
  };
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

/** 订阅状态（文档 §11.1） */
export type SubscriptionStatus = "pending" | "active" | "expired" | "cancelled";

/** 折扣类型（文档 §12.1） */
export type DiscountType = "percentage" | "fixed_amount" | "fixed_price";

/** 价格计算结果（文档 §14，单位：最小货币单位/分） */
export interface PriceResult {
  originalPrice: number;
  discountAmount: number;
  finalPrice: number;
  promotionId?: string;
}

/** 有效活动（PromotionService 内部结构） */
export interface ActivePromotion {
  id: string;
  name: string;
  discountType: DiscountType;
  discountValue: number;
  priority: number;
}

/** 价格计算器接口（促销服务实现；套餐/订阅通过该接口获得最终价，依赖倒置） */
export interface PriceCalculator {
  calculatePrice(planId: string): Promise<PriceResult>;
}
