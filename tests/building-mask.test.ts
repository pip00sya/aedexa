import assert from "node:assert/strict";
import test from "node:test";
import { createBuildingMask, isGroundLineKind } from "../app/lib/cad/buildingMask.ts";
import type { CadFeature, CadKind } from "../app/lib/cad/types.ts";

function feature(kind: CadKind, points: Array<[number, number]>, closed = true): CadFeature {
  return {
    id: `${kind}-${points.length}-${points[0][0]}`,
    sourceType: closed ? "HATCH" : "LWPOLYLINE",
    layer: "слой",
    kind,
    confidence: 0.9,
    reason: "test",
    closed,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
  };
}

const house = feature("building", [
  [10, 10],
  [22, 10],
  [22, 20],
  [10, 20],
]);

test("маска занимает только пятна зданий", () => {
  const inside = createBuildingMask([house]);

  assert.equal(inside(16, 15), true, "точка внутри дома занята");
  assert.equal(inside(5, 15), false, "слева от дома свободно");
  assert.equal(inside(16, 30), false, "выше дома свободно");
  assert.equal(inside(22.5, 15), false, "сразу за стеной уже свободно");
});

test("линия, проложенная ровно по стене, считается лежащей на стене", () => {
  const strict = createBuildingMask([house]);
  const withTolerance = createBuildingMask([house], 0.25);

  assert.equal(strict(16, 20), false, "строгая проверка точку на грани не считает занятой");
  assert.equal(withTolerance(16, 20), true, "с допуском линия по стене считается занятой");
  assert.equal(withTolerance(16, 20.2), true, "и чуть снаружи стены тоже");

  // Допуск не должен съедать то, что просто рядом с домом
  assert.equal(withTolerance(16, 20.6), false, "в полуметре от стены линия остаётся видимой");
  assert.equal(withTolerance(16, 25), false);
});

test("без допуска маска ведёт себя строго, как раньше", () => {
  const inside = createBuildingMask([house], 0);
  assert.equal(inside(16, 15), true);
  assert.equal(inside(16, 20.1), false);
});

test("в маску не попадают догадки: незамкнутые контуры и другие классы", () => {
  const openOutline = feature(
    "building",
    [
      [0, 0],
      [40, 0],
      [40, 40],
    ],
    false,
  );
  const parcel = feature("site", [
    [0, 0],
    [40, 0],
    [40, 40],
    [0, 40],
  ]);

  const inside = createBuildingMask([openOutline, parcel]);
  assert.equal(inside(20, 20), false, "площадка и незамкнутый контур зданием не считаются");
});

test("наземные линии обрываются на доме, а воздушные и рельеф — нет", () => {
  assert.equal(isGroundLineKind("boundary"), true);
  assert.equal(isGroundLineKind("fence"), true);
  assert.equal(isGroundLineKind("road"), true);
  assert.equal(isGroundLineKind("curb"), true);
  // Рельеф и провода живут в своей высоте, их обрезать по дому нельзя
  assert.equal(isGroundLineKind("terrain"), false);
  assert.equal(isGroundLineKind("wire"), false);
  assert.equal(isGroundLineKind("annotation"), false);
});

test("несколько домов проверяются независимо", () => {
  const second = feature("building", [
    [40, 40],
    [50, 40],
    [50, 48],
    [40, 48],
  ]);
  const inside = createBuildingMask([house, second]);

  assert.equal(inside(16, 15), true);
  assert.equal(inside(45, 44), true);
  assert.equal(inside(30, 30), false, "между домами пусто");
});
