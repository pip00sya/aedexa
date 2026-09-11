import { dedupePoints, polygonArea, polygonBounds, simplifyPolyline } from "../geometry";
import { findNormRule, normRuleDistance } from "../norms/registry";
import { classifyDrawing, elevationsLookLikeTerrain, isAbsoluteElevation } from "./drawingPurpose";
import { DxfError, type DxfDrawing, type DxfLine } from "./dxf";
import type {
  NeighborBuilding,
  PlacementPoint,
  PlacementPolygon,
  PlacementRelief,
  PlacementSource,
  ReliefContour,
  ReliefLine,
  ReliefMark,
  RuleStatus,
  UtilityRestriction,
} from "./types";
import { detectUtilityNetwork } from "./utilityZones";

/** Слой границы участка */
const BOUNDARY = /границ|участк|участок|межев|кадастр|отвод|землепольз|boundary|parcel|property/iu;
/** Слои оформления: границей участка не бывают, как бы ни назывались */
const DECOR = /штрих|hatch|рамк|frame|border|таблиц|table|текст|text|размер|выноск|штамп/iu;
/** Существующие строения - соседи для пожарных разрывов */
const BUILDING = /здан|строен|дом|постройк|building|house/iu;
const CONTOUR = /горизонт|изолин|рельеф|высотн|contour|isoline|topo/iu;
/** Разумные размеры участка: меньше - крыльцо, больше - квартал */
const MIN_PLOT = 100;
const MAX_PLOT = 50_000;
/** Больше соседей на плане не нужно: важны ближайшие */
const MAX_NEIGHBORS = 40;
const MAX_BASE_POINTS = 200_000;

type Found = { line: DxfLine; guessed: boolean };

function isRing(line: DxfLine, metersPerUnit: number) {
  if (line.closed) return true;
  if (line.points.length < 3) return false;
  const first = line.points[0];
  const last = line.points[line.points.length - 1];
  // Допуск на незамкнутость - полметра в натуре, а не в единицах чертежа
  return Math.hypot(first.x - last.x, first.y - last.y) <= 0.5 / metersPerUnit;
}

function findBoundary(lines: DxfLine[], metersPerUnit: number): Found | null {
  const plausible = lines.filter((line) => {
    if (line.points.length < 3 || !isRing(line, metersPerUnit)) return false;
    if (DECOR.test(line.layer)) return false;
    const value = polygonArea(line.points) * metersPerUnit * metersPerUnit;
    return value >= MIN_PLOT && value <= MAX_PLOT;
  });
  if (!plausible.length) return null;
  const largest = (pool: DxfLine[]) =>
    pool.reduce<DxfLine | null>(
      (winner, line) =>
        !winner || polygonArea(line.points) > polygonArea(winner.points) ? line : winner,
      null,
    );
  const named = plausible.filter((line) => BOUNDARY.test(line.layer));
  const pick = named.length ? largest(named) : largest(plausible);
  return pick ? { line: pick, guessed: !named.length } : null;
}

/** Кольцо без замыкающей точки: последняя вершина не дублирует первую */
function openRing(points: PlacementPolygon): PlacementPolygon {
  const out = dedupePoints(points);
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 2 && first && last && Math.hypot(first.x - last.x, first.y - last.y) <= 1e-6)
    out.pop();
  return out;
}

function averageZ(line: DxfLine) {
  let sum = 0;
  let count = 0;
  for (const point of line.points) {
    if (Number.isFinite(point.z)) {
      sum += point.z;
      count += 1;
    }
  }
  return count ? sum / count : Number.NaN;
}

function statusFor(ruleId: string | undefined): RuleStatus {
  if (!ruleId) return "MISSING_DATA";
  const rule = findNormRule(ruleId);
  return rule?.verifiedBy === "operator" ? "PASS" : "EXPERT_REVIEW";
}

export function placementSourceFromDxf(
  drawing: DxfDrawing,
  options: { name: string; source: "demo" | "upload" },
): PlacementSource {
  const scale = drawing.metersPerUnit;
  const found = findBoundary(drawing.lines, scale);
  if (!found) {
    throw new DxfError(
      "В чертеже не нашлась граница участка.",
      "Нужна топосъёмка: замкнутая полилиния участка, желательно на слое со словом «граница» или «участок». " +
        "Похоже, это архитектурный чертёж — планировки и фасады посадкой не разбираются. " +
        "Откройте готовый участок, чтобы посмотреть, как это работает.",
    );
  }

  const rawBoundary = openRing(
    found.line.points.map((point) => ({ x: point.x * scale, y: point.y * scale })),
  );
  const box = polygonBounds(rawBoundary);
  const origin: PlacementPoint = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const shift = (point: { x: number; y: number }): PlacementPoint => ({
    x: point.x * scale - origin.x,
    y: point.y * scale - origin.y,
  });
  const parcel = openRing(found.line.points.map(shift));

  const half = { x: box.width / 2, y: box.height / 2 };
  const margin = Math.max(20, Math.hypot(box.width, box.height) * 0.4);
  const nearParcel = (points: readonly PlacementPoint[]) => {
    const near = polygonBounds(points);
    return !(
      near.x + near.width < -half.x - margin ||
      near.x > half.x + margin ||
      near.y + near.height < -half.y - margin ||
      near.y > half.y + margin
    );
  };

  const utilities: UtilityRestriction[] = [];
  const neighbors: NeighborBuilding[] = [];
  const contours: ReliefContour[] = [];
  const base: ReliefLine[] = [];
  let basePoints = 0;
  let baseDropped = 0;

  for (const line of drawing.lines) {
    if (line === found.line || line.points.length < 2) continue;

    const detection = detectUtilityNetwork(line.layer);
    if (detection.kind !== "unknown") {
      const polyline = dedupePoints(line.points.map(shift));
      if (polyline.length < 2) continue;
      const rule = detection.ruleId ? findNormRule(detection.ruleId) : undefined;
      utilities.push({
        id: `utility:${utilities.length + 1}`,
        kind: detection.kind,
        label: detection.label,
        polyline,
        distance: normRuleDistance(detection.ruleId ?? "", 0),
        ruleId: detection.ruleId,
        clause: rule ? `${rule.document}, ${rule.clause}` : undefined,
        status: statusFor(detection.ruleId),
        voltageKv: detection.voltageKv,
      });
      continue;
    }

    if (CONTOUR.test(line.layer) && line.hasZ) {
      const z = averageZ(line) * scale;
      if (!Number.isFinite(z)) continue;
      const points = simplifyPolyline(dedupePoints(line.points.map(shift)), 0.35);
      if (points.length >= 2) contours.push({ z, points });
      continue;
    }

    if (BUILDING.test(line.layer) && isRing(line, scale)) {
      const polygon = openRing(line.points.map(shift));
      if (polygon.length < 3) continue;
      const bounds = polygonBounds(polygon);
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const reach = Math.max(60, Math.hypot(box.width, box.height));
      if (Math.hypot(center.x, center.y) > reach) continue;
      neighbors.push({ id: `dxf-building-${neighbors.length + 1}`, polygon });
    }

    // Все прочее - подоснова: смысла ей не приписываем, но и не выбрасываем
    const points = simplifyPolyline(dedupePoints(line.points.map(shift)), 0.2);
    if (points.length < 2 || !nearParcel(points)) continue;
    if (basePoints + points.length > MAX_BASE_POINTS) {
      baseDropped += 1;
      continue;
    }
    basePoints += points.length;
    base.push({ layer: line.layer, closed: line.closed, points });
  }

  const marks: ReliefMark[] = [];
  for (const mark of drawing.marks) {
    const point = shift(mark);
    if (!nearParcel([point])) continue;
    const z = mark.fromGeometry ? mark.z * scale : mark.z;
    if (!isAbsoluteElevation(z)) continue;
    marks.push({ x: point.x, y: point.y, z, fromGeometry: mark.fromGeometry });
  }
  const levels = marks.map((mark) => mark.z);
  const spread = levels.length ? Math.max(...levels) - Math.min(...levels) : undefined;
  const relief: PlacementRelief = {
    contours,
    marks:
      contours.length ||
      elevationsLookLikeTerrain(marks.length, spread, Math.max(box.width, box.height))
        ? marks
        : [],
    base,
    baseDropped,
  };

  const purpose = classifyDrawing({
    layers: drawing.layers,
    hasPlausibleParcel: true,
    parcelArea: polygonArea(parcel),
    markCount: marks.length,
  });

  const warnings: string[] = [];
  if (!purpose.allowsPlacement)
    warnings.push(`${purpose.suggestion} Основание: ${purpose.reasons.join("; ")}.`);
  if (found.guessed) {
    warnings.push(
      `В чертеже нет слоя с границей участка — взят самый большой замкнутый контур, ${Math.round(polygonArea(parcel))} м². Убедитесь, что это ваш участок: иначе всё остальное посчитано не по тому контуру.`,
    );
  }
  if (!utilities.length)
    warnings.push("Инженерных сетей на распознаваемых слоях нет: охранные зоны не построены.");
  if (!contours.length && marks.length < 8)
    warnings.push(
      "Горизонталей и высотных отметок в чертеже нет: рельеф не построен, участок показан на плоской подложке.",
    );
  if (found.guessed && !utilities.length && !drawing.marks.length) {
    warnings.push(
      "Похоже, это не топосъёмка: нет ни слоя границы, ни сетей, ни высотных отметок. Так выглядят планировки и фасады.",
    );
  }
  warnings.push(
    "Красная линия не подтверждена официальным слоем ПДП или АПЗ: показан предварительный отступ.",
  );

  return {
    kind: "dxf",
    name: options.name,
    confidence: found.guessed ? "pixel" : "local",
    unitLabel: drawing.unitLabel,
    coordinateLabel: `DXF · метры от центра участка${found.guessed ? " · граница определена по геометрии" : ""}`,
    parcel,
    parcelConfirmed: false,
    streetEdgeIndex: 0,
    neighbors: neighbors.slice(0, MAX_NEIGHBORS),
    utilities,
    relief,
    purpose,
    warnings,
  };
}
