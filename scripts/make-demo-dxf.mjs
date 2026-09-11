import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "demo");

const LAYER_BOUNDARY = "ГРАНИЦА УЧАСТКА";
const LAYER_CONTOUR = "ГОРИЗОНТАЛИ";
const LAYER_WATER = "В1 ВОДОПРОВОД";
const LAYER_GAS = "Г ГАЗОПРОВОД";

const LAYER_ROAD = "ДОРОГИ ПРОЕЗДЫ";
const LAYER_FENCE = "ОГРАЖДЕНИЯ";
const LAYER_EXISTING = "СУЩЕСТВУЮЩИЕ СТРОЕНИЯ";
const LAYER_GREEN = "ЗЕЛЕНЫЕ НАСАЖДЕНИЯ";
const LAYER_MARKS = "ВЫСОТНЫЕ ОТМЕТКИ";

function marks(list) {
  const out = [];
  const tag = (code, value) => out.push(String(code), String(value));

  for (const [x, y, z] of list) {
    tag(0, "POINT");
    tag(8, LAYER_MARKS);
    tag(10, (BASE_X + x).toFixed(4));
    tag(20, (BASE_Y + y).toFixed(4));
    tag(30, z.toFixed(3));

    tag(0, "TEXT");
    tag(8, LAYER_MARKS);
    tag(10, (BASE_X + x + 0.6).toFixed(4));
    tag(20, (BASE_Y + y + 0.4).toFixed(4));
    tag(30, "0.0");
    tag(40, "0.7");
    tag(1, z.toFixed(2));
  }
  return out;
}

function dxf(entities, extra = []) {
  const out = [];
  const tag = (code, value) => out.push(String(code), String(value));

  tag(0, "SECTION");
  tag(2, "HEADER");
  tag(9, "$ACADVER");
  tag(1, "AC1015");
  tag(9, "$INSUNITS");
  tag(70, 6); // метры
  tag(0, "ENDSEC");

  tag(0, "SECTION");
  tag(2, "ENTITIES");

  for (const entity of entities) {
    tag(0, "LWPOLYLINE");
    tag(8, entity.layer);
    tag(100, "AcDbEntity");
    tag(100, "AcDbPolyline");
    tag(90, entity.points.length);
    tag(70, entity.closed ? 1 : 0);
    if (entity.elevation !== undefined) tag(38, entity.elevation.toFixed(3));
    for (const [x, y] of entity.points) {
      tag(10, x.toFixed(4));
      tag(20, y.toFixed(4));
    }
  }

  // Отметки и подписи идут тем же потоком сущностей, что и линии
  for (const value of extra) out.push(value);

  tag(0, "ENDSEC");
  tag(0, "EOF");
  return out.join("\r\n") + "\r\n";
}

const BASE_X = 4512300;
const BASE_Y = 6178400;

function plot(width, depth, skew = 0) {
  return [
    [BASE_X, BASE_Y],
    [BASE_X + width, BASE_Y + skew],
    [BASE_X + width - skew * 0.6, BASE_Y + depth],
    [BASE_X - skew * 0.3, BASE_Y + depth - skew * 0.4],
  ];
}

function contours({ width, depth, count, drop, base, wave }) {
  const lines = [];
  const margin = 12;
  const step = drop / Math.max(1, count - 1);

  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1);
    const y = BASE_Y - margin + (depth + margin * 2) * t;
    const points = [];
    for (let x = -margin; x <= width + margin; x += 3) {
      const bend = Math.sin((x / width) * Math.PI * 1.6 + i * 0.7) * wave;
      points.push([BASE_X + x, y + bend]);
    }
    lines.push({
      layer: LAYER_CONTOUR,
      closed: false,
      elevation: Number((base + step * i).toFixed(2)),
      points,
    });
  }
  return lines;
}

function box(x, y, w, d) {
  return [
    [BASE_X + x, BASE_Y + y],
    [BASE_X + x + w, BASE_Y + y],
    [BASE_X + x + w, BASE_Y + y + d],
    [BASE_X + x, BASE_Y + y + d],
  ];
}

/** Крона дерева восьмиугольником: так их и рисуют на съемке */
function tree(x, y, r) {
  const points = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    points.push([BASE_X + x + Math.cos(a) * r, BASE_Y + y + Math.sin(a) * r]);
  }
  return points;
}

function situation({ width, depth, road = "south" }) {
  const lines = [];
  const far = 9;

  // Проезд вдоль южной границы: ось и два бортовых камня
  const y0 = road === "south" ? -far : depth + far;
  for (const offset of [-3, 0, 3]) {
    lines.push({
      layer: LAYER_ROAD,
      closed: false,
      points: [
        [BASE_X - 16, BASE_Y + y0 + offset],
        [BASE_X + width + 16, BASE_Y + y0 + offset],
      ],
    });
  }

  // Забор по трем сторонам, с разрывом под въезд
  lines.push({
    layer: LAYER_FENCE,
    closed: false,
    points: [
      [BASE_X - 0.4, BASE_Y + depth + 0.4],
      [BASE_X + width + 0.4, BASE_Y + depth + 0.4],
      [BASE_X + width + 0.4, BASE_Y - 0.4],
      [BASE_X + width * 0.62, BASE_Y - 0.4],
    ],
  });
  lines.push({
    layer: LAYER_FENCE,
    closed: false,
    points: [
      [BASE_X + width * 0.38, BASE_Y - 0.4],
      [BASE_X - 0.4, BASE_Y - 0.4],
      [BASE_X - 0.4, BASE_Y + depth + 0.4],
    ],
  });

  // Соседские строения за границей - по ним читается контекст застройки
  lines.push({ layer: LAYER_EXISTING, closed: true, points: box(-16, depth + 3, 9, 7) });
  lines.push({ layer: LAYER_EXISTING, closed: true, points: box(width + 5, depth * 0.3, 8, 6) });
  lines.push({ layer: LAYER_EXISTING, closed: true, points: box(width + 6, depth * 0.72, 5, 4) });

  // Старый сарай на самом участке: его снесут, но на съемке он есть
  lines.push({
    layer: LAYER_EXISTING,
    closed: true,
    points: box(width * 0.68, depth * 0.08, 4.5, 3),
  });

  for (const [x, y, r] of [
    [-6, depth * 0.55, 2.4],
    [width + 3.5, depth * 0.05, 2.1],
    [width * 0.12, depth + 4, 2.8],
    [width * 0.5, -5, 1.9],
  ]) {
    lines.push({ layer: LAYER_GREEN, closed: true, points: tree(x, y, r) });
  }

  return lines;
}

const plots = [
  {
    file: "uchastok-1-ravnina.dxf",
    build() {
      const width = 28;
      const depth = 29;
      return [
        { layer: LAYER_BOUNDARY, closed: true, points: plot(width, depth, 1.2) },
        ...contours({ width, depth, count: 7, drop: 0.6, base: 412.4, wave: 1.1 }),
        ...situation({ width, depth }),
      ];
    },
  },
  {
    file: "uchastok-2-sklon.dxf",
    build() {
      const width = 34;
      const depth = 35;
      return [
        { layer: LAYER_BOUNDARY, closed: true, points: plot(width, depth, 2.4) },
        ...contours({ width, depth, count: 9, drop: 4.5, base: 408.5, wave: 2.2 }),
        ...situation({ width, depth }),
        {
          layer: LAYER_GAS,
          closed: false,
          points: [
            [BASE_X - 6, BASE_Y + 7],
            [BASE_X + 12, BASE_Y + 9.5],
            [BASE_X + 30, BASE_Y + 7.5],
            [BASE_X + 41, BASE_Y + 9],
          ],
        },
      ];
    },
  },
  {
    file: "uchastok-3-vodoprovod.dxf",
    build() {
      const width = 31;
      const depth = 32;
      return [
        { layer: LAYER_BOUNDARY, closed: true, points: plot(width, depth, 1.8) },
        ...contours({ width, depth, count: 8, drop: 2.4, base: 410.2, wave: 1.6 }),
        ...situation({ width, depth, road: "north" }),
        {
          layer: LAYER_WATER,
          closed: false,
          points: [
            [BASE_X - 5, BASE_Y + 10.5],
            [BASE_X + 10, BASE_Y + 12.8],
            [BASE_X + 24, BASE_Y + 11.2],
            [BASE_X + 38, BASE_Y + 13],
          ],
        },
      ];
    },
  },
  {
    file: "uchastok-4-otmetki.dxf",
    build() {
      const width = 30;
      const depth = 26;
      return [
        { layer: LAYER_BOUNDARY, closed: true, points: plot(width, depth, 1.6) },
        ...situation({ width, depth }),
      ];
    },
    // Отметки по сетке с наклоном и небольшой ложбиной посередине
    extra() {
      const list = [];
      for (let x = -4; x <= 34; x += 6) {
        for (let y = -4; y <= 30; y += 6) {
          const slope = 405.2 + x * 0.055 + y * 0.09;
          const dip = -1.1 * Math.exp(-(((x - 15) ** 2 + (y - 13) ** 2) / 90));
          list.push([x, y, Number((slope + dip).toFixed(2))]);
        }
      }
      return marks(list);
    },
  },
];

await mkdir(outDir, { recursive: true });
for (const item of plots) {
  const text = dxf(item.build(), item.extra ? item.extra() : []);
  await writeFile(join(outDir, item.file), text, "utf8");
  console.log(`${item.file} — ${(text.length / 1024).toFixed(1)} КБ`);
}
