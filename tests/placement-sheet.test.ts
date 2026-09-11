import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildSheetEntities,
  cornerTable,
  explication,
  legend,
  titleBlock,
} from "../app/lib/placement/sheet.ts";
import type { SheetContent } from "../app/lib/placement/sheet.ts";
import { buildDxf, buildDxfText } from "../app/lib/cad/exportDxf.ts";
import { parseDxf } from "../app/lib/placement/dxf.ts";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter.ts";
import { analyzePlacement } from "../app/lib/placement/engine.ts";
import { createSiteObject, inspectSiteObjects } from "../app/lib/placement/siteObjects.ts";
import { createContextMark } from "../app/lib/placement/siteContext.ts";
import { decodeDxf } from "../app/lib/cad/dxfEncoding.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";

function sheetFromDemo(): SheetContent {
  const drawing = parseDxf(
    readFileSync("public/demo/uchastok-3-vodoprovod.dxf", "utf8"),
    "uchastok-3-vodoprovod.dxf",
  );
  const source = placementSourceFromDxf(drawing, { name: "Участок 3", source: "demo" });
  const parcel = source.parcel!;
  const objects = [
    createSiteObject("house", { x: 0, y: 0 }, 1),
    createSiteObject("garage", { x: 12, y: 10 }, 2),
  ];
  const contextMarks = [createContextMark("waste", { x: 25, y: 25 }, 1)];
  const analysis = analyzePlacement({
    parcel,
    streetEdgeIndex: source.streetEdgeIndex,
    neighbors: source.neighbors,
    utilities: source.utilities,
    contextMarks,
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
  });
  return {
    parcel,
    analysis,
    source,
    objects: inspectSiteObjects(objects, parcel, 3, source.utilities).reports,
    contextMarks,
    info: {
      title: "Участок 3, посёлок Наурыз",
      cadastralNumber: "20:123:456:789",
      date: new Date("2026-09-08"),
    },
  };
}

test("экспликация перечисляет всё, что показано, и называет происхождение", () => {
  const rows = explication(sheetFromDemo());

  assert.equal(rows[0].label, "Границы земельного участка");
  assert.match(rows[0].origin, /из чертежа/u, "граница пришла из DXF, и это сказано");
  assert.equal(rows[1].label, "Зона, в пределах которой разрешено строительство");

  const numbers = rows.map((row) => row.number);
  assert.deepEqual(
    numbers,
    numbers.map((_, index) => index + 1),
    "нумерация сплошная",
  );
  assert.ok(rows.some((row) => /Жилой дом \(проектируемый\)/u.test(row.label)));
  assert.ok(rows.some((row) => /Существующее строение/u.test(row.label)));
  assert.ok(rows.some((row) => /Площадка ТБО/u.test(row.label) && /разрыв 20 м/u.test(row.origin)));
});

test("условные обозначения собираются из того, что на листе есть", () => {
  const content = sheetFromDemo();
  const full = legend(content);
  assert.ok(full.some((item) => /границы земельного участка/u.test(item)));
  assert.ok(
    full.some((item) => /охранные зоны/u.test(item)),
    "у участка есть водопровод",
  );
  assert.ok(full.some((item) => /проектируемые строения/u.test(item)));

  const bare = legend({
    ...content,
    objects: [],
    contextMarks: [],
    source: { ...content.source, neighbors: [] },
  });
  assert.equal(
    bare.some((item) => /проектируемые строения/u.test(item)),
    false,
    "чего нет на листе, того нет и в легенде",
  );
  assert.equal(
    bare.some((item) => /существующие строения/u.test(item)),
    false,
  );
});

test("штамп содержит площади и честную стадию", () => {
  const rows = Object.fromEntries(titleBlock(sheetFromDemo()));
  assert.equal(rows["Стадия"], "Предпроектная проработка");
  assert.equal(rows["Кадастровый номер"], "20:123:456:789");
  assert.match(rows["Площадь участка"], /^\d+ м²$/u);
  assert.match(rows["Площадь застройки"], /^\d+ м²$/u);
  assert.match(rows["Процент застройки"], /^\d+\.\d %$/u);
  assert.match(rows["Основание"], /требует проверки специалистом/u);
});

test("координаты углов совпадают с границей участка", () => {
  const content = sheetFromDemo();
  const corners = cornerTable(content.parcel);
  assert.equal(corners.length, content.parcel.length);
  assert.equal(corners[0].number, 1);
  assert.ok(Math.abs(corners[0].x - content.parcel[0].x) < 1e-9);
});

test("лист собирается в DXF со всеми слоями и открывается как текст", () => {
  const { layers, entities } = buildSheetEntities(sheetFromDemo());
  const text = buildDxfText(layers, entities);

  assert.match(text, /^0\r?\nSECTION/u, "файл начинается с секции DXF");
  assert.match(text, /EOF\s*$/u);
  for (const layer of [
    "ГРАНИЦА УЧАСТКА",
    "ПЯТНО ЗАСТРОЙКИ",
    "ЭКСПЛИКАЦИЯ",
    "УСЛОВНЫЕ ОБОЗНАЧЕНИЯ",
    "ШТАМП",
  ]) {
    assert.ok(text.includes(layer), `слой «${layer}» не попал в DXF`);
  }
  assert.ok(text.includes("СХЕМА ПЛАНИРОВОЧНОЙ ОРГАНИЗАЦИИ ЗЕМЕЛЬНОГО УЧАСТКА"));
  assert.ok(text.includes("КООРДИНАТЫ УГЛОВ УЧАСТКА"));

  const boundary = entities.filter(
    (entity) => entity.type === "polyline" && entity.layer === "ГРАНИЦА УЧАСТКА",
  );
  assert.equal(boundary.length, 1, "граница выведена ровно один раз");
});

test("таблицы уходят правее плана и не накрывают чертёж", () => {
  const content = sheetFromDemo();
  const { entities } = buildSheetEntities(content);
  const right = Math.max(...content.parcel.map((point) => point.x));
  const texts = entities.filter(
    (entity) => entity.type === "text" && ["ШТАМП", "УСЛОВНЫЕ ОБОЗНАЧЕНИЯ"].includes(entity.layer),
  );

  assert.ok(texts.length > 10, "штамп и легенда выведены");
  for (const entity of texts) {
    assert.ok(entity.type === "text" && entity.position.x > right, "таблица залезла на план");
  }
});

test("текст листа переживает CP1251: единицы и тире не превращаются в вопросы", () => {
  const { layers, entities } = buildSheetEntities(sheetFromDemo());
  const bytes = buildDxf(layers, entities);
  const decoded = new TextDecoder("windows-1251").decode(bytes);

  assert.ok(decoded.includes("946 м2"), "квадратные метры записаны как м2, а не м?");
  assert.equal(
    decoded.includes("?"),
    false,
    `в файле остались незаписываемые символы: ${decoded.slice(decoded.indexOf("?") - 40, decoded.indexOf("?") + 20)}`,
  );
  assert.ok(decoded.includes('"Участок 3'), "кавычки-ёлочки заменены на прямые");
});

test("скачанный лист возвращает границу участка, а не рамку штампа", () => {
  const original = sheetFromDemo();
  const { layers, entities } = buildSheetEntities(original);
  const drawing = parseDxf(decodeDxf(buildDxf(layers, entities)), "roundtrip.dxf");
  const restored = placementSourceFromDxf(drawing, { name: "Повторный импорт", source: "upload" });
  assert.ok(drawing.layers.includes("ГРАНИЦА УЧАСТКА"));
  assert.equal(restored.purpose?.allowsPlacement, true);
  assert.ok(Math.abs(polygonArea(restored.parcel!) - polygonArea(original.parcel)) < 0.001);
  assert.equal(
    restored.parcelConfirmed,
    false,
    "импорт не подменяет подтверждение кадастровой границы",
  );
});

test("современный DXF с UTF-8 сохраняет русские названия слоёв", () => {
  const { layers, entities } = buildSheetEntities(sheetFromDemo());
  const text = buildDxfText(layers, entities).replace("AC1009", "AC1021");
  assert.equal(decodeDxf(new TextEncoder().encode(text)), text);
});
