import assert from "node:assert/strict";
import test from "node:test";
import {
  createSiteObject,
  edgeOf,
  gapBetween,
  inspectSiteObject,
  inspectSiteObjects,
  objectRing,
  specOf,
} from "../app/lib/placement/siteObjects.ts";
import type { SiteObject } from "../app/lib/placement/siteObjects.ts";
import type { UtilityRestriction } from "../app/lib/placement/types.ts";

const parcel = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
];

const object = (
  kind: SiteObject["kind"],
  x: number,
  y: number,
  over: Partial<SiteObject> = {},
): SiteObject => {
  const spec = specOf(kind);
  return {
    id: `${kind}-${x}-${y}`,
    kind,
    x,
    y,
    width: spec.width,
    depth: spec.depth,
    height: spec.height,
    rotation: 0,
    ...over,
  };
};

test("отступ дома — линия застройки участка, у остальных построек свой", () => {
  assert.equal(edgeOf("house", 3), 3, "дом отступает по линии застройки");
  assert.equal(edgeOf("house", 6), 6, "она меняется вместе с настройкой");
  assert.equal(edgeOf("garage", 6), 1, "у гаража свой отступ, он от линии застройки не зависит");
  assert.equal(edgeOf("septic", 6), 2);
  assert.equal(edgeOf("yard", 6), 0, "площадка — покрытие, отступа не требует");
});

test("постройка за границей участка и слишком близко к ней", () => {
  const straddling = inspectSiteObject(object("garage", 42, 15), parcel, [], 3);
  assert.ok(straddling.issues.some((issue) => /выходит за границу/u.test(issue.text)));
  assert.equal(straddling.toBoundary, 0, "контуры пересекаются — расстояние ноль");

  const outside = inspectSiteObject(object("garage", 50, 15), parcel, [], 3);
  assert.ok(outside.issues.some((issue) => /выходит за границу/u.test(issue.text)));
  assert.ok(
    Math.abs(outside.toBoundary + 6.75) < 0.01,
    `вынесена на 6,75 м, получено ${outside.toBoundary.toFixed(2)}`,
  );

  const tooClose = inspectSiteObject(object("garage", 3.4, 15), parcel, [], 3);
  assert.ok(
    tooClose.issues.some(
      (issue) => issue.severity === "conflict" && /До границы участка/u.test(issue.text),
    ),
  );

  const fine = inspectSiteObject(object("garage", 10, 15), parcel, [], 3);
  assert.deepEqual(fine.issues, [], "в глубине участка претензий нет");
  assert.ok(Math.abs(fine.footprint - 26) < 0.01, "гараж 6,5 × 4 м");
});

test("санитарный разрыв до септика — запрет, разрыв от бани — на подтверждение", () => {
  const septicRule = gapBetween("septic", "house");
  assert.equal(septicRule?.need, 5);
  assert.equal(septicRule?.hard, true);

  const house = object("house", 20, 20);
  const septic = object("septic", 20, 12);
  const report = inspectSiteObject(septic, parcel, [house, septic], 3);
  const conflict = report.issues.find((issue) => issue.severity === "conflict");
  assert.ok(conflict, "3,5 м между септиком и домом — нарушение");
  assert.match(conflict.text, /санитарный разрыв от септика до жилого дома: 5/u);

  const bath = object("bath", 20, 12);
  const bathReport = inspectSiteObject(bath, parcel, [house, bath], 3);
  const review = bathReport.issues.find((issue) => issue.severity === "review");
  assert.ok(review, "разрыв от бани показан, но своей цифрой за норму не выдан");
  assert.match(review.text, /зависит от материалов стен/u);
});

test("две постройки на одном пятне — конфликт, а навес над площадкой — нет", () => {
  const house = object("house", 20, 15);
  const garage = object("garage", 21, 15);
  const overlap = inspectSiteObject(garage, parcel, [house, garage], 3);
  assert.ok(overlap.issues.some((issue) => /Налезает/u.test(issue.text)));

  const yard = object("yard", 20, 15);
  const canopy = object("canopy", 20, 15);
  const overYard = inspectSiteObject(canopy, parcel, [yard, canopy], 3);
  assert.equal(overYard.issues.length, 0, "навес может стоять над площадкой");
});

test("охранная зона сети действует и на постройки", () => {
  const water: UtilityRestriction = {
    id: "u1",
    kind: "water",
    label: "Водопровод",
    polyline: [
      { x: 0, y: 15 },
      { x: 40, y: 15 },
    ],
    distance: 5,
    status: "EXPERT_REVIEW",
  };
  const garage = object("garage", 20, 17);
  const report = inspectSiteObject(garage, parcel, [garage], 3, [water]);
  assert.ok(report.issues.some((issue) => /Водопровод.*охранная зона 5/u.test(issue.text)));

  const moved = inspectSiteObject(object("garage", 20, 24), parcel, [], 3, [water]);
  assert.deepEqual(moved.issues, [], "отодвинули за зону — претензий нет");
});

test("сводка считает застройку без площадок и септика", () => {
  const summary = inspectSiteObjects(
    [
      object("house", 12, 20),
      object("garage", 30, 8),
      object("yard", 12, 8),
      object("septic", 34, 26),
    ],
    parcel,
    3,
  );

  assert.ok(Math.abs(summary.builtArea - 134) < 0.01);
  assert.ok(Math.abs(summary.pavedArea - 40) < 0.01, "площадка 8×5 — твёрдое покрытие");
  assert.ok(Math.abs(summary.builtPercent - (134 / 1200) * 100) < 0.01);
  assert.equal(summary.reports.length, 4);
});

test("поворот постройки поворачивает её контур, площадь сохраняется", () => {
  const turned = objectRing(object("garage", 10, 10, { rotation: Math.PI / 4 }));
  assert.equal(turned.length, 4);
  const report = inspectSiteObject(
    object("garage", 10, 10, { rotation: Math.PI / 4 }),
    parcel,
    [],
    3,
  );
  assert.ok(Math.abs(report.footprint - 26) < 0.01, "площадь не зависит от поворота");
});

test("новая постройка появляется там, куда её ставят, с габаритами из каталога", () => {
  const created = createSiteObject("bath", { x: 15, y: 20 }, 1);
  assert.equal(created.kind, "bath");
  assert.equal(created.x, 15);
  assert.equal(created.width, 5);
  assert.equal(created.depth, 4);
});
