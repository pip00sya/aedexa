import { splitRuns, stationsAlong, type Station } from "../geometry/polyline";
import { pointInPolygon, polygonArea } from "../geometry";
import { CAD_AUDIT_VERSION } from "./objectRules";
import type { CadFeature, CadPoint } from "./types";

export const ROAD_SURFACE_SOURCE_TYPE = "ROAD_SURFACE";

export type RoadSurfaceOptions = {
  /** Шаг сечения вдоль кромки, м */
  stationStepMeters?: number;
  /** Уже этого - не проезд, а двойное начертание одной кромки */
  minWidthMeters?: number;
  /** Шире этого - не проезд, а две несвязанные линии */
  maxWidthMeters?: number;
  /** Короче этого полотно не выпускается: обрывок ничего не значит */
  minLengthMeters?: number;
  maxWidthJumpMeters?: number;
  minLengthToWidthRatio?: number;
  occupied?: (x: number, y: number) => boolean;
  bridgeGapMeters?: number;
};

const corridorSamples = [0.2, 0.35, 0.5, 0.65, 0.8];
/** Соосность кусков для сшивки: cos 12° */
const bridgeAlignment = Math.cos((12 * Math.PI) / 180);
/** Зазор должен лежать вдоль линии, а не поперек: cos 25° */
const bridgeGapAlignment = Math.cos((25 * Math.PI) / 180);

const defaults = {
  bridgeGapMeters: 1,
  stationStepMeters: 1,
  minWidthMeters: 3,
  maxWidthMeters: 14,
  minLengthMeters: 6,
  maxWidthJumpMeters: 2,
  minLengthToWidthRatio: 1.5,
};

/** Противоположная кромка должна идти примерно вдоль исходной: cos 30° */
const minParallelAlignment = Math.cos(Math.PI / 6);

type Segment = {
  run: number;
  ax: number;
  ay: number;
  ex: number;
  ey: number;
  ux: number;
  uy: number;
};
type Hit = { x: number; y: number; distance: number; run: number };

export function chain(
  features: CadFeature[],
  toleranceUnits: number,
  bridgeUnits = 0,
): CadPoint[][] {
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
        const next = list.find((index) => !used[index]);
        if (next === undefined) break;
        const edge = edges[next];
        used[next] = true;
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
  return bridgeUnits > 0 ? bridgeCollinear(chains, bridgeUnits) : chains;
}

function endTangent(points: CadPoint[], atEnd: boolean) {
  const a = atEnd ? points[points.length - 2] : points[0];
  const b = atEnd ? points[points.length - 1] : points[1];
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

function bridgeCollinear(chains: CadPoint[][], bridgeUnits: number): CadPoint[][] {
  const pool = chains.filter((points) => points.length >= 2);
  for (let pass = 0; pass < 8; pass += 1) {
    let merged = false;
    for (let i = 0; i < pool.length; i += 1) {
      const head = pool[i];
      if (!head.length) continue;
      for (let j = i + 1; j < pool.length; j += 1) {
        const tail = pool[j];
        if (!tail.length) continue;
        let joined: CadPoint[] | undefined;
        for (const headForward of [true, false]) {
          for (const tailForward of [true, false]) {
            const a = headForward ? head : [...head].reverse();
            const b = tailForward ? tail : [...tail].reverse();
            const aEnd = a[a.length - 1];
            const bStart = b[0];
            const gap = Math.hypot(bStart.x - aEnd.x, bStart.y - aEnd.y);
            if (gap > bridgeUnits || gap < 1e-9) continue;
            const ta = endTangent(a, true);
            const tb = endTangent(b, false);
            if (ta.x * tb.x + ta.y * tb.y < bridgeAlignment) continue;
            const gx = (bStart.x - aEnd.x) / gap;
            const gy = (bStart.y - aEnd.y) / gap;
            if (gx * ta.x + gy * ta.y < bridgeGapAlignment) continue;
            joined = [...a, ...b];
            break;
          }
          if (joined) break;
        }
        if (!joined) continue;
        pool[i] = joined;
        pool[j] = [];
        merged = true;
        break;
      }
    }
    if (!merged) break;
  }
  return pool.filter((points) => points.length >= 2);
}

function createCaster(runs: CadPoint[][], maxReach: number) {
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

  return (station: Station, side: 1 | -1, minWidth: number, maxWidth: number): Hit | undefined => {
    const dx = -station.ty * side;
    const dy = station.tx * side;
    const cellX = Math.floor(station.x / maxReach);
    const cellY = Math.floor(station.y / maxReach);
    let best: Hit | undefined;
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
          if (t < minWidth || t > maxWidth || u < 0 || u > 1) continue;
          if (!best || t < best.distance)
            best = { x: station.x + dx * t, y: station.y + dy * t, distance: t, run: segment.run };
        }
      }
    }
    return best;
  };
}

type Band = { left: CadPoint[]; right: CadPoint[]; companion: number; lengthUnits: number };

export function buildRoadSurfaces(
  edges: CadFeature[],
  unitsPerMeter: number,
  options: RoadSurfaceOptions = {},
  blocked?: (x: number, y: number) => boolean,
): CadFeature[] {
  const resolved = { ...defaults, ...options };
  // Одна проверка "занято домом" на оба способа ее передать
  const occupied = resolved.occupied ?? blocked;
  const usable = edges.filter((feature) => !feature.closed && feature.points.length >= 2);
  if (usable.length < 2) return [];

  const scale = Math.max(unitsPerMeter, 1e-9);
  const runs = chain(usable, 0.02 * scale, resolved.bridgeGapMeters * scale).flatMap((points) =>
    splitRuns(points),
  );
  if (runs.length < 2) return [];

  const stepUnits = resolved.stationStepMeters * scale;
  const minWidth = resolved.minWidthMeters * scale;
  const maxWidth = resolved.maxWidthMeters * scale;
  const maxJump = resolved.maxWidthJumpMeters * scale;
  const minLength = resolved.minLengthMeters * scale;
  const cast = createCaster(runs, maxWidth);

  const bands: Band[] = [];
  for (let run = 0; run < runs.length; run += 1) {
    let current: Band | undefined;
    let previousWidth = 0;
    const close = () => {
      if (current && current.left.length >= 2) bands.push(current);
      current = undefined;
      previousWidth = 0;
    };
    for (const station of stationsAlong(runs[run], stepUnits, run)) {
      const left = cast(station, 1, minWidth, maxWidth);
      const right = cast(station, -1, minWidth, maxWidth);
      const hit =
        left && right ? (left.distance <= right.distance ? left : right) : (left ?? right);
      if (!hit) {
        close();
        continue;
      }
      if (occupied) {
        const throughHouse = corridorSamples.some((ratio) =>
          occupied(
            station.x + (hit.x - station.x) * ratio,
            station.y + (hit.y - station.y) * ratio,
          ),
        );
        if (throughHouse) {
          close();
          continue;
        }
      }
      const jumped = current !== undefined && Math.abs(hit.distance - previousWidth) > maxJump;
      if (jumped) close();
      if (current && current.right.length) {
        const previous = current.right[current.right.length - 1];
        if ((hit.x - previous.x) * station.tx + (hit.y - previous.y) * station.ty < 0) close();
      }
      if (!current) current = { left: [], right: [], companion: hit.run, lengthUnits: 0 };
      const last = current.left[current.left.length - 1];
      if (last) current.lengthUnits += Math.hypot(station.x - last.x, station.y - last.y);
      current.left.push({ x: station.x, y: station.y, z: 0 });
      current.right.push({ x: hit.x, y: hit.y, z: 0 });
      previousWidth = hit.distance;
    }
    close();
  }

  const joinReach = Math.max(stepUnits * 1.5, maxJump);
  for (let pass = 0; pass < 6; pass += 1) {
    let merged = false;
    for (let i = 0; i < bands.length; i += 1) {
      const head = bands[i];
      if (!head.left.length) continue;
      for (let j = i + 1; j < bands.length; j += 1) {
        const tail = bands[j];
        if (!tail.left.length) continue;
        const headEnd = head.left[head.left.length - 1];
        const tailStart = tail.left[0];
        if (Math.hypot(tailStart.x - headEnd.x, tailStart.y - headEnd.y) > joinReach) continue;
        const headWidth = Math.hypot(
          head.right[head.right.length - 1].x - headEnd.x,
          head.right[head.right.length - 1].y - headEnd.y,
        );
        const tailWidth = Math.hypot(tail.right[0].x - tailStart.x, tail.right[0].y - tailStart.y);
        if (Math.abs(headWidth - tailWidth) > maxJump) continue;
        head.lengthUnits +=
          Math.hypot(tailStart.x - headEnd.x, tailStart.y - headEnd.y) + tail.lengthUnits;
        head.left.push(...tail.left);
        head.right.push(...tail.right);
        tail.left = [];
        tail.right = [];
        merged = true;
      }
    }
    if (!merged) break;
  }

  const kept: Array<{ band: Band; points: CadPoint[] }> = [];
  const ordered = bands
    .filter((band) => band.left.length >= 3)
    .sort((a, b) => b.lengthUnits - a.lengthUnits);
  for (const band of ordered) {
    const width = Math.hypot(band.right[0].x - band.left[0].x, band.right[0].y - band.left[0].y);
    if (band.lengthUnits < minLength) continue;
    if (band.lengthUnits < width * resolved.minLengthToWidthRatio) continue;
    const points = [...band.left, ...[...band.right].reverse()];
    if (!Math.abs(polygonArea(points))) continue;
    const axis = band.left.map((left, index) => {
      const right = band.right[index];
      return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    });
    const covered = kept.some((other) => {
      const insideCount = axis.reduce(
        (count, point) => count + (pointInPolygon(point, other.points) ? 1 : 0),
        0,
      );
      return insideCount >= axis.length * 0.6;
    });
    if (!covered) kept.push({ band, points });
  }

  return kept
    .map(({ band }, index) => {
      const points = [...band.left, ...[...band.right].reverse()];
      const widthMeters = band.left.length
        ? Math.hypot(band.right[0].x - band.left[0].x, band.right[0].y - band.left[0].y) / scale
        : 0;
      const feature: CadFeature = {
        id: `road-surface-${index + 1}`,
        sourceType: ROAD_SURFACE_SOURCE_TYPE,
        layer: "AEDEXA · полотно проезда",
        kind: "road",
        confidence: 0.7,
        reason: `выведено между двумя подтверждёнными кромками, ширина ${widthMeters.toFixed(1)} м, длина ${(band.lengthUnits / scale).toFixed(0)} м; разрывы кромок не заполнялись`,
        classificationSource: "AI_DRAWING",
        closed: true,
        points,
        xySource: "CAD_GEOMETRY",
        zSource: "TIN",
        heightSource: "CAD_GEOMETRY",
        heightQuality: "DERIVED",
        heightMeters: 0,
        geometryConfidence: 0.7,
        qaStatus: "REVIEW",
        qaIssues: [
          "Полотно выведено из пары кромок, а не измерено: подтвердите по исполнительной документации.",
        ],
        elevationMode: "draped",
        auditVersion: CAD_AUDIT_VERSION,
      };
      return feature;
    })
    .filter((feature) => Math.abs(polygonArea(feature.points)) > 0);
}
