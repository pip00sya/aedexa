import type { DwgDatabase } from "@mlightcad/libredwg-web";
import { parseReconstructionModel } from "./schema";
import type {
  PreparedDrawing,
  ReconstructionDimension,
  ReconstructionModel,
  ReconstructionPart,
  ReconstructionUnit,
  ReconstructionVector3,
} from "./types";

const IMAGE_LIMIT = 15 * 1024 * 1024;
const CAD_LIMIT = 80 * 1024 * 1024;
const MAX_RASTER_SIDE = 4200;
const MAX_RASTER_DATA_URL_LENGTH = 20_000_000;
const MAX_TILE_SIDE = 1400;
const MAX_TILE_DATA_URL_LENGTH = 6_000_000;
const MAX_CAD_CONTEXT_LENGTH = 820_000;
const MAX_CAD_ARRAY_ITEMS = 400;
const partColors = ["#5d83b5", "#4d9a91", "#d18a45", "#7b75b7", "#77945a", "#b66b78"];

type GenericEntity = Record<string, unknown> & { type?: string; layer?: string };
type Point = { x: number; y: number; z?: number };
type ScopedCadEntity = { scope: string; region?: string; entity: GenericEntity };

function extension(name: string) {
  return name.toLowerCase().split(".").pop() || "";
}

export function repairCadSvg(
  svgText: string,
  bounds?: { min: { x: number; y: number; z?: number }; max: { x: number; y: number; z?: number } },
) {
  let repaired = svgText
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;")
    .replace(
      /(<text\b[^>]*>)([\s\S]*?)(<\/text>)/gi,
      (_match, open: string, text: string, close: string) => {
        const escaped = text
          .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `${open}${escaped}${close}`;
      },
    );
  if (!bounds) return repaired;
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  if (
    ![bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y, width, height].every(
      Number.isFinite,
    ) ||
    width <= 0 ||
    height <= 0
  )
    return repaired;
  const fitted = fitSvgRasterDimensions(width, height);
  repaired = repaired.replace(/<svg\b[\s\S]*?>/i, (root) => {
    const attribute = (name: string, value: string) => {
      const expression = new RegExp(`\\s${name}=["'][^"']*["']`, "i");
      return expression.test(root)
        ? root.replace(expression, ` ${name}="${value}"`)
        : root.replace(/>$/, ` ${name}="${value}">`);
    };
    let next = attribute("viewBox", `${bounds.min.x} ${-bounds.max.y} ${width} ${height}`);
    next = /\swidth=["'][^"']*["']/i.test(next)
      ? next.replace(/\swidth=["'][^"']*["']/i, ` width="${fitted.width}"`)
      : next.replace(/>$/, ` width="${fitted.width}">`);
    next = /\sheight=["'][^"']*["']/i.test(next)
      ? next.replace(/\sheight=["'][^"']*["']/i, ` height="${fitted.height}"`)
      : next.replace(/>$/, ` height="${fitted.height}">`);
    return next;
  });
  return repaired;
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось открыть изображение чертежа."));
    image.src = source;
  });
}

async function rasterize(source: string) {
  const image = await loadImage(source);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sides = [MAX_RASTER_SIDE, 3200, 2400, 1800];
  let fallback = "";

  for (const maxSide of sides) {
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Браузер не поддерживает подготовку чертежа.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const png = canvas.toDataURL("image/png");
    if (png.length <= MAX_RASTER_DATA_URL_LENGTH) return png;
    fallback = canvas.toDataURL("image/jpeg", 0.92);
    if (fallback.length <= MAX_RASTER_DATA_URL_LENGTH) return fallback;
  }

  return fallback;
}

function encodeCanvas(canvas: HTMLCanvasElement, maxLength: number) {
  const png = canvas.toDataURL("image/png");
  if (png.length <= maxLength) return png;
  const jpeg = canvas.toDataURL("image/jpeg", 0.92);
  return jpeg.length <= maxLength ? jpeg : undefined;
}

async function rasterizeTiles(source: string) {
  const image = await loadImage(source);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const columns = sourceWidth / Math.max(1, sourceHeight) >= 1.35 ? 3 : 2;
  const rows = 2;
  const candidates: Array<{ index: number; encoded: string }> = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const sx = Math.round((column * sourceWidth) / columns);
      const sy = Math.round((row * sourceHeight) / rows);
      const nextX = Math.round(((column + 1) * sourceWidth) / columns);
      const nextY = Math.round(((row + 1) * sourceHeight) / rows);
      const cropWidth = Math.max(1, nextX - sx);
      const cropHeight = Math.max(1, nextY - sy);
      const scale = Math.min(1, MAX_TILE_SIDE / Math.max(cropWidth, cropHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(cropWidth * scale));
      canvas.height = Math.max(1, Math.round(cropHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Браузер не поддерживает подготовку чертежа.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, sx, sy, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
      const encoded = encodeCanvas(canvas, MAX_TILE_DATA_URL_LENGTH);
      if (encoded) candidates.push({ index: row * columns + column, encoded });
    }
  }
  const largest = Math.max(1, ...candidates.map((candidate) => candidate.encoded.length));
  return candidates
    .filter((candidate) => candidate.encoded.length >= largest * 0.08)
    .sort((left, right) => right.encoded.length - left.encoded.length)
    .slice(0, 4)
    .sort((left, right) => left.index - right.index)
    .map((candidate) => candidate.encoded);
}

export function svgDimensionNeedsViewBox(value: string | null) {
  if (!value) return true;
  const match = value.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))(?:px)?$/i);
  return !match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0;
}

export function fitSvgRasterDimensions(width: number, height: number, maxSide = MAX_RASTER_SIDE) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const scale = Math.min(1, maxSide / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function sanitizeSvg(svgText: string, monochrome = false) {
  const document = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (document.querySelector("parsererror")) throw new Error("SVG содержит синтаксическую ошибку.");
  document.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on")) node.removeAttribute(attribute.name);
    }
  });
  document.querySelectorAll("image").forEach((node) => {
    const href = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
    if (/^(?:https?:|file:|javascript:)/i.test(href)) node.remove();
  });
  const root = document.documentElement;
  if (monochrome) {
    root.querySelectorAll("[stroke]").forEach((node) => {
      if (node.getAttribute("stroke") !== "none") node.setAttribute("stroke", "#17304e");
    });
    root.querySelectorAll("text").forEach((node) => {
      node.setAttribute("fill", "#17304e");
      node.setAttribute("stroke", "none");
    });
  }
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    const fitted = fitSvgRasterDimensions(Math.abs(viewBox[2]), Math.abs(viewBox[3]));
    if (svgDimensionNeedsViewBox(root.getAttribute("width"))) {
      root.setAttribute("width", String(fitted.width));
    }
    if (svgDimensionNeedsViewBox(root.getAttribute("height"))) {
      root.setAttribute("height", String(fitted.height));
    }
  }
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

async function svgToDataUrl(svgText: string, monochrome = false) {
  const clean = sanitizeSvg(svgText, monochrome);
  const url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
  try {
    return await rasterize(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function svgToCadDataUrls(svgText: string) {
  const clean = sanitizeSvg(svgText, true);
  const url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
  try {
    const overview = await rasterize(url);
    const tiles = await rasterizeTiles(url);
    return { overview, images: [overview, ...tiles] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function filterCadPreviewEntities<
  T extends { type?: string; xScale?: unknown; yScale?: unknown },
>(entities: readonly T[]) {
  return entities.filter((entity) => {
    if (entity.type === "RAY" || entity.type === "XLINE") return false;
    if (entity.type !== "INSERT") return true;
    const xScale = typeof entity.xScale === "number" ? Math.abs(entity.xScale) : 1;
    const yScale = typeof entity.yScale === "number" ? Math.abs(entity.yScale) : 1;
    return xScale >= 0.01 && yScale >= 0.01 && xScale <= 20 && yScale <= 20;
  });
}

export function cadPreviewDatabase(database: DwgDatabase): DwgDatabase {
  return {
    ...database,
    entities: filterCadPreviewEntities(database.entities),
    tables: {
      ...database.tables,
      BLOCK_RECORD: {
        ...database.tables.BLOCK_RECORD,
        entries: database.tables.BLOCK_RECORD.entries.map((block) => ({
          ...block,
          entities: filterCadPreviewEntities(block.entities),
        })),
      },
    },
  };
}

function finitePoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  );
}

function pointTuple(value: unknown) {
  if (!finitePoint(value)) return undefined;
  const z = typeof value.z === "number" && Number.isFinite(value.z) ? value.z : 0;
  return Math.abs(z) > 1e-12 ? [value.x, value.y, z] : [value.x, value.y];
}

const geometryPointKeys = [
  "startPoint",
  "endPoint",
  "center",
  "point",
  "position",
  "insertionPoint",
  "definitionPoint",
  "subDefinitionPoint1",
  "subDefinitionPoint2",
  "subDefinitionPoint3",
  "subDefinitionPoint4",
  "textMidPoint",
  "textPosition",
  "alignmentPoint",
  "firstAlignmentPoint",
  "secondAlignmentPoint",
  "corner1",
  "corner2",
  "corner3",
  "corner4",
  "axisPoint",
  "origin",
];
const geometryArrayKeys = ["vertices", "controlPoints", "fitPoints", "seedPoints", "points"];

function entityPoints(entity: GenericEntity): Point[] {
  const points: Point[] = [];
  const push = (value: unknown) => {
    if (finitePoint(value)) {
      points.push(value);
    }
  };
  geometryPointKeys.forEach((key) => push(entity[key]));
  geometryArrayKeys.forEach((key) => {
    const values = entity[key];
    if (Array.isArray(values)) values.slice(0, MAX_CAD_ARRAY_ITEMS).forEach(push);
  });

  const seen = new WeakSet<object>();
  const visitBoundary = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6 || points.length >= 20_000) return;
    if (finitePoint(value)) return push(value);
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, MAX_CAD_ARRAY_ITEMS).forEach((item) => visitBoundary(item, depth + 1));
      return;
    }
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      if (/point|vertex|start|end|center|edge|path|boundary/i.test(key))
        visitBoundary(item, depth + 1);
    });
  };
  visitBoundary(entity.boundaryPaths, 0);

  if (
    ["ARC", "CIRCLE"].includes(entity.type || "") &&
    finitePoint(entity.center) &&
    typeof entity.radius === "number" &&
    Number.isFinite(entity.radius) &&
    entity.radius > 0
  ) {
    const center = entity.center;
    points.push(
      { x: center.x - entity.radius, y: center.y, z: center.z },
      { x: center.x + entity.radius, y: center.y, z: center.z },
      { x: center.x, y: center.y - entity.radius, z: center.z },
      { x: center.x, y: center.y + entity.radius, z: center.z },
    );
  }
  return points;
}

function pointBounds(points: Point[]) {
  if (!points.length) return undefined;
  const min = {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    z: Number.POSITIVE_INFINITY,
  };
  const max = {
    x: Number.NEGATIVE_INFINITY,
    y: Number.NEGATIVE_INFINITY,
    z: Number.NEGATIVE_INFINITY,
  };
  points.forEach((point) => {
    const z = point.z ?? 0;
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
    max.z = Math.max(max.z, z);
  });
  return { min, max };
}

function entityBounds(entities: GenericEntity[]) {
  let bounds: ReturnType<typeof pointBounds>;
  entities.forEach((entity) => {
    entityPoints(entity).forEach((point) => {
      const z = point.z ?? 0;
      if (!bounds)
        bounds = { min: { x: point.x, y: point.y, z }, max: { x: point.x, y: point.y, z } };
      else {
        bounds.min.x = Math.min(bounds.min.x, point.x);
        bounds.min.y = Math.min(bounds.min.y, point.y);
        bounds.min.z = Math.min(bounds.min.z, z);
        bounds.max.x = Math.max(bounds.max.x, point.x);
        bounds.max.y = Math.max(bounds.max.y, point.y);
        bounds.max.z = Math.max(bounds.max.z, z);
      }
    });
  });
  return bounds;
}

function headerBounds(header: unknown) {
  if (!header || typeof header !== "object") return undefined;
  const record = header as Record<string, unknown>;
  const min = record.EXTMIN;
  const max = record.EXTMAX;
  if (!finitePoint(min) || !finitePoint(max) || max.x < min.x || max.y < min.y) return undefined;
  return {
    min: { x: min.x, y: min.y, z: min.z ?? 0 },
    max: { x: max.x, y: max.y, z: max.z ?? 0 },
  };
}

function unitFromInsUnits(code: unknown): ReconstructionUnit | undefined {
  if (code === 1) return "in";
  if (code === 4) return "mm";
  if (code === 5) return "cm";
  if (code === 6) return "m";
  return undefined;
}

function displayedDimension(entity: GenericEntity) {
  if (typeof entity.text !== "string") return undefined;
  const raw = entity.text.trim();
  if (!raw || raw === "<>" || raw.includes("<>")) return undefined;
  const normalized = raw.replace(/\\P/g, " ").replace(/\u00a0/g, " ");
  const match = normalized.match(/[-+]?\d[\d ]*(?:[.,]\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0].replace(/ /g, "").replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  const rawType = typeof entity.dimensionType === "number" ? entity.dimensionType & 15 : -1;
  return {
    raw,
    value: Math.abs(value),
    angular: /%%d|°/i.test(raw) || rawType === 2 || rawType === 5,
  };
}

function measuredDimension(entity: GenericEntity, angular: boolean) {
  if (typeof entity.measurement !== "number" || !Number.isFinite(entity.measurement))
    return undefined;
  const measurement = Math.abs(entity.measurement);
  return angular ? measurement * (180 / Math.PI) : measurement;
}

function cadDimensions(
  entities: GenericEntity[],
  unit: ReconstructionUnit,
): ReconstructionDimension[] {
  return entities
    .filter(
      (entity) =>
        entity.type === "DIMENSION" &&
        typeof entity.measurement === "number" &&
        Number.isFinite(entity.measurement),
    )
    .slice(0, 160)
    .map((entity, index) => {
      const display = displayedDimension(entity);
      return {
        label: display?.raw || `Размер ${index + 1}`,
        value: display?.value ?? Math.abs(entity.measurement as number),
        unit,
        source: display ? ("drawing" as const) : ("cad" as const),
        confidence: 1,
      };
    });
}

const omittedCadKeys = new Set([
  "acisData",
  "binaryData",
  "bmpPreview",
  "preview",
  "proxyEntity",
  "rawData",
  "thumbnailImage",
]);

function compactCadValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return Array.from(value.slice(0, 2_000), (character) => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13 ? " " : character;
    }).join("");
  }
  if (
    !value ||
    typeof value !== "object" ||
    depth > 7 ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  )
    return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CAD_ARRAY_ITEMS)
      .map((item) => compactCadValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 160)) {
    if (omittedCadKeys.has(key) || key === "entities" || typeof item === "function") continue;
    const compact = compactCadValue(item, depth + 1, seen);
    if (compact !== undefined) result[key] = compact;
  }
  return result;
}

function cadTableEntries(database: DwgDatabase, tableName: string): Record<string, unknown>[] {
  const tables = database.tables as unknown as Record<string, unknown>;
  const table = tables?.[tableName];
  if (!table || typeof table !== "object") return [];
  const entries = (table as Record<string, unknown>).entries;
  return Array.isArray(entries)
    ? entries.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object"),
      )
    : [];
}

function entityTypeCounts(entities: GenericEntity[]) {
  const counts: Record<string, number> = {};
  entities.forEach((entity) => {
    const type = typeof entity.type === "string" && entity.type ? entity.type : "UNKNOWN";
    counts[type] = (counts[type] || 0) + 1;
  });
  return counts;
}

function blockIsLayout(name: unknown) {
  return typeof name === "string" && /^\*(?:model|paper)_space/i.test(name);
}

function blockIsPaperLayout(name: unknown) {
  return typeof name === "string" && /^\*paper_space/i.test(name);
}

function generatedDimensionBlock(name: unknown) {
  return typeof name === "string" && /^\*D\d+$/i.test(name);
}

function textValue(entity: GenericEntity) {
  for (const key of ["text", "plainText", "value", "defaultValue"]) {
    if (typeof entity[key] === "string" && entity[key]) return String(entity[key]).slice(0, 2_000);
  }
  return undefined;
}

function readableCadText(value: string) {
  return value
    .replace(/\\(?:pt|[fFcChHwWqQtTaA])[^;{}]*;/g, "")
    .replace(/\\P/gi, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function documentIdentityEvidence(items: ScopedCadEntity[]) {
  const grouped = new Map<
    string,
    {
      text: string;
      count: number;
      scopes: Set<string>;
      regions: Set<string>;
      handles: string[];
    }
  >();

  items.forEach(({ entity, scope, region }) => {
    const raw = textValue(entity);
    if (!raw) return;
    const text = readableCadText(raw);
    if (text.length < 3 || !/[A-Za-zА-Яа-яЁё]/.test(text)) return;
    const key = text.toLocaleLowerCase("ru-RU");
    const current = grouped.get(key) || {
      text,
      count: 0,
      scopes: new Set<string>(),
      regions: new Set<string>(),
      handles: [],
    };
    current.count += 1;
    current.scopes.add(scope);
    if (region) current.regions.add(region);
    if (typeof entity.handle === "string" && current.handles.length < 12)
      current.handles.push(entity.handle);
    grouped.set(key, current);
  });

  const records = [...grouped.values()].map((entry) => ({
    text: entry.text,
    count: entry.count,
    scopes: [...entry.scopes].slice(0, 12),
    regions: [...entry.regions].slice(0, 12),
    handles: entry.handles,
  }));
  const titleScore = (entry: (typeof records)[number]) => {
    const words = entry.text.split(/\s+/).length;
    const nonLetters =
      entry.text.replace(/[A-Za-zА-Яа-яЁё\s]/g, "").length / Math.max(1, entry.text.length);
    return (
      Math.min(entry.text.length, 100) +
      Math.min(words, 12) * 8 +
      (words >= 4 && words <= 12 ? 40 : 0) +
      (entry.scopes.some((scope) => scope.startsWith("p:")) ? 80 : 0) -
      Math.max(0, entry.text.length - 100) * 2 -
      (nonLetters > 0.32 ? 90 : 0) -
      (/\b(?:ТОО|ООО|LLC|LTD|INC|CORP|COMPANY)\b/i.test(entry.text) ? 80 : 0)
    );
  };
  const titleCandidates = records
    .filter((entry) => entry.text.length >= 16 && entry.text.split(/\s+/).length >= 3)
    .sort((left, right) => titleScore(right) - titleScore(left))
    .slice(0, 32);
  const repeatedComponentLabels = records
    .filter(
      (entry) => entry.count > 1 && entry.text.length <= 80 && entry.text.split(/\s+/).length <= 6,
    )
    .sort((left, right) => right.count - left.count || right.text.length - left.text.length)
    .slice(0, 32);

  return {
    selectionPolicy:
      "Whole-object identity comes from a sheet/title-block title. Repeated short spatial labels name components, not the whole object.",
    titleCandidates,
    repeatedComponentLabels,
    uniqueReadableTexts: records.length,
  };
}

function compactEntity(entity: GenericEntity, scope: string, region?: string) {
  const type = typeof entity.type === "string" && entity.type ? entity.type : "UNKNOWN";
  const record: Record<string, unknown> = { s: scope, ...(region ? { r: region } : {}), t: type };
  if (typeof entity.handle === "string") record.h = entity.handle;
  if (typeof entity.layer === "string" && entity.layer !== "0") record.l = entity.layer;
  if (typeof entity.lineType === "string" && entity.lineType) record.lt = entity.lineType;
  if (typeof entity.lineweight === "number" && entity.lineweight !== 29)
    record.lw = entity.lineweight;
  const setNumber = (short: string, key: string) => {
    if (typeof entity[key] === "number" && Number.isFinite(entity[key] as number))
      record[short] = entity[key];
  };
  const setNonZero = (short: string, key: string) => {
    if (
      typeof entity[key] === "number" &&
      Number.isFinite(entity[key] as number) &&
      Math.abs(entity[key] as number) > 1e-12
    ) {
      record[short] = entity[key];
    }
  };
  const setPoint = (short: string, key: string) => {
    const value = pointTuple(entity[key]);
    if (value) record[short] = value;
  };
  const setPoints = (short: string, key: string) => {
    const value = entity[key];
    if (!Array.isArray(value)) return;
    const points = value.slice(0, MAX_CAD_ARRAY_ITEMS).map((item) => {
      if (!finitePoint(item)) return compactCadValue(item);
      const tuple: unknown[] = [
        item.x,
        item.y,
        typeof item.z === "number" && Number.isFinite(item.z) ? item.z : 0,
      ];
      const itemRecord = item as unknown as Record<string, unknown>;
      if (typeof itemRecord.bulge === "number") tuple.push(itemRecord.bulge);
      if (typeof itemRecord.startWidth === "number" || typeof itemRecord.endWidth === "number") {
        tuple.push(itemRecord.startWidth || 0, itemRecord.endWidth || 0);
      }
      return tuple;
    });
    if (points.length) record[short] = points;
  };

  if (type === "LINE") {
    setPoint("p1", "startPoint");
    setPoint("p2", "endPoint");
    setNonZero("th", "thickness");
  } else if (["LWPOLYLINE", "POLYLINE2D", "POLYLINE3D"].includes(type)) {
    setPoints("v", "vertices");
    setNonZero("fl", "flag");
    setNonZero("el", "elevation");
    setNonZero("th", "thickness");
    setNonZero("w", "constantWidth");
    if (typeof entity.flag === "number") record.closed = (entity.flag & 1) === 1;
  } else if (["ARC", "CIRCLE"].includes(type)) {
    setPoint("c", "center");
    setNumber("rad", "radius");
    setNumber("a1", "startAngle");
    setNumber("a2", "endAngle");
    setNonZero("th", "thickness");
    setNonZero("el", "elevation");
  } else if (type === "ELLIPSE") {
    setPoint("c", "center");
    setPoint("axis", "majorAxis");
    setNumber("ratio", "axisRatio");
    setNumber("a1", "startParameter");
    setNumber("a2", "endParameter");
  } else if (type === "SPLINE") {
    setNumber("degree", "degree");
    setNumber("flags", "flags");
    setPoints("cp", "controlPoints");
    setPoints("fp", "fitPoints");
    if (Array.isArray(entity.knots)) record.knots = entity.knots.slice(0, MAX_CAD_ARRAY_ITEMS);
    if (Array.isArray(entity.weights))
      record.weights = entity.weights.slice(0, MAX_CAD_ARRAY_ITEMS);
  } else if (type === "HATCH") {
    record.paths = compactCadValue(entity.boundaryPaths);
    for (const key of [
      "patternName",
      "solidFill",
      "associative",
      "patternAngle",
      "patternScale",
      "elevation",
    ]) {
      const value = compactCadValue(entity[key]);
      if (value !== undefined) record[key] = value;
    }
  } else if (["INSERT", "MINSERT"].includes(type)) {
    const name = typeof entity.name === "string" ? entity.name : entity.blockName;
    if (typeof name === "string") record.name = name;
    setPoint("p", "insertionPoint");
    setNumber("sx", "xScale");
    setNumber("sy", "yScale");
    setNumber("sz", "zScale");
    setNonZero("rot", "rotation");
    setNonZero("rows", "rowCount");
    setNonZero("cols", "columnCount");
    setNonZero("rowGap", "rowSpacing");
    setNonZero("colGap", "columnSpacing");
    const attributes = Array.isArray(entity.attribs)
      ? entity.attribs
      : Array.isArray(entity.attributes)
        ? entity.attributes
        : [];
    if (attributes.length)
      record.attrs = attributes.slice(0, 120).map((attribute) => compactCadValue(attribute));
  } else if (type === "DIMENSION") {
    const display = displayedDimension(entity);
    const measured = measuredDimension(entity, Boolean(display?.angular));
    if (display) record.display = display.raw;
    setNumber("measurement", "measurement");
    if (display && measured !== undefined) {
      const tolerance = Math.max(0.01, display.value * 0.001);
      record.nominal = display.value;
      record.anchorMeasurement = measured;
      record.overrideConflict = Math.abs(display.value - measured) > tolerance;
    }
    if (typeof entity.styleName === "string") record.style = entity.styleName;
    setNumber("dimType", "dimensionType");
    setNonZero("rot", "rotation");
    setNonZero("textRot", "textRotation");
    geometryPointKeys.forEach((key) => setPoint(key, key));
  } else if (["TEXT", "MTEXT", "ATTRIB", "ATTDEF", "TOLERANCE"].includes(type)) {
    const text = textValue(entity);
    if (text) record.text = text;
    if (typeof entity.tag === "string") record.tag = entity.tag;
    for (const key of ["textHeight", "height", "width", "widthFactor"]) setNumber(key, key);
    setNonZero("rotation", "rotation");
    geometryPointKeys.forEach((key) => setPoint(key, key));
  } else if (["3DFACE", "SOLID", "TRACE"].includes(type)) {
    ["corner1", "corner2", "corner3", "corner4"].forEach((key, index) =>
      setPoint(`p${index + 1}`, key),
    );
  } else if (type === "POINT") {
    setPoint("p", "point");
    setPoint("p", "position");
  } else {
    const fallback = compactCadValue(entity);
    if (fallback && typeof fallback === "object" && !Array.isArray(fallback))
      Object.assign(record, fallback);
  }
  const extrusion = pointTuple(entity.extrusionDirection);
  if (
    extrusion &&
    !(extrusion.length === 3 && extrusion[0] === 0 && extrusion[1] === 0 && extrusion[2] === 1)
  )
    record.ex = extrusion;
  return record;
}

function balancedEntityOrder<T extends { scope: string; region?: string; entity: GenericEntity }>(
  items: T[],
) {
  const groups = new Map<string, T[]>();
  items.forEach((item) => {
    const key = `${item.scope}|${item.region || "-"}|${item.entity.type || "UNKNOWN"}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  });
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group);
  const positions = orderedGroups.map(() => 0);
  const result: T[] = [];
  let remaining = items.length;
  while (remaining > 0) {
    orderedGroups.forEach((group, index) => {
      const item = group[positions[index]];
      if (!item) return;
      result.push(item);
      positions[index] += 1;
      remaining -= 1;
    });
  }
  return result;
}

type SpatialRegionSummary = {
  id: string;
  bounds: { min: { x: number; y: number }; max: { x: number; y: number } };
  entityCount: number;
  entityTypes: Record<string, number>;
  layers: Record<string, number>;
  annotations: string[];
  contentBounds: ReturnType<typeof entityBounds>;
  structuralBounds: ReturnType<typeof entityBounds>;
};

function spatialRegions(entities: GenericEntity[], bounds: ReturnType<typeof entityBounds>) {
  const regionByEntity = new WeakMap<object, string>();
  if (!bounds) return { summaries: [] as SpatialRegionSummary[], regionByEntity };
  const width = Math.max(1e-9, bounds.max.x - bounds.min.x);
  const height = Math.max(1e-9, bounds.max.y - bounds.min.y);
  const columns = width / height >= 1.35 ? 3 : 2;
  const rows = 2;
  const summaries: SpatialRegionSummary[] = Array.from({ length: columns * rows }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      id: `G${row + 1}${column + 1}`,
      bounds: {
        min: {
          x: bounds.min.x + (column * width) / columns,
          y: bounds.min.y + (row * height) / rows,
        },
        max: {
          x: bounds.min.x + ((column + 1) * width) / columns,
          y: bounds.min.y + ((row + 1) * height) / rows,
        },
      },
      entityCount: 0,
      entityTypes: {} as Record<string, number>,
      layers: {} as Record<string, number>,
      annotations: [] as string[],
      contentBounds: undefined as ReturnType<typeof entityBounds>,
      structuralBounds: undefined as ReturnType<typeof entityBounds>,
    };
  });
  const mergeBounds = (
    current: ReturnType<typeof entityBounds>,
    local: NonNullable<ReturnType<typeof entityBounds>>,
  ) =>
    current
      ? {
          min: {
            x: Math.min(current.min.x, local.min.x),
            y: Math.min(current.min.y, local.min.y),
            z: Math.min(current.min.z, local.min.z),
          },
          max: {
            x: Math.max(current.max.x, local.max.x),
            y: Math.max(current.max.y, local.max.y),
            z: Math.max(current.max.z, local.max.z),
          },
        }
      : local;
  const structuralLayer =
    /wall|sten|стен|peregorod|перегород|beton|бетон|cols?|колон|column|grid|ос[ьи]?|osi|axis|fl(?:oo|o)r[-_ ]?otln|slab|roof|кровл|контур/iu;
  const structuralTypes = new Set([
    "LINE",
    "LWPOLYLINE",
    "POLYLINE",
    "POLYLINE2D",
    "POLYLINE3D",
    "ARC",
    "SPLINE",
    "ELLIPSE",
  ]);
  entities.forEach((entity) => {
    const local = entityBounds([entity]);
    if (!local) return;
    const x = (local.min.x + local.max.x) / 2;
    const y = (local.min.y + local.max.y) / 2;
    const column = Math.min(
      columns - 1,
      Math.max(0, Math.floor(((x - bounds.min.x) / width) * columns)),
    );
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((y - bounds.min.y) / height) * rows)));
    const summary = summaries[row * columns + column];
    regionByEntity.set(entity, summary.id);
    summary.contentBounds = mergeBounds(summary.contentBounds, local);
    if (
      structuralTypes.has(entity.type || "") &&
      structuralLayer.test(String(entity.layer || ""))
    ) {
      const clipped = {
        min: {
          x: Math.max(local.min.x, summary.bounds.min.x),
          y: Math.max(local.min.y, summary.bounds.min.y),
          z: local.min.z,
        },
        max: {
          x: Math.min(local.max.x, summary.bounds.max.x),
          y: Math.min(local.max.y, summary.bounds.max.y),
          z: local.max.z,
        },
      };
      if (clipped.max.x >= clipped.min.x && clipped.max.y >= clipped.min.y) {
        summary.structuralBounds = mergeBounds(summary.structuralBounds, clipped);
      }
    }
    summary.entityCount += 1;
    const type = entity.type || "UNKNOWN";
    summary.entityTypes[type] = (summary.entityTypes[type] || 0) + 1;
    if (entity.layer) summary.layers[entity.layer] = (summary.layers[entity.layer] || 0) + 1;
    const annotation = textValue(entity);
    if (annotation && summary.annotations.length < 24) summary.annotations.push(annotation);
  });
  return { summaries, regionByEntity };
}

function planContourCandidates(
  entities: GenericEntity[],
  regionByEntity: WeakMap<object, string>,
  regionSummaries: Record<string, unknown>[],
  drawingBounds: ReturnType<typeof entityBounds>,
) {
  const planRegions = new Set(
    regionSummaries
      .filter(
        (region) =>
          Array.isArray(region.annotations) &&
          region.annotations.some(
            (value) =>
              typeof value === "string" && /(?:^|\W)(?:план|этаж|floor|plan)(?:\W|$)/iu.test(value),
          ),
      )
      .map((region) => String(region.id || "")),
  );
  const rejectedRegions = new Set(
    regionSummaries.flatMap((region) => {
      if (!Array.isArray(region.annotations)) return [];
      const annotation = region.annotations
        .filter((value): value is string => typeof value === "string")
        .join(" ");
      const containsPlan = /(?:^|\W)(?:план|этаж|floor|plan)(?:\W|$)/iu.test(annotation);
      const tableOnly = /экспликац|ведомост|спецификац|таблиц|schedule|specification/iu.test(
        annotation,
      );
      const nonPlanView = /фасад|разрез|elevation|section/iu.test(annotation);
      return tableOnly || (nonPlanView && !containsPlan) ? [String(region.id || "")] : [];
    }),
  );
  const drawingWidth = drawingBounds ? drawingBounds.max.x - drawingBounds.min.x : 0;
  const drawingHeight = drawingBounds ? drawingBounds.max.y - drawingBounds.min.y : 0;
  const ignoredLayer =
    /размер|dimension|\bdim\b|текст|text|штамп|рамк|border|format|формат|grid|ос[ьи]?|axis|мебел|furn|фасад|elevation|разрез|section/iu;
  const strongestLinearDimension = Math.max(
    0,
    ...entities.flatMap((entity) => {
      if (entity.type !== "DIMENSION") return [];
      const display = displayedDimension(entity);
      if (display?.angular) return [];
      const measured = measuredDimension(entity, false);
      return [display?.value, measured].filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value > 0,
      );
    }),
  );

  const candidates = entities
    .flatMap((entity, sourceIndex) => {
      if (
        !["LWPOLYLINE", "POLYLINE2D"].includes(entity.type || "") ||
        !Array.isArray(entity.vertices)
      )
        return [];
      const raw = entity.vertices.filter(finitePoint).slice(0, 240);
      if (raw.length < 3) return [];
      const minX = Math.min(...raw.map((point) => point.x));
      const maxX = Math.max(...raw.map((point) => point.x));
      const minY = Math.min(...raw.map((point) => point.y));
      const maxY = Math.max(...raw.map((point) => point.y));
      const width = maxX - minX;
      const depth = maxY - minY;
      if (width <= 0 || depth <= 0) return [];
      const tolerance = Math.max(width, depth) * 1e-6;
      const deduplicated = raw.filter(
        (point, index) =>
          index === 0 ||
          Math.hypot(point.x - raw[index - 1].x, point.y - raw[index - 1].y) > tolerance,
      );
      if (deduplicated.length < 3) return [];
      const first = deduplicated[0];
      const last = deduplicated[deduplicated.length - 1];
      const explicitlyClosed = typeof entity.flag === "number" && (entity.flag & 1) === 1;
      const repeatedEndpoint = Math.hypot(first.x - last.x, first.y - last.y) <= tolerance;
      if (!explicitlyClosed && !repeatedEndpoint) return [];
      const points = repeatedEndpoint ? deduplicated.slice(0, -1) : deduplicated;
      if (points.length < 3) return [];
      const signedArea =
        points.reduce((sum, point, index) => {
          const next = points[(index + 1) % points.length];
          return sum + point.x * next.y - next.x * point.y;
        }, 0) / 2;
      const area = Math.abs(signedArea);
      if (area <= width * depth * 0.002) return [];
      const region = regionByEntity.get(entity) || "";
      if (rejectedRegions.has(region)) return [];
      const layer = typeof entity.layer === "string" ? entity.layer : "0";
      if (ignoredLayer.test(layer)) return [];
      const fillsDrawing =
        drawingWidth > 0 &&
        drawingHeight > 0 &&
        width > drawingWidth * 0.72 &&
        depth > drawingHeight * 0.72;
      const compactness = area / (width * depth);
      const score =
        Math.log10(Math.max(1, area)) * 20 +
        Math.min(points.length, 24) * 2 +
        compactness * 45 +
        (planRegions.has(region) ? 180 : 0) -
        (fillsDrawing ? 220 : 0) -
        (Math.max(width, depth) / Math.max(1e-9, Math.min(width, depth)) > 18 ? 120 : 0);
      return [
        {
          handle: typeof entity.handle === "string" ? entity.handle : `polyline-${sourceIndex}`,
          layer,
          region,
          width,
          depth,
          area,
          compactness,
          closedBy: explicitlyClosed ? "flag" : "endpoint",
          vertices: points.map((point) => {
            const item = point as Point & { bulge?: unknown };
            return [
              point.x,
              point.y,
              typeof item.bulge === "number" && Number.isFinite(item.bulge) ? item.bulge : 0,
            ];
          }),
          score,
        },
      ];
    })
    .filter(
      (candidate) =>
        strongestLinearDimension <= 0 ||
        (Math.max(candidate.width, candidate.depth) >= strongestLinearDimension * 0.35 &&
          Math.min(candidate.width, candidate.depth) >= strongestLinearDimension * 0.075),
    )
    .sort((left, right) => right.score - left.score);
  const strongestCandidateScore = candidates[0]?.score || 0;
  return candidates
    .filter((candidate) => candidate.score >= strongestCandidateScore - 120)
    .slice(0, 20);
}

export function extractCadReconstructionContext(database: DwgDatabase) {
  const modelEntities = (database.entities || []) as unknown as GenericEntity[];
  const blockRecords = cadTableEntries(database, "BLOCK_RECORD");
  const layoutBlocks = blockRecords.filter((block) => blockIsPaperLayout(block.name));
  const definitionBlocks = blockRecords.filter((block) => !blockIsLayout(block.name));
  const allBlockEntities = definitionBlocks.flatMap((block) => {
    const entities = Array.isArray(block.entities) ? (block.entities as GenericEntity[]) : [];
    return entities;
  });
  const references = new Set<string>();
  const collectReference = (entity: GenericEntity) => {
    if (!["INSERT", "MINSERT"].includes(entity.type || "")) return;
    const name = typeof entity.name === "string" ? entity.name : entity.blockName;
    if (typeof name === "string" && name) references.add(name);
  };
  const layoutItems = layoutBlocks.flatMap((block) => {
    const name = String(block.name || "LAYOUT");
    const entities = Array.isArray(block.entities) ? (block.entities as GenericEntity[]) : [];
    return entities.map((entity) => ({ scope: `p:${name}`, entity }));
  });
  modelEntities.forEach(collectReference);
  layoutItems.forEach(({ entity }) => collectReference(entity));
  allBlockEntities.forEach(collectReference);
  const detailedBlocks = definitionBlocks.filter(
    (block) =>
      !generatedDimensionBlock(block.name) &&
      (references.has(String(block.name || "")) || definitionBlocks.length <= 40),
  );
  const detailedBlockItems = detailedBlocks.flatMap((block) => {
    const name = String(block.name || "UNNAMED");
    const entities = Array.isArray(block.entities) ? (block.entities as GenericEntity[]) : [];
    return entities.map((entity) => ({ scope: `b:${name}`, entity }));
  });
  const generatedDimensionEntityCount = definitionBlocks
    .filter((block) => generatedDimensionBlock(block.name))
    .reduce(
      (total, block) => total + (Array.isArray(block.entities) ? block.entities.length : 0),
      0,
    );
  const unreferencedBlockEntityCount = definitionBlocks
    .filter((block) => !generatedDimensionBlock(block.name) && !detailedBlocks.includes(block))
    .reduce(
      (total, block) => total + (Array.isArray(block.entities) ? block.entities.length : 0),
      0,
    );
  const insUnits = database.header?.INSUNITS;
  const modelSpaceBounds = headerBounds(database.header) || entityBounds(modelEntities);
  const regions = spatialRegions(modelEntities, modelSpaceBounds);
  const contourCandidates = planContourCandidates(
    modelEntities,
    regions.regionByEntity,
    regions.summaries,
    modelSpaceBounds,
  );
  const planScaleCandidates = ["1", "2"].flatMap((row) => {
    const rowRegions = regions.summaries.filter((region) => {
      if (region.id[1] !== row || !region.structuralBounds) return false;
      const annotation = region.annotations.join(" ");
      return (
        !/экспликац|ведомост|спецификац|таблиц|schedule|specification/iu.test(annotation) &&
        !(
          /фасад|разрез|elevation|section/iu.test(annotation) &&
          !/(?:^|\W)(?:план|этаж|floor|plan)(?:\W|$)/iu.test(annotation)
        )
      );
    });
    const hasPlanLabel = rowRegions.some((region) =>
      region.annotations.some((value) => /(?:^|\W)(?:план|этаж|floor|plan)(?:\W|$)/iu.test(value)),
    );
    if (!hasPlanLabel || !rowRegions.length) return [];
    const minX = Math.min(...rowRegions.map((region) => region.structuralBounds!.min.x));
    const maxX = Math.max(...rowRegions.map((region) => region.structuralBounds!.max.x));
    const minY = Math.min(...rowRegions.map((region) => region.structuralBounds!.min.y));
    const maxY = Math.max(...rowRegions.map((region) => region.structuralBounds!.max.y));
    const width = maxX - minX;
    const depth = maxY - minY;
    return [
      {
        regions: rowRegions.map((region) => region.id),
        structuralEnvelope: { width, depth },
        minimumPlausibleLongSpan: Math.max(width, depth) * 0.25,
        policy:
          "Approximate multi-region plan scale check only; explicit overall dimensions and verified footprints still rank higher.",
      },
    ];
  });
  const modelItems = modelEntities.map((entity) => ({
    scope: "m",
    region: regions.regionByEntity.get(entity),
    entity,
  }));
  const layoutAnnotations = layoutItems.filter(({ entity }) =>
    ["DIMENSION", "TEXT", "MTEXT", "ATTRIB", "ATTDEF", "TOLERANCE", "INSERT", "MINSERT"].includes(
      entity.type || "",
    ),
  );
  const scopedEntities = [
    ...balancedEntityOrder(modelItems),
    ...balancedEntityOrder(detailedBlockItems),
    ...balancedEntityOrder(layoutAnnotations),
  ];
  const identityItems: ScopedCadEntity[] = [
    ...modelItems,
    ...definitionBlocks.flatMap((block) => {
      const name = String(block.name || "UNNAMED");
      const entities = Array.isArray(block.entities) ? (block.entities as GenericEntity[]) : [];
      return entities.map((entity) => ({ scope: `b:${name}`, entity }));
    }),
    ...layoutItems,
  ];
  const dimensionConflicts = modelEntities
    .filter((entity) => entity.type === "DIMENSION")
    .map((entity) => {
      const display = displayedDimension(entity);
      if (!display) return undefined;
      const measured = measuredDimension(entity, display.angular);
      if (measured === undefined) return undefined;
      const tolerance = Math.max(0.01, display.value * 0.001);
      if (Math.abs(display.value - measured) <= tolerance) return undefined;
      return {
        handle: typeof entity.handle === "string" ? entity.handle : undefined,
        layer: entity.layer,
        displayedNominal: display.value,
        geometricAnchorMeasurement: measured,
        unit: display.angular ? "deg" : unitFromInsUnits(insUnits) || "unknown",
        policy:
          "Displayed nominal is the intended drawing value; anchor measurement is a consistency warning, not an automatic blocker.",
      };
    })
    .filter(Boolean)
    .slice(0, MAX_CAD_ARRAY_ITEMS);
  const context = {
    format: "AEDEXA_CAD_CONTEXT_V3",
    entitySchema: {
      common:
        "s=scope(m=model,b:<name>=block-local,p:<name>=paper/layout space), r=spatial grid, t=type, h=handle, l=layer, lt=linetype, lw=lineweight, ex=extrusion vector",
      geometry:
        "p/p1/p2/c/axis are [x,y,z]; v=polyline vertices [x,y,z,bulge?,startWidth?,endWidth?]; rad=radius; a1/a2=angles(rad); th=thickness; el=elevation",
      insert: "name=block, p=insertion point, sx/sy/sz=scales, rot=radians, attrs=attributes",
      dimension:
        "display=printed nominal, measurement=CAD anchor measurement, overrideConflict warns when they differ; printed nominal wins as design intent",
    },
    coordinatePolicy: {
      model: "s=m coordinates are model-space CAD coordinates.",
      blocks:
        "s=b:<name> coordinates are block-local. Apply matching INSERT/MINSERT point, scales and rotation (radians).",
      layouts:
        "s=p:<name> contains sheet/title-block annotations. Use it for document identity and view names, not as model geometry.",
      precision:
        "Numbers are unrounded. User values rank first; explicit displayed dimensions are project nominals; CAD anchor geometry checks consistency; raster is visual evidence only.",
    },
    imageSet:
      "Input images are ordered: full-sheet overview, then enlarged visual tiles left-to-right and top-to-bottom. CAD grid Gxy is coordinate-based; match it by geometry/annotations, not by assumed screen Y direction.",
    insUnits,
    recognizedUnit: unitFromInsUnits(insUnits) || "unknown",
    documentIdentity: documentIdentityEvidence(identityItems),
    entityCount: {
      modelSpace: modelEntities.length,
      blockDefinitions: allBlockEntities.length,
      layoutAnnotations: layoutAnnotations.length,
      total: modelEntities.length + allBlockEntities.length + layoutAnnotations.length,
      detailedCandidates: scopedEntities.length,
    },
    entityTypes: {
      modelSpace: entityTypeCounts(modelEntities),
      blockDefinitions: entityTypeCounts(allBlockEntities),
      layoutAnnotations: entityTypeCounts(layoutAnnotations.map(({ entity }) => entity)),
      total: entityTypeCounts([
        ...modelEntities,
        ...allBlockEntities,
        ...layoutAnnotations.map(({ entity }) => entity),
      ]),
    },
    modelSpaceBounds,
    spatialRegions: regions.summaries,
    planScaleCandidates,
    planContourCandidates: contourCandidates,
    dimensionConflicts,
    header: compactCadValue(database.header),
    tables: {
      layers: cadTableEntries(database, "LAYER")
        .slice(0, MAX_CAD_ARRAY_ITEMS)
        .map((entry) => compactCadValue(entry)),
      dimensionStyles: cadTableEntries(database, "DIMSTYLE")
        .slice(0, MAX_CAD_ARRAY_ITEMS)
        .map((entry) => compactCadValue(entry)),
      lineTypes: cadTableEntries(database, "LTYPE")
        .slice(0, MAX_CAD_ARRAY_ITEMS)
        .map((entry) => compactCadValue(entry)),
      textStyles: cadTableEntries(database, "STYLE")
        .slice(0, MAX_CAD_ARRAY_ITEMS)
        .map((entry) => compactCadValue(entry)),
    },
    blockDefinitions: definitionBlocks.slice(0, MAX_CAD_ARRAY_ITEMS).map((block) => {
      const entities = Array.isArray(block.entities) ? (block.entities as GenericEntity[]) : [];
      return {
        name: block.name,
        handle: block.handle,
        basePoint: pointTuple(block.basePoint),
        insertionUnits: block.insertionUnits,
        flags: block.flags,
        description: block.description,
        referenced: references.has(String(block.name || "")),
        generatedDimensionGraphics: generatedDimensionBlock(block.name),
        entityCount: entities.length,
        entityTypes: entityTypeCounts(entities),
        localBounds: entityBounds(entities),
      };
    }),
    layoutSpaces: layoutBlocks.slice(0, 40).map((block) => {
      const entities = Array.isArray(block.entities) ? (block.entities as GenericEntity[]) : [];
      return {
        name: block.name,
        handle: block.handle,
        entityCount: entities.length,
        entityTypes: entityTypeCounts(entities),
      };
    }),
    entities: [] as Record<string, unknown>[],
    truncation: {
      maxContextCharacters: MAX_CAD_CONTEXT_LENGTH,
      maxItemsPerNestedArray: MAX_CAD_ARRAY_ITEMS,
      entityRecordsIncluded: 0,
      entityRecordsOmitted: 0,
      modelSpaceRecordsIncluded: 0,
      blockDefinitionRecordsIncluded: 0,
      layoutSpaceRecordsIncluded: 0,
      generatedDimensionGraphicsExcluded: generatedDimensionEntityCount,
      unreferencedBlockRecordsExcluded: unreferencedBlockEntityCount,
      omittedEntityTypes: {} as Record<string, number>,
    },
  };

  const reserve = 12_000;
  let used = JSON.stringify(context).length;
  for (const item of scopedEntities) {
    const record = compactEntity(
      item.entity,
      item.scope,
      "region" in item && typeof item.region === "string" ? item.region : undefined,
    );
    const encodedLength = JSON.stringify(record).length + 1;
    if (used + encodedLength <= MAX_CAD_CONTEXT_LENGTH - reserve) {
      context.entities.push(record);
      used += encodedLength;
      continue;
    }
    const type = item.entity.type || "UNKNOWN";
    context.truncation.omittedEntityTypes[type] =
      (context.truncation.omittedEntityTypes[type] || 0) + 1;
  }
  context.truncation.entityRecordsIncluded = context.entities.length;
  context.truncation.entityRecordsOmitted = scopedEntities.length - context.entities.length;
  context.truncation.modelSpaceRecordsIncluded = context.entities.filter(
    (entity) => entity.s === "m",
  ).length;
  context.truncation.blockDefinitionRecordsIncluded = context.entities.filter((entity) =>
    String(entity.s).startsWith("b:"),
  ).length;
  context.truncation.layoutSpaceRecordsIncluded = context.entities.filter((entity) =>
    String(entity.s).startsWith("p:"),
  ).length;

  let result = JSON.stringify(context);
  while (result.length > MAX_CAD_CONTEXT_LENGTH && context.entities.length) {
    const removed = context.entities.pop();
    const type = typeof removed?.t === "string" ? removed.t : "UNKNOWN";
    context.truncation.omittedEntityTypes[type] =
      (context.truncation.omittedEntityTypes[type] || 0) + 1;
    context.truncation.entityRecordsIncluded = context.entities.length;
    context.truncation.entityRecordsOmitted = scopedEntities.length - context.entities.length;
    context.truncation.modelSpaceRecordsIncluded = context.entities.filter(
      (entity) => entity.s === "m",
    ).length;
    context.truncation.blockDefinitionRecordsIncluded = context.entities.filter((entity) =>
      String(entity.s).startsWith("b:"),
    ).length;
    context.truncation.layoutSpaceRecordsIncluded = context.entities.filter((entity) =>
      String(entity.s).startsWith("p:"),
    ).length;
    result = JSON.stringify(context);
  }
  return result;
}

function cadExactModel(database: DwgDatabase, sourceName: string): ReconstructionModel | undefined {
  const unit = unitFromInsUnits(database.header?.INSUNITS);
  if (!unit) return undefined;
  const entities = (database.entities || []) as unknown as GenericEntity[];
  const relevant = entities.filter(
    (entity) =>
      entity.type === "3DFACE" ||
      (entity.type === "LWPOLYLINE" &&
        typeof entity.thickness === "number" &&
        Math.abs(entity.thickness as number) > 1e-9) ||
      (entity.type === "CIRCLE" &&
        typeof entity.thickness === "number" &&
        Math.abs(entity.thickness as number) > 1e-9),
  );
  if (!relevant.length) return undefined;

  const points = relevant.flatMap(entityPoints);
  const bounds = pointBounds(points);
  const centerX = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
  const centerY = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
  const parts: ReconstructionPart[] = [];
  let colorIndex = 0;

  entities.forEach((entity, index) => {
    if (
      entity.type === "LWPOLYLINE" &&
      typeof entity.flag === "number" &&
      ((entity.flag as number) & 1) === 1 &&
      typeof entity.thickness === "number" &&
      Math.abs(entity.thickness as number) > 1e-9
    ) {
      const vertices = (Array.isArray(entity.vertices) ? entity.vertices : []).filter(finitePoint);
      if (vertices.length < 3) return;
      const localX =
        (Math.min(...vertices.map((point) => point.x)) +
          Math.max(...vertices.map((point) => point.x))) /
        2;
      const localY =
        (Math.min(...vertices.map((point) => point.y)) +
          Math.max(...vertices.map((point) => point.y))) /
        2;
      const height = Math.abs(entity.thickness as number);
      parts.push({
        id: `cad-profile-${index}`,
        name: `Профиль ${parts.length + 1}${entity.layer ? ` · ${entity.layer}` : ""}`,
        kind: "extrusion",
        position: {
          x: localX - centerX,
          y: Number(entity.elevation || 0) + height / 2,
          z: localY - centerY,
        },
        rotationDegrees: { x: 0, y: 0, z: 0 },
        size: { x: 0, y: 0, z: 0 },
        radius: 0,
        height,
        profile: vertices
          .slice(0, 240)
          .map((point) => ({ x: point.x - localX, z: point.y - localY })),
        holes: [],
        vertices: [],
        faces: [],
        color: partColors[colorIndex++ % partColors.length],
        confidence: 1,
        evidence: ["Замкнутый CAD-профиль и его толщина прочитаны напрямую из файла."],
      });
    }

    if (
      entity.type === "CIRCLE" &&
      finitePoint(entity.center) &&
      typeof entity.radius === "number" &&
      entity.radius > 0 &&
      typeof entity.thickness === "number" &&
      Math.abs(entity.thickness as number) > 1e-9
    ) {
      const height = Math.abs(entity.thickness as number);
      const center = entity.center as Point;
      parts.push({
        id: `cad-cylinder-${index}`,
        name: `Цилиндр ${parts.length + 1}${entity.layer ? ` · ${entity.layer}` : ""}`,
        kind: "cylinder",
        position: { x: center.x - centerX, y: (center.z || 0) + height / 2, z: center.y - centerY },
        rotationDegrees: { x: 0, y: 0, z: 0 },
        size: { x: 0, y: 0, z: 0 },
        radius: entity.radius as number,
        height,
        profile: [],
        holes: [],
        vertices: [],
        faces: [],
        color: partColors[colorIndex++ % partColors.length],
        confidence: 1,
        evidence: ["Радиус и толщина окружности прочитаны напрямую из CAD."],
      });
    }
  });

  const faceEntities = entities.filter((entity) => entity.type === "3DFACE").slice(0, 5_000);
  if (faceEntities.length) {
    const vertices: ReconstructionVector3[] = [];
    const faces: { a: number; b: number; c: number }[] = [];
    faceEntities.forEach((entity) => {
      const corners = [entity.corner1, entity.corner2, entity.corner3, entity.corner4].filter(
        finitePoint,
      );
      if (corners.length < 3) return;
      const offset = vertices.length;
      corners.forEach((point) =>
        vertices.push({ x: point.x - centerX, y: point.z || 0, z: point.y - centerY }),
      );
      faces.push({ a: offset, b: offset + 1, c: offset + 2 });
      if (
        corners.length === 4 &&
        (corners[3].x !== corners[2].x ||
          corners[3].y !== corners[2].y ||
          (corners[3].z || 0) !== (corners[2].z || 0))
      ) {
        faces.push({ a: offset, b: offset + 2, c: offset + 3 });
      }
    });
    if (faces.length)
      parts.push({
        id: "cad-face-mesh",
        name: "Точная сетка 3DFACE",
        kind: "mesh",
        position: { x: 0, y: 0, z: 0 },
        rotationDegrees: { x: 0, y: 0, z: 0 },
        size: { x: 0, y: 0, z: 0 },
        radius: 0,
        height: 0,
        profile: [],
        holes: [],
        vertices,
        faces,
        color: partColors[colorIndex % partColors.length],
        confidence: 1,
        evidence: [`${faces.length} граней прочитаны напрямую из CAD без AI-реконструкции.`],
      });
  }

  if (!parts.length) return undefined;
  const hasUnsupportedSolid = entities.some((entity) => entity.type === "3DSOLID");
  const faceLimitReached =
    entities.filter((entity) => entity.type === "3DFACE").length > faceEntities.length;
  const unresolved = [
    ...(hasUnsupportedSolid
      ? [
          {
            id: "acis-solid",
            label: "Тело ACIS",
            reason: "Файл содержит закрытую 3DSOLID-геометрию в проприетарном представлении ACIS.",
            requiredFromUser:
              "Экспортируйте это тело из AutoCAD в STEP/OBJ/GLB или приложите размерные виды.",
            severity: "critical" as const,
          },
        ]
      : []),
    ...(faceLimitReached
      ? [
          {
            id: "face-limit",
            label: "Слишком плотная сетка",
            reason: "Для безопасной работы в браузере прочитаны первые 5000 объектов 3DFACE.",
            requiredFromUser: "Упростите сетку или экспортируйте исходную модель в GLB.",
            severity: "critical" as const,
          },
        ]
      : []),
  ];
  const status = unresolved.length ? "needs_input" : "ready";

  return parseReconstructionModel({
    version: "1.0",
    sourceName,
    method: "cad_exact",
    status,
    title: sourceName.replace(/\.[^.]+$/, ""),
    unit,
    summary: unresolved.length
      ? "Прямая CAD-геометрия построена частично; часть исходных тел требует другого формата."
      : "Объёмная геометрия прочитана напрямую из координат, толщин и граней CAD-файла без генеративных допущений.",
    detectedViews: ["Пространство модели CAD"],
    dimensions: cadDimensions(entities, unit),
    parts,
    unresolved,
    warnings: hasUnsupportedSolid
      ? ["3DSOLID/ACIS не преобразуется в сетку этим браузерным парсером."]
      : [],
    overallConfidence: unresolved.length ? 0.72 : 1,
    canExport: unresolved.length === 0,
  });
}

async function prepareCad(file: File): Promise<PreparedDrawing> {
  const { LibreDwg, Dwg_File_Type } = await import("@mlightcad/libredwg-web");
  const parser = await LibreDwg.create("/libredwg/");
  const data = await file.arrayBuffer();
  const pointer = parser.dwg_read_data(data, Dwg_File_Type.DWG);
  if (!pointer) throw new Error("CAD-файл не распознан или повреждён.");
  try {
    let database;
    try {
      database = parser.convert(pointer);
    } catch {
      throw new Error(
        "CAD-файл повреждён или не содержит читаемой модели. Проверьте его в CAD-программе и сохраните повторно.",
      );
    }
    if (!database || !Array.isArray(database.entities) || database.entities.length === 0) {
      throw new Error(
        "CAD-файл повреждён или не содержит читаемой модели. Проверьте его в CAD-программе и сохраните повторно.",
      );
    }
    const previewDatabase = cadPreviewDatabase(database);
    const bounds =
      headerBounds(previewDatabase.header) ||
      entityBounds(previewDatabase.entities as unknown as GenericEntity[]);
    const svg = repairCadSvg(parser.dwg_to_svg(previewDatabase), bounds);
    const rendered = await svgToCadDataUrls(svg);
    return {
      name: file.name,
      sourceKind: "cad",
      previewDataUrl: rendered.overview,
      apiDataUrl: rendered.overview,
      apiDataUrls: rendered.images,
      context: extractCadReconstructionContext(database),
      exactModel: cadExactModel(database, file.name),
    };
  } finally {
    parser.dwg_free(pointer);
  }
}

export async function prepareDrawing(file: File): Promise<PreparedDrawing> {
  const ext = extension(file.name);
  const isCad = ext === "dwg" || ext === "dxf";
  if (file.size <= 0) throw new Error("Файл пустой.");
  if (file.size > (isCad ? CAD_LIMIT : IMAGE_LIMIT)) {
    throw new Error(isCad ? "CAD-файл превышает 80 МБ." : "Изображение превышает 15 МБ.");
  }

  // TODO: читать DXF и здесь, пока только DWG
  if (ext === "dxf") {
    throw new Error(
      "DXF доступен в модуле посадки. Для реконструкции сохраните этот чертёж как DWG либо загрузите PNG или JPEG с нужными видами.",
    );
  }
  if (isCad) return prepareCad(file);
  if (ext === "pdf" || file.type === "application/pdf") {
    throw new Error(
      "PDF модель не принимает. Экспортируйте нужные виды в PNG или JPEG и загрузите изображение.",
    );
  }
  if (ext === "svg" || file.type === "image/svg+xml") {
    const previewDataUrl = await svgToDataUrl(await file.text());
    return {
      name: file.name,
      sourceKind: "svg",
      previewDataUrl,
      apiDataUrl: previewDataUrl,
      context: "",
    };
  }
  if (["png", "jpg", "jpeg", "webp"].includes(ext) || /^image\/(png|jpeg|webp)$/.test(file.type)) {
    const rawUrl = URL.createObjectURL(file);
    try {
      const previewDataUrl = await rasterize(rawUrl);
      return {
        name: file.name,
        sourceKind: "image",
        previewDataUrl,
        apiDataUrl: previewDataUrl,
        context: "",
      };
    } finally {
      URL.revokeObjectURL(rawUrl);
    }
  }
  throw new Error("Поддерживаются DWG, SVG, PNG, JPEG и WEBP.");
}
