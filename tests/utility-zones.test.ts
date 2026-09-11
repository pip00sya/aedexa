import assert from "node:assert/strict";
import test from "node:test";
import {
  polygonArea,
  polylineBufferOutlines,
  rectToPolylineDistance,
  segmentToSegmentDistance,
} from "../app/lib/geometry/index.ts";
import { findNormRule, listNormRules } from "../app/lib/norms/registry.ts";
import { analyzePlacement } from "../app/lib/placement/engine.ts";
import {
  detectUtilityNetwork,
  utilityRestrictionsFromCad,
} from "../app/lib/placement/utilityZones.ts";
import type { CadFeature, CadProcessingResult } from "../app/lib/cad/types.ts";
import type { PlacementParameters, UtilityRestriction } from "../app/lib/placement/types.ts";

function cadFeature(
  partial: Partial<CadFeature> & Pick<CadFeature, "id" | "layer" | "kind" | "points">,
): CadFeature {
  return {
    sourceType: "LWPOLYLINE",
    confidence: 0.9,
    reason: "test",
    closed: false,
    ...partial,
  };
}

function cadResult(features: CadFeature[]): CadProcessingResult {
  return { features, unitLabel: "м", warnings: [] } as unknown as CadProcessingResult;
}

const parameters: PlacementParameters = {
  profile: "detached_house",
  streetType: "residential",
  buildingWidth: 10,
  buildingDepth: 10,
  projectFireClass: "I–II",
  neighborFireClass: "I–II",
  seismicity: 9,
  officialRedLine: false,
  neighborDataConfirmed: false,
};

const squareParcel = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 30 },
  { x: 0, y: 30 },
];

test("общие расстояния геометрии считаются как ожидается", () => {
  assert.equal(polygonArea(squareParcel), 900);
  assert.equal(
    segmentToSegmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 5, y: -5 }),
    0,
  );
  assert.equal(
    segmentToSegmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }, { x: 10, y: 4 }),
    4,
  );
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(
    rectToPolylineDistance(rect, [
      { x: 15, y: 0 },
      { x: 15, y: 10 },
    ]),
    5,
  );
  assert.equal(
    rectToPolylineDistance(rect, [
      { x: 5, y: -20 },
      { x: 5, y: 20 },
    ]),
    0,
  );
  const outlines = polylineBufferOutlines(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    2,
  );
  assert.equal(outlines.length, 2);
  assert.ok(outlines.every((outline) => outline.length > 8));
});

test("вид сети определяется по русским именам слоёв", () => {
  assert.equal(detectUtilityNetwork("В1 водопровод").kind, "water");
  assert.equal(detectUtilityNetwork("Сети К1").kind, "sewer");
  assert.equal(detectUtilityNetwork("Арык существующий").kind, "drainage");
  assert.equal(detectUtilityNetwork("Газопровод низкого давления").kind, "gas-low");
  const unknownPressure = detectUtilityNetwork("газ подводящий");
  assert.equal(unknownPressure.kind, "gas-high");
  assert.equal(unknownPressure.assumed, true);
  assert.equal(detectUtilityNetwork("Теплотрасса 2Ду150").kind, "heat");
  assert.equal(detectUtilityNetwork("Кабель связи").kind, "communication");
  const overhead = detectUtilityNetwork("ЛЭП 10кВ");
  assert.equal(overhead.kind, "power-overhead");
  assert.equal(overhead.voltageKv, 10);
  assert.equal(overhead.ruleId, "utility.overhead-10");
  const lowVoltage = detectUtilityNetwork("ВЛ 0,4 кВ");
  assert.equal(lowVoltage.ruleId, "utility.overhead-0_4");
  assert.equal(detectUtilityNetwork("подземная кабельная ЛЭП").kind, "power-cable");
  assert.equal(detectUtilityNetwork("какой-то слой").kind, "unknown");
});

test("реестр нормативов честно говорит, что по сетям проверено, а что нет", () => {
  const utilityRules = listNormRules("utility");
  assert.ok(utilityRules.length >= 10);
  for (const rule of utilityRules) {
    assert.equal(rule.verifiedBy, "unverified");
    assert.ok(typeof rule.parameters.distanceMeters === "number");
    assert.ok(rule.document.length > 3);
  }
  assert.equal(findNormRule("utility.water-supply")?.parameters.distanceMeters, 5);
});

test("сети из CAD становятся ограничениями в масштабе с расстояниями из реестра", () => {
  const result = cadResult([
    cadFeature({
      id: "w1",
      layer: "В1 водопровод",
      kind: "utility",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 20, y: 0, z: 0 },
      ],
    }),
    cadFeature({
      id: "x1",
      layer: "непонятно",
      kind: "utility",
      points: [
        { x: 0, y: 5, z: 0 },
        { x: 20, y: 5, z: 0 },
      ],
    }),
    cadFeature({
      id: "b1",
      layer: "здание",
      kind: "building",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 5, z: 0 },
      ],
    }),
  ]);
  const restrictions = utilityRestrictionsFromCad(result, 0.001);
  assert.equal(restrictions.length, 2);
  const water = restrictions.find((item) => item.kind === "water");
  assert.ok(water);
  assert.equal(water.distance, 5);
  assert.equal(water.status, "EXPERT_REVIEW");
  assert.ok(Math.abs(water.polyline[1].x - 0.02) < 1e-9);
  const unknown = restrictions.find((item) => item.kind === "unknown");
  assert.ok(unknown);
  assert.equal(unknown.distance, 0);
  assert.equal(unknown.status, "MISSING_DATA");
});

test("движок посадки вычитает разрывы до сетей из пятна застройки", () => {
  const blockingUtility: UtilityRestriction = {
    id: "u-block",
    kind: "water",
    label: "Водопровод",
    polyline: [
      { x: 15, y: -5 },
      { x: 15, y: 35 },
    ],
    distance: 12,
    ruleId: "utility.water-supply",
    status: "EXPERT_REVIEW",
  };
  const blocked = analyzePlacement({
    parcel: squareParcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters,
    utilities: [blockingUtility],
  });
  assert.equal(blocked.building, undefined);
  assert.equal(blocked.rules.find((rule) => rule.id === "building-fit")?.status, "FAIL");
  const utilityRule = blocked.rules.find((rule) => rule.id === "utility-clearance");
  assert.ok(utilityRule);
  assert.equal(utilityRule.status, "EXPERT_REVIEW");
  assert.ok(blocked.utilityZones?.length === 1);
  assert.ok(blocked.utilityZones[0].outlines.length >= 1);

  const clearable = analyzePlacement({
    parcel: squareParcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters,
    utilities: [
      {
        ...blockingUtility,
        distance: 3,
        polyline: [
          { x: 1, y: -5 },
          { x: 1, y: 35 },
        ],
      },
    ],
  });
  assert.ok(clearable.building);
  assert.ok(
    rectToPolylineDistance(clearable.building, [
      { x: 1, y: -5 },
      { x: 1, y: 35 },
    ]) >=
      3 - 1e-9,
  );

  const withoutData = analyzePlacement({
    parcel: squareParcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters,
    utilities: [],
  });
  assert.equal(
    withoutData.rules.find((rule) => rule.id === "utility-clearance")?.status,
    "MISSING_DATA",
  );

  const imageSource = analyzePlacement({
    parcel: squareParcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters,
  });
  assert.equal(
    imageSource.rules.find((rule) => rule.id === "utility-clearance"),
    undefined,
  );
});
