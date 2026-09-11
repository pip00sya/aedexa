import { pointInPolygon, polygonBounds, segmentCapsule } from "../geometry";
import { findNormRule, normRuleDistance } from "../norms/registry";
import type { SiteObjectKind } from "./siteObjects";
import type {
  PlacementPoint,
  PlacementPolygon,
  RuleStatus,
  UtilityRestriction,
  UtilityZone,
} from "./types";

export type SiteContextKind = "waste" | "well" | "pole" | "entrance" | "tree" | "neighbor-house";

export type SiteContextSpec = {
  kind: SiteContextKind;
  label: string;
  /** Норматив, из которого берется расстояние; пусто - требования нет */
  ruleId?: string;
  /** Расстояние по умолчанию, метры */
  distance: number;
  /** Что это требование означает человеческим языком */
  meaning: string;
  /** Отмечается точкой или линией */
  shape: "point" | "line";
};

export const SITE_CONTEXT_CATALOG: SiteContextSpec[] = [
  {
    kind: "waste",
    label: "Площадка ТБО",
    ruleId: "placement.waste-to-house",
    distance: 20,
    meaning: "разрыв от контейнерной площадки до жилого дома и детской площадки",
    shape: "point",
  },
  {
    kind: "well",
    label: "Колодец или скважина",
    ruleId: "placement.well-to-septic",
    distance: 20,
    meaning: "разрыв от источника воды до септика и выгреба",
    shape: "point",
  },
  {
    kind: "pole",
    label: "Опора ЛЭП",
    ruleId: "utility.overhead-0_4",
    distance: 2,
    meaning: "охранная зона воздушной линии до 1 кВ",
    shape: "point",
  },
  {
    kind: "entrance",
    label: "Въезд на участок",
    distance: 0,
    meaning: "справочная отметка въезда; уличную грань выберите на контуре участка",
    shape: "point",
  },
  {
    kind: "tree",
    label: "Дерево",
    ruleId: "placement.tree-to-wall",
    distance: 5,
    meaning: "расстояние от ствола до стены здания",
    shape: "point",
  },
  {
    kind: "neighbor-house",
    label: "Соседний дом",
    distance: 0,
    meaning:
      "справочная точка; для противопожарного расчёта нужен контур здания и его огнестойкость",
    shape: "point",
  },
];

export const contextSpecOf = (kind: SiteContextKind) =>
  SITE_CONTEXT_CATALOG.find((item) => item.kind === kind) ?? SITE_CONTEXT_CATALOG[0];

export type SiteContextMark = {
  id: string;
  kind: SiteContextKind;
  /** Положение в метрах, в системе участка */
  x: number;
  y: number;
  /** Расстояние, назначенное человеком; пусто - из реестра норм */
  distance?: number;
};

export function contextDistance(mark: SiteContextMark) {
  if (typeof mark.distance === "number" && Number.isFinite(mark.distance) && mark.distance >= 0)
    return mark.distance;
  const spec = contextSpecOf(mark.kind);
  return spec.ruleId ? normRuleDistance(spec.ruleId, spec.distance) : spec.distance;
}

/** Разрыв применяем к тому объекту, для которого он задан в каталоге */
export function applicableContext(
  marks: readonly SiteContextMark[],
  kind: SiteObjectKind = "house",
) {
  return marks.filter((mark) => {
    if (mark.kind === "well") return kind === "septic";
    if (mark.kind === "waste") return kind === "house" || kind === "yard";
    if (mark.kind === "tree") return kind !== "septic" && kind !== "yard";
    return true;
  });
}

/** Внутренний формат для проверки расстояний; это не распознанные сети */
export function contextClearances(
  marks: readonly SiteContextMark[],
  kind: SiteObjectKind = "house",
): UtilityRestriction[] {
  return applicableContext(marks, kind)
    .filter((mark) => contextDistance(mark) > 0)
    .map((mark) => ({
      id: `context:${mark.id}`,
      kind: "unknown",
      label: contextSpecOf(mark.kind).label,
      polyline: [
        { x: mark.x, y: mark.y },
        { x: mark.x, y: mark.y },
      ],
      distance: contextDistance(mark),
      status: statusFor(contextSpecOf(mark.kind).ruleId),
    }));
}

function statusFor(ruleId: string | undefined): RuleStatus {
  if (!ruleId) return "MISSING_DATA";
  return findNormRule(ruleId)?.verifiedBy === "operator" ? "PASS" : "EXPERT_REVIEW";
}

export function contextZones(marks: readonly SiteContextMark[]): UtilityZone[] {
  const zones: UtilityZone[] = [];
  for (const mark of marks) {
    const spec = contextSpecOf(mark.kind);
    const distance = contextDistance(mark);
    if (distance <= 0) continue;
    const outline = segmentCapsule(
      { x: mark.x, y: mark.y },
      { x: mark.x, y: mark.y },
      distance,
      16,
    );
    zones.push({
      id: `context:${mark.id}`,
      label: spec.label,
      distance,
      status: statusFor(spec.ruleId),
      outlines: [outline],
    });
  }
  return zones;
}

/** Отметки, попавшие внутрь участка: их зоны режут пятно застройки */
export function marksInsideParcel(marks: readonly SiteContextMark[], parcel: PlacementPolygon) {
  return marks.filter((mark) => pointInPolygon({ x: mark.x, y: mark.y }, parcel));
}

export function createContextMark(
  kind: SiteContextKind,
  at: PlacementPoint,
  index: number,
): SiteContextMark {
  return { id: `context-${kind}-${index}`, kind, x: at.x, y: at.y };
}

/** Точка для новой отметки: середина участка со сдвигом по спирали */
export function nextContextSpot(parcel: PlacementPolygon, index: number): PlacementPoint {
  const box = polygonBounds(parcel);
  const step = Math.max(2, Math.min(box.width, box.height) / 8);
  const angle = index * 1.9;
  return {
    x: box.x + box.width / 2 + Math.cos(angle) * step * Math.sqrt(index),
    y: box.y + box.height / 2 + Math.sin(angle) * step * Math.sqrt(index),
  };
}
