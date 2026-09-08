/**
 * ReferenceResolver（V0.3 Phase 3，实施文档 §23）。
 *
 * 职责：Generation Request → Characters → Reference Assets → Provider 能力判定
 * → 支持参考图则注入，否则回退 Character Prompt Anchor。
 *
 * 说明：当前 Image/Video Provider 尚未暴露「参考图注入」能力，因此默认
 * `capabilities.supportsReferenceImages` 返回 false → 一律回退 Prompt Anchor。
 * 后续若某 Provider 支持，可注入 capability 并在此启用参考图。
 */
import type { Character } from "../character/character-types";
import { deriveCharacterPromptAnchor } from "../character/character-anchor";
import type { ProductionService } from "../service";
import type { ProductionAsset } from "../asset/asset-types";

/** Provider 能力判定（由 server 层注入；缺省表示不支持参考图） */
export interface ProviderCapabilities {
  /** 该 provider 是否支持参考图注入（如文生图带角色参考图） */
  supportsReferenceImages?: (providerId: string) => boolean;
}

export interface ResolvedReferenceAsset {
  assetId: string;
  name: string;
  type: string;
  url?: string;
}

export interface CharacterReferenceResolution {
  characterId: string;
  characterName: string;
  /** 稳定 Prompt Anchor（无论是否注入参考图，都用它保证一致） */
  anchor: string;
  /** 解析后的参考资产（可能为空） */
  referenceAssets: ResolvedReferenceAsset[];
  /** 当前 Provider 是否采用参考图注入（否则回退 Anchor） */
  useReferences: boolean;
}

export interface ResolveCharacterReferencesInput {
  projectId: string;
  characterIds: string[];
  providerId?: string;
  capabilities?: ProviderCapabilities;
}

/** 收集角色的参考图资产 id（referenceAssetId + visualProfile.referenceAssetIds，去重） */
function collectReferenceAssetIds(character: Character): string[] {
  const ids = new Set<string>();
  if (character.referenceAssetId) ids.add(character.referenceAssetId);
  for (const id of character.visualProfile?.referenceAssetIds ?? []) {
    if (id) ids.add(id);
  }
  return [...ids];
}

export class ReferenceResolver {
  constructor(private readonly production: ProductionService) {}

  async resolve(input: ResolveCharacterReferencesInput): Promise<CharacterReferenceResolution[]> {
    const supports = input.capabilities?.supportsReferenceImages?.(input.providerId ?? "") ?? false;
    const results: CharacterReferenceResolution[] = [];

    for (const characterId of input.characterIds) {
      const character = await this.production.getCharacter(characterId);
      const anchor = deriveCharacterPromptAnchor(character);

      const referenceAssets: ResolvedReferenceAsset[] = [];
      for (const assetId of collectReferenceAssetIds(character)) {
        try {
          const asset: ProductionAsset = await this.production.getAsset(assetId);
          referenceAssets.push({ assetId: asset.id, name: asset.name, type: asset.type, url: asset.url });
        } catch {
          // 参考资产缺失/越权：跳过该引用，不阻断整次生成（回退 Anchor 兜底）
        }
      }

      results.push({
        characterId,
        characterName: character.name,
        anchor,
        referenceAssets,
        useReferences: supports && referenceAssets.length > 0,
      });
    }
    return results;
  }
}
