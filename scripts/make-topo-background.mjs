import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "public/demo/uchastok-2-sklon.dxf";

/** Поле фона: широкое и низкое, как полоса горизонта под содержимым */
const WIDTH = 2400;
const HEIGHT = 1400;

/** Съемка: линия видна как белый росчерк на камне */
const INK = "rgba(255,255,255,0.30)";

const TILE_INK = "rgba(255,255,255,0.10)";

function readContours(text) {
  const rows = text.split(/\r?\n/);
  const contours = [];
  let layer = "";
  let points = [];
  let collecting = false;

  const flush = () => {
    if (collecting && /горизонт|рельеф/iu.test(layer) && points.length >= 3) contours.push(points);
    points = [];
  };

  for (let index = 0; index + 1 < rows.length; index += 2) {
    const code = Number(rows[index].trim());
    const value = rows[index + 1];
    if (code === 0) {
      flush();
      const type = value.trim();
      collecting = type === "LWPOLYLINE" || type === "POLYLINE";
      layer = "";
    } else if (code === 8) {
      layer = value.trim();
    } else if (collecting && code === 10) {
      points.push({ x: Number(value), y: Number.NaN });
    } else if (collecting && code === 20 && points.length) {
      points[points.length - 1].y = Number(value);
    }
  }
  flush();

  return contours.filter((line) =>
    line.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
  );
}

/** Приводит набор линий к единичному квадрату, сохраняя пропорции */
function normalize(contours) {
  const all = contours.flat();
  const minX = Math.min(...all.map((point) => point.x));
  const maxX = Math.max(...all.map((point) => point.x));
  const minY = Math.min(...all.map((point) => point.y));
  const maxY = Math.max(...all.map((point) => point.y));
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  return contours.map((line) =>
    line.map((point) => ({ x: (point.x - minX) / span, y: (point.y - minY) / span })),
  );
}

/** Плавная кривая по точкам: съемка рисует горизонтали сглаженными */
function smoothPath(points) {
  if (points.length < 2) return "";
  const parts = [`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const middle = {
      x: (points[index].x + points[index + 1].x) / 2,
      y: (points[index].y + points[index + 1].y) / 2,
    };
    parts.push(
      `Q ${points[index].x.toFixed(1)} ${points[index].y.toFixed(1)} ${middle.x.toFixed(1)} ${middle.y.toFixed(1)}`,
    );
  }
  const last = points[points.length - 1];
  parts.push(`L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`);
  return parts.join(" ");
}

const svgDocument = (viewBox, width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" fill="none">\n${body}\n</svg>\n`;

const SHEETS = [
  { scale: 1750, x: -260, y: 40, rotate: -4, opacity: 1, width: 1.15 },
  { scale: 1180, x: 1080, y: -210, rotate: 7, opacity: 0.72, width: 1 },
  { scale: 2300, x: 420, y: 520, rotate: -11, opacity: 0.5, width: 1.4 },
  { scale: 860, x: -120, y: 780, rotate: 14, opacity: 0.6, width: 0.9 },
  { scale: 1420, x: 1620, y: 640, rotate: -6, opacity: 0.56, width: 1.05 },
];

const contours = normalize(readContours(readFileSync(SOURCE, "utf8")));
if (!contours.length) throw new Error(`в ${SOURCE} не нашлось горизонталей`);

const sheets = SHEETS.map((sheet) => {
  const paths = contours
    .map((line) =>
      smoothPath(line.map((point) => ({ x: point.x * sheet.scale, y: point.y * sheet.scale }))),
    )
    .filter(Boolean)
    .map((d) => `      <path d="${d}" stroke-width="${sheet.width}" />`)
    .join("\n");
  return [
    `    <g transform="translate(${sheet.x} ${sheet.y}) rotate(${sheet.rotate})" stroke-opacity="${sheet.opacity}">`,
    paths,
    "    </g>",
  ].join("\n");
}).join("\n");

writeFileSync(
  "public/arche/topo-lines.svg",
  svgDocument(
    `0 0 ${WIDTH} ${HEIGHT}`,
    WIDTH,
    HEIGHT,
    [
      "  <title>Горизонтали демонстрационного участка как фон</title>",
      `  <g stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">`,
      sheets,
      "  </g>",
    ].join("\n"),
  ),
);

/** Косая штриховка: тот же знак, каким на чертеже показывают разрез */
const hatch = Array.from({ length: 17 }, (_, index) => {
  const shift = (index - 8) * 12;
  return `  <path d="M ${shift} 96 L ${shift + 96} 0" stroke="${TILE_INK}" stroke-width="1"/>`;
}).join("\n");
writeFileSync("public/arche/hatch.svg", svgDocument("0 0 96 96", 96, 96, hatch));

/** Миллиметровка: ритм, по которому выравнивается все остальное */
const grid = Array.from({ length: 13 }, (_, index) => index * 8)
  .map(
    (step) =>
      `  <path d="M ${step} 0 V 96 M 0 ${step} H 96" stroke="${TILE_INK}" stroke-width="0.5"/>`,
  )
  .join("\n");
writeFileSync("public/arche/grid.svg", svgDocument("0 0 96 96", 96, 96, grid));

console.log(
  `собрано: topo-lines.svg (${contours.length} горизонталей на ${SHEETS.length} листах), hatch.svg, grid.svg`,
);
