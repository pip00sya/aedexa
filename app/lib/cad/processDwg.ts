import { median as medianNumber, percentile } from "../math/statistics";
import { record, type UnknownRecord } from "../untrusted";
import { createBuildingMask } from "./buildingMask";
import {
  classifyCadItem,
  demoteHatchOutlines,
  isElevationLayer,
  recognizeCadObject,
} from "./classification";
import {
  aciToRgb,
  cadColorFamily,
  effectiveCadColor,
  findMixedColorLayers,
  lineWeightMillimetres,
  packRgb,
  type CadColorRef,
} from "./color";
import { expandBulges, mtextLines, primitiveBounds } from "./drawing";
import { attachLabelsToFeatures, collectDrawingTexts } from "./drawingTexts";
import { buildRoadBetweenEdges } from "./roadBetweenEdges";
import { buildTerrainModel, parseElevationLabel, placeFeaturesOnTerrain } from "./terrain";
import type {
  CadBounds,
  CadDrawing,
  CadDrawingPrimitive,
  CadFeature,
  CadLayerSummary,
  CadPoint,
  CadPreflightReport,
  CadProcessingResult,
  CadSpatialReference,
  CadTerrainGrid,
} from "./types";

const MAX_FEATURES = 90_000;
const MAX_EXPANDED_ENTITIES = 120_000;
const MAX_DRAWING_ENTITIES = 400_000;

type CadTransform = {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  zScale: number;
  tz: number;
};

const identityTransform: CadTransform = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  tx: 0,
  ty: 0,
  zScale: 1,
  tz: 0,
};

type ElevationAnnotationEntity = {
  type?: unknown;
  layer?: unknown;
  text?: unknown;
  startPoint?: unknown;
  insertionPoint?: unknown;
};

function colorRef(value: UnknownRecord): CadColorRef {
  const color = finite(value.color, Number.NaN);
  const colorIndex = finite(value.colorIndex, Number.NaN);
  return {
    color: Number.isFinite(color) ? color : undefined,
    colorIndex: Number.isFinite(colorIndex) ? colorIndex : undefined,
  };
}

function finite(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function transformFrom(value: unknown) {
  const candidate = record(value);
  return candidate.__cadTransform as CadTransform | undefined;
}

function transformPoint(value: CadPoint, transform?: CadTransform): CadPoint {
  if (!transform) return value;
  return {
    x: transform.a * value.x + transform.c * value.y + transform.tx,
    y: transform.b * value.x + transform.d * value.y + transform.ty,
    z: transform.zScale * value.z + transform.tz,
    zExplicit: value.zExplicit,
  };
}

function composeTransform(parent: CadTransform, child: CadTransform): CadTransform {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
    zScale: parent.zScale * child.zScale,
    tz: parent.zScale * child.tz + parent.tz,
  };
}

function insertTransform(entity: UnknownRecord, block: UnknownRecord): CadTransform | undefined {
  const insertion = point(entity.insertionPoint);
  if (!insertion) return undefined;
  const base = point(block.basePoint) ?? { x: 0, y: 0, z: 0 };
  const xScale = finite(entity.xScale, 1);
  const yScale = finite(entity.yScale, 1);
  const zScale = finite(entity.zScale, 1);
  const rotation = finite(entity.rotation);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const a = xScale * cos;
  const b = xScale * sin;
  const c = -yScale * sin;
  const d = yScale * cos;
  return {
    a,
    b,
    c,
    d,
    tx: insertion.x - a * base.x - c * base.y,
    ty: insertion.y - b * base.x - d * base.y,
    zScale,
    tz: insertion.z - zScale * base.z,
  };
}

function blockIsContainer(block: UnknownRecord, layer: string, blockName: string, depth: number) {
  const entities = Array.isArray(block.entities) ? block.entities.map(record) : [];
  const namedAsDrawing = /(xref|survey|topo|топо|с[ъь]ём|геодез|рельеф|основа|base|генплан)/iu.test(
    `${layer} ${blockName}`,
  );
  if (isElevationLayer(layer) || namedAsDrawing) return entities.length > 0;
  return depth === 0 && layer === "0" && entities.length >= 500;
}

export type CadBlockStyle = {
  color?: CadColorRef;
  layer: string;
  lineweight?: number;
  lineType?: string;
};

export type ExpandCadBlockOptions = {
  all?: boolean;
  hiddenLayers?: Set<string>;
};

export function expandCadBlockEntities(
  sourceEntities: UnknownRecord[],
  blockEntries: UnknownRecord[],
  limit = MAX_EXPANDED_ENTITIES,
  options: ExpandCadBlockOptions = {},
) {
  const blocks = new Map(blockEntries.map((entry) => [String(entry.name ?? ""), entry]));
  const expanded: UnknownRecord[] = [];
  const maxDepth = options.all ? 8 : 5;
  const ownIndex = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 255;
  const blockStyleOf = (
    entity: UnknownRecord,
    layer: string,
    parent?: CadBlockStyle,
  ): CadBlockStyle => {
    const color = colorRef(entity);
    const rgb =
      color.color !== undefined && Number.isFinite(color.color) && color.color > 0
        ? color.color
        : undefined;
    const resolvedColor =
      rgb !== undefined || ownIndex(color.colorIndex)
        ? { color: rgb, colorIndex: ownIndex(color.colorIndex) ? color.colorIndex : undefined }
        : color.colorIndex === 0 && parent
          ? parent.color
          : undefined;
    const lineweight = finite(entity.lineweight, Number.NaN);
    const lineType =
      typeof entity.lineType === "string" &&
      !/^by(layer|block)$/iu.test(entity.lineType) &&
      entity.lineType
        ? entity.lineType
        : /^byblock$/iu.test(String(entity.lineType ?? ""))
          ? parent?.lineType
          : undefined;
    return {
      color: resolvedColor,
      layer: color.colorIndex === 0 && parent ? parent.layer : layer,
      lineweight:
        Number.isFinite(lineweight) && lineweight >= 0 && lineweight <= 23
          ? lineweight
          : lineweight === 30
            ? parent?.lineweight
            : undefined,
      lineType,
    };
  };

  const visit = (
    entity: UnknownRecord,
    parentTransform: CadTransform,
    inheritedLayer: string | undefined,
    depth: number,
    path: string[],
    blockStyle?: CadBlockStyle,
  ) => {
    if (expanded.length >= limit) return;
    const rawLayer = String(entity.layer ?? "0");
    const layer = rawLayer === "0" && inheritedLayer ? inheritedLayer : rawLayer;
    const type = String(entity.type ?? "").toUpperCase();
    if (options.all && type === "ATTDEF") return;
    const blockName = String(entity.name ?? "");
    const decorate = (item: UnknownRecord): UnknownRecord => ({
      ...item,
      layer,
      __cadTransform: parentTransform,
      __cadBlockPath: path,
      ...(blockStyle ? { __cadBlockStyle: blockStyle } : {}),
    });

    if (options.all && type === "DIMENSION") {
      const block = blocks.get(blockName);
      const children = block && Array.isArray(block.entities) ? block.entities.map(record) : [];
      if (children.length && depth < maxDepth) {
        if (options.hiddenLayers?.has(layer)) return;
        const style = blockStyleOf(entity, layer, blockStyle);
        for (const child of children) {
          visit(child, parentTransform, layer, depth + 1, [...path, blockName], style);
          if (expanded.length >= limit) break;
        }
        return;
      }
      expanded.push(decorate(entity));
      return;
    }

    const block = type === "INSERT" ? blocks.get(blockName) : undefined;
    const children = block && Array.isArray(block.entities) ? block.entities.map(record) : [];
    const canExpand = Boolean(
      block &&
        children.length &&
        depth < maxDepth &&
        (options.all || blockIsContainer(block, layer, blockName, depth)),
    );

    if (!canExpand) {
      expanded.push(decorate(entity));
      return;
    }

    const localTransform = insertTransform(entity, block!);
    if (!localTransform) {
      expanded.push(decorate(entity));
      return;
    }
    if (options.all && options.hiddenLayers?.has(layer)) return;
    const transform = composeTransform(parentTransform, localTransform);
    const nextPath = [...path, blockName];
    const style = options.all ? blockStyleOf(entity, layer, blockStyle) : undefined;
    if (options.all) {
      // Значения атрибутов вставки хранятся уже в мировых координатах
      const attribs = Array.isArray(entity.attribs) ? entity.attribs.map(record) : [];
      for (const attrib of attribs) {
        const nested = record(attrib.text);
        const flat =
          typeof attrib.text === "string" ? attrib : { ...attrib, ...nested, text: nested.text };
        if (finite(attrib.flags) & 1) continue; // невидимый атрибут
        expanded.push({
          ...flat,
          type: "ATTRIB",
          layer: String(attrib.layer ?? layer) === "0" ? layer : String(attrib.layer ?? layer),
          __cadTransform: parentTransform,
          __cadBlockPath: nextPath,
          __cadBlockStyle: style,
        });
      }
    }
    for (const child of children) {
      visit(child, transform, layer, depth + 1, nextPath, style);
      if (expanded.length >= limit) break;
    }
  };

  for (const entity of sourceEntities) {
    visit(entity, identityTransform, undefined, 0, []);
    if (expanded.length >= limit) break;
  }
  return expanded;
}

function sourceUnitsPerMeter(unitLabel: string) {
  if (unitLabel === "мм") return 1_000;
  if (unitLabel === "см") return 100;
  if (unitLabel === "км") return 0.001;
  if (unitLabel === "футы") return 3.28084;
  if (unitLabel === "дюймы") return 39.3701;
  return 1;
}

function point(value: unknown, defaultZ = 0): CadPoint | undefined {
  const candidate = record(value);
  const x = finite(candidate.x, Number.NaN);
  const y = finite(candidate.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const explicitZ =
    candidate.z !== undefined && candidate.z !== null && Number.isFinite(Number(candidate.z));
  return { x, y, z: explicitZ ? finite(candidate.z) : defaultZ, zExplicit: explicitZ };
}

function closeEnough(a: CadPoint, b: CadPoint) {
  const scale = Math.max(1, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y));
  return Math.abs(a.x - b.x) / scale < 1e-8 && Math.abs(a.y - b.y) / scale < 1e-8;
}

function makeArc(
  centerValue: unknown,
  radiusValue: unknown,
  startValue: unknown = 0,
  endValue: unknown = Math.PI * 2,
  defaultZ = 0,
) {
  const center = point(centerValue, defaultZ);
  const radius = Math.abs(finite(radiusValue));
  if (!center || radius <= 0) return [];
  const start = finite(startValue);
  let end = finite(endValue, Math.PI * 2);
  if (end <= start) end += Math.PI * 2;
  const segments = Math.max(16, Math.min(64, Math.ceil(Math.abs(end - start) * 10)));
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = start + ((end - start) * index) / segments;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      z: center.z,
      zExplicit: center.zExplicit,
    };
  });
}

function hatchPoints(entity: UnknownRecord) {
  const paths = Array.isArray(entity.boundaryPaths) ? entity.boundaryPaths : [];
  const firstPath = paths.map(record).find((path) => Array.isArray(path.edges));
  if (!firstPath) return [];
  const edges = (firstPath.edges as unknown[]).map(record);
  const result: CadPoint[] = [];
  for (const edge of edges) {
    const edgeType = finite(edge.type);
    if (edgeType === 1) {
      const start = point(edge.start);
      const end = point(edge.end);
      if (start && (!result.length || !closeEnough(result[result.length - 1], start)))
        result.push(start);
      if (end) result.push(end);
    } else if (edgeType === 2) {
      result.push(...makeArc(edge.center, edge.radius, edge.startAngle, edge.endAngle));
    }
  }
  return result;
}

function entityPoints(entity: UnknownRecord): CadPoint[] {
  const type = String(entity.type ?? "").toUpperCase();
  const transform = transformFrom(entity);
  const finish = (values: CadPoint[]) => values.map((value) => transformPoint(value, transform));
  const elevation = finite(entity.elevation);
  const elevationExplicit =
    entity.elevation !== undefined &&
    entity.elevation !== null &&
    Number.isFinite(Number(entity.elevation));
  if (/^(LWPOLYLINE|POLYLINE2D|POLYLINE3D)$/u.test(type)) {
    const vertices = Array.isArray(entity.vertices) ? entity.vertices : [];
    const bulges = vertices.map((vertex) => finite(record(vertex).bulge, 0));
    const flag = finite(entity.flag);
    const closedPolyline =
      type === "LWPOLYLINE" ? (flag & 512) === 512 || (flag & 1) === 1 : (flag & 1) === 1;
    const parsedVertices = vertices
      .map((vertex) => {
        const value = record(vertex);
        const parsed = point(value.position ?? value, elevation);
        if (
          parsed &&
          elevationExplicit &&
          (!parsed.zExplicit ||
            (type !== "POLYLINE3D" && Math.abs(parsed.z) < 1e-9 && Math.abs(elevation) > 1e-9))
        ) {
          parsed.z = elevation;
          parsed.zExplicit = true;
        }
        return parsed;
      })
      .filter((value): value is CadPoint => Boolean(value));
    const withArcs =
      bulges.some((bulge) => Math.abs(bulge) > 1e-9) && parsedVertices.length === vertices.length
        ? expandBulges(parsedVertices, bulges, closedPolyline).map((value) =>
            "z" in value ? value : { ...value, z: elevation, zExplicit: elevationExplicit },
          )
        : parsedVertices;
    return finish(withArcs);
  }
  if (type === "LINE") {
    return finish(
      [point(entity.startPoint), point(entity.endPoint)].filter((value): value is CadPoint =>
        Boolean(value),
      ),
    );
  }
  if (type === "POINT")
    return finish([point(entity.position)].filter((value): value is CadPoint => Boolean(value)));
  if (type === "INSERT") {
    return finish(
      [point(entity.insertionPoint)].filter((value): value is CadPoint => Boolean(value)),
    );
  }
  if (type === "TEXT")
    return finish([point(entity.startPoint)].filter((value): value is CadPoint => Boolean(value)));
  if (type === "MTEXT")
    return finish(
      [point(entity.insertionPoint)].filter((value): value is CadPoint => Boolean(value)),
    );
  if (type === "CIRCLE") return finish(makeArc(entity.center, entity.radius));
  if (type === "ARC")
    return finish(makeArc(entity.center, entity.radius, entity.startAngle, entity.endAngle));
  if (type === "ELLIPSE") {
    const center = point(entity.center);
    const major = point(entity.majorAxisEndPoint);
    if (!center || !major) return [];
    const majorRadius = Math.hypot(major.x, major.y);
    const ratio = Math.abs(finite(entity.axisRatio, 1));
    const rotation = Math.atan2(major.y, major.x);
    const start = finite(entity.startAngle);
    let end = finite(entity.endAngle, Math.PI * 2);
    if (end <= start) end += Math.PI * 2;
    return finish(
      Array.from({ length: 49 }, (_, index) => {
        const angle = start + ((end - start) * index) / 48;
        const localX = Math.cos(angle) * majorRadius;
        const localY = Math.sin(angle) * majorRadius * ratio;
        return {
          x: center.x + localX * Math.cos(rotation) - localY * Math.sin(rotation),
          y: center.y + localX * Math.sin(rotation) + localY * Math.cos(rotation),
          z: center.z,
          zExplicit: center.zExplicit,
        };
      }),
    );
  }
  if (type === "SPLINE") {
    const values =
      Array.isArray(entity.fitPoints) && entity.fitPoints.length
        ? entity.fitPoints
        : Array.isArray(entity.controlPoints)
          ? entity.controlPoints
          : [];
    return finish(
      values.map((value) => point(value)).filter((value): value is CadPoint => Boolean(value)),
    );
  }
  if (type === "HATCH") return finish(hatchPoints(entity));
  if (/^(3DFACE|SOLID|TRACE)$/u.test(type)) {
    return finish(
      [
        "corner1",
        "corner2",
        "corner3",
        "corner4",
        "firstCorner",
        "secondCorner",
        "thirdCorner",
        "fourthCorner",
      ]
        .map((key) => point(entity[key]))
        .filter((value): value is CadPoint => Boolean(value)),
    );
  }
  return [];
}

type DrawingContext = {
  layerColors: Map<string, CadColorRef>;
  layerStyles: Map<string, { lineweight?: number; lineType?: string }>;
  hiddenLayers: Set<string>;
  ltypeDashes: Map<string, number[]>;
  ltScale: number;
  unitsPerMeter: number;
  /** Стили текста: коэффициент ширины и наклон букв */
  textStyles?: Map<string, { widthFactor?: number; obliqueAngle?: number }>;
  /** Размер стрелки выносок в единицах чертежа (DIMASZ × DIMSCALE) */
  arrowSize?: number;
};

const DRAWING_FOREGROUND = 0xffffff;

function aciOrForeground(index: number) {
  if (index === 7) return DRAWING_FOREGROUND;
  const rgb = aciToRgb(index);
  return rgb ? packRgb(rgb) : DRAWING_FOREGROUND;
}

const drawingLineworkTypes =
  /^(LINE|LWPOLYLINE|POLYLINE2D|POLYLINE3D|ARC|CIRCLE|ELLIPSE|SPLINE|3DFACE|SOLID|TRACE|POINT)$/u;

function angleDegrees(value: unknown) {
  const angle = finite(value, 0);
  return Math.abs(angle) > 6.3 ? angle : (angle * 180) / Math.PI;
}

function flatPoints(points: CadPoint[]) {
  const flat: number[] = [];
  const step = points.length > 4_000 ? points.length / 4_000 : 1;
  for (let index = 0; index < points.length; index += step) {
    const point = points[Math.floor(index)];
    flat.push(point.x, point.y);
  }
  return flat;
}

function hatchLoops(entity: UnknownRecord): CadPoint[][] {
  const paths = Array.isArray(entity.boundaryPaths) ? entity.boundaryPaths.map(record) : [];
  const transform = transformFrom(entity);
  const loops: CadPoint[][] = [];
  for (const path of paths) {
    let loop: CadPoint[] = [];
    if (Array.isArray(path.vertices)) {
      const vertices = path.vertices
        .map(record)
        .map((vertex) => point(vertex))
        .filter((value): value is CadPoint => Boolean(value));
      const bulges = path.vertices.map((vertex: unknown) => finite(record(vertex).bulge, 0));
      loop =
        vertices.length === path.vertices.length
          ? expandBulges(vertices, bulges, true).map((value) =>
              "z" in value ? value : { ...value, z: 0 },
            )
          : vertices;
    } else if (Array.isArray(path.edges)) {
      for (const edge of path.edges.map(record)) {
        const edgeType = finite(edge.type);
        if (edgeType === 1) {
          const start = point(edge.start);
          const end = point(edge.end);
          if (start && (!loop.length || !closeEnough(loop[loop.length - 1], start)))
            loop.push(start);
          if (end) loop.push(end);
        } else if (edgeType === 2) {
          loop.push(...makeArc(edge.center, edge.radius, edge.startAngle, edge.endAngle));
        } else if (edgeType === 3) {
          const center = point(edge.center);
          const major = point(edge.end);
          if (center && major) {
            const majorRadius = Math.hypot(major.x, major.y);
            const ratio = Math.abs(finite(edge.lengthOfMinorAxis, 1));
            const rotation = Math.atan2(major.y, major.x);
            const start = finite(edge.startAngle);
            let end = finite(edge.endAngle, Math.PI * 2);
            if (end <= start) end += Math.PI * 2;
            for (let index = 0; index <= 32; index += 1) {
              const angle = start + ((end - start) * index) / 32;
              const localX = Math.cos(angle) * majorRadius;
              const localY = Math.sin(angle) * majorRadius * ratio;
              loop.push({
                x: center.x + localX * Math.cos(rotation) - localY * Math.sin(rotation),
                y: center.y + localX * Math.sin(rotation) + localY * Math.cos(rotation),
                z: 0,
              });
            }
          }
        } else if (edgeType === 4) {
          const control =
            Array.isArray(edge.fitDatum) && edge.fitDatum.length
              ? edge.fitDatum
              : Array.isArray(edge.controlPoints)
                ? edge.controlPoints
                : [];
          loop.push(
            ...control
              .map((value: unknown) => point(value))
              .filter((value: CadPoint | undefined): value is CadPoint => Boolean(value)),
          );
        }
      }
    }
    if (loop.length >= 3) loops.push(loop.map((value) => transformPoint(value, transform)));
  }
  return loops;
}

function buildDrawing(entities: UnknownRecord[], context: DrawingContext): CadDrawing {
  const primitives: CadDrawingPrimitive[] = [];
  let omitted = 0;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const ownIndex = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 255;
  const layerRgb = (layer: string) => {
    const ref = context.layerColors.get(layer);
    if (!ref) return DRAWING_FOREGROUND;
    if (ownIndex(ref.colorIndex)) return aciOrForeground(ref.colorIndex);
    return ref.color !== undefined &&
      Number.isFinite(ref.color) &&
      ref.color > 0 &&
      ref.color !== 0xffffff
      ? ref.color
      : DRAWING_FOREGROUND;
  };
  const blockStyleOf = (entity: UnknownRecord) =>
    entity.__cadBlockStyle as CadBlockStyle | undefined;
  const rgbOf = (entity: UnknownRecord, layer: string): number => {
    const own = colorRef(entity);
    if (own.color !== undefined && Number.isFinite(own.color)) {
      if (own.color > 0) return own.color;
      return DRAWING_FOREGROUND; // истинный черный - цвет переднего плана
    }
    if (ownIndex(own.colorIndex)) return aciOrForeground(own.colorIndex);
    if (own.colorIndex === 0) {
      // По блоку: цвет вставки, а если она "по слою" - цвет ее слоя
      const style = blockStyleOf(entity);
      if (style?.color?.color !== undefined && style.color.color > 0) return style.color.color;
      if (style && ownIndex(style.color?.colorIndex))
        return aciOrForeground(style.color!.colorIndex as number);
      return layerRgb(style?.layer ?? layer);
    }
    return layerRgb(layer);
  };
  const weightOf = (entity: UnknownRecord, layer: string) => {
    const own = finite(entity.lineweight, Number.NaN);
    const layerStyle = context.layerStyles.get(layer);
    if (own === 30) {
      const style = blockStyleOf(entity);
      if (style?.lineweight !== undefined) return lineWeightMillimetres(style.lineweight);
      return lineWeightMillimetres(
        undefined,
        context.layerStyles.get(style?.layer ?? layer)?.lineweight,
      );
    }
    return lineWeightMillimetres(Number.isFinite(own) ? own : undefined, layerStyle?.lineweight);
  };
  const dashOf = (entity: UnknownRecord, layer: string) => {
    const raw = typeof entity.lineType === "string" ? entity.lineType : "";
    const own =
      raw && !/^by(layer|block)$/iu.test(raw)
        ? raw
        : /^byblock$/iu.test(raw)
          ? (blockStyleOf(entity)?.lineType ??
            context.layerStyles.get(blockStyleOf(entity)?.layer ?? layer)?.lineType)
          : context.layerStyles.get(layer)?.lineType;
    const pattern = own ? context.ltypeDashes.get(own.toUpperCase()) : undefined;
    if (!pattern) return undefined;
    const scale = context.ltScale * (finite(entity.lineTypeScale, 1) || 1);
    return pattern.map((value) => (value === 0 ? 0.02 : Math.abs(value)) * scale);
  };
  const omittedTypes: Record<string, number> = {};
  const omit = (type: string) => {
    omitted += 1;
    omittedTypes[type] = (omittedTypes[type] ?? 0) + 1;
  };
  const push = (primitive: CadDrawingPrimitive) => {
    if (primitives.length >= MAX_DRAWING_ENTITIES) {
      omit("LIMIT");
      return;
    }
    const box = primitiveBounds(primitive);
    if (!Number.isFinite(box.minX)) return;
    primitive.b = [box.minX, box.minY, box.maxX, box.maxY];
    if (primitive.t !== "text") {
      bounds.minX = Math.min(bounds.minX, box.minX);
      bounds.minY = Math.min(bounds.minY, box.minY);
      bounds.maxX = Math.max(bounds.maxX, box.maxX);
      bounds.maxY = Math.max(bounds.maxY, box.maxY);
    }
    primitives.push(primitive);
  };
  const textPrimitive = (
    source: UnknownRecord,
    layer: string,
    color: number,
    anchor: CadPoint,
    mtext: boolean,
  ) => {
    // У атрибутов и их определений поля текста вложены в объект text
    const entity: UnknownRecord =
      typeof source.text === "object" && source.text !== null
        ? { ...source, ...record(source.text) }
        : source;
    const raw = textFromEntity(entity);
    if (!raw.trim()) return;
    const transform = transformFrom(entity);
    const scale = transform ? Math.hypot(transform.a, transform.b) || 1 : 1;
    const height = Math.abs(finite(entity.textHeight, 0)) * scale;
    if (!(height > 0)) return;
    const style = context.textStyles?.get(String(entity.styleName ?? ""));
    const ownWidth = finite(entity.xScale, Number.NaN);
    const widthFactor =
      Number.isFinite(ownWidth) && ownWidth > 0 && !mtext ? ownWidth : style?.widthFactor;
    const ownOblique = finite(entity.obliqueAngle, Number.NaN);
    const oblique =
      Number.isFinite(ownOblique) && Math.abs(ownOblique) > 1e-9 && !mtext
        ? angleDegrees(ownOblique)
        : style?.obliqueAngle;
    let halign: "left" | "center" | "right" = "left";
    let valign: "baseline" | "middle" | "top" | "bottom" = "baseline";
    if (mtext) {
      const attachment = finite(entity.attachmentPoint, 1);
      halign = attachment % 3 === 1 ? "left" : attachment % 3 === 2 ? "center" : "right";
      valign = attachment <= 3 ? "top" : attachment <= 6 ? "middle" : "bottom";
    } else {
      const h = finite(entity.halign, 0);
      const v = finite(entity.valign, 0);
      halign = h === 1 || h === 4 ? "center" : h === 2 ? "right" : "left";
      valign = v === 1 ? "bottom" : v === 2 ? "middle" : v === 3 ? "top" : "baseline";
    }
    let rot = angleDegrees(entity.rotation);
    if (mtext && !rot) {
      const direction = record(entity.direction);
      const dx = finite(direction.x, 1);
      const dy = finite(direction.y, 0);
      if (Math.abs(dy) > 1e-9 || dx < 0) rot = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
    // Поворот вставки блока добавляется к повороту текста
    if (transform && (Math.abs(transform.b) > 1e-12 || transform.a < 0))
      rot += (Math.atan2(transform.b, transform.a) * 180) / Math.PI;
    const lines = mtext ? mtextLines(raw) : undefined;
    const text = mtext ? (lines ?? []).join(" ") : mtextLines(raw).join(" ");
    push({
      t: "text",
      layer,
      color,
      x: anchor.x,
      y: anchor.y,
      h: height,
      rot,
      text,
      lines: lines && lines.length > 1 ? lines : undefined,
      halign,
      valign,
      xs:
        widthFactor !== undefined && Math.abs(widthFactor - 1) > 1e-6 && widthFactor > 0
          ? widthFactor
          : undefined,
      ob: oblique !== undefined && Math.abs(oblique) > 1e-6 ? oblique : undefined,
      b: [0, 0, 0, 0],
    });
  };
  const pushPolyline = (
    entity: UnknownRecord,
    layer: string,
    color: number,
    points: CadPoint[],
    closed: boolean,
    fill?: boolean,
  ) => {
    if (points.length < 2) return false;
    push({
      t: "path",
      layer,
      color,
      weight: weightOf(entity, layer),
      dash: fill ? undefined : dashOf(entity, layer),
      fill: fill || undefined,
      closed,
      pts: flatPoints(points),
      b: [0, 0, 0, 0],
    });
    return true;
  };

  for (const entity of entities) {
    const layer = String(entity.layer ?? "0");
    if (context.hiddenLayers.has(layer)) continue;
    const type = String(entity.type ?? "").toUpperCase();
    if (type === "ATTDEF" || type === "VIEWPORT") continue; // шаблоны атрибутов и видовые экраны AutoCAD не показывает
    if (entity.isVisible === false) continue;
    const color = rgbOf(entity, layer);
    if (type === "SOLID" || type === "TRACE") {
      // Углы SOLID идут "бантиком": 1-2-4-3
      const transform = transformFrom(entity);
      const corners = ["corner1", "corner2", "corner4", "corner3"]
        .map((key) => point(entity[key]))
        .filter((value): value is CadPoint => Boolean(value));
      const ordered =
        corners.length === 3
          ? corners
          : corners.length === 4
            ? [corners[0], corners[1], corners[2], corners[3]]
            : corners;
      const points = ordered.map((value) => transformPoint(value, transform));
      if (!pushPolyline(entity, layer, color, points, true, true)) omit(type);
      continue;
    }
    if (type === "LEADER") {
      const transform = transformFrom(entity);
      const vertices = (Array.isArray(entity.vertices) ? entity.vertices : [])
        .map((value) => point(value))
        .filter((value): value is CadPoint => Boolean(value))
        .map((value) => transformPoint(value, transform));
      if (!pushPolyline(entity, layer, color, vertices, false)) {
        omit(type);
        continue;
      }
      if (entity.isArrowheadEnabled !== false && vertices.length >= 2 && context.arrowSize) {
        const [tip, next] = vertices;
        const length = Math.hypot(next.x - tip.x, next.y - tip.y) || 1;
        const ux = (next.x - tip.x) / length;
        const uy = (next.y - tip.y) / length;
        const size = context.arrowSize;
        const base = { x: tip.x + ux * size, y: tip.y + uy * size, z: tip.z, zExplicit: false };
        const half = size / 6;
        pushPolyline(
          entity,
          layer,
          color,
          [
            tip,
            { ...base, x: base.x - uy * half, y: base.y + ux * half },
            { ...base, x: base.x + uy * half, y: base.y - ux * half },
          ],
          true,
          true,
        );
      }
      continue;
    }
    if (type === "MULTILEADER") {
      // Мультивыноска: линии выносок с "полкой" и стрелкой плюс текст у полки
      const transform = transformFrom(entity);
      const contentScale = finite(entity.contentScale, 1) || 1;
      const arrow = Math.abs(finite(entity.arrowheadSize, context.arrowSize ?? 0)) * contentScale;
      const sections = Array.isArray(entity.leaderSections)
        ? entity.leaderSections.map(record)
        : [];
      let drawn = 0;
      for (const section of sections) {
        const last = point(section.lastLeaderLinePoint);
        const dogleg = record(section.doglegVector);
        const doglegLength = finite(section.doglegLength, finite(entity.doglegLength, 0));
        const landing =
          last && entity.doglegEnabled !== false && doglegLength > 0
            ? {
                ...last,
                x: last.x + finite(dogleg.x, 0) * doglegLength,
                y: last.y + finite(dogleg.y, 0) * doglegLength,
              }
            : undefined;
        const lines = Array.isArray(section.leaderLines) ? section.leaderLines.map(record) : [];
        for (const line of lines) {
          const vertices = (Array.isArray(line.vertices) ? line.vertices : [])
            .map((value) => point(value))
            .filter((value): value is CadPoint => Boolean(value));
          const tail = vertices[vertices.length - 1];
          if (last && (!tail || Math.hypot(tail.x - last.x, tail.y - last.y) > 1e-9))
            vertices.push(last);
          if (landing) vertices.push(landing);
          const world = vertices.map((value) => transformPoint(value, transform));
          if (!pushPolyline(entity, layer, color, world, false)) continue;
          drawn += 1;
          if (arrow > 0 && world.length >= 2) {
            const [tip, next] = world;
            const length = Math.hypot(next.x - tip.x, next.y - tip.y) || 1;
            const ux = (next.x - tip.x) / length;
            const uy = (next.y - tip.y) / length;
            const base = { ...tip, x: tip.x + ux * arrow, y: tip.y + uy * arrow };
            const half = arrow / 6;
            pushPolyline(
              entity,
              layer,
              color,
              [
                tip,
                { ...base, x: base.x - uy * half, y: base.y + ux * half },
                { ...base, x: base.x + uy * half, y: base.y - ux * half },
              ],
              true,
              true,
            );
          }
        }
      }
      const content = typeof entity.textContent === "string" ? entity.textContent : "";
      const anchor = point(entity.textAnchor) ?? point(entity.contentBasePosition);
      if (content.trim() && anchor) {
        const attachment = finite(entity.textAttachmentPoint, 1);
        textPrimitive(
          {
            text: content.replace(/\r?\n/gu, "\\P"),
            textHeight: Math.abs(finite(entity.textHeight, 0)) * contentScale,
            attachmentPoint: attachment === 2 ? 2 : attachment === 3 ? 3 : 1,
            rotation: entity.textRotation,
            __cadTransform: transform,
          },
          layer,
          color,
          transformPoint(anchor, transform),
          true,
        );
        drawn += 1;
      }
      if (!drawn) omit(type);
      continue;
    }
    if (type === "MLINE") {
      const transform = transformFrom(entity);
      const vertices = Array.isArray(entity.vertices) ? entity.vertices.map(record) : [];
      const lineCount = Math.max(
        finite(entity.numberOfLines, 0),
        ...vertices.map((vertex) => (Array.isArray(vertex.lines) ? vertex.lines.length : 0)),
      );
      const closed = (finite(entity.flags) & 2) === 2;
      let drawnLines = 0;
      for (let line = 0; line < lineCount; line += 1) {
        const points: CadPoint[] = [];
        for (const vertex of vertices) {
          const base = point(vertex.vertex);
          const miter = record(vertex.miterDirection);
          const params = Array.isArray(vertex.lines) ? record(vertex.lines[line]) : {};
          const offsets = Array.isArray(params.segmentParams) ? params.segmentParams : [];
          const distance = finite(offsets[0], 0) * (finite(entity.scale, 1) || 1);
          if (!base) continue;
          points.push(
            transformPoint(
              {
                ...base,
                x: base.x + finite(miter.x, 0) * distance,
                y: base.y + finite(miter.y, 0) * distance,
              },
              transform,
            ),
          );
        }
        if (pushPolyline(entity, layer, color, points, closed)) drawnLines += 1;
      }
      if (!drawnLines) omit(type);
      continue;
    }
    if (drawingLineworkTypes.test(type)) {
      const points = entityPoints(entity);
      if (!points.length) {
        omit(type);
        continue;
      }
      const flag = finite(entity.flag);
      const closed =
        type === "CIRCLE" ||
        type === "3DFACE" ||
        type === "SOLID" ||
        type === "TRACE" ||
        (type === "LWPOLYLINE"
          ? (flag & 512) === 512 || (flag & 1) === 1
          : /^(POLYLINE2D|POLYLINE3D)$/u.test(type) && (flag & 1) === 1);
      const constantWidth = finite(entity.constantWidth, Number.NaN);
      const vertexWidths = Array.isArray(entity.vertices)
        ? entity.vertices
            .map((vertex) => finite(record(vertex).startWidth, Number.NaN))
            .filter((value) => Number.isFinite(value) && value > 0)
        : [];
      const width =
        Number.isFinite(constantWidth) && constantWidth > 0
          ? constantWidth
          : vertexWidths.length
            ? vertexWidths.reduce((sum, value) => sum + value, 0) / vertexWidths.length
            : undefined;
      push({
        t: "path",
        layer,
        color,
        weight: weightOf(entity, layer),
        dash: dashOf(entity, layer),
        width,
        fill: type === "SOLID" || type === "TRACE" ? true : undefined,
        closed,
        pts: flatPoints(points),
        b: [0, 0, 0, 0],
      });
      continue;
    }
    if (type === "HATCH") {
      const loops = hatchLoops(entity);
      if (!loops.length) {
        omit(type);
        continue;
      }
      const patternName = String(entity.patternName ?? "").toUpperCase();
      const solid = finite(entity.solidFill) === 1 || patternName === "SOLID";
      const definitionLines = Array.isArray(entity.definitionLines)
        ? entity.definitionLines.map(record)
        : [];
      const patternScale = Math.abs(finite(entity.patternScale, 1)) || 1;
      const patternAngle = angleDegrees(entity.patternAngle);
      let lines = definitionLines
        .map((line) => {
          const offset = record(line.offset);
          const offsetY = Math.abs(finite(offset.y, 0));
          const spacing =
            offsetY > 1e-9 ? offsetY : Math.hypot(finite(offset.x, 0), finite(offset.y, 0));
          return {
            angle: angleDegrees(line.angle),
            spacing,
            dashes: Array.isArray(line.dashLengths)
              ? line.dashLengths.map((value: unknown) => finite(value, 0))
              : [],
          };
        })
        .filter((line) => line.spacing > 1e-9);
      if (!lines.length && !solid) {
        const base = 3.175 * patternScale;
        lines =
          patternName === "ANSI37" || patternName === "ANSI38"
            ? [
                { angle: 45 + patternAngle, spacing: base, dashes: [] },
                { angle: 135 + patternAngle, spacing: base, dashes: [] },
              ]
            : [
                {
                  angle: 45 + patternAngle,
                  spacing: patternName === "ANSI32" ? base * 1.5 : base,
                  dashes: [],
                },
              ];
      }
      push({
        t: "hatch",
        layer,
        color,
        solid,
        lines,
        loops: loops.map((loop) => flatPoints(loop)),
        b: [0, 0, 0, 0],
      });
      continue;
    }
    if (type === "TEXT" || type === "ATTRIB" || type === "ATTDEF") {
      const h = finite(entity.halign, 0);
      const v = finite(entity.valign, 0);
      const useEnd = (h !== 0 && h !== 3 && h !== 5) || v !== 0;
      const anchor =
        point(useEnd && entity.endPoint ? entity.endPoint : entity.startPoint) ??
        point(entity.startPoint);
      if (!anchor) {
        omit(type);
        continue;
      }
      textPrimitive(entity, layer, color, transformPoint(anchor, transformFrom(entity)), false);
      continue;
    }
    if (type === "MTEXT") {
      const anchor = point(entity.insertionPoint);
      if (!anchor) {
        omit(type);
        continue;
      }
      textPrimitive(entity, layer, color, transformPoint(anchor, transformFrom(entity)), true);
      continue;
    }
    if (type === "INSERT") {
      const attribs = Array.isArray(entity.attribs) ? entity.attribs.map(record) : [];
      for (const attrib of attribs) {
        const nested = record(attrib.text);
        const flat =
          typeof attrib.text === "string" ? attrib : { ...attrib, ...nested, text: nested.text };
        const anchor = point(flat.startPoint) ?? point(entity.insertionPoint);
        if (!anchor) continue;
        textPrimitive(
          { ...flat, layer: attrib.layer ?? layer, __cadTransform: transformFrom(entity) },
          String(attrib.layer ?? layer),
          rgbOf(attrib, layer),
          transformPoint(anchor, transformFrom(entity)),
          false,
        );
      }
      if (!attribs.length) omit(type);
      continue;
    }
    omit(type);
  }
  if (!Number.isFinite(bounds.minX)) Object.assign(bounds, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  return {
    bounds,
    unitsPerMeter: context.unitsPerMeter,
    primitives,
    entityCount: entities.length,
    omitted,
    omittedTypes: omitted ? omittedTypes : undefined,
  };
}

function textFromEntity(entity: UnknownRecord) {
  if (typeof entity.text === "string") return entity.text;
  const nested = record(entity.text);
  if (typeof nested.text === "string") return nested.text;
  const attributes = Array.isArray(entity.attribs) ? entity.attribs.map(record) : [];
  return attributes
    .map((attribute) => {
      if (typeof attribute.text === "string") return attribute.text;
      const nestedText = record(attribute.text);
      return typeof nestedText.text === "string" ? nestedText.text : "";
    })
    .filter(Boolean)
    .join(" ");
}

export function findElevationAnnotationLayers(entities: ElevationAnnotationEntity[]) {
  const groups = new Map<string, Array<{ value: number; point: CadPoint }>>();
  for (const source of entities) {
    const entity = record(source);
    if (!/^(TEXT|MTEXT|ATTRIB)$/iu.test(String(entity.type ?? ""))) continue;
    const value = parseElevationLabel(textFromEntity(entity));
    const position = entityPoints(entity)[0];
    if (value === undefined || !position) continue;
    const layer = String(entity.layer ?? "0");
    const values = groups.get(layer);
    if (values) values.push({ value, point: position });
    else groups.set(layer, [{ value, point: position }]);
  }

  return new Set(
    [...groups.entries()]
      .filter(([, values]) => {
        if (values.length < 6) return false;
        let minElevation = Number.POSITIVE_INFINITY;
        let maxElevation = Number.NEGATIVE_INFINITY;
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const item of values) {
          minElevation = Math.min(minElevation, item.value);
          maxElevation = Math.max(maxElevation, item.value);
          minX = Math.min(minX, item.point.x);
          maxX = Math.max(maxX, item.point.x);
          minY = Math.min(minY, item.point.y);
          maxY = Math.max(maxY, item.point.y);
        }
        const elevationRange = maxElevation - minElevation;
        const spatialRange = Math.hypot(maxX - minX, maxY - minY);
        return elevationRange >= 0.1 && spatialRange > 1;
      })
      .map(([layer]) => layer),
  );
}

function boundsFor(features: CadFeature[]): CadBounds {
  const bounds: CadBounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
  for (const feature of features) {
    for (const value of feature.points) {
      bounds.minX = Math.min(bounds.minX, value.x);
      bounds.maxX = Math.max(bounds.maxX, value.x);
      bounds.minY = Math.min(bounds.minY, value.y);
      bounds.maxY = Math.max(bounds.maxY, value.y);
      bounds.minZ = Math.min(bounds.minZ, value.z);
      bounds.maxZ = Math.max(bounds.maxZ, value.z);
    }
  }
  if (!Number.isFinite(bounds.minX)) {
    return { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 0, maxZ: 0 };
  }
  return bounds;
}

function featureCenter(feature: CadFeature) {
  return {
    x: medianNumber(feature.points.map((value) => value.x)),
    y: medianNumber(feature.points.map((value) => value.y)),
  };
}

export function selectPrimaryCadScope(features: CadFeature[]) {
  if (features.length < 12) return { features, mode: "all" as const };
  const reference = features.filter((feature) => feature.kind !== "annotation");
  const centers = (reference.length >= 12 ? reference : features).map(featureCenter);
  const centerX = medianNumber(centers.map((value) => value.x));
  const centerY = medianNumber(centers.map((value) => value.y));
  const thresholdX = Math.max(
    percentile(
      centers.map((value) => Math.abs(value.x - centerX)),
      0.9,
    ) * 3,
    1,
  );
  const thresholdY = Math.max(
    percentile(
      centers.map((value) => Math.abs(value.y - centerY)),
      0.9,
    ) * 3,
    1,
  );
  const primary = features.filter((feature) => {
    const center = featureCenter(feature);
    return Math.abs(center.x - centerX) <= thresholdX && Math.abs(center.y - centerY) <= thresholdY;
  });
  if (primary.length < features.length * 0.55 || primary.length === features.length) {
    return { features, mode: "all" as const };
  }

  const allBounds = boundsFor(features);
  const primaryBounds = boundsFor(primary);
  const allDiagonal = Math.hypot(allBounds.maxX - allBounds.minX, allBounds.maxY - allBounds.minY);
  const primaryDiagonal = Math.max(
    1,
    Math.hypot(primaryBounds.maxX - primaryBounds.minX, primaryBounds.maxY - primaryBounds.minY),
  );
  return allDiagonal > primaryDiagonal * 20
    ? { features: primary, mode: "primary-cluster" as const }
    : { features, mode: "all" as const };
}

function unitLabelFromHeader(header: UnknownRecord) {
  const units = finite(header.INSUNITS ?? header.insUnits ?? header.$INSUNITS, -1);
  const labels: Record<number, string> = {
    0: "единицы чертежа",
    1: "дюймы",
    2: "футы",
    4: "мм",
    5: "см",
    6: "м",
    7: "км",
  };
  return labels[units] ?? "единицы DWG";
}

export function inferCadSpatialReference(input: {
  fileName: string;
  bounds: CadBounds;
  unitLabel: string;
  referenceText?: string;
}): CadSpatialReference {
  const signal = `${input.fileName} ${input.referenceText ?? ""}`;
  const evidence: string[] = [];
  const epsg = signal.match(/EPSG\s*[:=_-]?\s*(\d{4,6})/iu)?.[1];
  const wgsUtm =
    signal.match(/WGS\s*84\s*\/?\s*UTM(?:\s*(?:zone|зона))?\D{0,24}(\d{1,2})\s*N\b/iu)?.[1] ??
    signal.match(/UTM(?:\s*(?:zone|зона))?\D{0,24}(\d{1,2})\s*N\b\D{0,24}WGS\s*84/iu)?.[1];
  const qazZone = signal.match(/QazTRF[-_ ]?23.*?(?:zone|зона)\s*8/iu);
  const almatyBishkek = /(алматы|almaty|бишкек|bishkek)/iu.test(signal);
  const looksProjectedMeters =
    /^(м|единицы)/u.test(input.unitLabel) &&
    input.bounds.minX >= 100_000 &&
    input.bounds.maxX <= 900_000 &&
    input.bounds.minY >= 0 &&
    input.bounds.maxY <= 10_000_000;
  const looksProjectedSwapped =
    /^(м|единицы)/u.test(input.unitLabel) &&
    input.bounds.minY >= 100_000 &&
    input.bounds.maxY <= 900_000 &&
    input.bounds.minX >= 0 &&
    input.bounds.maxX <= 10_000_000;

  let horizontalCrs = "Исходная система координат DWG";
  let detectionMethod: NonNullable<CadSpatialReference["detectionMethod"]> = "SOURCE_PRESERVED";
  let confidence = 0.35;
  if (epsg) {
    horizontalCrs = `EPSG:${epsg}`;
    detectionMethod = "EMBEDDED";
    confidence = 0.99;
    evidence.push("Код EPSG найден в тексте или метаданных DWG");
  } else if (wgsUtm) {
    const zone = Number(wgsUtm);
    if (zone >= 1 && zone <= 60) {
      horizontalCrs = `EPSG:${32600 + zone} — WGS 84 / UTM zone ${zone}N`;
      detectionMethod = "EMBEDDED";
      confidence = 0.96;
      evidence.push("Название WGS 84 / UTM и номер зоны найдены в DWG");
    }
  } else if (qazZone) {
    horizontalCrs = "EPSG:10942 — QazTRF-23 / Gauss-Kruger zone 8";
    detectionMethod = "EMBEDDED";
    confidence = 0.96;
    evidence.push("QazTRF-23 и зона 8 найдены в DWG");
  } else if (almatyBishkek && looksProjectedMeters) {
    horizontalCrs = "Кандидат EPSG:32643 — WGS 84 / UTM zone 43N";
    detectionMethod = "INFERRED";
    confidence = 0.74;
    evidence.push("Имя проекта указывает на коридор Алматы–Бишкек");
    evidence.push("Диапазон X/Y соответствует метрической зональной проекции");
  } else if (looksProjectedMeters || looksProjectedSwapped) {
    horizontalCrs = "Зональная метрическая CRS — зона не определена";
    detectionMethod = "INFERRED";
    confidence = 0.5;
    evidence.push("Диапазон координат похож на UTM или Гаусса–Крюгера");
  } else {
    evidence.push(
      "В DWG нет надёжного идентификатора CRS; исходные X/Y сохранены без преобразования",
    );
  }

  let verticalDatum = "Исходные Z DWG — вертикальный датум не указан";
  const baltic1977 = /(балтийск\w*.*1977|бсв[-_ ]?77|baltic.*1977)/iu.test(signal);
  const baltic1946 = /(балтийск\w*.*1946|бсв[-_ ]?46|baltic.*1946)/iu.test(signal);
  const conditional = /(условн\w*.*систем\w*.*высот|местн\w*.*систем\w*.*высот)/iu.test(signal);
  if (baltic1977) {
    verticalDatum = "Балтийская система высот 1977";
    evidence.push("Система высот найдена в тексте DWG");
  } else if (baltic1946) {
    verticalDatum = "Балтийская система высот 1946";
    evidence.push("Система высот найдена в тексте DWG");
  } else if (conditional) {
    verticalDatum = "Условная/местная система высот";
    evidence.push("Условная система высот указана в тексте DWG");
  } else {
    evidence.push("Вертикальный датум не найден; числовые Z сохранены без пересчёта");
  }

  return {
    horizontalCrs,
    verticalDatum,
    confirmedByOperator: false,
    detectionMethod,
    confidence,
    axisOrder: looksProjectedMeters
      ? "EASTING_NORTHING"
      : looksProjectedSwapped
        ? "NORTHING_EASTING"
        : "XY_UNRESOLVED",
    coordinatePolicy: "SOURCE_UNCHANGED",
    evidence,
  };
}

export function buildCadPreflightReport(input: {
  unitLabel: string;
  bounds: CadBounds;
  terrain: CadTerrainGrid;
  layers: CadLayerSummary[];
  modelEntityCount: number;
  scopeMode: "all" | "primary-cluster";
  boundaryCandidateCount: number;
  spatialReference?: CadSpatialReference;
}): CadPreflightReport {
  const width = Math.max(0, input.bounds.maxX - input.bounds.minX);
  const depth = Math.max(0, input.bounds.maxY - input.bounds.minY);
  const elevationRange = input.terrain.maxElevation - input.terrain.minElevation;
  const unitsKnown = !/единицы/u.test(input.unitLabel);
  const hasElevation = input.terrain.triangles.length >= 3 && elevationRange >= 0.02;
  const unknownEntities = input.layers
    .filter((layer) => layer.kind === "unknown")
    .reduce((sum, layer) => sum + layer.entityCount, 0);
  const unknownRatio = unknownEntities / Math.max(1, input.modelEntityCount);
  const checks: CadPreflightReport["checks"] = [
    {
      id: "units",
      label: "Единицы DWG",
      status: unitsKnown ? "pass" : "review",
      value: input.unitLabel,
      detail: unitsKnown
        ? "Единицы прочитаны из заголовка DWG."
        : "В заголовке нет однозначных единиц — подтвердите их по исходным материалам.",
    },
    {
      id: "coordinates",
      label: "Диапазон координат",
      status: input.scopeMode === "primary-cluster" ? "review" : "pass",
      value: `${width.toFixed(2)} × ${depth.toFixed(2)} ${input.unitLabel}`,
      detail:
        input.scopeMode === "primary-cluster"
          ? "Обнаружены удалённые координатные выбросы; в рабочую область взят основной кластер."
          : "Рабочая область не содержит удалённых кластеров координат.",
    },
    {
      id: "reference",
      label: "Автопривязка координат",
      status: input.spatialReference?.detectionMethod === "EMBEDDED" ? "pass" : "review",
      value: input.spatialReference?.horizontalCrs ?? "Исходные координаты",
      detail:
        input.spatialReference?.detectionMethod === "EMBEDDED"
          ? "CRS прочитана из текста DWG. Исходные X/Y/Z сохраняются без скрытого пересчёта."
          : "Система определила наиболее вероятный вариант, но не преобразует координаты без надёжного идентификатора.",
    },
    {
      id: "elevations",
      label: "Реальные отметки Z",
      status: hasElevation
        ? input.terrain.quality.status === "ready"
          ? "pass"
          : "review"
        : "fail",
      value: `${input.terrain.sampleCount.toLocaleString("ru-RU")} точек · ΔZ ${elevationRange.toFixed(2)} ${input.unitLabel}`,
      detail: hasElevation
        ? `${input.terrain.trustedSampleCount.toLocaleString("ru-RU")} отметок получены из геометрии, ${Math.max(0, input.terrain.interpretedSampleCount - (input.terrain.derivedBoundarySampleCount ?? 0)).toLocaleString("ru-RU")} восстановлены из числовых подписей, ${(input.terrain.derivedBoundarySampleCount ?? 0).toLocaleString("ru-RU")} граничных узлов интерполированы.`
        : "Нет достаточного набора согласованных высот и треугольников. Поверхность не создаётся.",
    },
    {
      id: "duplicates",
      label: "Совпадающие XY",
      status: input.terrain.conflictingPointCount ? "review" : "pass",
      value: `${input.terrain.conflictingPointCount.toLocaleString("ru-RU")} конфликтов Z`,
      detail: input.terrain.conflictingPointCount
        ? "Одна XY-позиция имеет разные Z. Проверьте, не смешаны ли разные поверхности или уровни."
        : "Конфликтующие отметки в одинаковых XY не обнаружены.",
    },
    {
      id: "breaklines",
      label: "Структурные линии",
      status: "review",
      value: `${input.terrain.structuralLineCount.toLocaleString("ru-RU")} кандидатов`,
      detail: input.terrain.structuralLineCount
        ? "Линии с реальными Z включены в выборку. Перемычки через разрывы отсекаются, но обязательные рёбра ещё требуют подтверждения."
        : "Breaklines не найдены; канавы, бровки и бордюры могут быть интерполированы неверно.",
    },
    {
      id: "boundary",
      label: "Внешняя граница",
      status: "review",
      value: `${input.boundaryCandidateCount.toLocaleString("ru-RU")} кандидатов`,
      detail: input.boundaryCandidateCount
        ? "Замкнутая граница применяется только если охватывает не менее 80% высотных точек."
        : "Обоснованная внешняя граница не найдена; края ограничиваются локальной плотностью съёмки.",
    },
    {
      id: "classification",
      label: "Классификация слоёв",
      status: unknownRatio > 0.1 ? "review" : "pass",
      value: `${unknownEntities.toLocaleString("ru-RU")} не назначено`,
      detail:
        unknownRatio > 0.1
          ? "Более 10% сущностей остаются неопределёнными — проверьте назначение слоёв."
          : "Большинство сущностей получило предметный класс.",
    },
  ];
  return {
    status: checks.some((check) => check.status === "fail")
      ? "blocked"
      : checks.some((check) => check.status === "review")
        ? "review"
        : "ready",
    checks,
  };
}

export async function processDwgBuffer(
  input: { fileName: string; fileSize: number; content: ArrayBuffer },
  onProgress?: (progress: number, label: string) => void,
  wasmPath = "/libredwg",
): Promise<CadProcessingResult> {
  onProgress?.(14, "Читаем DWG локально");
  const { LibreDwg, Dwg_File_Type } = await import("@mlightcad/libredwg-web");
  onProgress?.(24, "Запускаем CAD-ядро");
  const libredwg = await LibreDwg.create(wasmPath);
  const pointer = libredwg.dwg_read_data(input.content, Dwg_File_Type.DWG);
  if (!pointer)
    throw new Error("CAD-ядро не смогло открыть DWG. Проверьте версию или пересохраните файл.");

  try {
    onProgress?.(42, "Извлекаем модель, блоки и слои");
    const database = record(libredwg.convert(pointer));
    const header = record(database.header);
    const unitLabel = unitLabelFromHeader(header);
    const unitsPerMeter = sourceUnitsPerMeter(unitLabel);
    const entities = Array.isArray(database.entities) ? database.entities.map(record) : [];
    if (!entities.length) {
      throw new Error(
        "В DWG не удалось прочитать ни одной сущности. Файл пуст или его содержимое не поддерживается CAD-ядром. Пересохраните его в AutoCAD как DWG другой версии или DXF.",
      );
    }
    const tables = record(database.tables);
    const rawLayerEntries = record(tables.LAYER).entries;
    const layerColors = new Map<string, CadColorRef>();
    const layerStyles = new Map<string, { lineweight?: number; lineType?: string }>();
    for (const entry of Array.isArray(rawLayerEntries) ? rawLayerEntries.map(record) : []) {
      layerColors.set(String(entry.name ?? ""), colorRef(entry));
      const lineweight = finite(entry.lineweight, Number.NaN);
      layerStyles.set(String(entry.name ?? ""), {
        lineweight: Number.isFinite(lineweight) ? lineweight : undefined,
        lineType: typeof entry.lineType === "string" ? entry.lineType : undefined,
      });
    }
    const hiddenLayers = new Set<string>();
    for (const entry of Array.isArray(rawLayerEntries) ? rawLayerEntries.map(record) : []) {
      if (entry.frozen === true || entry.off === true) hiddenLayers.add(String(entry.name ?? ""));
    }
    const rawLtypeEntries = record(tables.LTYPE).entries;
    const ltypeDashes = new Map<string, number[]>();
    for (const entry of Array.isArray(rawLtypeEntries) ? rawLtypeEntries.map(record) : []) {
      const pattern = Array.isArray(entry.pattern) ? entry.pattern.map(record) : [];
      const dashes = pattern.map((element) => finite(element.elementLength, 0));
      if (dashes.length && dashes.some((value) => value !== 0))
        ltypeDashes.set(String(entry.name ?? "").toUpperCase(), dashes);
    }
    const ltScale = finite(header.LTSCALE ?? header.$LTSCALE, 1) || 1;
    const rawBlockEntries = record(tables.BLOCK_RECORD).entries;
    const blockEntries = Array.isArray(rawBlockEntries) ? rawBlockEntries.map(record) : [];
    const modelHandle = String(
      blockEntries.find((entry) => String(entry.name) === "*Model_Space")?.handle ?? "2",
    );
    const sourceModelEntities = entities.filter(
      (entity) => String(entity.ownerBlockRecordSoftId ?? modelHandle) === modelHandle,
    );
    const modelEntities = expandCadBlockEntities(sourceModelEntities, blockEntries);
    if (!modelEntities.length) {
      throw new Error(
        "В пространстве модели DWG не прочитано ни одной сущности. Проверьте, что чертёж находится в модели, или пересохраните его как DXF. Расчёт по пустой модели невозможен.",
      );
    }
    const elevationAnnotationLayers = findElevationAnnotationLayers(modelEntities);
    const entityColorFamily = (entity: UnknownRecord, layer: string) => {
      const effective = effectiveCadColor(colorRef(entity), layerColors.get(layer));
      return cadColorFamily(effective.color, effective.colorIndex);
    };
    const mixedColorLayers = findMixedColorLayers(
      modelEntities.map((entity) => {
        const layer = String(entity.layer ?? "0");
        return {
          layer,
          sourceType: String(entity.type ?? ""),
          family: entityColorFamily(entity, layer),
        };
      }),
    );

    const drawingTexts = collectDrawingTexts(
      (function* () {
        for (const entity of modelEntities) {
          const sourceType = String(entity.type ?? "").toUpperCase();
          if (!/^(TEXT|MTEXT|ATTRIB|INSERT)$/u.test(sourceType)) continue;
          const text = textFromEntity(entity);
          if (!text) continue;
          const [anchor] = entityPoints(entity);
          if (!anchor) continue;
          yield { text, layer: String(entity.layer ?? "0"), x: anchor.x, y: anchor.y };
        }
      })(),
    );

    onProgress?.(56, "Считаем объекты и слои");
    const priorityFeatures: CadFeature[] = [];
    const sampledFeatures: CadFeature[] = [];
    const terrainSourceFeatures: CadFeature[] = [];
    const layerCounts = new Map<string, number>();
    const referenceSignals: string[] = [];
    for (const entity of modelEntities) {
      const layer = String(entity.layer ?? "0");
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
      if (/^(TEXT|MTEXT|ATTRIB)$/iu.test(String(entity.type ?? ""))) {
        const value = textFromEntity(entity);
        if (
          value &&
          referenceSignals.length < 250 &&
          /(EPSG|WGS|UTM|QazTRF|СК[-_ ]?\d|систем\w*\s+(?:координат|высот)|балтийск|датум|МСК|Пулково|Кронштадт)/iu.test(
            value,
          )
        ) {
          referenceSignals.push(value);
        }
      }
    }
    const drawableEntityCount = modelEntities.filter((entity) => {
      const layer = String(entity.layer ?? "0");
      const sourceType = String(entity.type ?? "UNKNOWN");
      return !/^(TEXT|MTEXT|ATTRIB|DIMENSION)$/iu.test(sourceType) || isElevationLayer(layer);
    }).length;
    const globalStride = Math.max(1, Math.ceil(drawableEntityCount / (MAX_FEATURES * 0.92)));
    const layerKinds = new Map(
      [...layerCounts.keys()].map((layer) => [layer, classifyCadItem(layer).kind]),
    );
    const layerSeen = new Map<string, number>();
    for (let entityIndex = 0; entityIndex < modelEntities.length; entityIndex += 1) {
      const entity = modelEntities[entityIndex];
      const layer = String(entity.layer ?? "0");
      const seen = (layerSeen.get(layer) ?? 0) + 1;
      layerSeen.set(layer, seen);
      const layerTotal = layerCounts.get(layer) ?? 1;
      const rareLayer = layerTotal <= 28;
      const elevationLayer = isElevationLayer(layer);
      const elevationStride = Math.max(1, Math.ceil(layerTotal / 3_000));
      const sourceType = String(entity.type ?? "UNKNOWN");
      const elevationAnnotation =
        elevationAnnotationLayers.has(layer) &&
        /^(TEXT|MTEXT|ATTRIB)$/iu.test(sourceType) &&
        parseElevationLabel(textFromEntity(entity)) !== undefined;
      const annotationEntity =
        /^(TEXT|MTEXT|ATTRIB|DIMENSION)$/iu.test(sourceType) &&
        !elevationLayer &&
        !elevationAnnotation;
      const priorityRoadGeometry = ["road", "curb"].includes(layerKinds.get(layer) ?? "unknown");
      const shouldKeep =
        !annotationEntity &&
        (priorityRoadGeometry ||
          rareLayer ||
          (elevationLayer && seen % elevationStride === 0) ||
          entityIndex % globalStride === 0);
      const potentialTerrainSource =
        elevationLayer || elevationAnnotation || sourceType.toUpperCase() === "POINT";
      if (!shouldKeep && !potentialTerrainSource) continue;
      const points = entityPoints(entity);
      if (!points.length) continue;
      const blockName = typeof entity.name === "string" ? entity.name : "";
      const text = textFromEntity(entity);
      const flag = finite(entity.flag);
      const isClosedByFlag =
        sourceType === "LWPOLYLINE"
          ? (flag & 512) === 512 || (flag & 1) === 1
          : /^(POLYLINE2D|POLYLINE3D)$/u.test(sourceType) && (flag & 1) === 1;
      const closed =
        isClosedByFlag ||
        (sourceType === "HATCH" && points.length >= 3) ||
        (points.length > 2 && closeEnough(points[0], points[points.length - 1]));
      const patternName = String(entity.patternName ?? "");
      const colorFamily = entityColorFamily(entity, layer);
      const layerStyle = layerStyles.get(layer);
      const ownLineweight = finite(entity.lineweight, Number.NaN);
      const lineWeightMm = lineWeightMillimetres(
        Number.isFinite(ownLineweight) ? ownLineweight : undefined,
        layerStyle?.lineweight,
      );
      const constantWidth = finite(entity.constantWidth, Number.NaN);
      const vertexWidths = Array.isArray(entity.vertices)
        ? entity.vertices
            .map((vertex) => finite(record(vertex).startWidth, Number.NaN))
            .filter((value) => Number.isFinite(value) && value > 0)
        : [];
      const polylineWidthUnits =
        Number.isFinite(constantWidth) && constantWidth > 0
          ? constantWidth
          : vertexWidths.length
            ? vertexWidths.reduce((sum, value) => sum + value, 0) / vertexWidths.length
            : undefined;
      const ownLineType = typeof entity.lineType === "string" ? entity.lineType : "";
      const lineType =
        ownLineType && !/^by(layer|block)$/iu.test(ownLineType)
          ? ownLineType
          : layerStyle?.lineType;
      const classification = recognizeCadObject({
        layer,
        blockName,
        text,
        sourceType,
        patternName,
        points,
        closed,
        sourceUnitsPerMeter: unitsPerMeter,
        colorFamily,
        layerMixedColors: mixedColorLayers.has(layer),
        lineWeightMm,
        lineType,
        polylineWidthUnits,
      });
      const sourceColor = finite(entity.color, Number.NaN);
      const sourceColorIndex = finite(entity.colorIndex, Number.NaN);
      const feature: CadFeature = {
        id: String(
          entity.handle ?? `${sourceType}-${priorityFeatures.length + sampledFeatures.length}`,
        ),
        sourceType,
        layer,
        blockName: blockName || undefined,
        text: text || undefined,
        patternName: patternName || undefined,
        sourceColor: Number.isFinite(sourceColor) ? sourceColor : undefined,
        sourceColorIndex: Number.isFinite(sourceColorIndex) ? sourceColorIndex : undefined,
        colorFamily,
        lineWeightMm,
        lineType,
        polylineWidthUnits,
        kind: classification.kind,
        confidence: classification.confidence,
        reason: classification.reason,
        classificationSource: classification.source,
        closed,
        points,
      };
      if (potentialTerrainSource || classification.kind === "terrain")
        terrainSourceFeatures.push(feature);
      if (shouldKeep) {
        if (priorityRoadGeometry) priorityFeatures.push(feature);
        else if (sampledFeatures.length < MAX_FEATURES) sampledFeatures.push(feature);
      }
      if (entityIndex > 0 && entityIndex % 12_000 === 0) {
        const progress = 58 + Math.round((entityIndex / modelEntities.length) * 16);
        onProgress?.(
          progress,
          `Упрощаем большую модель: ${entityIndex.toLocaleString("ru-RU")} / ${modelEntities.length.toLocaleString("ru-RU")}`,
        );
      }
    }

    onProgress?.(73, "Собираем полную рабочую область");
    const allFeatures = [
      ...priorityFeatures.slice(0, MAX_FEATURES),
      ...sampledFeatures.slice(0, Math.max(0, MAX_FEATURES - priorityFeatures.length)),
    ];
    const scope = selectPrimaryCadScope(demoteHatchOutlines(allFeatures, unitsPerMeter));
    onProgress?.(74, "Распознаём объекты по слоям и геометрии");
    const roadEdges = scope.features.filter(
      (feature) =>
        (feature.kind === "road" || feature.kind === "curb") &&
        !feature.closed &&
        feature.points.length >= 2,
    );
    const roadSurfaces =
      roadEdges.length >= 2
        ? buildRoadBetweenEdges(roadEdges, unitsPerMeter, {
            minWidthMeters: 0.9,
            minLengthMeters: 4,
            occupied: createBuildingMask(scope.features),
            boundaries: scope.features.filter(
              (feature) =>
                feature.kind === "building" && feature.closed && feature.points.length >= 3,
            ),
          })
        : [];
    const completedFeatures = [...scope.features, ...roadSurfaces];
    const bounds = boundsFor(completedFeatures);
    const terrainSourcesInScope = terrainSourceFeatures.filter((feature) =>
      feature.points.some(
        (point) =>
          point.x >= bounds.minX &&
          point.x <= bounds.maxX &&
          point.y >= bounds.minY &&
          point.y <= bounds.maxY,
      ),
    );
    const terrainInput = new Map(
      [
        ...terrainSourcesInScope,
        ...scope.features.filter((feature) => feature.kind === "boundary"),
      ].map((feature) => [feature.id, feature]),
    );
    const terrain = buildTerrainModel([...terrainInput.values()], unitsPerMeter);
    const placedFeatures = placeFeaturesOnTerrain(completedFeatures, terrain);
    const spatialReference = inferCadSpatialReference({
      fileName: input.fileName,
      bounds,
      unitLabel,
      referenceText: referenceSignals.join(" "),
    });

    // Класс слоя берется из итоговых признаков
    const firstCompletedByLayer = new Map<string, CadFeature>();
    for (const feature of completedFeatures) {
      if (!firstCompletedByLayer.has(feature.layer))
        firstCompletedByLayer.set(feature.layer, feature);
    }
    const layers: CadLayerSummary[] = [...layerCounts.entries()]
      .map(([name, entityCount]) => {
        const samples = allFeatures.filter((feature) => feature.layer === name);
        const first = firstCompletedByLayer.get(name) ?? samples[0];
        const fallback = classifyCadItem(name);
        return {
          name,
          entityCount,
          kind: first?.kind ?? fallback.kind,
          confidence: first?.confidence ?? fallback.confidence,
          reason: first?.reason ?? fallback.reason,
        };
      })
      .sort((a, b) => b.entityCount - a.entityCount || a.name.localeCompare(b.name, "ru"));
    const preflight = buildCadPreflightReport({
      unitLabel,
      bounds,
      terrain,
      layers,
      modelEntityCount: modelEntities.length,
      scopeMode: scope.mode,
      boundaryCandidateCount: completedFeatures.filter(
        (feature) => feature.closed && (feature.kind === "boundary" || feature.kind === "site"),
      ).length,
      spatialReference,
    });

    onProgress?.(92, "Проверяем локальные разрывы рельефа");
    const warnings: string[] = [];
    const elevationRange = terrain.maxElevation - terrain.minElevation;
    if (terrain.method === "none" || elevationRange < 0.02) {
      warnings.push(
        "Поверхность не создана: в DWG недостаточно согласованных отметок Z. Плоская подмена рельефа отключена.",
      );
    }
    if (
      terrain.method === "local-tin" &&
      terrain.trustedSampleCount === 0 &&
      terrain.interpretedSampleCount > 0
    ) {
      const numericCount = Math.max(
        0,
        terrain.interpretedSampleCount - (terrain.derivedBoundarySampleCount ?? 0),
      );
      warnings.push(
        `TIN построен по ${numericCount.toLocaleString("ru-RU")} числовым отметкам DWG и ${(terrain.derivedBoundarySampleCount ?? 0).toLocaleString("ru-RU")} интерполированным узлам границы съёмки. Проверьте отметки перед выпуском проекта.`,
      );
    }
    if (terrain.quality.rejectedGapTriangleCount) {
      warnings.push(
        `${terrain.quality.rejectedGapTriangleCount.toLocaleString("ru-RU")} треугольников исключены как перемычки через пустоты или за подтверждённой границей.`,
      );
    }
    if (terrain.quality.rejectedSlopeTriangleCount) {
      warnings.push(
        `${terrain.quality.rejectedSlopeTriangleCount.toLocaleString("ru-RU")} треугольников исключены из-за неправдоподобного уклона.`,
      );
    }
    if (terrain.method === "local-tin" && terrain.quality.coverageRatio < 0.75) {
      warnings.push(
        `После удаления ложных перемычек сохранено ${Math.round(terrain.quality.coverageRatio * 100)}% исходной триангуляции.`,
      );
    }
    if (terrain.rejectedSampleCount) {
      warnings.push(
        `${terrain.rejectedSampleCount.toLocaleString("ru-RU")} высотных отсчётов отброшены как выбросы или избыточные точки.`,
      );
    }
    if (terrain.conflictingPointCount) {
      warnings.push(
        `${terrain.conflictingPointCount.toLocaleString("ru-RU")} совпадающих XY имеют разные отметки Z — использована медианная отметка, требуется проверка геодезиста.`,
      );
    }
    const unknownCount = placedFeatures.filter((feature) => feature.kind === "unknown").length;
    if (unknownCount) {
      warnings.push(
        `${unknownCount.toLocaleString("ru-RU")} объектов сохранены как «не определено» — их можно назначить по слоям.`,
      );
    }
    const unresolvedCount = placedFeatures.filter(
      (feature) => feature.elevationMode === "unresolved",
    ).length;
    if (unresolvedCount) {
      warnings.push(
        `${unresolvedCount.toLocaleString("ru-RU")} объектов находятся вне подтверждённой поверхности и не поднимаются автоматически.`,
      );
    }
    if (drawableEntityCount > allFeatures.length) {
      warnings.push(
        `Очень тяжёлая модель адаптивно ограничена до ${allFeatures.length.toLocaleString("ru-RU")} геометрических объектов из ${drawableEntityCount.toLocaleString("ru-RU")}; исходный DWG не изменён.`,
      );
    }
    if (scope.mode === "primary-cluster") {
      warnings.push(
        `${(allFeatures.length - scope.features.length).toLocaleString("ru-RU")} удалённых координатных выбросов не включены в рабочую сцену; исходный DWG не изменён.`,
      );
    }

    onProgress?.(96, "Собираем точный 2D-чертёж");
    const rawStyleEntries = record(tables.STYLE).entries;
    const textStyles = new Map<string, { widthFactor?: number; obliqueAngle?: number }>();
    for (const entry of Array.isArray(rawStyleEntries) ? rawStyleEntries.map(record) : []) {
      const widthFactor = finite(entry.widthFactor, Number.NaN);
      const obliqueAngle = finite(entry.obliqueAngle, Number.NaN);
      textStyles.set(String(entry.name ?? ""), {
        widthFactor: Number.isFinite(widthFactor) && widthFactor > 0 ? widthFactor : undefined,
        obliqueAngle:
          Number.isFinite(obliqueAngle) && Math.abs(obliqueAngle) > 1e-9
            ? angleDegrees(obliqueAngle)
            : undefined,
      });
    }
    const arrowSize =
      Math.abs(finite(header.DIMASZ ?? header.$DIMASZ, 2.5)) *
      (Math.abs(finite(header.DIMSCALE ?? header.$DIMSCALE, 1)) || 1);
    const drawingEntities = expandCadBlockEntities(
      sourceModelEntities,
      blockEntries,
      MAX_DRAWING_ENTITIES,
      { all: true, hiddenLayers },
    );
    const drawing = buildDrawing(drawingEntities, {
      layerColors,
      layerStyles,
      hiddenLayers,
      ltypeDashes,
      ltScale,
      unitsPerMeter,
      textStyles,
      arrowSize,
    });
    onProgress?.(100, "Новая модель исходных данных готова");
    return {
      fileName: input.fileName,
      fileSize: input.fileSize,
      formatVersion: String(header.version ?? header.ACADVER ?? "DWG"),
      entityCount: entities.length,
      modelEntityCount: modelEntities.length,
      renderedEntityCount: scope.features.length,
      omittedEntityCount: Math.max(0, modelEntities.length - scope.features.length),
      layers,
      features: attachLabelsToFeatures(placedFeatures, drawingTexts, unitsPerMeter),
      texts: drawingTexts,
      drawing,
      bounds,
      terrain,
      unitLabel,
      scopeMode: scope.mode,
      preflight,
      spatialReference,
      warnings,
    };
  } finally {
    libredwg.dwg_free(pointer);
  }
}
