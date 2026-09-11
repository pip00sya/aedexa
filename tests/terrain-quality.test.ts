import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTerrainModel,
  countTerrainPatches,
  orientTerrainTriangles,
  parseElevationLabel,
  placeFeaturesOnTerrain,
} from "../app/lib/cad/terrain.ts";
import { cadObjectRules } from "../app/lib/cad/objectRules.ts";
import type { CadFeature, CadPoint } from "../app/lib/cad/types.ts";

const terrainPoint = (point: CadPoint, index: number): CadFeature => ({
  id: `terrain-${index}`,
  sourceType: "POINT",
  layer: "TOPO",
  kind: "terrain",
  confidence: 1,
  reason: "test fixture",
  closed: false,
  points: [{ ...point, zExplicit: true }],
});

test("грани рельефа развёрнуты верно и для выгрузки с Z вверх, и для показа в браузере с Y вверх", () => {
  const vertices = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  assert.deepEqual(orientTerrainTriangles(vertices, [0, 2, 1], "ccw"), [0, 1, 2]);
  assert.deepEqual(orientTerrainTriangles(vertices, [0, 1, 2], "cw"), [0, 2, 1]);
});

test("рельеф строится по месту и не перекидывает мост между несвязанными участками съёмки", () => {
  const dense = Array.from({ length: 11 }, (_, row) =>
    Array.from({ length: 11 }, (_, column) => ({
      x: column * 10,
      y: row * 10,
      z: 100 + row + column,
    })),
  ).flat();
  const ready = buildTerrainModel(dense.map(terrainPoint));
  assert.equal(ready.quality.status, "ready");
  assert.ok(ready.quality.score >= 70);
  assert.ok(ready.quality.coverageRatio > 0.95);

  const separated = [
    { x: 0, y: 0, z: 100 },
    { x: 10, y: 0, z: 101 },
    { x: 10, y: 10, z: 102 },
    { x: 0, y: 10, z: 101 },
    { x: 1_000, y: 1_000, z: 103 },
  ];
  const review = buildTerrainModel(separated.map(terrainPoint));
  assert.equal(review.quality.status, "review");
  assert.ok(review.quality.rejectedGapTriangleCount > 0);
  assert.ok(review.quality.coverageRatio <= 0.01);
});

test("за высоту принимается только чистая отметка: пикетаж и размеры за Z не идут", () => {
  assert.equal(parseElevationLabel("787,125"), 787.125);
  assert.equal(parseElevationLabel("ПК 19+20"), undefined);
  assert.equal(parseElevationLabel("L=787.12"), undefined);
  assert.equal(parseElevationLabel("634156.3"), undefined);
});

test("по расплющенным отметкам миллиметрового чертежа собирается метрическая триангуляция", () => {
  const labels: CadFeature[] = [
    [0, 0, "697.00"],
    [10_000, 0, "697.50"],
    [20_000, 0, "698.00"],
    [0, 10_000, "697.50"],
    [10_000, 10_000, "698.00"],
    [20_000, 10_000, "698.50"],
    [0, 20_000, "698.00"],
    [10_000, 20_000, "698.50"],
    [20_000, 20_000, "699.00"],
  ].map(([x, y, text], index) => ({
    id: `label-${index}`,
    sourceType: "MTEXT",
    layer: "Defpoints",
    text: String(text),
    kind: "annotation",
    confidence: 0.8,
    reason: "расплющенная отметка съёмки",
    closed: false,
    points: [{ x: Number(x), y: Number(y), z: 0 }],
  }));
  const terrain = buildTerrainModel(labels, 1_000);

  assert.equal(terrain.method, "local-tin");
  assert.equal(terrain.interpretedSampleCount, 9);
  assert.equal(terrain.trustedSampleCount, 0);
  assert.equal(terrain.minElevation, 697_000);
  assert.equal(terrain.maxElevation, 699_000);
});

test("расплющенные горизонтали восстанавливаются по соседним подписям того же слоя", () => {
  const contours: CadFeature[] = Array.from({ length: 6 }, (_, row) => ({
    id: `contour-${row}`,
    sourceType: "LWPOLYLINE",
    layer: "GOR_B",
    kind: "terrain",
    confidence: 0.94,
    reason: "расплющенная горизонталь",
    closed: false,
    points: Array.from({ length: 8 }, (_, column) => ({
      x: column * 10,
      y: row * 10,
      z: 0,
      zExplicit: true,
    })),
  }));
  const labels: CadFeature[] = Array.from({ length: 6 }, (_, row) => ({
    id: `label-${row}`,
    sourceType: "TEXT",
    layer: "GOR_B",
    text: String(700 + row),
    kind: "terrain",
    confidence: 0.94,
    reason: "подпись горизонтали",
    closed: false,
    points: [{ x: 30, y: row * 10, z: 0 }],
  }));

  const terrain = buildTerrainModel([...contours, ...labels]);

  assert.equal(terrain.structuralLineCount, 6);
  assert.ok(terrain.sampleCount > labels.length);
  assert.ok(terrain.triangles.length > 0);
  assert.ok(terrain.quality.coverageRatio > 0.9);
});

test("без достоверных отметок плоскость не выдумывается", () => {
  const flat = buildTerrainModel([
    terrainPoint({ x: 0, y: 0, z: 0 }, 0),
    terrainPoint({ x: 10, y: 0, z: 0 }, 1),
    terrainPoint({ x: 0, y: 10, z: 0 }, 2),
  ]);

  assert.equal(flat.method, "none");
  assert.equal(flat.triangles.length, 0);
  assert.equal(flat.quality.status, "insufficient");
});

test("большая связная триангуляция считается без переполнения стека вызовов", () => {
  const triangles: number[] = [];
  for (let index = 0; index < 20_000; index += 1) {
    triangles.push(index, index + 1, index + 2);
  }

  assert.equal(countTerrainPatches(triangles), 1);
});

test("рельеф по боевому объёму отметок строится, не раскладывая их в стек", () => {
  const points = Array.from({ length: 135_000 }, (_, index) => ({
    x: index % 450,
    y: Math.floor(index / 450),
    z: 780 + (index % 100) * 0.01,
    zExplicit: true,
  }));
  const feature: CadFeature = {
    id: "large-terrain",
    sourceType: "POLYLINE3D",
    layer: "TOPO",
    kind: "terrain",
    confidence: 1,
    reason: "production-sized test fixture",
    closed: false,
    points,
  };

  const terrain = buildTerrainModel([feature]);

  assert.ok(terrain.vertices.length <= 12_000);
  assert.ok(terrain.triangles.length > 0);
});

test("правдоподобный объект с абсолютной Z вне подтверждённого покрытия не выгружается", () => {
  const terrain = buildTerrainModel([
    terrainPoint({ x: 0, y: 0, z: 100 }, 0),
    terrainPoint({ x: 20, y: 0, z: 101 }, 1),
    terrainPoint({ x: 20, y: 20, z: 102 }, 2),
    terrainPoint({ x: 0, y: 20, z: 101 }, 3),
  ]);
  const [outside] = placeFeaturesOnTerrain(
    [
      {
        id: "remote-pole",
        sourceType: "INSERT",
        layer: "Столбы",
        kind: "pole",
        confidence: 0.94,
        reason: "test",
        closed: false,
        points: [{ x: 100, y: 100, z: 101, zExplicit: true }],
      },
    ],
    terrain,
  );

  assert.equal(outside.elevationMode, "unresolved");
  assert.equal(outside.qaStatus, "REJECT");
});

test("происхождение записывается, а высота из шаблона за обмерную не выдаётся", () => {
  const terrain = buildTerrainModel([
    terrainPoint({ x: 0, y: 0, z: 100 }, 0),
    terrainPoint({ x: 20, y: 0, z: 101 }, 1),
    terrainPoint({ x: 20, y: 20, z: 102 }, 2),
    terrainPoint({ x: 0, y: 20, z: 101 }, 3),
  ]);
  const placed = placeFeaturesOnTerrain(
    [
      {
        id: "building",
        sourceType: "LWPOLYLINE",
        layer: "BUILDING",
        kind: "building",
        confidence: 0.94,
        reason: "test",
        classificationSource: "CAD_LAYER",
        closed: true,
        points: [
          { x: 4, y: 4, z: 0 },
          { x: 8, y: 4, z: 0 },
          { x: 8, y: 8, z: 0 },
          { x: 4, y: 8, z: 0 },
        ],
      },
      {
        id: "wire",
        sourceType: "LINE",
        layer: "WIRE",
        kind: "wire",
        confidence: 0.94,
        reason: "test",
        classificationSource: "CAD_LAYER",
        closed: false,
        points: [
          { x: 2, y: 2, z: 0 },
          { x: 18, y: 18, z: 0 },
        ],
      },
    ],
    terrain,
  );

  assert.equal(placed[0].zSource, "TIN");
  assert.equal(placed[0].heightQuality, "TEMPLATE");
  assert.equal(placed[0].heightMeters, cadObjectRules.building.defaultHeightMeters);
  assert.equal(placed[0].qaStatus, "REVIEW");
  assert.equal(placed[1].qaStatus, "REJECT");
  assert.match(placed[1].qaIssues?.join(" ") ?? "", /измеренный 3D Z/u);
});

test("условные знаки садятся на землю по месту, а не на общую отметку вставки", () => {
  const terrain = buildTerrainModel([
    terrainPoint({ x: 0, y: 0, z: 100 }, 0),
    terrainPoint({ x: 20, y: 0, z: 102 }, 1),
    terrainPoint({ x: 20, y: 20, z: 104 }, 2),
    terrainPoint({ x: 0, y: 20, z: 102 }, 3),
  ]);
  const [pole] = placeFeaturesOnTerrain(
    [
      {
        id: "pole",
        sourceType: "INSERT",
        layer: "Фонарь электрический",
        kind: "pole",
        confidence: 0.94,
        reason: "test",
        closed: false,
        points: [{ x: 18, y: 18, z: 100, zExplicit: true }],
      },
    ],
    terrain,
  );

  assert.equal(pole.elevationMode, "draped");
  assert.equal(pole.zSource, "TIN");
  assert.ok((pole.points[0].resolvedZ ?? 0) > 103);
});
