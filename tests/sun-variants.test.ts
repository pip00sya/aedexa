import assert from "node:assert/strict";
import test from "node:test";
import { convexHull } from "../app/lib/geometry/index.ts";
import {
  ALMATY_LATITUDE,
  EQUINOX_DAY,
  rectShadowPolygon,
  shadowVector,
  solarPosition,
} from "../app/lib/sun/index.ts";
import { analyzePlacement } from "../app/lib/placement/engine.ts";
import { generatePlacementVariants } from "../app/lib/placement/variants.ts";
import { pointInPolygon, rectToPolylineDistance } from "../app/lib/geometry/index.ts";
import type { PlacementContext } from "../app/lib/placement/types.ts";

test("положение солнца совпадает с известной геометрией равноденствия", () => {
  const noon = solarPosition(ALMATY_LATITUDE, EQUINOX_DAY, 12);
  assert.ok(
    Math.abs(noon.altitudeDeg - (90 - ALMATY_LATITUDE)) < 0.6,
    `altitude=${noon.altitudeDeg}`,
  );
  assert.ok(Math.abs(noon.azimuthDeg - 180) < 2, `azimuth=${noon.azimuthDeg}`);

  const morning = solarPosition(ALMATY_LATITUDE, EQUINOX_DAY, 9);
  assert.ok(morning.azimuthDeg > 90 && morning.azimuthDeg < 180, "утром солнце на юго-востоке");
  assert.ok(morning.altitudeDeg > 0 && morning.altitudeDeg < noon.altitudeDeg);

  const night = solarPosition(ALMATY_LATITUDE, EQUINOX_DAY, 0);
  assert.equal(shadowVector(night, 10), null);
});

test("длина и направление тени идут за солнцем", () => {
  const offset = shadowVector({ altitudeDeg: 45, azimuthDeg: 180 }, 10);
  assert.ok(offset);
  // Солнце на юге, высота 45°: тень длиной 10 м строго на север (+Y)
  assert.ok(Math.abs(offset.x) < 1e-9);
  assert.ok(Math.abs(offset.y - 10) < 1e-9);

  const polygon = rectShadowPolygon({ x: 0, y: 0, width: 10, height: 6 }, 10, {
    altitudeDeg: 45,
    azimuthDeg: 180,
  });
  assert.ok(polygon && polygon.length >= 6);
  assert.ok(
    pointInPolygon({ x: 5, y: 12 }, polygon),
    "смещённая часть тени накрывает точку севернее здания",
  );
  assert.ok(pointInPolygon({ x: 5, y: 3 }, polygon), "основание здания входит в контур тени");

  // Пиксельная система север-сверху: +Y растет на юг, тень уходит в −Y
  const flipped = shadowVector({ altitudeDeg: 45, azimuthDeg: 180 }, 10, -1);
  assert.ok(flipped && Math.abs(flipped.y + 10) < 1e-9);
});

test("выпуклая оболочка обходится против часовой и лишних точек не держит", () => {
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 5, y: 5 },
  ]);
  assert.equal(hull.length, 4);
});

const context: PlacementContext = {
  parcel: [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 40 },
    { x: 0, y: 40 },
  ],
  streetEdgeIndex: 0,
  neighbors: [],
  parameters: {
    profile: "detached_house",
    streetType: "residential",
    buildingWidth: 10,
    buildingDepth: 8,
    projectFireClass: "I–II",
    neighborFireClass: "I–II",
    seismicity: 9,
    officialRedLine: false,
    neighborDataConfirmed: false,
  },
};

test("генератор вариантов выдаёт разные годные посадки с оценкой", () => {
  const analysis = analyzePlacement(context);
  const variants = generatePlacementVariants(context, analysis, 5);
  assert.ok(variants.length >= 3, `variants=${variants.length}`);
  for (let index = 1; index < variants.length; index += 1) {
    assert.ok(variants[index - 1].score >= variants[index].score, "сортировка по убыванию балла");
  }
  for (const variant of variants) {
    const corners = [
      { x: variant.rect.x, y: variant.rect.y },
      { x: variant.rect.x + variant.rect.width, y: variant.rect.y },
      { x: variant.rect.x + variant.rect.width, y: variant.rect.y + variant.rect.height },
      { x: variant.rect.x, y: variant.rect.y + variant.rect.height },
    ];
    assert.ok(
      corners.every((corner) => pointInPolygon(corner, analysis.buildable)),
      "вариант внутри допустимого пятна",
    );
    assert.equal(variant.breakdown.length, 5);
    const weightSum = variant.breakdown.reduce((sum, part) => sum + part.weight, 0);
    assert.ok(Math.abs(weightSum - 1) < 1e-9);
    assert.ok(variant.score >= 0 && variant.score <= 100);
  }
  // Лучший вариант ориентирует длинный фасад на юг (шире, чем глубже)
  assert.ok(variants[0].rect.width >= variants[0].rect.height);
});

test("варианты не залезают в охранные зоны сетей", () => {
  const utilityContext: PlacementContext = {
    ...context,
    utilities: [
      {
        id: "u1",
        kind: "water",
        label: "Водопровод",
        polyline: [
          { x: 20, y: -5 },
          { x: 20, y: 45 },
        ],
        distance: 5,
        status: "EXPERT_REVIEW",
      },
    ],
  };
  const analysis = analyzePlacement(utilityContext);
  const variants = generatePlacementVariants(utilityContext, analysis, 5);
  assert.ok(variants.length >= 1);
  for (const variant of variants) {
    assert.ok(
      rectToPolylineDistance(variant.rect, [
        { x: 20, y: -5 },
        { x: 20, y: 45 },
      ]) >=
        5 - 1e-9,
      "все варианты вне охранной зоны",
    );
  }
});
