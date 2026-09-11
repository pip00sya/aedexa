import { splitRuns, stationsAlong, type Station } from "../geometry/polyline";
import { pointInPolygon, polygonArea, polygonBounds, polylineLength } from "../geometry";
import { median } from "../math/statistics";
import type { CadColorFamily, CadFeature, CadKind, CadPoint } from "./types";

export type CadGeometryForm = "closed" | "open" | "hatch" | "point";

/** Сечения, на которых у линии нашлась спутница в той же группе */
export type CadParallelSignature = {
  /** Доля сечений с найденной парой: у кромок проезда она высокая */
  pairedRatio: number;
  /** Медианное расстояние между парой линий, м */
  medianSpacingMeters: number;
  spacingSpreadMeters: number;
  stationCount: number;
};

export type CadCorridorSignature = {
  emptyRatio: number;
  /** Доля сечений, где в полосе стоит здание */
  buildingRatio: number;
  /** Доля сечений, где полоса лежит внутри другого замкнутого контура */
  enclosedRatio: number;
  longestPairedRunMeters: number;
  sampledStations: number;
};

export type CadGeometryGroup = {
  id: string;
  layer: string;
  colorFamily: CadColorFamily;
  form: CadGeometryForm;
  count: number;
  ruleKind: CadKind;
  ruleConfidence: number;
  ruleReason: string;
  /** Преобладающие стилевые признаки группы */
  colorIndex?: number;
  lineType?: string;
  lineWeightMm?: number;
  patternName?: string;
  totalLengthMeters: number;
  medianLengthMeters: number;
  chainCount?: number;
  medianChainLengthMeters?: number;
  medianEndGapMeters?: number;
  medianAreaMeters?: number;
  medianFillRatio?: number;
  medianElongationRatio?: number;
  spanMeters: { width: number; height: number };
  parallel?: CadParallelSignature;
  corridor?: CadCorridorSignature;
  /** Подписи, стоящие внутри контуров группы */
  labels: string[];
  featureIds: string[];
};

export type GeometryGroupOptions = {
  /** Сколько групп попадет в отпечаток: самые многочисленные */
  maxGroups?: number;
  /** Шаг сечения при замере параллельности, м */
  stationStepMeters?: number;
  minSpacingMeters?: number;
  /** Дальше этого линии парой не считаются */
  maxSpacingMeters?: number;
  maxStationsPerGroup?: number;
};

const defaults = {
  maxGroups: 60,
  stationStepMeters: 2,
  minSpacingMeters: 1.5,
  maxSpacingMeters: 30,
  maxStationsPerGroup: 4_000,
};

/** Противоположная линия должна идти примерно вдоль исходной: cos 30° */
const minParallelAlignment = Math.cos(Math.PI / 6);

const textTypes = /^(TEXT|MTEXT|ATTRIB|DIMENSION)$/u;

type Segment = {
  run: number;
  ax: number;
  ay: number;
  ex: number;
  ey: number;
  ux: number;
  uy: number;
};
type Bucket = {
  layer: string;
  colorFamily: CadColorFamily;
  form: CadGeometryForm;
  members: CadFeature[];
};

function formOf(feature: CadFeature): CadGeometryForm {
  if (feature.sourceType.toUpperCase() === "HATCH") return "hatch";
  if (feature.closed && feature.points.length >= 3) return "closed";
  return feature.points.length >= 2 ? "open" : "point";
}

/** Самое частое значение среди заданных; undefined, если значений нет */
function dominant<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function chainLinework(features: CadFeature[], toleranceUnits: number): CadPoint[][] {
  const nodes: CadPoint[] = [];
  const cells = new Map<string, number[]>();
  const nodeFor = (point: CadPoint) => {
    const cellX = Math.floor(point.x / toleranceUnits);
    const cellY = Math.floor(point.y / toleranceUnits);
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (const id of cells.get(`${x}:${y}`) ?? []) {
          if (Math.hypot(nodes[id].x - point.x, nodes[id].y - point.y) <= toleranceUnits) return id;
        }
      }
    }
    const id = nodes.length;
    nodes.push(point);
    const key = `${cellX}:${cellY}`;
    const list = cells.get(key);
    if (list) list.push(id);
    else cells.set(key, [id]);
    return id;
  };

  const edges = features.map((feature) => ({
    points: feature.points,
    start: nodeFor(feature.points[0]),
    end: nodeFor(feature.points[feature.points.length - 1]),
  }));
  const incident = new Map<number, number[]>();
  edges.forEach((edge, index) => {
    for (const node of [edge.start, edge.end]) {
      const list = incident.get(node);
      if (list) list.push(index);
      else incident.set(node, [index]);
    }
  });

  const used = new Array<boolean>(edges.length).fill(false);
  const chains: CadPoint[][] = [];
  for (let seed = 0; seed < edges.length; seed += 1) {
    if (used[seed]) continue;
    used[seed] = true;
    const points = [...edges[seed].points];
    const extend = (startNode: number, forward: boolean) => {
      let current = startNode;
      for (let guard = 0; guard < 100_000; guard += 1) {
        const list = incident.get(current) ?? [];
        if (list.length !== 2) break;
        const nextIndex = list.find((index) => !used[index]);
        if (nextIndex === undefined) break;
        const edge = edges[nextIndex];
        used[nextIndex] = true;
        const oriented = edge.start === current ? edge.points : [...edge.points].reverse();
        if (forward) points.push(...oriented.slice(1));
        else points.unshift(...[...oriented].reverse().slice(0, -1));
        current = edge.start === current ? edge.end : edge.start;
      }
    };
    extend(edges[seed].end, true);
    extend(edges[seed].start, false);
    chains.push(points);
  }
  return chains;
}

function createSpacingProbe(runs: CadPoint[][], maxReach: number) {
  const segments: Segment[] = [];
  const grid = new Map<string, number[]>();
  runs.forEach((points, run) => {
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-9) continue;
      const id =
        segments.push({
          run,
          ax: a.x,
          ay: a.y,
          ex: b.x - a.x,
          ey: b.y - a.y,
          ux: (b.x - a.x) / length,
          uy: (b.y - a.y) / length,
        }) - 1;
      for (
        let x = Math.floor(Math.min(a.x, b.x) / maxReach);
        x <= Math.floor(Math.max(a.x, b.x) / maxReach);
        x += 1
      ) {
        for (
          let y = Math.floor(Math.min(a.y, b.y) / maxReach);
          y <= Math.floor(Math.max(a.y, b.y) / maxReach);
          y += 1
        ) {
          const key = `${x}:${y}`;
          const list = grid.get(key);
          if (list) list.push(id);
          else grid.set(key, [id]);
        }
      }
    }
  });

  return (station: Station, side: 1 | -1, minWidth: number, maxWidth: number) => {
    const dx = -station.ty * side;
    const dy = station.tx * side;
    const cellX = Math.floor(station.x / maxReach);
    const cellY = Math.floor(station.y / maxReach);
    let best: number | undefined;
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (const id of grid.get(`${x}:${y}`) ?? []) {
          const segment = segments[id];
          if (segment.run === station.run) continue;
          if (Math.abs(segment.ux * station.tx + segment.uy * station.ty) < minParallelAlignment)
            continue;
          const denominator = dx * segment.ey - dy * segment.ex;
          if (Math.abs(denominator) < 1e-12) continue;
          const wx = segment.ax - station.x;
          const wy = segment.ay - station.y;
          const t = (wx * segment.ey - wy * segment.ex) / denominator;
          const u = (wx * dy - wy * dx) / denominator;
          if (t < minWidth || u < 0 || u > 1 || t > maxWidth) continue;
          if (best === undefined || t < best) best = t;
        }
      }
    }
    return best;
  };
}

function measureEndGaps(
  features: CadFeature[],
  unitsPerMeter: number,
  maxReachMeters: number,
): number | undefined {
  const ends = features.flatMap((feature, owner) =>
    [feature.points[0], feature.points[feature.points.length - 1]].map((point) => ({
      x: point.x,
      y: point.y,
      owner,
    })),
  );
  if (ends.length < 4) return undefined;

  const reach = maxReachMeters * unitsPerMeter;
  const grid = new Map<string, number[]>();
  ends.forEach((end, index) => {
    const key = `${Math.floor(end.x / reach)}:${Math.floor(end.y / reach)}`;
    const list = grid.get(key);
    if (list) list.push(index);
    else grid.set(key, [index]);
  });

  const gaps: number[] = [];
  for (const end of ends) {
    const cellX = Math.floor(end.x / reach);
    const cellY = Math.floor(end.y / reach);
    let best = Infinity;
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (const index of grid.get(`${x}:${y}`) ?? []) {
          const other = ends[index];
          if (other.owner === end.owner) continue;
          const distance = Math.hypot(other.x - end.x, other.y - end.y);
          if (distance < best) best = distance;
        }
      }
    }
    if (Number.isFinite(best)) gaps.push(best / unitsPerMeter);
  }
  return gaps.length ? median(gaps) : undefined;
}

export type CadOccupancy = "building" | "enclosed" | "empty";

function createOccupancyProbe(
  features: CadFeature[],
  unitsPerMeter: number,
  sheet: { width: number; height: number },
) {
  const cell = 20 * unitsPerMeter;
  const sheetArea = Math.max(sheet.width * sheet.height, 1e-9);
  const grid = new Map<string, Array<{ points: CadPoint[]; kind: CadOccupancy }>>();
  for (const feature of features) {
    if (!feature.closed || feature.points.length < 3) continue;
    const area = polygonArea(feature.points);
    if (area < 1 * unitsPerMeter * unitsPerMeter) continue;
    if (area > sheetArea * 0.1) continue;
    const box = polygonBounds(feature.points);
    const entry = {
      points: feature.points,
      kind: (feature.kind === "building" ? "building" : "enclosed") as CadOccupancy,
    };
    for (let x = Math.floor(box.x / cell); x <= Math.floor((box.x + box.width) / cell); x += 1) {
      for (let y = Math.floor(box.y / cell); y <= Math.floor((box.y + box.height) / cell); y += 1) {
        const key = `${x}:${y}`;
        const list = grid.get(key);
        if (list) list.push(entry);
        else grid.set(key, [entry]);
      }
    }
  }

  return (x: number, y: number): CadOccupancy => {
    let result: CadOccupancy = "empty";
    for (const entry of grid.get(`${Math.floor(x / cell)}:${Math.floor(y / cell)}`) ?? []) {
      if (!pointInPolygon({ x, y }, entry.points)) continue;
      if (entry.kind === "building") return "building";
      result = "enclosed";
    }
    return result;
  };
}

function measureParallel(
  runs: CadPoint[][],
  unitsPerMeter: number,
  options: Required<GeometryGroupOptions>,
  occupancy?: (x: number, y: number) => CadOccupancy,
): { parallel: CadParallelSignature; corridor?: CadCorridorSignature } | undefined {
  if (runs.length < 2) return undefined;

  const stepUnits = options.stationStepMeters * unitsPerMeter;
  const minWidth = options.minSpacingMeters * unitsPerMeter;
  const maxWidth = options.maxSpacingMeters * unitsPerMeter;
  const probe = createSpacingProbe(runs, maxWidth);

  const spacings: number[] = [];
  let stationCount = 0;
  let pairedCount = 0;
  const seen: Record<CadOccupancy, number> = { building: 0, enclosed: 0, empty: 0 };
  let sampled = 0;
  let longestRun = 0;
  for (let run = 0; run < runs.length && stationCount < options.maxStationsPerGroup; run += 1) {
    let currentRun = 0;
    for (const station of stationsAlong(runs[run], stepUnits, run)) {
      if (stationCount >= options.maxStationsPerGroup) break;
      stationCount += 1;
      const left = probe(station, 1, minWidth, maxWidth);
      const right = probe(station, -1, minWidth, maxWidth);
      const side: 1 | -1 = left === undefined ? -1 : right === undefined || left <= right ? 1 : -1;
      const nearest = side === 1 ? left : right;
      if (nearest === undefined) {
        currentRun = 0;
        continue;
      }
      pairedCount += 1;
      spacings.push(nearest / unitsPerMeter);
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
      if (occupancy) {
        const half = nearest / 2;
        seen[
          occupancy(station.x - station.ty * side * half, station.y + station.tx * side * half)
        ] += 1;
        sampled += 1;
      }
    }
  }
  if (!stationCount || !spacings.length) return undefined;

  const medianSpacing = median(spacings);
  return {
    parallel: {
      pairedRatio: pairedCount / stationCount,
      medianSpacingMeters: medianSpacing,
      spacingSpreadMeters: median(spacings.map((value) => Math.abs(value - medianSpacing))),
      stationCount,
    },
    ...(sampled
      ? {
          corridor: {
            emptyRatio: seen.empty / sampled,
            buildingRatio: seen.building / sampled,
            enclosedRatio: seen.enclosed / sampled,
            longestPairedRunMeters: (longestRun * stepUnits) / unitsPerMeter,
            sampledStations: sampled,
          },
        }
      : {}),
  };
}

export function buildGeometryGroups(
  features: CadFeature[],
  unitsPerMeter: number,
  options: GeometryGroupOptions = {},
): CadGeometryGroup[] {
  const resolved: Required<GeometryGroupOptions> = { ...defaults, ...options };
  const scale = Math.max(unitsPerMeter, 1e-9);
  const sheet = polygonBounds(features.flatMap((feature) => feature.points));
  const occupancy = createOccupancyProbe(features, scale, sheet);
  const buckets = new Map<string, Bucket>();
  for (const feature of features) {
    if (textTypes.test(feature.sourceType.toUpperCase())) continue;
    if (!feature.points.length) continue;
    const colorFamily = feature.colorFamily ?? "unknown";
    const form = formOf(feature);
    const key = JSON.stringify([feature.layer, colorFamily, form]);
    const bucket = buckets.get(key);
    if (bucket) bucket.members.push(feature);
    else buckets.set(key, { layer: feature.layer, colorFamily, form, members: [feature] });
  }

  const measured = [...buckets.values()].map(
    ({ layer, colorFamily, form, members }): Omit<CadGeometryGroup, "id"> => {
      const lengths = members.map((feature) => polylineLength(feature.points) / scale);
      const closedMembers = members.filter(
        (feature) => feature.closed && feature.points.length >= 3,
      );
      const areas = closedMembers.map((feature) => polygonArea(feature.points) / (scale * scale));
      const fills: number[] = [];
      const elongations: number[] = [];
      for (const feature of closedMembers) {
        const box = polygonBounds(feature.points);
        const boxArea = box.width * box.height;
        if (boxArea > 0) fills.push(polygonArea(feature.points) / boxArea);
        const long = Math.max(box.width, box.height);
        const short = Math.min(box.width, box.height);
        if (short > 0) elongations.push(long / short);
      }
      const span = polygonBounds(members.flatMap((feature) => feature.points));
      const strongest = [...members].sort((a, b) => b.confidence - a.confidence)[0];
      const linework =
        form === "open"
          ? members.filter((feature) => !feature.closed && feature.points.length >= 2)
          : [];
      const chains = linework.length ? chainLinework(linework, 0.02 * scale) : [];

      return {
        layer,
        colorFamily,
        form,
        count: members.length,
        ruleKind: dominant(members.map((feature) => feature.kind)) ?? strongest.kind,
        ruleConfidence: median(members.map((feature) => feature.confidence)),
        ruleReason: strongest.reason,
        colorIndex: dominant(
          members
            .map((feature) => feature.sourceColorIndex)
            .filter((value): value is number => value !== undefined),
        ),
        lineType: dominant(
          members
            .map((feature) => feature.lineType)
            .filter((value): value is string => Boolean(value)),
        ),
        lineWeightMm: dominant(
          members
            .map((feature) => feature.lineWeightMm)
            .filter((value): value is number => value !== undefined),
        ),
        patternName: dominant(
          members
            .map((feature) => feature.patternName)
            .filter((value): value is string => Boolean(value)),
        ),
        totalLengthMeters: lengths.reduce((total, value) => total + value, 0),
        medianLengthMeters: median(lengths),
        ...(chains.length
          ? {
              chainCount: chains.length,
              medianChainLengthMeters: median(chains.map((chain) => polylineLength(chain) / scale)),
              medianEndGapMeters: measureEndGaps(linework, scale, resolved.maxSpacingMeters),
            }
          : {}),
        ...(areas.length ? { medianAreaMeters: median(areas) } : {}),
        ...(fills.length ? { medianFillRatio: median(fills) } : {}),
        ...(elongations.length ? { medianElongationRatio: median(elongations) } : {}),
        spanMeters: { width: span.width / scale, height: span.height / scale },
        ...(chains.length
          ? (measureParallel(
              chains.flatMap((chain) => splitRuns(chain)),
              scale,
              resolved,
              occupancy,
            ) ?? {})
          : {}),
        labels: [...new Set(members.flatMap((feature) => feature.labels ?? []))].slice(0, 12),
        featureIds: members.map((feature) => feature.id),
      };
    },
  );

  return measured
    .sort((a, b) => b.totalLengthMeters - a.totalLengthMeters || b.count - a.count)
    .slice(0, resolved.maxGroups)
    .map((group, index) => ({ id: `g${index + 1}`, ...group }));
}
