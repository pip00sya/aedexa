import type { DxfEntity, DxfLayer } from "../cad/exportDxf";
import { polygonArea, polygonBounds, polygonCentroid, polygonPerimeter } from "../geometry";
import { contextDistance, contextSpecOf, type SiteContextMark } from "./siteContext";
import type { SiteObjectReport } from "./siteObjects";
import type { PlacementAnalysis, PlacementPolygon, PlacementSource, RuleStatus } from "./types";

/** Слои листа: имена такие, какими их ведут в проектных организациях */
const SHEET_LAYERS: DxfLayer[] = [
  { name: "ГРАНИЦА УЧАСТКА", colorIndex: 3 },
  { name: "ЛИНИЯ ЗАСТРОЙКИ", colorIndex: 5 },
  { name: "ПЯТНО ЗАСТРОЙКИ", colorIndex: 3 },
  { name: "ОХРАННЫЕ ЗОНЫ", colorIndex: 6 },
  { name: "СУЩЕСТВУЮЩИЕ СТРОЕНИЯ", colorIndex: 8 },
  { name: "ПРОЕКТИРУЕМЫЕ СТРОЕНИЯ", colorIndex: 1 },
  { name: "ОКРУЖЕНИЕ", colorIndex: 1 },
  { name: "РАЗМЕРЫ", colorIndex: 4 },
  { name: "ЭКСПЛИКАЦИЯ", colorIndex: 7 },
  { name: "УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", colorIndex: 7 },
  { name: "ШТАМП", colorIndex: 7 },
];

export type SheetInfo = {
  /** Название объекта: адрес или имя исходника */
  title: string;
  /** Кадастровый номер, если известен */
  cadastralNumber?: string;
  /** Кто подготовил лист */
  author?: string;
  /** Дата листа */
  date: Date;
};

export type SheetContent = {
  parcel: PlacementPolygon;
  analysis: PlacementAnalysis;
  source: PlacementSource;
  objects: readonly SiteObjectReport[];
  contextMarks: readonly SiteContextMark[];
  info: SheetInfo;
};

/** Строка экспликации: номер, название, площадь и происхождение */
export type ExplicationRow = {
  number: number;
  label: string;
  /** Площадь в м²; ноль - объект без площади (точка окружения) */
  area: number;
  /** Откуда взят объект: из чертежа, поставлен пользователем, из норм */
  origin: string;
};

const STATUS_WORDS: Record<RuleStatus, string> = {
  PASS: "учтено",
  FAIL: "конфликт",
  MISSING_DATA: "нет данных",
  EXPERT_REVIEW: "нужно подтвердить",
};

const area = (value: number) => `${Math.round(value)} м²`;

export function explication(content: SheetContent): ExplicationRow[] {
  const rows: ExplicationRow[] = [];
  const push = (label: string, value: number, origin: string) =>
    rows.push({ number: rows.length + 1, label, area: value, origin });

  push("Границы земельного участка", polygonArea(content.parcel), sourceOrigin(content.source));
  push(
    "Зона, в пределах которой разрешено строительство",
    content.analysis.buildableArea,
    "расчёт по отступам и охранным зонам",
  );

  for (const report of content.objects) {
    push(
      `${report.title} (проектируемый)`,
      report.footprint,
      report.issues.length
        ? `поставлен пользователем; ${report.issues.length} замечани${report.issues.length === 1 ? "е" : "й"}`
        : "поставлен пользователем",
    );
  }
  for (const [index, neighbor] of content.source.neighbors.entries()) {
    push(
      `Существующее строение №${index + 1}`,
      polygonArea(neighbor.polygon),
      sourceOrigin(content.source),
    );
  }
  for (const mark of content.contextMarks) {
    const spec = contextSpecOf(mark.kind);
    const distance = contextDistance(mark);
    push(
      spec.label,
      0,
      distance > 0 ? `отмечено пользователем; разрыв ${distance} м` : "отмечено пользователем",
    );
  }
  return rows;
}

function sourceOrigin(source: PlacementSource) {
  if (source.kind === "dwg" || source.kind === "dxf") return `из чертежа «${source.name}»`;
  if (source.kind === "map") return "обведено по спутниковому снимку";
  return "обведено по снимку плана";
}

export function legend(content: SheetContent): string[] {
  const items = [
    "сплошная толстая — границы земельного участка",
    "штриховая синяя — линия застройки после отступов",
    "заливка зелёная — зона, в пределах которой разрешено строительство",
  ];
  if (content.analysis.utilityZones?.length)
    items.push("штриховая фиолетовая — охранные зоны и нормируемые разрывы");
  if (content.source.neighbors.length) items.push("серый контур — существующие строения");
  if (content.objects.length) items.push("красный контур — проектируемые строения");
  if (content.contextMarks.length)
    items.push("точка с окружностью — отмеченное окружение и его разрыв");
  items.push("числа у граней — нормируемый отступ, метры");
  return items;
}

/** Координаты углов участка: без них границу нельзя вынести в натуру */
export function cornerTable(parcel: PlacementPolygon, origin?: { x: number; y: number }) {
  return parcel.map((point, index) => ({
    number: index + 1,
    x: point.x + (origin?.x ?? 0),
    y: point.y + (origin?.y ?? 0),
  }));
}

/** Строки штампа */
export function titleBlock(content: SheetContent) {
  const parcelArea = polygonArea(content.parcel);
  const built = content.objects
    .filter((report) => report.object.kind !== "yard" && report.object.kind !== "septic")
    .reduce((sum, report) => sum + report.footprint, 0);
  return [
    ["Объект", content.info.title],
    ...(content.info.cadastralNumber ? [["Кадастровый номер", content.info.cadastralNumber]] : []),
    ["Стадия", "Предпроектная проработка"],
    ["Лист", "Схема планировочной организации земельного участка"],
    ["Площадь участка", area(parcelArea)],
    ["Площадь застройки", area(built)],
    ["Процент застройки", `${parcelArea > 0 ? ((built / parcelArea) * 100).toFixed(1) : "0"} %`],
    ["Периметр участка", `${polygonPerimeter(content.parcel).toFixed(1)} м`],
    ["Исходные данные", sourceOrigin(content.source)],
    ["Дата", content.info.date.toLocaleDateString("ru-RU")],
    ...(content.info.author ? [["Подготовил", content.info.author]] : []),
    ["Основание", "Автоматизированный предпроектный расчёт AEDEXA; требует проверки специалистом"],
  ];
}

export function buildSheetEntities(content: SheetContent): {
  layers: DxfLayer[];
  entities: DxfEntity[];
} {
  const entities: DxfEntity[] = [];
  const box = polygonBounds(content.parcel);
  const scale = Math.max(box.width, box.height) / 40;
  const textHeight = Math.max(0.4, scale * 0.9);
  const lineStep = textHeight * 1.9;
  const columnX = box.x + box.width + Math.max(6, scale * 6);
  let cursorY = box.y + box.height;

  const write = (layer: string, value: string, indent = 0, height = textHeight) => {
    entities.push({
      type: "text",
      layer,
      position: { x: columnX + indent, y: cursorY },
      height,
      value,
    });
    cursorY -= lineStep;
  };

  entities.push({
    type: "polyline",
    layer: "ГРАНИЦА УЧАСТКА",
    points: content.parcel,
    closed: true,
  });
  if (content.analysis.buildable.length >= 3) {
    entities.push({
      type: "polyline",
      layer: "ЛИНИЯ ЗАСТРОЙКИ",
      points: content.analysis.buildable,
      closed: true,
    });
  }
  for (const rings of content.analysis.buildableSpots ?? []) {
    for (const ring of rings) {
      if (ring.length >= 3)
        entities.push({ type: "polyline", layer: "ПЯТНО ЗАСТРОЙКИ", points: ring, closed: true });
    }
  }
  for (const zone of content.analysis.utilityZones ?? []) {
    for (const outline of zone.outlines) {
      if (outline.length >= 3)
        entities.push({ type: "polyline", layer: "ОХРАННЫЕ ЗОНЫ", points: outline, closed: true });
    }
  }
  for (const neighbor of content.source.neighbors) {
    if (neighbor.polygon.length >= 3) {
      entities.push({
        type: "polyline",
        layer: "СУЩЕСТВУЮЩИЕ СТРОЕНИЯ",
        points: neighbor.polygon,
        closed: true,
      });
    }
  }
  for (const report of content.objects) {
    entities.push({
      type: "polyline",
      layer: "ПРОЕКТИРУЕМЫЕ СТРОЕНИЯ",
      points: report.ring,
      closed: true,
    });
  }
  for (const mark of content.contextMarks) {
    const distance = contextDistance(mark);
    entities.push({
      type: "circle",
      layer: "ОКРУЖЕНИЕ",
      center: { x: mark.x, y: mark.y },
      radius: Math.max(textHeight * 0.4, 0.3),
    });
    if (distance > 0)
      entities.push({
        type: "circle",
        layer: "ОКРУЖЕНИЕ",
        center: { x: mark.x, y: mark.y },
        radius: distance,
      });
  }

  const rows = explication(content);
  const marked: Array<{ number: number; at: { x: number; y: number } }> = [];
  content.objects.forEach((report, index) => {
    marked.push({ number: 3 + index, at: polygonCentroid(report.ring) });
  });
  content.source.neighbors.forEach((neighbor, index) => {
    marked.push({
      number: 3 + content.objects.length + index,
      at: polygonCentroid(neighbor.polygon),
    });
  });
  content.contextMarks.forEach((mark, index) => {
    marked.push({
      number: 3 + content.objects.length + content.source.neighbors.length + index,
      at: { x: mark.x, y: mark.y },
    });
  });
  for (const item of marked) {
    entities.push({
      type: "text",
      layer: "ЭКСПЛИКАЦИЯ",
      position: item.at,
      height: textHeight,
      value: String(item.number),
    });
  }

  content.parcel.forEach((point, index) => {
    const next = content.parcel[(index + 1) % content.parcel.length];
    const setback = content.analysis.edgeSetbacks[index];
    if (!Number.isFinite(setback) || setback <= 0) return;
    entities.push({
      type: "text",
      layer: "РАЗМЕРЫ",
      position: { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 },
      height: textHeight,
      value: `${setback.toFixed(1)} м`,
    });
  });

  write("ШТАМП", "СХЕМА ПЛАНИРОВОЧНОЙ ОРГАНИЗАЦИИ ЗЕМЕЛЬНОГО УЧАСТКА", 0, textHeight * 1.4);
  for (const [key, value] of titleBlock(content)) write("ШТАМП", `${key}: ${value}`);

  cursorY -= lineStep;
  write("ЭКСПЛИКАЦИЯ", "ЭКСПЛИКАЦИЯ", 0, textHeight * 1.2);
  for (const row of rows) {
    write(
      "ЭКСПЛИКАЦИЯ",
      `${row.number}. ${row.label}${row.area > 0 ? ` — ${area(row.area)}` : ""} · ${row.origin}`,
    );
  }

  cursorY -= lineStep;
  write("УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", "УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", 0, textHeight * 1.2);
  for (const item of legend(content)) write("УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", `— ${item}`);

  cursorY -= lineStep;
  write("ЭКСПЛИКАЦИЯ", "КООРДИНАТЫ УГЛОВ УЧАСТКА, М", 0, textHeight * 1.2);
  for (const corner of cornerTable(content.parcel, content.source.anchor ? undefined : undefined)) {
    write("ЭКСПЛИКАЦИЯ", `${corner.number}: X ${corner.x.toFixed(2)}   Y ${corner.y.toFixed(2)}`);
  }

  cursorY -= lineStep;
  write("ШТАМП", "ПРИМЕНЁННЫЕ ПРАВИЛА", 0, textHeight * 1.2);
  for (const rule of content.analysis.rules) {
    write(
      "ШТАМП",
      `${rule.title} — ${STATUS_WORDS[rule.status]}${rule.requiredMeters ? ` (${rule.requiredMeters.toFixed(1)} м)` : ""} · ${rule.clause}`,
    );
  }

  return { layers: SHEET_LAYERS, entities };
}
