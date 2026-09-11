import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCadItem,
  isElevationLayer,
  recognizeCadObject,
} from "../app/lib/cad/classification.ts";
import { isCadFeatureRenderable } from "../app/lib/cad/objectRules.ts";

test("classifies recurring layers from the Алматы–Бишкек production protocol", () => {
  const cases = new Map([
    ["Общая поверхность по верху_ ПЧ или ДП_откосы", "terrain"],
    ["Горизонтали", "terrain"],
    ["Геодезические пункты", "terrain"],
    ["Дорожные полосы", "road"],
    ["Укрепленная часть обочины", "road"],
    ["Дороги с покрытием (граница проезжей части)", "road"],
    ["АД СД_Ось", "road"],
    ["Правая ось ППС R60", "road"],
    ["Дорожн. знаки (прочие)", "sign"],
    ["ЛЭП н.напряж. подзем.", "utility"],
    ["Коммуникации", "utility"],
    ["Водопропускн. труба_ d_1м", "utility"],
    ["Смотровые колодцы и люки", "manhole"],
    ["Бортовой камень_бордюр", "curb"],
    ["Кюветы и канавы", "ditch"],
    ["ЛЭП воздушная линия", "wire"],
    ["КМ 21+165", "annotation"],
    ["Начало и конец круговой кривой_красный", "annotation"],
    ["Ограды металлические на круглых столбах", "fence"],
    ["Фундамент ограды", "fence"],
    ["Линии связи незастроен. терр.", "utility"],
    ["Камень бортовой проектный", "curb"],
    ["каб.TNS+", "utility"],
  ] as const);
  for (const [layer, expected] of cases) {
    assert.equal(classifyCadItem(layer).kind, expected, layer);
  }
  assert.equal(isElevationLayer("Общая поверхность по верху_ ПЧ или ДП_откосы"), true);
  assert.equal(
    classifyCadItem("Столбы деревянные").kind,
    "pole",
    "деревянные опоры — не растительность",
  );
  assert.equal(
    classifyCadItem("Нурсултан").kind,
    "unknown",
    "неоднозначные имена остаются на проверку",
  );
});

test("штриховка архитектурных пятен поднимается, границы участка в объёме остаются", () => {
  const rectangle = (width: number, height: number) => [
    { x: 0, y: 0, z: 0 },
    { x: width, y: 0, z: 0 },
    { x: width, y: height, z: 0 },
    { x: 0, y: height, z: 0 },
  ];
  assert.equal(
    recognizeCadObject({
      layer: "Заливка",
      sourceType: "HATCH",
      patternName: "ANSI32",
      points: rectangle(5_000, 2_780),
      closed: true,
      sourceUnitsPerMeter: 1_000,
    }).kind,
    "building",
  );
  assert.equal(
    recognizeCadObject({
      layer: "Заливка",
      sourceType: "HATCH",
      patternName: "ANSI32",
      points: rectangle(2_380, 800),
      closed: true,
      sourceUnitsPerMeter: 1_000,
    }).kind,
    "annotation",
    "мелкие образцы обозначений остаются плоскими",
  );
  assert.equal(
    recognizeCadObject({
      layer: "Заливка",
      blockName: "RM_AREA",
      sourceType: "INSERT",
      points: [{ x: 0, y: 0, z: 0 }],
      closed: false,
      sourceUnitsPerMeter: 1_000,
    }).kind,
    "annotation",
    "подписи площадей объёмами зданий не становятся",
  );
  assert.equal(
    isCadFeatureRenderable({
      id: "parcel",
      sourceType: "LWPOLYLINE",
      layer: "Границы участков",
      kind: "boundary",
      confidence: 0.94,
      reason: "test",
      closed: true,
      elevationMode: "draped",
      points: rectangle(20, 12),
    }),
    true,
  );
  assert.equal(
    recognizeCadObject({
      layer: "ГП-Граница учасика ИЖС",
      sourceType: "LWPOLYLINE",
      points: rectangle(20, 12),
      closed: true,
      sourceUnitsPerMeter: 1,
    }).kind,
    "fence",
    "linear IЖS parcel outlines become auditable fence panels",
  );
  assert.equal(
    recognizeCadObject({
      layer: "ГП-Граница учасика ИЖС",
      sourceType: "HATCH",
      points: rectangle(20, 12),
      closed: true,
      sourceUnitsPerMeter: 1,
    }).kind,
    "boundary",
    "штриховка участка не дублирует полотна забора",
  );
});
