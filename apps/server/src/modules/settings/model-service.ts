import { and, asc, eq } from "drizzle-orm";
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
}

/** 用户视角：可用模型（仅启用项） */
export interface AvailableModel {
  id: string;
  modelName: string;
  type: ModelType;
  displayName: string;
}

/** 创建 / 更新模型输入 */
export interface ModelInput {
  providerId: string;
  modelName: string;
  type: ModelType;
  displayName: string;
  enabled?: boolean;
  sortOrder?: number;
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

  /** 解析运行模型：会话指定模型名（启用）或默认模型（首个启用文本模型） */
  async resolveModel(modelName?: string): Promise<{ providerId: string; modelName: string; type: ModelType }> {
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
      return { providerId: row[0].providerId, modelName: row[0].modelName, type: row[0].type as ModelType };
    }
    const def = await this.db
      .select()
      .from(modelsTable)
      .where(and(eq(modelsTable.type, "text"), eq(modelsTable.enabled, true)))
      .orderBy(asc(modelsTable.sortOrder), asc(modelsTable.createdAt))
      .limit(1);
    if (def[0]) {
      return { providerId: def[0].providerId, modelName: def[0].modelName, type: def[0].type as ModelType };
    }
    throw ERRORS.INVALID_INPUT("系统未配置可用文本模型，请联系管理员在后台添加");
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
    };
  }

  private toViewForAdmin(r: ModelRow): AdminModelRow {
    return this.toView(r);
  }
}
