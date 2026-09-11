import {
  cadPathWidthMeters,
  isBuildingFootprint,
  isCadFeatureRenderable,
  isPointCadObject,
  resolveCadObjectHeight,
} from "./objectRules";
import { signedArea } from "../geometry";
import { orientTerrainTriangles } from "./terrain";
import {
  cadKindMeta,
  type CadFeature,
  type CadKind,
  type CadPoint,
  type CadProcessingResult,
} from "./types";

type ExportProgress = (progress: number, label: string) => void;

type MeshBucket = {
  positions: number[];
  triangles: number[];
};

type MaterialKey =
  | CadKind
  | "building-wall"
  | "building-roof"
  | "tree-trunk"
  | "tree-crown"
  | "sign-post"
  | "sign-face";

type GeometryRecord = {
  id: string;
  name: string;
  kind: CadKind;
  material: MaterialKey;
  smooth?: boolean;
  primitive: "triangles" | "lines";
  positions: number[];
  indices: number[];
};

function yieldToUi() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export type DaeExportStats = {
  geometryCount: number;
  vertexCount: number;
  triangleCount: number;
  lineSegmentCount: number;
  featureCount: number;
  sourceUnit: string;
  coordinateOrigin: { x: number; y: number; z: number };
  autoCount: number;
  reviewCount: number;
  rejectedCount: number;
};

export type DaeExportResult = {
  content: string;
  stats: DaeExportStats;
};

function xml(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function number(value: number) {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.abs(value) < 5e-10 ? 0 : value;
  return rounded
    .toFixed(6)
    .replace(/\.0+$/u, "")
    .replace(/(\.\d*?)0+$/u, "$1");
}

function sourceToMeters(unitLabel: string) {
  const factors: Record<string, number> = {
    мм: 0.001,
    см: 0.01,
    м: 1,
    км: 1_000,
    футы: 0.3048,
    дюймы: 0.0254,
  };
  return factors[unitLabel] ?? 1;
}

function pointInTriangle(point: CadPoint, a: CadPoint, b: CadPoint, c: CadPoint) {
  const sign = (p1: CadPoint, p2: CadPoint, p3: CadPoint) =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(point, a, b);
  const d2 = sign(point, b, c);
  const d3 = sign(point, c, a);
  const hasNegative = d1 < -1e-10 || d2 < -1e-10 || d3 < -1e-10;
  const hasPositive = d1 > 1e-10 || d2 > 1e-10 || d3 > 1e-10;
  return !(hasNegative && hasPositive);
}

function triangulatePolygon(input: CadPoint[]) {
  const points = [...input];
  if (
    points.length > 2 &&
    Math.abs(points[0].x - points[points.length - 1].x) < 1e-9 &&
    Math.abs(points[0].y - points[points.length - 1].y) < 1e-9
  ) {
    points.pop();
  }
  if (points.length < 3) return { points, triangles: [] as number[] };

  const order = Array.from({ length: points.length }, (_, index) => index);
  if (signedArea(points) < 0) order.reverse();
  const triangles: number[] = [];
  let guard = points.length * points.length;

  while (order.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let cursor = 0; cursor < order.length; cursor += 1) {
      const previous = order[(cursor - 1 + order.length) % order.length];
      const current = order[cursor];
      const next = order[(cursor + 1) % order.length];
      const a = points[previous];
      const b = points[current];
      const c = points[next];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 1e-10) continue;
      if (
        order.some(
          (index) =>
            index !== previous &&
            index !== current &&
            index !== next &&
            pointInTriangle(points[index], a, b, c),
        )
      )
        continue;
      triangles.push(previous, current, next);
      order.splice(cursor, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (order.length === 3) triangles.push(order[0], order[1], order[2]);
  if (!triangles.length) {
    for (let index = 1; index < points.length - 1; index += 1) triangles.push(0, index, index + 1);
  }
  return { points, triangles };
}

function appendSurface(
  bucket: MeshBucket,
  feature: CadFeature,
  local: (point: CadPoint) => [number, number, number],
) {
  const polygon = triangulatePolygon(feature.points);
  if (polygon.points.length < 3 || !polygon.triangles.length) return;
  const offset = bucket.positions.length / 3;
  for (const point of polygon.points) bucket.positions.push(...local(point));
  for (const index of polygon.triangles) bucket.triangles.push(offset + index);
}

function appendBuilding(
  wallBucket: MeshBucket,
  roofBucket: MeshBucket,
  feature: CadFeature,
  local: (point: CadPoint) => [number, number, number],
) {
  const polygon = triangulatePolygon(feature.points);
  if (polygon.points.length < 3 || !polygon.triangles.length) return;
  const height = resolveCadObjectHeight(feature).heightMeters;
  if (!height) return;
  const base = feature.baseElevation ?? polygon.points[0].resolvedZ ?? polygon.points[0].z;

  const wallOffset = wallBucket.positions.length / 3;
  for (const point of polygon.points) {
    const [x, y] = local(point);
    const [, , z] = local({ ...point, resolvedZ: base });
    wallBucket.positions.push(x, y, z);
  }
  for (const point of polygon.points) {
    const [x, y] = local(point);
    const [, , z] = local({ ...point, resolvedZ: base });
    wallBucket.positions.push(x, y, z + height);
  }

  const count = polygon.points.length;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const bottomA = wallOffset + index;
    const bottomB = wallOffset + next;
    const topA = wallOffset + count + index;
    const topB = wallOffset + count + next;
    wallBucket.triangles.push(bottomA, bottomB, topB, bottomA, topB, topA);
  }

  const roofOffset = roofBucket.positions.length / 3;
  for (const point of polygon.points) {
    const [x, y] = local(point);
    const [, , z] = local({ ...point, resolvedZ: base });
    roofBucket.positions.push(x, y, z + height);
  }
  for (const index of polygon.triangles) {
    roofBucket.triangles.push(roofOffset + index);
  }
}

function appendPrism(
  bucket: MeshBucket,
  center: [number, number, number],
  radiusBottom: number,
  radiusTop: number,
  height: number,
  sides = 8,
) {
  const offset = bucket.positions.length / 3;
  for (let ring = 0; ring < 2; ring += 1) {
    const radius = ring ? radiusTop : radiusBottom;
    const z = center[2] + (ring ? height : 0);
    for (let index = 0; index < sides; index += 1) {
      const angle = (index / sides) * Math.PI * 2;
      bucket.positions.push(
        center[0] + Math.cos(angle) * radius,
        center[1] + Math.sin(angle) * radius,
        z,
      );
    }
  }
  const bottomCenter = bucket.positions.length / 3;
  bucket.positions.push(center[0], center[1], center[2]);
  const topCenter = bucket.positions.length / 3;
  bucket.positions.push(center[0], center[1], center[2] + height);
  for (let index = 0; index < sides; index += 1) {
    const next = (index + 1) % sides;
    bucket.triangles.push(
      offset + index,
      offset + next,
      offset + sides + next,
      offset + index,
      offset + sides + next,
      offset + sides + index,
      bottomCenter,
      offset + next,
      offset + index,
      topCenter,
      offset + sides + index,
      offset + sides + next,
    );
  }
}

function appendObjectMarker(
  bodyBucket: MeshBucket,
  detailBucket: MeshBucket,
  feature: CadFeature,
  local: (point: CadPoint) => [number, number, number],
) {
  if (!feature.points.length) return;
  const centerPoint = feature.points.reduce<CadPoint>(
    (sum, point) => ({
      x: sum.x + point.x / feature.points.length,
      y: sum.y + point.y / feature.points.length,
      z: sum.z + point.z / feature.points.length,
      resolvedZ: (sum.resolvedZ ?? 0) + (point.resolvedZ ?? point.z) / feature.points.length,
    }),
    { x: 0, y: 0, z: 0, resolvedZ: 0 },
  );
  const center = local(centerPoint);
  const height = resolveCadObjectHeight(feature).heightMeters;
  if (feature.kind === "building" && height) {
    appendPrism(bodyBucket, center, 2.1, 2.1, height, 4);
  } else if (feature.kind === "manhole") {
    appendPrism(bodyBucket, center, 0.4, 0.4, 0.04, 16);
  } else if (feature.kind === "pole" && height) {
    appendPrism(bodyBucket, center, 0.16, 0.1, height, 8);
  } else if (feature.kind === "sign" && height) {
    const postHeight = Math.max(0.8, height - 0.6);
    appendPrism(bodyBucket, center, 0.08, 0.07, postHeight, 8);
    appendPrism(detailBucket, [center[0], center[1], center[2] + postHeight], 0.34, 0.34, 0.6, 4);
  } else if (feature.kind === "waste" && height) {
    appendPrism(bodyBucket, center, 0.55, 0.5, height, 4);
  } else if (feature.kind === "vegetation" && height) {
    const trunkHeight = height * 0.55;
    appendPrism(bodyBucket, center, 0.2, 0.14, trunkHeight, 8);
    appendPrism(
      detailBucket,
      [center[0], center[1], center[2] + trunkHeight * 0.72],
      height * 0.34,
      height * 0.08,
      height * 0.55,
      10,
    );
  }
}

function appendFencePanels(
  bucket: MeshBucket,
  feature: CadFeature,
  local: (point: CadPoint) => [number, number, number],
) {
  const height = resolveCadObjectHeight(feature).heightMeters;
  if (!height || feature.points.length < 2) return;
  for (let index = 0; index < feature.points.length - 1; index += 1) {
    const a = local(feature.points[index]);
    const b = local(feature.points[index + 1]);
    const offset = bucket.positions.length / 3;
    bucket.positions.push(...a, ...b, a[0], a[1], a[2] + height, b[0], b[1], b[2] + height);
    bucket.triangles.push(offset, offset + 1, offset + 3, offset, offset + 3, offset + 2);
  }
}

function appendPathRibbon(
  bucket: MeshBucket,
  feature: CadFeature,
  local: (point: CadPoint) => [number, number, number],
  widthMeters: number,
) {
  const halfWidth = widthMeters / 2;
  for (let index = 0; index < feature.points.length - 1; index += 1) {
    const a = local(feature.points[index]);
    const b = local(feature.points[index + 1]);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-8) continue;
    const nx = (-dy / length) * halfWidth;
    const ny = (dx / length) * halfWidth;
    const offset = bucket.positions.length / 3;
    bucket.positions.push(
      a[0] + nx,
      a[1] + ny,
      a[2] + 0.02,
      a[0] - nx,
      a[1] - ny,
      a[2] + 0.02,
      b[0] + nx,
      b[1] + ny,
      b[2] + 0.02,
      b[0] - nx,
      b[1] - ny,
      b[2] + 0.02,
    );
    bucket.triangles.push(offset, offset + 1, offset + 3, offset, offset + 3, offset + 2);
  }
}

const materialOverrides: Partial<Record<MaterialKey, { label: string; color: number }>> = {
  terrain: { label: "Земля — тёплый грунт", color: 0x987550 },
  "building-wall": { label: "Здания — светлый фасад", color: 0xe8ddcf },
  "building-roof": { label: "Здания — кровля", color: 0xb85c2d },
  "tree-trunk": { label: "Деревья — ствол", color: 0x76502b },
  "tree-crown": { label: "Деревья — крона", color: 0x2f8f46 },
  "sign-post": { label: "Дорожные знаки — стойка", color: 0x66717c },
  "sign-face": { label: "Дорожные знаки — щит", color: 0x2563eb },
};

function materialDefinition(material: MaterialKey) {
  const override = materialOverrides[material];
  if (override) return override;
  const kind = material as CadKind;
  return { label: cadKindMeta[kind].label, color: cadKindMeta[kind].color };
}

function materialEffect(material: MaterialKey) {
  const { color } = materialDefinition(material);
  const [red, green, blue] = colorForNumber(color).map(number);
  return `<effect id="fx-${material}"><profile_COMMON><technique sid="common"><lambert><emission><color>0 0 0 1</color></emission><ambient><color>${red} ${green} ${blue} 1</color></ambient><diffuse><color>${red} ${green} ${blue} 1</color></diffuse><transparent opaque="A_ONE"><color>1 1 1 1</color></transparent><transparency><float>1</float></transparency></lambert></technique></profile_COMMON><extra><technique profile="GOOGLEEARTH"><double_sided>1</double_sided></technique></extra></effect>`;
}

function colorForNumber(value: number) {
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function smoothNormals(positions: number[], indices: number[]) {
  const normals = Array.from({ length: positions.length }, () => 0);
  for (let index = 0; index < indices.length; index += 3) {
    const ia = indices[index] * 3;
    const ib = indices[index + 1] * 3;
    const ic = indices[index + 2] * 3;
    const ab = [
      positions[ib] - positions[ia],
      positions[ib + 1] - positions[ia + 1],
      positions[ib + 2] - positions[ia + 2],
    ];
    const ac = [
      positions[ic] - positions[ia],
      positions[ic + 1] - positions[ia + 1],
      positions[ic + 2] - positions[ia + 2],
    ];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    for (const offset of [ia, ib, ic]) {
      normals[offset] += normal[0];
      normals[offset + 1] += normal[1];
      normals[offset + 2] += normal[2];
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;
    normals[index] /= length;
    normals[index + 1] /= length;
    normals[index + 2] /= length;
  }
  return normals;
}

function geometryXml(record: GeometryRecord) {
  const positionsId = `${record.id}-positions`;
  const arrayId = `${positionsId}-array`;
  const verticesId = `${record.id}-vertices`;
  const values = record.positions.map(number).join(" ");
  const normals =
    record.smooth && record.primitive === "triangles"
      ? smoothNormals(record.positions, record.indices)
      : undefined;
  const normalSource = normals
    ? `<source id="${record.id}-normals"><float_array id="${record.id}-normals-array" count="${normals.length}">${normals.map(number).join(" ")}</float_array><technique_common><accessor source="#${record.id}-normals-array" count="${normals.length / 3}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`
    : "";
  const normalInput = normals
    ? `<input semantic="NORMAL" source="#${record.id}-normals" offset="1"/>`
    : "";
  const indexValues = normals
    ? record.indices.flatMap((index) => [index, index]).join(" ")
    : record.indices.join(" ");
  const count =
    record.primitive === "triangles" ? record.indices.length / 3 : record.indices.length / 2;
  return `<geometry id="${record.id}" name="${xml(record.name)}"><mesh><source id="${positionsId}"><float_array id="${arrayId}" count="${record.positions.length}">${values}</float_array><technique_common><accessor source="#${arrayId}" count="${record.positions.length / 3}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>${normalSource}<vertices id="${verticesId}"><input semantic="POSITION" source="#${positionsId}"/></vertices><${record.primitive} material="mat-${record.material}-symbol" count="${count}"><input semantic="VERTEX" source="#${verticesId}" offset="0"/>${normalInput}<p>${indexValues}</p></${record.primitive}></mesh><extra><technique profile="AEDEXA"><class>${record.kind}</class><material_class>${record.material}</material_class><smooth>${record.smooth ? "true" : "false"}</smooth><primitive>${record.primitive}</primitive></technique></extra></geometry>`;
}

function sceneNodeXml(record: GeometryRecord) {
  return `<node id="node-${record.id}" name="${xml(record.name)}" type="NODE"><instance_geometry url="#${record.id}"><bind_material><technique_common><instance_material symbol="mat-${record.material}-symbol" target="#mat-${record.material}"/></technique_common></bind_material></instance_geometry></node>`;
}

export async function exportDaeModel(
  result: CadProcessingResult,
  onProgress?: ExportProgress,
): Promise<DaeExportResult> {
  if (!result.terrain.triangles.length) {
    throw new Error("DAE не создан: сначала нужен подтверждённый рельеф с треугольниками.");
  }
  onProgress?.(8, "Готовим локальную систему координат");
  await yieldToUi();
  const factor = sourceToMeters(result.unitLabel);
  const terrainBounds = result.terrain.vertices.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      maxX: Math.max(bounds.maxX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
  const origin = {
    x: (terrainBounds.minX + terrainBounds.maxX) / 2,
    y: (terrainBounds.minY + terrainBounds.maxY) / 2,
    z: result.terrain.minElevation,
  };
  const local = (point: CadPoint): [number, number, number] => [
    (point.x - origin.x) * factor,
    (point.y - origin.y) * factor,
    ((point.resolvedZ ?? (point.zExplicit ? point.z : origin.z)) - origin.z) * factor,
  ];

  const records: GeometryRecord[] = [];
  if (result.terrain.vertices.length && result.terrain.triangles.length) {
    const terrainPositions = result.terrain.vertices.flatMap((point) =>
      local({ ...point, resolvedZ: point.z }),
    );
    records.push({
      id: "geometry-terrain-tin",
      name: "AEDEXA TIN terrain",
      kind: "terrain",
      material: "terrain",
      smooth: true,
      primitive: "triangles",
      positions: terrainPositions,
      indices: orientTerrainTriangles(result.terrain.vertices, result.terrain.triangles, "ccw"),
    });
  }

  onProgress?.(28, "Создаём поверхности и объёмы");
  await yieldToUi();
  const meshBuckets = new Map<MaterialKey, MeshBucket & { kind: CadKind }>();
  const meshBucket = (material: MaterialKey, kind: CadKind) => {
    const existing = meshBuckets.get(material);
    if (existing) return existing;
    const created = { positions: [] as number[], triangles: [] as number[], kind };
    meshBuckets.set(material, created);
    return created;
  };
  const rejectedCount = result.features.filter((feature) => feature.qaStatus === "REJECT").length;
  const reviewCount = result.features.filter((feature) => feature.qaStatus === "REVIEW").length;
  const autoCount = result.features.filter((feature) => feature.qaStatus === "AUTO").length;
  const exportableFeatures = result.features.filter(isCadFeatureRenderable);
  for (const feature of exportableFeatures) {
    if (isBuildingFootprint(feature)) {
      appendBuilding(
        meshBucket("building-wall", "building"),
        meshBucket("building-roof", "building"),
        feature,
        local,
      );
    } else if (feature.kind === "building" && feature.sourceType.toUpperCase() === "INSERT") {
      appendObjectMarker(
        meshBucket("building-wall", "building"),
        meshBucket("building-roof", "building"),
        feature,
        local,
      );
    } else if (
      ["road", "site", "water"].includes(feature.kind) &&
      feature.closed &&
      feature.points.length >= 3
    ) {
      appendSurface(meshBucket(feature.kind, feature.kind), feature, local);
    } else if (isPointCadObject(feature)) {
      const bodyMaterial: MaterialKey =
        feature.kind === "vegetation"
          ? "tree-trunk"
          : feature.kind === "sign"
            ? "sign-post"
            : feature.kind;
      const detailMaterial: MaterialKey =
        feature.kind === "vegetation"
          ? "tree-crown"
          : feature.kind === "sign"
            ? "sign-face"
            : bodyMaterial;
      appendObjectMarker(
        meshBucket(bodyMaterial, feature.kind),
        meshBucket(detailMaterial, feature.kind),
        feature,
        local,
      );
    } else if (feature.kind === "fence") {
      appendFencePanels(meshBucket("fence", "fence"), feature, local);
    } else if (["road", "curb", "ditch", "water", "wire"].includes(feature.kind)) {
      appendPathRibbon(
        meshBucket(feature.kind, feature.kind),
        feature,
        local,
        cadPathWidthMeters(feature),
      );
    }
  }

  for (const [material, bucket] of meshBuckets) {
    if (!bucket.positions.length || !bucket.triangles.length) continue;
    const definition = materialDefinition(material);
    records.push({
      id: `geometry-${material}-surfaces`,
      name: `${definition.label} — surfaces`,
      kind: bucket.kind,
      material,
      smooth: ["tree-trunk", "tree-crown", "pole", "sign-post"].includes(material),
      primitive: "triangles",
      positions: bucket.positions,
      indices: bucket.triangles,
    });
  }

  onProgress?.(56, "Проверяем поверхности и объекты");
  await yieldToUi();

  const usedMaterials = new Set(records.map((record) => record.material));
  const now = new Date().toISOString();
  const geometries = records.map(geometryXml).join("");
  const nodes = records.map(sceneNodeXml).join("");
  const effects = [...usedMaterials].map(materialEffect).join("");
  const materials = [...usedMaterials]
    .map(
      (material) =>
        `<material id="mat-${material}" name="${xml(materialDefinition(material).label)}"><instance_effect url="#fx-${material}"/></material>`,
    )
    .join("");

  onProgress?.(82, "Собираем COLLADA 1.4.1");
  await yieldToUi();
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><authoring_tool>AEDEXA DWG to DAE</authoring_tool><comments>Source DWG: ${xml(result.fileName)}. The DAE contains the confirmed TIN and semantic 3D geometry only; raw CAD construction lines are excluded. TEMPLATE heights are not survey measurements.</comments></contributor><created>${now}</created><modified>${now}</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis><extra><technique profile="AEDEXA"><source_unit>${xml(result.unitLabel)}</source_unit><horizontal_crs>${xml(result.spatialReference?.horizontalCrs ?? "UNKNOWN")}</horizontal_crs><vertical_datum>${xml(result.spatialReference?.verticalDatum ?? "UNKNOWN")}</vertical_datum><crs_detection_method>${result.spatialReference?.detectionMethod ?? "SOURCE_PRESERVED"}</crs_detection_method><crs_confidence>${number(result.spatialReference?.confidence ?? 0)}</crs_confidence><axis_order>${result.spatialReference?.axisOrder ?? "XY_UNRESOLVED"}</axis_order><coordinate_policy>${result.spatialReference?.coordinatePolicy ?? "SOURCE_UNCHANGED"}</coordinate_policy><crs_confirmed>${result.spatialReference?.confirmedByOperator ? "true" : "false"}</crs_confirmed><origin_x>${number(origin.x)}</origin_x><origin_y>${number(origin.y)}</origin_y><origin_z>${number(origin.z)}</origin_z><terrain_method>${result.terrain.method}</terrain_method><terrain_quality_status>${result.terrain.quality.status}</terrain_quality_status><terrain_quality_score>${result.terrain.quality.score}</terrain_quality_score><terrain_coverage_ratio>${number(result.terrain.quality.coverageRatio)}</terrain_coverage_ratio><source_entities>${result.modelEntityCount}</source_entities><exported_features>${exportableFeatures.length}</exported_features><qa_auto>${autoCount}</qa_auto><qa_review>${reviewCount}</qa_review><qa_reject>${rejectedCount}</qa_reject></technique></extra></asset><library_effects>${effects}</library_effects><library_materials>${materials}</library_materials><library_geometries>${geometries}</library_geometries><library_visual_scenes><visual_scene id="Scene" name="AEDEXA DWG scene">${nodes}<extra><technique profile="AEDEXA"><coordinate_reference>Local metric coordinates; add stored origin to recover source DWG coordinates.</coordinate_reference></technique></extra></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>`;

  const stats: DaeExportStats = {
    geometryCount: records.length,
    vertexCount: records.reduce((sum, record) => sum + record.positions.length / 3, 0),
    triangleCount: records
      .filter((record) => record.primitive === "triangles")
      .reduce((sum, record) => sum + record.indices.length / 3, 0),
    lineSegmentCount: records
      .filter((record) => record.primitive === "lines")
      .reduce((sum, record) => sum + record.indices.length / 2, 0),
    featureCount: exportableFeatures.length,
    sourceUnit: result.unitLabel,
    coordinateOrigin: origin,
    autoCount,
    reviewCount,
    rejectedCount,
  };
  onProgress?.(100, "DAE готов");
  return { content, stats };
}
