import assert from "node:assert/strict";
import test from "node:test";
import { pointInPolygon, polygonArea } from "../app/lib/geometry/index.ts";
import { buildRoadBetweenEdges } from "../app/lib/cad/roadBetweenEdges.ts";
import type { CadFeature } from "../app/lib/cad/types.ts";

let counter = 0;

function edge(points: Array<[number, number]>): CadFeature {
  counter += 1;
  return {
    id: `e${counter}`,
    sourceType: "LWPOLYLINE",
    layer: "КРОМКИ",
    kind: "curb",
    confidence: 0.8,
    reason: "кромка покрытия",
    closed: false,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
  };
}

const area = (feature: CadFeature) => Math.abs(polygonArea(feature.points));

test("две прямые кромки — одно полотно, найденное с обеих сторон только раз", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );

  assert.equal(surfaces.length, 1);
  assert.ok(
    Math.abs(area(surfaces[0]) - 72) / 72 < 0.05,
    `площадь около 72 м², получено ${area(surfaces[0]).toFixed(1)}`,
  );
  assert.equal(surfaces[0].qaStatus, "REVIEW");
  assert.equal(surfaces[0].heightQuality, "DERIVED");
});

test("бухты въездов попадают в полотно ровно как начерчены", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [10, 1.2],
        [10, 2.0],
        [12, 2.0],
        [12, 1.2],
        [30, 1.2],
        [30, 2.0],
        [32, 2.0],
        [32, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );

  assert.equal(surfaces.length, 1, `бухта не должна рвать полотно, получено ${surfaces.length}`);
  const expected = 60 * 1.2 + 2 * (2 * 0.8);
  assert.ok(
    Math.abs(area(surfaces[0]) - expected) / expected < 0.05,
    `площадь с бухтами ${expected}, получено ${area(surfaces[0]).toFixed(1)}`,
  );
  assert.equal(
    pointInPolygon({ x: 11, y: 1.6 }, surfaces[0].points),
    true,
    "точка в бухте — внутри полотна",
  );
  assert.equal(
    pointInPolygon({ x: 11, y: 2.4 }, surfaces[0].points),
    false,
    "а за дном бухты — уже нет",
  );
  // Угол бухты должен быть в вершинах полотна, а не срезан
  assert.ok(
    surfaces[0].points.some(
      (point) => Math.abs(point.x - 10) < 1e-6 && Math.abs(point.y - 2.0) < 1e-6,
    ),
    "вершина бухты сохранена",
  );
});

test("стойка ворот внутри бухты не рвёт полотно и не подменяет кромку", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [20, 1.2],
        [20, 2.0],
        [24, 2.0],
        [24, 1.2],
        [60, 1.2],
      ]),
      edge([
        [21, 1.5],
        [23, 1.5],
      ]),
    ],
    1,
  );

  assert.equal(surfaces.length, 1, `стойка не должна рвать полотно, получено ${surfaces.length}`);
  assert.ok(
    area(surfaces[0]) >= 60 * 1.2 + 2 * 0.3 - 0.5 && area(surfaces[0]) <= 60 * 1.2 + 4 * 0.8 + 0.5,
    `полотно с бухтой и стойкой, получено ${area(surfaces[0]).toFixed(1)}`,
  );
});

test("скруглённые углы бухт не рвут полотно: с дуги перпендикуляр никуда не попадает", () => {
  const arc = (x: number, y: number, r: number, dir: 1 | -1): Array<[number, number]> => [
    [x, y],
    [x + r * 0.7 * dir, y + r * 0.3],
    [x + r * dir, y + r],
  ];
  const upper = edge([
    [0, 1.2],
    [20, 1.2],
    ...arc(20, 1.2, 0.4, 1),
    [20.4, 2.0],
    [23.6, 2.0],
    [24, 1.6],
    [24, 1.2],
    [60, 1.2],
  ]);
  const lower = edge([
    [0, 0],
    [22, 0],
    [22, -0.8],
    [26, -0.8],
    [26, 0],
    [60, 0],
  ]);

  const surfaces = buildRoadBetweenEdges([lower, upper], 1);

  assert.equal(
    surfaces.length,
    1,
    `дуги на углах не должны рвать полотно, получено ${surfaces.length}`,
  );
  assert.equal(pointInPolygon({ x: 22, y: 1.6 }, surfaces[0].points), true, "верхняя бухта внутри");
  assert.equal(pointInPolygon({ x: 24, y: -0.4 }, surfaces[0].points), true, "нижняя бухта внутри");
});

test("проём въезда замыкается по линии ворот: две ножки навстречу через короткий зазор", () => {
  const lowerLeft = edge([
    [0, 0],
    [20, 0],
    [20, -0.9],
  ]);
  const lowerRight = edge([
    [21.4, -0.9],
    [21.4, 0],
    [60, 0],
  ]);
  const upper = edge([
    [0, 1.2],
    [60, 1.2],
  ]);

  const surfaces = buildRoadBetweenEdges([lowerLeft, lowerRight, upper], 1);

  assert.equal(surfaces.length, 1, `проём не должен рвать полотно, получено ${surfaces.length}`);
  const expected = 60 * 1.2 + 1.4 * 0.9;
  assert.ok(
    Math.abs(area(surfaces[0]) - expected) < 0.3,
    `бухта до линии ворот входит в полотно: ${expected.toFixed(1)} м², получено ${area(surfaces[0]).toFixed(1)}`,
  );
  assert.equal(
    pointInPolygon({ x: 20.7, y: -0.5 }, surfaces[0].points),
    true,
    "въезд внутри полотна",
  );
  assert.equal(
    pointInPolygon({ x: 20.7, y: -1.3 }, surfaces[0].points),
    false,
    "за линией ворот покрытия нет",
  );
});

test("стойка ворот проём не замыкает, а настоящая дыра с ножками навстречу шире трёх метров не закрывается", () => {
  // Стойка 0,6 м рядом с ножкой - не кромка: с ней ничего не соединяется
  const withPost = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [20, 0],
        [20, -0.9],
      ]),
      edge([
        [20.8, -0.9],
        [20.8, -0.3],
      ]),
      edge([
        [0, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.ok(
    Math.max(...withPost.flatMap((surface) => surface.points.map((point) => point.x))) <= 20.01,
    "стойка не продлевает кромку",
  );

  const wide = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [20, 0],
        [20, -0.9],
      ]),
      edge([
        [24, -0.9],
        [24, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.ok(wide.length >= 2, "широкий проём остаётся разрывом");
});

test("ворота вторым способом: соосный зазор по линии дома, обрамлённый отводами, замыкается", () => {
  const upperLeft = edge([
    [0, 1.2],
    [20, 1.2],
    [20, 2.1],
    [20.9, 2.1],
  ]);
  const upperRight = edge([
    [22.6, 2.1],
    [23.5, 2.1],
    [23.5, 1.2],
    [60, 1.2],
  ]);
  const lower = edge([
    [0, 0],
    [60, 0],
  ]);

  const surfaces = buildRoadBetweenEdges([upperLeft, upperRight, lower], 1);

  assert.equal(surfaces.length, 1, `ворота не должны рвать полотно, получено ${surfaces.length}`);
  assert.equal(
    pointInPolygon({ x: 21.75, y: 1.7 }, surfaces[0].points),
    true,
    "проём ворот внутри полотна",
  );
  assert.equal(
    pointInPolygon({ x: 21.75, y: 2.5 }, surfaces[0].points),
    false,
    "за линией дома покрытия нет",
  );

  const bare = buildRoadBetweenEdges(
    [
      edge([
        [0, 1.2],
        [20.9, 1.2],
      ]),
      edge([
        [22.6, 1.2],
        [60, 1.2],
      ]),
      edge([
        [0, 0],
        [60, 0],
      ]),
    ],
    1,
  );
  assert.ok(bare.length >= 2, "голая дыра без отводов остаётся разрывом");
});

const house = (x: number, y: number, w: number, h: number): CadFeature => ({
  id: `h${++counter}`,
  sourceType: "HATCH",
  layer: "ДОМА",
  kind: "building",
  confidence: 0.95,
  reason: "здание",
  closed: true,
  points: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ].map(([px, py]) => ({ x: px, y: py, z: 0 })),
});

test("где кромки нет, а стоит дом, проезд упирается в стену дома", () => {
  const post = (x: number) =>
    edge([
      [x, 2.1],
      [x, 1.2],
      [x + 0.6, 1.2],
      [x + 0.6, 2.1],
    ]);
  const lower = edge([
    [0, 0],
    [60, 0],
  ]);
  const homes = [house(0, 2.1, 28, 6), house(29.5, 2.1, 30.5, 6)];

  const surfaces = buildRoadBetweenEdges([lower, post(10), post(20), post(40), post(50)], 1, {
    boundaries: homes,
    occupied: (x, y) =>
      homes.some((h) => x > h.points[0].x && x < h.points[1].x && y > 2.1 && y < 8.1),
  });

  assert.equal(
    surfaces.length,
    1,
    `проезд вдоль домов — одно полотно, получено ${surfaces.length}`,
  );
  assert.equal(
    pointInPolygon({ x: 15, y: 1.8 }, surfaces[0].points),
    true,
    "между стойками покрытие доходит до стены дома",
  );
  assert.equal(
    pointInPolygon({ x: 10.3, y: 1.8 }, surfaces[0].points),
    false,
    "а сама стойка — не покрытие",
  );
  assert.equal(
    pointInPolygon({ x: 15, y: 2.5 }, surfaces[0].points),
    false,
    "внутрь дома покрытие не идёт",
  );
  assert.equal(
    pointInPolygon({ x: 28.75, y: 1.8 }, surfaces[0].points),
    true,
    "в коротком просвете между домами полотно держится линии домов",
  );
});

test("полоса начинается только от кромки и держится одной её стороны: во двор перед домом не уходит", () => {
  const curbA = edge([
    [0, 0],
    [60, 0],
  ]);
  const curbB = edge([
    [0, 1.2],
    [60, 1.2],
  ]);
  const yardHouse = house(0, -6.9, 60, 6);

  const surfaces = buildRoadBetweenEdges([curbA, curbB], 1, { boundaries: [yardHouse] });

  assert.equal(surfaces.length, 1, "только проход между кромками");
  assert.equal(
    pointInPolygon({ x: 30, y: -0.45 }, surfaces[0].points),
    false,
    "двор между кромкой и домом — не проезд",
  );

  // Дом без единой кромки полосу не начинает
  assert.deepEqual(
    buildRoadBetweenEdges([], 1, { boundaries: [yardHouse, house(0, 3, 60, 6)] }),
    [],
  );
});

test("две кромки одного прохода не склеиваются поперёк, даже если их концы — дужки на одном x", () => {
  const upper = edge([
    [0, 1.2],
    [30, 1.2],
    [30.2, 1.1],
    [30.3, 0.9],
  ]);
  const lower = edge([
    [30.3, -0.3],
    [30.2, -0.1],
    [30, 0],
    [60, 0],
  ]);
  const upperRight = edge([
    [31.7, 0.9],
    [31.8, 1.1],
    [32, 1.2],
    [60, 1.2],
  ]);
  const lowerLeft = edge([
    [0, 0],
    [28.3, 0],
    [28.5, -0.1],
    [28.6, -0.3],
  ]);

  const surfaces = buildRoadBetweenEdges([upper, lower, upperRight, lowerLeft], 1);

  assert.ok(surfaces.length >= 1, "проход должен построиться");
  const covered = surfaces.reduce((total, surface) => {
    const xs = surface.points.map((point) => point.x);
    return total + (Math.max(...xs) - Math.min(...xs));
  }, 0);
  assert.ok(covered > 50, `проход накрыт почти целиком, накрыто ${covered.toFixed(0)} м из 60`);
});

test("хвост без кромки B в полотно не входит", () => {
  // Кромка A идет до 60, кромка B кончается на 40: дальше полотна нет
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [40, 1.2],
      ]),
    ],
    1,
  );
  assert.equal(surfaces.length, 1);
  assert.ok(
    Math.max(...surfaces[0].points.map((point) => point.x)) <= 40.01,
    "за концом кромки B ничего не достраивается",
  );
});

test("настоящий разрыв кромки остаётся разрывом", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [100, 0],
      ]),
      edge([
        [0, 1.2],
        [40, 1.2],
      ]),
      edge([
        [60, 1.2],
        [100, 1.2],
      ]),
    ],
    1,
  );

  assert.ok(surfaces.length >= 2);
  assert.equal(
    surfaces.some((surface) => surface.points.some((point) => point.x > 44 && point.x < 56)),
    false,
    "в разрыве полотна нет",
  );
});

test("соосные обрезки в полуметре сшиваются, а три метра — нет", () => {
  const stitched = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [29.7, 1.2],
      ]),
      edge([
        [30.3, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.equal(stitched.length, 1, "полметра между кусками одной прямой — черчение");

  const torn = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [28, 1.2],
      ]),
      edge([
        [31, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.ok(torn.length >= 2, "три метра — въезд или дыра, не сшивается");
});

test("сквозь дом полотно не идёт: две стороны контура ряда — не проезд", () => {
  const occupied = (x: number, y: number) => y > 2 && y < 8 && x > 0 && x < 60;
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 9.8],
        [60, 9.8],
      ]),
    ],
    1,
    { occupied },
  );

  assert.deepEqual(surfaces, [], "между сторонами контура стоят дома — полотна быть не должно");
});

test("пятно размером со свою ширину дорогой не считается", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [3, 0],
      ]),
      edge([
        [0, 2.5],
        [3, 2.5],
      ]),
    ],
    1,
  );
  assert.deepEqual(surfaces, []);
});

test("чертёж в миллиметрах даёт те же метры", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60_000, 0],
      ]),
      edge([
        [0, 1_200],
        [60_000, 1_200],
      ]),
    ],
    1_000,
  );
  assert.equal(surfaces.length, 1);
  assert.ok(Math.abs(area(surfaces[0]) / 1e6 - 72) / 72 < 0.05);
});
