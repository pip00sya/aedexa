import assert from "node:assert/strict";
import test from "node:test";
import {
  contextDistance,
  contextSpecOf,
  contextZones,
  createContextMark,
  marksInsideParcel,
  nextContextSpot,
  SITE_CONTEXT_CATALOG,
} from "../app/lib/placement/siteContext.ts";
import type { SiteContextMark } from "../app/lib/placement/siteContext.ts";
import { findNormRule } from "../app/lib/norms/registry.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";

const parcel = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
];
const mark = (
  kind: SiteContextMark["kind"],
  x: number,
  y: number,
  distance?: number,
): SiteContextMark => ({ id: `${kind}-${x}`, kind, x, y, distance });

test("каждое требование окружения ссылается на правило из реестра", () => {
  for (const spec of SITE_CONTEXT_CATALOG) {
    if (!spec.ruleId) {
      assert.equal(
        spec.distance,
        0,
        `«${spec.label}» без правила не должен нормировать расстояние`,
      );
      continue;
    }
    const rule = findNormRule(spec.ruleId);
    assert.ok(rule, `правило ${spec.ruleId} для «${spec.label}» отсутствует в реестре`);
    assert.equal(
      rule.parameters.distanceMeters,
      spec.distance,
      `значение «${spec.label}» разошлось с реестром`,
    );
  }
});

test("расстояние берётся из реестра, но правка человека главнее", () => {
  assert.equal(contextDistance(mark("waste", 10, 10)), 20, "площадка ТБО — 20 м из реестра");
  assert.equal(
    contextDistance(mark("waste", 10, 10, 8)),
    8,
    "местные правила разрешили меньше — считаем по ним",
  );
  assert.equal(contextDistance(mark("entrance", 5, 0)), 0, "въезд расстояний не нормирует");
  assert.equal(contextDistance(mark("tree", 5, 5)), 5);
});

test("зона строится вокруг отметки и требует подтверждения", () => {
  const zones = contextZones([mark("waste", 20, 15), mark("entrance", 0, 15)]);
  assert.equal(zones.length, 1, "въезд зоны не даёт");

  const waste = zones[0];
  assert.equal(waste.label, "Площадка ТБО");
  assert.equal(waste.distance, 20);
  assert.equal(
    waste.status,
    "EXPERT_REVIEW",
    "правило не сверено с редакцией — чистого PASS быть не может",
  );

  const area = Math.abs(polygonArea(waste.outlines[0]));
  assert.ok(
    Math.abs(area - Math.PI * 400) < Math.PI * 400 * 0.05,
    `площадь зоны ${Math.round(area)} м² не похожа на круг радиусом 20 м`,
  );
});

test("отметки за границей участка пятно не режут", () => {
  const inside = marksInsideParcel([mark("waste", 20, 15), mark("well", 100, 100)], parcel);
  assert.equal(inside.length, 1);
  assert.equal(inside[0].kind, "waste");
});

test("новые отметки не ложатся друг на друга", () => {
  const spots = [0, 1, 2, 3].map((index) => nextContextSpot(parcel, index));
  for (let i = 1; i < spots.length; i += 1) {
    for (let k = 0; k < i; k += 1) {
      assert.ok(
        Math.hypot(spots[i].x - spots[k].x, spots[i].y - spots[k].y) > 0.5,
        `отметки ${k} и ${i} совпали`,
      );
    }
  }
});

test("новая отметка встаёт туда, куда её ставят", () => {
  const created = createContextMark("well", { x: 12, y: 8 }, 1);
  assert.equal(created.kind, "well");
  assert.equal(created.x, 12);
  assert.equal(contextSpecOf(created.kind).label, "Колодец или скважина");
});
