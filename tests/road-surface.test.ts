import assert from "node:assert/strict";
import test from "node:test";
import { polygonArea } from "../app/lib/geometry/index.ts";
import { buildRoadSurfaces } from "../app/lib/cad/roadSurface.ts";
import type { CadFeature } from "../app/lib/cad/types.ts";

let counter = 0;

function edge(points: Array<[number, number]>): CadFeature {
  counter += 1;
  return {
    id: `e${counter}`,
    sourceType: "LWPOLYLINE",
    layer: "КРОМКИ",
    kind: "road",
    confidence: 0.8,
    reason: "кромка по решению ИИ",
    closed: false,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
  };
}

/** Суммарная длина полотен вдоль оси X */
function spanX(features: CadFeature[]) {
  return features.reduce((total, feature) => {
    const xs = feature.points.map((point) => point.x);
    return total + (Math.max(...xs) - Math.min(...xs));
  }, 0);
}

test("между двумя целыми кромками строится одно полотно нужной ширины", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [60, 6],
      ]),
    ],
    1,
  );

  assert.equal(
    surfaces.length,
    1,
    "пара кромок даёт ровно одно полотно, а не по одному с каждой стороны",
  );
  const [surface] = surfaces;
  assert.equal(surface.kind, "road");
  assert.equal(surface.closed, true);
  assert.equal(surface.qaStatus, "REVIEW", "полотно выведено, а не измерено");
  assert.equal(surface.heightQuality, "DERIVED");
  assert.equal(surface.classificationSource, "AI_DRAWING");
  const area = Math.abs(polygonArea(surface.points));
  assert.ok(
    Math.abs(area - 60 * 6) / (60 * 6) < 0.1,
    `площадь около 360 м², получено ${area.toFixed(0)}`,
  );
});

test("разрыв кромки остаётся разрывом: полотно рвётся, а не достраивается", () => {
  // Нижняя кромка целая, верхняя разорвана на 20 м посередине
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [100, 0],
      ]),
      edge([
        [0, 6],
        [40, 6],
      ]),
      edge([
        [60, 6],
        [100, 6],
      ]),
    ],
    1,
  );

  assert.ok(surfaces.length >= 2, `ожидались отдельные куски полотна, получено ${surfaces.length}`);
  const covered = spanX(surfaces);
  assert.ok(
    covered < 90,
    `полотно не должно накрывать разрыв, накрыто ${covered.toFixed(0)} м из 100`,
  );
  assert.ok(
    covered > 60,
    `там, где обе кромки есть, полотно обязано быть: накрыто всего ${covered.toFixed(0)} м`,
  );

  // Ни одна точка полотна не лежит в середине разрыва
  const inGap = surfaces.some((surface) =>
    surface.points.some((point) => point.x > 44 && point.x < 56),
  );
  assert.equal(inGap, false, "в разрыве не должно быть ни одной точки полотна");
});

test("за концами кромок ничего не продлевается", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [100, 0],
      ]),
      edge([
        [20, 6],
        [50, 6],
      ]),
    ],
    1,
  );

  const xs = surfaces.flatMap((surface) => surface.points.map((point) => point.x));
  assert.ok(xs.length, "полотно на общем участке должно появиться");
  assert.ok(
    Math.min(...xs) >= 19,
    `полотно начинается не раньше короткой кромки, получено ${Math.min(...xs)}`,
  );
  assert.ok(Math.max(...xs) <= 51, `и не заканчивается позже неё, получено ${Math.max(...xs)}`);
});

test("узкий П-контур участка не выдаётся за проезд, а проезд между рядами — строится", () => {
  const bracketRow = (y: number, flip: 1 | -1) =>
    [0, 14, 28, 42].flatMap((x) => [
      edge([
        [x, y],
        [x + 12, y],
      ]),
      edge([
        [x, y],
        [x, y + 2.5 * flip],
      ]),
      edge([
        [x + 12, y],
        [x + 12, y + 2.5 * flip],
      ]),
      edge([
        [x, y + 2.5 * flip],
        [x + 12, y + 2.5 * flip],
      ]),
    ]);

  const surfaces = buildRoadSurfaces([...bracketRow(0, -1), ...bracketRow(8, 1)], 1);

  assert.ok(surfaces.length, "проезд между рядами обязан появиться");
  const widths = surfaces.map((surface) => {
    const ys = surface.points.map((point) => point.y);
    return Math.max(...ys) - Math.min(...ys);
  });
  for (const width of widths) {
    assert.ok(
      width > 6,
      `полотно должно лечь через проезд, а не поперёк контура участка: ${width.toFixed(1)} м`,
    );
  }
});

test("нарезка чертежа сшивается: два куска одной прямой в полуметре — одна кромка", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [19.7, 6],
      ]),
      edge([
        [20.3, 6],
        [39.7, 6],
      ]),
      edge([
        [40.3, 6],
        [60, 6],
      ]),
    ],
    1,
  );

  assert.equal(
    surfaces.length,
    1,
    `соосные куски с просветом 0,6 м обязаны стать одним полотном, получено ${surfaces.length}`,
  );
  assert.ok(spanX(surfaces) > 58, "и полотно накрывает всю длину, включая стыки");
});

test("настоящий разрыв не сшивается: три метра — это въезд или дыра", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [28, 6],
      ]),
      edge([
        [31, 6],
        [60, 6],
      ]),
    ],
    1,
  );

  assert.ok(surfaces.length >= 2, "через 3 м полотно не перекидывается");
  const inGap = surfaces.some((surface) =>
    surface.points.some((point) => point.x > 28.5 && point.x < 30.5),
  );
  assert.equal(inGap, false, "в разрыве точек полотна нет");
});

test("сшивка только соосных: угол и боковой сдвиг не сшиваются", () => {
  const corner = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [30, 6],
      ]),
      edge([
        [30.5, 6.5],
        [30.5, 20],
      ]),
    ],
    1,
  );
  assert.ok(
    spanX(corner) < 32,
    `угол не должен продлить кромку дальше 30 м, получено ${spanX(corner).toFixed(1)}`,
  );

  const shifted = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [30, 6],
      ]),
      edge([
        [30.3, 9.5],
        [60, 9.5],
      ]),
    ],
    1,
  );
  const widths = new Set(
    shifted.map((surface) => Math.round(Math.max(...surface.points.map((point) => point.y)))),
  );
  assert.ok(
    widths.size >= 2 || shifted.length >= 2,
    "сдвинутые куски дают разные полосы, а не одну с изломом",
  );
});

test("полотно не самопересекается: точки противоположной кромки идут монотонно", () => {
  // Дубль кромки чуть глубже основной: попадания прыгают между ними
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [60, 6],
      ]),
      edge([
        [10, 6.4],
        [20, 6.4],
      ]),
      edge([
        [30, 6.4],
        [40, 6.4],
      ]),
    ],
    1,
  );

  for (const surface of surfaces) {
    const half = surface.points.length / 2;
    const rights = surface.points.slice(half).reverse();
    for (let index = 1; index < rights.length; index += 1) {
      assert.ok(
        rights[index].x >= rights[index - 1].x - 1e-6,
        `противоположная сторона полотна пошла назад на ${index}: самопересечение`,
      );
    }
  }
});

test("одинокая кромка полотна не даёт", () => {
  assert.deepEqual(
    buildRoadSurfaces(
      [
        edge([
          [0, 0],
          [80, 0],
        ]),
      ],
      1,
    ),
    [],
  );
});

test("слишком широкий и слишком узкий просвет полотном не становятся", () => {
  const tooWide = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 40],
        [60, 40],
      ]),
    ],
    1,
  );
  const tooNarrow = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 0.5],
        [60, 0.5],
      ]),
    ],
    1,
  );

  assert.deepEqual(tooWide, [], "40 м между линиями — это не проезд");
  assert.deepEqual(tooNarrow, [], "0,5 м — двойное начертание одной кромки, а не полотно");
});

test("чертёж в миллиметрах даёт полотно тех же метрических размеров", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60_000, 0],
      ]),
      edge([
        [0, 6_000],
        [60_000, 6_000],
      ]),
    ],
    1_000,
  );

  assert.equal(surfaces.length, 1);
  const area = Math.abs(polygonArea(surfaces[0].points)) / 1_000_000;
  assert.ok(Math.abs(area - 360) / 360 < 0.1, `в метрах около 360 м², получено ${area.toFixed(0)}`);
});
