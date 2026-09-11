import assert from "node:assert/strict";
import test from "node:test";
import type { CadFeature, CadProcessingResult } from "../app/lib/cad/types";
import { placementSourceFromCad, stitchBoundaryFragments } from "../app/lib/placement/cadAdapter";
import { polygonArea } from "../app/lib/placement/engine";

function feature(
  id: string,
  layer: string,
  points: Array<[number, number]>,
  closed = false,
): CadFeature {
  return {
    id,
    layer,
    sourceType: "LWPOLYLINE",
    kind: "boundary",
    confidence: 0.94,
    reason: "test",
    classificationSource: "CAD_LAYER",
    closed,
    points: points.map(([x, y]) => ({ x, y, z: 0, zExplicit: true })),
  };
}

function unknownFeature(id: string, layer: string, points: Array<[number, number]>): CadFeature {
  return { ...feature(id, layer, points), kind: "unknown" };
}

test("разрезанная внешняя граница сшивается, а не подменяется одной из повторяющихся ячеек", () => {
  const outer = [
    feature("a", "ГР.УЧ", [
      [0, 0],
      [100_000, 0],
      [100_000, 50_000],
    ]),
    feature("b", "ГР.УЧ", [
      [100_000, 50_000],
      [0, 50_000],
    ]),
    feature("c", "ГР.УЧ", [
      [0, 50_000],
      [0, 0],
    ]),
  ];
  const cells = Array.from({ length: 24 }, (_, index) => {
    const x = index * 3_000;
    return feature(
      `cell-${index}`,
      "ГП-Граница участка ИЖС",
      [
        [x, 5_000],
        [x + 2_000, 5_000],
        [x + 2_000, 7_000],
        [x, 7_000],
      ],
      true,
    );
  });
  const result = {
    fileName: "fixture.dwg",
    unitLabel: "мм",
    layers: [{ name: "ГР.УЧ" }, { name: "ГП-Граница участка ИЖС" }],
    features: [...outer, ...cells],
    preflight: { status: "review" },
    spatialReference: { horizontalCrs: "local" },
    warnings: [],
  } as unknown as CadProcessingResult;

  const source = placementSourceFromCad(result);
  assert.ok(source.parcel);
  assert.equal(Math.round(polygonArea(source.parcel!)), 5_000);
  assert.equal(source.parcelCandidates?.[0].source, "stitched-cad");
  assert.match(source.warnings[0], /восстановлена из 3/);
});

test("настоящий разрыв границей не зарастает", () => {
  const fragments = [
    feature("a", "ГР.УЧ", [
      [0, 0],
      [10, 0],
    ]),
    feature("b", "ГР.УЧ", [
      [11, 0],
      [11, 10],
      [0, 10],
      [0, 0],
    ]),
  ];
  assert.equal(stitchBoundaryFragments(fragments, 1, 0.05).length, 0);
});

test("граница по смысловому имени слоя сшивается, даже если классификатор её не опознал", () => {
  const fragments = [
    unknownFeature("a", "PARCEL_BOUNDARY", [
      [0, 0],
      [20, 0],
      [20, 10],
    ]),
    unknownFeature("b", "PARCEL_BOUNDARY", [
      [20, 10],
      [0, 10],
      [0, 0],
    ]),
  ];
  const stitched = stitchBoundaryFragments(fragments, 1);
  assert.equal(stitched.length, 1);
  assert.equal(Math.round(polygonArea(stitched[0].polygon)), 200);
});
