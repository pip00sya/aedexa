import type { CadColorFamily } from "./types";

export const cadColorFamilyLabels: Record<CadColorFamily, string> = {
  grey: "серый",
  neutral: "чёрный или белый",
  red: "красный",
  orange: "оранжевый",
  yellow: "жёлтый",
  green: "зелёный",
  cyan: "голубой",
  blue: "синий",
  magenta: "пурпурный",
  unknown: "цвет не задан",
};

type Rgb = [number, number, number];

export type CadColorRef = { color?: number; colorIndex?: number };

const lineWeightTable = [
  0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1,
  1.06, 1.2, 1.4, 1.58, 2, 2.11,
];

export function lineWeightMillimetres(code?: number, layerCode?: number): number | undefined {
  const resolve = (value?: number) =>
    value !== undefined && Number.isInteger(value) && value >= 0 && value < lineWeightTable.length
      ? lineWeightTable[value]
      : undefined;
  const own = resolve(code);
  if (own !== undefined) return own;
  if (code === 31) return 0.25;
  const layer = resolve(layerCode);
  if (layer !== undefined) return layer;
  return layerCode === 31 ? 0.25 : undefined;
}

const aciBase: Record<number, Rgb> = {
  1: [255, 0, 0],
  2: [255, 255, 0],
  3: [0, 255, 0],
  4: [0, 255, 255],
  5: [0, 0, 255],
  6: [255, 0, 255],
  7: [255, 255, 255],
  8: [128, 128, 128],
  9: [192, 192, 192],
};
const aciGreys: Rgb[] = [
  [51, 51, 51],
  [91, 91, 91],
  [132, 132, 132],
  [173, 173, 173],
  [214, 214, 214],
  [255, 255, 255],
];
const aciValues = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3];

function hsvToRgb(hue: number, saturation: number, value: number): Rgb {
  const chroma = value * saturation;
  const sector = (hue / 60) % 6;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = value - chroma;
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  return [Math.round((r + base) * 255), Math.round((g + base) * 255), Math.round((b + base) * 255)];
}

/** RGB стандартной палитры AutoCAD (ACI) для индексов 1-255 */
export function aciToRgb(index: number): Rgb | undefined {
  if (!Number.isInteger(index) || index < 1 || index > 255) return undefined;
  if (index < 10) return aciBase[index];
  if (index >= 250) return aciGreys[index - 250];
  const hue = (Math.floor(index / 10) - 1) * 15;
  const shade = index % 10;
  return hsvToRgb(hue, shade % 2 === 0 ? 1 : 0.5, aciValues[shade]);
}

export function packRgb([r, g, b]: Rgb) {
  return (r << 16) | (g << 8) | b;
}

/** Семейство цвета для 24-битного RGB */
function rgbColorFamily(rgb: number): CadColorFamily {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.16) return lightness >= 0.92 || lightness < 0.1 ? "neutral" : "grey";
  let hue =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 50) return "orange";
  if (hue < 75) return "yellow";
  if (hue < 165) return "green";
  if (hue < 200) return "cyan";
  if (hue < 265) return "blue";
  return "magenta";
}

/** Семейство цвета по RGB (если задан) или по индексу ACI */
export function cadColorFamily(color?: number, colorIndex?: number): CadColorFamily {
  if (color !== undefined && Number.isFinite(color) && color >= 0 && color <= 0xffffff)
    return rgbColorFamily(color);
  const rgb = colorIndex !== undefined ? aciToRgb(colorIndex) : undefined;
  return rgb ? rgbColorFamily(packRgb(rgb)) : "unknown";
}

const ownIndex = (index?: number) =>
  index !== undefined && Number.isFinite(index) && index >= 1 && index <= 255;

export function effectiveCadColor(entity: CadColorRef, layer?: CadColorRef): CadColorRef {
  const index = entity.colorIndex;
  if (entity.color !== undefined && Number.isFinite(entity.color) && entity.color > 0) {
    return { color: entity.color, colorIndex: ownIndex(index) ? index : undefined };
  }
  if (ownIndex(index)) return { colorIndex: index };
  if (!layer) return {};
  if (ownIndex(layer.colorIndex)) return { colorIndex: layer.colorIndex };
  return layer.color !== undefined && Number.isFinite(layer.color) && layer.color !== 0xffffff
    ? { color: layer.color }
    : {};
}

const geometryTypes =
  /^(LINE|LWPOLYLINE|POLYLINE2D|POLYLINE3D|ARC|CIRCLE|ELLIPSE|SPLINE|HATCH|3DFACE|SOLID)$/u;

export function findMixedColorLayers(
  items: Iterable<{ layer: string; sourceType: string; family: CadColorFamily }>,
  minCount = 3,
): Set<string> {
  const counts = new Map<string, Map<CadColorFamily, number>>();
  for (const item of items) {
    if (item.family === "unknown" || !geometryTypes.test(item.sourceType.toUpperCase())) continue;
    const families = counts.get(item.layer) ?? new Map<CadColorFamily, number>();
    families.set(item.family, (families.get(item.family) ?? 0) + 1);
    counts.set(item.layer, families);
  }
  const mixed = new Set<string>();
  for (const [layer, families] of counts) {
    let strong = 0;
    for (const count of families.values()) if (count >= minCount) strong += 1;
    if (strong >= 2) mixed.add(layer);
  }
  return mixed;
}
