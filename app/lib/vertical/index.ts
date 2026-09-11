import {
  distanceToPolyline,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  type XY,
} from "../geometry";
import type { XlsxSheet } from "../report/xlsx";

export type TerrainResolver = (x: number, y: number) => number | undefined;

export type EarthworksInput = {
  /** Контур площадки в метрах */
  platform: XY[];
  /** Проектная отметка ровной площадки */
  platformElevation: number;
  slopeRatio: number;
  /** Шаг сетки в метрах */
  gridStep: number;
  /** Коэффициент разрыхления: применяется к выемке при сведении баланса */
  looseningFactor?: number;
  resolve: TerrainResolver;
};

export type EarthworksNode = {
  x: number;
  y: number;
  design: number;
  actual: number;
  /** Проектная минус натурная: плюс - насыпь, минус - выемка */
  work: number;
  insidePlatform: boolean;
};

export type EarthworksResult = {
  nodes: EarthworksNode[];
  columns: number;
  rows: number;
  origin: XY;
  step: number;
  platformArea: number;
  /** Объемы в кубометрах, оба числа положительные */
  cutVolume: number;
  fillVolume: number;
  /** Насыпь минус разрыхленная выемка: плюс - грунт придется везти */
  balance: number;
  looseningFactor: number;
  /** Узлы сетки над площадкой, куда съемка не дотянулась */
  uncoveredCount: number;
  /** Линия нулевых работ отрезками в метрах */
  zeroLine: Array<[XY, XY]>;
};

function closedRing(polygon: XY[]): XY[] {
  if (polygon.length < 2) return polygon;
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  return first.x === last.x && first.y === last.y ? polygon : [...polygon, first];
}

export function computeEarthworks(input: EarthworksInput): EarthworksResult {
  const { platform, platformElevation, slopeRatio, resolve } = input;
  if (platform.length < 3) throw new Error("Контур площадки должен содержать не менее трёх точек.");
  const step = Math.max(0.5, input.gridStep);
  const looseningFactor =
    input.looseningFactor && input.looseningFactor >= 1 ? input.looseningFactor : 1;
  const ring = closedRing(platform);
  const bounds = polygonBounds(platform);

  let maxDrop = 0;
  const probeSteps = 12;
  for (let row = 0; row <= probeSteps; row += 1) {
    for (let column = 0; column <= probeSteps; column += 1) {
      const x = bounds.x + (bounds.width * column) / probeSteps;
      const y = bounds.y + (bounds.height * row) / probeSteps;
      const z = resolve(x, y);
      if (z !== undefined) maxDrop = Math.max(maxDrop, Math.abs(z - platformElevation));
    }
  }
  const margin = slopeRatio > 0 ? Math.min(200, slopeRatio * (maxDrop + 1) + step) : 0;

  const minX = bounds.x - margin;
  const minY = bounds.y - margin;
  const columns = Math.max(2, Math.ceil((bounds.width + margin * 2) / step) + 1);
  const rows = Math.max(2, Math.ceil((bounds.height + margin * 2) / step) + 1);
  if (columns * rows > 4_000_000) {
    throw new Error("Слишком плотная сетка: увеличьте шаг или уменьшите площадку.");
  }

  const nodes: EarthworksNode[] = [];
  const workGrid: (number | undefined)[] = new Array(columns * rows).fill(undefined);
  let uncoveredCount = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = minX + column * step;
      const y = minY + row * step;
      const inside =
        pointInPolygon({ x, y }, platform) || distanceToPolyline({ x, y }, ring) <= 1e-9;
      const actual = resolve(x, y);
      if (inside && actual === undefined) uncoveredCount += 1;
      if (actual === undefined) continue;

      let design: number | undefined;
      if (inside) {
        design = platformElevation;
      } else if (slopeRatio > 0) {
        const distance = distanceToPolyline({ x, y }, ring);
        const rise = distance / slopeRatio;
        const candidate =
          actual > platformElevation ? platformElevation + rise : platformElevation - rise;
        const reachedDaylight =
          actual > platformElevation ? candidate >= actual : candidate <= actual;
        if (!reachedDaylight) design = candidate;
      }
      if (design === undefined) continue;
      const work = design - actual;
      workGrid[row * columns + column] = work;
      nodes.push({ x, y, design, actual, work, insidePlatform: inside });
    }
  }

  let cutVolume = 0;
  let fillVolume = 0;
  const cellArea = step * step;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const corners = [
        workGrid[row * columns + column],
        workGrid[row * columns + column + 1],
        workGrid[(row + 1) * columns + column],
        workGrid[(row + 1) * columns + column + 1],
      ].filter((value): value is number => value !== undefined);
      if (!corners.length) continue;
      const coverage = corners.length / 4;
      const mean = corners.reduce((sum, value) => sum + value, 0) / corners.length;
      const volume = mean * cellArea * coverage;
      if (volume > 0) fillVolume += volume;
      else cutVolume += -volume;
    }
  }

  const zeroLine: Array<[XY, XY]> = [];
  const interpolate = (a: XY, wa: number, b: XY, wb: number): XY => {
    const t = wa / (wa - wb);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const points: Array<{ position: XY; work: number }> = [];
      const corner = (dc: number, dr: number) => {
        const work = workGrid[(row + dr) * columns + column + dc];
        return work === undefined
          ? undefined
          : {
              position: { x: minX + (column + dc) * step, y: minY + (row + dr) * step },
              work,
            };
      };
      const a = corner(0, 0);
      const b = corner(1, 0);
      const c = corner(1, 1);
      const d = corner(0, 1);
      if (!a || !b || !c || !d) continue;
      const edges: Array<[{ position: XY; work: number }, { position: XY; work: number }]> = [
        [a, b],
        [b, c],
        [c, d],
        [d, a],
      ];
      for (const [start, end] of edges) {
        if (start.work > 0 !== end.work > 0 && start.work !== end.work) {
          points.push({
            position: interpolate(start.position, start.work, end.position, end.work),
            work: 0,
          });
        }
      }
      if (points.length === 2) zeroLine.push([points[0].position, points[1].position]);
    }
  }

  return {
    nodes,
    columns,
    rows,
    origin: { x: minX, y: minY },
    step,
    platformArea: polygonArea(platform),
    cutVolume,
    fillVolume,
    balance: fillVolume - cutVolume * looseningFactor,
    looseningFactor,
    uncoveredCount,
    zeroLine,
  };
}

export function earthworksXlsxSheets(result: EarthworksResult, projectName: string): XlsxSheet[] {
  const round1 = (value: number) => Math.round(value * 10) / 10;
  const summary: XlsxSheet = {
    name: "Баланс масс",
    columnWidths: [42, 16, 8],
    rows: [
      [{ value: `Вертикальная планировка — ${projectName}`, bold: true }],
      [
        {
          value: "Предварительный расчёт AEDEXA по TIN съёмки. Требует проверки специалистом.",
          bold: false,
        },
      ],
      [],
      [
        { value: "Показатель", bold: true },
        { value: "Значение", bold: true },
        { value: "Ед.", bold: true },
      ],
      ["Площадь площадки", round1(result.platformArea), "м²"],
      ["Объём выемки", round1(result.cutVolume), "м³"],
      ["Объём насыпи", round1(result.fillVolume), "м³"],
      ["Коэффициент разрыхления", result.looseningFactor, ""],
      ["Баланс (насыпь − выемка × Кр)", round1(result.balance), "м³"],
      [
        result.balance >= 0 ? "Недостающий грунт (завоз)" : "Излишек грунта (вывоз)",
        round1(Math.abs(result.balance)),
        "м³",
      ],
      ...(result.uncoveredCount
        ? [
            [
              `Узлы площадки вне покрытия съёмки: ${result.uncoveredCount}. Результат предварительный.`,
              null,
              null,
            ] as (string | number | null)[],
          ]
        : []),
    ],
  };
  return [summary];
}
