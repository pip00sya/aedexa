import { downloadBlob } from "../browser/download";

export type DxfPoint = { x: number; y: number };

export type DxfEntity =
  | { type: "line"; layer: string; start: DxfPoint; end: DxfPoint }
  | { type: "polyline"; layer: string; points: DxfPoint[]; closed?: boolean }
  | { type: "circle"; layer: string; center: DxfPoint; radius: number }
  | {
      type: "text";
      layer: string;
      position: DxfPoint;
      height: number;
      value: string;
      rotation?: number;
    };

export type DxfLayer = { name: string; colorIndex: number };

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function group(code: number, value: string | number): string {
  return `${code}\n${typeof value === "number" ? formatNumber(value) : value}\n`;
}

function layerTable(layers: DxfLayer[]) {
  const unique = new Map<string, DxfLayer>();
  unique.set("0", { name: "0", colorIndex: 7 });
  for (const layer of layers) unique.set(layer.name, layer);
  let table = group(0, "TABLE") + group(2, "LAYER") + group(70, unique.size);
  for (const layer of unique.values()) {
    table +=
      group(0, "LAYER") +
      group(2, layer.name) +
      group(70, 0) +
      group(62, Math.max(1, Math.min(255, Math.round(layer.colorIndex)))) +
      group(6, "CONTINUOUS");
  }
  return table + group(0, "ENDTAB");
}

function entityDxf(entity: DxfEntity): string {
  if (entity.type === "line") {
    return (
      group(0, "LINE") +
      group(8, entity.layer) +
      group(10, entity.start.x) +
      group(20, entity.start.y) +
      group(30, 0) +
      group(11, entity.end.x) +
      group(21, entity.end.y) +
      group(31, 0)
    );
  }
  if (entity.type === "circle") {
    return (
      group(0, "CIRCLE") +
      group(8, entity.layer) +
      group(10, entity.center.x) +
      group(20, entity.center.y) +
      group(30, 0) +
      group(40, Math.max(1e-9, entity.radius))
    );
  }
  if (entity.type === "text") {
    return (
      group(0, "TEXT") +
      group(8, entity.layer) +
      group(10, entity.position.x) +
      group(20, entity.position.y) +
      group(30, 0) +
      group(40, Math.max(1e-9, entity.height)) +
      group(1, entity.value) +
      (entity.rotation ? group(50, entity.rotation) : "")
    );
  }
  let polyline =
    group(0, "POLYLINE") + group(8, entity.layer) + group(66, 1) + group(70, entity.closed ? 1 : 0);
  for (const point of entity.points) {
    polyline +=
      group(0, "VERTEX") +
      group(8, entity.layer) +
      group(10, point.x) +
      group(20, point.y) +
      group(30, 0);
  }
  return polyline + group(0, "SEQEND") + group(8, entity.layer);
}

export function buildDxfText(layers: DxfLayer[], entities: DxfEntity[]): string {
  const header =
    group(0, "SECTION") +
    group(2, "HEADER") +
    group(9, "$ACADVER") +
    group(1, "AC1009") +
    group(9, "$DWGCODEPAGE") +
    group(3, "ANSI_1251") +
    group(9, "$INSUNITS") +
    group(70, 6) +
    group(0, "ENDSEC");
  const tables = group(0, "SECTION") + group(2, "TABLES") + layerTable(layers) + group(0, "ENDSEC");
  const body =
    group(0, "SECTION") +
    group(2, "ENTITIES") +
    entities.map(entityDxf).join("") +
    group(0, "ENDSEC");
  return header + tables + body + group(0, "EOF");
}

const CP1251_REPLACEMENTS: Record<string, string> = {
  "²": "2",
  "³": "3",
  "·": "-",
  "•": "-",
  "—": "-",
  "–": "-",
  "−": "-",
  "«": '"',
  "»": '"',
  "“": '"',
  "”": '"',
  "„": '"',
  "‘": "'",
  "’": "'",
  "…": "...",
  "‰": " промилле",
  "×": "x",
  "≥": ">=",
  "≤": "<=",
  "→": "->",
  "\u00a0": " ",
};

/** Приводит строку к тому, что CP1251 действительно умеет записать */
function toCp1251Text(text: string): string {
  let out = "";
  for (const character of text) out += CP1251_REPLACEMENTS[character] ?? character;
  return out;
}

export function encodeCp1251(text: string): Uint8Array {
  const source = toCp1251Text(text);
  const bytes = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code < 0x80) bytes[index] = code;
    else if (code >= 0x410 && code <= 0x44f) bytes[index] = code - 0x410 + 0xc0;
    else if (code === 0x401) bytes[index] = 0xa8;
    else if (code === 0x451) bytes[index] = 0xb8;
    else if (code === 0x2116) bytes[index] = 0xb9;
    else bytes[index] = 0x3f;
  }
  return bytes;
}

export function buildDxf(layers: DxfLayer[], entities: DxfEntity[]): Uint8Array {
  return encodeCp1251(buildDxfText(layers, entities));
}

/** Отдает собранный чертеж браузеру на скачивание */
export function downloadDxf(fileName: string, layers: DxfLayer[], entities: DxfEntity[]) {
  const bytes = buildDxf(layers, entities);
  const blob = new Blob(
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
    {
      type: "application/dxf",
    },
  );
  downloadBlob(fileName.endsWith(".dxf") ? fileName : `${fileName}.dxf`, blob);
}
