import type { XY } from "./index";
export type Station = XY & { tx: number; ty: number; run: number };
const minRunAlignment = Math.cos((25 * Math.PI) / 180);
export function splitRuns<T extends XY>(points: T[]): T[][] {
  if (points.length < 2) return [];
  const runs: T[][] = [];
  let current: T[] = [points[0]];
  let previous: { ux: number; uy: number } | undefined;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    const direction = { ux: (b.x - a.x) / length, uy: (b.y - a.y) / length };
    if (previous && previous.ux * direction.ux + previous.uy * direction.uy < minRunAlignment) {
      if (current.length >= 2) runs.push(current);
      current = [a];
    }
    current.push(b);
    previous = direction;
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}
export function stationsAlong(points: XY[], stepUnits: number, run: number): Station[] {
  const stations: Station[] = [];
  let carry = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    const tx = (b.x - a.x) / length;
    const ty = (b.y - a.y) / length;
    let along = carry;
    while (along <= length) {
      stations.push({ x: a.x + tx * along, y: a.y + ty * along, tx, ty, run });
      along += stepUnits;
    }
    carry = along - length;
  }
  return stations;
}
