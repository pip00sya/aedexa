import Delaunator from "delaunator";
import { pointInPolygon, polygonArea, polygonPerimeter } from "../geometry";
import type { PlacementPoint, PlacementPolygon, PlacementRelief } from "./types";

export type ParcelTin = {
  /** Вершины x, y, z подряд, в метрах, в системе участка */
  positions: Float64Array;
  /** Индексы вершин по три на треугольник */
  indices: Uint32Array;
  minZ: number;
  maxZ: number;
  /** Высота в точке или null, если точка не накрыта поверхностью */
  sample: (point: PlacementPoint) => number | null;
};

export type ParcelTerrainStats = {
  minZ: number;
  maxZ: number;
  drop: number;
  slopePercent: number;
  contourCount: number;
  markCount: number;
};

/** Шаг, с которым досаживаются точки вдоль горизонтали и вдоль границы */
const STEP = 2.5;

const MIN_HEIGHT = 0.35;

export function buildParcelTin(
  parcel: PlacementPolygon,
  relief: PlacementRelief | undefined,
): ParcelTin | null {
  if (!relief || parcel.length < 3) return null;

  const enough = relief.contours.length >= 2 || relief.marks.length >= 8;
  if (!enough) return null;

  const sparse = relief.contours.length < 2;
  const tightEdge = Math.max(
    6,
    Math.min(sparse ? 60 : 28, Math.sqrt(Math.max(polygonArea(parcel), 1)) / (sparse ? 1.1 : 2.5)),
  );
  const looseEdge = Math.max(
    tightEdge,
    Math.min(80, Math.sqrt(Math.max(polygonArea(parcel), 1)) * 2),
  );
  for (const maxEdge of tightEdge < looseEdge ? [tightEdge, looseEdge] : [tightEdge]) {
    const tin = triangulateParcel(parcel, relief, maxEdge);
    if (tin) return tin;
  }
  return null;
}

function triangulateParcel(
  parcel: PlacementPolygon,
  relief: PlacementRelief,
  maxEdge: number,
): ParcelTin | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];

  for (const contour of relief.contours) {
    for (const point of resample(contour.points, STEP)) {
      xs.push(point.x);
      ys.push(point.y);
      zs.push(contour.z);
    }
  }
  for (const mark of relief.marks) {
    xs.push(mark.x);
    ys.push(mark.y);
    zs.push(mark.z);
  }
  if (xs.length < 8) return null;

  const first = triangulate(xs, ys, maxEdge, () => true);
  if (!first.length) return null;
  const probe = makeSampler(xs, ys, zs, first);

  for (const point of resample([...parcel, parcel[0]], STEP)) {
    const z = probe(point);
    if (z === null) continue;
    xs.push(point.x);
    ys.push(point.y);
    zs.push(z);
  }

  // Второй проход - с посаженной границей и обрезкой по участку
  const kept = triangulate(xs, ys, maxEdge, (ax, ay, bx, by, cx, cy) =>
    pointInPolygon({ x: (ax + bx + cx) / 3, y: (ay + by + cy) / 3 }, parcel),
  );
  if (kept.length < 3) return null;

  const remap = new Map<number, number>();
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const indices = new Uint32Array(kept.length);
  for (let i = 0; i < kept.length; i += 1) {
    const source = kept[i];
    let target = remap.get(source);
    if (target === undefined) {
      target = px.length;
      remap.set(source, target);
      px.push(xs[source]);
      py.push(ys[source]);
      pz.push(zs[source]);
    }
    indices[i] = target;
  }

  const positions = new Float64Array(px.length * 3);
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < px.length; i += 1) {
    positions[i * 3] = px[i];
    positions[i * 3 + 1] = py[i];
    positions[i * 3 + 2] = pz[i];
    if (pz[i] < minZ) minZ = pz[i];
    if (pz[i] > maxZ) maxZ = pz[i];
  }

  return { positions, indices, minZ, maxZ, sample: makeSampler(px, py, pz, indices) };
}

export function parcelTerrainStats(
  tin: ParcelTin,
  parcel: PlacementPolygon,
  relief: PlacementRelief,
): ParcelTerrainStats {
  const drop = tin.maxZ - tin.minZ;
  const span = Math.max(
    Math.sqrt(Math.max(polygonArea(parcel), 1)),
    polygonPerimeter(parcel) / 4,
    1,
  );
  return {
    minZ: tin.minZ,
    maxZ: tin.maxZ,
    drop,
    slopePercent: (drop / span) * 100,
    // Горизонталь в чертеже часто разбита на куски: считаем уровни высот
    contourCount: new Set(relief.contours.map((contour) => Math.round(contour.z * 100))).size,
    markCount: relief.marks.length,
  };
}

function triangulate(
  xs: number[],
  ys: number[],
  maxEdge: number,
  keepTriangle: (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => boolean,
): number[] {
  const coords = new Float64Array(xs.length * 2);
  for (let i = 0; i < xs.length; i += 1) {
    coords[i * 2] = xs[i];
    coords[i * 2 + 1] = ys[i];
  }

  const triangles = new Delaunator(coords).triangles;
  const keep: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    const longest = Math.max(
      Math.hypot(xs[a] - xs[b], ys[a] - ys[b]),
      Math.hypot(xs[b] - xs[c], ys[b] - ys[c]),
      Math.hypot(xs[c] - xs[a], ys[c] - ys[a]),
    );
    if (longest > maxEdge) continue;
    const twiceArea = Math.abs(
      (xs[b] - xs[a]) * (ys[c] - ys[a]) - (xs[c] - xs[a]) * (ys[b] - ys[a]),
    );
    if (twiceArea / longest < MIN_HEIGHT) continue;
    if (!keepTriangle(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c])) continue;
    keep.push(a, b, c);
  }
  return keep;
}

function makeSampler(xs: number[], ys: number[], zs: number[], indices: ArrayLike<number>) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < xs.length; i += 1) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }

  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);
  const cells = Math.max(1, Math.min(96, Math.round(Math.sqrt(indices.length / 3) / 1.5)));
  const stepX = width / cells;
  const stepY = height / cells;
  const cellOf = (value: number, min: number, step: number) =>
    Math.min(cells - 1, Math.max(0, Math.floor((value - min) / step)));

  const grid: number[][] = Array.from({ length: cells * cells }, () => []);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    const cx0 = cellOf(Math.min(xs[a], xs[b], xs[c]), minX, stepX);
    const cx1 = cellOf(Math.max(xs[a], xs[b], xs[c]), minX, stepX);
    const cy0 = cellOf(Math.min(ys[a], ys[b], ys[c]), minY, stepY);
    const cy1 = cellOf(Math.max(ys[a], ys[b], ys[c]), minY, stepY);
    for (let cy = cy0; cy <= cy1; cy += 1) {
      for (let cx = cx0; cx <= cx1; cx += 1) grid[cy * cells + cx].push(i);
    }
  }

  return (point: PlacementPoint): number | null => {
    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) return null;
    const cell = grid[cellOf(point.y, minY, stepY) * cells + cellOf(point.x, minX, stepX)];
    for (const i of cell) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      const denominator = (ys[b] - ys[c]) * (xs[a] - xs[c]) + (xs[c] - xs[b]) * (ys[a] - ys[c]);
      if (Math.abs(denominator) < 1e-12) continue;
      const w1 =
        ((ys[b] - ys[c]) * (point.x - xs[c]) + (xs[c] - xs[b]) * (point.y - ys[c])) / denominator;
      const w2 =
        ((ys[c] - ys[a]) * (point.x - xs[c]) + (xs[a] - xs[c]) * (point.y - ys[c])) / denominator;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
      return w1 * zs[a] + w2 * zs[b] + w3 * zs[c];
    }
    return null;
  };
}

/** Досаживает точки вдоль ломаной, чтобы триангуляция не была рваной */
function resample(points: readonly PlacementPoint[], step: number): PlacementPoint[] {
  if (points.length < 2) return [...points];
  const out: PlacementPoint[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const parts = Math.floor(length / step);
    for (let k = 1; k <= parts; k += 1) {
      const t = (k * step) / length;
      if (t >= 1) break;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    out.push(b);
  }
  return out;
}
