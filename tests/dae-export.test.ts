import assert from "node:assert/strict";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { exportDaeModel } from "../app/lib/cad/exportDae.ts";
import type { CadFeature, CadProcessingResult } from "../app/lib/cad/types.ts";

const feature = (
  value: Partial<CadFeature> & Pick<CadFeature, "id" | "kind" | "points">,
): CadFeature => ({
  sourceType: "LWPOLYLINE",
  layer: value.kind,
  confidence: 1,
  reason: "test fixture",
  closed: false,
  ...value,
});

const fixture: CadProcessingResult = {
  fileName: "тестовая топосъёмка & площадка.dwg",
  fileSize: 1_024,
  formatVersion: "AC1032",
  entityCount: 4,
  modelEntityCount: 4,
  renderedEntityCount: 3,
  omittedEntityCount: 0,
  unitLabel: "м",
  scopeMode: "all",
  preflight: { status: "review", checks: [] },
  spatialReference: {
    horizontalCrs: "EPSG:32643",
    verticalDatum: "Балтийская 1977",
    confirmedByOperator: true,
    detectionMethod: "EMBEDDED",
    confidence: 0.99,
    axisOrder: "EASTING_NORTHING",
    coordinatePolicy: "SOURCE_UNCHANGED",
  },
  warnings: [],
  bounds: { minX: 100, maxX: 110, minY: 200, maxY: 210, minZ: 10, maxZ: 12 },
  layers: [],
  terrain: {
    vertices: [
      { x: 100, y: 200, z: 10, zExplicit: true },
      { x: 110, y: 200, z: 11, zExplicit: true },
      { x: 110, y: 210, z: 12, zExplicit: true },
      { x: 100, y: 210, z: 11, zExplicit: true },
    ],
    triangles: [0, 2, 1, 0, 3, 2],
    sampleCount: 4,
    minElevation: 10,
    maxElevation: 12,
    sourceSampleCount: 4,
    trustedSampleCount: 4,
    interpretedSampleCount: 0,
    rejectedSampleCount: 0,
    conflictingPointCount: 0,
    structuralLineCount: 0,
    method: "local-tin",
    quality: {
      status: "review",
      score: 68,
      coverageRatio: 1,
      retainedSampleRatio: 1,
      rejectedGapTriangleCount: 0,
      rejectedSlopeTriangleCount: 0,
      patchCount: 1,
    },
  },
  features: [
    feature({
      id: "building-1",
      kind: "building",
      closed: true,
      baseElevation: 10.5,
      text: "H=6",
      qaStatus: "REVIEW",
      points: [
        { x: 102, y: 202, z: 0, resolvedZ: 10.5 },
        { x: 106, y: 202, z: 0, resolvedZ: 10.5 },
        { x: 106, y: 206, z: 0, resolvedZ: 10.5 },
        { x: 102, y: 206, z: 0, resolvedZ: 10.5 },
      ],
    }),
    feature({
      id: "road-1",
      kind: "road",
      qaStatus: "AUTO",
      points: [
        { x: 100, y: 204, z: 0, resolvedZ: 10.4 },
        { x: 110, y: 204, z: 0, resolvedZ: 11.4 },
      ],
    }),
    feature({
      id: "tree-1",
      kind: "vegetation",
      sourceType: "POINT",
      qaStatus: "REVIEW",
      points: [{ x: 108, y: 208, z: 0, resolvedZ: 11.8 }],
    }),
    feature({
      id: "sign-1",
      kind: "sign",
      sourceType: "INSERT",
      heightMeters: 2.4,
      heightQuality: "ATTRIBUTE",
      heightSource: "CAD_TEXT",
      qaStatus: "AUTO",
      points: [{ x: 104, y: 208, z: 0, resolvedZ: 11.4 }],
    }),
  ],
};

test("COLLADA уходит корректной и метрической: рельеф и поднятые объекты на месте", async () => {
  const progress: number[] = [];
  const exported = await exportDaeModel(fixture, (value) => progress.push(value));
  const parser = new XMLParser({ ignoreAttributes: false });
  const document = parser.parse(exported.content);

  assert.equal(document.COLLADA["@_version"], "1.4.1");
  assert.equal(document.COLLADA.asset.up_axis, "Z_UP");
  assert.equal(String(document.COLLADA.asset.unit["@_meter"]), "1");
  assert.match(exported.content, /id="geometry-terrain-tin"/);
  assert.match(exported.content, /id="geometry-building-wall-surfaces"/);
  assert.match(exported.content, /id="geometry-building-roof-surfaces"/);
  assert.match(exported.content, /id="geometry-road-surfaces"/);
  assert.match(exported.content, /id="geometry-tree-trunk-surfaces"/);
  assert.match(exported.content, /id="geometry-tree-crown-surfaces"/);
  assert.match(exported.content, /id="geometry-sign-post-surfaces"/);
  assert.match(exported.content, /id="geometry-sign-face-surfaces"/);
  assert.match(
    exported.content,
    /<input semantic="NORMAL" source="#geometry-terrain-tin-normals" offset="1"\/>/,
  );
  assert.match(exported.content, /id="mat-building-wall" name="Здания — светлый фасад"/);
  assert.match(exported.content, /id="mat-building-roof" name="Здания — кровля"/);
  assert.match(exported.content, /id="mat-terrain" name="Земля — тёплый грунт"/);
  assert.doesNotMatch(
    exported.content,
    /<lines\b|geometry-terrain-lines|raw CAD construction lines[^<]*included/,
  );
  assert.match(exported.content, /Source DWG: тестовая топосъёмка &amp; площадка\.dwg/);
  assert.match(exported.content, /<terrain_quality_score>68<\/terrain_quality_score>/);
  assert.match(exported.content, /<qa_auto>2<\/qa_auto>/);
  assert.match(exported.content, /<qa_review>2<\/qa_review>/);
  assert.match(exported.content, /<horizontal_crs>EPSG:32643<\/horizontal_crs>/);
  assert.match(exported.content, /<vertical_datum>Балтийская 1977<\/vertical_datum>/);
  assert.match(exported.content, /<crs_detection_method>EMBEDDED<\/crs_detection_method>/);
  assert.match(exported.content, /<crs_confidence>0\.99<\/crs_confidence>/);
  assert.match(exported.content, /<axis_order>EASTING_NORTHING<\/axis_order>/);
  assert.match(exported.content, /<coordinate_policy>SOURCE_UNCHANGED<\/coordinate_policy>/);
  assert.doesNotMatch(exported.content, /\b(?:NaN|Infinity)\b/);
  const terrainNormals =
    exported.content
      .match(/id="geometry-terrain-tin-normals-array" count="\d+">([^<]+)/u)?.[1]
      .trim()
      .split(/\s+/u)
      .map(Number) ?? [];
  assert.ok(terrainNormals.length > 0);
  assert.ok(
    terrainNormals.filter((_, index) => index % 3 === 2).every((z) => z > 0),
    "лицевые грани рельефа смотрят вверх",
  );
  assert.ok(
    exported.stats.triangleCount >= 14,
    "рельеф и выдавленное здание разбиты на треугольники",
  );
  assert.equal(
    exported.stats.lineSegmentCount,
    0,
    "плоские линии в объёмную модель не протекают",
  );
  assert.equal(exported.stats.coordinateOrigin.z, 10);
  assert.equal(exported.stats.autoCount, 2);
  assert.equal(exported.stats.reviewCount, 2);
  assert.deepEqual(progress, [8, 28, 56, 82, 100]);
});

test("без известной глубины сеть по поверхности не выдумывается", async () => {
  const exported = await exportDaeModel({
    ...fixture,
    features: [
      ...fixture.features,
      feature({
        id: "underground-cable",
        kind: "utility",
        sourceType: "LWPOLYLINE",
        elevationMode: "draped",
        qaStatus: "REVIEW",
        points: [
          { x: 101, y: 201, z: 0, resolvedZ: 10.2 },
          { x: 109, y: 209, z: 0, resolvedZ: 11.8 },
        ],
      }),
    ],
  });

  assert.doesNotMatch(exported.content, /geometry-utility/);
  assert.equal(exported.stats.featureCount, fixture.features.length);
});
