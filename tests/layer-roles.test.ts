import assert from "node:assert/strict";
import test from "node:test";
import { evidenceWithOverrides, layerRoles, roleOf } from "../app/lib/placement/layerRoles.ts";
import { classifyDrawing } from "../app/lib/placement/drawingPurpose.ts";
import type { CadLayerSummary } from "../app/lib/cad/types.ts";

const layer = (name: string, kind: CadLayerSummary["kind"], entityCount = 10): CadLayerSummary => ({
  name,
  entityCount,
  kind,
  confidence: 0.8,
  reason: `слой «${name}» отнесён к классу ${kind}`,
});

test("роли выводятся из класса слоя, пустые слои не показываются", () => {
  const entries = layerRoles([
    layer("ГРАНИЦА УЧАСТКА", "boundary", 4),
    layer("ГОРИЗОНТАЛИ", "terrain", 120),
    layer("В1 ВОДОПРОВОД", "utility", 6),
    layer("СУЩЕСТВУЮЩИЕ СТРОЕНИЯ", "building", 12),
    layer("РАМКА", "annotation", 2),
    layer("пустой", "unknown", 0),
  ]);

  assert.equal(entries.length, 5, "слой без сущностей в список не идёт");
  assert.equal(entries[0].layer, "ГОРИЗОНТАЛИ", "сначала самые наполненные слои");
  assert.deepEqual(
    entries.map((entry) => roleOf(entry)),
    ["relief", "building", "utility", "parcel", "annotation"],
  );
  assert.match(entries[0].reason, /отнесён к классу/u, "основание решения видно человеку");
});

test("правка человека главнее разбора", () => {
  const entries = layerRoles([layer("L-01", "unknown", 8)], { "L-01": "parcel" });
  assert.equal(entries[0].detected, "ignored");
  assert.equal(entries[0].override, "parcel");
  assert.equal(roleOf(entries[0]), "parcel");
});

test("слой, названный человеком границей, делает чертёж участком", () => {
  // Чертеж с безымянными слоями: по именам его не узнать
  const layers = [layer("L-01", "unknown", 8), layer("L-02", "unknown", 40)];
  const base = {
    layers: layers.map((item) => item.name),
    hasPlausibleParcel: true,
    parcelArea: 900,
    markCount: 0,
  };

  const before = classifyDrawing(base);
  assert.equal(before.allowsPlacement, false, "без улик участок не объявляется");

  const entries = layerRoles(layers, { "L-01": "parcel", "L-02": "relief" });
  const after = classifyDrawing(evidenceWithOverrides(base, entries));
  assert.equal(after.purpose, "site-survey");
  assert.equal(
    after.allowsPlacement,
    true,
    "человек подтвердил границу и рельеф — расчёт разрешён",
  );
});

test("слой, снятый человеком, перестаёт быть уликой", () => {
  const layers = [layer("ГРАНИЦА УЧАСТКА", "boundary", 4), layer("ГОРИЗОНТАЛИ", "terrain", 60)];
  const base = {
    layers: layers.map((item) => item.name),
    hasPlausibleParcel: true,
    parcelArea: 900,
    markCount: 0,
  };
  assert.equal(classifyDrawing(base).allowsPlacement, true);

  const entries = layerRoles(layers, { "ГРАНИЦА УЧАСТКА": "ignored", ГОРИЗОНТАЛИ: "ignored" });
  const after = classifyDrawing(evidenceWithOverrides(base, entries));
  assert.equal(after.allowsPlacement, false, "человек снял улики — расчёт остановлен");
});

test("без правок улики остаются теми же", () => {
  const layers = [layer("ГРАНИЦА УЧАСТКА", "boundary"), layer("ГОРИЗОНТАЛИ", "terrain")];
  const base = {
    layers: layers.map((item) => item.name),
    hasPlausibleParcel: true,
    parcelArea: 900,
    markCount: 0,
  };
  assert.deepEqual(evidenceWithOverrides(base, layerRoles(layers)), base);
});
