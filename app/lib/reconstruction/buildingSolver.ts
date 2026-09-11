import { buildFootprintBases } from "./buildingFootprint";
import type {
  DrawingAnalysis,
  ReconstructionHints,
  ReconstructionPart,
  ReconstructionUnit,
} from "./types";

export type BuildingMassShape = "box" | "arc";
export type BuildingRoof = "flat" | "gable" | "hip" | "curved";

export interface BuildingMassRecipe {
  id: string;
  name: string;
  shape: BuildingMassShape;
  centerX: number;
  centerZ: number;
  width: number;
  depth: number;
  startLevel: number;
  levels: number;
  rotationDegrees: number;
  arcSweepDegrees: number;
  roof: BuildingRoof;
  roofHeight: number;
  windowColumnsFront: number;
  windowColumnsSide: number;
  windowWidth: number;
  windowHeight: number;
  entrance: boolean;
  porchSteps: number;
  balconyLevels: number[];
  cores: number;
  footprintHandle: string;
}

interface BuildingContourCandidate {
  handle: string;
  layer: string;
  region: string;
  width: number;
  depth: number;
  area: number;
  compactness: number;
  vertices: Array<{ x: number; z: number; bulge: number }>;
}

export interface BuildingRecipe {
  applicable: boolean;
  reason: string;
  unit: ReconstructionUnit;
  overallWidth: number;
  overallDepth: number;
  floorHeight: number;
  masses: BuildingMassRecipe[];
  confidence: number;
  assumptions: string[];
}

const massSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", maxLength: 50 },
    name: { type: "string", maxLength: 100 },
    shape: { type: "string", enum: ["box", "arc"] },
    centerX: { type: "number" },
    centerZ: { type: "number" },
    width: { type: "number", exclusiveMinimum: 0 },
    depth: { type: "number", exclusiveMinimum: 0 },
    startLevel: { type: "integer", minimum: 0, maximum: 30 },
    levels: { type: "integer", minimum: 1, maximum: 40 },
    rotationDegrees: { type: "number", minimum: -180, maximum: 180 },
    arcSweepDegrees: { type: "number", minimum: 0, maximum: 180 },
    roof: { type: "string", enum: ["flat", "gable", "hip", "curved"] },
    roofHeight: { type: "number", minimum: 0 },
    windowColumnsFront: { type: "integer", minimum: 0, maximum: 40 },
    windowColumnsSide: { type: "integer", minimum: 0, maximum: 20 },
    windowWidth: { type: "number", minimum: 0 },
    windowHeight: { type: "number", minimum: 0 },
    entrance: { type: "boolean" },
    porchSteps: { type: "integer", minimum: 0, maximum: 8 },
    balconyLevels: {
      type: "array",
      maxItems: 8,
      items: { type: "integer", minimum: 1, maximum: 30 },
    },
    cores: { type: "integer", minimum: 0, maximum: 8 },
    footprintHandle: { type: "string", maxLength: 64 },
  },
  required: [
    "id",
    "name",
    "shape",
    "centerX",
    "centerZ",
    "width",
    "depth",
    "startLevel",
    "levels",
    "rotationDegrees",
    "arcSweepDegrees",
    "roof",
    "roofHeight",
    "windowColumnsFront",
    "windowColumnsSide",
    "windowWidth",
    "windowHeight",
    "entrance",
    "cores",
    "footprintHandle",
  ],
} as const;

export const buildingRecipeJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    applicable: { type: "boolean" },
    reason: { type: "string", maxLength: 420 },
    unit: { type: "string", enum: ["mm", "cm", "m", "in"] },
    overallWidth: { type: "number", exclusiveMinimum: 0 },
    overallDepth: { type: "number", exclusiveMinimum: 0 },
    floorHeight: { type: "number", exclusiveMinimum: 0 },
    masses: { type: "array", minItems: 1, maxItems: 12, items: massSchema },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    assumptions: { type: "array", maxItems: 16, items: { type: "string", maxLength: 220 } },
  },
  required: [
    "applicable",
    "reason",
    "unit",
    "overallWidth",
    "overallDepth",
    "floorHeight",
    "masses",
    "confidence",
    "assumptions",
  ],
} as const;

function finite(value: unknown, label: string, minimum = 0, maximum = 1_000_000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label}: недопустимое число`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  const number = finite(value, label, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${label}: ожидалось целое число`);
  return number;
}

export function parseBuildingRecipe(value: unknown): BuildingRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("buildingRecipe: ожидался объект");
  const item = value as Record<string, unknown>;
  const units = new Set<ReconstructionUnit>(["mm", "cm", "m", "in"]);
  if (typeof item.applicable !== "boolean")
    throw new Error("buildingRecipe.applicable: ожидался boolean");
  if (typeof item.reason !== "string" || !item.reason.trim())
    throw new Error("buildingRecipe.reason: требуется объяснение");
  if (typeof item.unit !== "string" || !units.has(item.unit as ReconstructionUnit))
    throw new Error("buildingRecipe.unit: неизвестные единицы");
  if (!Array.isArray(item.masses) || !item.masses.length || item.masses.length > 12)
    throw new Error("buildingRecipe.masses: требуется 1–12 масс");
  const ids = new Set<string>();
  const masses = item.masses.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`buildingRecipe.masses[${index}]: ожидался объект`);
    const mass = value as Record<string, unknown>;
    const id = typeof mass.id === "string" ? mass.id.trim().slice(0, 50) : "";
    const name = typeof mass.name === "string" ? mass.name.trim().slice(0, 100) : "";
    if (!id || ids.has(id) || !name)
      throw new Error(`buildingRecipe.masses[${index}]: id и name должны быть уникальны`);
    ids.add(id);
    if (mass.shape !== "box" && mass.shape !== "arc")
      throw new Error(`buildingRecipe.masses[${index}].shape: неизвестная форма`);
    if (!(["flat", "gable", "hip", "curved"] as unknown[]).includes(mass.roof))
      throw new Error(`buildingRecipe.masses[${index}].roof: неизвестная крыша`);
    if (typeof mass.entrance !== "boolean")
      throw new Error(`buildingRecipe.masses[${index}].entrance: ожидался boolean`);
    return {
      id,
      name,
      shape: mass.shape as BuildingMassShape,
      centerX: finite(mass.centerX, `${id}.centerX`, -1_000_000_000, 1_000_000_000),
      centerZ: finite(mass.centerZ, `${id}.centerZ`, -1_000_000_000, 1_000_000_000),
      width: finite(mass.width, `${id}.width`, 0.01),
      depth: finite(mass.depth, `${id}.depth`, 0.01),
      startLevel: integer(mass.startLevel, `${id}.startLevel`, 0, 30),
      levels: integer(mass.levels, `${id}.levels`, 1, 40),
      rotationDegrees: finite(mass.rotationDegrees, `${id}.rotationDegrees`, -180, 180),
      arcSweepDegrees: finite(mass.arcSweepDegrees, `${id}.arcSweepDegrees`, 0, 180),
      roof: mass.roof as BuildingRoof,
      roofHeight: finite(mass.roofHeight, `${id}.roofHeight`, 0),
      windowColumnsFront: integer(mass.windowColumnsFront, `${id}.windowColumnsFront`, 0, 40),
      windowColumnsSide: integer(mass.windowColumnsSide, `${id}.windowColumnsSide`, 0, 20),
      windowWidth: finite(mass.windowWidth, `${id}.windowWidth`, 0),
      windowHeight: finite(mass.windowHeight, `${id}.windowHeight`, 0),
      entrance: mass.entrance,
      porchSteps:
        typeof mass.porchSteps === "number"
          ? integer(mass.porchSteps, `${id}.porchSteps`, 0, 8)
          : 0,
      balconyLevels: Array.isArray(mass.balconyLevels)
        ? [
            ...new Set(
              mass.balconyLevels.filter(
                (level): level is number =>
                  typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 30,
              ),
            ),
          ].slice(0, 8)
        : [],
      cores: integer(mass.cores, `${id}.cores`, 0, 8),
      footprintHandle:
        typeof mass.footprintHandle === "string" ? mass.footprintHandle.trim().slice(0, 64) : "",
    };
  });
  const assumptions = Array.isArray(item.assumptions)
    ? item.assumptions
        .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
        .slice(0, 16)
        .map((entry) => entry.trim().slice(0, 220))
    : [];
  return {
    applicable: item.applicable,
    reason: item.reason.trim().slice(0, 420),
    unit: item.unit as ReconstructionUnit,
    overallWidth: finite(item.overallWidth, "buildingRecipe.overallWidth", 0.01),
    overallDepth: finite(item.overallDepth, "buildingRecipe.overallDepth", 0.01),
    floorHeight: finite(item.floorHeight, "buildingRecipe.floorHeight", 0.01),
    masses,
    confidence: finite(item.confidence, "buildingRecipe.confidence", 0, 1),
    assumptions,
  };
}

export function buildingContourCandidates(context: string): BuildingContourCandidate[] {
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    if (!Array.isArray(parsed.planContourCandidates)) return [];
    return parsed.planContourCandidates
      .flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const candidate = value as Record<string, unknown>;
        const handle = typeof candidate.handle === "string" ? candidate.handle.slice(0, 64) : "";
        const layer = typeof candidate.layer === "string" ? candidate.layer.slice(0, 100) : "0";
        const region = typeof candidate.region === "string" ? candidate.region.slice(0, 20) : "";
        const width =
          typeof candidate.width === "number" && Number.isFinite(candidate.width)
            ? candidate.width
            : 0;
        const depth =
          typeof candidate.depth === "number" && Number.isFinite(candidate.depth)
            ? candidate.depth
            : 0;
        const area =
          typeof candidate.area === "number" && Number.isFinite(candidate.area)
            ? candidate.area
            : 0;
        const compactness =
          typeof candidate.compactness === "number" && Number.isFinite(candidate.compactness)
            ? candidate.compactness
            : 0;
        const vertices = Array.isArray(candidate.vertices)
          ? candidate.vertices
              .flatMap((point) => {
                if (
                  !Array.isArray(point) ||
                  point.length < 2 ||
                  !Number.isFinite(point[0]) ||
                  !Number.isFinite(point[1])
                )
                  return [];
                return [
                  {
                    x: Number(point[0]),
                    z: Number(point[1]),
                    bulge: Number.isFinite(point[2]) ? Number(point[2]) : 0,
                  },
                ];
              })
              .slice(0, 240)
          : [];
        return handle && width > 0 && depth > 0 && vertices.length >= 3
          ? [{ handle, layer, region, width, depth, area, compactness, vertices }]
          : [];
      })
      .slice(0, 20);
  } catch {
    return [];
  }
}

const colors = {
  shell: "#d7dde5",
  band: "#7c8999",
  window: "#4f86a5",
  roof: "#9a5f43",
  core: "#8e98a7",
  entrance: "#4f6f87",
  foundation: "#737b86",
};

export function buildBuildingDraft(
  sourceName: string,
  analysis: DrawingAnalysis,
  hints: ReconstructionHints,
  recipe: BuildingRecipe,
  contours: BuildingContourCandidate[] = [],
) {
  if (!recipe.applicable) throw new Error(`buildingRecipe: ${recipe.reason}`);
  const unit = analysis.unit === "unknown" ? hints.unit || recipe.unit : analysis.unit;
  const mixedMetricMarks =
    unit === "mm" &&
    Math.max(
      recipe.overallWidth,
      recipe.overallDepth,
      ...analysis.dimensions.map((dimension) => dimension.value),
    ) >= 1_000;
  const architecturalLength = (value: number) =>
    mixedMetricMarks && value > 0 && value < 50 ? value * 1_000 : value;
  const floorHeight =
    hints.height && recipe.masses.length === 1
      ? hints.height / recipe.masses[0].levels
      : architecturalLength(recipe.floorHeight);
  const parts: ReconstructionPart[] = [];
  const contoursByHandle = new Map(contours.map((candidate) => [candidate.handle, candidate]));
  const evidence = [`Параметрический решатель выбран по анализу чертежа: ${recipe.reason}`];
  const dimensionValues = analysis.dimensions
    .map((dimension) => dimension.value)
    .filter((value) => value > floorHeight * 1.5)
    .sort((left, right) => right - left);
  const expectedLong = dimensionValues[0];
  const expectedShort =
    expectedLong &&
    dimensionValues.find((value) => value <= expectedLong * 0.85 && value >= expectedLong * 0.15);
  let overallWidth = hints.width || architecturalLength(recipe.overallWidth);
  let overallDepth = hints.depth || architecturalLength(recipe.overallDepth);
  let masses = recipe.masses.map((mass) => {
    const normalized = {
      ...mass,
      width: architecturalLength(mass.width),
      depth: architecturalLength(mass.depth),
      roofHeight: architecturalLength(mass.roofHeight),
      windowWidth: architecturalLength(mass.windowWidth),
      windowHeight: architecturalLength(mass.windowHeight),
    };
    const contour = contoursByHandle.get(mass.footprintHandle);
    if (!contour) return normalized;
    const directError =
      Math.abs(Math.log(normalized.width / contour.width)) +
      Math.abs(Math.log(normalized.depth / contour.depth));
    const swappedError =
      Math.abs(Math.log(normalized.width / contour.depth)) +
      Math.abs(Math.log(normalized.depth / contour.width));
    return swappedError < directError
      ? { ...normalized, width: contour.depth, depth: contour.width }
      : { ...normalized, width: contour.width, depth: contour.depth };
  });
  const massMinX = Math.min(...masses.map((mass) => mass.centerX - mass.width / 2));
  const massMaxX = Math.max(...masses.map((mass) => mass.centerX + mass.width / 2));
  const massMinZ = Math.min(...masses.map((mass) => mass.centerZ - mass.depth / 2));
  const massMaxZ = Math.max(...masses.map((mass) => mass.centerZ + mass.depth / 2));
  const drawingOffsetX = (massMinX + massMaxX) / 2;
  const drawingOffsetZ = (massMinZ + massMaxZ) / 2;
  masses = masses.map((mass) => ({
    ...mass,
    centerX: mass.centerX - drawingOffsetX,
    centerZ: mass.centerZ - drawingOffsetZ,
  }));
  if (Math.abs(drawingOffsetX) > overallWidth || Math.abs(drawingOffsetZ) > overallDepth) {
    evidence.push("Абсолютные координаты DWG автоматически переведены в локальную систему модели.");
  }
  if (mixedMetricMarks && floorHeight !== recipe.floorHeight) {
    evidence.push(
      "Архитектурные отметки вида +2.310 нормализованы из метров в миллиметры относительно общего масштаба DWG.",
    );
  }
  if (
    !hints.width &&
    !hints.depth &&
    expectedLong &&
    expectedShort &&
    Math.max(overallWidth, overallDepth) < expectedLong * 0.65
  ) {
    const targetWidth = overallWidth >= overallDepth ? expectedLong : expectedShort;
    const targetDepth = overallWidth >= overallDepth ? expectedShort : expectedLong;
    const scaleX = targetWidth / overallWidth;
    const scaleZ = targetDepth / overallDepth;
    masses = masses.map((mass) => ({
      ...mass,
      centerX: mass.centerX * scaleX,
      centerZ: mass.centerZ * scaleZ,
      width: mass.width * scaleX,
      depth: mass.depth * scaleZ,
      roofHeight: mass.roofHeight * Math.min(scaleX, scaleZ),
    }));
    overallWidth = targetWidth;
    overallDepth = targetDepth;
  }
  if (
    masses.length === 1 &&
    /(?:^|\W)(?:l|t|г|т)[-‑–— ]?образ/iu.test(`${masses[0].name} ${recipe.reason}`)
  ) {
    const source = masses[0];
    masses = [
      {
        ...source,
        id: `${source.id}-wing`,
        name: `${source.name} · продольное крыло`,
        centerZ: source.centerZ - source.depth * 0.27,
        depth: source.depth * 0.46,
      },
      {
        ...source,
        id: `${source.id}-cross`,
        name: `${source.name} · поперечное крыло`,
        centerX: source.centerX + source.width * 0.18,
        centerZ: source.centerZ + source.depth * 0.14,
        width: source.width * 0.36,
        depth: source.depth * 0.72,
        windowColumnsFront: Math.max(2, Math.round(source.windowColumnsFront * 0.36)),
      },
    ];
  }
  masses = masses.map((mass) => {
    if (mass.shape !== "arc") return mass;
    const horizontal = overallWidth >= overallDepth;
    const rotationDegrees = horizontal ? 0 : 90;
    const transverseSpan = horizontal ? overallDepth : overallWidth;
    const depth = Math.min(mass.depth, transverseSpan * 0.55);
    const chord = Math.max(1, mass.width);
    const availableSagitta = Math.max(0, transverseSpan - depth);
    const maximumSweep = Math.max(
      12,
      Math.min(170, (4 * Math.atan2(2 * availableSagitta, chord) * 180) / Math.PI),
    );
    return {
      ...mass,
      depth,
      rotationDegrees,
      arcSweepDegrees: Math.min(Math.max(10, mass.arcSweepDegrees), maximumSweep),
    };
  });
  const projectedHalfExtents = (mass: BuildingMassRecipe) => {
    const radians = (mass.rotationDegrees * Math.PI) / 180;
    const cosine = Math.abs(Math.cos(radians));
    const sine = Math.abs(Math.sin(radians));
    return {
      x: (mass.width * cosine + mass.depth * sine) / 2,
      z: (mass.width * sine + mass.depth * cosine) / 2,
    };
  };
  const complexFootprint =
    masses.length > 1 &&
    /(?:^|\W)(?:l|t|г|т)[-‑–— ]?образ/iu.test(
      `${recipe.reason} ${masses.map((mass) => mass.name).join(" ")}`,
    );
  if (complexFootprint) {
    masses = masses.map((mass) => {
      const extent = projectedHalfExtents(mass);
      if (extent.x * 2 < overallWidth * 0.76 || extent.z * 2 < overallDepth * 0.76) return mass;
      return mass.width >= mass.depth
        ? { ...mass, depth: Math.min(mass.depth, overallDepth * 0.44) }
        : { ...mass, width: Math.min(mass.width, overallWidth * 0.44) };
    });
    evidence.push(
      "Г-/L-/Т-образный контур разложен на пересекающиеся крылья вместо сплошного прямоугольника.",
    );
  }
  masses = masses.map((mass) => {
    const extent = projectedHalfExtents(mass);
    const factor = Math.min(
      1,
      (overallWidth * 0.98) / (extent.x * 2),
      (overallDepth * 0.98) / (extent.z * 2),
    );
    return factor < 1 ? { ...mass, width: mass.width * factor, depth: mass.depth * factor } : mass;
  });
  const fitMassCenters = (items: BuildingMassRecipe[], axis: "x" | "z", target: number) => {
    const centerKey = axis === "x" ? "centerX" : "centerZ";
    const extentKey = axis;
    const boundsAt = (scale: number) => {
      const minima = items.map(
        (mass) => mass[centerKey] * scale - projectedHalfExtents(mass)[extentKey],
      );
      const maxima = items.map(
        (mass) => mass[centerKey] * scale + projectedHalfExtents(mass)[extentKey],
      );
      return { min: Math.min(...minima), max: Math.max(...maxima) };
    };
    let scale = 1;
    if (boundsAt(scale).max - boundsAt(scale).min > target) {
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < 32; iteration += 1) {
        const middle = (low + high) / 2;
        const bounds = boundsAt(middle);
        if (bounds.max - bounds.min <= target) low = middle;
        else high = middle;
      }
      scale = low;
    }
    const scaled = items.map((mass) => ({ ...mass, [centerKey]: mass[centerKey] * scale }));
    const minima = scaled.map((mass) => mass[centerKey] - projectedHalfExtents(mass)[extentKey]);
    const maxima = scaled.map((mass) => mass[centerKey] + projectedHalfExtents(mass)[extentKey]);
    const offset = (Math.min(...minima) + Math.max(...maxima)) / 2;
    return scaled.map((mass) => ({ ...mass, [centerKey]: mass[centerKey] - offset }));
  };
  masses = fitMassCenters(masses, "x", overallWidth);
  masses = fitMassCenters(masses, "z", overallDepth);
  const addBox = (
    id: string,
    name: string,
    position: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    rotationDegrees: { x: number; y: number; z: number },
    color: string,
    partEvidence: string[],
  ) => {
    if (parts.length >= 680 || Math.min(size.x, size.y, size.z) <= 0) return;
    parts.push({
      id,
      name,
      kind: "box",
      position,
      size,
      rotationDegrees,
      radius: 0,
      height: 0,
      profile: [],
      holes: [],
      vertices: [],
      faces: [],
      color,
      confidence: Math.min(analysis.overallConfidence, recipe.confidence),
      evidence: partEvidence,
    });
  };
  const addExtrusion = (
    id: string,
    name: string,
    position: { x: number; y: number; z: number },
    profile: Array<{ x: number; z: number }>,
    height: number,
    size: { x: number; y: number; z: number },
    color: string,
    partEvidence: string[],
  ) => {
    if (parts.length >= 680 || profile.length < 3 || height <= 0) return;
    parts.push({
      id,
      name,
      kind: "extrusion",
      position,
      size,
      height,
      profile,
      rotationDegrees: { x: 0, y: 0, z: 0 },
      radius: 0,
      holes: [],
      vertices: [],
      faces: [],
      color,
      confidence: Math.min(analysis.overallConfidence, recipe.confidence),
      evidence: partEvidence,
    });
  };
  const profileForMass = (mass: BuildingMassRecipe) => {
    const contour = contoursByHandle.get(mass.footprintHandle);
    if (!contour) return undefined;
    const directScale = Math.max(
      mass.width / contour.width,
      contour.width / mass.width,
      mass.depth / contour.depth,
      contour.depth / mass.depth,
    );
    const swappedScale = Math.max(
      mass.width / contour.depth,
      contour.depth / mass.width,
      mass.depth / contour.width,
      contour.width / mass.depth,
    );
    if (Math.min(directScale, swappedScale) > 1.65) return undefined;
    const swapAxes = swappedScale < directScale;
    const expanded: Array<{ x: number; z: number }> = [];
    contour.vertices.forEach((point, index) => {
      const next = contour.vertices[(index + 1) % contour.vertices.length];
      expanded.push({ x: point.x, z: point.z });
      if (Math.abs(point.bulge) < 1e-8) return;
      const chord = Math.hypot(next.x - point.x, next.z - point.z);
      if (chord <= 1e-9) return;
      const sweep = 4 * Math.atan(point.bulge);
      const middle = { x: (point.x + next.x) / 2, z: (point.z + next.z) / 2 };
      const offset = (chord * (1 - point.bulge * point.bulge)) / (4 * point.bulge);
      const center = {
        x: middle.x - ((next.z - point.z) / chord) * offset,
        z: middle.z + ((next.x - point.x) / chord) * offset,
      };
      const start = Math.atan2(point.z - center.z, point.x - center.x);
      const segments = Math.min(24, Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
      for (let step = 1; step < segments; step += 1) {
        const angle = start + (sweep * step) / segments;
        const radius = Math.hypot(point.x - center.x, point.z - center.z);
        expanded.push({
          x: center.x + Math.cos(angle) * radius,
          z: center.z + Math.sin(angle) * radius,
        });
      }
    });
    const minX = Math.min(...expanded.map((point) => point.x));
    const maxX = Math.max(...expanded.map((point) => point.x));
    const minZ = Math.min(...expanded.map((point) => point.z));
    const maxZ = Math.max(...expanded.map((point) => point.z));
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const scaleX = mass.width / Math.max(1e-9, swapAxes ? maxZ - minZ : maxX - minX);
    const scaleZ = mass.depth / Math.max(1e-9, swapAxes ? maxX - minX : maxZ - minZ);
    const radians = (mass.rotationDegrees * Math.PI) / 180;
    return expanded.map((point) => {
      const x = (swapAxes ? point.z - centerZ : point.x - centerX) * scaleX;
      const z = (swapAxes ? -(point.x - centerX) : point.z - centerZ) * scaleZ;
      return {
        x: x * Math.cos(radians) + z * Math.sin(radians),
        z: -x * Math.sin(radians) + z * Math.cos(radians),
      };
    });
  };
  const rotate = (x: number, z: number, degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return {
      x: x * Math.cos(radians) + z * Math.sin(radians),
      z: -x * Math.sin(radians) + z * Math.cos(radians),
    };
  };

  const exactProfiles = new Map(
    masses.flatMap((mass) => {
      const profile = profileForMass(mass);
      return profile ? [[mass.id, profile] as const] : [];
    }),
  );
  if (exactProfiles.size) {
    evidence.push("Контур основных объёмов выдавлен из выбранных ИИ замкнутых полилиний DWG.");
  }

  for (const mass of masses) {
    const baseY = mass.startLevel * floorHeight;
    const wallHeight = mass.levels * floorHeight;
    const exactProfile = exactProfiles.get(mass.id);
    const segments = exactProfile
      ? 0
      : mass.shape === "arc"
        ? Math.min(14, Math.max(5, Math.ceil(Math.abs(mass.arcSweepDegrees) / 12)))
        : 1;
    const halfSweep = (Math.max(10, mass.arcSweepDegrees) * Math.PI) / 360;
    const radius = mass.shape === "arc" ? mass.width / Math.max(0.2, 2 * Math.sin(halfSweep)) : 0;
    const segmentLength =
      mass.shape === "arc" ? ((radius * halfSweep * 2) / segments) * 1.06 : mass.width;
    const arcMid = mass.shape === "arc" ? (radius + radius * Math.cos(halfSweep)) / 2 : 0;

    if (exactProfile) {
      addExtrusion(
        `${mass.id}-shell`,
        `${mass.name} · точный объём DWG`,
        { x: mass.centerX, y: baseY + wallHeight / 2, z: mass.centerZ },
        exactProfile,
        wallHeight,
        { x: mass.width, y: wallHeight, z: mass.depth },
        colors.shell,
        evidence,
      );
      for (let level = 0; level <= mass.levels; level += 1) {
        const scale = 1.012;
        addExtrusion(
          `${mass.id}-band-${level}`,
          `${mass.name} · пояс уровня ${mass.startLevel + level}`,
          { x: mass.centerX, y: baseY + level * floorHeight, z: mass.centerZ },
          exactProfile.map((point) => ({ x: point.x * scale, z: point.z * scale })),
          Math.max(floorHeight * 0.045, 80),
          { x: mass.width * scale, y: Math.max(floorHeight * 0.045, 80), z: mass.depth * scale },
          colors.band,
          evidence,
        );
      }
      const nominalSpacing = Math.max(
        floorHeight * 0.9,
        mass.width / Math.max(1, mass.windowColumnsFront),
      );
      const windowHeight =
        mass.windowHeight > 0
          ? Math.min(mass.windowHeight, floorHeight * 0.82)
          : floorHeight * 0.48;
      exactProfile.forEach((start, edgeIndex) => {
        const end = exactProfile[(edgeIndex + 1) % exactProfile.length];
        const edgeLength = Math.hypot(end.x - start.x, end.z - start.z);
        const columns = Math.min(12, Math.max(0, Math.round(edgeLength / nominalSpacing)));
        if (!columns) return;
        const step = edgeLength / columns;
        const width =
          mass.windowWidth > 0
            ? Math.min(mass.windowWidth, step * 0.78)
            : Math.min(step * 0.55, floorHeight * 0.55);
        const yaw = (-Math.atan2(end.z - start.z, end.x - start.x) * 180) / Math.PI;
        for (let level = 0; level < mass.levels && parts.length < 640; level += 1) {
          for (let column = 0; column < columns && parts.length < 640; column += 1) {
            const ratio = (column + 0.5) / columns;
            addBox(
              `${mass.id}-edge-${edgeIndex}-window-${level}-${column}`,
              `${mass.name} · окно по контуру`,
              {
                x: mass.centerX + start.x + (end.x - start.x) * ratio,
                y: baseY + level * floorHeight + floorHeight * 0.55,
                z: mass.centerZ + start.z + (end.z - start.z) * ratio,
              },
              { x: width, y: windowHeight, z: Math.max(50, floorHeight * 0.025) },
              { x: 0, y: yaw, z: 0 },
              colors.window,
              evidence,
            );
          }
        }
      });
    }

    for (let segment = 0; segment < segments; segment += 1) {
      const theta =
        mass.shape === "arc" ? -halfSweep + (segment + 0.5) * ((halfSweep * 2) / segments) : 0;
      const localX = mass.shape === "arc" ? radius * Math.sin(theta) : 0;
      const localZ = mass.shape === "arc" ? radius * Math.cos(theta) - arcMid : 0;
      const placed = rotate(localX, localZ, mass.rotationDegrees);
      const segmentRotation = mass.rotationDegrees - (theta * 180) / Math.PI;
      const width = mass.shape === "arc" ? segmentLength : mass.width;
      const id = `${mass.id}-s${segment + 1}`;
      addBox(
        `${id}-shell`,
        `${mass.name} · объём ${segment + 1}`,
        { x: mass.centerX + placed.x, y: baseY + wallHeight / 2, z: mass.centerZ + placed.z },
        { x: width, y: wallHeight, z: mass.depth },
        { x: 0, y: segmentRotation, z: 0 },
        colors.shell,
        evidence,
      );

      for (let level = 0; level <= mass.levels; level += 1) {
        addBox(
          `${id}-band-${level}`,
          `${mass.name} · пояс уровня ${mass.startLevel + level}`,
          {
            x: mass.centerX + placed.x,
            y: baseY + level * floorHeight,
            z: mass.centerZ + placed.z,
          },
          { x: width * 1.012, y: Math.max(floorHeight * 0.045, 80), z: mass.depth * 1.012 },
          { x: 0, y: segmentRotation, z: 0 },
          colors.band,
          evidence,
        );
      }

      const frontColumns = mass.shape === "arc" ? 1 : Math.min(18, mass.windowColumnsFront);
      const sideColumns =
        mass.shape === "arc" || segments > 1 ? 0 : Math.min(8, mass.windowColumnsSide);
      const windowHeight =
        mass.windowHeight > 0
          ? Math.min(mass.windowHeight, floorHeight * 0.82)
          : floorHeight * 0.48;
      const frontStep = width / Math.max(1, frontColumns);
      for (let level = 0; level < mass.levels && parts.length < 640; level += 1) {
        for (let column = 0; column < frontColumns; column += 1) {
          const localWindowX = -width / 2 + frontStep * (column + 0.5);
          const windowWidth =
            mass.windowWidth > 0
              ? Math.min(mass.windowWidth, frontStep * 0.82)
              : Math.min(frontStep * 0.58, floorHeight * 0.55);
          for (const side of [-1, 1]) {
            const offset = rotate(
              localWindowX,
              side * (mass.depth / 2 + Math.max(25, mass.depth * 0.004)),
              segmentRotation,
            );
            addBox(
              `${id}-window-${level}-${column}-${side}`,
              `${mass.name} · окно`,
              {
                x: mass.centerX + placed.x + offset.x,
                y: baseY + level * floorHeight + floorHeight * 0.55,
                z: mass.centerZ + placed.z + offset.z,
              },
              { x: windowWidth, y: windowHeight, z: Math.max(50, mass.depth * 0.008) },
              { x: 0, y: segmentRotation, z: 0 },
              colors.window,
              evidence,
            );
          }
        }
        const sideStep = mass.depth / Math.max(1, sideColumns);
        for (let column = 0; column < sideColumns; column += 1) {
          const localWindowZ = -mass.depth / 2 + sideStep * (column + 0.5);
          const windowWidth =
            mass.windowWidth > 0
              ? Math.min(mass.windowWidth, sideStep * 0.82)
              : Math.min(sideStep * 0.58, floorHeight * 0.55);
          for (const side of [-1, 1]) {
            const offset = rotate(
              side * (width / 2 + Math.max(25, width * 0.004)),
              localWindowZ,
              segmentRotation,
            );
            addBox(
              `${id}-side-window-${level}-${column}-${side}`,
              `${mass.name} · боковое окно`,
              {
                x: mass.centerX + placed.x + offset.x,
                y: baseY + level * floorHeight + floorHeight * 0.55,
                z: mass.centerZ + placed.z + offset.z,
              },
              { x: Math.max(50, width * 0.008), y: windowHeight, z: windowWidth },
              { x: 0, y: segmentRotation, z: 0 },
              colors.window,
              evidence,
            );
          }
        }
      }
    }

    const roofRise = Math.min(Math.max(mass.roofHeight, floorHeight * 0.25), floorHeight * 1.5);
    const roofThickness = Math.max(100, floorHeight * 0.05);
    const roofY =
      baseY +
      wallHeight +
      (mass.roof === "gable" || mass.roof === "hip" ? roofRise / 2 : roofThickness / 2);
    if (mass.roof === "gable" || mass.roof === "hip") {
      const angle = (Math.atan2(roofRise, mass.depth / 2) * 180) / Math.PI;
      const slope = Math.hypot(mass.depth / 2, roofRise);
      for (const side of [-1, 1]) {
        const offset = rotate(0, (side * mass.depth) / 4, mass.rotationDegrees);
        addBox(
          `${mass.id}-roof-${side}`,
          `${mass.name} · скат крыши`,
          { x: mass.centerX + offset.x, y: roofY, z: mass.centerZ + offset.z },
          { x: mass.width * 1.04, y: Math.max(80, floorHeight * 0.035), z: slope * 1.04 },
          { x: side * angle, y: mass.rotationDegrees, z: 0 },
          colors.roof,
          evidence,
        );
      }
    } else if (exactProfile) {
      addExtrusion(
        `${mass.id}-roof`,
        `${mass.name} · кровля по DWG`,
        { x: mass.centerX, y: roofY, z: mass.centerZ },
        exactProfile.map((point) => ({ x: point.x * 1.04, z: point.z * 1.04 })),
        Math.max(100, floorHeight * 0.05),
        { x: mass.width * 1.04, y: Math.max(100, floorHeight * 0.05), z: mass.depth * 1.04 },
        colors.roof,
        evidence,
      );
    } else {
      addBox(
        `${mass.id}-roof`,
        `${mass.name} · кровля`,
        { x: mass.centerX, y: roofY, z: mass.centerZ },
        { x: mass.width * 1.04, y: Math.max(100, floorHeight * 0.05), z: mass.depth * 1.04 },
        { x: 0, y: mass.rotationDegrees, z: 0 },
        colors.roof,
        evidence,
      );
    }

    for (let core = 0; core < mass.cores; core += 1) {
      const localX =
        mass.cores === 1
          ? 0
          : -mass.width * 0.3 + (mass.width * 0.6 * core) / Math.max(1, mass.cores - 1);
      const offset = rotate(localX, 0, mass.rotationDegrees);
      addBox(
        `${mass.id}-core-${core + 1}`,
        `${mass.name} · вертикальное ядро ${core + 1}`,
        { x: mass.centerX + offset.x, y: baseY + wallHeight / 2, z: mass.centerZ + offset.z },
        {
          x: Math.min(floorHeight, mass.width * 0.12),
          y: wallHeight,
          z: Math.min(floorHeight, mass.depth * 0.28),
        },
        { x: 0, y: mass.rotationDegrees, z: 0 },
        colors.core,
        evidence,
      );
    }
    if (mass.entrance) {
      const front = rotate(0, mass.depth / 2 + floorHeight * 0.32, mass.rotationDegrees);
      addBox(
        `${mass.id}-entrance`,
        `${mass.name} · входной портал`,
        { x: mass.centerX + front.x, y: baseY + floorHeight * 0.46, z: mass.centerZ + front.z },
        {
          x: Math.min(mass.width * 0.22, floorHeight * 1.8),
          y: floorHeight * 0.85,
          z: floorHeight * 0.12,
        },
        { x: 0, y: mass.rotationDegrees, z: 0 },
        colors.entrance,
        evidence,
      );
      addBox(
        `${mass.id}-canopy`,
        `${mass.name} · входной козырёк`,
        { x: mass.centerX + front.x, y: baseY + floorHeight * 0.92, z: mass.centerZ + front.z },
        {
          x: Math.min(mass.width * 0.3, floorHeight * 2.2),
          y: Math.max(80, floorHeight * 0.04),
          z: floorHeight * 0.75,
        },
        { x: 0, y: mass.rotationDegrees, z: 0 },
        colors.roof,
        evidence,
      );
      const stepWidth = Math.min(mass.width * 0.32, floorHeight * 2.4);
      for (let step = 0; step < mass.porchSteps; step += 1) {
        const treadDepth = floorHeight * 0.18;
        const local = rotate(0, mass.depth / 2 + treadDepth * (step + 0.5), mass.rotationDegrees);
        const rise = Math.max(120, floorHeight * 0.055);
        addBox(
          `${mass.id}-porch-step-${step + 1}`,
          `${mass.name} · ступень крыльца ${step + 1}`,
          {
            x: mass.centerX + local.x,
            y: baseY + (rise * (step + 1)) / 2,
            z: mass.centerZ + local.z,
          },
          { x: stepWidth, y: rise * (step + 1), z: treadDepth },
          { x: 0, y: mass.rotationDegrees, z: 0 },
          colors.foundation,
          evidence,
        );
      }
    }
    mass.balconyLevels
      .filter((level) => level <= mass.levels)
      .forEach((level) => {
        const balconyWidth = Math.min(mass.width * 0.42, floorHeight * 3);
        const balconyDepth = Math.min(mass.depth * 0.22, floorHeight * 0.8);
        const front = rotate(0, mass.depth / 2 + balconyDepth / 2, mass.rotationDegrees);
        const balconyY = baseY + level * floorHeight;
        addBox(
          `${mass.id}-balcony-${level}`,
          `${mass.name} · балкон уровня ${level}`,
          {
            x: mass.centerX + front.x,
            y: balconyY,
            z: mass.centerZ + front.z,
          },
          { x: balconyWidth, y: Math.max(100, floorHeight * 0.045), z: balconyDepth },
          { x: 0, y: mass.rotationDegrees, z: 0 },
          colors.band,
          evidence,
        );
        const railFront = rotate(0, mass.depth / 2 + balconyDepth, mass.rotationDegrees);
        addBox(
          `${mass.id}-balcony-${level}-rail`,
          `${mass.name} · ограждение балкона уровня ${level}`,
          {
            x: mass.centerX + railFront.x,
            y: balconyY + floorHeight * 0.16,
            z: mass.centerZ + railFront.z,
          },
          { x: balconyWidth, y: floorHeight * 0.32, z: Math.max(45, floorHeight * 0.018) },
          { x: 0, y: mass.rotationDegrees, z: 0 },
          colors.core,
          evidence,
        );
      });
  }

  parts.push(
    ...buildFootprintBases(
      parts.filter((part) => part.id.endsWith("-shell")),
      floorHeight * 0.08,
      colors.foundation,
    ),
  );
  const critical = analysis.unresolved.some((issue) => issue.severity === "critical");
  return {
    version: "1.0",
    title: analysis.objectName,
    status: critical ? "needs_input" : "ready",
    unit,
    summary: `Строительная 3D-сборка создана автономно из ${masses.length} масс: этажи, фасадные ритмы, крыши, входы и вертикальные ядра развернуты процедурным CAD-решателем.`,
    detectedViews: analysis.detectedViews,
    dimensions: analysis.dimensions,
    parts,
    unresolved: analysis.unresolved,
    warnings: [
      ...recipe.assumptions.map((assumption) => `AI-допущение: ${assumption}`),
      "Проёмы показаны фасадными элементами; производственные узлы и скрытые конструкции требуют проектной модели или дополнительных разрезов.",
    ].slice(0, 40),
    overallConfidence: Math.min(analysis.overallConfidence, recipe.confidence),
    canExport: !critical,
    sourceName,
  };
}
