import assert from "node:assert/strict";
import test from "node:test";
import { buildGeometryGroups } from "../app/lib/cad/geometryGroups.ts";
import type { CadFeature, CadKind } from "../app/lib/cad/types.ts";

let counter = 0;

function line(
  layer: string,
  points: Array<[number, number]>,
  overrides: Partial<CadFeature> = {},
): CadFeature {
  counter += 1;
  return {
    id: `f${counter}`,
    sourceType: "LWPOLYLINE",
    layer,
    kind: "unknown" as CadKind,
    confidence: 0.3,
    reason: "нет правила",
    closed: false,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
    ...overrides,
  };
}

function rectangle(
  layer: string,
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<CadFeature> = {},
): CadFeature {
  return line(
    layer,
    [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ],
    { closed: true, ...overrides },
  );
}

/** Прямая линия вдоль X, нарезанная на куски со сходящимися концами */
function splitStraight(
  layer: string,
  y: number,
  from: number,
  to: number,
  pieces: number,
  overrides: Partial<CadFeature> = {},
) {
  const step = (to - from) / pieces;
  return Array.from({ length: pieces }, (_, index) =>
    line(
      layer,
      [
        [from + step * index, y],
        [from + step * (index + 1), y],
      ],
      overrides,
    ),
  );
}

test("две кромки вдоль друг друга дают устойчивое расстояние, здания — площадь", () => {
  const grey = { colorFamily: "grey" as const };
  const features = [
    line(
      "ПРОЕЗД",
      [
        [0, 0],
        [60, 0],
      ],
      grey,
    ),
    line(
      "ПРОЕЗД",
      [
        [0, 6],
        [60, 6],
      ],
      grey,
    ),
    rectangle("ЗДАНИЯ", 0, 20, 12, 8, {
      colorFamily: "orange",
      kind: "building",
      confidence: 0.9,
      reason: "слой здания",
    }),
    rectangle("ЗДАНИЯ", 20, 20, 12, 8, {
      colorFamily: "orange",
      kind: "building",
      confidence: 0.9,
      reason: "слой здания",
    }),
  ];

  const groups = buildGeometryGroups(features, 1);
  const road = groups.find((group) => group.layer === "ПРОЕЗД");
  const buildings = groups.find((group) => group.layer === "ЗДАНИЯ");

  assert.ok(road?.parallel, "у открытых линий должен быть замер параллельности");
  assert.ok(
    road.parallel.pairedRatio > 0.9,
    `ожидалась пара почти на всех сечениях, получено ${road.parallel.pairedRatio}`,
  );
  assert.ok(
    Math.abs(road.parallel.medianSpacingMeters - 6) < 0.2,
    `ширина ${road.parallel.medianSpacingMeters}`,
  );
  assert.ok(
    road.parallel.spacingSpreadMeters < 0.2,
    "у ровной пары разброс расстояния близок к нулю",
  );

  assert.equal(buildings?.form, "closed");
  assert.equal(buildings?.parallel, undefined, "замкнутые контуры параллельностью не меряются");
  assert.ok(Math.abs((buildings?.medianAreaMeters ?? 0) - 96) < 0.001);
  assert.ok(
    Math.abs((buildings?.medianFillRatio ?? 0) - 1) < 0.001,
    "прямоугольник заполняет свой габарит целиком",
  );
});

test("группа только меряет и не меняет класс, к которому пришли правила", () => {
  const features = [
    line(
      "ГП-Граница учасика ИЖС",
      [
        [0, 0],
        [40, 0],
      ],
      {
        colorFamily: "grey",
        kind: "fence",
        confidence: 0.84,
        reason: "линейный контур участка ИЖС",
      },
    ),
    line(
      "ГП-Граница учасика ИЖС",
      [
        [0, 6],
        [40, 6],
      ],
      {
        colorFamily: "grey",
        kind: "fence",
        confidence: 0.84,
        reason: "линейный контур участка ИЖС",
      },
    ),
  ];

  const [group] = buildGeometryGroups(features, 1);

  assert.equal(group.ruleKind, "fence");
  assert.equal(group.ruleReason, "линейный контур участка ИЖС");
  assert.ok(group.parallel && group.parallel.pairedRatio > 0.9);
});

test("разорванная на куски кромка меряется как целая, а настоящий разрыв виден", () => {
  const grey = { colorFamily: "grey" as const };
  const whole = buildGeometryGroups(
    [
      line(
        "A",
        [
          [0, 0],
          [40, 0],
        ],
        grey,
      ),
      ...splitStraight("A", 6, 0, 40, 8, grey),
    ],
    1,
  )[0];

  const gapped = buildGeometryGroups(
    [
      line(
        "B",
        [
          [0, 0],
          [40, 0],
        ],
        grey,
      ),
      line(
        "B",
        [
          [0, 6],
          [15, 6],
        ],
        grey,
      ),
      line(
        "B",
        [
          [25, 6],
          [40, 6],
        ],
        grey,
      ),
    ],
    1,
  )[0];

  assert.ok(
    whole.parallel && whole.parallel.pairedRatio > 0.9,
    "сшивка по совпадающим концам не должна штрафовать нарезанную кромку",
  );
  assert.ok(gapped.parallel, "у разорванной пары замер тоже есть");
  assert.ok(
    gapped.parallel.pairedRatio < whole.parallel.pairedRatio,
    "настоящий разрыв обязан быть виден в замере, а не заполнен",
  );
  assert.ok(gapped.parallel.pairedRatio > 0.5, "оставшаяся часть кромки всё ещё в паре");
});

test("широкий и неровный просвет между заборами отличим от проезда по разбросу", () => {
  const green = { colorFamily: "green" as const, kind: "fence" as CadKind };
  // Заборы соседних участков: расстояние гуляет с 18 до 28 м
  const groups = buildGeometryGroups(
    [
      line(
        "ЗАБОРЫ",
        [
          [0, 0],
          [90, 0],
        ],
        green,
      ),
      line(
        "ЗАБОРЫ",
        [
          [0, 18],
          [30, 18],
        ],
        green,
      ),
      line(
        "ЗАБОРЫ",
        [
          [30, 24],
          [60, 24],
        ],
        green,
      ),
      line(
        "ЗАБОРЫ",
        [
          [60, 28],
          [90, 28],
        ],
        green,
      ),
    ],
    1,
  );
  const fences = groups[0];

  assert.ok(fences.parallel, "замер есть и здесь — отличие в числах, а не в наличии");
  assert.ok(
    fences.parallel.medianSpacingMeters > 15,
    `просвет ${fences.parallel.medianSpacingMeters} м шире проезда`,
  );
  assert.ok(fences.parallel.spacingSpreadMeters > 1, "у заборов расстояние заметно гуляет");
});

test("различает пустой проезд и полосу, в которой стоит дом", () => {
  const grey = { colorFamily: "grey" as const };
  const house = (x: number, y: number) =>
    rectangle("ДОМА", x, y, 8, 6, {
      colorFamily: "orange",
      kind: "building",
      confidence: 0.95,
      reason: "слой здания",
    });

  // Проезд: две кромки на 4 м, между ними ничего
  const lane = buildGeometryGroups(
    [
      line(
        "ПРОЕЗД",
        [
          [0, 0],
          [60, 0],
        ],
        grey,
      ),
      line(
        "ПРОЕЗД",
        [
          [0, 4],
          [60, 4],
        ],
        grey,
      ),
      house(0, 30),
    ],
    1,
  ).find((group) => group.layer === "ПРОЕЗД");

  // Межевая пара: то же расстояние, но в полосе стоят дома
  const plots = buildGeometryGroups(
    [
      line(
        "МЕЖА",
        [
          [0, 0],
          [60, 0],
        ],
        grey,
      ),
      line(
        "МЕЖА",
        [
          [0, 8],
          [60, 8],
        ],
        grey,
      ),
      house(2, 1),
      house(14, 1),
      house(26, 1),
      house(38, 1),
      house(50, 1),
    ],
    1,
  ).find((group) => group.layer === "МЕЖА");

  assert.ok(lane?.corridor, "у спаренных линий должен быть замер полосы");
  assert.ok(
    lane.corridor.emptyRatio > 0.95,
    `полоса проезда пуста, получено ${lane.corridor.emptyRatio}`,
  );
  assert.equal(lane.corridor.buildingRatio, 0, "в проезде домов нет");
  assert.ok(lane.corridor.longestPairedRunMeters > 50, "проезд тянется непрерывно");

  assert.ok(plots?.corridor, "у межевой пары замер тоже есть");
  assert.ok(
    plots.corridor.buildingRatio > 0.6,
    `в межевой полосе стоят дома, получено ${plots.corridor.buildingRatio}`,
  );
  assert.ok(
    plots.corridor.buildingRatio > lane.corridor.buildingRatio,
    "именно это и отличает участок от проезда",
  );
});

test("контур размером с весь лист не делает занятым весь чертёж", () => {
  const grey = { colorFamily: "grey" as const };
  const groups = buildGeometryGroups(
    [
      rectangle("КВАРТАЛ", -10, -10, 200, 200, {
        kind: "site",
        confidence: 0.8,
        reason: "контур квартала",
      }),
      line(
        "ПРОЕЗД",
        [
          [0, 0],
          [60, 0],
        ],
        grey,
      ),
      line(
        "ПРОЕЗД",
        [
          [0, 4],
          [60, 4],
        ],
        grey,
      ),
    ],
    1,
  );
  const lane = groups.find((group) => group.layer === "ПРОЕЗД");

  assert.ok(lane?.corridor, "замер полосы есть");
  assert.ok(
    lane.corridor.emptyRatio > 0.95,
    `проезд внутри контура квартала обязан остаться пустым, получено ${lane.corridor.emptyRatio}`,
  );
});

test("значимость группы — занятая длина, а не число обрезков", () => {
  const grey = { colorFamily: "grey" as const };
  // Тысяча крошечных кружков-маркеров против сотни длинных кромок
  const markers = Array.from({ length: 1_000 }, (_, index) =>
    rectangle("МАРКЕРЫ", index % 40, Math.floor(index / 40), 0.04, 0.04, grey),
  );
  const edges = Array.from({ length: 100 }, (_, index) =>
    line(
      "КРОМКИ",
      [
        [0, index],
        [30, index],
      ],
      grey,
    ),
  );

  const groups = buildGeometryGroups([...markers, ...edges], 1);

  assert.equal(groups[0].layer, "КРОМКИ", "длинные кромки важнее груды мелких маркеров");
  assert.equal(groups[0].id, "g1", "идентификаторы раздаются уже после сортировки");
  assert.ok(groups[0].totalLengthMeters > (groups[1]?.totalLengthMeters ?? 0));
});

test("чертёж в миллиметрах меряется в метрах", () => {
  const grey = { colorFamily: "grey" as const };
  const [group] = buildGeometryGroups(
    [
      line(
        "ПРОЕЗД",
        [
          [0, 0],
          [60_000, 0],
        ],
        grey,
      ),
      line(
        "ПРОЕЗД",
        [
          [0, 6_000],
          [60_000, 6_000],
        ],
        grey,
      ),
    ],
    1_000,
  );

  assert.ok(
    Math.abs((group.parallel?.medianSpacingMeters ?? 0) - 6) < 0.2,
    "ширина в метрах, а не в миллиметрах",
  );
  assert.ok(Math.abs(group.medianLengthMeters - 60) < 0.1);
  assert.ok(Math.abs(group.spanMeters.width - 60) < 0.1);
});

test("нарезанная кромка различает стык впритык и настоящий разрыв", () => {
  const grey = { colorFamily: "grey" as const };
  const [touching] = buildGeometryGroups(splitStraight("СТЫК", 0, 0, 40, 8, grey), 1);
  const [gapped] = buildGeometryGroups(
    Array.from({ length: 8 }, (_, index) =>
      line(
        "ДЫРЫ",
        [
          [index * 5, 0],
          [index * 5 + 4.5, 0],
        ],
        grey,
      ),
    ),
    1,
  );

  assert.ok((touching.medianEndGapMeters ?? 1) < 0.01, "стыкующиеся концы дают нулевой просвет");
  assert.ok(
    Math.abs((touching.medianChainLengthMeters ?? 0) - 40) < 0.01,
    "стыкующиеся куски сшиваются в одну цепочку 40 м",
  );

  assert.ok(
    Math.abs((gapped.medianEndGapMeters ?? 0) - 0.5) < 0.01,
    "просвет 0,5 м измерен, а не заполнен",
  );
  assert.ok(
    Math.abs((gapped.medianChainLengthMeters ?? 0) - 4.5) < 0.01,
    "через настоящий разрыв сшивки нет: цепочка равна куску",
  );
  assert.equal(gapped.chainCount, 8, "восемь кусков остались восемью цепочками");
});

test("подписи и стилевые признаки группы попадают в отпечаток", () => {
  const [group] = buildGeometryGroups(
    [
      rectangle("Заливка", 0, 0, 4, 3, {
        sourceType: "HATCH",
        patternName: "ANSI32",
        colorFamily: "orange",
        sourceColorIndex: 30,
        lineWeightMm: 0.3,
        lineType: "Continuous",
        labels: ["ТИП-3"],
      }),
      rectangle("Заливка", 10, 0, 4, 3, {
        sourceType: "HATCH",
        patternName: "ANSI32",
        colorFamily: "orange",
        sourceColorIndex: 30,
        labels: ["ТИП-3"],
      }),
    ],
    1,
  );

  assert.equal(group.form, "hatch");
  assert.equal(group.patternName, "ANSI32");
  assert.equal(group.colorIndex, 30);
  assert.deepEqual(group.labels, ["ТИП-3"]);
  assert.equal(group.count, 2);
  assert.equal(group.featureIds.length, 2, "идентификаторы нужны, чтобы применить решение модели");
});
