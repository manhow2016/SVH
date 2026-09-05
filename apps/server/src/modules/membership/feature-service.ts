import { eq, inArray } from "drizzle-orm";
import { randomId } from "@svh/shared";
import {
  membershipFeatures,
  membershipTiers,
  tierFeatures,
  type MembershipFeatureRow,
  type MembershipTierRow,
  type SVHDatabase,
} from "@svh/database";
import { ERRORS } from "../../lib/errors";

/** 管理员写入等级-功能关联的项 */
export interface SetTierFeatureInput {
  code: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

/**
 * 会员等级 / 功能 / 关联配置服务（§8/§24：后台可配置）。
 *
 * 价格与功能配置全部可配置，业务代码不硬编码（原则 9）。
 */
export class FeatureService {
  constructor(private readonly db: SVHDatabase) {}

  // ---- 会员等级 ----

  listTiers(): Promise<MembershipTierRow[]> {
    return this.db.select().from(membershipTiers).orderBy(membershipTiers.sortOrder);
  }

  getTierByCode(code: string): Promise<MembershipTierRow | null> {
    const rows = this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.code, code))
      .limit(1);
    return rows.then((r) => r[0] ?? null);
  }

  async createTier(input: {
    code: string;
    name: string;
    description?: string;
    sortOrder?: number;
    enabled?: boolean;
  }): Promise<MembershipTierRow> {
    const code = input.code?.trim();
    if (!code) throw ERRORS.INVALID_INPUT("code is required");
    if (!input.name?.trim()) throw ERRORS.INVALID_INPUT("name is required");
    if (await this.getTierByCode(code)) throw ERRORS.INVALID_INPUT("code 已存在");
    const now = new Date();
    const rows = await this.db
      .insert(membershipTiers)
      .values({
        id: randomId("tier"),
        code,
        name: input.name.trim(),
        description: input.description ?? "",
        sortOrder: input.sortOrder ?? 0,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rows[0]!;
  }

  async updateTier(
    id: string,
    patch: Partial<Pick<MembershipTierRow, "name" | "description" | "sortOrder" | "enabled">>,
  ): Promise<MembershipTierRow> {
    const existing = await this.getTierById(id);
    if (!existing) throw ERRORS.INVALID_INPUT("等级不存在");
    const now = new Date();
    await this.db
      .update(membershipTiers)
      .set({ ...patch, updatedAt: now })
      .where(eq(membershipTiers.id, id));
    return (await this.getTierById(id))!;
  }

  getTierById(id: string): Promise<MembershipTierRow | null> {
    return this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);
  }

  // ---- 功能 ----

  listFeatures(): Promise<MembershipFeatureRow[]> {
    return this.db.select().from(membershipFeatures).orderBy(membershipFeatures.code);
  }

  async createFeature(input: {
    code: string;
    name: string;
    description?: string;
  }): Promise<MembershipFeatureRow> {
    const code = input.code?.trim();
    if (!code) throw ERRORS.INVALID_INPUT("code is required");
    if (!input.name?.trim()) throw ERRORS.INVALID_INPUT("name is required");
    const exists = await this.db
      .select()
      .from(membershipFeatures)
      .where(eq(membershipFeatures.code, code))
      .limit(1);
    if (exists[0]) throw ERRORS.INVALID_INPUT("code 已存在");
    const now = new Date();
    const rows = await this.db
      .insert(membershipFeatures)
      .values({
        id: randomId("feat"),
        code,
        name: input.name.trim(),
        description: input.description ?? "",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rows[0]!;
  }

  async updateFeature(
    id: string,
    patch: Partial<Pick<MembershipFeatureRow, "name" | "description">>,
  ): Promise<MembershipFeatureRow> {
    const existing = await this.getFeatureById(id);
    if (!existing) throw ERRORS.INVALID_INPUT("功能不存在");
    await this.db
      .update(membershipFeatures)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(membershipFeatures.id, id));
    return (await this.getFeatureById(id))!;
  }

  getFeatureById(id: string): Promise<MembershipFeatureRow | null> {
    return this.db
      .select()
      .from(membershipFeatures)
      .where(eq(membershipFeatures.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);
  }

  // ---- 等级功能关联 ----

  /** 某等级的全部功能（含 code、enabled、config 解析结果） */
  async getTierFeatures(tierId: string): Promise<
    Array<{ id: string; code: string; name: string; enabled: boolean; config: unknown }>
  > {
    const links = await this.db
      .select()
      .from(tierFeatures)
      .where(eq(tierFeatures.tierId, tierId));
    if (links.length === 0) return [];
    const featureRows = await this.db
      .select()
      .from(membershipFeatures)
      .where(inArray(membershipFeatures.id, links.map((l) => l.featureId)));
    const byId = new Map(featureRows.map((f) => [f.id, f]));
    return links.map((l) => ({
      id: l.id,
      code: byId.get(l.featureId)?.code ?? l.featureId,
      name: byId.get(l.featureId)?.name ?? l.featureId,
      enabled: l.enabled,
      config: l.config ? JSON.parse(l.config) : null,
    }));
  }

  /** 全量覆盖某等级的功能关联（§25 PUT /tiers/:id/features） */
  async setTierFeatures(tierId: string, items: SetTierFeatureInput[]): Promise<void> {
    const tier = await this.getTierById(tierId);
    if (!tier) throw ERRORS.INVALID_INPUT("等级不存在");
    const codes = items.map((i) => i.code);
    if (new Set(codes).size !== codes.length) {
      throw ERRORS.INVALID_INPUT("features 存在重复 code");
    }
    const featureRows = await this.db
      .select()
      .from(membershipFeatures)
      .where(inArray(membershipFeatures.code, codes));
    const byCode = new Map(featureRows.map((f) => [f.code, f]));

    await this.db.delete(tierFeatures).where(eq(tierFeatures.tierId, tierId));
    const now = new Date();
    for (const item of items) {
      const feature = byCode.get(item.code);
      if (!feature) continue; // 跳过未知 code（保持幂等、不破坏其余）
      await this.db.insert(tierFeatures).values({
        id: randomId("tf"),
        tierId,
        featureId: feature.id,
        enabled: item.enabled,
        config: JSON.stringify(item.config ?? {}),
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
