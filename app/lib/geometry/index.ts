export type XY = { x: number; y: number };
export type XYBounds = { x: number; y: number; width: number; height: number };

const EPSILON = 1e-8;

export function signedArea(points: readonly XY[]) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

export function polygonArea(points: readonly XY[]) {
  if (points.length < 3) return 0;
  return Math.abs(signedArea(points));
}

export function isSimplePolygon(points: readonly XY[]) {
  if (
    points.length < 3 ||
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)) ||
    polygonArea(points) <= EPSILON
  )
    return false;
  for (let i = 0; i < points.length; i += 1) {
    const next = (i + 1) % points.length;
    if (Math.hypot(points[i].x - points[next].x, points[i].y - points[next].y) <= EPSILON)
      return false;
    for (let j = i + 1; j < points.length; j += 1) {
      if (j === next || (j + 1) % points.length === i) continue;
      if (segmentsIntersect(points[i], points[next], points[j], points[(j + 1) % points.length]))
        return false;
    }
  }
  return true;
}

export function polygonBounds(points: readonly XY[]): XYBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function pointInPolygon(point: XY, polygon: readonly XY[]) {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distancePointToSegment(point: XY, start: XY, end: XY) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

export function distanceToPolyline(point: XY, line: readonly XY[]) {
  if (!line.length) return Infinity;
  if (line.length === 1) return Math.hypot(point.x - line[0].x, point.y - line[0].y);
  let best = Infinity;
  for (let index = 0; index < line.length - 1; index += 1) {
    const distance = distancePointToSegment(point, line[index], line[index + 1]);
    if (distance < best) best = distance;
  }
  return best;
}

function orientation(a: XY, b: XY, c: XY) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < EPSILON) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a: XY, b: XY, c: XY) {
  return (
    Math.min(a.x, c.x) - EPSILON <= b.x &&
    b.x <= Math.max(a.x, c.x) + EPSILON &&
    Math.min(a.y, c.y) - EPSILON <= b.y &&
    b.y <= Math.max(a.y, c.y) + EPSILON
  );
}

export function segmentsIntersect(a1: XY, a2: XY, b1: XY, b2: XY) {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

export function segmentToSegmentDistance(a1: XY, a2: XY, b1: XY, b2: XY) {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    distancePointToSegment(a1, b1, b2),
    distancePointToSegment(a2, b1, b2),
    distancePointToSegment(b1, a1, a2),
    distancePointToSegment(b2, a1, a2),
  );
}

export function polylineLength(points: readonly XY[]) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(
      points[index + 1].x - points[index].x,
      points[index + 1].y - points[index].y,
    );
  }
  return total;
}

export function rectToPolylineDistance(rect: XYBounds, line: readonly XY[]) {
  if (!line.length) return Infinity;
  const corners: XY[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  const inside = (point: XY) =>
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
  if (line.some(inside)) return 0;
  let best = Infinity;
  for (let index = 0; index < Math.max(1, line.length - 1); index += 1) {
    const start = line[index];
    const end = line[Math.min(index + 1, line.length - 1)];
    for (let corner = 0; corner < 4; corner += 1) {
      const a = corners[corner];
      const b = corners[(corner + 1) % 4];
      const distance = segmentToSegmentDistance(a, b, start, end);
      if (distance < best) best = distance;
      if (best === 0) return 0;
    }
  }
  return best;
}

export function segmentCapsule(start: XY, end: XY, radius: number, capSegments = 8): XY[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const angle = length < EPSILON ? 0 : Math.atan2(dy, dx);
  const points: XY[] = [];
  for (let index = 0; index <= capSegments; index += 1) {
    const theta = angle + Math.PI / 2 + (Math.PI * index) / capSegments;
    points.push({ x: start.x + Math.cos(theta) * radius, y: start.y + Math.sin(theta) * radius });
  }
  for (let index = 0; index <= capSegments; index += 1) {
    const theta = angle - Math.PI / 2 + (Math.PI * index) / capSegments;
    points.push({ x: end.x + Math.cos(theta) * radius, y: end.y + Math.sin(theta) * radius });
  }
  return points;
}

export function convexHull(points: readonly XY[]): XY[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: XY[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0)
      lower.pop();
    lower.push(point);
  }
  const upper: XY[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0)
      upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function polylineBufferOutlines(
  line: readonly XY[],
  radius: number,
  capSegments = 8,
): XY[][] {
  if (!line.length || radius <= 0) return [];
  if (line.length === 1) return [segmentCapsule(line[0], line[0], radius, capSegments)];
  const outlines: XY[][] = [];
  for (let index = 0; index < line.length - 1; index += 1) {
    outlines.push(segmentCapsule(line[index], line[index + 1], radius, capSegments));
  }
  return outlines;
}

/** Убирает подряд идущие точки, совпадающие с точностью до допуска */
export function dedupePoints(points: readonly XY[], tolerance = 1e-6): XY[] {
  const out: XY[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < tolerance) continue;
    out.push(point);
  }
  return out;
}

/** Упрощение по Дугласу - Пекеру; концы ломаной остаются на месте */
export function simplifyPolyline(points: readonly XY[], tolerance: number): XY[] {
  if (points.length < 3 || tolerance <= 0) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const distance = distancePointToSegment(points[i], points[first], points[last]);
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

export function polygonPerimeter(points: readonly XY[]) {
  let length = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    length += Math.hypot(next.x - points[i].x, next.y - points[i].y);
  }
  return length;
}

/** Центр тяжести площади; у вырожденного контура - центр габаритов */
export function polygonCentroid(ring: readonly XY[]): XY {
  const area = signedArea(ring);
  if (Math.abs(area) < 1e-9) {
    const box = polygonBounds(ring);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export type XYRect = XY & { width: number; height: number };
export function rectCorners(rect: XYRect) {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}
export function rectIntersects(a: XYRect, b: XYRect) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}
