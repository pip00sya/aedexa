import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGroupDictionary,
  buildStripPrompt,
  parseGroupDictionary,
  parseStripAnswers,
  roadEdgeFeatures,
  stripCandidates,
} from "../app/lib/cad/groupSemantics.ts";
import type { CadGeometryGroup } from "../app/lib/cad/geometryGroups.ts";
import type { CadFeature, CadProcessingResult } from "../app/lib/cad/types.ts";

function group(id: string, over: Partial<CadGeometryGroup> = {}): CadGeometryGroup {
  return {
    id,
    layer: `слой-${id}`,
    colorFamily: "grey",
    form: "open",
    count: 10,
    ruleKind: "unknown",
    ruleConfidence: 0.3,
    ruleReason: "нет правила",
    totalLengthMeters: 300,
    medianLengthMeters: 3,
    spanMeters: { width: 60, height: 60 },
    labels: [],
    featureIds: [`${id}-a`, `${id}-b`],
    ...over,
  };
}

function feature(id: string, over: Partial<CadFeature> = {}): CadFeature {
  return {
    id,
    sourceType: "LWPOLYLINE",
    layer: "слой",
    kind: "unknown",
    confidence: 0.3,
    reason: "нет правила",
    closed: false,
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    ],
    ...over,
  };
}

function processing(features: CadFeature[]): CadProcessingResult {
  return { features } as CadProcessingResult;
}

const paired = {
  parallel: {
    pairedRatio: 0.9,
    medianSpacingMeters: 4,
    spacingSpreadMeters: 0.3,
    stationCount: 40,
  },
  corridor: {
    emptyRatio: 0.8,
    buildingRatio: 0.1,
    enclosedRatio: 0.1,
    longestPairedRunMeters: 30,
    sampledStations: 36,
  },
};

test("узкий вопрос задаётся только о полосах дорожной ширины", () => {
  const candidates = stripCandidates([
    group("g1", paired),
    // Разлиновка таблицы: полоса 1,5 м - спрашивать не о чем
    group("g2", { ...paired, parallel: { ...paired.parallel, medianSpacingMeters: 1.5 } }),
    // Просвет между кварталами: 29 м - это не проезд
    group("g3", { ...paired, parallel: { ...paired.parallel, medianSpacingMeters: 29 } }),
    // Слишком короткий кусок
    group("g4", { ...paired, corridor: { ...paired.corridor, longestPairedRunMeters: 4 } }),
    // Без замера полосы
    group("g5"),
  ]);

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["g1"],
  );
});

test("в узком вопросе нет ни имени слоя, ни цвета, ни класса", () => {
  const { prompt, letters } = buildStripPrompt([
    group("g7", {
      ...paired,
      layer: "ГП-Граница учасика ИЖС",
      colorFamily: "green",
      ruleKind: "fence",
    }),
  ]);

  assert.equal(letters.get("A"), "g7");
  assert.equal(
    prompt.includes("ГП-Граница"),
    false,
    "имя слоя — сильнейший якорь, его в вопросе быть не должно",
  );
  assert.equal(prompt.includes("green"), false, "цвет тоже не должен подсказывать ответ");
  assert.equal(prompt.includes("fence"), false, "и текущий класс тоже");
  assert.ok(prompt.includes("4 м"), "а измеренная ширина полосы — должна");
});

test("ответы про полосу привязываются к группам по буквам, чужое отбрасывается", () => {
  const letters = new Map([
    ["A", "g7"],
    ["B", "g8"],
  ]);
  const answers = parseStripAnswers(
    {
      answers: [
        { id: "A", strip: "passage", confidence: 0.9, why: "полоса пуста и тянется" },
        { id: "B", strip: "выдумка", confidence: 0.9, why: "" },
        { id: "Z", strip: "plot", confidence: 0.9, why: "группы Z не существует" },
      ],
    },
    letters,
  );

  assert.deepEqual(
    answers.map((answer) => [answer.groupId, answer.verdict]),
    [["g7", "passage"]],
  );
});

test("роль кромки разрешена только дороге и бордюру", () => {
  const dictionary = parseGroupDictionary(
    {
      summary: "",
      decisions: [
        {
          id: "g1",
          kind: "road",
          role: "road-edge",
          status: "existing",
          confidence: 0.8,
          evidence: "замер полосы",
        },
        {
          id: "g2",
          kind: "annotation",
          role: "road-edge",
          status: "existing",
          confidence: 0.9,
          evidence: "рамка листа",
        },
        {
          id: "g3",
          kind: "выдумка",
          role: "other",
          status: "existing",
          confidence: 0.9,
          evidence: "",
        },
      ],
    },
    ["g1", "g2", "g3"],
  );

  assert.equal(dictionary.decisions.length, 2, "класс не из списка отбрасывается целиком");
  assert.equal(dictionary.decisions[0].role, "road-edge");
  assert.equal(dictionary.decisions[1].role, "other", "рамка листа кромкой дороги быть не может");
});

test("уверенное решение правил не перебивается, и роль кромки вместе с ним пропадает", () => {
  const groups = [
    group("g1", { featureIds: ["frame-a", "frame-b"] }),
    group("g2", { featureIds: ["edge-a", "edge-b"] }),
  ];
  const before = processing([
    // Рамка листа: правила уверены, ИИ ошибается
    feature("frame-a", { kind: "annotation", confidence: 0.94, classificationSource: "CAD_LAYER" }),
    feature("frame-b", { kind: "annotation", confidence: 0.94, classificationSource: "CAD_LAYER" }),
    // Линии без класса: тут решение ИИ уместно
    feature("edge-a"),
    feature("edge-b"),
  ]);
  const dictionary = {
    summary: "",
    decisions: [
      {
        groupId: "g1",
        kind: "road" as const,
        role: "road-edge" as const,
        status: "existing" as const,
        confidence: 0.9,
        evidence: "ИИ ошибся",
      },
      {
        groupId: "g2",
        kind: "road" as const,
        role: "road-edge" as const,
        status: "existing" as const,
        confidence: 0.8,
        evidence: "замер полосы",
      },
    ],
  };

  const { result, appliedCount } = applyGroupDictionary(before, groups, dictionary);

  assert.equal(appliedCount, 2, "меняются только линии без класса");
  assert.equal(
    result.features[0].kind,
    "annotation",
    "уверенное правило по имени слоя сильнее решения ИИ",
  );
  assert.equal(result.features[2].kind, "road");
  assert.equal(result.features[2].classificationSource, "AI_DRAWING");
  assert.equal(
    result.features[2].qaStatus,
    "REVIEW",
    "решение ИИ — на проверку, а не измеренный факт",
  );

  const edges = roadEdgeFeatures(result, groups, dictionary);
  assert.deepEqual(
    edges.map((edge) => edge.id),
    ["edge-a", "edge-b"],
    "рамка отвергнута как класс — значит, и кромкой дороги она быть не может",
  );
});

test("объяснение подписи сильнее замера и не перебивается", () => {
  const groups = [group("g1", { featureIds: ["labeled"] })];
  const before = processing([
    feature("labeled", {
      kind: "building",
      confidence: 0.5,
      semantic: {
        label: "ТИП-3",
        meaning: "жилой дом",
        kind: "building",
        status: "planned",
        floors: 0,
        heightMeters: 0,
        use: "",
        confidence: 0.9,
        evidence: "легенда",
      },
    }),
  ]);

  const { result, appliedCount } = applyGroupDictionary(before, groups, {
    summary: "",
    decisions: [
      {
        groupId: "g1",
        kind: "road",
        role: "other",
        status: "existing",
        confidence: 0.9,
        evidence: "",
      },
    ],
  });

  assert.equal(appliedCount, 0);
  assert.equal(result.features[0].kind, "building");
});
