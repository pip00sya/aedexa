import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseDxf } from "../app/lib/placement/dxf.ts";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter.ts";
import { PLACEMENT_DEMOS } from "../app/lib/placement/demos.ts";
import { buildParcelTin, parcelTerrainStats } from "../app/lib/placement/terrain.ts";
import {
  createSiteObject,
  earthworks,
  inspectSiteObjects,
  specOf,
  suggestSpot,
} from "../app/lib/placement/siteObjects.ts";
import type { PlacementRelief } from "../app/lib/placement/types.ts";

const square = (size: number) => [
  { x: -size / 2, y: -size / 2 },
  { x: size / 2, y: -size / 2 },
  { x: size / 2, y: size / 2 },
  { x: -size / 2, y: size / 2 },
];

/** Склон: четыре горизонтали через 12 м, перепад 1,5 м на участке 40 м */
function slope(): PlacementRelief {
  const line = (y: number) => [
    { x: -40, y },
    { x: 40, y },
  ];
  return {
    contours: [
      { z: 100, points: line(-18) },
      { z: 100.5, points: line(-6) },
      { z: 101, points: line(6) },
      { z: 101.5, points: line(18) },
    ],
    marks: [],
    base: [],
    baseDropped: 0,
  };
}

test("без горизонталей и отметок поверхности нет", () => {
  assert.equal(buildParcelTin(square(40), undefined), null);
  assert.equal(
    buildParcelTin(square(40), { contours: [], marks: [], base: [], baseDropped: 0 }),
    null,
  );
  const one = {
    contours: [
      {
        z: 100,
        points: [
          { x: -30, y: 0 },
          { x: 30, y: 0 },
        ],
      },
    ],
    marks: [],
    base: [],
    baseDropped: 0,
  };
  assert.equal(buildParcelTin(square(40), one), null, "одной горизонтали для поверхности мало");
});

test("склон из трёх горизонталей: высота между ними интерполируется, снаружи участка — null", () => {
  const parcel = square(40);
  const tin = buildParcelTin(parcel, slope());
  assert.ok(tin, "поверхность построена");
  const middle = tin.sample({ x: 3, y: 12 });
  assert.ok(
    middle !== null && Math.abs(middle - 101.25) < 0.05,
    `на полпути между 101 и 101,5 ожидается 101,25, получено ${middle}`,
  );
  assert.equal(tin.sample({ x: 300, y: 300 }), null, "за поверхностью честное «не знаю»");

  const stats = parcelTerrainStats(tin, parcel, slope());
  assert.ok(
    Math.abs(stats.drop - 1.5) < 0.15,
    `перепад около 1,5 м, получено ${stats.drop.toFixed(2)}`,
  );
  assert.equal(stats.contourCount, 4);
  assert.ok(
    stats.slopePercent > 2.5 && stats.slopePercent < 5,
    `уклон ~3,75 %, получено ${stats.slopePercent.toFixed(1)}`,
  );
});

test("редкие горизонтали: поверхность всё же строится, а не пропадает", () => {
  const sparse: PlacementRelief = {
    contours: [
      {
        z: 100,
        points: [
          { x: -40, y: -30 },
          { x: 40, y: -30 },
        ],
      },
      {
        z: 102,
        points: [
          { x: -40, y: 30 },
          { x: 40, y: 30 },
        ],
      },
    ],
    marks: [],
    base: [],
    baseDropped: 0,
  };
  const tin = buildParcelTin(square(40), sparse);
  assert.ok(tin, "две горизонтали в 60 м друг от друга всё равно дают поверхность");
  const center = tin.sample({ x: 0, y: 0 });
  assert.ok(
    center !== null && Math.abs(center - 101) < 0.05,
    `между 100 и 102 — 101, получено ${center}`,
  );
});

test("поверхность режется границей участка", () => {
  const tin = buildParcelTin(square(40), slope());
  assert.ok(tin);
  for (let i = 0; i < tin.positions.length; i += 3) {
    assert.ok(
      Math.abs(tin.positions[i]) <= 20.01 && Math.abs(tin.positions[i + 1]) <= 20.01,
      "вершина внутри участка",
    );
  }
});

test("земляные работы: дом на склоне даёт и срез, и подсыпку", () => {
  const tin = buildParcelTin(square(40), slope());
  assert.ok(tin);
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);
  const earth = earthworks(house, tin);
  assert.ok(earth, "пятно накрыто поверхностью");
  assert.ok(earth.cut > 0 && earth.fill > 0, "склон: часть срезать, часть подсыпать");
  assert.ok(
    Math.abs(earth.cut - earth.fill) < earth.cut * 0.15,
    "площадка по средней отметке — срез примерно равен подсыпке",
  );
  assert.ok(earth.platform > 100.5 && earth.platform < 101.2, "отметка площадки — середина склона");
  assert.ok(earth.maxCut < 0.3, "уклон ~4 % на 9 м — не больше 20 см");
});

test("автопостановка находит место без нарушений, а не роняет постройку в центр", () => {
  const parcel = square(40);
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);
  const spot = suggestSpot(parcel, [house], specOf("garage"), 3);
  const garage = { ...createSiteObject("garage", spot, 2) };
  const summary = inspectSiteObjects([house, garage], parcel, 3);
  assert.equal(
    summary.conflicts,
    0,
    `гараж поставлен без конфликтов: ${JSON.stringify(summary.reports[1].issues)}`,
  );
  assert.ok(Math.hypot(spot.x, spot.y) > 5, "не в центре, где стоит дом");
});

test("в тесноте автопостановка ставит в лучшее место и не выходит за участок", () => {
  const parcel = square(16);
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);
  const spot = suggestSpot(parcel, [house], specOf("septic"), 3);
  const septic = createSiteObject("septic", spot, 2);
  const report = inspectSiteObjects([house, septic], parcel, 3).reports[1];
  assert.equal(
    report.issues.some((issue) => /выходит за границу/u.test(issue.text)),
    false,
    "за границу нельзя даже в тесноте",
  );
});

for (const demo of PLACEMENT_DEMOS) {
  test(`готовый участок «${demo.name}»: рельеф читается или честно отсутствует`, () => {
    const drawing = parseDxf(readFileSync(`public/${demo.file}`, "utf8"), demo.file);
    const source = placementSourceFromDxf(drawing, { name: demo.name, source: "demo" });
    assert.ok(source.relief, "рельеф разобран");
    const tin = buildParcelTin(source.parcel!, source.relief);
    const hasData = source.relief.contours.length >= 2 || source.relief.marks.length >= 8;
    if (hasData) {
      assert.ok(
        tin,
        `есть данные (${source.relief.contours.length} горизонталей, ${source.relief.marks.length} отметок) — поверхность построена`,
      );
      const stats = parcelTerrainStats(tin, source.parcel!, source.relief);
      assert.ok(stats.drop >= 0 && Number.isFinite(stats.slopePercent));
    } else {
      assert.equal(tin, null);
      assert.ok(
        source.warnings.some((warning) => /рельеф не построен/u.test(warning)),
        "предупреждение о плоской подложке",
      );
    }
  });
}
