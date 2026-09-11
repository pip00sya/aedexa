import assert from "node:assert/strict";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { POST } from "../app/api/reconstruct/route";
import {
  buildDeterministicCadAnalysis,
  compactCadContext,
} from "../app/lib/reconstruction/server/context";
import {
  needsTopologyRepair,
  normalizeAiCoordinateConvention,
  stabilizePedestrianBridgeDraft,
} from "../app/lib/reconstruction/server/model";
import * as THREE from "three";
import {
  createReconstructionGroup,
  disposeReconstructionGroup,
  exportReconstructionDae,
  setReconstructionOutlineMode,
} from "../app/lib/reconstruction/modelScene";
import {
  buildBuildingDraft,
  buildingContourCandidates,
  parseBuildingRecipe,
} from "../app/lib/reconstruction/buildingSolver";
import {
  extractCadReconstructionContext,
  fitSvgRasterDimensions,
  filterCadPreviewEntities,
  repairCadSvg,
  svgDimensionNeedsViewBox,
} from "../app/lib/reconstruction/prepareDrawing";
import { parseDrawingAnalysis, parseReconstructionModel } from "../app/lib/reconstruction/schema";

type ModelRequest = {
  model: string;
  max_tokens: number;
  response_format: { type: string };
  messages: Array<{ role: string; content: unknown }>;
};

const requestBody = (body: Record<string, unknown>) => body as unknown as ModelRequest;
// форма ответа уходит модели текстом в системном сообщении
const requestShape = (body: Record<string, unknown>) =>
  String(requestBody(body).messages[0].content);
const requestHasKey = (body: Record<string, unknown>, key: string) =>
  requestShape(body).includes(`"${key}":`);
const requestActionEnum = (body: Record<string, unknown>): string[] => {
  const found = requestShape(body).match(/"action": одно из (\[[^\]]*\])/);
  return found ? (JSON.parse(found[1]) as string[]) : [];
};
const requestContent = (body: Record<string, unknown>) =>
  requestBody(body).messages[1].content as Array<Record<string, unknown>>;
const requestPrompt = (body: Record<string, unknown>) =>
  String(requestContent(body).at(-1)?.text);
const requestImages = (body: Record<string, unknown>) => requestContent(body).slice(0, -1);
const imageUrl = (block: Record<string, unknown>) => (block.image_url as { url: string }).url;
const modelAnswer = (payload: unknown) =>
  Response.json({
    choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
  });

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0",
    objectName: "Кронштейн",
    documentType: "orthographic",
    unit: "mm",
    summary: "Три согласованных ортогональных вида с размерами.",
    detectedViews: ["спереди", "сверху", "сбоку"],
    dimensions: [{ label: "Ширина", value: 80, unit: "mm", source: "drawing", confidence: 1 }],
    features: [
      {
        id: "body",
        name: "Основание",
        kind: "solid",
        relatedViews: ["спереди", "сверху"],
        evidence: ["Контур совпадает на двух видах."],
        confidence: 0.98,
      },
    ],
    conclusions: [
      {
        id: "body-shape",
        statement: "Основание имеет прямоугольную форму 80 × 10 × 50 мм.",
        evidence: ["Размеры на трёх видах."],
        confidence: 0.96,
        affectsGeometry: true,
      },
    ],
    unresolved: [],
    sufficientFor3d: true,
    overallConfidence: 0.96,
    ...overrides,
  };
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0",
    sourceName: "bracket.pdf",
    method: "ai_vision",
    status: "ready",
    title: "Кронштейн",
    unit: "mm",
    summary: "Все три ортогональных вида и размеры согласованы.",
    detectedViews: ["спереди", "сверху", "сбоку"],
    dimensions: [{ label: "Ширина", value: 80, unit: "mm", source: "drawing", confidence: 1 }],
    parts: [
      {
        id: "base",
        name: "Основание",
        kind: "box",
        position: { x: 0, y: 5, z: 0 },
        rotationDegrees: { x: 0, y: 0, z: 0 },
        size: { x: 80, y: 10, z: 50 },
        radius: 0,
        height: 0,
        profile: [],
        holes: [],
        vertices: [],
        faces: [],
        color: "#5d83b5",
        confidence: 1,
        evidence: ["Размеры 80, 10 и 50 нанесены на согласованных видах."],
      },
    ],
    unresolved: [],
    warnings: [],
    overallConfidence: 0.96,
    canExport: true,
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    objectName: "Кронштейн",
    summary: "Геометрия и размеры согласованы с исходными видами.",
    accepted: true,
    overallConfidence: 0.97,
    rejectedPartIds: [],
    corrections: [],
    unresolved: [],
    warnings: [],
    ...overrides,
  };
}

function agentStep(action: string, overrides: Record<string, unknown> = {}) {
  const verifiedElements =
    action === "finish"
      ? [
          "bridge_span",
          "left_tower",
          "right_tower",
          "stair_flights",
          "landings",
          "guardrails",
          "lift_shafts",
          "canopies",
          "foundations",
        ]
      : [];
  return {
    action,
    reason: "Проверяю точные CAD-данные и геометрию перед приёмкой.",
    entityTypes: [],
    layerContains: "",
    scope: "all",
    region: "",
    limit: 120,
    solver: action === "run_parametric_solver" ? "pedestrian_bridge" : "none",
    verifiedElements,
    mismatches: [],
    visualConfidence: action === "finish" ? 0.94 : 0,
    ...overrides,
  };
}

async function readFinal(response: Response) {
  const lines = (await response.text()).trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as unknown;
}

test("обмерная параметрическая реконструкция принимается", () => {
  const result = parseReconstructionModel(model());
  assert.equal(result.canExport, true);
  assert.equal(result.parts[0].size.x, 80);
});

test("плотные поверхности рисуются обычно, прозрачные контуры — только в контурном режиме", () => {
  const parsed = parseReconstructionModel(
    model({
      parts: [{ ...model().parts[0], id: "tower-canopy-test" }],
    }),
  );
  const group = createReconstructionGroup(parsed);
  try {
    const mesh = group.children[0] as THREE.Mesh;
    const surface = mesh.material as THREE.MeshStandardMaterial;
    const edges = mesh.children[0] as THREE.LineSegments;
    const edgeMaterial = edges.material as THREE.LineBasicMaterial;
    assert.equal(surface.transparent, false);
    assert.equal(surface.opacity, 1);
    assert.equal(surface.depthWrite, true);
    assert.equal(surface.side, THREE.DoubleSide);
    setReconstructionOutlineMode(group, true);
    assert.equal(surface.transparent, true);
    assert.equal(surface.opacity, 0);
    assert.equal(surface.depthWrite, false);
    assert.equal(surface.colorWrite, false);
    assert.equal(edgeMaterial.opacity, 0.92);
    assert.equal(edgeMaterial.depthTest, false);
    assert.equal(edgeMaterial.depthWrite, false);
    setReconstructionOutlineMode(group, false);
    assert.equal(surface.transparent, false);
    assert.equal(surface.opacity, 1);
    assert.equal(surface.depthWrite, true);
    assert.equal(surface.colorWrite, true);
    assert.equal(edgeMaterial.opacity, 0.42);
    assert.equal(edgeMaterial.depthTest, true);
    assert.equal(edgeMaterial.depthWrite, true);
  } finally {
    disposeReconstructionGroup(group);
  }
});

test("бесконечные вспомогательные лучи CAD не попадают в предпросмотр", () => {
  const entities = filterCadPreviewEntities([
    { type: "LINE" },
    { type: "RAY" },
    { type: "XLINE" },
    { type: "INSERT", xScale: 1, yScale: 1 },
    { type: "INSERT", xScale: 200, yScale: 200 },
    { type: "DIMENSION" },
  ]);
  assert.deepEqual(
    entities.map((entity) => [entity.type, entity.xScale]),
    [
      ["LINE", undefined],
      ["INSERT", 1],
      ["DIMENSION", undefined],
    ],
  );
});

test("процентные размеры SVG заменяются собственными размерами viewBox", () => {
  assert.equal(svgDimensionNeedsViewBox("100%"), true);
  assert.equal(svgDimensionNeedsViewBox(null), true);
  assert.equal(svgDimensionNeedsViewBox("107058.75"), false);
  assert.equal(svgDimensionNeedsViewBox("640px"), false);
  assert.deepEqual(fitSvgRasterDimensions(107_058.75, 64_870.43), { width: 4200, height: 2545 });
});

test("из CAD вытаскиваются пространство модели, таблицы, размеры и блоки", () => {
  const database = {
    header: { INSUNITS: 4, EXTMIN: { x: 0, y: 0, z: 0 }, EXTMAX: { x: 200, y: 300, z: 20 } },
    entities: [
      {
        type: "DIMENSION",
        handle: "D1",
        layer: "DIM",
        measurement: 80,
        text: "<>",
        styleName: "ISO-25",
        definitionPoint: { x: 0, y: 0, z: 0 },
        subDefinitionPoint1: { x: 0, y: 20, z: 0 },
        subDefinitionPoint2: { x: 80, y: 20, z: 0 },
        textRotation: 0,
      },
      {
        type: "INSERT",
        handle: "I1",
        layer: "PARTS",
        name: "BRACKET",
        insertionPoint: { x: 100, y: 200, z: 0 },
        xScale: 2,
        yScale: 2,
        zScale: 1,
        rotation: 1.5707963267948966,
        rowCount: 1,
        columnCount: 1,
        attribs: [
          { type: "ATTRIB", tag: "PART_NO", text: "A-17", startPoint: { x: 100, y: 200, z: 0 } },
        ],
      },
      {
        type: "ARC",
        handle: "A1",
        layer: "PROFILE",
        center: { x: 25, y: 30, z: 0 },
        radius: 12,
        startAngle: 0,
        endAngle: Math.PI,
      },
    ],
    tables: {
      LAYER: {
        entries: [
          {
            name: "PROFILE",
            frozen: false,
            off: false,
            locked: false,
            lineType: "CONTINUOUS",
            lineweight: 25,
          },
        ],
      },
      DIMSTYLE: { entries: [{ name: "ISO-25", DIMSCALE: 1, DIMLFAC: 1, DIMDEC: 2 }] },
      LTYPE: { entries: [{ name: "CONTINUOUS", description: "Solid line", patternLength: 0 }] },
      STYLE: { entries: [{ name: "STANDARD", fixedTextHeight: 0, widthFactor: 1 }] },
      BLOCK_RECORD: {
        entries: [
          {
            name: "BRACKET",
            handle: "B1",
            flags: 0,
            basePoint: { x: 0, y: 0, z: 0 },
            insertionUnits: 4,
            description: "Reusable bracket",
            explodability: 1,
            scalability: 1,
            entities: [
              {
                type: "CIRCLE",
                handle: "C1",
                layer: "PROFILE",
                center: { x: 5, y: 5, z: 0 },
                radius: 3,
                thickness: 4,
              },
            ],
          },
        ],
      },
    },
  } as unknown as Parameters<typeof extractCadReconstructionContext>[0];

  const context = JSON.parse(extractCadReconstructionContext(database)) as Record<string, unknown>;
  assert.equal(context.format, "AEDEXA_CAD_CONTEXT_V3");
  assert.equal(context.recognizedUnit, "mm");
  assert.equal((context.entityCount as Record<string, number>).modelSpace, 3);
  assert.equal((context.entityCount as Record<string, number>).blockDefinitions, 1);
  const tables = context.tables as Record<string, Array<Record<string, unknown>>>;
  assert.equal(tables.layers[0].name, "PROFILE");
  assert.equal(tables.dimensionStyles[0].DIMLFAC, 1);
  const entities = context.entities as Array<Record<string, unknown>>;
  const dimension = entities.find((entity) => entity.h === "D1");
  assert.equal(dimension?.measurement, 80);
  assert.deepEqual(dimension?.subDefinitionPoint2, [80, 20]);
  const insert = entities.find((entity) => entity.h === "I1");
  assert.equal(insert?.rot, 1.5707963267948966);
  assert.deepEqual(insert?.p, [100, 200]);
  const blockCircle = entities.find((entity) => entity.h === "C1");
  assert.equal(blockCircle?.s, "b:BRACKET");
  assert.equal(blockCircle?.rad, 3);
  assert.ok(Array.isArray(context.spatialRegions));
  assert.ok(extractCadReconstructionContext(database).length <= 820_000);
});

test("контуры фасада и разреза не выдаются за пятно плана", () => {
  const closed = (handle: string, layer: string, x: number) => ({
    type: "LWPOLYLINE",
    handle,
    layer,
    flag: 1,
    vertices: [
      { x, y: 0, z: 0 },
      { x: x + 20, y: 0, z: 0 },
      { x: x + 20, y: 10, z: 0 },
      { x, y: 10, z: 0 },
    ],
  });
  const database = {
    header: { INSUNITS: 4, EXTMIN: { x: 0, y: 0, z: 0 }, EXTMAX: { x: 100, y: 40, z: 0 } },
    entities: [
      closed("PLAN", "АР-СТЕНЫ", 0),
      closed("FACADE", "ФАСАД-18", 30),
      closed("SECTION", "Section A-A", 60),
    ],
    tables: {
      LAYER: { entries: [] },
      DIMSTYLE: { entries: [] },
      LTYPE: { entries: [] },
      STYLE: { entries: [] },
      BLOCK_RECORD: { entries: [] },
    },
  } as unknown as Parameters<typeof extractCadReconstructionContext>[0];
  const context = JSON.parse(extractCadReconstructionContext(database)) as {
    planContourCandidates: Array<{ handle: string }>;
  };
  assert.deepEqual(
    context.planContourCandidates.map((candidate) => candidate.handle),
    ["PLAN"],
  );
});

test("замкнутая полилиния размером с комнату не становится пятном всего здания", () => {
  const database = {
    header: { INSUNITS: 4, EXTMIN: { x: 0, y: 0, z: 0 }, EXTMAX: { x: 24_000, y: 12_000, z: 0 } },
    entities: [
      {
        type: "MTEXT",
        handle: "T1",
        layer: "TEXT",
        text: "План этажа",
        position: { x: 1_000, y: 1_000, z: 0 },
      },
      {
        type: "DIMENSION",
        handle: "D1",
        layer: "DIM",
        measurement: 18_000,
        text: "<>",
        definitionPoint: { x: 0, y: 0, z: 0 },
        subDefinitionPoint1: { x: 0, y: 100, z: 0 },
        subDefinitionPoint2: { x: 18_000, y: 100, z: 0 },
      },
      {
        type: "LWPOLYLINE",
        handle: "ROOM",
        layer: "WALL",
        flag: 1,
        vertices: [
          { x: 0, y: 0, z: 0 },
          { x: 4_900, y: 0, z: 0 },
          { x: 4_900, y: 3_000, z: 0 },
          { x: 0, y: 3_000, z: 0 },
        ],
      },
      {
        type: "LWPOLYLINE",
        handle: "FACADE_STRIP",
        layer: "WALL",
        flag: 1,
        vertices: [
          { x: 0, y: 5_000, z: 0 },
          { x: 9_000, y: 5_000, z: 0 },
          { x: 9_000, y: 5_500, z: 0 },
          { x: 0, y: 5_500, z: 0 },
        ],
      },
    ],
    tables: {
      LAYER: { entries: [] },
      DIMSTYLE: { entries: [] },
      LTYPE: { entries: [] },
      STYLE: { entries: [] },
      BLOCK_RECORD: { entries: [] },
    },
  } as unknown as Parameters<typeof extractCadReconstructionContext>[0];
  const context = JSON.parse(extractCadReconstructionContext(database)) as {
    planContourCandidates: Array<{ handle: string }>;
  };
  assert.deepEqual(context.planContourCandidates, []);
});

test("имя из штампа не смешивается с повторяющимися подписями узлов", () => {
  const database = {
    header: { INSUNITS: 4, EXTMIN: { x: 0, y: 0, z: 0 }, EXTMAX: { x: 60_000, y: 20_000, z: 0 } },
    entities: [
      { type: "MTEXT", handle: "M1", text: "Подъемник", position: { x: 0, y: 0, z: 0 } },
      { type: "MTEXT", handle: "M2", text: "Подъемник", position: { x: 50_000, y: 0, z: 0 } },
      {
        type: "LINE",
        handle: "L1",
        startPoint: { x: 0, y: 0, z: 0 },
        endPoint: { x: 42_600, y: 0, z: 0 },
      },
    ],
    tables: {
      LAYER: { entries: [] },
      DIMSTYLE: { entries: [] },
      LTYPE: { entries: [] },
      STYLE: { entries: [] },
      BLOCK_RECORD: {
        entries: [
          {
            name: "*Paper_Space",
            handle: "P1",
            entities: [
              {
                type: "MTEXT",
                handle: "TITLE",
                text: "Надземный пешеходный переход\\Pна км 21 + 165",
                position: { x: 10, y: 10, z: 0 },
              },
            ],
          },
        ],
      },
    },
  } as unknown as Parameters<typeof extractCadReconstructionContext>[0];

  const full = JSON.parse(extractCadReconstructionContext(database)) as Record<string, unknown>;
  const identity = full.documentIdentity as Record<string, Array<Record<string, unknown>>>;
  assert.equal(identity.titleCandidates[0].text, "Надземный пешеходный переход на км 21 + 165");
  assert.equal(identity.repeatedComponentLabels[0].text, "Подъемник");
  const layoutEntity = (full.entities as Array<Record<string, unknown>>).find(
    (entity) => entity.h === "TITLE",
  );
  assert.equal(layoutEntity?.s, "p:*Paper_Space");

  const compact = JSON.parse(compactCadContext(JSON.stringify(full), true, 20_000)) as Record<
    string,
    unknown
  >;
  const compactIdentity = compact.documentIdentity as Record<
    string,
    Array<Record<string, unknown>>
  >;
  assert.equal(
    compactIdentity.titleCandidates[0].text,
    "Надземный пешеходный переход на км 21 + 165",
  );
  assert.ok(
    (compact.entities as Array<Record<string, unknown>>).some((entity) => entity.h === "TITLE"),
  );
});

test("большой паспорт CAD остаётся корректным, а записи за пределом объёма перечисляются", () => {
  const database = {
    header: { INSUNITS: 4 },
    entities: Array.from({ length: 20_000 }, (_, index) => ({
      type: "LINE",
      handle: `L${index}`,
      layer: `DETAILED_GEOMETRY_${index % 20}`,
      startPoint: { x: index, y: index % 97, z: 0 },
      endPoint: { x: index + 10, y: (index % 97) + 5, z: 0 },
      lineType: "CONTINUOUS",
      lineweight: 25,
    })),
    tables: {
      LAYER: { entries: [] },
      DIMSTYLE: { entries: [] },
      LTYPE: { entries: [] },
      STYLE: { entries: [] },
      BLOCK_RECORD: { entries: [] },
    },
  } as unknown as Parameters<typeof extractCadReconstructionContext>[0];

  const serialized = extractCadReconstructionContext(database);
  const context = JSON.parse(serialized) as Record<string, unknown>;
  const truncation = context.truncation as Record<string, number>;
  assert.ok(serialized.length <= 820_000);
  assert.ok(truncation.entityRecordsIncluded > 0);
  assert.ok(truncation.entityRecordsOmitted > 0);
  assert.equal(truncation.entityRecordsIncluded + truncation.entityRecordsOmitted, 20_000);
});

test("плотная разметка CAD уравновешивается всеми крупными семействами геометрии", () => {
  const annotations = Array.from({ length: 5_000 }, (_, index) => ({
    type: index % 2 ? "DIMENSION" : "MTEXT",
    handle: `A${index}`,
    layer: "ANNOTATION",
    text: index % 2 ? `${index + 1}` : `Note ${index}`,
    measurement: index + 1,
    definitionPoint: { x: index % 500, y: Math.floor(index / 500), z: 0 },
  }));
  const geometryTypes = ["LINE", "ARC", "LWPOLYLINE", "HATCH", "CIRCLE", "SPLINE"];
  const geometry = geometryTypes.flatMap((type, typeIndex) =>
    Array.from({ length: 300 }, (_, index) => ({
      type,
      handle: `${type}-${index}`,
      layer: "GEOMETRY",
      startPoint: { x: index, y: typeIndex * 100, z: 0 },
      endPoint: { x: index + 10, y: typeIndex * 100 + 5, z: 0 },
      center: { x: index, y: typeIndex * 100, z: 0 },
      radius: 5,
      vertices: [
        { x: index, y: 0, z: 0 },
        { x: index + 5, y: 5, z: 0 },
      ],
      controlPoints: [
        { x: index, y: 0, z: 0 },
        { x: index + 5, y: 5, z: 0 },
      ],
      boundaryPaths: [
        {
          vertices: [
            { x: index, y: 0 },
            { x: index + 5, y: 5 },
          ],
        },
      ],
    })),
  );
  const database = {
    header: { INSUNITS: 4, EXTMIN: { x: 0, y: 0, z: 0 }, EXTMAX: { x: 500, y: 600, z: 0 } },
    entities: [...annotations, ...geometry],
    tables: {
      LAYER: { entries: [] },
      DIMSTYLE: { entries: [] },
      LTYPE: { entries: [] },
      STYLE: { entries: [] },
      BLOCK_RECORD: { entries: [] },
    },
  } as unknown as Parameters<typeof extractCadReconstructionContext>[0];

  const context = JSON.parse(extractCadReconstructionContext(database)) as {
    entities: Array<{ t?: string }>;
  };
  const includedTypes = new Set(context.entities.map((entity) => entity.t));
  geometryTypes.forEach((type) =>
    assert.ok(includedTypes.has(type), `${type} must be represented`),
  );
  assert.ok(includedTypes.has("DIMENSION"));
  assert.ok(includedTypes.has("MTEXT"));
});

test("метрическая модель COLLADA 1.4.1 уходит в SketchUp", async () => {
  const blob = exportReconstructionDae(parseReconstructionModel(model()));
  const content = await blob.text();
  const document = new XMLParser({ ignoreAttributes: false }).parse(content);
  assert.equal(blob.type, "model/vnd.collada+xml");
  assert.equal(document.COLLADA["@_version"], "1.4.1");
  assert.match(content, /version="1\.4\.1"/);
  assert.match(content, /<unit name="meter" meter="1"\/>/);
  assert.match(content, /<up_axis>Y_UP<\/up_axis>/);
  assert.match(content, /<geometry id="geometry-part-0" name="Основание">/);
  assert.match(content, /<triangles material="material-part-0-symbol" count="12">/);
  assert.match(content, /\b0\.04\b/);
  assert.doesNotMatch(content, /\b(?:NaN|Infinity)\b/);
});

test("нерешённая геометрия уходит черновиком с явной пометкой", async () => {
  const draft = parseReconstructionModel(
    model({
      status: "needs_input",
      unresolved: [
        {
          id: "depth",
          label: "Глубина",
          reason: "Размер не подтверждён.",
          requiredFromUser: "Добавьте боковой вид.",
          severity: "critical",
        },
      ],
    }),
  );
  assert.equal(draft.canExport, false);
  const content = await exportReconstructionDae(draft).text();
  assert.match(content, /<export_status>draft<\/export_status>/);
  assert.match(content, /<geometry id="geometry-part-0"/);
});

test("нерешённый скрытый размер закрывает выгрузку", () => {
  const result = parseReconstructionModel(
    model({
      status: "needs_input",
      canExport: true,
      unresolved: [
        {
          id: "depth",
          label: "Глубина",
          reason: "На листе нет бокового вида.",
          requiredFromUser: "Укажите глубину или приложите боковой вид.",
          severity: "critical",
        },
      ],
    }),
  );
  assert.equal(result.canExport, false);
});

test("негодная геометрия до выпуска не доходит", () => {
  const invalid = model();
  (invalid.parts as Array<Record<string, unknown>>)[0].size = { x: 80, y: 0, z: 50 };
  assert.throws(() => parseReconstructionModel(invalid), /больше нуля/);
});

test("найденная проверкой критическая неопределённость перебивает бодрый результат в объёме", () => {
  const audited = analysis({
    sufficientFor3d: false,
    unresolved: [
      {
        id: "depth",
        label: "Глубина",
        reason: "Нет бокового вида.",
        requiredFromUser: "Добавьте боковой вид.",
        severity: "critical",
      },
    ],
  });
  assert.equal(parseDrawingAnalysis(audited).sufficientFor3d, false);
  const result = parseReconstructionModel(model({ analysis: audited }));
  assert.equal(result.status, "needs_input");
  assert.equal(result.canExport, false);
});

test("видно, когда многоузловой объект свернули в слишком мало частей", () => {
  const features = Array.from({ length: 8 }, (_, index) => ({
    id: `feature-${index}`,
    name: `Узел ${index}`,
    kind: "solid" as const,
    relatedViews: ["главный вид"],
    evidence: ["Контур"],
    confidence: 0.9,
  }));
  const audited = parseDrawingAnalysis(analysis({ features }));
  assert.equal(needsTopologyRepair(audited, { parts: [{}, {}, {}] }), true);
  assert.equal(
    needsTopologyRepair(audited, { parts: Array.from({ length: 8 }, () => ({})) }),
    false,
  );
});

test("местная модель, положившая высоту чертежа на ось Z, приводится к норме", () => {
  const audited = parseDrawingAnalysis(
    analysis({
      dimensions: [
        { label: "Lp = 42600", value: 42600, unit: "mm", source: "drawing", confidence: 1 },
        { label: "Высота", value: 3810, unit: "mm", source: "drawing", confidence: 1 },
      ],
    }),
  );
  const part = (id: string, x: number) => ({
    id,
    position: { x, y: 0, z: 3810 },
    rotationDegrees: { x: 0, y: 16, z: 0 },
    size: { x: 42600, y: 2250, z: 400 },
  });
  const normalized = normalizeAiCoordinateConvention(
    { parts: [part("a", -21300), part("b", 21300), part("c", 0)], warnings: [] },
    audited,
  );
  const parts = normalized.parts as Array<Record<string, unknown>>;
  assert.deepEqual(parts[0].position, { x: 0, y: 3810, z: 0 });
  assert.deepEqual(parts[0].size, { x: 42600, y: 400, z: 2250 });
  assert.deepEqual(parts[0].rotationDegrees, { x: 0, y: 0, z: 16 });

  const quarterTurn = normalizeAiCoordinateConvention(
    {
      parts: [part("a", -21300), part("b", 21300), part("c", 0)].map((entry) => ({
        ...entry,
        rotationDegrees: { x: 0, y: 90, z: 0 },
      })),
      warnings: [],
    },
    audited,
  );
  assert.deepEqual((quarterTurn.parts as Array<Record<string, unknown>>)[0].rotationDegrees, {
    x: 0,
    y: 0,
    z: 0,
  });
});

test("пешеходный мост собирается связной сборкой, а не перестановкой коробок от модели", async () => {
  const audited = parseDrawingAnalysis(
    analysis({
      objectName: "Надземный пешеходный переход на км 21 + 165",
      dimensions: [
        { label: "Lp = 42600", value: 42600, unit: "mm", source: "drawing", confidence: 1 },
        {
          label: "Общая длина перехода",
          value: 57900,
          unit: "mm",
          source: "drawing",
          confidence: 1,
        },
        { label: "Клиренс над дорогой", value: 3810, unit: "mm", source: "drawing", confidence: 1 },
        { label: "Ширина прохода", value: 2250, unit: "mm", source: "drawing", confidence: 1 },
        {
          label: "Перепад отметок основания и дороги",
          value: 2790,
          unit: "mm",
          source: "drawing",
          confidence: 1,
        },
        {
          label: "Высота подъёма до перехода",
          value: 6600,
          unit: "mm",
          source: "drawing",
          confidence: 1,
        },
        {
          label: "Глубина лестничной башни",
          value: 13430,
          unit: "mm",
          source: "drawing",
          confidence: 1,
        },
        {
          label: "Длина лестничной башни",
          value: 7800,
          unit: "mm",
          source: "drawing",
          confidence: 1,
        },
        {
          label: "Горизонтальная проекция лестничного марша",
          value: 4470,
          unit: "mm",
          source: "drawing",
          confidence: 1,
        },
        {
          label: "Ширина лестничного марша",
          value: 1750,
          unit: "mm",
          source: "drawing",
          confidence: 1,
        },
      ],
      conclusions: [
        {
          id: "span",
          statement: "Общая длина перехода составляет 42600 мм.",
          evidence: ["Lp"],
          confidence: 1,
          affectsGeometry: true,
        },
        {
          id: "clearance",
          statement: "Высота перехода над дорогой составляет 3810 мм.",
          evidence: ["Размер"],
          confidence: 1,
          affectsGeometry: true,
        },
        {
          id: "width",
          statement: "Ширина прохода составляет 2250 мм.",
          evidence: ["Размер"],
          confidence: 1,
          affectsGeometry: true,
        },
        {
          id: "canopy",
          statement: "Угол наклона навесов лестничных башен составляет 15°.",
          evidence: ["Размер"],
          confidence: 1,
          affectsGeometry: true,
        },
      ],
    }),
  );
  const box = (id: string, name: string) => ({
    id,
    name,
    kind: "box",
    position: { x: 0, y: 3810, z: 0 },
    rotationDegrees: { x: 0, y: 0, z: 0 },
    size: { x: 42600, y: 400, z: 6600 },
    radius: 0,
    height: 0,
    profile: [],
    holes: [],
    vertices: [],
    faces: [],
    color: "#5d83b5",
    confidence: 0.95,
    evidence: ["Черновик"],
  });
  const stabilized = stabilizePedestrianBridgeDraft(
    {
      parts: [
        box("deck", "Центральная балка пролёта"),
        box("lift-left", "Левый лифтовый блок"),
        box("lift-right", "Правый лифтовый блок"),
        box("rail-left", "Левое ограждение пролёта"),
        box("rail-right", "Правое ограждение пролёта"),
      ],
      warnings: [],
    },
    audited,
  );
  const parts = stabilized.parts as Array<Record<string, unknown>>;
  const deck = parts.find((part) => part.id === "bridge-deck")!;
  const roof = parts.find((part) => part.id === "bridge-roof")!;
  const leftLift = parts.find((part) => part.id === "tower-lift-left")!;
  const rightLift = parts.find((part) => part.id === "tower-lift-right")!;
  const firstStair = parts.find((part) => part.id === "tower-stair-stringer-left-0-a")!;
  const secondStair = parts.find((part) => part.id === "tower-stair-stringer-left-1-a")!;
  const thirdStair = parts.find((part) => part.id === "tower-stair-stringer-left-2-a")!;
  const leftFoundation = parts.find((part) => part.id === "tower-foundation-left-inner-0")!;
  const leftCanopy = parts.find((part) => part.id === "tower-canopy-left")!;
  const rightCanopy = parts.find((part) => part.id === "tower-canopy-right")!;
  assert.deepEqual(deck.size, { x: 42600, y: 250, z: 2250 });
  assert.equal((deck.position as Record<string, number>).y, 6475);
  assert.equal((roof.position as Record<string, number>).y, 10394);
  assert.equal(
    Math.abs((leftCanopy.position as Record<string, number>).x) +
      (leftCanopy.size as Record<string, number>).x / 2 -
      300,
    57900 / 2,
  );
  assert.equal(parts.length, 587);
  assert.ok((leftLift.position as Record<string, number>).x < 0);
  assert.ok((rightLift.position as Record<string, number>).x > 0);
  assert.ok(Math.abs((leftLift.position as Record<string, number>).z) > 13430 / 2);
  assert.ok(Math.abs((rightLift.position as Record<string, number>).z) > 13430 / 2);
  assert.equal(
    (leftLift.position as Record<string, number>).z,
    -(rightLift.position as Record<string, number>).z,
  );
  assert.ok((firstStair.rotationDegrees as Record<string, number>).x < 0);
  assert.ok((secondStair.rotationDegrees as Record<string, number>).x > 0);
  assert.ok((thirdStair.rotationDegrees as Record<string, number>).x < 0);
  assert.equal(
    (firstStair.position as Record<string, number>).x,
    (thirdStair.position as Record<string, number>).x,
  );
  assert.notEqual(
    (firstStair.position as Record<string, number>).x,
    (secondStair.position as Record<string, number>).x,
  );
  assert.notEqual(
    (leftLift.position as Record<string, number>).x,
    (firstStair.position as Record<string, number>).x,
  );
  assert.ok((leftCanopy.rotationDegrees as Record<string, number>).x < 0);
  assert.ok((rightCanopy.rotationDegrees as Record<string, number>).x > 0);
  assert.equal(Math.abs((leftCanopy.rotationDegrees as Record<string, number>).x), 15);
  assert.ok((leftCanopy.size as Record<string, number>).z > 13430);
  assert.ok((leftFoundation.position as Record<string, number>).y < 0);
  assert.equal(parts.filter((part) => String(part.id).startsWith("bridge-frame-post-")).length, 44);
  assert.equal(parts.filter((part) => String(part.id).startsWith("bridge-guard-post-")).length, 44);
  assert.equal(parts.filter((part) => String(part.id).startsWith("bridge-guard-rail-")).length, 12);
  assert.equal(parts.filter((part) => String(part.id).startsWith("bridge-roof-frame-")).length, 22);
  assert.equal(
    parts.filter((part) => String(part.id).startsWith("bridge-truss-diagonal-")).length,
    0,
  );
  assert.equal(parts.filter((part) => String(part.id).startsWith("tower-column-")).length, 16);
  assert.equal(
    parts.filter((part) => String(part.id).startsWith("tower-stair-stringer-")).length,
    12,
  );
  assert.equal(parts.filter((part) => String(part.id).startsWith("tower-stair-rail-")).length, 60);
  assert.equal(parts.filter((part) => String(part.id).startsWith("tower-stair-post-")).length, 48);
  assert.equal(
    parts.filter((part) => String(part.id).startsWith("tower-landing-rail-")).length,
    80,
  );
  assert.equal(parts.filter((part) => String(part.id).startsWith("tower-lift-post-")).length, 8);
  assert.equal(parts.filter((part) => String(part.id).startsWith("tower-lift-ring-")).length, 32);
  assert.equal(parts.filter((part) => String(part.id).startsWith("tower-foundation-")).length, 16);
  assert.equal(parts.filter((part) => String(part.id).startsWith("tower-tread-")).length, 66);
  assert.equal(
    parts.some((part) => String(part.id).startsWith("bridge-stair-")),
    false,
  );
  parts.forEach((part) => {
    const size = part.size as Record<string, number>;
    assert.ok(
      size.x > 0 && size.y > 0 && size.z > 0,
      `${String(part.id)} must have non-zero geometry`,
    );
  });
  assert.equal(deck.confidence, 0.65);

  const parsed = parseReconstructionModel({
    ...model({ status: "needs_input", canExport: false }),
    ...stabilized,
    analysis: audited,
  });
  const dae = await exportReconstructionDae(parsed).text();
  assert.equal((dae.match(/<geometry id=/g) || []).length, 587);
});

test("агент сам выбирает, осматривает и утверждает детерминированный решатель моста", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FEATHERLESS_API_KEY;
  const outputs = [
    agentStep("run_parametric_solver"),
    agentStep("finish", {
      reason:
        "Сопоставлены пролёт, две башни, три марша, ограждения, рамы и навесы на трёх проекциях.",
    }),
  ];
  const upstreamBodies: Record<string, unknown>[] = [];
  let call = 0;
  process.env.FEATHERLESS_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return modelAnswer(outputs[call++]);
  };

  try {
    const response = await POST(
      new Request("http://localhost/api/reconstruct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceName: "bridge.dwg",
          dataUrls: [
            "data:image/png;base64,aGVsbG8=",
            "data:image/png;base64,dGlsZS0x",
            "data:image/png;base64,dGlsZS0y",
          ],
          context: JSON.stringify({
            format: "AEDEXA_CAD_CONTEXT_V3",
            recognizedUnit: "mm",
            documentIdentity: {
              titleCandidates: [{ text: "Надземный пешеходный переход на км 21 + 165" }],
            },
            entities: [
              { t: "DIMENSION", display: "Lp = 42600", nominal: 42600 },
              { t: "DIMENSION", measurement: 3810 },
              { t: "DIMENSION", measurement: 2250 },
              { t: "DIMENSION", measurement: 2790 },
            ],
          }),
          hints: { unit: "mm", allowInferredGeometry: true },
        }),
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const payload = (await readFinal(response)) as {
      model: ReturnType<typeof parseReconstructionModel>;
    };
    assert.equal(upstreamBodies.length, 2);
    assert.equal(requestHasKey(upstreamBodies[0], "action"), true);
    assert.equal(requestActionEnum(upstreamBodies[0]).includes("run_parametric_solver"), true);
    assert.deepEqual(requestActionEnum(upstreamBodies[1]), ["finish", "generic_reconstruction"]);
    const finalAgentImages = requestImages(upstreamBodies[1]);
    assert.equal(finalAgentImages.length, 4);
    assert.match(imageUrl(finalAgentImages[3]), /^data:image\/png;base64,iVBOR/);
    assert.equal(payload.model.method, "ai_agent");
    assert.equal(payload.model.agentTrace?.llmInvoked, true);
    assert.equal(payload.model.agentTrace?.previewCompared, true);
    assert.equal(payload.model.agentTrace?.completed, true);
    assert.equal(payload.model.agentTrace?.reviewConfidence, 0.94);
    assert.equal(payload.model.agentTrace?.verifiedElements.length, 9);
    assert.equal(payload.model.parts.length, 587);
    assert.equal(
      payload.model.parts.some((part) => part.id === "tower-stair-stringer-left-0-a"),
      true,
    );
    assert.equal(
      payload.model.parts.some((part) => part.id === "tower-stair-stringer-right-2-b"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FEATHERLESS_API_KEY;
    else process.env.FEATHERLESS_API_KEY = originalKey;
  }
});

test("обмерный DWG моста читается, и до выдачи объёма модель обязана пройти настоящий цикл вызовов", async () => {
  const context = JSON.stringify({
    format: "AEDEXA_CAD_CONTEXT_V3",
    recognizedUnit: "mm",
    documentIdentity: {
      titleCandidates: [{ text: "Надземный пешеходный переход на км 21 + 165" }],
    },
    entities: [
      { t: "DIMENSION", h: "D1", display: "Lp = 42600", nominal: 42600, measurement: 42600 },
      { t: "DIMENSION", h: "D2", measurement: 3810 },
      { t: "DIMENSION", h: "D3", measurement: 2250 },
      { t: "DIMENSION", h: "D4", measurement: 2790 },
      { t: "DIMENSION", h: "D5", measurement: 57900 },
      {
        t: "DIMENSION",
        h: "D6",
        measurement: 6600,
        subDefinitionPoint1: [0, 0],
        subDefinitionPoint2: [0, 6600],
      },
      { t: "DIMENSION", h: "D7", measurement: 13430 },
      { t: "DIMENSION", h: "D8", measurement: 7800 },
      { t: "DIMENSION", h: "D9", measurement: 4470 },
      { t: "DIMENSION", h: "D10", measurement: 1750 },
      { t: "DIMENSION", h: "D11", display: "15°", dimType: 2 },
      { s: "m", t: "LINE", p1: [-21300, 8938], p2: [21300, 8938] },
      { s: "m", t: "LINE", p1: [-21300, 10394], p2: [21300, 10394] },
      ...Array.from({ length: 21 }, (_, index) => ({
        s: "m",
        t: "LINE",
        p1: [-21000 + index * 2000, 7765],
        p2: [-19200 + index * 2000, 7765],
      })),
      ...Array.from({ length: 22 }, (_, index) => ({
        s: "m",
        t: "LINE",
        p1: [-21000 + index * 2000, 8938],
        p2: [-21000 + index * 2000, 10394],
      })),
      { t: "MTEXT", text: "План" },
      { t: "MTEXT", text: "Разрез 1-1" },
    ],
  });
  const audited = buildDeterministicCadAnalysis(context, { allowInferredGeometry: true });
  assert.equal(audited?.objectName, "Надземный пешеходный переход на км 21 + 165");
  assert.equal(audited?.documentType, "orthographic");
  assert.equal(audited?.dimensions.length, 10);
  assert.equal(
    audited?.dimensions.some(
      (entry) => entry.label === "Общая длина перехода" && entry.value === 57900,
    ),
    true,
  );
  assert.equal(
    audited?.dimensions.some(
      (entry) => entry.label === "Высота подъёма до перехода" && entry.value === 6600,
    ),
    true,
  );
  assert.equal(
    audited?.dimensions.some(
      (entry) => entry.label === "Перепад отметок основания и дороги" && entry.value === 2790,
    ),
    true,
  );
  assert.equal(
    audited?.dimensions.some(
      (entry) => entry.label === "Глубина лестничной башни" && entry.value === 13430,
    ),
    true,
  );
  assert.equal(
    audited?.conclusions.some(
      (entry) => entry.id === "cad-canopy-angle" && entry.statement.includes("15°"),
    ),
    true,
  );
  assert.equal(
    audited?.conclusions.some(
      (entry) => entry.id === "cad-bridge-frame-bottom" && entry.statement.includes("2338"),
    ),
    true,
  );
  assert.equal(
    audited?.conclusions.some(
      (entry) => entry.id === "cad-bridge-frame-height" && entry.statement.includes("1456"),
    ),
    true,
  );
  assert.equal(
    audited?.conclusions.some(
      (entry) => entry.id === "cad-bridge-guardrail" && entry.statement.includes("1165"),
    ),
    true,
  );

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FEATHERLESS_API_KEY;
  process.env.FEATHERLESS_API_KEY = "test-key";
  let upstreamCalls = 0;
  const outputs = [agentStep("run_parametric_solver"), agentStep("finish")];
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return modelAnswer(outputs[upstreamCalls - 1]);
  };
  try {
    const response = await POST(
      new Request("http://localhost/api/reconstruct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceName: "180726 (1).dwg",
          dataUrls: ["data:image/png;base64,aGVsbG8="],
          context,
          hints: { allowInferredGeometry: true },
        }),
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const payload = (await readFinal(response)) as {
      model: ReturnType<typeof parseReconstructionModel>;
    };
    assert.equal(upstreamCalls, 2);
    assert.equal(payload.model.method, "ai_agent");
    assert.equal(
      payload.model.agentTrace?.steps.map((step) => step.action).join(","),
      "run_parametric_solver,finish",
    );
    assert.equal(payload.model.parts.length, 587);
    assert.equal(payload.model.parts.find((part) => part.id === "bridge-deck")?.size.x, 42600);
    assert.equal(
      payload.model.parts.some((part) => part.id === "bridge-roof"),
      true,
    );
    assert.equal(
      payload.model.parts.filter((part) => part.id.startsWith("tower-tread-")).length,
      66,
    );
    assert.equal(
      Math.abs(
        payload.model.parts.find((part) => part.id === "tower-canopy-left")!.rotationDegrees.x,
      ),
      15,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FEATHERLESS_API_KEY;
    else process.env.FEATHERLESS_API_KEY = originalKey;
  }
});

test("чертёж уходит к модели со схемой ответа, ответ проверяется", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FEATHERLESS_API_KEY;
  const source = model();
  const aiModel = { ...source } as Record<string, unknown>;
  delete aiModel.sourceName;
  delete aiModel.method;
  const candidateModel = structuredClone(aiModel);
  ((candidateModel.parts as Array<Record<string, unknown>>)[0].size as Record<string, unknown>).x =
    78;
  candidateModel.overallConfidence = 0.82;
  const outputs = [
    analysis(),
    candidateModel,
    review({
      corrections: [
        {
          partId: "base",
          position: { x: 0, y: 5, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          size: { x: 80, y: 10, z: 50 },
          radius: 0,
          height: 0,
          reason: "Размер ширины 80 мм подтверждён пользовательским вводом.",
        },
      ],
    }),
  ];
  const upstreamBodies: Record<string, unknown>[] = [];
  let call = 0;
  process.env.FEATHERLESS_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return modelAnswer(outputs[call++]);
  };

  try {
    const response = await POST(
      new Request("http://localhost/api/reconstruct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceName: "bracket.png",
          dataUrl: "data:image/png;base64,aGVsbG8=",
          dataUrls: ["data:image/png;base64,aGVsbG8=", "data:image/png;base64,dGlsZQ=="],
          context: JSON.stringify({
            format: "AEDEXA_CAD_CONTEXT_V3",
            marker: "rich-cad-context",
            entities: [
              { t: "LINE", h: "heavy-line" },
              { t: "DIMENSION", h: "dimension-evidence" },
            ],
          }),
          hints: { unit: "mm", width: 80, allowInferredGeometry: false },
        }),
      }),
    );
    assert.equal(response.status, 200);
    const payload = (await readFinal(response)) as {
      model: ReturnType<typeof parseReconstructionModel>;
    };
    assert.equal(payload.model.sourceName, "bracket.png");
    assert.equal(payload.model.canExport, true);
    assert.equal(payload.model.parts[0].size.x, 80);
    assert.equal(payload.model.overallConfidence, 0.82);
    assert.equal(payload.model.analysis?.objectName, "Кронштейн");
    assert.equal(upstreamBodies.length, 3);
    upstreamBodies.forEach((body) => {
      assert.equal(requestBody(body).response_format.type, "json_object");
      assert.match(requestPrompt(body), /AEDEXA_CAD_CONTEXT_V3/);
    });
    assert.equal(requestHasKey(upstreamBodies[0], "sufficientFor3d"), true);
    assert.equal(requestHasKey(upstreamBodies[1], "parts"), true);
    assert.equal(requestHasKey(upstreamBodies[2], "corrections"), true);
    const analysisPrompt = requestPrompt(upstreamBodies[0]);
    const modelPrompt = requestPrompt(upstreamBodies[1]);
    assert.match(analysisPrompt, /СТРОГИЙ РЕЖИМ/);
    assert.match(analysisPrompt, /titleCandidates/);
    assert.match(modelPrompt, /СТРОГИЙ РЕЖИМ/);
    assert.doesNotMatch(analysisPrompt, /heavy-line/);
    assert.match(analysisPrompt, /dimension-evidence/);
    assert.match(modelPrompt, /heavy-line/);
    const imageBlocks = requestImages(upstreamBodies[0]);
    assert.equal(imageBlocks.length, 2);
    imageBlocks.forEach((imageBlock) => {
      assert.equal(imageBlock.type, "image_url");
      assert.match(imageUrl(imageBlock), /^data:image\/png;base64,/);
    });
    const reviewImages = requestImages(upstreamBodies[2]);
    assert.equal(reviewImages.length, 2);
    reviewImages.forEach((imageBlock) => assert.equal(imageBlock.type, "image_url"));
    const reviewPrompt = requestPrompt(upstreamBodies[2]);
    assert.match(reviewPrompt, /Черновая 3D-модель/);
    assert.match(reviewPrompt, /"x":78/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FEATHERLESS_API_KEY;
    else process.env.FEATHERLESS_API_KEY = originalKey;
  }
});

test("повторяющаяся подпись узла исправляется по штампу до сборки объёма", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FEATHERLESS_API_KEY;
  const wrongAnalysis = analysis({
    objectName: "Подъемник",
    summary: "Локальная подпись ошибочно принята за объект.",
  });
  const wrongModel = { ...model({ title: "Подъемник" }) } as Record<string, unknown>;
  delete wrongModel.sourceName;
  delete wrongModel.method;
  const outputs = [wrongAnalysis, wrongModel, review({ objectName: "Подъемник" })];
  const upstreamBodies: Record<string, unknown>[] = [];
  let call = 0;
  process.env.FEATHERLESS_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return modelAnswer(outputs[call++]);
  };

  try {
    const response = await POST(
      new Request("http://localhost/api/reconstruct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceName: "bridge.dwg",
          dataUrls: ["data:image/png;base64,aGVsbG8="],
          context: JSON.stringify({
            format: "AEDEXA_CAD_CONTEXT_V3",
            documentIdentity: {
              selectionPolicy: "title wins",
              titleCandidates: [
                {
                  text: "Надземный пешеходный переход на км 21 + 165",
                  count: 1,
                  scopes: ["b:TITLE"],
                },
              ],
              repeatedComponentLabels: [{ text: "Подъемник", count: 2, scopes: ["m"] }],
            },
            entities: [],
          }),
          hints: { unit: "mm", allowInferredGeometry: false },
        }),
      }),
    );
    assert.equal(response.status, 200);
    const payload = (await readFinal(response)) as {
      model: ReturnType<typeof parseReconstructionModel>;
    };
    assert.equal(payload.model.analysis?.objectName, "Надземный пешеходный переход на км 21 + 165");
    assert.equal(payload.model.title, "Надземный пешеходный переход на км 21 + 165");
    const modelPrompt = requestPrompt(upstreamBodies[1]);
    assert.match(modelPrompt, /"objectName":"Надземный пешеходный переход на км 21 \+ 165"/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FEATHERLESS_API_KEY;
    else process.env.FEATHERLESS_API_KEY = originalKey;
  }
});

test("обмерный черновик восстанавливается, и независимая итоговая проверка идёт всегда", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FEATHERLESS_API_KEY;
  const issue = {
    id: "hidden-joint",
    label: "Скрытый узел",
    reason: "Узел не показан в разрезе.",
    requiredFromUser: "Добавьте разрез узла.",
    severity: "critical",
  };
  const audited = analysis({
    sufficientFor3d: false,
    unresolved: [issue],
    overallConfidence: 0.76,
  });
  const rawModel = (overrides: Record<string, unknown>) => {
    const value = {
      ...model({ status: "needs_input", canExport: false, unresolved: [issue], ...overrides }),
    } as Record<string, unknown>;
    delete value.sourceName;
    delete value.method;
    return value;
  };
  const emptyCandidate = rawModel({ parts: [] });
  const recoveredCandidate = rawModel({
    status: "ready",
    canExport: true,
    overallConfidence: 0.74,
  });
  const outputs = [
    audited,
    emptyCandidate,
    recoveredCandidate,
    review({
      objectName: "Кронштейн",
      accepted: false,
      overallConfidence: 0.74,
      unresolved: [issue],
    }),
  ];
  const upstreamBodies: Record<string, unknown>[] = [];
  let call = 0;
  process.env.FEATHERLESS_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return modelAnswer(outputs[call++]);
  };

  try {
    const response = await POST(
      new Request("http://localhost/api/reconstruct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceName: "bridge.dwg",
          dataUrls: ["data:image/png;base64,aGVsbG8="],
          context: JSON.stringify({ format: "AEDEXA_CAD_CONTEXT_V3", marker: "measured-cad" }),
          hints: { unit: "mm" },
        }),
      }),
    );
    assert.equal(response.status, 200);
    const payload = (await readFinal(response)) as {
      model: ReturnType<typeof parseReconstructionModel>;
    };
    assert.equal(upstreamBodies.length, 4);
    assert.equal(requestHasKey(upstreamBodies[2], "parts"), true);
    assert.equal(requestHasKey(upstreamBodies[3], "corrections"), true);
    const recoveryPrompt = requestPrompt(upstreamBodies[2]);
    assert.match(recoveryPrompt, /Первый проход не создал геометрию/);
    assert.match(recoveryPrompt, /РЕЖИМ САМОСТОЯТЕЛЬНОЙ AI-РЕКОНСТРУКЦИИ/);
    assert.match(recoveryPrompt, /самостоятельно выбери консервативную толщину\/глубину/);
    assert.equal(payload.model.parts.length, 1);
    assert.equal(payload.model.status, "needs_input");
    assert.equal(payload.model.canExport, false);
    assert.match(payload.model.warnings.join(" "), /Режим AI-допущений включён/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FEATHERLESS_API_KEY;
    else process.env.FEATHERLESS_API_KEY = originalKey;
  }
});

test("битый текст SVG из CAD и негодные границы растра починяются", () => {
  const repaired = repairCadSvg(
    '<svg viewBox="NaN NaN NaN NaN" width="NaN" height="NaN"><defs><g id="204&211"/></defs><use href="#204&211"/><text><i</text></svg>',
    { min: { x: 100, y: 200, z: 0 }, max: { x: 900, y: 700, z: 0 } },
  );
  assert.match(repaired, /viewBox="100 -700 800 500"/);
  assert.match(repaired, /&lt;i/);
  assert.match(repaired, /204&amp;211/);
  assert.doesNotMatch(repaired, /="NaN"/);
  assert.doesNotThrow(() => new XMLParser().parse(repaired));
});

test("решатель здания переносит абсолютные координаты DWG к центру и ограничивает дуговые кровли", () => {
  const buildingAnalysis = parseDrawingAnalysis(
    analysis({
      objectName: "Гостиничный комплекс",
      dimensions: [
        { label: "Общий габарит", value: 50_000, unit: "mm", source: "cad", confidence: 0.98 },
        { label: "Глубина", value: 18_000, unit: "mm", source: "cad", confidence: 0.98 },
      ],
    }),
  );
  const recipe = parseBuildingRecipe({
    applicable: true,
    reason: "Дуговой многоэтажный гостиничный корпус прочитан по плану и фасаду.",
    unit: "mm",
    overallWidth: 50_000,
    overallDepth: 18_000,
    floorHeight: 3_150,
    masses: [
      {
        id: "hotel",
        name: "Дуговой корпус",
        shape: "arc",
        centerX: 1_450_000,
        centerZ: 820_000,
        width: 50_000,
        depth: 8_000,
        startLevel: 0,
        levels: 10,
        rotationDegrees: 90,
        arcSweepDegrees: 145,
        roof: "flat",
        roofHeight: 37_000,
        windowColumnsFront: 16,
        windowColumnsSide: 0,
        windowWidth: 1_050,
        windowHeight: 1_450,
        entrance: true,
        cores: 2,
        footprintHandle: "",
      },
    ],
    confidence: 0.82,
    assumptions: [],
  });
  const draft = buildBuildingDraft(
    "hotel.dwg",
    buildingAnalysis,
    { allowInferredGeometry: true },
    recipe,
  );
  const shell = draft.parts.find((part) => part.id.endsWith("-shell"));
  const roof = draft.parts.find((part) => part.id === "hotel-roof");
  assert.ok(shell && roof);
  assert.ok(Math.abs(shell.position.x) < 30_000);
  assert.ok(Math.abs(shell.position.z) < 20_000);
  assert.ok(roof.position.y < 33_000);
  assert.ok(draft.parts.length > 100);

  const contours = buildingContourCandidates(
    JSON.stringify({
      planContourCandidates: [
        {
          handle: "FP1",
          width: 50_000,
          depth: 18_000,
          vertices: [
            [0, 0, 0],
            [50_000, 0, 0],
            [50_000, 7_000, 0],
            [20_000, 7_000, 0],
            [20_000, 18_000, 0],
            [0, 18_000, 0],
          ],
        },
      ],
    }),
  );
  const exactDraft = buildBuildingDraft(
    "hotel.dwg",
    buildingAnalysis,
    { allowInferredGeometry: true },
    {
      ...recipe,
      masses: [{ ...recipe.masses[0], shape: "box", rotationDegrees: 0, footprintHandle: "FP1" }],
    },
    contours,
  );
  const exactShell = exactDraft.parts.find((part) => part.id === "hotel-shell");
  assert.equal(exactShell?.kind, "extrusion");
  assert.equal(exactShell?.profile.length, 6);
  assert.equal(
    exactDraft.parts.some((part) => part.id === "building-foundation"),
    false,
  );
});

test("архитектурные отметки в метрах внутри миллиметрового здания приводятся к норме", () => {
  const saunaAnalysis = parseDrawingAnalysis(
    analysis({
      objectName: "Деревянное каркасное здание (сауна)",
      dimensions: [
        { label: "Общий габарит", value: 8_875, unit: "mm", source: "drawing", confidence: 1 },
      ],
    }),
  );
  const saunaRecipe = parseBuildingRecipe({
    applicable: true,
    reason: "План и фасады сауны согласованы.",
    unit: "mm",
    overallWidth: 8_875,
    overallDepth: 4_400,
    floorHeight: 2.31,
    masses: [
      {
        id: "sauna",
        name: "Основной объём",
        shape: "box",
        centerX: 0,
        centerZ: 0,
        width: 4_400,
        depth: 3_300,
        startLevel: 0,
        levels: 1,
        rotationDegrees: 0,
        arcSweepDegrees: 0,
        roof: "gable",
        roofHeight: 1.09,
        windowColumnsFront: 2,
        windowColumnsSide: 1,
        windowWidth: 1.5,
        windowHeight: 1.894,
        entrance: true,
        porchSteps: 3,
        balconyLevels: [1],
        cores: 0,
        footprintHandle: "",
      },
    ],
    confidence: 0.85,
    assumptions: [],
  });
  const draft = buildBuildingDraft(
    "sauna.dwg",
    saunaAnalysis,
    { allowInferredGeometry: true },
    saunaRecipe,
  );
  const shell = draft.parts.find((part) => part.id === "sauna-s1-shell");
  const window = draft.parts.find((part) => part.id.startsWith("sauna-s1-window"));
  assert.equal(shell?.size.y, 2_310);
  assert.equal(window?.size.y, 1_894);
  assert.match(shell?.evidence.join(" ") || "", /нормализованы из метров в миллиметры/);
  assert.equal(draft.parts.filter((part) => part.id.startsWith("sauna-porch-step-")).length, 3);
  assert.ok(draft.parts.some((part) => part.id === "sauna-balcony-1"));
  assert.ok(draft.parts.some((part) => part.id === "sauna-balcony-1-rail"));
});

test("подпись комнаты не становится названием всей гостиницы", () => {
  const context = JSON.stringify({
    format: "AEDEXA_CAD_CONTEXT_V3",
    recognizedUnit: "mm",
    documentIdentity: {
      titleCandidates: [{ text: "Гардероб персонала отеля с душевой", count: 2 }],
    },
    entityCount: { modelSpace: 1000 },
    entities: [
      { t: "TEXT", text: "План типового этажа" },
      { t: "TEXT", text: "Фасад 1-16" },
      { t: "DIMENSION", nominal: 50_000 },
      { t: "DIMENSION", nominal: 18_000 },
      { t: "DIMENSION", nominal: 3_150 },
    ],
  });
  const audited = buildDeterministicCadAnalysis(
    context,
    { allowInferredGeometry: true },
    "gostinichny_komplex.dwg",
  );
  assert.equal(audited?.objectName, "gostinichny komplex");
});

test("шаг агента без строгой схемы: служебные фильтры приводятся к дефолтам, решение проверяется строго", async () => {
  const { parseCadAgentStep } = await import("../app/lib/reconstruction/server/agentSchema.ts");
  const step = parseCadAgentStep({
    action: "inspect_entities",
    reason: "проверить контуры",
    entityTypes: "LINE, LWPOLYLINE, all",
    layerContains: null,
    scope: "везде",
    region: undefined,
    limit: "40",
    solver: "",
    verifiedElements: ["roof", "выдумка"],
    mismatches: [{ element: "roof", severity: "серьёзно", description: "скат не совпал" }, "мусор"],
    visualConfidence: "0.7",
  });

  assert.deepEqual(
    step.entityTypes,
    ["LINE", "LWPOLYLINE"],
    "строка режется на список, «all» — не фильтр",
  );
  assert.equal(step.layerContains, "");
  assert.equal(step.scope, "all");
  assert.equal(step.region, "");
  assert.equal(step.limit, 40);
  assert.equal(step.solver, "none");
  assert.deepEqual(
    step.verifiedElements,
    ["roof"],
    "неизвестный узел отбрасывается, а не валит шаг",
  );
  assert.deepEqual(step.mismatches, [
    { element: "roof", severity: "warning", description: "скат не совпал" },
  ]);
  assert.equal(step.visualConfidence, 0.7);

  // А вот действие и обоснование - это решение, здесь по-прежнему строго
  assert.throws(
    () => parseCadAgentStep({ action: "поплясать", reason: "x", entityTypes: [] }),
    /agent\.action/u,
  );
  assert.throws(
    () => parseCadAgentStep({ action: "finish", reason: "  ", entityTypes: [] }),
    /agent\.reason/u,
  );
});
