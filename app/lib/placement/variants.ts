import { rectCorners, rectIntersects } from "../geometry";
import {
  distancePointToSegment,
  pointInPolygon,
  polygonBounds,
  rectToPolylineDistance,
} from "../geometry";
import { contextClearances } from "./siteContext";
import type {
  FireRestriction,
  PlacementAnalysis,
  PlacementContext,
  PlacementRect,
  UtilityRestriction,
} from "./types";

export type VariantScorePart = {
  id: "south" | "boundary" | "fire" | "utility" | "street";
  label: string;
  /** Оценка по этому признаку, от 0 до 100 */
  score: number;
  weight: number;
  detail: string;
};

export type PlacementVariant = {
  id: string;
  rect: PlacementRect;
  /** Общая оценка с весами, от 0 до 100 */
  score: number;
  breakdown: VariantScorePart[];
};

const GRID_STEPS = 44;

function rectGap(a: PlacementRect, b: PlacementRect) {
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0);
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0);
  return Math.hypot(gapX, gapY);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function scoreCandidate(
  rect: PlacementRect,
  context: PlacementContext,
  fireRestrictions: FireRestriction[],
  typedUtilities: UtilityRestriction[],
): VariantScorePart[] {
  const parcelRing = [...context.parcel, context.parcel[0]];
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };

  const wide = rect.width >= rect.height;
  const south: VariantScorePart = {
    id: "south",
    label: "Длинный фасад на юг",
    score: wide ? 100 : 55,
    weight: 0.3,
    detail: wide
      ? "Длинная сторона ориентирована восток–запад: окна главного фасада смотрят на юг (север — вверх плана)."
      : "Длинная сторона ориентирована север–юг: южный фасад короткий.",
  };

  const boundaryMargin = rectToPolylineDistance(rect, parcelRing);
  const boundary: VariantScorePart = {
    id: "boundary",
    label: "Запас до границ участка",
    score: clamp01(boundaryMargin / 5) * 100,
    weight: 0.2,
    detail: `Ближайшая граница в ${boundaryMargin.toFixed(1)} м от стены сверх обязательных отступов.`,
  };

  const fireGap = fireRestrictions.length
    ? Math.min(...fireRestrictions.map((restriction) => rectGap(rect, restriction)))
    : undefined;
  const fire: VariantScorePart = {
    id: "fire",
    label: "Запас пожарного разрыва",
    score: fireGap === undefined ? 100 : clamp01(fireGap / 6) * 100,
    weight: 0.2,
    detail:
      fireGap === undefined
        ? "Подтверждённых соседних зданий нет."
        : `Дополнительно ${fireGap.toFixed(1)} м сверх нормативной зоны соседа.`,
  };

  const utilityMargin = typedUtilities.length
    ? Math.min(
        ...typedUtilities.map(
          (utility) => rectToPolylineDistance(rect, utility.polyline) - utility.distance,
        ),
      )
    : undefined;
  const utility: VariantScorePart = {
    id: "utility",
    label: "Запас до инженерных сетей",
    score: utilityMargin === undefined ? 100 : clamp01(utilityMargin / 3) * 100,
    weight: 0.15,
    detail:
      utilityMargin === undefined
        ? "Сети с охранными зонами не распознаны."
        : `Дополнительно ${utilityMargin.toFixed(1)} м сверх охранной зоны ближайшей сети.`,
  };

  const streetStart =
    context.parcel[Math.max(0, Math.min(context.parcel.length - 1, context.streetEdgeIndex))];
  const streetEnd = context.parcel[(context.streetEdgeIndex + 1) % context.parcel.length];
  const streetDistance = distancePointToSegment(center, streetStart, streetEnd);
  const street: VariantScorePart = {
    id: "street",
    label: "Близость к уличному фронту",
    score: clamp01(1 - (streetDistance - 6) / 30) * 100,
    weight: 0.15,
    detail: `Центр здания в ${streetDistance.toFixed(1)} м от уличной стороны: короче подъезд и вводы сетей.`,
  };

  return [south, boundary, fire, utility, street];
}

export function generatePlacementVariants(
  context: PlacementContext,
  analysis: PlacementAnalysis,
  count = 5,
): PlacementVariant[] {
  const buildable = analysis.buildable;
  const { buildingWidth, buildingDepth } = context.parameters;
  if (buildable.length < 3 || buildingWidth <= 0 || buildingDepth <= 0) return [];
  const typedUtilities = (context.utilities ?? []).filter(
    (utility) => utility.kind !== "unknown" && utility.distance > 0,
  );
  const bounds = polygonBounds(buildable);
  const clearances = contextClearances(context.contextMarks ?? []);
  const orientations =
    buildingWidth === buildingDepth
      ? [{ width: buildingWidth, height: buildingDepth }]
      : [
          { width: buildingWidth, height: buildingDepth },
          { width: buildingDepth, height: buildingWidth },
        ];

  const candidates: PlacementVariant[] = [];
  for (const size of orientations) {
    const freeX = bounds.width - size.width;
    const freeY = bounds.height - size.height;
    if (freeX < 0 || freeY < 0) continue;
    const columns = Math.max(1, Math.min(GRID_STEPS, Math.ceil(freeX / 0.5)));
    const rows = Math.max(1, Math.min(GRID_STEPS, Math.ceil(freeY / 0.5)));
    for (let row = 0; row <= rows; row += 1) {
      for (let column = 0; column <= columns; column += 1) {
        const rect: PlacementRect = {
          x: bounds.x + (freeX * column) / columns,
          y: bounds.y + (freeY * row) / rows,
          width: size.width,
          height: size.height,
        };
        if (!rectCorners(rect).every((corner) => pointInPolygon(corner, buildable))) continue;
        if (analysis.fireRestrictions.some((restriction) => rectIntersects(rect, restriction)))
          continue;
        if (
          typedUtilities.some(
            (utility) => rectToPolylineDistance(rect, utility.polyline) < utility.distance,
          )
        )
          continue;
        if (
          clearances.some(
            (restriction) =>
              rectToPolylineDistance(rect, restriction.polyline) < restriction.distance,
          )
        )
          continue;
        const breakdown = scoreCandidate(rect, context, analysis.fireRestrictions, typedUtilities);
        const score = breakdown.reduce((sum, part) => sum + part.score * part.weight, 0);
        candidates.push({
          id: `variant-${size.width}x${size.height}-${column}-${row}`,
          rect,
          score: Math.round(score * 10) / 10,
          breakdown,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const minimumSpacing = Math.max(buildingWidth, buildingDepth) * 0.6;
  const selected: PlacementVariant[] = [];
  for (const candidate of candidates) {
    const center = {
      x: candidate.rect.x + candidate.rect.width / 2,
      y: candidate.rect.y + candidate.rect.height / 2,
    };
    const distinct = selected.every((kept) => {
      const keptCenter = {
        x: kept.rect.x + kept.rect.width / 2,
        y: kept.rect.y + kept.rect.height / 2,
      };
      return Math.hypot(center.x - keptCenter.x, center.y - keptCenter.y) >= minimumSpacing;
    });
    if (!distinct) continue;
    selected.push(candidate);
    if (selected.length >= count) break;
  }
  return selected;
}
