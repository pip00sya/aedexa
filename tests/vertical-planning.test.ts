import assert from "node:assert/strict";
import test from "node:test";
import { computeEarthworks, earthworksXlsxSheets } from "../app/lib/vertical/index.ts";

const square = (size: number) => [
  { x: 0, y: 0 },
  { x: size, y: 0 },
  { x: size, y: size },
  { x: 0, y: size },
];

test("ровная площадка на проектной отметке даёт нулевые объёмы", () => {
  const result = computeEarthworks({
    platform: square(20),
    platformElevation: 100,
    slopeRatio: 1.5,
    gridStep: 1,
    resolve: () => 100,
  });
  assert.ok(result.cutVolume < 1e-6);
  assert.ok(result.fillVolume < 1e-6);
  assert.equal(result.balance, 0);
  assert.equal(result.uncoveredCount, 0);
  assert.equal(result.platformArea, 400);
});

test("объёмы по наклонной плоскости совпадают с аналитическим решением", () => {
  const result = computeEarthworks({
    platform: square(100),
    platformElevation: 103,
    slopeRatio: 0,
    gridStep: 1,
    resolve: (x) => 100 + 0.1 * x,
  });
  assert.ok(Math.abs(result.fillVolume - 4500) / 4500 < 0.02, `fill=${result.fillVolume}`);
  assert.ok(Math.abs(result.cutVolume - 24500) / 24500 < 0.02, `cut=${result.cutVolume}`);
  assert.ok(result.zeroLine.length > 0);
  const zeroXs = result.zeroLine.flatMap(([a, b]) => [a.x, b.x]);
  const meanZeroX = zeroXs.reduce((sum, value) => sum + value, 0) / zeroXs.length;
  assert.ok(
    Math.abs(meanZeroX - 30) < 1.5,
    `линия нулевых работ около x=30, получено ${meanZeroX}`,
  );
});

test("коэффициент разрыхления и ведомость xlsx применяются", () => {
  const result = computeEarthworks({
    platform: square(10),
    platformElevation: 99,
    slopeRatio: 0,
    gridStep: 1,
    looseningFactor: 1.2,
    resolve: () => 100, // равномерная срезка 1 м -> выемка 100 м³
  });
  assert.ok(Math.abs(result.cutVolume - 100) / 100 < 0.05);
  assert.ok(result.balance < 0);
  assert.ok(Math.abs(result.balance + result.cutVolume * 1.2) < 1e-6);
  const sheets = earthworksXlsxSheets(result, "Тест");
  assert.equal(sheets.length, 1);
  assert.ok(sheets[0].rows.some((row) => row[0] === "Излишек грунта (вывоз)"));
});

test("за пределы съёмки ничего не продлевается", () => {
  const result = computeEarthworks({
    platform: square(20),
    platformElevation: 100,
    slopeRatio: 1.5,
    gridStep: 1,
    resolve: (_x, y) => (y <= 10 ? 100 : undefined),
  });
  assert.ok(result.uncoveredCount > 0);
  assert.ok(result.nodes.every((node) => node.actual !== undefined));
});
