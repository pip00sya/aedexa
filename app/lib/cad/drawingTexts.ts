import { pointInPolygon, polygonArea } from "../geometry";
import type { CadDrawingText, CadFeature } from "./types";

export function normalizeDrawingText(raw: string): string {
  return raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/gu, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\P/gu, " ")
    .replace(/\\~/gu, " ")
    .replace(/\\S([^;]*);/gu, (_match, stack: string) => stack.replace(/[#^]/gu, "/"))
    .replace(/\\[ACFHQTWfhpqtw][^;]*;/gu, "")
    .replace(/\\[LlOoKk]/gu, "")
    .replace(/%%[dD]/gu, "°")
    .replace(/%%[cC]/gu, "⌀")
    .replace(/%%[pP]/gu, "±")
    .replace(/%%[uUoO]/gu, "")
    .replace(/[{}]/gu, "")
    .replace(/\\\\/gu, "\\")
    .replace(/\s+/gu, " ")
    .trim();
}

const numericLike = /^[+\-±]?\d{1,9}(?:[.,]\d+)?(?:\s?(?:м|мм|см|га|м²|м2|м3|м³|%|°|шт\.?))?$/iu;

function isMeaningfulDrawingText(text: string) {
  if (text.length < 2 || text.length > 600) return false;
  if (numericLike.test(text)) return false;
  return /[A-Za-zА-Яа-яЁё]/u.test(text);
}

export type DrawingTextSource = { text: string; layer: string; x: number; y: number };

export function collectDrawingTexts(
  items: Iterable<DrawingTextSource>,
  limits = { maxUnique: 800, maxPoints: 60, maxLayers: 8 },
): CadDrawingText[] {
  const groups = new Map<string, CadDrawingText>();
  for (const item of items) {
    const text = normalizeDrawingText(item.text);
    if (!isMeaningfulDrawingText(text)) continue;
    const key = text.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { text, count: 0, layers: [], points: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (!group.layers.includes(item.layer) && group.layers.length < limits.maxLayers)
      group.layers.push(item.layer);
    if (
      group.points.length < limits.maxPoints &&
      Number.isFinite(item.x) &&
      Number.isFinite(item.y)
    ) {
      group.points.push({ x: item.x, y: item.y });
    }
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text, "ru"))
    .slice(0, limits.maxUnique);
}

const labelHostKinds = new Set<CadFeature["kind"]>([
  "building",
  "site",
  "road",
  "unknown",
  "boundary",
  "fence",
  "water",
  "vegetation",
]);

export function attachLabelsToFeatures(
  features: CadFeature[],
  texts: CadDrawingText[],
  sourceUnitsPerMeter = 1,
  options = { maxHostAreaMeters: 5_000, maxLabels: 4, cellMeters: 10 },
): CadFeature[] {
  if (!texts.length) return features;
  const cell = options.cellMeters * sourceUnitsPerMeter;
  const maxArea = options.maxHostAreaMeters * sourceUnitsPerMeter * sourceUnitsPerMeter;
  type Host = { index: number; area: number; points: CadFeature["points"] };
  const cells = new Map<string, Host[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  features.forEach((feature, index) => {
    // Построенная программой геометрия (проезжая часть) подписи не собирает
    if (
      !feature.closed ||
      feature.points.length < 3 ||
      !labelHostKinds.has(feature.kind) ||
      feature.sourceType.startsWith("ROAD_")
    )
      return;
    const area = polygonArea(feature.points);
    if (!(area > 0) || area > maxArea) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of feature.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const host: Host = { index, area, points: feature.points };
    for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx += 1) {
      for (let cy = Math.floor(minY / cell); cy <= Math.floor(maxY / cell); cy += 1) {
        const cellKey = `${cx}:${cy}`;
        const list = cells.get(cellKey);
        if (list) list.push(host);
        else cells.set(cellKey, [host]);
      }
    }
  });
  if (!cells.size) return features;

  const labels = new Map<number, string[]>();
  for (const text of texts) {
    for (const point of text.points) {
      let best: Host | undefined;
      for (const host of cells.get(key(point.x, point.y)) ?? []) {
        if ((best && host.area >= best.area) || !pointInPolygon(point, host.points)) continue;
        best = host;
      }
      if (!best) continue;
      const list = labels.get(best.index) ?? [];
      if (!list.includes(text.text) && list.length < options.maxLabels) list.push(text.text);
      labels.set(best.index, list);
    }
  }
  if (!labels.size) return features;
  return features.map((feature, index) => {
    const list = labels.get(index);
    return list ? { ...feature, labels: list } : feature;
  });
}
