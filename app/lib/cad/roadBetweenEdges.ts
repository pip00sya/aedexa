import { pointInPolygon, polygonArea, polylineLength } from "../geometry";
import { CAD_AUDIT_VERSION } from "./objectRules";
import { chain, ROAD_SURFACE_SOURCE_TYPE } from "./roadSurface";
import type { CadFeature, CadPoint } from "./types";

export type RoadBetweenEdgesOptions = {
  /** Шаг сечения вдоль кромки между ее вершинами, м */
  stationStepMeters?: number;
  /** Уже - двойное начертание одной кромки, не проезд */
  minWidthMeters?: number;
  /** Шире - две несвязанные линии */
  maxWidthMeters?: number;
  /** Короче не выпускается */
  minLengthMeters?: number;
  minLengthToWidthRatio?: number;
  maxWidthJumpMeters?: number;
  bridgeGapMeters?: number;
  closeBayOpeningsMeters?: number;
  /** Пятна домов: сквозь них полотно не идет */
  occupied?: (x: number, y: number) => boolean;
  boundaries?: readonly CadFeature[];
  maxUnmatchedMeters?: number;
  trace?: (event: RoadTraceEvent) => void;
};

export type RoadTraceEvent =
  | {
      kind: "close";
      reason: "no-b-too-long" | "occupied" | "jumped" | "backward" | "end-of-chain";
      chain: number;
      at: CadPoint;
      points: number;
      matched: number;
      lengthMeters: number;
    }
  | { kind: "chains"; count: number; lengthsMeters: number[] }
  | {
      kind: "drop";
      reason: "too-short" | "too-square" | "no-area" | "duplicate";
      lengthMeters: number;
      widthMeters: number;
      at: CadPoint;
    }
  | { kind: "keep"; lengthMeters: number; widthMeters: number; at: CadPoint }
  | {
      kind: "station";
      chain: number;
      at: CadPoint;
      tangent: [number, number];
      turned: boolean;
      left?: [number, number];
      right?: [number, number];
      decision: "match" | "skip-jumped" | "skip-backward" | "no-hit" | "occupied";
    }
  | {
      kind: "opening";
      aEnd: CadPoint;
      bStart: CadPoint;
      gapMeters: number;
      verdict: "joined" | "leg-a" | "leg-b" | "direction" | "across";
    };

const defaults = {
  stationStepMeters: 1,
  minWidthMeters: 0.9,
  maxWidthMeters: 14,
  minLengthMeters: 4,
  minLengthToWidthRatio: 1.5,
  maxWidthJumpMeters: 2,
  bridgeGapMeters: 1,
  maxUnmatchedMeters: 2,
  closeBayOpeningsMeters: 3,
};

const sameWayLegs = Math.cos((12 * Math.PI) / 180);
/** Зазор проема лежит поперек ножек: доля вдоль ножки не больше sin 15° */
const openingAcross = Math.sin((15 * Math.PI) / 180);
const minLegPieceRatio = 1;

function endDirection(points: CadPoint[], atEnd: boolean) {
  const a = atEnd ? points[points.length - 2] : points[1];
  const b = atEnd ? points[points.length - 1] : points[0];
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

const maxLegMeters = 3;

function endRoadDirection(points: CadPoint[], atEnd: boolean, windowUnits: number) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y),
    );
  }
  const total = cumulative[cumulative.length - 1];
  const from = atEnd ? pointAt(points, cumulative, total - windowUnits) : points[0];
  const to = atEnd ? points[points.length - 1] : pointAt(points, cumulative, windowUnits);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return length > 1e-9
    ? { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
    : endDirection(points, atEnd);
}

const roadWindowMeters = 5;

function gapAlongRoad(a: CadPoint[], b: CadPoint[], gx: number, gy: number, scale: number) {
  const window = roadWindowMeters * scale;
  const checks: Array<{ x: number; y: number }> = [];
  if (polylineLength(a) >= window) checks.push(endRoadDirection(a, true, window));
  if (polylineLength(b) >= window) checks.push(endRoadDirection(b, false, window));
  return checks.every((road) => Math.abs(gx * road.x + gy * road.y) >= minParallelAlignment);
}
const legLookbackMeters = 2.5;
/** Ножка должна свернуть с хода кромки хотя бы на 60° */
const legTurn = Math.cos(Math.PI / 3);

function isLeg(points: CadPoint[], atEnd: boolean, scale: number) {
  const oriented = atEnd ? points : [...points].reverse();
  const tip = oriented[oriented.length - 1];
  const root = oriented[oriented.length - 2];
  const legLength = Math.hypot(tip.x - root.x, tip.y - root.y);
  if (legLength < 1e-9 || legLength > maxLegMeters * scale) return false;
  const leg = { x: (tip.x - root.x) / legLength, y: (tip.y - root.y) / legLength };
  let remaining = legLookbackMeters * scale;
  let index = oriented.length - 2;
  let back: CadPoint = root;
  while (index > 0 && remaining > 0) {
    const previous = oriented[index - 1];
    const step = Math.hypot(back.x - previous.x, back.y - previous.y);
    if (step >= remaining) {
      const ratio = remaining / step;
      back = {
        x: back.x + (previous.x - back.x) * ratio,
        y: back.y + (previous.y - back.y) * ratio,
        z: 0,
      };
      remaining = 0;
      break;
    }
    remaining -= step;
    back = previous;
    index -= 1;
  }
  const runLength = Math.hypot(root.x - back.x, root.y - back.y);
  if (runLength < 1e-9) return false;
  const run = { x: (root.x - back.x) / runLength, y: (root.y - back.y) / runLength };
  return Math.abs(run.x * leg.x + run.y * leg.y) <= legTurn;
}

function bridgeOpenings(
  chains: CadPoint[][],
  maxOpeningUnits: number,
  minPieceUnits: number,
  scale: number,
  trace?: (event: RoadTraceEvent) => void,
): CadPoint[][] {
  const report = (
    aEnd: CadPoint,
    bStart: CadPoint,
    gap: number,
    verdict: Extract<RoadTraceEvent, { kind: "opening" }>["verdict"],
  ) => trace?.({ kind: "opening", aEnd, bStart, gapMeters: gap / scale, verdict });
  const pool = chains.filter((points) => points.length >= 2);
  for (let pass = 0; pass < 8; pass += 1) {
    let merged = false;
    for (let i = 0; i < pool.length; i += 1) {
      const head = pool[i];
      if (head.length < 3 || polylineLength(head) < minPieceUnits) continue;
      for (let j = i + 1; j < pool.length; j += 1) {
        const tail = pool[j];
        if (tail.length < 3 || polylineLength(tail) < minPieceUnits) continue;
        let joined: CadPoint[] | undefined;
        for (const headForward of [true, false]) {
          for (const tailForward of [true, false]) {
            const a = headForward ? head : [...head].reverse();
            const b = tailForward ? tail : [...tail].reverse();
            const aEnd = a[a.length - 1];
            const bStart = b[0];
            const gap = Math.hypot(bStart.x - aEnd.x, bStart.y - aEnd.y);
            if (gap > maxOpeningUnits || gap < 1e-9) continue;
            if (!isLeg(a, true, scale)) {
              report(aEnd, bStart, gap, "leg-a");
              continue;
            }
            if (!isLeg(b, false, scale)) {
              report(aEnd, bStart, gap, "leg-b");
              continue;
            }
            // Наружные направления обеих ножек: от прохода к дому, параллельно
            const outA = endDirection(a, true);
            const outB = endDirection(b, false);
            if (outA.x * outB.x + outA.y * outB.y < sameWayLegs) {
              report(aEnd, bStart, gap, "direction");
              continue;
            }
            const gx = (bStart.x - aEnd.x) / gap;
            const gy = (bStart.y - aEnd.y) / gap;
            if (Math.abs(gx * outA.x + gy * outA.y) > openingAcross) {
              report(aEnd, bStart, gap, "across");
              continue;
            }
            if (!gapAlongRoad(a, b, gx, gy, scale)) {
              report(aEnd, bStart, gap, "across");
              continue;
            }
            report(aEnd, bStart, gap, "joined");
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

/** Противоположная кромка должна идти примерно вдоль исходной: cos 30° */
const minParallelAlignment = Math.cos(Math.PI / 6);
/** Где по ширине полосы проверять занятость домом */
const corridorSamples = [0.2, 0.35, 0.5, 0.65, 0.8];

type Station = { x: number; y: number; tx: number; ty: number; lx: number; ly: number };
type Segment = {
  chain: number;
  index: number;
  ax: number;
  ay: number;
  ex: number;
  ey: number;
  ux: number;
  uy: number;
};
type Hit = {
  x: number;
  y: number;
  distance: number;
  chain: number;
  index: number;
  via: "curb" | "building";
};

const smoothWindowMeters = 3;

/** Точка на ломаной по длине от начала (с зажимом в концы) */
function pointAt(points: CadPoint[], cumulative: number[], s: number) {
  const total = cumulative[cumulative.length - 1];
  const target = Math.min(Math.max(s, 0), total);
  let index = 1;
  while (index < cumulative.length - 1 && cumulative[index] < target) index += 1;
  const a = points[index - 1];
  const b = points[index];
  const span = cumulative[index] - cumulative[index - 1];
  const ratio = span > 1e-9 ? (target - cumulative[index - 1]) / span : 0;
  return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
}

function stationsAlong(points: CadPoint[], stepUnits: number, smoothUnits: number): Station[] {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y),
    );
  }
  const raw: Array<{ x: number; y: number; s: number; tx: number; ty: number }> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = cumulative[index + 1] - cumulative[index];
    if (length < 1e-9) continue;
    const tx = (b.x - a.x) / length;
    const ty = (b.y - a.y) / length;
    const steps = Math.max(1, Math.floor(length / stepUnits));
    for (let step = 0; step < steps; step += 1) {
      const along = (length * step) / steps;
      raw.push({ x: a.x + tx * along, y: a.y + ty * along, s: cumulative[index] + along, tx, ty });
    }
    if (index === points.length - 2) raw.push({ x: b.x, y: b.y, s: cumulative[index + 1], tx, ty });
  }
  return raw.map((station) => {
    const behind = pointAt(points, cumulative, station.s - smoothUnits);
    const ahead = pointAt(points, cumulative, station.s + smoothUnits);
    const length = Math.hypot(ahead.x - behind.x, ahead.y - behind.y);
    return length > 1e-9
      ? {
          x: station.x,
          y: station.y,
          tx: (ahead.x - behind.x) / length,
          ty: (ahead.y - behind.y) / length,
          lx: station.tx,
          ly: station.ty,
        }
      : {
          x: station.x,
          y: station.y,
          tx: station.tx,
          ty: station.ty,
          lx: station.tx,
          ly: station.ty,
        };
  });
}

function nearestBoundary(cast: { curb?: Hit; building?: Hit }): Hit | undefined {
  const { curb, building } = cast;
  if (curb && (!building || curb.distance <= building.distance)) return curb;
  return building;
}

function createCaster(chains: CadPoint[][], kinds: Array<"curb" | "building">, maxReach: number) {
  const segments: Segment[] = [];
  const grid = new Map<string, number[]>();
  chains.forEach((points, chainIndex) => {
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-9) continue;
      const id =
        segments.push({
          chain: chainIndex,
          index,
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

  return (
    station: Station,
    own: number,
    side: 1 | -1,
    minWidth: number,
    maxWidth: number,
  ): { curb?: Hit; building?: Hit } => {
    const dx = -station.ty * side;
    const dy = station.tx * side;
    const cellX = Math.floor(station.x / maxReach);
    const cellY = Math.floor(station.y / maxReach);
    let curb: Hit | undefined;
    let building: Hit | undefined;
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (const id of grid.get(`${x}:${y}`) ?? []) {
          const segment = segments[id];
          if (segment.chain === own) continue;
          if (Math.abs(segment.ux * station.tx + segment.uy * station.ty) < minParallelAlignment)
            continue;
          const denominator = dx * segment.ey - dy * segment.ex;
          if (Math.abs(denominator) < 1e-12) continue;
          const wx = segment.ax - station.x;
          const wy = segment.ay - station.y;
          const t = (wx * segment.ey - wy * segment.ex) / denominator;
          const u = (wx * dy - wy * dx) / denominator;
          if (t < minWidth || t > maxWidth || u < 0 || u > 1) continue;
          const via = kinds[segment.chain];
          const hit: Hit = {
            x: station.x + dx * t,
            y: station.y + dy * t,
            distance: t,
            chain: segment.chain,
            index: segment.index,
            via,
          };
          if (via === "curb") {
            if (!curb || t < curb.distance) curb = hit;
          } else if (!building || t < building.distance) {
            building = hit;
          }
        }
      }
    }
    return { curb, building };
  };
}

type Run = { a: CadPoint[]; hits: Array<Hit | undefined> };

const maxDetourMeters = 6;

function facingSide(chains: CadPoint[][], hits: Hit[], scale: number): CadPoint[] {
  const side: CadPoint[] = [{ x: hits[0].x, y: hits[0].y, z: 0 }];
  for (let position = 1; position < hits.length; position += 1) {
    const previous = hits[position - 1];
    const current = hits[position];
    if (current.chain === previous.chain && current.index !== previous.index) {
      const target = chains[current.chain];
      const between: CadPoint[] = [];
      if (current.index > previous.index) {
        for (let index = previous.index + 1; index <= current.index; index += 1)
          between.push(target[index]);
      } else {
        for (let index = previous.index; index > current.index; index -= 1)
          between.push(target[index]);
      }
      const chord = Math.hypot(current.x - previous.x, current.y - previous.y);
      const detour = polylineLength([
        { x: previous.x, y: previous.y },
        ...between,
        { x: current.x, y: current.y },
      ]);
      if (detour <= chord + maxDetourMeters * scale) side.push(...between);
    }
    side.push({ x: current.x, y: current.y, z: 0 });
  }
  return side;
}

/** Отвод (ножка) считается рядом с концом, если он не дальше этого, м */
const flankReachMeters = 1.2;

function hasReturnNear(points: CadPoint[], atEnd: boolean, reachUnits: number) {
  const oriented = atEnd ? points : [...points].reverse();
  const tip = oriented[oriented.length - 1];
  const root = oriented[oriented.length - 2];
  const endLength = Math.hypot(tip.x - root.x, tip.y - root.y) || 1;
  const end = { x: (tip.x - root.x) / endLength, y: (tip.y - root.y) / endLength };
  let walked = endLength;
  for (let index = oriented.length - 2; index > 0 && walked <= reachUnits; index -= 1) {
    const b = oriented[index];
    const a = oriented[index - 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    if (Math.abs(direction.x * end.x + direction.y * end.y) <= legTurn) return true;
    walked += length;
  }
  return false;
}

function bridgeFlankedGaps(
  chains: CadPoint[][],
  maxOpeningUnits: number,
  minPieceUnits: number,
  scale: number,
  trace?: (event: RoadTraceEvent) => void,
): CadPoint[][] {
  const pool = chains.filter((points) => points.length >= 2);
  for (let pass = 0; pass < 8; pass += 1) {
    let merged = false;
    for (let i = 0; i < pool.length; i += 1) {
      const head = pool[i];
      if (head.length < 3 || polylineLength(head) < minPieceUnits) continue;
      for (let j = i + 1; j < pool.length; j += 1) {
        const tail = pool[j];
        if (tail.length < 3 || polylineLength(tail) < minPieceUnits) continue;
        let joined: CadPoint[] | undefined;
        for (const headForward of [true, false]) {
          for (const tailForward of [true, false]) {
            const a = headForward ? head : [...head].reverse();
            const b = tailForward ? tail : [...tail].reverse();
            const aEnd = a[a.length - 1];
            const bStart = b[0];
            const gap = Math.hypot(bStart.x - aEnd.x, bStart.y - aEnd.y);
            if (gap > maxOpeningUnits || gap < 1e-9) continue;
            const outA = endDirection(a, true);
            const outB = endDirection(b, false);
            // Концы навстречу и зазор вдоль линии
            if (outA.x * outB.x + outA.y * outB.y > -sameWayLegs) continue;
            const gx = (bStart.x - aEnd.x) / gap;
            const gy = (bStart.y - aEnd.y) / gap;
            if (gx * outA.x + gy * outA.y < sameWayLegs) continue;
            if (!gapAlongRoad(a, b, gx, gy, scale)) {
              trace?.({ kind: "opening", aEnd, bStart, gapMeters: gap / scale, verdict: "across" });
              continue;
            }
            if (
              !hasReturnNear(a, true, flankReachMeters * scale) ||
              !hasReturnNear(b, false, flankReachMeters * scale)
            ) {
              trace?.({ kind: "opening", aEnd, bStart, gapMeters: gap / scale, verdict: "leg-a" });
              continue;
            }
            trace?.({ kind: "opening", aEnd, bStart, gapMeters: gap / scale, verdict: "joined" });
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

export function buildRoadBetweenEdges(
  edges: CadFeature[],
  unitsPerMeter: number,
  options: RoadBetweenEdgesOptions = {},
): CadFeature[] {
  const resolved = { ...defaults, ...options };
  const usable = edges.filter((feature) => !feature.closed && feature.points.length >= 2);
  if (usable.length < 2) return [];

  const scale = Math.max(unitsPerMeter, 1e-9);
  const stitched = chain(usable, 0.02 * scale, resolved.bridgeGapMeters * scale);
  const maxOpeningUnits = resolved.closeBayOpeningsMeters * scale;
  const chains =
    resolved.closeBayOpeningsMeters > 0
      ? bridgeFlankedGaps(
          bridgeOpenings(
            stitched,
            maxOpeningUnits,
            minLegPieceRatio * scale,
            scale,
            resolved.trace,
          ),
          maxOpeningUnits,
          minLegPieceRatio * scale,
          scale,
          resolved.trace,
        )
      : stitched;
  if (chains.length < 2) return [];

  const stepUnits = resolved.stationStepMeters * scale;
  const minWidth = resolved.minWidthMeters * scale;
  const maxWidth = resolved.maxWidthMeters * scale;
  const maxJump = resolved.maxWidthJumpMeters * scale;
  const minLength = resolved.minLengthMeters * scale;
  const maxUnmatched = resolved.maxUnmatchedMeters * scale;
  const buildingChains = (resolved.boundaries ?? [])
    .filter((feature) => feature.closed && feature.points.length >= 3)
    .map((feature) => [...feature.points, feature.points[0]]);
  const targets = [...chains, ...buildingChains];
  const targetKinds: Array<"curb" | "building"> = [
    ...chains.map(() => "curb" as const),
    ...buildingChains.map(() => "building" as const),
  ];
  const cast = createCaster(targets, targetKinds, maxWidth);
  const occupied = resolved.occupied;
  const trace = resolved.trace;
  trace?.({
    kind: "chains",
    count: chains.length,
    lengthsMeters: chains.map((points) => polylineLength(points) / scale),
  });

  const runs: Run[] = [];
  chains.forEach((points, own) => {
    let current: Run | undefined;
    let lastMatched: Hit | undefined;
    /** Сечение последнего попадания: от него меряется отрезок без кромки B */
    let lastStation: Station | undefined;
    let runSide: 1 | -1 | undefined;
    const close = (
      reason: Extract<RoadTraceEvent, { kind: "close" }>["reason"] = "end-of-chain",
      at?: Station,
    ) => {
      if (current && trace) {
        trace({
          kind: "close",
          reason,
          chain: own,
          at: at ? { x: at.x, y: at.y, z: 0 } : current.a[current.a.length - 1],
          points: current.a.length,
          matched: current.hits.filter(Boolean).length,
          lengthMeters: polylineLength(current.a) / scale,
        });
      }
      if (current) {
        while (current.hits.length && !current.hits[current.hits.length - 1]) {
          current.hits.pop();
          current.a.pop();
        }
        if (current.hits.filter(Boolean).length >= 2) runs.push(current);
      }
      current = undefined;
      lastMatched = undefined;
      lastStation = undefined;
      runSide = undefined;
    };
    for (const station of stationsAlong(points, stepUnits, smoothWindowMeters * scale)) {
      let hit: Hit | undefined;
      const turned = Math.abs(station.lx * station.tx + station.ly * station.ty) < legTurn;
      let left: Hit | undefined;
      let right: Hit | undefined;
      let side: 1 | -1 | undefined = runSide;
      if (!turned) {
        if (runSide === undefined) {
          const leftNearest = nearestBoundary(cast(station, own, 1, minWidth, maxWidth));
          const rightNearest = nearestBoundary(cast(station, own, -1, minWidth, maxWidth));
          left = leftNearest?.via === "curb" ? leftNearest : undefined;
          right = rightNearest?.via === "curb" ? rightNearest : undefined;
          if (left && right) side = left.distance <= right.distance ? 1 : -1;
          else if (left) side = 1;
          else if (right) side = -1;
          hit = side === 1 ? left : side === -1 ? right : undefined;
        } else {
          hit = nearestBoundary(cast(station, own, runSide, minWidth, maxWidth));
          if (runSide === 1) left = hit;
          else right = hit;
        }
      }
      let decision: Extract<RoadTraceEvent, { kind: "station" }>["decision"] = hit
        ? "match"
        : "no-hit";
      if (hit && lastMatched) {
        const jumped = Math.abs(hit.distance - lastMatched.distance) > maxJump;
        const backward =
          (hit.x - lastMatched.x) * station.tx + (hit.y - lastMatched.y) * station.ty < 0;
        if (jumped) decision = "skip-jumped";
        else if (backward) decision = "skip-backward";
        if (jumped || backward) hit = undefined;
      }
      const throughHouse =
        hit !== undefined &&
        occupied !== undefined &&
        corridorSamples.some((ratio) =>
          occupied(
            station.x + (hit!.x - station.x) * ratio,
            station.y + (hit!.y - station.y) * ratio,
          ),
        );
      if (throughHouse) decision = "occupied";
      trace?.({
        kind: "station",
        chain: own,
        at: { x: station.x, y: station.y, z: 0 },
        tangent: [station.tx, station.ty],
        turned,
        ...(left ? { left: [left.distance, left.chain] as [number, number] } : {}),
        ...(right ? { right: [right.distance, right.chain] as [number, number] } : {}),
        decision,
      });
      if (throughHouse) {
        close("occupied", station);
        continue;
      }

      if (!hit) {
        if (!current || !lastStation) continue;
        if (Math.hypot(station.x - lastStation.x, station.y - lastStation.y) > maxUnmatched) {
          close("no-b-too-long", station);
          continue;
        }
        current.a.push({ x: station.x, y: station.y, z: 0 });
        current.hits.push(undefined);
        continue;
      }

      if (
        current &&
        lastStation &&
        Math.hypot(station.x - lastStation.x, station.y - lastStation.y) > maxUnmatched
      ) {
        // Между двумя попаданиями кромки B не было дольше размера угла - разрыв
        close("no-b-too-long", station);
      }
      if (!current) {
        current = { a: [], hits: [] };
        runSide = side;
      }
      current.a.push({ x: station.x, y: station.y, z: 0 });
      current.hits.push(hit);
      lastMatched = hit;
      lastStation = station;
    }
    close();
  });

  const kept: Array<{ points: CadPoint[]; lengthUnits: number; widthUnits: number }> = [];
  for (const run of runs.sort((a, b) => polylineLength(b.a) - polylineLength(a.a))) {
    const matched = run.hits.filter((hit): hit is Hit => hit !== undefined);
    const lengthUnits = polylineLength(run.a);
    const widthUnits = matched.map((hit) => hit.distance).sort((a, b) => a - b)[
      matched.length >> 1
    ];
    const at = run.a[0];
    const report = (reason: Extract<RoadTraceEvent, { kind: "drop" }>["reason"]) =>
      trace?.({
        kind: "drop",
        reason,
        lengthMeters: lengthUnits / scale,
        widthMeters: widthUnits / scale,
        at,
      });
    if (lengthUnits < minLength) {
      report("too-short");
      continue;
    }
    if (lengthUnits < widthUnits * resolved.minLengthToWidthRatio) {
      report("too-square");
      continue;
    }
    const side = facingSide(targets, matched, scale);
    const points = [...run.a, ...[...side].reverse()];
    if (!Math.abs(polygonArea(points))) {
      report("no-area");
      continue;
    }
    const axis = run.a.flatMap((a, index) => {
      const hit = run.hits[index];
      return hit ? [{ x: (a.x + hit.x) / 2, y: (a.y + hit.y) / 2 }] : [];
    });
    const duplicate = kept.some(
      (other) =>
        axis.reduce((count, point) => count + (pointInPolygon(point, other.points) ? 1 : 0), 0) >=
        axis.length * 0.6,
    );
    if (duplicate) {
      report("duplicate");
      continue;
    }
    trace?.({
      kind: "keep",
      lengthMeters: lengthUnits / scale,
      widthMeters: widthUnits / scale,
      at,
    });
    kept.push({ points, lengthUnits, widthUnits });
  }

  return kept.map(
    ({ points, lengthUnits, widthUnits }, index): CadFeature => ({
      id: `road-surface-${index + 1}`,
      sourceType: ROAD_SURFACE_SOURCE_TYPE,
      layer: "AEDEXA · полотно проезда",
      kind: "road",
      confidence: 0.7,
      reason: `выведено по вершинам двух начерченных кромок, ширина ${(widthUnits / scale).toFixed(1)} м, длина ${(lengthUnits / scale).toFixed(0)} м; въезды — как начерчены, разрывы кромок не заполнялись`,
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
    }),
  );
}
