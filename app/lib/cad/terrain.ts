import Delaunator from "delaunator";
import { pointInPolygon, polygonArea } from "../geometry";
import { median, percentile } from "../math/statistics";
import { isElevationLayer } from "./classification";
import { auditPlacedCadFeature } from "./objectRules";
import type { CadBounds, CadFeature, CadPoint, CadTerrainGrid } from "./types";

const MAX_TIN_POINTS = 12_000;
const TRIANGLE_INDEX_SIZE = 72;
const MAX_GROUND_SLOPE = 0.45;

type TerrainSample = CadPoint & {
  certainty: "geometry" | "interpreted";
  priority: number;
};

export function parseElevationLabel(value: string) {
  const normalized = value
    .replace(/\\[A-Za-z][^;]*;/gu, "")
    .replace(/[{}]/gu, "")
    .trim()
    .replace(",", ".");
  if (!/^[+-]?\d{1,4}(?:\.\d{1,3})?$/u.test(normalized)) return undefined;
  const elevation = Number(normalized);
  return Number.isFinite(elevation) && elevation > -500 && elevation < 9_000
    ? elevation
    : undefined;
}

function pointBounds(points: CadPoint[]): CadBounds {
  if (!points.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  return points.reduce<CadBounds>(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      maxX: Math.max(bounds.maxX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxY: Math.max(bounds.maxY, point.y),
      minZ: Math.min(bounds.minZ, point.z),
      maxZ: Math.max(bounds.maxZ, point.z),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );
}

function distanceToPolyline(point: CadPoint, line: CadPoint[]) {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < line.length - 1; index += 1) {
    const a = line[index];
    const b = line[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio =
      lengthSquared > 0
        ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
        : 0;
    nearest = Math.min(
      nearest,
      Math.hypot(point.x - (a.x + ratio * dx), point.y - (a.y + ratio * dy)),
    );
  }
  return nearest;
}

function samplePolyline(points: CadPoint[], spacing: number) {
  if (points.length < 2) return points;
  const sampled: CadPoint[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.min(128, Math.ceil(length / spacing)));
    for (let step = 0; step < steps; step += 1) {
      const ratio = step / steps;
      sampled.push({
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
        z: 0,
      });
    }
  }
  sampled.push({ ...points[points.length - 1] });
  return sampled;
}

export function orientTerrainTriangles(
  vertices: Array<Pick<CadPoint, "x" | "y">>,
  triangles: number[],
  winding: "ccw" | "cw" = "ccw",
) {
  const oriented = [...triangles];
  for (let index = 0; index < oriented.length; index += 3) {
    const a = vertices[oriented[index]];
    const b = vertices[oriented[index + 1]];
    const c = vertices[oriented[index + 2]];
    if (!a || !b || !c) continue;
    const signedArea2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const shouldFlip = winding === "ccw" ? signedArea2 < 0 : signedArea2 > 0;
    if (shouldFlip)
      [oriented[index + 1], oriented[index + 2]] = [oriented[index + 2], oriented[index + 1]];
  }
  return oriented;
}

function collectTerrainEvidence(features: CadFeature[], annotationUnitsPerMeter = 1) {
  const geometry: TerrainSample[] = [];
  const interpreted: TerrainSample[] = [];
  const elevationLabels = new Map<string, TerrainSample[]>();
  const flattenedContours: CadFeature[] = [];
  let structuralLineCount = 0;

  for (const feature of features) {
    const type = feature.sourceType.toUpperCase();
    const terrainLayer = feature.kind === "terrain" || isElevationLayer(feature.layer);
    const annotation = /^(TEXT|MTEXT|ATTRIB|DIMENSION)$/u.test(type);

    if (annotation) {
      if (!feature.text || !feature.points[0]) continue;
      const elevation = parseElevationLabel(feature.text);
      if (elevation === undefined) continue;
      interpreted.push({
        x: feature.points[0].x,
        y: feature.points[0].y,
        z: elevation * annotationUnitsPerMeter,
        zExplicit: false,
        certainty: "interpreted",
        priority: 1,
      });
      const labels = elevationLabels.get(feature.layer);
      if (labels) labels.push(interpreted[interpreted.length - 1]);
      else elevationLabels.set(feature.layer, [interpreted[interpreted.length - 1]]);
      continue;
    }

    if (!terrainLayer && type !== "POINT") continue;
    const acceptsGeometryZ =
      /^(POINT|LINE|LWPOLYLINE|POLYLINE2D|POLYLINE3D|SPLINE|3DFACE|SOLID|TRACE)$/u.test(type);
    if (!acceptsGeometryZ) continue;
    const trusted = feature.points.filter(
      (point) =>
        point.zExplicit &&
        Number.isFinite(point.z) &&
        (Math.abs(point.z) > 1e-9 || /^(POLYLINE3D|3DFACE)$/u.test(type)),
    );
    if (!trusted.length) {
      if (
        terrainLayer &&
        feature.points.length > 1 &&
        /^(LINE|LWPOLYLINE|POLYLINE2D|SPLINE)$/u.test(type)
      ) {
        flattenedContours.push(feature);
      }
      continue;
    }
    if (trusted.length > 1) structuralLineCount += 1;
    const priority = /^(POINT|POLYLINE3D|3DFACE)$/u.test(type) ? 4 : 3;
    for (const point of trusted) {
      geometry.push({ ...point, certainty: "geometry", priority });
    }
  }

  const reconstructed: TerrainSample[] = [];
  const matchedLabels = new Set<TerrainSample>();
  const labelReach = Math.max(annotationUnitsPerMeter * 8, 1e-6);
  const contourSpacing = Math.max(annotationUnitsPerMeter * 3, 1e-6);
  for (const contour of flattenedContours) {
    const labels = elevationLabels.get(contour.layer);
    if (!labels?.length) continue;
    let nearest: TerrainSample | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const label of labels) {
      const distance = distanceToPolyline(label, contour.points);
      if (distance < nearestDistance) {
        nearest = label;
        nearestDistance = distance;
      }
    }
    if (!nearest || nearestDistance > labelReach) continue;
    matchedLabels.add(nearest);
    structuralLineCount += 1;
    for (const point of samplePolyline(contour.points, contourSpacing)) {
      reconstructed.push({
        x: point.x,
        y: point.y,
        z: nearest.z,
        zExplicit: false,
        certainty: "interpreted",
        priority: 2,
      });
    }
  }

  const unmatchedLabels = interpreted.filter((label) => !matchedLabels.has(label));

  const geometryBounds = pointBounds(geometry);
  const geometryRange = geometry.length ? geometryBounds.maxZ - geometryBounds.minZ : 0;
  const sourceSampleCount = geometry.length + interpreted.length + reconstructed.length;

  if (geometry.length >= 3 && geometryRange >= 0.02) {
    const min = geometryBounds.minZ;
    const max = geometryBounds.maxZ;
    const padding = Math.max(10, (max - min) * 0.5);
    return {
      samples: [
        ...geometry,
        ...unmatchedLabels.filter((point) => point.z >= min - padding && point.z <= max + padding),
        ...reconstructed.filter((point) => point.z >= min - padding && point.z <= max + padding),
      ],
      sourceSampleCount,
      structuralLineCount,
    };
  }

  return {
    samples: [...unmatchedLabels, ...reconstructed],
    sourceSampleCount,
    structuralLineCount,
  };
}

function deduplicateSamples(samples: TerrainSample[]) {
  if (!samples.length) return { points: [] as TerrainSample[], conflictingPointCount: 0 };
  const bounds = pointBounds(samples);
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
  const tolerance = Math.max(span * 1e-9, 1e-4);
  const buckets = new Map<string, TerrainSample[]>();
  for (const sample of samples) {
    const key = `${Math.round(sample.x / tolerance)}:${Math.round(sample.y / tolerance)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(sample);
    else buckets.set(key, [sample]);
  }

  let conflictingPointCount = 0;
  const points: TerrainSample[] = [];
  for (const bucket of buckets.values()) {
    const elevationBounds = pointBounds(bucket);
    if (elevationBounds.maxZ - elevationBounds.minZ > 0.05) conflictingPointCount += 1;
    let priority = 0;
    for (const point of bucket) priority = Math.max(priority, point.priority);
    const preferred = bucket.filter((point) => point.priority === priority);
    const certainty = preferred.some((point) => point.certainty === "geometry")
      ? "geometry"
      : "interpreted";
    points.push({
      x: median(preferred.map((point) => point.x)),
      y: median(preferred.map((point) => point.y)),
      z: median(preferred.map((point) => point.z)),
      zExplicit: certainty === "geometry",
      certainty,
      priority,
    });
  }
  return { points, conflictingPointCount };
}

function rejectElevationOutliers(points: TerrainSample[]) {
  if (points.length < 8) return points;
  const center = median(points.map((point) => point.z));
  const deviations = points.map((point) => Math.abs(point.z - center));
  const mad = median(deviations);
  const limit = mad > 1e-9 ? Math.max(8 * mad, 5) : 5;
  const filtered = points.filter((point) => Math.abs(point.z - center) <= limit);
  return filtered.length >= 3 ? filtered : points;
}

function spatiallyReduce(points: TerrainSample[]): TerrainSample[] {
  if (points.length <= MAX_TIN_POINTS) return points;
  const bounds = pointBounds(points);
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const aspect = Math.max(0.05, Math.min(20, spanX / spanY));
  const columns = Math.max(8, Math.round(Math.sqrt(MAX_TIN_POINTS * aspect)));
  const rows = Math.max(8, Math.round(MAX_TIN_POINTS / columns));
  const cells = new Map<string, TerrainSample[]>();
  for (const point of points) {
    const column = Math.min(
      columns - 1,
      Math.max(0, Math.floor(((point.x - bounds.minX) / spanX) * columns)),
    );
    const row = Math.min(
      rows - 1,
      Math.max(0, Math.floor(((point.y - bounds.minY) / spanY) * rows)),
    );
    const key = `${column}:${row}`;
    const current = cells.get(key);
    if (current) current.push(point);
    else cells.set(key, [point]);
  }
  return [...cells.values()].slice(0, MAX_TIN_POINTS).map((cell) => {
    const priority = Math.max(...cell.map((point) => point.priority));
    const preferred = cell.filter((point) => point.priority === priority);
    const certainty = preferred.some((point) => point.certainty === "geometry")
      ? "geometry"
      : "interpreted";
    return {
      x: median(preferred.map((point) => point.x)),
      y: median(preferred.map((point) => point.y)),
      z: median(preferred.map((point) => point.z)),
      zExplicit: certainty === "geometry",
      certainty,
      priority,
    };
  });
}

function convexHull(points: CadPoint[]) {
  const sorted = [
    ...new Map(
      points
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map((point) => [`${point.x}:${point.y}`, point] as const),
    ).values(),
  ].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 2) return sorted;
  const cross = (a: CadPoint, b: CadPoint, c: CadPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (values: CadPoint[]) => {
    const hull: CadPoint[] = [];
    for (const point of values) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0)
        hull.pop();
      hull.push(point);
    }
    return hull;
  };
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)];
}

function findOuterBoundary(features: CadFeature[], samples: CadPoint[]) {
  if (!samples.length) return undefined;
  const candidates = features
    .filter(
      (feature) => feature.kind === "boundary" && feature.closed && feature.points.length >= 3,
    )
    .map((feature) => ({ points: feature.points, area: polygonArea(feature.points) }))
    .filter((candidate) => candidate.area > 0)
    .sort((a, b) => b.area - a.area);
  return candidates.find((candidate) => {
    const inside = samples.filter((sample) => pointInPolygon(sample, candidate.points)).length;
    return inside / samples.length >= 0.8;
  })?.points;
}

function findTerrainCoverageBoundary(features: CadFeature[], samples: CadPoint[]) {
  const explicit = findOuterBoundary(features, samples);
  if (explicit) return explicit;

  const footprint: CadPoint[] = [];
  for (const feature of features) {
    if (!(feature.kind === "terrain" || isElevationLayer(feature.layer))) continue;
    const type = feature.sourceType.toUpperCase();
    if (/^(TEXT|MTEXT|ATTRIB|DIMENSION|POINT|INSERT)$/u.test(type) || feature.points.length < 2)
      continue;
    const stride = Math.max(1, Math.ceil(feature.points.length / 8));
    for (let index = 0; index < feature.points.length; index += stride)
      footprint.push(feature.points[index]);
  }
  const hull = convexHull(footprint);
  return hull.length >= 3 ? hull : undefined;
}

function interpolateBoundaryHeight(point: CadPoint, samples: TerrainSample[]) {
  const nearest = samples
    .map((sample) => ({
      sample,
      distanceSquared: (sample.x - point.x) ** 2 + (sample.y - point.y) ** 2,
    }))
    .sort((a, b) => a.distanceSquared - b.distanceSquared)
    .slice(0, 12);
  if (!nearest.length) return 0;
  if (nearest[0].distanceSquared <= 1e-12) return nearest[0].sample.z;
  let weighted = 0;
  let weights = 0;
  for (const value of nearest) {
    const weight = 1 / Math.max(Math.sqrt(value.distanceSquared), 1e-6);
    weighted += value.sample.z * weight;
    weights += weight;
  }
  return weighted / weights;
}

function buildBoundaryAnchors(
  boundary: CadPoint[] | undefined,
  samples: TerrainSample[],
  spacing: number,
) {
  if (!boundary?.length || samples.length < 3) return [] as TerrainSample[];
  const closed = [...boundary, boundary[0]];
  const points = samplePolyline(closed, spacing).slice(0, -1);
  const elevations = points.map((point) => interpolateBoundaryHeight(point, samples));
  return points.map((point, index) => ({
    x: point.x,
    y: point.y,
    z: [-2, -1, 0, 1, 2].reduce(
      (sum, offset) =>
        sum + elevations[(index + offset + elevations.length) % elevations.length] / 5,
      0,
    ),
    zExplicit: false,
    certainty: "interpreted" as const,
    priority: 0,
  }));
}

function triangleArea(a: CadPoint, b: CadPoint, c: CadPoint) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
}

function edgeLength(a: CadPoint, b: CadPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function countTerrainPatches(triangles: number[]) {
  if (!triangles.length) return 0;

  let highestVertex = 0;
  for (const vertex of triangles) highestVertex = Math.max(highestVertex, vertex);

  const parents = new Int32Array(highestVertex + 1);
  const ranks = new Uint8Array(highestVertex + 1);
  const used = new Uint8Array(highestVertex + 1);
  for (let vertex = 0; vertex <= highestVertex; vertex += 1) parents[vertex] = vertex;

  const find = (vertex: number) => {
    let root = vertex;
    while (parents[root] !== root) root = parents[root];
    while (parents[vertex] !== vertex) {
      const parent = parents[vertex];
      parents[vertex] = root;
      vertex = parent;
    }
    return root;
  };

  const join = (a: number, b: number) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;
    if (ranks[rootA] < ranks[rootB]) [rootA, rootB] = [rootB, rootA];
    parents[rootB] = rootA;
    if (ranks[rootA] === ranks[rootB]) ranks[rootA] += 1;
  };

  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index];
    const b = triangles[index + 1];
    const c = triangles[index + 2];
    used[a] = 1;
    used[b] = 1;
    used[c] = 1;
    join(a, b);
    join(b, c);
  }

  const roots = new Set<number>();
  for (let vertex = 0; vertex <= highestVertex; vertex += 1) {
    if (used[vertex]) roots.add(find(vertex));
  }
  return roots.size;
}

function buildLocalTin(vertices: TerrainSample[], boundary?: CadPoint[], structuralLineCount = 0) {
  const empty = {
    triangles: [] as number[],
    coverageRatio: 0,
    rejectedGapTriangleCount: 0,
    rejectedSlopeTriangleCount: 0,
    patchCount: 0,
  };
  if (vertices.length < 3) return empty;

  let raw: number[];
  try {
    raw = Array.from(
      Delaunator.from(
        vertices,
        (point) => point.x,
        (point) => point.y,
      ).triangles,
    );
  } catch {
    return empty;
  }

  const incidentLengths = Array.from({ length: vertices.length }, () => [] as number[]);
  const rawEdgeLengths: number[] = [];
  let rawArea = 0;
  for (let index = 0; index < raw.length; index += 3) {
    const indices = [raw[index], raw[index + 1], raw[index + 2]];
    const points = indices.map((value) => vertices[value]);
    if (points.some((point) => !point)) continue;
    rawArea += triangleArea(points[0], points[1], points[2]);
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ]) {
      const length = edgeLength(points[a], points[b]);
      rawEdgeLengths.push(length);
      incidentLengths[indices[a]].push(length);
      incidentLengths[indices[b]].push(length);
    }
  }

  const localScale = incidentLengths.map((lengths) =>
    median([...lengths].sort((a, b) => a - b).slice(0, 6)),
  );
  const positiveScales = localScale.filter((value) => value > 1e-9);
  const globalEdgeLimit = Math.max(
    percentile(positiveScales, 0.9) * 6,
    median(positiveScales) * 8,
    1e-6,
  );
  const structuredEdgeLimit = Math.max(
    percentile(rawEdgeLengths, 0.9) * 2.5,
    median(rawEdgeLengths) * 6,
    globalEdgeLimit,
  );
  const triangles: number[] = [];
  let keptArea = 0;
  let rejectedGapTriangleCount = 0;
  let rejectedSlopeTriangleCount = 0;

  for (let index = 0; index < raw.length; index += 3) {
    const indices = [raw[index], raw[index + 1], raw[index + 2]];
    const points = indices.map((value) => vertices[value]);
    if (points.some((point) => !point)) continue;
    const area = triangleArea(points[0], points[1], points[2]);
    if (area <= 1e-10) continue;
    if (boundary) {
      const center = {
        x: (points[0].x + points[1].x + points[2].x) / 3,
        y: (points[0].y + points[1].y + points[2].y) / 3,
        z: 0,
      };
      if (!pointInPolygon(center, boundary)) {
        rejectedGapTriangleCount += 1;
        continue;
      }
    }

    let gap = false;
    let steep = false;
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ]) {
      const length = edgeLength(points[a], points[b]);
      const localLimit = Math.max(localScale[indices[a]], localScale[indices[b]]) * 4.5;
      const edgeLimit = structuralLineCount
        ? structuredEdgeLimit
        : Math.min(localLimit || globalEdgeLimit, globalEdgeLimit);
      if (length <= 1e-9 || length > edgeLimit) gap = true;
      if (length > 1e-9 && Math.abs(points[a].z - points[b].z) / length > MAX_GROUND_SLOPE)
        steep = true;
    }
    if (gap) {
      rejectedGapTriangleCount += 1;
      continue;
    }
    if (steep) {
      rejectedSlopeTriangleCount += 1;
      continue;
    }
    triangles.push(...indices);
    keptArea += area;
  }

  return {
    triangles,
    coverageRatio: rawArea > 0 ? Math.min(1, keptArea / rawArea) : 0,
    rejectedGapTriangleCount,
    rejectedSlopeTriangleCount,
    patchCount: countTerrainPatches(triangles),
  };
}

function terrainQuality(input: {
  method: CadTerrainGrid["method"];
  sampleCount: number;
  sourceSampleCount: number;
  trustedSampleCount: number;
  structuralLineCount: number;
  coverageRatio: number;
  rejectedGapTriangleCount: number;
  rejectedSlopeTriangleCount: number;
  patchCount: number;
}) {
  const retainedSampleRatio = input.sourceSampleCount
    ? Math.min(1, input.sampleCount / input.sourceSampleCount)
    : 0;
  if (input.method === "none" || input.sampleCount < 3) {
    return {
      status: "insufficient" as const,
      score: 0,
      coverageRatio: input.coverageRatio,
      retainedSampleRatio,
      rejectedGapTriangleCount: input.rejectedGapTriangleCount,
      rejectedSlopeTriangleCount: input.rejectedSlopeTriangleCount,
      patchCount: input.patchCount,
    };
  }

  const sampleScore = Math.min(1, Math.log10(input.sampleCount + 1) / 2);
  const trustScore = input.trustedSampleCount / Math.max(1, input.sampleCount);
  const structureScore = input.structuralLineCount ? 1 : 0.7;
  const patchPenalty = Math.min(0.18, Math.max(0, input.patchCount - 1) * 0.03);
  const score = Math.max(
    0,
    Math.round(
      100 *
        (sampleScore * 0.35 +
          input.coverageRatio * 0.3 +
          trustScore * 0.2 +
          structureScore * 0.1 +
          retainedSampleRatio * 0.05 -
          patchPenalty),
    ),
  );
  const ready =
    score >= 70 &&
    input.sampleCount >= 12 &&
    input.coverageRatio >= 0.75 &&
    input.trustedSampleCount >= 3;
  return {
    status: ready ? ("ready" as const) : ("review" as const),
    score,
    coverageRatio: input.coverageRatio,
    retainedSampleRatio,
    rejectedGapTriangleCount: input.rejectedGapTriangleCount,
    rejectedSlopeTriangleCount: input.rejectedSlopeTriangleCount,
    patchCount: input.patchCount,
  };
}

export function buildTerrainModel(
  features: CadFeature[],
  annotationUnitsPerMeter = 1,
): CadTerrainGrid {
  const evidence = collectTerrainEvidence(features, annotationUnitsPerMeter);
  const deduplicated = deduplicateSamples(evidence.samples);
  const filtered = rejectElevationOutliers(deduplicated.points);
  const core = spatiallyReduce(filtered);
  const outerBoundary = findTerrainCoverageBoundary(features, core);
  const boundaryAnchors = buildBoundaryAnchors(
    outerBoundary,
    core,
    Math.max(annotationUnitsPerMeter * 4, 1e-6),
  );
  const reduced = spatiallyReduce([...core, ...boundaryAnchors]);
  const vertices = reduced.map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z,
    zExplicit: point.certainty === "geometry",
  }));
  const localTin = buildLocalTin(reduced, outerBoundary, evidence.structuralLineCount);
  const elevationBounds = pointBounds(vertices);
  const method: CadTerrainGrid["method"] = localTin.triangles.length ? "local-tin" : "none";
  const trustedSampleCount = vertices.filter((point) => point.zExplicit).length;
  const interpretedSampleCount = vertices.length - trustedSampleCount;
  const derivedBoundarySampleCount = reduced.filter((point) => point.priority === 0).length;
  const rejectedSampleCount = Math.max(
    0,
    evidence.sourceSampleCount - (vertices.length - derivedBoundarySampleCount),
  );

  return {
    vertices,
    triangles: localTin.triangles,
    sampleCount: vertices.length,
    minElevation: vertices.length ? elevationBounds.minZ : 0,
    maxElevation: vertices.length ? elevationBounds.maxZ : 0,
    sourceSampleCount: evidence.sourceSampleCount,
    trustedSampleCount,
    interpretedSampleCount,
    derivedBoundarySampleCount,
    rejectedSampleCount,
    conflictingPointCount: deduplicated.conflictingPointCount,
    structuralLineCount: evidence.structuralLineCount,
    method,
    quality: terrainQuality({
      method,
      sampleCount: vertices.length,
      sourceSampleCount: evidence.sourceSampleCount,
      trustedSampleCount,
      structuralLineCount: evidence.structuralLineCount,
      coverageRatio: localTin.coverageRatio,
      rejectedGapTriangleCount: localTin.rejectedGapTriangleCount,
      rejectedSlopeTriangleCount: localTin.rejectedSlopeTriangleCount,
      patchCount: localTin.patchCount,
    }),
  };
}

export function createTerrainResolver(terrain: CadTerrainGrid) {
  if (!terrain.triangles.length) return () => undefined;
  const bounds = pointBounds(terrain.vertices);
  const columns = TRIANGLE_INDEX_SIZE;
  const rows = TRIANGLE_INDEX_SIZE;
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const triangleCells = new Map<number, number[]>();
  const cellFor = (x: number, y: number) => {
    const column = Math.min(
      columns - 1,
      Math.max(0, Math.floor(((x - bounds.minX) / spanX) * columns)),
    );
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((y - bounds.minY) / spanY) * rows)));
    return { column, row, key: row * columns + column };
  };

  for (let index = 0; index < terrain.triangles.length; index += 3) {
    const triangleIndex = index / 3;
    const points = [
      terrain.vertices[terrain.triangles[index]],
      terrain.vertices[terrain.triangles[index + 1]],
      terrain.vertices[terrain.triangles[index + 2]],
    ];
    const min = cellFor(
      Math.min(...points.map((point) => point.x)),
      Math.min(...points.map((point) => point.y)),
    );
    const max = cellFor(
      Math.max(...points.map((point) => point.x)),
      Math.max(...points.map((point) => point.y)),
    );
    for (let row = min.row; row <= max.row; row += 1) {
      for (let column = min.column; column <= max.column; column += 1) {
        const key = row * columns + column;
        const values = triangleCells.get(key);
        if (values) values.push(triangleIndex);
        else triangleCells.set(key, [triangleIndex]);
      }
    }
  }

  return (x: number, y: number) => {
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return undefined;
    for (const triangleIndex of triangleCells.get(cellFor(x, y).key) ?? []) {
      const offset = triangleIndex * 3;
      const a = terrain.vertices[terrain.triangles[offset]];
      const b = terrain.vertices[terrain.triangles[offset + 1]];
      const c = terrain.vertices[terrain.triangles[offset + 2]];
      const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
      if (Math.abs(denominator) < 1e-12) continue;
      const wa = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
      const wb = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
      const wc = 1 - wa - wb;
      if (wa >= -1e-8 && wb >= -1e-8 && wc >= -1e-8) return wa * a.z + wb * b.z + wc * c.z;
    }
    return undefined;
  };
}

export function placeFeaturesOnTerrain(features: CadFeature[], terrain: CadTerrainGrid) {
  const resolveTerrain = createTerrainResolver(terrain);
  const tolerance = Math.max((terrain.maxElevation - terrain.minElevation) * 2, 20);

  return features.map((feature) => {
    const explicit = feature.points.filter((point) => point.zExplicit && Number.isFinite(point.z));
    const explicitMedian = median(explicit.map((point) => point.z));
    if (feature.kind === "terrain" && explicit.length) {
      return auditPlacedCadFeature({
        ...feature,
        points: feature.points.map((point) => ({
          ...point,
          resolvedZ: point.zExplicit ? point.z : undefined,
        })),
        elevationMode: "terrain",
      });
    }
    const sourceElevationIsPlausible =
      explicit.length === feature.points.length &&
      (terrain.method === "none" ||
        (explicitMedian >= terrain.minElevation - tolerance &&
          explicitMedian <= terrain.maxElevation + tolerance));
    const coveragePoints = feature.points.flatMap((point, index) => {
      const next = feature.points[index + 1];
      return next
        ? [point, { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2, z: 0 }]
        : [point];
    });
    const coverageElevations = coveragePoints.map((point) => resolveTerrain(point.x, point.y));
    const fullyCovered = coverageElevations.every((value) => value !== undefined);
    const groundElevations = feature.points.map((point) => resolveTerrain(point.x, point.y));
    const resolvedGround = groundElevations.filter((value): value is number => value !== undefined);

    let elevationMode: NonNullable<CadFeature["elevationMode"]> = "unresolved";
    let baseElevation: number | undefined;
    const measuredThreeDimensionalGeometry = /^(POLYLINE3D|3DFACE)$/u.test(
      feature.sourceType.toUpperCase(),
    );
    const preserveMeasuredElevation =
      sourceElevationIsPlausible &&
      (feature.kind === "wire" || (feature.kind === "utility" && measuredThreeDimensionalGeometry));

    if (!fullyCovered) {
      elevationMode = "unresolved";
    } else if (
      feature.kind === "building" &&
      feature.closed &&
      resolvedGround.length === feature.points.length
    ) {
      elevationMode = "leveled";
      baseElevation = median(resolvedGround);
    } else if (preserveMeasuredElevation) {
      elevationMode = "absolute";
      baseElevation = explicitMedian;
    } else if (resolvedGround.length === feature.points.length && feature.points.length) {
      elevationMode = "draped";
      baseElevation = median(resolvedGround);
    }

    const points = feature.points.map((point, index) => {
      const resolvedZ =
        elevationMode === "absolute"
          ? point.zExplicit
            ? point.z
            : undefined
          : elevationMode === "leveled"
            ? baseElevation
            : elevationMode === "draped"
              ? groundElevations[index]
              : undefined;
      return { ...point, resolvedZ };
    });
    return auditPlacedCadFeature({ ...feature, points, elevationMode, baseElevation });
  });
}
