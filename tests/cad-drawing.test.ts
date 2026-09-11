import assert from "node:assert/strict";
import test from "node:test";
import {
  bulgeArcPoints,
  cadDrawingToSvg,
  expandBulges,
  fitCadDrawingView,
  lineWeightPixels,
  mtextLines,
} from "../app/lib/cad/drawing.ts";
import type { CadDrawing } from "../app/lib/cad/types.ts";

test("прогибы полилинии разворачиваются в дуги окружности", () => {
  const arc = bulgeArcPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 1);
  assert.equal(arc.length > 4, true);
  const middle = arc[Math.floor(arc.length / 2)];
  assert.equal(
    Math.abs(Math.hypot(middle.x - 5, middle.y) - 5) < 1e-6,
    true,
    "точки остаются на окружности",
  );
  assert.equal(middle.y < 0, true, "положительный прогиб идёт против часовой, ниже хорды по +X");
  const mirrored = bulgeArcPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, -1);
  assert.equal(
    mirrored[Math.floor(mirrored.length / 2)].y > 0,
    true,
    "отрицательный прогиб гнётся в другую сторону",
  );
  assert.deepEqual(
    bulgeArcPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 0),
    [],
    "прямые участки ничего не добавляют",
  );
  const expanded = expandBulges(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    [1, 0, 0],
    false,
  );
  assert.equal(expanded.length > 3, true);
  assert.deepEqual(expanded[0], { x: 0, y: 0 });
  assert.deepEqual(expanded[expanded.length - 1], { x: 10, y: 10 });
});

test("MTEXT разбивается на чистые строки", () => {
  assert.deepEqual(mtextLines("{\\fArial|b0;Примечания\\P1. План\\P2. Отметки}"), [
    "Примечания",
    "1. План",
    "2. Отметки",
  ]);
  assert.deepEqual(mtextLines("ТИП-3"), ["ТИП-3"]);
});

test("толщина линий переводится в экранную так же, как показывает AutoCAD", () => {
  assert.equal(lineWeightPixels(undefined), 1);
  assert.equal(lineWeightPixels(0.05), 1);
  assert.equal(lineWeightPixels(0.25), 1);
  assert.equal(lineWeightPixels(0.3), 2);
  assert.equal(lineWeightPixels(0.5), 3);
  assert.equal(lineWeightPixels(1), 7);
  assert.equal(lineWeightPixels(5), 24);
});

test("вид садится по габаритам, а SVG уходит с исходным оформлением", () => {
  const drawing: CadDrawing = {
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
    unitsPerMeter: 1,
    entityCount: 3,
    omitted: 0,
    primitives: [
      {
        t: "path",
        layer: "ГП",
        color: 0x5b5b5b,
        weight: 0.3,
        dash: [2, 1],
        closed: false,
        pts: [0, 0, 100, 0],
        b: [0, 0, 100, 0],
      },
      {
        t: "hatch",
        layer: "Заливка",
        color: 0xffd1a3,
        solid: false,
        lines: [{ angle: 45, spacing: 3.175, dashes: [] }],
        loops: [[10, 10, 30, 10, 30, 20, 10, 20]],
        b: [10, 10, 30, 20],
      },
      {
        t: "text",
        layer: "0",
        color: 0xffffff,
        x: 5,
        y: 30,
        h: 2.5,
        rot: 0,
        text: "ТИП-2",
        halign: "left",
        valign: "baseline",
        b: [0, 28, 15, 32],
      },
    ],
  };
  const view = fitCadDrawingView(drawing.bounds, 800, 400);
  assert.equal(
    Math.abs(view.scale - (800 * 0.92) / 100) < 1e-9 ||
      Math.abs(view.scale - (400 * 0.92) / 50) < 1e-9,
    true,
  );
  assert.equal(view.centerX, 50);
  assert.equal(view.centerY, 25);
  const svg = cadDrawingToSvg(drawing);
  assert.match(svg, /stroke="#5b5b5b"/);
  assert.match(svg, /stroke-dasharray="2.000 1.000"/);
  assert.match(svg, /<pattern id="hatch-1"/);
  assert.match(svg, /ТИП-2/);
  assert.match(svg, /vector-effect="non-scaling-stroke"/);
});

test("сжатие текста и наклон букв доживают до SVG", () => {
  const drawing: CadDrawing = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    unitsPerMeter: 1,
    entityCount: 1,
    omitted: 0,
    primitives: [
      {
        t: "text",
        layer: "0",
        color: 0xffffff,
        x: 1,
        y: 1,
        h: 2,
        rot: 0,
        text: "ГОСТ",
        halign: "left",
        valign: "baseline",
        xs: 0.85,
        ob: 15,
        b: [0, 0, 5, 3],
      },
    ],
  };
  assert.match(cadDrawingToSvg(drawing), /skewX\(-15.00\) scale\(0.850 1\)/);
});
