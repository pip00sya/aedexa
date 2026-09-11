import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlacement } from "../app/lib/placement/engine";
import { generatePlacementVariants } from "../app/lib/placement/variants";
import {
  createSiteObject,
  inspectSiteObject,
  suggestSpot,
  specOf,
  earthworks,
} from "../app/lib/placement/siteObjects";
import { placementSourceForArchive } from "../app/lib/archive";
import type { PlacementContext, PlacementSource } from "../app/lib/placement/types";
import type { ParcelTin } from "../app/lib/placement/terrain";
import { isSimplePolygon } from "../app/lib/geometry";

const parcel = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
];
const context: PlacementContext = {
  parcel,
  streetEdgeIndex: 0,
  neighbors: [],
  parameters: {
    profile: "detached_house",
    streetType: "main",
    buildingWidth: 12,
    buildingDepth: 9,
    projectFireClass: "I–II",
    neighborFireClass: "I–II",
    seismicity: 9,
    officialRedLine: true,
    neighborDataConfirmed: true,
  },
};
const tree = { id: "tree", kind: "tree" as const, x: 20, y: 15, distance: 100 };

test("ручной контур участка отбивает совпадающие, лежащие на прямой, пересекающиеся и нечисловые точки", () => {
  assert.equal(isSimplePolygon(parcel), true);
  assert.equal(isSimplePolygon([parcel[0], parcel[0], parcel[0]]), false);
  assert.equal(
    isSimplePolygon([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]),
    false,
  );
  assert.equal(isSimplePolygon([parcel[0], parcel[2], parcel[1], parcel[3]]), false);
  assert.equal(isSimplePolygon([...parcel, { x: NaN, y: 5 }]), false);
});

test("ограничения окружения закрывают и подбор, и предложенные варианты", () => {
  const input = { ...context, contextMarks: [tree] };
  const analysis = analyzePlacement(input);
  assert.equal(analysis.buildableArea, 0);
  assert.equal(analysis.building, undefined);
  assert.deepEqual(generatePlacementVariants(input, analysis), []);
});

test("разбор объекта и предложенное место учитывают разрыв до дерева", () => {
  const mark = { ...tree, distance: 5 };
  const house = createSiteObject("house", { x: 20, y: 15 }, 0);
  assert.ok(
    inspectSiteObject(house, parcel, [], 3, [], null, [mark]).issues.some((issue) =>
      issue.text.includes("Дерево"),
    ),
  );
  const spot = suggestSpot(parcel, [], specOf("house"), 3, [], undefined, [mark]);
  assert.equal(
    inspectSiteObject({ ...house, ...spot }, parcel, [], 3, [], null, [mark]).issues.length,
    0,
  );
});

test("разрыв от колодца считается до септика, а не до любой постройки", () => {
  const mark = { ...tree, kind: "well" as const };
  assert.ok(analyzePlacement({ ...context, contextMarks: [mark] }).building);
  const septic = createSiteObject("septic", { x: 20, y: 15 }, 0);
  assert.ok(
    inspectSiteObject(septic, parcel, [], 3, [], null, [mark]).issues.some((issue) =>
      issue.text.includes("Колодец"),
    ),
  );
});

test("подтверждение исходных данных не подтверждает нормативные значения", () => {
  const result = analyzePlacement({ ...context, neighbors: [{ id: "neighbor", polygon: parcel }] });
  for (const id of ["red-line", "parcel-boundary", "fire-gap"]) {
    assert.equal(result.rules.find((rule) => rule.id === id)?.status, "EXPERT_REVIEW");
  }
});

test("дом, поставленный руками, подчиняется тем же пределам по улице и соседу", () => {
  const analysis = analyzePlacement(context);
  const house = createSiteObject("house", { x: 20, y: 8 }, 0);
  assert.ok(
    inspectSiteObject(house, parcel, [], 3, [], null, [], analysis).issues.some((issue) =>
      issue.text.includes("уличной"),
    ),
  );
  const fire = {
    ...analysis,
    fireRestrictions: [{ x: 10, y: 5, width: 20, height: 20, distance: 6, sourceId: "neighbor" }],
  };
  assert.ok(
    inspectSiteObject(house, parcel, [], 3, [], null, [], fire).issues.some((issue) =>
      issue.text.includes("противопожарную"),
    ),
  );
  const spot = suggestSpot(parcel, [], specOf("house"), 3, [], undefined, [], analysis);
  assert.equal(
    inspectSiteObject({ ...house, ...spot }, parcel, [], 3, [], null, [], analysis).issues.length,
    0,
  );
});

test("по неполному покрытию рельефа объёмы земляных работ не выдаются", () => {
  const house = createSiteObject("house", { x: 20, y: 15 }, 0);
  const tin: ParcelTin = {
    positions: new Float64Array(),
    indices: new Uint32Array(),
    minZ: 100,
    maxZ: 100,
    sample: (point) => (point.x > 20 ? null : 100),
  };
  assert.equal(earthworks(house, tin), null);
  assert.equal(earthworks(house, tin, 0), null);
});

test("в архиве остаются происхождение и привязка, а временная ссылка на снимок — нет", () => {
  const source = {
    kind: "map",
    name: "QA",
    confidence: "local",
    unitLabel: "м",
    coordinateLabel: "local",
    parcel,
    parcelConfirmed: true,
    streetEdgeIndex: 0,
    neighbors: [],
    warnings: [],
    imageUrl: "blob:temporary",
    anchor: { lat: 43, lon: 76, rotation: 0 },
  } as PlacementSource;
  const stored = placementSourceForArchive(source);
  assert.deepEqual(stored.anchor, source.anchor);
  assert.deepEqual(stored.parcel, parcel);
  assert.equal("imageUrl" in stored, false);
  assert.equal(source.imageUrl, "blob:temporary");
});
