import type { CadLayerSummary } from "../cad/types";
import type { DrawingEvidence } from "./drawingPurpose";

export type LayerRole =
  | "parcel"
  | "relief"
  | "utility"
  | "site"
  | "building"
  | "annotation"
  | "ignored";

export type LayerRoleMeta = { label: string; hint: string };

export const LAYER_ROLE_META: Record<LayerRole, LayerRoleMeta> = {
  parcel: { label: "Граница участка", hint: "от неё считаются отступы и площадь" },
  relief: { label: "Рельеф", hint: "горизонтали и высотные отметки" },
  utility: { label: "Инженерные сети", hint: "оси сетей и охранные зоны" },
  site: { label: "Ситуация", hint: "дороги, покрытия, озеленение" },
  building: { label: "Строения", hint: "существующие здания — соседи для разрывов" },
  annotation: { label: "Оформление", hint: "рамка, штамп, размеры, тексты" },
  ignored: { label: "Не учитывать", hint: "слой не участвует в расчёте" },
};

export const LAYER_ROLES = Object.keys(LAYER_ROLE_META) as LayerRole[];

/** Класс объекта из разбора DWG -> роль слоя в расчете участка */
const KIND_TO_ROLE: Partial<Record<CadLayerSummary["kind"], LayerRole>> = {
  boundary: "parcel",
  terrain: "relief",
  utility: "utility",
  wire: "utility",
  water: "site",
  road: "site",
  curb: "site",
  ditch: "site",
  vegetation: "site",
  site: "site",
  waste: "site",
  building: "building",
  fence: "site",
  pole: "site",
  sign: "site",
  manhole: "utility",
  annotation: "annotation",
  unknown: "ignored",
};

export type LayerRoleEntry = {
  layer: string;
  entityCount: number;
  /** Роль, назначенная разбором */
  detected: LayerRole;
  /** Почему разбор так решил */
  reason: string;
  /** Роль, назначенная человеком; пусто - принято как есть */
  override?: LayerRole;
};

/** Итоговая роль: правка человека главнее разбора */
export const roleOf = (entry: LayerRoleEntry) => entry.override ?? entry.detected;

export function layerRoles(
  layers: readonly CadLayerSummary[],
  overrides: Readonly<Record<string, LayerRole>> = {},
): LayerRoleEntry[] {
  return layers
    .filter((layer) => layer.entityCount > 0)
    .map((layer) => ({
      layer: layer.name,
      entityCount: layer.entityCount,
      detected: KIND_TO_ROLE[layer.kind] ?? "ignored",
      reason: layer.reason,
      override: overrides[layer.name],
    }))
    .sort((a, b) => b.entityCount - a.entityCount || a.layer.localeCompare(b.layer, "ru"));
}

export function evidenceWithOverrides(
  base: DrawingEvidence,
  entries: readonly LayerRoleEntry[],
): DrawingEvidence {
  const corrected = entries.filter((entry) => entry.override && entry.override !== entry.detected);
  if (!corrected.length) return base;

  const synthetic = corrected
    .filter(
      (entry) =>
        entry.override === "parcel" ||
        entry.override === "relief" ||
        entry.override === "utility" ||
        entry.override === "site",
    )
    .map(
      (entry) =>
        ({
          parcel: "ГРАНИЦА УЧАСТКА",
          relief: "ГОРИЗОНТАЛИ",
          utility: "ВОДОПРОВОД",
          site: "ДОРОГИ",
        })[entry.override as "parcel" | "relief" | "utility" | "site"],
    );

  // Слои, которые человек снял с роли участка, из улик убираются
  const dropped = new Set(
    corrected
      .filter((entry) => entry.override === "ignored" || entry.override === "annotation")
      .map((entry) => entry.layer),
  );

  return { ...base, layers: [...base.layers.filter((layer) => !dropped.has(layer)), ...synthetic] };
}
