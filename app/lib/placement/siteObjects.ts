import {
  pointInPolygon,
  polygonArea,
  segmentsIntersect,
  segmentToSegmentDistance,
} from "../geometry";
import { contextClearances, type SiteContextMark } from "./siteContext";
import type { ParcelTin } from "./terrain";
import type {
  PlacementAnalysis,
  PlacementPoint,
  PlacementPolygon,
  UtilityRestriction,
} from "./types";

type PlacementLimits = Pick<PlacementAnalysis, "buildable" | "fireRestrictions">;

export type SiteObjectKind = "house" | "garage" | "bath" | "septic" | "canopy" | "yard";

export type SiteObject = {
  id: string;
  kind: SiteObjectKind;
  /** Центр в метрах, в той же системе, что и граница участка */
  x: number;
  y: number;
  /** Габариты в плане, метры */
  width: number;
  depth: number;
  /** Высота до карниза, метры */
  height: number;
  /** Поворот в плане, радианы */
  rotation: number;
};

export type SiteObjectSpec = {
  kind: SiteObjectKind;
  title: string;
  width: number;
  depth: number;
  height: number;
  edge: number | null;
  hint: string;
};

export const SITE_OBJECT_CATALOG: SiteObjectSpec[] = [
  {
    kind: "house",
    title: "Жилой дом",
    width: 12,
    depth: 9,
    height: 7,
    edge: null,
    hint: "отступ — линия застройки участка",
  },
  {
    kind: "garage",
    title: "Гараж",
    width: 6.5,
    depth: 4,
    height: 3.2,
    edge: 1,
    hint: "на одну машину",
  },
  { kind: "bath", title: "Баня", width: 5, depth: 4, height: 3.4, edge: 1, hint: "с печью" },
  {
    kind: "septic",
    title: "Септик",
    width: 2.4,
    depth: 1.6,
    height: 0.4,
    edge: 2,
    hint: "санитарный разрыв",
  },
  {
    kind: "canopy",
    title: "Навес",
    width: 6,
    depth: 4,
    height: 2.8,
    edge: 1,
    hint: "лёгкая конструкция",
  },
  {
    kind: "yard",
    title: "Площадка",
    width: 8,
    depth: 5,
    height: 0,
    edge: 0,
    hint: "твёрдое покрытие",
  },
];

export const specOf = (kind: SiteObjectKind) =>
  SITE_OBJECT_CATALOG.find((item) => item.kind === kind) ?? SITE_OBJECT_CATALOG[0];

/** Отступ постройки от границы участка: у дома - линия застройки с плана */
export const edgeOf = (kind: SiteObjectKind, setback: number) => specOf(kind).edge ?? setback;

const CLEARANCE = 1.5;

type GapRule = {
  pair: [SiteObjectKind, SiteObjectKind];
  need: number;
  why: string;
  hard: boolean;
};

const GAPS: GapRule[] = [
  {
    pair: ["septic", "house"],
    need: 5,
    why: "санитарный разрыв от септика до жилого дома",
    hard: true,
  },
  { pair: ["septic", "bath"], need: 5, why: "санитарный разрыв от септика до бани", hard: true },
  {
    pair: ["bath", "house"],
    need: 8,
    why: "обычный разрыв от бани с печью до жилого дома",
    hard: false,
  },
];

export function gapBetween(a: SiteObjectKind, b: SiteObjectKind): GapRule | null {
  return (
    GAPS.find(
      (rule) =>
        (rule.pair[0] === a && rule.pair[1] === b) || (rule.pair[0] === b && rule.pair[1] === a),
    ) ?? null
  );
}

/** Прямоугольник с поворотом -> четыре угла */
export function objectRing(
  object: Pick<SiteObject, "x" | "y" | "width" | "depth" | "rotation">,
): PlacementPolygon {
  const cos = Math.cos(object.rotation);
  const sin = Math.sin(object.rotation);
  const halfWidth = object.width / 2;
  const halfDepth = object.depth / 2;
  return [
    { x: -halfWidth, y: -halfDepth },
    { x: halfWidth, y: -halfDepth },
    { x: halfWidth, y: halfDepth },
    { x: -halfWidth, y: halfDepth },
  ].map((point) => ({
    x: object.x + point.x * cos - point.y * sin,
    y: object.y + point.x * sin + point.y * cos,
  }));
}

/** Расстояние между ребрами двух замкнутых контуров */
function ringToRing(a: PlacementPolygon, b: PlacementPolygon) {
  if (a.length < 3 || b.length < 3) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a.length; i += 1) {
    for (let k = 0; k < b.length; k += 1) {
      const distance = segmentToSegmentDistance(
        a[i],
        a[(i + 1) % a.length],
        b[k],
        b[(k + 1) % b.length],
      );
      if (distance < best) best = distance;
      if (best === 0) return 0;
    }
  }
  return best;
}

function ringsOverlap(a: PlacementPolygon, b: PlacementPolygon) {
  if (a.length < 3 || b.length < 3) return false;
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
  for (let i = 0; i < a.length; i += 1) {
    for (let k = 0; k < b.length; k += 1) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[k], b[(k + 1) % b.length])) return true;
    }
  }
  return false;
}

/** Расстояние между постройками; ноль, если налезают */
function objectGap(a: PlacementPolygon, b: PlacementPolygon) {
  return ringsOverlap(a, b) ? 0 : ringToRing(a, b);
}

/** Расстояние от контура до ломаной; ноль, если ломаная заходит внутрь */
function ringToPolyline(ring: PlacementPolygon, line: PlacementPolygon) {
  if (ring.length < 3 || line.length < 2) return Number.POSITIVE_INFINITY;
  for (const point of line) if (pointInPolygon(point, ring)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1) {
    for (let k = 0; k < line.length - 1; k += 1) {
      const distance = segmentToSegmentDistance(
        ring[i],
        ring[(i + 1) % ring.length],
        line[k],
        line[k + 1],
      );
      if (distance < best) best = distance;
      if (best === 0) return 0;
    }
  }
  return best;
}

export type SiteObjectIssue = {
  severity: "conflict" | "review";
  text: string;
};

/** Срез и подсыпка под площадку постройки */
export type Earthworks = {
  /** Отметка площадки - средняя по пятну, метры */
  platform: number;
  /** Объем среза и подсыпки, м³ */
  cut: number;
  fill: number;
  /** Наибольшая глубина среза и высота подсыпки, метры */
  maxCut: number;
  maxFill: number;
};

export type SiteObjectReport = {
  object: SiteObject;
  title: string;
  ring: PlacementPolygon;
  /** Площадь застройки этой постройки, м² */
  footprint: number;
  /** Расстояние до границы участка, м */
  toBoundary: number;
  issues: SiteObjectIssue[];
  earth: Earthworks | null;
};

const metres = (value: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function earthworks(object: SiteObject, tin: ParcelTin, step = 0.5): Earthworks | null {
  if (!Number.isFinite(step) || step <= 0) return null;
  const ring = objectRing(object);
  if (ring.some((point) => tin.sample(point) === null)) return null;
  const xs = ring.map((point) => point.x);
  const ys = ring.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const heights: number[] = [];
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      const point = { x, y };
      if (!pointInPolygon(point, ring)) continue;
      const z = tin.sample(point);
      // Частично покрытое пятно не дает объема работ для всей постройки
      if (z === null) return null;
      heights.push(z);
    }
  }
  if (heights.length < 3) return null;

  const platform = heights.reduce((sum, z) => sum + z, 0) / heights.length;
  const cell = step * step;
  let cut = 0;
  let fill = 0;
  let maxCut = 0;
  let maxFill = 0;
  for (const z of heights) {
    const delta = z - platform;
    if (delta > 0) {
      cut += delta * cell;
      if (delta > maxCut) maxCut = delta;
    } else {
      fill += -delta * cell;
      if (-delta > maxFill) maxFill = -delta;
    }
  }
  return { platform, cut, fill, maxCut, maxFill };
}

/** Разбор одной постройки: где стоит и что нарушает */
export function inspectSiteObject(
  object: SiteObject,
  parcel: PlacementPolygon,
  others: readonly SiteObject[],
  setback: number,
  utilities: readonly UtilityRestriction[] = [],
  tin: ParcelTin | null = null,
  contextMarks: readonly SiteContextMark[] = [],
  placement: PlacementLimits | null = null,
): SiteObjectReport {
  const ring = objectRing(object);
  const spec = specOf(object.kind);
  const edge = edgeOf(object.kind, setback);
  const issues: SiteObjectIssue[] = [];
  if (object.kind === "house" && placement) {
    if (!ring.every((point) => pointInPolygon(point, placement.buildable))) {
      issues.push({
        severity: "conflict",
        text: "Дом пересекает рассчитанную линию застройки, включая отступ с уличной стороны.",
      });
    }
    if (
      placement.fireRestrictions.some((rect) =>
        ringsOverlap(
          ring,
          objectRing({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            width: rect.width,
            depth: rect.height,
            rotation: 0,
          }),
        ),
      )
    ) {
      issues.push({
        severity: "conflict",
        text: "Дом пересекает рассчитанную противопожарную зону соседнего здания.",
      });
    }
  }

  const inside = ring.every((corner) => pointInPolygon(corner, parcel));
  const boundaryGap = ringToRing(ring, parcel);
  const toBoundary = inside || boundaryGap === 0 ? boundaryGap : -boundaryGap;

  if (!inside) {
    issues.push({ severity: "conflict", text: "Постройка выходит за границу участка." });
  } else if (edge > 0 && toBoundary < edge - 0.01) {
    issues.push({
      severity: "conflict",
      text: `До границы участка ${metres(toBoundary)} м, требуется ${metres(edge)} м.`,
    });
  }

  for (const utility of [...utilities, ...contextClearances(contextMarks, object.kind)]) {
    if (utility.distance <= 0 || utility.polyline.length < 2) continue;
    const distance = ringToPolyline(ring, utility.polyline);
    if (distance < utility.distance - 0.01) {
      issues.push({
        severity: "conflict",
        text: utility.id.startsWith("context:")
          ? `${utility.label}: расстояние ${metres(distance)} м, заданный разрыв ${metres(utility.distance)} м; норматив требует подтверждения.`
          : `${utility.label}: до оси ${metres(distance)} м, охранная зона ${metres(utility.distance)} м.`,
      });
    }
  }

  for (const other of others) {
    if (other.id === object.id) continue;
    const otherRing = objectRing(other);
    const overlapping = ringsOverlap(ring, otherRing);
    const distance = overlapping ? 0 : ringToRing(ring, otherRing);

    if (overlapping && object.kind !== "yard" && other.kind !== "yard") {
      issues.push({
        severity: "conflict",
        text: `Налезает на «${specOf(other.kind).title}» — две постройки не могут стоять на одном пятне.`,
      });
      continue;
    }

    const rule = gapBetween(object.kind, other.kind);
    if (rule && distance < rule.need - 0.01) {
      issues.push({
        severity: rule.hard ? "conflict" : "review",
        text: rule.hard
          ? `«${specOf(other.kind).title}» — ${metres(distance)} м, ${rule.why}: ${metres(rule.need)} м.`
          : `«${specOf(other.kind).title}» — ${metres(distance)} м. ${capitalize(rule.why)} — ${metres(rule.need)} м; зависит от материалов стен, подтвердите по местным нормам.`,
      });
    }
  }

  return {
    object,
    title: spec.title,
    ring,
    footprint: Math.abs(polygonArea(ring)),
    toBoundary,
    issues,
    earth: tin && object.kind !== "yard" ? earthworks(object, tin) : null,
  };
}

export type SiteObjectsSummary = {
  reports: SiteObjectReport[];
  /** Площадь застройки: дом, гараж, баня, навес - без площадок и септика */
  builtArea: number;
  /** Твердое покрытие: площадки */
  pavedArea: number;
  builtPercent: number;
  conflicts: number;
  reviews: number;
  /** Суммарный срез и подсыпка по всем постройкам, м³ */
  cut: number;
  fill: number;
};

/** Что стоит на участке, сколько занимает и что мешает */
export function inspectSiteObjects(
  objects: readonly SiteObject[],
  parcel: PlacementPolygon,
  setback: number,
  utilities: readonly UtilityRestriction[] = [],
  tin: ParcelTin | null = null,
  contextMarks: readonly SiteContextMark[] = [],
  placement: PlacementLimits | null = null,
): SiteObjectsSummary {
  const reports = objects.map((object) =>
    inspectSiteObject(object, parcel, objects, setback, utilities, tin, contextMarks, placement),
  );
  const parcelArea = Math.abs(polygonArea(parcel));
  let builtArea = 0;
  let pavedArea = 0;
  let cut = 0;
  let fill = 0;
  for (const report of reports) {
    if (report.object.kind === "yard") pavedArea += report.footprint;
    else if (report.object.kind !== "septic") builtArea += report.footprint;
    if (report.earth) {
      cut += report.earth.cut;
      fill += report.earth.fill;
    }
  }
  return {
    reports,
    builtArea,
    pavedArea,
    builtPercent: parcelArea > 0 ? (builtArea / parcelArea) * 100 : 0,
    conflicts: reports.reduce(
      (total, report) =>
        total + report.issues.filter((issue) => issue.severity === "conflict").length,
      0,
    ),
    reviews: reports.reduce(
      (total, report) =>
        total + report.issues.filter((issue) => issue.severity === "review").length,
      0,
    ),
    cut,
    fill,
  };
}

export function suggestSpot(
  parcel: PlacementPolygon,
  objects: readonly SiteObject[],
  spec: SiteObjectSpec,
  setback: number,
  utilities: readonly UtilityRestriction[] = [],
  start?: PlacementPoint,
  contextMarks: readonly SiteContextMark[] = [],
  placement: PlacementLimits | null = null,
): PlacementPoint {
  const clearances = [...utilities, ...contextClearances(contextMarks, spec.kind)];
  const origin = start ?? {
    x: parcel.reduce((sum, point) => sum + point.x, 0) / parcel.length,
    y: parcel.reduce((sum, point) => sum + point.y, 0) / parcel.length,
  };
  const step = Math.max(1, Math.min(spec.width, spec.depth) / 2);
  const edge = edgeOf(spec.kind, setback);

  type Score = { hard: number; advice: number; ok: boolean };
  const WORST: Score = {
    hard: Number.POSITIVE_INFINITY,
    advice: Number.POSITIVE_INFINITY,
    ok: false,
  };
  const better = (a: Score, b: Score) =>
    a.hard < b.hard - 1e-9 || (Math.abs(a.hard - b.hard) <= 1e-9 && a.advice < b.advice - 1e-9);
  const shortfall = (actual: number, need: number) =>
    need > 0 && actual < need ? (need - actual) ** 2 : 0;

  const scoreAt = (point: PlacementPoint): Score => {
    const ring = objectRing({
      x: point.x,
      y: point.y,
      width: spec.width,
      depth: spec.depth,
      rotation: 0,
    });
    if (!ring.every((corner) => pointInPolygon(corner, parcel))) return WORST;
    if (spec.kind === "house" && placement) {
      if (!ring.every((corner) => pointInPolygon(corner, placement.buildable))) return WORST;
      if (
        placement.fireRestrictions.some((rect) =>
          ringsOverlap(
            ring,
            objectRing({
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
              width: rect.width,
              depth: rect.height,
              rotation: 0,
            }),
          ),
        )
      )
        return WORST;
    }

    let hard = shortfall(ringToRing(ring, parcel), edge);
    let advice = 0;
    for (const utility of clearances) {
      if (utility.distance > 0 && utility.polyline.length >= 2)
        hard += shortfall(ringToPolyline(ring, utility.polyline), utility.distance);
    }
    for (const other of objects) {
      // Площадка - покрытие: навес и дорожка могут лежать на ней
      const free = spec.kind === "yard" || other.kind === "yard";
      const gap = objectGap(ring, objectRing(other));
      hard += shortfall(gap, free ? 0 : CLEARANCE);
      const rule = gapBetween(spec.kind, other.kind);
      if (rule) {
        if (rule.hard) hard += shortfall(gap, rule.need);
        else advice += shortfall(gap, rule.need);
      }
    }
    return { hard, advice, ok: hard === 0 && advice === 0 };
  };

  let best = origin;
  let bestScore = WORST;
  for (let radius = 0; radius <= 120; radius += step) {
    const count = radius === 0 ? 1 : Math.max(12, Math.round((2 * Math.PI * radius) / step));
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const point = {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius,
      };
      const score = scoreAt(point);
      if (score.ok) return point;
      if (better(score, bestScore)) {
        bestScore = score;
        best = point;
      }
    }
  }

  for (const fine of [1, 0.5, 0.25, 0.1]) {
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = 0; i < 8; i += 1) {
        const angle = (i / 8) * Math.PI * 2;
        const point = { x: best.x + Math.cos(angle) * fine, y: best.y + Math.sin(angle) * fine };
        const score = scoreAt(point);
        if (better(score, bestScore)) {
          bestScore = score;
          best = point;
          moved = true;
          if (score.ok) return best;
        }
      }
    }
  }
  return best;
}

/** Новая постройка с габаритами из каталога в заданной точке */
export function createSiteObject(
  kind: SiteObjectKind,
  at: PlacementPoint,
  index: number,
): SiteObject {
  const spec = specOf(kind);
  return {
    id: `object-${kind}-${index}`,
    kind,
    x: at.x,
    y: at.y,
    width: spec.width,
    depth: spec.depth,
    height: spec.height,
    rotation: 0,
  };
}
