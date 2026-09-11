import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { processDwgBuffer } from "../app/lib/cad/processDwg";
import { placementSourceFromCad } from "../app/lib/placement/cadAdapter";
import { parseDxf } from "../app/lib/placement/dxf";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter";
import { analyzePlacement } from "../app/lib/placement/engine";
import { buildParcelTin, parcelTerrainStats } from "../app/lib/placement/terrain";
import { polygonArea } from "../app/lib/geometry";
import type { PlacementSource } from "../app/lib/placement/types";

const WASM_PATH = pathToFileURL(resolve("public/libredwg/")).href;

type Row = {
  file: string;
  sizeMb: number;
  seconds: number;
  /** Чем программа сочла чертеж и почему */
  purpose?: string;
  purposeReasons?: string;
  layerNames?: string;
  /** Что удалось прочитать */
  entities?: number;
  layers?: number;
  units?: string;
  /** Участок и посадка */
  parcelArea?: number;
  parcelSource?: string;
  buildableArea?: number;
  spots?: number;
  utilities?: number;
  neighbors?: number;
  rulesPass?: number;
  rulesFail?: number;
  rulesReview?: number;
  rulesMissing?: number;
  /** Рельеф */
  contours?: number;
  marks?: number;
  drop?: number;
  /** Топосъемка */
  terrainMethod?: string;
  terrainQuality?: string;
  classified?: number;
  /** Итог */
  verdict: "посадка" | "только чертёж" | "не участок" | "не открылся";
  note?: string;
};

function classifiedShare(source: PlacementSource) {
  const features = source.cad?.features ?? [];
  if (!features.length) return 0;
  const known = features.filter((feature) => feature.kind !== "unknown").length;
  return Math.round((known / features.length) * 100);
}

async function readSource(path: string): Promise<PlacementSource> {
  const name = basename(path);
  if (name.toLowerCase().endsWith(".dxf")) {
    return placementSourceFromDxf(parseDxf(readFileSync(path, "utf8"), name), {
      name,
      source: "upload",
    });
  }
  const buffer = readFileSync(path);
  const content = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const result = await processDwgBuffer(
    { fileName: name, fileSize: buffer.byteLength, content },
    undefined,
    WASM_PATH,
  );
  const source = placementSourceFromCad(result);
  return source;
}

async function inspect(path: string): Promise<Row> {
  const name = basename(path);
  const sizeMb = Math.round((statSync(path).size / 1_048_576) * 10) / 10;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;

  let source: PlacementSource;
  try {
    source = await readSource(path);
  } catch (error) {
    return {
      file: name,
      sizeMb,
      seconds: seconds(),
      verdict: "не открылся",
      note: error instanceof Error ? error.message.slice(0, 120) : String(error),
    };
  }

  const row: Row = {
    file: name,
    sizeMb,
    seconds: seconds(),
    purpose: source.purpose?.purpose,
    purposeReasons: source.purpose?.reasons.join("; "),
    layerNames: source.cad?.layers.map((layer) => layer.name).join(" · "),
    entities: source.cad?.modelEntityCount,
    layers: source.cad?.layers.length,
    units: source.unitLabel,
    utilities: source.utilities?.length ?? 0,
    neighbors: source.neighbors.length,
    contours: source.relief?.contours.length ?? 0,
    marks: source.relief?.marks.length ?? 0,
    terrainMethod: source.cad?.terrain.method,
    terrainQuality: source.cad?.terrain.quality.status,
    classified: source.cad ? classifiedShare(source) : undefined,
    verdict: "только чертёж",
  };

  if (!source.parcel || source.parcel.length < 3) {
    row.verdict = "не участок";
    row.note = source.warnings[0]?.slice(0, 120);
    return row;
  }

  row.parcelArea = Math.round(polygonArea(source.parcel));
  row.parcelSource =
    source.parcelCandidates?.[0]?.label.slice(0, 40) ?? source.coordinateLabel.slice(0, 40);

  const tin = buildParcelTin(source.parcel, source.relief);
  if (tin && source.relief)
    row.drop = Math.round(parcelTerrainStats(tin, source.parcel, source.relief).drop * 100) / 100;

  const analysis = analyzePlacement({
    parcel: source.parcel,
    streetEdgeIndex: source.streetEdgeIndex,
    neighbors: source.neighbors,
    utilities: source.utilities,
    parameters: {
      profile: "detached_house",
      streetType: "residential",
      buildingWidth: 10,
      buildingDepth: 8,
      projectFireClass: "I–II",
      neighborFireClass: "I–II",
      seismicity: 9,
      officialRedLine: false,
      neighborDataConfirmed: false,
    },
  });
  row.buildableArea = Math.round(analysis.buildableArea);
  row.spots = analysis.buildableSpots?.length ?? 0;
  row.rulesPass = analysis.rules.filter((rule) => rule.status === "PASS").length;
  row.rulesFail = analysis.rules.filter((rule) => rule.status === "FAIL").length;
  row.rulesReview = analysis.rules.filter((rule) => rule.status === "EXPERT_REVIEW").length;
  row.rulesMissing = analysis.rules.filter((rule) => rule.status === "MISSING_DATA").length;
  row.verdict = row.buildableArea > 0 ? "посадка" : "только чертёж";
  return row;
}

async function main() {
  const [folder, ...rest] = process.argv.slice(2);
  if (!folder) {
    console.error("Укажите папку с чертежами: npx tsx scripts/check-drawings.ts <папка>");
    process.exit(1);
  }
  const limitIndex = rest.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
  const jsonIndex = rest.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? rest[jsonIndex + 1] : undefined;

  const files = readdirSync(folder)
    .filter((name) => /\.(dwg|dxf)$/i.test(name))
    .sort()
    .slice(0, limit)
    .map((name) => join(folder, name));

  console.log(`Чертежей к разбору: ${files.length}\n`);
  const rows: Row[] = [];
  for (const [index, path] of files.entries()) {
    const row = await inspect(path);
    rows.push(row);
    const head = `${String(index + 1).padStart(2)}/${files.length} ${row.file.padEnd(52).slice(0, 52)} ${String(row.sizeMb).padStart(5)} МБ ${String(row.seconds).padStart(6)} с`;
    const body =
      row.verdict === "не открылся"
        ? `✖ не открылся: ${row.note}`
        : row.verdict === "не участок"
          ? `— ${row.purpose ?? "?"}: ${row.purposeReasons ?? "улик нет"} (${row.entities ?? 0} сущ., ${row.layers ?? 0} сл.)`
          : `✓ [${row.purpose ?? "?"}] участок ${row.parcelArea} м² · пятно ${row.buildableArea} м² (${row.spots} ч.) · сети ${row.utilities} · соседи ${row.neighbors} · рельеф ${row.contours}г/${row.marks}о${row.drop ? ` (перепад ${row.drop} м)` : ""} · правила ${row.rulesPass}/${row.rulesFail}/${row.rulesReview}/${row.rulesMissing}`;
    console.log(`${head}\n     ${body}`);
  }

  const count = (verdict: Row["verdict"]) => rows.filter((row) => row.verdict === verdict).length;
  console.log(`\n── Сводка ──`);
  console.log(`открылось:        ${rows.length - count("не открылся")} из ${rows.length}`);
  console.log(`дошло до посадки: ${count("посадка")}`);
  console.log(`границы нет:      ${count("не участок")}`);
  console.log(`не открылось:     ${count("не открылся")}`);
  const withTerrain = rows.filter(
    (row) => (row.contours ?? 0) >= 2 || (row.marks ?? 0) >= 8,
  ).length;
  console.log(`с рельефом:       ${withTerrain}`);
  const slowest = [...rows].sort((a, b) => b.seconds - a.seconds)[0];
  if (slowest) console.log(`дольше всех:      ${slowest.file} — ${slowest.seconds} с`);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
    console.log(`\nПодробности: ${jsonPath}`);
  }
}

void main();
