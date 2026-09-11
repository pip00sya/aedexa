import type { CadFeature, CadProcessingResult } from "../cad/types";
import { dedupePoints, distancePointToSegment, simplifyPolyline } from "../geometry";
import { classifyDrawing, elevationsLookLikeTerrain, isAbsoluteElevation } from "./drawingPurpose";
import { polygonArea, polygonBounds } from "./engine";
import type {
  NeighborBuilding,
  ParcelCandidate,
  PlacementPoint,
  PlacementPolygon,
  PlacementRelief,
  PlacementSource,
  ReliefContour,
  ReliefLine,
  ReliefMark,
} from "./types";
import { utilityRestrictionsFromCad } from "./utilityZones";

function points(feature: CadFeature, unitScale: number): PlacementPolygon {
  const source =
    feature.points.length > 1 &&
    feature.points[0].x === feature.points[feature.points.length - 1].x &&
    feature.points[0].y === feature.points[feature.points.length - 1].y
      ? feature.points.slice(0, -1)
      : feature.points;
  return source.map((point) => ({ x: point.x * unitScale, y: point.y * unitScale }));
}

function unitScale(result: CadProcessingResult) {
  const label = result.unitLabel.toLowerCase();
  if (label.includes("мм") || label.includes("millimeter")) return 0.001;
  if (label.includes("см") || label.includes("centimeter")) return 0.01;
  return 1;
}

function distance(a: PlacementPoint, b: PlacementPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

type Candidate = {
  id: string;
  layer: string;
  polygon: PlacementPolygon;
  source: ParcelCandidate["source"];
  featureKind: CadFeature["kind"];
  sourceType: string;
  fragmentCount: number;
  sameLayerCount: number;
};

const boundaryLayerPattern =
  /кадастр|участ|parcel|lot.?line|property|boundary|границ|зем|гр\.?\s*уч|шекара|жер\s*(?:телім|учаске)/iu;

function parcelScore(candidate: Candidate) {
  const layer = candidate.layer.toLowerCase();
  const area = polygonArea(candidate.polygon);
  let score = candidate.featureKind === "boundary" ? 12 : candidate.featureKind === "site" ? 8 : 0;
  if (boundaryLayerPattern.test(layer)) score += 20;
  if (/^(?:гр\.?\s*уч|границ\w*\s+(?:зем\w*\s+)?участ)/iu.test(layer.trim())) score += 8;
  if (/красн|red.?line|ось|трасс/.test(layer)) score -= 8;
  if (candidate.source === "stitched-cad") score += 16;
  if (candidate.sourceType === "HATCH") score -= 5;
  if (candidate.sameLayerCount > 12 && candidate.source === "closed-cad") score -= 8;
  if (area < 25) score -= 6;
  score += Math.min(14, Math.log10(Math.max(1, area)) * 4);
  return score;
}

function closeRing(points: PlacementPolygon, tolerance: number) {
  if (points.length < 3 || distance(points[0], points[points.length - 1]) > tolerance) return null;
  return points.slice(0, -1);
}

export function stitchBoundaryFragments(features: CadFeature[], scale: number, tolerance = 0.05) {
  const groups = new Map<string, CadFeature[]>();
  features
    .filter(
      (feature) =>
        (["boundary", "site"].includes(feature.kind) || boundaryLayerPattern.test(feature.layer)) &&
        !feature.closed &&
        feature.points.length >= 2,
    )
    .forEach((feature) =>
      groups.set(feature.layer, [...(groups.get(feature.layer) ?? []), feature]),
    );

  const candidates: Candidate[] = [];
  for (const [layer, fragments] of groups) {
    const unused = new Set(fragments.map((_, index) => index));
    while (unused.size) {
      const firstIndex = unused.values().next().value as number;
      unused.delete(firstIndex);
      const used = [firstIndex];
      let path = points(fragments[firstIndex], scale);
      let changed = true;
      while (changed && unused.size && distance(path[0], path[path.length - 1]) > tolerance) {
        changed = false;
        let best: {
          index: number;
          mode: "append" | "append-reverse" | "prepend" | "prepend-reverse";
          gap: number;
        } | null = null;
        for (const index of unused) {
          const part = points(fragments[index], scale);
          const options = [
            { mode: "append" as const, gap: distance(path[path.length - 1], part[0]) },
            {
              mode: "append-reverse" as const,
              gap: distance(path[path.length - 1], part[part.length - 1]),
            },
            { mode: "prepend" as const, gap: distance(path[0], part[part.length - 1]) },
            { mode: "prepend-reverse" as const, gap: distance(path[0], part[0]) },
          ];
          for (const option of options) {
            if (option.gap <= tolerance && (!best || option.gap < best.gap))
              best = { index, ...option };
          }
        }
        if (!best) continue;
        const part = points(fragments[best.index], scale);
        if (best.mode === "append") path = [...path, ...part.slice(1)];
        if (best.mode === "append-reverse") path = [...path, ...part.slice().reverse().slice(1)];
        if (best.mode === "prepend") path = [...part.slice(0, -1), ...path];
        if (best.mode === "prepend-reverse")
          path = [...part.slice().reverse().slice(0, -1), ...path];
        unused.delete(best.index);
        used.push(best.index);
        changed = true;
      }
      const polygon = closeRing(path, tolerance);
      if (polygon && polygonArea(polygon) > 4) {
        candidates.push({
          id: `stitched:${layer}:${candidates.length}`,
          layer,
          polygon,
          source: "stitched-cad",
          featureKind: fragments[firstIndex].kind,
          sourceType: "POLYLINE_SET",
          fragmentCount: used.length,
          sameLayerCount: fragments.length,
        });
      }
    }
  }
  return candidates;
}

function detectStreetEdge(parcel: PlacementPolygon, roads: PlacementPolygon[]) {
  if (!roads.length) return 0;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  parcel.forEach((start, index) => {
    const end = parcel[(index + 1) % parcel.length];
    const samples = roads
      .flat()
      .filter((_, sampleIndex) => sampleIndex % 3 === 0)
      .slice(0, 2500);
    const distance = samples.reduce(
      (minimum, point) => Math.min(minimum, distancePointToSegment(point, start, end)),
      Number.POSITIVE_INFINITY,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

const MAX_BASE_POINTS = 200_000;

const NOT_BASE = new Set<CadFeature["kind"]>([
  "terrain",
  "boundary",
  "utility",
  "annotation",
  "wire",
]);

function reliefFromCad(
  result: CadProcessingResult,
  scale: number,
  parcel: PlacementPolygon | null,
): PlacementRelief | undefined {
  if (!parcel) return undefined;
  const box = polygonBounds(parcel);
  const margin = Math.max(20, Math.hypot(box.width, box.height) * 0.4);
  const nearParcel = (points: readonly PlacementPoint[]) => {
    const near = polygonBounds(points);
    return !(
      near.x + near.width < box.x - margin ||
      near.x > box.x + box.width + margin ||
      near.y + near.height < box.y - margin ||
      near.y > box.y + box.height + margin
    );
  };

  const contours: ReliefContour[] = [];
  const base: ReliefLine[] = [];
  let basePoints = 0;
  let baseDropped = 0;

  for (const feature of result.features) {
    if (
      feature.points.length < 2 ||
      /^(TEXT|MTEXT|ATTRIB|DIMENSION|INSERT)$/u.test(feature.sourceType.toUpperCase())
    )
      continue;
    const scaled = dedupePoints(
      feature.points.map((point) => ({ x: point.x * scale, y: point.y * scale })),
    );
    if (scaled.length < 2 || !nearParcel(scaled)) continue;

    if (feature.kind === "terrain") {
      const explicit = feature.points.filter(
        (point) => point.zExplicit && Number.isFinite(point.z) && Math.abs(point.z) > 1e-9,
      );
      if (explicit.length < 2 || explicit.length < feature.points.length) continue;
      const levels = explicit.map((point) => point.z);
      const z = (levels.reduce((sum, value) => sum + value, 0) / levels.length) * scale;
      if (Math.max(...levels) - Math.min(...levels) > 1e-6 / scale) continue;
      const points = simplifyPolyline(scaled, 0.35);
      if (points.length >= 2) contours.push({ z, points });
      continue;
    }

    if (NOT_BASE.has(feature.kind)) continue;
    const points = simplifyPolyline(scaled, 0.2);
    if (points.length < 2) continue;
    if (basePoints + points.length > MAX_BASE_POINTS) {
      baseDropped += 1;
      continue;
    }
    basePoints += points.length;
    base.push({ layer: feature.layer, closed: Boolean(feature.closed), points });
  }

  const marks: ReliefMark[] = [];
  for (const vertex of result.terrain?.vertices ?? []) {
    const point = { x: vertex.x * scale, y: vertex.y * scale };
    const z = vertex.z * scale;
    if (!nearParcel([point]) || !isAbsoluteElevation(z)) continue;
    marks.push({ x: point.x, y: point.y, z, fromGeometry: Boolean(vertex.zExplicit) });
  }
  const levels = marks.map((mark) => mark.z);
  const spread = levels.length ? Math.max(...levels) - Math.min(...levels) : undefined;
  const parcelSpan = Math.max(box.width, box.height);
  const trustedMarks =
    contours.length || elevationsLookLikeTerrain(marks.length, spread, parcelSpan) ? marks : [];

  return { contours, marks: trustedMarks, base, baseDropped };
}

export function placementSourceFromCad(
  result: CadProcessingResult,
  preferredCandidateId?: string,
): PlacementSource {
  const scale = unitScale(result);
  const closedPerLayer = new Map<string, number>();
  result.features.forEach((feature) => {
    if (feature.closed)
      closedPerLayer.set(feature.layer, (closedPerLayer.get(feature.layer) ?? 0) + 1);
  });
  const closedCandidates: Candidate[] = result.features
    .filter(
      (feature) =>
        feature.closed &&
        feature.points.length >= 3 &&
        ["boundary", "site", "unknown"].includes(feature.kind),
    )
    .map((feature) => ({
      id: feature.id,
      layer: feature.layer,
      polygon: points(feature, scale),
      source: "closed-cad" as const,
      featureKind: feature.kind,
      sourceType: feature.sourceType,
      fragmentCount: 1,
      sameLayerCount: closedPerLayer.get(feature.layer) ?? 1,
    }))
    .filter((candidate) => polygonArea(candidate.polygon) > 4);
  const roads = result.features
    .filter((feature) => feature.kind === "road" && feature.points.length >= 2)
    .map((feature) => points(feature, scale));
  const deduplicated = new Map<string, Candidate>();
  [...stitchBoundaryFragments(result.features, scale), ...closedCandidates].forEach((candidate) => {
    const bounds = polygonBounds(candidate.polygon);
    const signature = `${Math.round(bounds.x * 10)}:${Math.round(bounds.y * 10)}:${Math.round(polygonArea(candidate.polygon) * 10)}`;
    const current = deduplicated.get(signature);
    if (!current || parcelScore(candidate) > parcelScore(current))
      deduplicated.set(signature, candidate);
  });
  const candidates = [...deduplicated.values()].sort((a, b) => parcelScore(b) - parcelScore(a));
  const selected =
    candidates.find((candidate) => candidate.id === preferredCandidateId) ?? candidates[0];
  const parcel = selected?.polygon ?? null;
  const parcelBounds = parcel ? polygonBounds(parcel) : null;
  const parcelCandidates: ParcelCandidate[] = candidates.slice(0, 6).map((candidate) => ({
    id: candidate.id,
    label:
      candidate.source === "stitched-cad"
        ? `${candidate.layer} · собрано из ${candidate.fragmentCount} фрагм.`
        : candidate.layer,
    polygon: candidate.polygon,
    area: polygonArea(candidate.polygon),
    confidence: Math.max(0.35, Math.min(0.97, parcelScore(candidate) / 75)),
    source: candidate.source,
    streetEdgeIndex: detectStreetEdge(candidate.polygon, roads),
  }));

  const buildings = result.features
    .filter(
      (feature) => feature.kind === "building" && feature.closed && feature.points.length >= 3,
    )
    .map((feature): NeighborBuilding => ({ id: feature.id, polygon: points(feature, scale) }))
    .filter((building) => polygonArea(building.polygon) > 1)
    .filter((building) => {
      if (!parcelBounds) return true;
      const bounds = polygonBounds(building.polygon);
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const margin = Math.max(30, Math.max(parcelBounds.width, parcelBounds.height) * 0.5);
      return (
        center.x >= parcelBounds.x - margin &&
        center.x <= parcelBounds.x + parcelBounds.width + margin &&
        center.y >= parcelBounds.y - margin &&
        center.y <= parcelBounds.y + parcelBounds.height + margin
      );
    })
    .sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))
    .slice(0, 20);
  const officialRedLine = result.features.some((feature) =>
    /красн|red.?line/i.test(`${feature.layer} ${feature.blockName ?? ""} ${feature.text ?? ""}`),
  );

  const purpose = classifyDrawing({
    layers: (result.layers ?? []).map((layer) => layer.name),
    hasPlausibleParcel: Boolean(
      parcel && polygonArea(parcel) >= 100 && polygonArea(parcel) <= 50_000,
    ),
    parcelArea: parcel ? polygonArea(parcel) : undefined,
    markCount: result.terrain?.sampleCount ?? 0,
  });
  const utilities = utilityRestrictionsFromCad(result, scale);
  const unknownUtilityCount = utilities.filter((utility) => utility.kind === "unknown").length;

  const warnings = [...result.warnings];
  if (unknownUtilityCount)
    warnings.push(
      `Линий инженерных сетей без распознанного типа: ${unknownUtilityCount}. Охранные зоны для них не построены.`,
    );
  if (!purpose.allowsPlacement)
    warnings.unshift(`${purpose.suggestion} Основание: ${purpose.reasons.join("; ")}.`);
  if (!parcel)
    warnings.unshift(
      "Замкнутый кандидат границы участка не найден. Нужен кадастровый контур или ручное обведение.",
    );
  if (parcel && selected?.source === "stitched-cad")
    warnings.unshift(
      `Граница участка восстановлена из ${selected.fragmentCount} совпадающих CAD-фрагментов слоя «${selected.layer}». Подтвердите контур.`,
    );
  else if (parcel)
    warnings.unshift(
      "Контур выбран автоматически как кандидат. Подтвердите, что это граница нужного земельного участка.",
    );
  if (!officialRedLine)
    warnings.push(
      "Официальная красная линия в слоях не подтверждена; уличный отступ будет предварительным.",
    );

  return {
    kind: "dwg",
    name: result.fileName,
    confidence: result.preflight.status === "ready" ? "confirmed" : "local",
    unitLabel: result.unitLabel,
    coordinateLabel: result.spatialReference?.horizontalCrs ?? "Локальная система DWG",
    parcel: purpose.allowsPlacement ? parcel : null,
    withheldParcel: purpose.allowsPlacement || !parcel ? undefined : parcel,
    parcelConfirmed: false,
    streetEdgeIndex: parcel ? detectStreetEdge(parcel, roads) : 0,
    neighbors: buildings,
    parcelCandidates,
    selectedParcelCandidateId: selected?.id,
    utilities,
    relief: reliefFromCad(result, scale, parcel),
    purpose,
    cad: result,
    warnings,
  };
}
