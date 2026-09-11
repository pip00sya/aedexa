import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { classifyDrawing } from "../app/lib/placement/drawingPurpose.ts";
import { parseDxf } from "../app/lib/placement/dxf.ts";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter.ts";
import { analyzePlacement } from "../app/lib/placement/engine.ts";
import { buildParcelTin } from "../app/lib/placement/terrain.ts";
import {
  createSiteObject,
  inspectSiteObjects,
  specOf,
  suggestSpot,
} from "../app/lib/placement/siteObjects.ts";
import { contextZones, createContextMark } from "../app/lib/placement/siteContext.ts";
import { buildSheetEntities } from "../app/lib/placement/sheet.ts";
import { buildDxf } from "../app/lib/cad/exportDxf.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";
import type { PlacementSource } from "../app/lib/placement/types.ts";

const demo = (file: string): PlacementSource =>
  placementSourceFromDxf(parseDxf(readFileSync(`public/demo/${file}`, "utf8"), file), {
    name: file,
    source: "demo",
  });

const analyze = (
  source: PlacementSource,
  over: Partial<Parameters<typeof analyzePlacement>[0]> = {},
) =>
  analyzePlacement({
    parcel: source.parcel!,
    streetEdgeIndex: source.streetEdgeIndex,
    neighbors: source.neighbors,
    utilities: source.utilities,
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
    ...over,
  });

/** Слои настоящих чертежей: топосъемка и архитектурный комплект */
const TOPO = ["SIT_LГРАНИЦЫ", "SIT_LГОРИЗОН", "Газопроводы", "SIT_LДОРОГИ", "ГР.УЧ"];
const INTERIOR = [
  "0",
  "AP_PEREGORODKA",
  "AP_OBORUDOVANIE",
  "EQP",
  "Граница полов внутри помещений",
  "!ПОТОЛКИ-ОТМЕТКИ",
];

test("Интерьерный чертёж не получает площадь участка и не строит рельеф", () => {
  const verdict = classifyDrawing({
    layers: INTERIOR,
    hasPlausibleParcel: true,
    parcelArea: 1200,
    markCount: 400,
  });
  assert.equal(verdict.allowsPlacement, false, `получено ${verdict.purpose}`);
});

test("Чертёж фасадов и разрезов предлагает 2D → 3D, а не посадку", () => {
  const verdict = classifyDrawing({
    layers: ["0", "СТЕНЫ", "оси", "двери", "окна", "лестницы", "колонны", "перекрытия"],
    hasPlausibleParcel: true,
    parcelArea: 4990,
    markCount: 112,
  });
  assert.equal(verdict.purpose, "building");
  assert.match(verdict.suggestion, /2D → 3D/u);
});

test("Топосъёмка и генплан продолжают давать участок", () => {
  assert.equal(
    classifyDrawing({ layers: TOPO, hasPlausibleParcel: true, markCount: 1891 }).allowsPlacement,
    true,
  );
  for (const file of ["uchastok-1-ravnina.dxf", "uchastok-4-otmetki.dxf"]) {
    const source = demo(file);
    assert.ok(source.parcel && source.parcel.length >= 3, `${file}: граница потеряна`);
  }
});

test("Битый файл даёт причину отказа, а не молчание", () => {
  assert.throws(
    () => parseDxf("не dxf вовсе", "broken.dxf"),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.message.length > 10, "причина не названа");
      return true;
    },
  );
});

test("Площадь участка правдоподобна: от 100 м² до 5 гектаров", () => {
  for (const file of [
    "uchastok-1-ravnina.dxf",
    "uchastok-2-sklon.dxf",
    "uchastok-3-vodoprovod.dxf",
    "uchastok-4-otmetki.dxf",
  ]) {
    const value = polygonArea(demo(file).parcel!);
    assert.ok(
      value >= 100 && value <= 50_000,
      `${file}: площадь ${Math.round(value)} м² вне разумных границ`,
    );
  }
});

test("Рельеф строится только по горизонталям или связным отметкам", () => {
  const flat = demo("uchastok-1-ravnina.dxf");
  assert.ok(
    buildParcelTin(flat.parcel!, flat.relief),
    "у участка с горизонталями поверхность есть",
  );

  const invented = buildParcelTin(flat.parcel!, {
    contours: [],
    marks: [],
    base: [],
    baseDropped: 0,
  });
  assert.equal(invented, null, "без данных поверхность не строится");
});

test("Пятно меньше контура после отступов, когда есть охранные зоны", () => {
  const source = demo("uchastok-3-vodoprovod.dxf");
  const result = analyze(source);
  assert.ok(source.utilities?.length, "у участка есть водопровод");
  assert.ok(result.buildableArea < polygonArea(result.buildable), "зона не вычтена из пятна");
});

test("Сеть, которой нет в чертеже, названа в списке недостающих", () => {
  const source = demo("uchastok-1-ravnina.dxf");
  const utility = analyze(source).rules.find((rule) => rule.id === "utility-clearance");
  assert.ok(utility, "правило по сетям отсутствует");
  assert.match(utility.detail, /Не найдены/u, "недостающие сети не перечислены");
});

test("Каждое правило несёт статус и ссылку на источник", () => {
  for (const rule of analyze(demo("uchastok-2-sklon.dxf")).rules) {
    assert.ok(
      ["PASS", "FAIL", "MISSING_DATA", "EXPERT_REVIEW"].includes(rule.status),
      `${rule.id}: статус ${rule.status}`,
    );
    assert.ok(rule.clause.length > 3, `${rule.id}: пункт нормы не назван`);
    assert.match(rule.sourceUrl, /^https?:\/\//u, `${rule.id}: нет ссылки на источник`);
  }
});

test("Постройка не выходит за границу участка ни при какой тесноте", () => {
  const parcel = [
    { x: 0, y: 0 },
    { x: 16, y: 0 },
    { x: 16, y: 16 },
    { x: 0, y: 16 },
  ];
  const house = createSiteObject("house", { x: 8, y: 8 }, 1);
  const spot = suggestSpot(parcel, [house], specOf("septic"), 3);
  const septic = createSiteObject("septic", spot, 2);
  const report = inspectSiteObjects([house, septic], parcel, 3).reports[1];
  assert.equal(
    report.issues.some((issue) => /выходит за границу/u.test(issue.text)),
    false,
  );
});

test("Санитарный разрыв до септика — запрет, разрыв от бани — совет", () => {
  const parcel = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 30 },
    { x: 0, y: 30 },
  ];
  const house = createSiteObject("house", { x: 20, y: 20 }, 1);
  const septic = createSiteObject("septic", { x: 20, y: 12 }, 2);
  const bath = createSiteObject("bath", { x: 8, y: 14 }, 3);
  const summary = inspectSiteObjects([house, septic, bath], parcel, 3);

  const septicIssues = summary.reports[1].issues;
  assert.ok(
    septicIssues.some((issue) => issue.severity === "conflict"),
    "разрыв до септика должен быть запретом",
  );
  const bathIssues = summary.reports[2].issues;
  assert.ok(
    bathIssues.some((issue) => issue.severity === "review"),
    "разрыв от бани должен быть советом",
  );
});

test("Наложение построек обнаруживается, включая вложенность", () => {
  const parcel = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 30 },
    { x: 0, y: 30 },
  ];
  const house = createSiteObject("house", { x: 20, y: 15 }, 1);
  const inside = { ...createSiteObject("garage", { x: 20, y: 15 }, 2), width: 2, depth: 2 };
  const report = inspectSiteObjects([house, inside], parcel, 3).reports[1];
  assert.ok(
    report.issues.some((issue) => /Налезает/u.test(issue.text)),
    "гараж внутри дома не замечен",
  );
});

test("Срез и подсыпка считаются только при настоящей поверхности", () => {
  const source = demo("uchastok-1-ravnina.dxf");
  const parcel = source.parcel!;
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);

  const withTin = inspectSiteObjects(
    [house],
    parcel,
    3,
    source.utilities,
    buildParcelTin(parcel, source.relief),
  );
  assert.ok(withTin.reports[0].earth, "на поверхности земляные работы считаются");

  const without = inspectSiteObjects([house], parcel, 3, source.utilities, null);
  assert.equal(without.reports[0].earth, null, "без поверхности объёмы не выдумываются");
  assert.equal(without.cut, 0);
});

test("Окружение: зона от отметки вычитается из пятна и требует подтверждения", () => {
  const source = demo("uchastok-1-ravnina.dxf");
  const marks = [createContextMark("waste", { x: 0, y: 0 }, 1)];
  const zones = contextZones(marks);
  assert.equal(zones[0].status, "EXPERT_REVIEW", "непроверенное правило не даёт чистого PASS");

  const before = analyze(source).buildableArea;
  const after = analyze(source, { contextMarks: marks }).buildableArea;
  assert.ok(
    after < before,
    `пятно не уменьшилось: было ${Math.round(before)}, стало ${Math.round(after)}`,
  );
});

test("Лист: собирается в DXF и переживает CP1251", () => {
  const source = demo("uchastok-3-vodoprovod.dxf");
  const parcel = source.parcel!;
  const analysis = analyze(source);
  const { layers, entities } = buildSheetEntities({
    parcel,
    analysis,
    source,
    objects: inspectSiteObjects([createSiteObject("house", { x: 0, y: 0 }, 1)], parcel, 3).reports,
    contextMarks: [],
    info: { title: "Проверка листа", date: new Date("2026-09-08") },
  });
  const text = new TextDecoder("windows-1251").decode(buildDxf(layers, entities));

  assert.ok(text.includes("СХЕМА ПЛАНИРОВОЧНОЙ ОРГАНИЗАЦИИ ЗЕМЕЛЬНОГО УЧАСТКА"));
  assert.ok(text.includes("КООРДИНАТЫ УГЛОВ УЧАСТКА"));
  assert.equal(text.includes("?"), false, "в листе остались символы вне кодировки");
});

