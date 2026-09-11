import { hex, shade } from "./render/color";
import type {
  ArchiveEntry,
  PlacementArchiveEntry,
  ReconstructionArchiveEntry,
  TopographyArchiveEntry,
} from "./archive";
import {
  cadPathWidthMeters,
  isCadFeatureRenderable,
  resolveCadObjectHeight,
} from "./cad/objectRules";
import { cadKindMeta, type CadFeature } from "./cad/types";
import { cadUnitsToMeters } from "./cad/units";

type Bounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};
type Project = (x: number, y: number, z: number) => [number, number];

const ISO_X = Math.cos(Math.PI / 6);
const ISO_Y = Math.sin(Math.PI / 6);
const BACKGROUND = "#f3f6fa";

function mix(from: [number, number, number], to: [number, number, number], t: number) {
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(from[0] + (to[0] - from[0]) * k)}, ${Math.round(from[1] + (to[1] - from[1]) * k)}, ${Math.round(from[2] + (to[2] - from[2]) * k)})`;
}

function buildingRoofColor(feature: Pick<CadFeature, "sourceColor">) {
  const source = feature.sourceColor;
  if (source === undefined || source < 0 || source > 0xffffff) return 0xb85c2d;
  const r = ((source >> 16) & 255) / 255;
  const g = ((source >> 8) & 255) / 255;
  const b = (source & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const saturation = Math.max(0.42, delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1)));
  const light = Math.min(0.74, lightness);
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = light - chroma / 2;
  const [cr, cg, cb] =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second];
  return (
    (Math.round((cr + base) * 255) << 16) |
    (Math.round((cg + base) * 255) << 8) |
    Math.round((cb + base) * 255)
  );
}

function isoProjector(
  bounds: Bounds,
  width: number,
  height: number,
): { project: Project; scale: number } {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const spanZ = Math.max(bounds.maxZ - bounds.minZ, 0);
  const isoWidth = (spanX + spanY) * ISO_X;
  const isoHeight = (spanX + spanY) * ISO_Y + spanZ;
  const scale = Math.min((width * 0.92) / isoWidth, (height * 0.84) / Math.max(isoHeight, 1e-9));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const originX = width / 2;
  const originY = height / 2 + (spanZ * scale) / 2;
  return {
    scale,
    project: (x, y, z) => [
      originX + (x - centerX - (y - centerY)) * ISO_X * scale,
      originY - (x - centerX + (y - centerY)) * ISO_Y * scale - (z - bounds.minZ) * scale,
    ],
  };
}

function polygon(ctx: CanvasRenderingContext2D, points: Array<[number, number]>) {
  ctx.beginPath();
  points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function polyline(ctx: CanvasRenderingContext2D, points: Array<[number, number]>) {
  ctx.beginPath();
  points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
}

function unitsPerMeter(unitLabel: string) {
  const metersPerUnit = cadUnitsToMeters(unitLabel);
  return Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? 1 / metersPerUnit : 1;
}

/** Изометрический кубоид: стены от дальних к ближним, затем верх */
function drawExtrusion(
  ctx: CanvasRenderingContext2D,
  project: Project,
  footprint: Array<{ x: number; y: number }>,
  base: number,
  top: number,
  wallColor: number,
  topColor: number,
) {
  const edges = footprint
    .map((point, index) => ({ from: point, to: footprint[(index + 1) % footprint.length] }))
    .sort(
      (left, right) =>
        right.from.x +
        right.from.y +
        right.to.x +
        right.to.y -
        (left.from.x + left.from.y + left.to.x + left.to.y),
    );
  for (const edge of edges) {
    const angle = Math.atan2(edge.to.y - edge.from.y, edge.to.x - edge.from.x);
    const light = 0.7 + 0.3 * ((Math.cos(angle - Math.PI * 0.75) + 1) / 2);
    polygon(ctx, [
      project(edge.from.x, edge.from.y, base),
      project(edge.to.x, edge.to.y, base),
      project(edge.to.x, edge.to.y, top),
      project(edge.from.x, edge.from.y, top),
    ]);
    ctx.fillStyle = hex(shade(wallColor, light));
    ctx.fill();
  }
  polygon(
    ctx,
    footprint.map((point) => project(point.x, point.y, top)),
  );
  ctx.fillStyle = hex(topColor);
  ctx.fill();
  ctx.strokeStyle = hex(shade(topColor, 0.7));
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

const featureLimits: Partial<Record<CadFeature["kind"], number>> = {
  building: 700,
  road: 1_800,
  site: 300,
  water: 400,
  fence: 900,
  boundary: 1_500,
  curb: 600,
  ditch: 400,
  utility: 400,
  vegetation: 1_400,
};

function drawTopography(
  ctx: CanvasRenderingContext2D,
  entry: TopographyArchiveEntry,
  width: number,
  height: number,
) {
  const result = entry.payload;
  const upm = unitsPerMeter(result.unitLabel);
  const terrain = result.terrain;
  const hasTin =
    terrain.method !== "none" && terrain.triangles.length >= 3 && terrain.vertices.length >= 3;
  const bounds: Bounds = hasTin
    ? terrain.vertices.reduce(
        (box, vertex) => ({
          minX: Math.min(box.minX, vertex.x),
          maxX: Math.max(box.maxX, vertex.x),
          minY: Math.min(box.minY, vertex.y),
          maxY: Math.max(box.maxY, vertex.y),
          minZ: Math.min(box.minZ, vertex.z),
          maxZ: Math.max(box.maxZ, vertex.z),
        }),
        {
          minX: Infinity,
          maxX: -Infinity,
          minY: Infinity,
          maxY: -Infinity,
          minZ: Infinity,
          maxZ: -Infinity,
        },
      )
    : { ...result.bounds, minZ: 0, maxZ: 0 };
  if (!Number.isFinite(bounds.minX) || bounds.maxX <= bounds.minX) return false;
  const { project, scale } = isoProjector(bounds, width, height);
  const groundZ = (feature: CadFeature, point: CadFeature["points"][number]) =>
    point.resolvedZ ?? feature.baseElevation ?? bounds.minZ;

  if (hasTin) {
    const zSpan = Math.max(bounds.maxZ - bounds.minZ, 1e-9);
    const low: [number, number, number] = [143, 106, 69];
    const high: [number, number, number] = [230, 217, 181];
    const faces: Array<{ depth: number; points: Array<[number, number]>; shadeValue: number }> = [];
    for (let index = 0; index + 2 < terrain.triangles.length; index += 3) {
      const a = terrain.vertices[terrain.triangles[index]];
      const b = terrain.vertices[terrain.triangles[index + 1]];
      const c = terrain.vertices[terrain.triangles[index + 2]];
      if (!a || !b || !c) continue;
      faces.push({
        depth: a.x + a.y + b.x + b.y + c.x + c.y,
        points: [project(a.x, a.y, a.z), project(b.x, b.y, b.z), project(c.x, c.y, c.z)],
        shadeValue: ((a.z + b.z + c.z) / 3 - bounds.minZ) / zSpan,
      });
    }
    faces.sort((left, right) => right.depth - left.depth);
    for (const face of faces) {
      polygon(ctx, face.points);
      ctx.fillStyle = mix(low, high, face.shadeValue);
      ctx.fill();
    }
  } else {
    polygon(ctx, [
      project(bounds.minX, bounds.minY, 0),
      project(bounds.maxX, bounds.minY, 0),
      project(bounds.maxX, bounds.maxY, 0),
      project(bounds.minX, bounds.maxY, 0),
    ]);
    ctx.fillStyle = "#e4dccb";
    ctx.fill();
  }

  const counts = new Map<CadFeature["kind"], number>();
  const picked: CadFeature[] = [];
  for (const feature of result.features) {
    const limit = featureLimits[feature.kind];
    if (!limit) continue;
    if (
      hasTin
        ? !isCadFeatureRenderable(feature)
        : feature.qaStatus === "REJECT" && feature.elevationMode !== "unresolved"
    )
      continue;
    const seen = counts.get(feature.kind) ?? 0;
    if (seen >= limit) continue;
    counts.set(feature.kind, seen + 1);
    picked.push(feature);
  }
  const order: Record<string, number> = {
    site: 0,
    water: 0,
    road: 1,
    boundary: 2,
    curb: 2,
    ditch: 2,
    utility: 2,
    fence: 3,
    building: 4,
    vegetation: 5,
  };
  picked.sort((left, right) => (order[left.kind] ?? 2) - (order[right.kind] ?? 2));
  const lineWidthPx = (meters: number, minimum: number) => Math.max(minimum, meters * upm * scale);

  for (const feature of picked) {
    const color = cadKindMeta[feature.kind].color;
    if (
      (feature.kind === "road" || feature.kind === "site" || feature.kind === "water") &&
      feature.closed &&
      feature.points.length >= 3
    ) {
      polygon(
        ctx,
        feature.points.map((point) => project(point.x, point.y, groundZ(feature, point))),
      );
      ctx.fillStyle = hex(color);
      ctx.globalAlpha = feature.kind === "water" ? 0.75 : 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    if (feature.kind === "building" && feature.closed && feature.points.length >= 3) {
      const base = feature.baseElevation ?? groundZ(feature, feature.points[0]);
      const heightMeters = resolveCadObjectHeight(feature).heightMeters ?? 3;
      drawExtrusion(
        ctx,
        project,
        feature.points,
        base,
        base + heightMeters * upm,
        cadKindMeta.building.color,
        buildingRoofColor(feature),
      );
      continue;
    }
    if (feature.kind === "vegetation") {
      const point = feature.points[0];
      if (!point) continue;
      const z = groundZ(feature, point);
      const heightMeters = resolveCadObjectHeight(feature).heightMeters ?? 3;
      const [x0, y0] = project(point.x, point.y, z);
      const [x1, y1] = project(point.x, point.y, z + heightMeters * upm);
      const crown = Math.max(1.4, heightMeters * upm * scale * 0.4);
      ctx.strokeStyle = "#7c4a24";
      ctx.lineWidth = Math.max(0.6, crown * 0.3);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1 + crown * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x1, y1, crown, 0, Math.PI * 2);
      ctx.fillStyle = "#22a447";
      ctx.fill();
      continue;
    }
    if (feature.points.length < 2) continue;
    const points = feature.points.map((point) =>
      project(point.x, point.y, groundZ(feature, point)),
    );
    if (feature.kind === "fence") {
      const heightPx = Math.max(
        1.2,
        (resolveCadObjectHeight(feature).heightMeters ?? 1.8) * upm * scale,
      );
      for (let index = 1; index < points.length; index += 1) {
        polygon(ctx, [
          points[index - 1],
          points[index],
          [points[index][0], points[index][1] - heightPx],
          [points[index - 1][0], points[index - 1][1] - heightPx],
        ]);
        ctx.fillStyle = "rgba(116, 123, 130, 0.75)";
        ctx.fill();
      }
      continue;
    }
    polyline(ctx, points);
    ctx.strokeStyle = hex(color);
    ctx.globalAlpha = feature.kind === "boundary" ? 0.55 : 0.9;
    ctx.lineWidth =
      feature.kind === "road"
        ? lineWidthPx(cadPathWidthMeters(feature), 0.9)
        : feature.kind === "boundary"
          ? 0.5
          : 0.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  return true;
}

function drawReconstruction(
  ctx: CanvasRenderingContext2D,
  entry: ReconstructionArchiveEntry,
  width: number,
  height: number,
) {
  const boxes = entry.payload.parts
    .map((part) => {
      if (part.kind === "mesh" && part.vertices.length) {
        const box = part.vertices.reduce(
          (current, vertex) => ({
            minX: Math.min(current.minX, vertex.x),
            maxX: Math.max(current.maxX, vertex.x),
            minY: Math.min(current.minY, vertex.y),
            maxY: Math.max(current.maxY, vertex.y),
            minZ: Math.min(current.minZ, vertex.z),
            maxZ: Math.max(current.maxZ, vertex.z),
          }),
          {
            minX: Infinity,
            maxX: -Infinity,
            minY: Infinity,
            maxY: -Infinity,
            minZ: Infinity,
            maxZ: -Infinity,
          },
        );
        return { ...box, color: part.color };
      }
      const sizeX = part.kind === "cylinder" ? part.radius * 2 : part.size.x;
      const sizeY = part.kind === "cylinder" ? part.radius * 2 : part.size.y;
      const sizeZ = part.kind === "cylinder" ? part.height : part.size.z;
      return {
        minX: part.position.x - sizeX / 2,
        maxX: part.position.x + sizeX / 2,
        minY: part.position.y - sizeY / 2,
        maxY: part.position.y + sizeY / 2,
        minZ: part.position.z - sizeZ / 2,
        maxZ: part.position.z + sizeZ / 2,
        color: part.color,
      };
    })
    .filter((box) => Number.isFinite(box.minX) && box.maxX > box.minX);
  if (!boxes.length) return false;
  const bounds = boxes.reduce(
    (current, box) => ({
      minX: Math.min(current.minX, box.minX),
      maxX: Math.max(current.maxX, box.maxX),
      minY: Math.min(current.minY, box.minY),
      maxY: Math.max(current.maxY, box.maxY),
      minZ: Math.min(current.minZ, box.minZ),
      maxZ: Math.max(current.maxZ, box.maxZ),
    }),
    {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    },
  );
  const { project } = isoProjector(bounds, width, height);
  polygon(ctx, [
    project(bounds.minX, bounds.minY, bounds.minZ),
    project(bounds.maxX, bounds.minY, bounds.minZ),
    project(bounds.maxX, bounds.maxY, bounds.minZ),
    project(bounds.minX, bounds.maxY, bounds.minZ),
  ]);
  ctx.fillStyle = "#e6ebf1";
  ctx.fill();
  boxes.sort(
    (left, right) =>
      right.minX +
        right.maxX +
        right.minY +
        right.maxY -
        (left.minX + left.maxX + left.minY + left.maxY) || left.minZ - right.minZ,
  );
  for (const box of boxes) {
    const parsed = /^#?([0-9a-f]{6})$/iu.exec(box.color?.trim() ?? "");
    const color = parsed ? parseInt(parsed[1], 16) : 0xcbd5e1;
    drawExtrusion(
      ctx,
      project,
      [
        { x: box.minX, y: box.minY },
        { x: box.maxX, y: box.minY },
        { x: box.maxX, y: box.maxY },
        { x: box.minX, y: box.maxY },
      ],
      box.minZ,
      box.maxZ,
      color,
      shade(color, 1.08),
    );
  }
  return true;
}

function drawPlacement(
  ctx: CanvasRenderingContext2D,
  entry: PlacementArchiveEntry,
  width: number,
  height: number,
) {
  const { source, analysis } = entry.payload;
  const polygons: Array<{
    points: Array<{ x: number; y: number }>;
    fill: string;
    stroke: string;
    dash?: number[];
  }> = [];
  for (const neighbor of source.neighbors ?? [])
    polygons.push({ points: neighbor.polygon, fill: "#d7dde5", stroke: "#94a3b8" });
  if (source.parcel?.length)
    polygons.push({ points: source.parcel, fill: "#e8f1fb", stroke: "#2563eb" });
  const spots = analysis.buildableSpots
    ?.map((rings) => rings[0])
    .filter((ring) => ring?.length >= 3);
  if (spots?.length)
    for (const ring of spots)
      polygons.push({
        points: ring,
        fill: "rgba(22, 163, 74, 0.18)",
        stroke: "#16a34a",
        dash: [4, 3],
      });
  else if (analysis.buildable?.length)
    polygons.push({
      points: analysis.buildable,
      fill: "rgba(22, 163, 74, 0.18)",
      stroke: "#16a34a",
      dash: [4, 3],
    });
  if (analysis.building) {
    const rect = analysis.building;
    polygons.push({
      points: [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height },
      ],
      fill: "rgba(37, 99, 235, 0.7)",
      stroke: "#1d4ed8",
    });
  }
  const all = polygons.flatMap((item) => item.points);
  if (all.length < 3) return false;
  const minX = Math.min(...all.map((point) => point.x));
  const maxX = Math.max(...all.map((point) => point.x));
  const minY = Math.min(...all.map((point) => point.y));
  const maxY = Math.max(...all.map((point) => point.y));
  const scale = Math.min(
    (width * 0.86) / Math.max(maxX - minX, 1e-9),
    (height * 0.86) / Math.max(maxY - minY, 1e-9),
  );
  const toCanvas = (point: { x: number; y: number }): [number, number] => [
    width / 2 + (point.x - (minX + maxX) / 2) * scale,
    height / 2 - (point.y - (minY + maxY) / 2) * scale,
  ];
  for (const item of polygons) {
    polygon(ctx, item.points.map(toCanvas));
    ctx.fillStyle = item.fill;
    ctx.fill();
    ctx.strokeStyle = item.stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash(item.dash ?? []);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  return true;
}

/** Рисует миниатюру записи архива; false - рисовать нечего */
export function drawArchivePreview(
  ctx: CanvasRenderingContext2D,
  entry: ArchiveEntry,
  width: number,
  height: number,
) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  try {
    if (entry.kind === "topography") return drawTopography(ctx, entry, width, height);
    if (entry.kind === "reconstruction") return drawReconstruction(ctx, entry, width, height);
    return drawPlacement(ctx, entry, width, height);
  } catch {
    return false;
  }
}
