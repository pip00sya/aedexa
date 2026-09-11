import { writeFileSync } from "node:fs";

const WIDTH = 1600;
const HEIGHT = 1200;

/** Модуль построения: все размеры кратны ему */
const M = 100;

const INK = "rgba(255,255,255,0.62)";

const parts = [];
const add = (line) => parts.push(`  ${line}`);

const arches = 7;
for (let index = 0; index < arches; index += 1) {
  const inset = index * (M * 0.62);
  const left = M * 1.4 + inset;
  const right = WIDTH - M * 1.4 - inset;
  const base = HEIGHT - M * 1.6 - index * (M * 0.34);
  const radius = (right - left) / 2;
  const springing = base - M * 0.9 - index * (M * 0.12);
  const opacity = (0.85 - index * 0.1).toFixed(2);
  add(
    `<path d="M ${left} ${base} L ${left} ${springing} A ${radius} ${radius} 0 0 1 ${right} ${springing} L ${right} ${base}" stroke-opacity="${opacity}"/>`,
  );
}

/** Основание портика: одна линия, на которой стоит весь ряд */
add(`<path d="M ${M * 0.8} ${HEIGHT - M * 1.6} H ${WIDTH - M * 0.8}" stroke-opacity="0.9"/>`);

let side = M * 4.4;
let center = { x: M * 3.6, y: M * 3.4 };
for (let step = 0; step < 3; step += 1) {
  const half = side / 2;
  add(
    `<rect x="${(center.x - half).toFixed(1)}" y="${(center.y - half).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" stroke-opacity="${(0.8 - step * 0.16).toFixed(2)}"/>`,
  );
  add(
    `<circle cx="${center.x.toFixed(1)}" cy="${center.y.toFixed(1)}" r="${half.toFixed(1)}" stroke-opacity="${(0.6 - step * 0.14).toFixed(2)}"/>`,
  );
  // Диагонали квадрата задают центр следующего построения
  add(
    `<path d="M ${(center.x - half).toFixed(1)} ${(center.y - half).toFixed(1)} L ${(center.x + half).toFixed(1)} ${(center.y + half).toFixed(1)} M ${(center.x + half).toFixed(1)} ${(center.y - half).toFixed(1)} L ${(center.x - half).toFixed(1)} ${(center.y + half).toFixed(1)}" stroke-opacity="${(0.28 - step * 0.07).toFixed(2)}"/>`,
  );
  side /= Math.SQRT2;
  center = { x: center.x + side * 0.22, y: center.y + side * 0.3 };
}

const hub = { x: WIDTH - M * 2.6, y: M * 3.2 };
for (let index = 1; index <= 5; index += 1) {
  const radius = index * M * 0.62;
  add(
    `<path d="M ${(hub.x - radius).toFixed(1)} ${hub.y} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 0 1 ${hub.x} ${(hub.y - radius).toFixed(1)}" stroke-opacity="${(0.62 - index * 0.09).toFixed(2)}"/>`,
  );
}
add(`<circle cx="${hub.x}" cy="${hub.y}" r="3" stroke-opacity="0.9"/>`);

/** Ось и вынос: две линии, показывающие, откуда взят размер */
add(
  `<path d="M ${hub.x} ${M * 0.7} V ${M * 5.2} M ${WIDTH - M * 6} ${hub.y} H ${WIDTH - M * 0.7}" stroke-opacity="0.22" stroke-dasharray="14 6 3 6"/>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" fill="none">
  <title>Архитектурное построение: арки, окружности, квадраты</title>
  <g stroke="${INK}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none">
${parts.join("\n")}
  </g>
</svg>
`;

writeFileSync("public/arche/sketch.svg", svg);
console.log(
  `public/arche/sketch.svg: ${parts.length} построений, ${(svg.length / 1024).toFixed(1)} КБ`,
);
