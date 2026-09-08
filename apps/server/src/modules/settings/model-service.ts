import { and, asc, eq, inArray } from "drizzle-orm";
import { models as modelsTable, type ModelRow, type SVHDatabase } from "@svh/database";
import { ERRORS } from "../../lib/errors";
import { getProviderMeta, type ModelType } from "./model-catalog";

/** 管理员视图：完整模型行（含禁用） */
export interface AdminModelRow {
  id: string;
  providerId: string;
  providerName: string;
  modelName: string;
  type: ModelType;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
  /** 生成方案档位（economy / balanced / quality） */
  tier: string;
}

/** 用户视角：可用模型（仅启用项） */
export interface AvailableModel {
  id: string;
  modelName: string;
  type: ModelType;
  displayName: string;
  tier: string;
}

/** 创建 / 更新模型输入 */
export interface ModelInput {
  providerId: string;
  modelName: string;
  type: ModelType;
  displayName: string;
  enabled?: boolean;
  sortOrder?: number;
  tier?: string;
}

/**
 * 可用模型服务（管理员后台维护模型列表，用户只读）。
 *
 * models 表存储供应商模型清单：模型名（API 调用）、类型、显示名称。
 * 默认模型：按 sort_order 排序的第一个启用文本模型（对话 Agent 未指定模型时使用）。
 */
export class ModelService {
  constructor(private readonly db: SVHDatabase) {}

  /** 管理员：全部模型（含禁用），按供应商排序 */
  async listAll(): Promise<AdminModelRow[]> {
    const rows = await this.db
      .select()
      .from(modelsTable)
      .orderBy(asc(modelsTable.sortOrder), asc(modelsTable.createdAt));
    return rows.map((r) => ({
      ...this.toView(r),
      providerName: getProviderMeta(r.providerId)?.name ?? r.providerId,
    }));
  }

  /** 用户视角：全部可用模型（仅启用），按供应商分组 */
  async listEnabledGrouped(): Promise<Record<string, AvailableModel[]>> {
    const rows = await this.db
      .select()
      .from(modelsTable)
      .where(eq(modelsTable.enabled, true))
      .orderBy(asc(modelsTable.sortOrder), asc(modelsTable.createdAt));
    const grouped: Record<string, AvailableModel[]> = {};
    for (const r of rows) {
      (grouped[r.providerId] ??= []).push({
        id: r.id,
        modelName: r.modelName,
        type: r.type as ModelType,
        displayName: r.displayName,
        tier: r.tier,
      });
    }
    return grouped;
  }

  /** 新增模型（校验供应商与类型） */
  async create(input: ModelInput): Promise<AdminModelRow> {
    this.validate(input);
    const now = new Date();
    const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      id,
      providerId: input.providerId,
      modelName: input.modelName,
      type: input.type,
      displayName: input.displayName,
      enabled: input.enabled ?? true,
      sortOrder: input.sortOrder ?? 0,
      tier: input.tier ?? "balanced",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.db.insert(modelsTable).values(row);
    } catch {
      throw ERRORS.INVALID_INPUT(`模型已存在：${input.providerId} / ${input.modelName}`);
    }
    return this.toViewForAdmin(row as ModelRow);
  }

  /** 更新模型（局部字段） */
  async update(id: string, patch: Partial<ModelInput>): Promise<AdminModelRow> {
    const existing = await this.db.select().from(modelsTable).where(eq(modelsTable.id, id)).limit(1);
    if (!existing[0]) throw ERRORS.INVALID_INPUT("模型不存在");
    const next: ModelInput = {
      providerId: patch.providerId ?? existing[0].providerId,
      modelName: patch.modelName ?? existing[0].modelName,
      type: (patch.type ?? existing[0].type) as ModelType,
      displayName: patch.displayName ?? existing[0].displayName,
      enabled: patch.enabled ?? existing[0].enabled,
      sortOrder: patch.sortOrder ?? existing[0].sortOrder,
      tier: patch.tier ?? existing[0].tier,
    };
    try {
      await this.db
        .update(modelsTable)
        .set({
          providerId: next.providerId,
          modelName: next.modelName,
          type: next.type,
          displayName: next.displayName,
          enabled: next.enabled,
          sortOrder: next.sortOrder,
          tier: next.tier,
          updatedAt: new Date(),
        })
        .where(eq(modelsTable.id, id));
    } catch {
      throw ERRORS.INVALID_INPUT(`模型已存在：${next.providerId} / ${next.modelName}`);
    }
    return this.toViewForAdmin({ ...existing[0], ...next, id });
  }

  /** 删除模型（会话引用时运行时解析会报错，属于预期行为） */
  async remove(id: string): Promise<void> {
    await this.db.delete(modelsTable).where(eq(modelsTable.id, id));
  }

  /** 校验模型 id 列表：返回不存在的 id（用于用户启用列表校验） */
  async findMissingIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: modelsTable.id })
      .from(modelsTable)
      .where(inArray(modelsTable.id, ids));
    const found = new Set(rows.map((r) => r.id));
    return ids.filter((id) => !found.has(id));
  }

  /**
   * 过滤出仍存在的模型 id（保持原顺序）。
   * 管理员删除/替换模型后，用户启用列表可能残留已失效引用，读取与保存时统一收敛。
   */
  async filterExistingIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const missing = new Set(await this.findMissingIds(ids));
    return ids.filter((id) => !missing.has(id));
  }

  /**
   * 解析运行模型：会话/技能指定模型名（全局启用且用户启用）或默认模型。
   *
   * 系统决定模型（V0.3）：默认解析支持 tier 档位（生成方案 economy/balanced/quality）——
   * 命中档位的启用模型中按 sort_order 取首个；档位无模型时回落到 balanced；
   * 仍无则任意启用模型；全无则报错。userEnabledIds 由服务层传 null（用户不再启停模型）。
   * providerWhitelist = 用户已配置 API Key 的供应商：系统仅在已配 Key 的供应商标内选模型；
   * null/空 = 不限制（如 env 兜底 Key 场景）。
   */
  async resolveModel(
    modelName?: string,
    userEnabledIds?: string[] | null,
    types?: ModelType[],
    tier?: string,
    providerWhitelist?: string[] | null,
  ): Promise<{ providerId: string; modelName: string; type: ModelType }> {
    const allowedTypes = types ?? ["text"];
    const name = modelName?.trim() ?? "";
    if (name !== "") {
      const row = await this.db
        .select()
        .from(modelsTable)
        .where(and(eq(modelsTable.modelName, name), eq(modelsTable.enabled, true)))
        .limit(1);
      if (!row[0]) {
        throw ERRORS.INVALID_INPUT(`模型不可用：${name}（请管理员在后台启用或更换模型）`);
      }
      // 仅当调用方显式指定类型集合（技能路径）时校验类型，会话路径保持旧行为兼容
      if (types !== undefined && !(types as string[]).includes(row[0].type)) {
        throw ERRORS.INVALID_INPUT(`技能不支持该模型类型：${name}`);
      }
      this.assertUserEnabled(row[0].id, userEnabledIds);
      return { providerId: row[0].providerId, modelName: row[0].modelName, type: row[0].type as ModelType };
    }
    const rows = await this.db
      .select()
      .from(modelsTable)
      .where(and(inArray(modelsTable.type, allowedTypes), eq(modelsTable.enabled, true)))
      .orderBy(asc(modelsTable.sortOrder), asc(modelsTable.createdAt));
    if (rows.length === 0) {
      // 保持原文案兼容：默认文本场景提示「文本模型」，其余类型集合给通用文案
      const label = allowedTypes.length === 1 && allowedTypes[0] === "text" ? "文本模型" : "模型";
      throw ERRORS.INVALID_INPUT(`系统未配置可用${label}，请联系管理员在后台添加`);
    }
    // 已配 Key 的供应商标内优先（用户只需提供 API Key，系统在已配置的供应商里自动选）
    const whitelist = providerWhitelist && providerWhitelist.length > 0 ? new Set(providerWhitelist) : null;
    const preferWhitelist = (list: typeof rows): typeof rows => {
      if (!whitelist) return list;
      const hit = list.filter((r) => whitelist.has(r.providerId));
      return hit.length > 0 ? hit : list;
    };
    // 方案档位解析（只见于显式 tier 请求；档位落空按 balanced → 任意 顺序回落）
    const tierStep = tier?.trim() || "";
    if (tierStep !== "") {
      const byTier = rows.filter((r) => r.tier === tierStep);
      const tierBlock = byTier.length > 0 ? byTier : rows.filter((r) => r.tier === "balanced");
      const pool = preferWhitelist(tierBlock.length > 0 ? tierBlock : rows);
      const pick = pool[0]!;
      return { providerId: pick.providerId, modelName: pick.modelName, type: pick.type as ModelType };
    }
    const candidates = preferWhitelist(rows);
    const pick = candidates.find((r) => this.isUserEnabled(r.id, userEnabledIds)) ?? candidates[0]!;
    return { providerId: pick.providerId, modelName: pick.modelName, type: pick.type as ModelType };
  }

  /** 用户级启用判断（null = 全部启用） */
  private isUserEnabled(id: string, userEnabledIds?: string[] | null): boolean {
    return userEnabledIds == null || userEnabledIds.includes(id);
  }

  private assertUserEnabled(id: string, userEnabledIds?: string[] | null): void {
    if (!this.isUserEnabled(id, userEnabledIds)) {
      throw ERRORS.INVALID_INPUT("该模型未启用，请在「模型设置」中启用后重试");
    }
  }

  // ---- 内部 ----

  private validate(input: ModelInput): void {
    if (!getProviderMeta(input.providerId)) {
      throw ERRORS.INVALID_INPUT(`供应商不存在：${input.providerId}`);
    }
    if (!["text", "image", "video", "audio"].includes(input.type)) {
      throw ERRORS.INVALID_INPUT(`模型类型不合法：${input.type}`);
    }
    if (input.modelName.trim() === "") {
      throw ERRORS.INVALID_INPUT("模型名不能为空");
    }
    if (input.displayName.trim() === "") {
      throw ERRORS.INVALID_INPUT("显示名称不能为空");
    }
    if (input.tier !== undefined && !["economy", "balanced", "quality"].includes(input.tier)) {
      throw ERRORS.INVALID_INPUT(`方案档位不合法：${input.tier}`);
    }
  }

  private toView(r: ModelRow): AdminModelRow {
    return {
      id: r.id,
      providerId: r.providerId,
      providerName: getProviderMeta(r.providerId)?.name ?? r.providerId,
      modelName: r.modelName,
      type: r.type as ModelType,
      displayName: r.displayName,
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      tier: r.tier,
    };
  }

  private toViewForAdmin(r: ModelRow): AdminModelRow {
    return this.toView(r);
  }
}
