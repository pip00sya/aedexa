import assert from "node:assert/strict";
import test from "node:test";
import {
  attachLabelsToFeatures,
  collectDrawingTexts,
  normalizeDrawingText,
} from "../app/lib/cad/drawingTexts.ts";
import {
  applyCadSemantics,
  buildSemanticInventory,
  findLegendRows,
  parseCadSemanticDictionary,
} from "../app/lib/cad/semantics.ts";
import type { CadFeature, CadProcessingResult } from "../app/lib/cad/types.ts";

const rectangle = (width: number, height: number, x0 = 0, y0 = 0) => [
  { x: x0, y: y0, z: 0 },
  { x: x0 + width, y: y0, z: 0 },
  { x: x0 + width, y: y0 + height, z: 0 },
  { x: x0, y: y0 + height, z: 0 },
];

const feature = (
  id: string,
  kind: CadFeature["kind"],
  points: CadFeature["points"],
  extra: Partial<CadFeature> = {},
): CadFeature => ({
  id,
  sourceType: "HATCH",
  layer: "Заливка",
  kind,
  confidence: 0.9,
  reason: "test",
  closed: true,
  elevationMode: "draped",
  points,
  ...extra,
});

test("разметка MTEXT снимается, читаемая подпись остаётся", () => {
  assert.equal(normalizeDrawingText("{\\fArial|b0|i0;\\C1;ТИП-3}"), "ТИП-3");
  assert.equal(normalizeDrawingText("2КЖ\\PН"), "2КЖ Н");
  assert.equal(normalizeDrawingText("\\U+0417\\U+0414 \\H0.8x;сущ."), "ЗД сущ.");
  assert.equal(normalizeDrawingText("  П А Ш Н Я  "), "П А Ш Н Я");
});

test("собираются осмысленные подписи, а отметки, координаты и площади пропускаются", () => {
  const texts = collectDrawingTexts([
    { text: "ТИП-3", layer: "Заливка", x: 1, y: 1 },
    { text: "тип-3", layer: "ГП", x: 2, y: 2 },
    { text: "701.50", layer: "AREA", x: 3, y: 3 },
    { text: "4804000", layer: "РЕЛЬЕФ", x: 4, y: 4 },
    { text: "120 м²", layer: "ГП", x: 5, y: 5 },
    { text: "Все дома ТИП-3 — 2 этажа", layer: "Примечания", x: 6, y: 6 },
  ]);
  assert.deepEqual(
    texts.map((item) => [item.text, item.count]),
    [
      ["ТИП-3", 2],
      ["Все дома ТИП-3 — 2 этажа", 1],
    ],
  );
  assert.deepEqual(texts[0].layers, ["Заливка", "ГП"]);
  assert.equal(texts[0].points.length, 2);
});

test("подпись достаётся самому мелкому замкнутому контуру, внутри которого она стоит", () => {
  const features = [
    feature("house", "building", rectangle(4_000, 3_000, 10_000, 10_000)),
    feature("parcel", "boundary", rectangle(7_000, 4_500, 9_000, 9_000), {
      sourceType: "LWPOLYLINE",
    }),
    feature("field", "boundary", rectangle(200_000, 200_000, 0, 0), { sourceType: "LWPOLYLINE" }),
  ];
  const texts = collectDrawingTexts([
    { text: "ТИП-3", layer: "Заливка", x: 12_000, y: 11_500 },
    { text: "ПАШНЯ", layer: "РЕЛЬЕФ", x: 150_000, y: 150_000 },
    { text: "уч. 12", layer: "ГП", x: 9_500, y: 9_200 },
  ]);
  const labeled = attachLabelsToFeatures(features, texts, 1_000);
  assert.deepEqual(labeled[0].labels, ["ТИП-3"], "дом получает подпись, стоящую внутри его пятна");
  assert.deepEqual(labeled[1].labels, ["уч. 12"], "участку достаётся только подпись за пределами дома");
  assert.equal(labeled[2].labels, undefined, "огромные контуры подписи не собирают");
});

test("словарь от модели читается строго и сверяется с подписями чертежа", () => {
  const dictionary = parseCadSemanticDictionary(
    {
      summary: "Генплан посёлка ИЖС",
      entries: [
        {
          label: "тип-3",
          meaning: "Типовой жилой дом",
          kind: "building",
          status: "planned",
          floors: 2,
          heightMeters: 0,
          use: "жилой дом",
          confidence: 1.4,
          evidence: "легенда",
        },
        {
          label: "ВЫДУМКА",
          meaning: "нет такой подписи",
          kind: "building",
          status: "planned",
          floors: 9,
          heightMeters: 0,
          use: "",
          confidence: 0.9,
          evidence: "",
        },
        {
          label: "S=120 м²",
          meaning: "площадь",
          kind: "ignore",
          status: "unknown",
          floors: 0,
          heightMeters: 0,
          use: "",
          confidence: 0.9,
          evidence: "",
        },
      ],
      notes: ["Все дома ТИП-3 двухэтажные"],
    },
    ["ТИП-3", "S=120 м²", "Примечание: все дома ТИП-3 двухэтажные"],
  );
  assert.equal(dictionary.entries.length, 2, "неизвестные подписи отбрасываются");
  assert.equal(dictionary.entries[0].label, "ТИП-3", "подпись возвращается к написанию на чертеже");
  assert.equal(dictionary.entries[0].confidence, 1, "уверенность зажимается в пределах");
  assert.equal(dictionary.entries[0].floors, 2);
  assert.equal(dictionary.entries[0].heightMeters, undefined);
  assert.equal(dictionary.entries[1].kind, "ignore");
  assert.deepEqual(dictionary.notes, ["Все дома ТИП-3 двухэтажные"]);
  assert.throws(
    () => parseCadSemanticDictionary({ entries: [{ label: "ТИП-3", kind: "castle" }] }, ["ТИП-3"]),
    /неизвестный класс/,
  );
  assert.throws(() => parseCadSemanticDictionary({ entries: "no" }, []), /массив/);
  const ungrounded = parseCadSemanticDictionary(
    {
      entries: [
        {
          label: "ТИП-3",
          meaning: "Типовой дом, стандартно 2 этажа",
          kind: "building",
          status: "existing",
          floors: 2,
          heightMeters: 6.5,
          use: "",
          confidence: 0.9,
          evidence: "подпись «ТИП-3» ×37",
        },
      ],
    },
    ["ТИП-3", "карагач 20", "S=120 м²"],
  );
  assert.equal(
    ungrounded.entries[0].floors,
    undefined,
    "этажи требуют упоминания этажности где-нибудь на чертеже",
  );
  assert.equal(
    ungrounded.entries[0].heightMeters,
    undefined,
    "высота требует упоминания высоты на чертеже",
  );
  const grounded = parseCadSemanticDictionary(
    {
      entries: [
        {
          label: "2КЖ",
          meaning: "двухэтажный каменный жилой",
          kind: "building",
          status: "existing",
          floors: 2,
          heightMeters: 0,
          use: "",
          confidence: 0.9,
          evidence: "«2КЖ»",
        },
      ],
    },
    ["2КЖ"],
  );
  assert.equal(grounded.entries[0].floors, 2, "a conventional label like 2КЖ grounds the floors");
});

test("словарь применяется: этажи дают высоту, подписанные неизвестные контуры получают класс, снос уходит на проверку", () => {
  const base: CadProcessingResult = {
    fileName: "topo.dwg",
    fileSize: 1,
    formatVersion: "DWG",
    entityCount: 0,
    modelEntityCount: 0,
    renderedEntityCount: 0,
    omittedEntityCount: 0,
    layers: [
      { name: "Заливка", entityCount: 3, kind: "unknown", confidence: 0.35, reason: "test" },
    ],
    features: [
      feature("house", "building", rectangle(4_000, 3_000), {
        labels: ["ТИП-3"],
        heightQuality: "TEMPLATE",
        heightMeters: 3,
      }),
      feature("shed", "unknown", rectangle(3_000, 2_000, 20_000, 0), {
        sourceType: "LWPOLYLINE",
        labels: ["ХОЗБЛОК"],
      }),
      feature("old", "building", rectangle(4_000, 3_000, 40_000, 0), { labels: ["сн."] }),
      feature("plain", "building", rectangle(4_000, 3_000, 60_000, 0), { labels: ["S=120 м²"] }),
      feature("nolabel", "building", rectangle(4_000, 3_000, 80_000, 0)),
    ],
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 0 },
    terrain: {
      vertices: [],
      triangles: [],
      sampleCount: 0,
      minElevation: 0,
      maxElevation: 0,
      sourceSampleCount: 0,
      trustedSampleCount: 0,
      interpretedSampleCount: 0,
      rejectedSampleCount: 0,
      conflictingPointCount: 0,
      structuralLineCount: 0,
      method: "none",
      quality: {
        status: "insufficient",
        score: 0,
        coverageRatio: 0,
        retainedSampleRatio: 0,
        rejectedGapTriangleCount: 0,
        rejectedSlopeTriangleCount: 0,
        patchCount: 0,
      },
    },
    unitLabel: "мм",
    scopeMode: "all",
    preflight: { status: "ready", checks: [] },
    warnings: [],
    texts: [
      { text: "ТИП-3", count: 1, layers: ["Заливка"], points: [{ x: 1, y: 1 }] },
      { text: "ХОЗБЛОК", count: 1, layers: ["0"], points: [{ x: 21_000, y: 500 }] },
    ],
  };
  const inventory = buildSemanticInventory(base);
  assert.equal(
    inventory.texts[0].contexts[0].startsWith("внутри контура: здания, штриховка"),
    true,
    inventory.texts[0].contexts[0],
  );
  assert.equal(inventory.unitLabel, "мм");

  const applied = applyCadSemantics(base, {
    summary: "",
    notes: [],
    createdAt: "2026-09-06T00:00:00.000Z",
    entries: [
      {
        label: "ТИП-3",
        meaning: "типовой двухэтажный дом",
        kind: "building",
        status: "planned",
        floors: 2,
        confidence: 0.9,
        evidence: "легенда",
      },
      {
        label: "ХОЗБЛОК",
        meaning: "хозяйственная постройка",
        kind: "building",
        status: "planned",
        floors: 1,
        confidence: 0.85,
        evidence: "подпись",
      },
      {
        label: "сн.",
        meaning: "под снос",
        kind: "building",
        status: "demolition",
        confidence: 0.8,
        evidence: "обозначение",
      },
      {
        label: "S=120 м²",
        meaning: "площадь",
        kind: "ignore",
        status: "unknown",
        confidence: 0.9,
        evidence: "",
      },
    ],
  });
  const byId = new Map(applied.result.features.map((item) => [item.id, item]));
  assert.equal(applied.appliedCount, 3);
  const house = byId.get("house");
  assert.equal(house?.heightMeters, 6, "два этажа × 3 м");
  assert.equal(house?.heightQuality, "ANNOTATION");
  assert.equal(house?.heightSource, "AI_TEXT");
  assert.equal(house?.qaStatus, "AUTO", "подписанная высота — уже не допущение из шаблона");
  assert.equal(house?.semantic?.status, "planned");
  const shed = byId.get("shed");
  assert.equal(shed?.kind, "building");
  assert.equal(shed?.classificationSource, "AI_TEXT");
  assert.equal(shed?.heightMeters, 3);
  const old = byId.get("old");
  assert.equal(old?.qaStatus, "REVIEW");
  assert.match((old?.qaIssues ?? []).join(" "), /под снос/);
  assert.equal(byId.get("plain")?.semantic, undefined, "ignored labels change nothing");
  assert.equal(byId.get("nolabel")?.semantic, undefined);
});

test("строки условных обозначений читаются и разносятся по совпадающим штриховкам и линиям плана", () => {
  const line = (
    id: string,
    kind: CadFeature["kind"],
    points: CadFeature["points"],
    extra: Partial<CadFeature>,
  ): CadFeature => feature(id, kind, points, { sourceType: "LINE", closed: false, ...extra });
  const base: CadProcessingResult = {
    fileName: "topo.dwg",
    fileSize: 1,
    formatVersion: "DWG",
    entityCount: 0,
    modelEntityCount: 0,
    renderedEntityCount: 0,
    omittedEntityCount: 0,
    layers: [],
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 0 },
    unitLabel: "мм",
    scopeMode: "all",
    preflight: { status: "ready", checks: [] },
    warnings: [],
    terrain: {
      vertices: [],
      triangles: [],
      sampleCount: 0,
      minElevation: 0,
      maxElevation: 0,
      sourceSampleCount: 0,
      trustedSampleCount: 0,
      interpretedSampleCount: 0,
      rejectedSampleCount: 0,
      conflictingPointCount: 0,
      structuralLineCount: 0,
      method: "none",
      quality: {
        status: "insufficient",
        score: 0,
        coverageRatio: 0,
        retainedSampleRatio: 0,
        rejectedGapTriangleCount: 0,
        rejectedSlopeTriangleCount: 0,
        patchCount: 0,
      },
    },
    features: [
      feature("swatch", "annotation", rectangle(1_400, 1_800, 100_000, 100_000), {
        reason: "образец штриховки легенды",
        patternName: "ANSI31",
        colorFamily: "blue",
      }),
      line(
        "red-sample",
        "boundary",
        [
          { x: 100_000, y: 98_000, z: 0 },
          { x: 102_400, y: 98_000, z: 0 },
        ],
        { layer: "ГР.УЧ", colorFamily: "red", classificationSource: "CAD_LAYER", confidence: 0.94 },
      ),
      line(
        "green-sample",
        "fence",
        [
          { x: 100_000, y: 96_000, z: 0 },
          { x: 102_400, y: 96_000, z: 0 },
        ],
        { layer: "ГП", colorFamily: "green", classificationSource: "CAD_COLOR", confidence: 0.86 },
      ),
      feature("strip", "road", rectangle(5_700, 78_000, 0, 0), {
        patternName: "ANSI31",
        colorFamily: "blue",
        classificationSource: "CAD_GEOMETRY",
        confidence: 0.74,
        reason: "замкнутый контур в форме полосы",
      }),
      feature("house", "building", rectangle(4_000, 3_000, 50_000, 0), {
        patternName: "ANSI32",
        colorFamily: "blue",
        classificationSource: "CAD_GEOMETRY",
        confidence: 0.96,
      }),
      line(
        "red-line",
        "unknown",
        [
          { x: 0, y: -50_000, z: 0 },
          { x: 90_000, y: -50_000, z: 0 },
        ],
        {
          sourceType: "LWPOLYLINE",
          layer: "ГР.УЧ",
          colorFamily: "red",
          classificationSource: "UNKNOWN",
          confidence: 0.35,
        },
      ),
      line(
        "fence",
        "fence",
        [
          { x: 0, y: -60_000, z: 0 },
          { x: 90_000, y: -60_000, z: 0 },
        ],
        {
          sourceType: "LWPOLYLINE",
          layer: "ГП",
          colorFamily: "green",
          classificationSource: "CAD_COLOR",
          confidence: 0.86,
        },
      ),
    ],
    texts: [
      {
        text: "Участок общего пользования",
        count: 1,
        layers: ["0"],
        points: [{ x: 103_000, y: 100_900 }],
      },
      {
        text: "Граница участка освоения",
        count: 1,
        layers: ["0"],
        points: [{ x: 103_000, y: 98_000 }],
      },
      {
        text: "Граница участка индивидуального жилого дома",
        count: 1,
        layers: ["0"],
        points: [{ x: 103_000, y: 96_000 }],
      },
      {
        text: "Условные обозначения:",
        count: 1,
        layers: ["0"],
        points: [{ x: 101_000, y: 103_000 }],
      },
      { text: "ТИП-4", count: 11, layers: ["ГП"], points: [{ x: 3_000, y: -70_000 }] },
      { text: "шлагб.", count: 1, layers: ["РЕЛЬЕФ"], points: [{ x: 3_000, y: -80_000 }] },
    ],
  };
  base.features.push(
    line(
      "stray-red",
      "unknown",
      [
        { x: 0, y: -70_000, z: 0 },
        { x: 2_000, y: -70_000, z: 0 },
      ],
      { layer: "AREA", colorFamily: "red", classificationSource: "UNKNOWN", confidence: 0.35 },
    ),
    line(
      "stray-grey",
      "road",
      [
        { x: 0, y: -80_000, z: 0 },
        { x: 2_000, y: -80_000, z: 0 },
      ],
      {
        layer: "SIT_LДОРОГИ",
        colorFamily: "grey",
        classificationSource: "CAD_LAYER",
        confidence: 0.96,
      },
    ),
  );
  const rows = findLegendRows(base);
  assert.deepEqual(
    rows.map((row) => [row.text, row.signatures[0]]),
    [
      ["Участок общего пользования", { kind: "hatch", pattern: "ANSI31", colorFamily: "blue" }],
      ["Граница участка освоения", { kind: "line", colorFamily: "red", layer: "ГР.УЧ" }],
      [
        "Граница участка индивидуального жилого дома",
        { kind: "line", colorFamily: "green", layer: "ГП" },
      ],
    ],
  );
  const inventory = buildSemanticInventory(base);
  assert.equal(
    inventory.texts[0].contexts[0],
    "строка легенды, образец: штриховка ANSI31, цвет синий",
  );

  const applied = applyCadSemantics(base, {
    summary: "",
    notes: [],
    createdAt: "2026-09-06T00:00:00.000Z",
    entries: [
      {
        label: "Участок общего пользования",
        meaning: "территория общего пользования",
        kind: "site",
        status: "existing",
        confidence: 0.6,
        evidence: "легенда",
      },
      {
        label: "Граница участка освоения",
        meaning: "граница территории освоения",
        kind: "boundary",
        status: "planned",
        confidence: 0.7,
        evidence: "легенда",
      },
      {
        label: "Граница участка индивидуального жилого дома",
        meaning: "граница участка ИЖС",
        kind: "boundary",
        status: "planned",
        confidence: 0.75,
        evidence: "легенда",
      },
    ],
  });
  const byId = new Map(applied.result.features.map((item) => [item.id, item]));
  assert.equal(byId.get("strip")?.kind, "site", "условные обозначения перебивают догадку о дороге по форме");
  assert.match(byId.get("strip")?.reason ?? "", /по легенде чертежа «Участок общего пользования»/);
  assert.equal(byId.get("strip")?.classificationSource, "AI_TEXT");
  assert.equal(byId.get("house")?.kind, "building", "другой узор штриховки не затрагивается");
  assert.equal(byId.get("house")?.semantic, undefined);
  assert.equal(
    byId.get("red-line")?.kind,
    "boundary",
    "неклассифицированная линия берёт класс из обозначений",
  );
  assert.equal(byId.get("fence")?.kind, "fence", "забор, определённый по цвету, класс сохраняет");
  assert.equal(
    byId.get("fence")?.semantic?.label,
    "Граница участка индивидуального жилого дома",
    "но несёт смысл из обозначений",
  );
  assert.equal(
    byId.get("fence")?.heightMeters,
    0.6,
    "забор по границе участка становится низким разделителем",
  );
  assert.equal(byId.get("fence")?.heightQuality, "ANNOTATION");
  assert.match(byId.get("fence")?.reason ?? "", /низкий разделитель/);
  assert.equal(byId.get("swatch")?.semantic, undefined, "legend samples themselves are left alone");
  assert.equal(byId.get("red-sample")?.semantic, undefined);
  assert.equal(applied.appliedCount, 3);
});
