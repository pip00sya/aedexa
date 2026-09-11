import assert from "node:assert/strict";
import test from "node:test";
import {
  aciToRgb,
  cadColorFamily,
  effectiveCadColor,
  findMixedColorLayers,
} from "../app/lib/cad/color.ts";
import { demoteHatchOutlines, recognizeCadObject } from "../app/lib/cad/classification.ts";
import type { CadFeature } from "../app/lib/cad/types.ts";

const rectangle = (width: number, height: number, x0 = 0, y0 = 0, closing = false) => {
  const points = [
    { x: x0, y: y0, z: 0 },
    { x: x0 + width, y: y0, z: 0 },
    { x: x0 + width, y: y0 + height, z: 0 },
    { x: x0, y: y0 + height, z: 0 },
  ];
  return closing ? [...points, { ...points[0] }] : points;
};

test("индексы AutoCAD и точные цвета сводятся к семействам", () => {
  assert.deepEqual(aciToRgb(1), [255, 0, 0]);
  assert.deepEqual(aciToRgb(94), [0, 153, 0], "тёмно-зелёный из девяностой группы оттенков");
  assert.equal(cadColorFamily(undefined, 251), "grey");
  assert.equal(cadColorFamily(undefined, 9), "grey");
  assert.equal(cadColorFamily(undefined, 8), "grey");
  assert.equal(cadColorFamily(undefined, 7), "neutral", "белый или чёрный по умолчанию смысла не несёт");
  assert.equal(cadColorFamily(undefined, 255), "neutral");
  assert.equal(cadColorFamily(undefined, 94), "green");
  assert.equal(cadColorFamily(undefined, 3), "green");
  assert.equal(cadColorFamily(undefined, 41), "orange");
  assert.equal(cadColorFamily(undefined, 1), "red");
  assert.equal(cadColorFamily(undefined, 5), "blue");
  assert.equal(cadColorFamily(undefined, 211), "magenta");
  assert.equal(cadColorFamily(0xc7ffc7, 254), "green", "точный цвет перебивает ближайший индекс");
  assert.equal(cadColorFamily(0xffd1a3, 41), "orange");
  assert.equal(cadColorFamily(0x808080), "grey");
  assert.equal(cadColorFamily(undefined, 256), "unknown");
  assert.equal(cadColorFamily(), "unknown");
});

test("цвет по слою и по блоку разворачивается через таблицу слоёв", () => {
  assert.deepEqual(effectiveCadColor({ colorIndex: 256 }, { colorIndex: 3, color: 0xffffff }), {
    colorIndex: 3,
  });
  assert.deepEqual(effectiveCadColor({ colorIndex: 0 }, { colorIndex: 256, color: 0x336699 }), {
    color: 0x336699,
  });
  assert.deepEqual(
    effectiveCadColor({}, { colorIndex: 256, color: 0xffffff }),
    {},
    "белая заглушка слоя цветом не считается",
  );
  assert.deepEqual(effectiveCadColor({ colorIndex: 254, color: 0xc7ffc7 }, { colorIndex: 7 }), {
    color: 0xc7ffc7,
    colorIndex: 254,
  });
  assert.deepEqual(effectiveCadColor({ colorIndex: 94 }, { colorIndex: 7 }), { colorIndex: 94 });
});

test("слои, где цвет несёт смысл, отличаются от раскрашенных наугад", () => {
  const items = [
    ...Array.from({ length: 10 }, () => ({
      layer: "ГП",
      sourceType: "LWPOLYLINE",
      family: "grey" as const,
    })),
    ...Array.from({ length: 4 }, () => ({
      layer: "ГП",
      sourceType: "LWPOLYLINE",
      family: "green" as const,
    })),
    ...Array.from({ length: 10 }, () => ({
      layer: "Съёмка",
      sourceType: "LINE",
      family: "grey" as const,
    })),
    ...Array.from({ length: 5 }, () => ({
      layer: "Съёмка",
      sourceType: "INSERT",
      family: "red" as const,
    })),
    { layer: "Съёмка", sourceType: "LINE", family: "red" as const },
  ];
  const mixed = findMixedColorLayers(items);
  assert.equal(mixed.has("ГП"), true);
  assert.equal(
    mixed.has("Съёмка"),
    false,
    "подписи и одиночные случайные линии слой разноцветным не делают",
  );
});

test("цвет внутри разноцветного слоя участков: зелёное — ограждение, остальное правило слоя забором не делает", () => {
  const layer = "ГП-Граница учасика ИЖС";
  const line = (family: "grey" | "green" | "orange" | "unknown", mixed = true, closed = false) =>
    recognizeCadObject({
      layer,
      sourceType: "LWPOLYLINE",
      points: closed
        ? rectangle(4_000, 3_000)
        : [
            { x: 0, y: 0, z: 0 },
            { x: 18_000, y: 0, z: 0 },
          ],
      closed,
      sourceUnitsPerMeter: 1_000,
      colorFamily: family,
      layerMixedColors: mixed,
    });
  const green = line("green");
  assert.equal(green.kind, "fence");
  assert.match(green.reason, /зелёная линия/);
  assert.equal(green.source, "CAD_COLOR");
  const grey = line("grey");
  assert.equal(
    grey.kind,
    "curb",
    "серая линия разноцветного слоя участков — кромка покрытия, не ограждение",
  );
  assert.equal(grey.source, "CAD_COLOR");
  assert.equal(
    line("orange", true, true).kind,
    "boundary",
    "и другие цвета в таком слое тоже не заборы",
  );
  assert.equal(line("grey", false).kind, "fence", "на одноцветном слое цвет ничего не решает");
  assert.equal(
    recognizeCadObject({
      layer: "SIT_LГРАНИЦЫ",
      sourceType: "LINE",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 18_000, y: 0, z: 0 },
      ],
      closed: false,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "grey",
      layerMixedColors: false,
    }).kind,
    "boundary",
  );
  assert.equal(
    recognizeCadObject({
      layer: "Дороги с покрытием",
      sourceType: "LINE",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 18_000, y: 0, z: 0 },
      ],
      closed: false,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "green",
      layerMixedColors: true,
    }).kind,
    "road",
    "слой с определённым смыслом цветом не перебивается",
  );
});

test("штрихованные дома на слое участка распознаются, а бесцветная штриховка остаётся при классе слоя", () => {
  const layer = "ГП-Граница учасика ИЖС";
  const house = recognizeCadObject({
    layer,
    sourceType: "HATCH",
    patternName: "ANSI32",
    points: rectangle(4_000, 3_000, 0, 0, true),
    closed: true,
    sourceUnitsPerMeter: 1_000,
    colorFamily: "orange",
    layerMixedColors: true,
  });
  assert.equal(house.kind, "building");
  assert.match(house.reason, /штриховка/);
  assert.equal(
    recognizeCadObject({
      layer,
      sourceType: "HATCH",
      patternName: "ANSI32",
      points: rectangle(2_000, 1_000, 0, 0, true),
      closed: true,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "orange",
      layerMixedColors: true,
    }).kind,
    "annotation",
    "образцы условных обозначений остаются плоскими",
  );
  const greyFill = recognizeCadObject({
    layer,
    sourceType: "HATCH",
    patternName: "SOLID",
    points: rectangle(6_000, 8_000, 0, 0, true),
    closed: true,
    sourceUnitsPerMeter: 1_000,
    colorFamily: "grey",
    layerMixedColors: true,
  });
  assert.equal(
    greyFill.kind,
    "boundary",
    "серый больше не означает покрытие: неархитектурная заливка уходит к правилу слоя границы участка",
  );
  assert.equal(
    recognizeCadObject({
      layer: "Заливка",
      sourceType: "HATCH",
      patternName: "ANSI31",
      points: rectangle(78_000, 5_700, 0, 0, true),
      closed: true,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "blue",
      layerMixedColors: true,
    }).kind,
    "unknown",
    "длинная полоса домом не становится даже с архитектурной штриховкой",
  );
  assert.equal(
    recognizeCadObject({
      layer,
      sourceType: "HATCH",
      points: rectangle(20_000, 12_000, 0, 0, true),
      closed: true,
      sourceUnitsPerMeter: 1_000,
      layerMixedColors: false,
    }).kind,
    "boundary",
    "штриховка без признаков узора и цвета остаётся заливкой участка",
  );
});

test("замкнутый контур, лишь обводящий штриховку, теряет вес", () => {
  const feature = (
    id: string,
    sourceType: string,
    kind: CadFeature["kind"],
    points: CadFeature["points"],
  ): CadFeature => ({
    id,
    sourceType,
    layer: "ГП-Граница учасика ИЖС",
    kind,
    confidence: 0.9,
    reason: "test",
    closed: true,
    points,
  });
  const source = [
    feature("hatch", "HATCH", "building", rectangle(4_000, 3_000, 10_000, 10_000, true)),
    feature("outline", "LWPOLYLINE", "fence", rectangle(4_000, 3_000, 10_000, 10_000)),
    feature("other", "LWPOLYLINE", "fence", rectangle(4_000, 3_000, 30_000, 10_000)),
    feature("bigger", "LWPOLYLINE", "fence", rectangle(6_000, 4_000, 9_000, 9_500)),
  ];
  const result = demoteHatchOutlines(source, 1_000);
  const byId = new Map(result.map((item) => [item.id, item]));
  assert.equal(byId.get("hatch")?.kind, "building");
  assert.equal(byId.get("outline")?.kind, "annotation");
  assert.match(byId.get("outline")?.reason ?? "", /повторяет штриховку/);
  assert.equal(byId.get("other")?.kind, "fence");
  assert.equal(byId.get("bigger")?.kind, "fence");
});
