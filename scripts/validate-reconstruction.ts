import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Dwg_File_Type, LibreDwg } from "@mlightcad/libredwg-web";
import sharpModule from "sharp";
import { pngPreviewDataUrl } from "../app/lib/reconstruction/server/preview";
import { exportReconstructionDae } from "../app/lib/reconstruction/modelScene";
import {
  cadPreviewDatabase,
  extractCadReconstructionContext,
  repairCadSvg,
} from "../app/lib/reconstruction/prepareDrawing";
import type { ReconstructionModel } from "../app/lib/reconstruction/types";
import { readAnalysisResponse } from "../app/lib/ai/readResponse";

const inspectContours = process.argv.includes("--inspect-contours");
const files = process.argv
  .slice(2)
  .filter((file) => file !== "--inspect-contours")
  .map((file) => resolve(file));
if (!files.length) throw new Error("Передайте один или несколько DWG-файлов.");

const outputDirectory = resolve("validation-output");
await mkdir(outputDirectory, { recursive: true });
const parser = await LibreDwg.create(resolve("node_modules/@mlightcad/libredwg-web/wasm"));

type SharpPipeline = {
  flatten(options?: Record<string, unknown>): SharpPipeline;
  resize(options?: Record<string, unknown>): SharpPipeline;
  png(options?: Record<string, unknown>): SharpPipeline;
  extract(region: { left: number; top: number; width: number; height: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{ width?: number; height?: number }>;
};
type SharpFactory = (input?: Buffer, options?: Record<string, unknown>) => SharpPipeline;
const sharp = sharpModule as unknown as SharpFactory;

interface ValidationCadContext {
  planContourCandidates?: Array<Record<string, unknown>>;
  modelSpaceBounds?: { min: { x: number; y: number }; max: { x: number; y: number } };
  entityCount?: unknown;
  truncation?: unknown;
}

function safeStem(file: string) {
  return (
    basename(file, extname(file))
      .replace(/[^a-zа-яё0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "drawing"
  );
}

function dataUrl(buffer: Buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function renderSourceImages(svg: string) {
  const source = Buffer.from(svg);
  const overview = await sharp(source, { density: 144 })
    .flatten({ background: "#ffffff" })
    .resize({ width: 4200, height: 4200, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const metadata = await sharp(overview).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const columns = width / height >= 1.35 ? 3 : 2;
  const rows = 2;
  const candidates: Array<{ index: number; buffer: Buffer }> = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = Math.round((column * width) / columns);
      const top = Math.round((row * height) / rows);
      const right = Math.round(((column + 1) * width) / columns);
      const bottom = Math.round(((row + 1) * height) / rows);
      const tile = await sharp(overview)
        .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
        .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      candidates.push({ index: row * columns + column, buffer: tile });
    }
  }
  const largest = Math.max(1, ...candidates.map((candidate) => candidate.buffer.length));
  const tiles = candidates
    .filter((candidate) => candidate.buffer.length >= largest * 0.08)
    .sort((left, right) => right.buffer.length - left.buffer.length)
    .slice(0, 4)
    .sort((left, right) => left.index - right.index)
    .map((candidate) => dataUrl(candidate.buffer));
  return { overview, images: [dataUrl(overview), ...tiles] };
}

async function validate(file: string) {
  const bytes = await readFile(file);
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const pointer = parser.dwg_read_data(data, Dwg_File_Type.DWG);
  if (!pointer) throw new Error(`${basename(file)}: DWG не распознан.`);

  try {
    const database = parser.convert(pointer);
    const context = extractCadReconstructionContext(database);
    const cad = JSON.parse(context) as ValidationCadContext;
    if (inspectContours) {
      return {
        file: basename(file),
        contours: (cad.planContourCandidates || []).map((candidate, index) => {
          const width = typeof candidate.width === "number" ? candidate.width : 0;
          const depth = typeof candidate.depth === "number" ? candidate.depth : 0;
          const area = typeof candidate.area === "number" ? candidate.area : 0;
          const compactness = typeof candidate.compactness === "number" ? candidate.compactness : 0;
          const vertices = Array.isArray(candidate.vertices) ? candidate.vertices : [];
          return {
            handle: candidate.handle,
            layer: candidate.layer,
            region: candidate.region,
            width: Math.round(width),
            depth: Math.round(depth),
            area: Math.round(area),
            compactness: Number(compactness.toFixed(2)),
            vertices: vertices.length,
            ...(index < 5 ? { points: vertices } : {}),
          };
        }),
      };
    }
    const rendered = await renderSourceImages(
      repairCadSvg(parser.dwg_to_svg(cadPreviewDatabase(database)), cad.modelSpaceBounds),
    );
    const stem = safeStem(file);
    await writeFile(join(outputDirectory, `${stem}-source.png`), rendered.overview);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
    let response: Response;
    let payload: { model?: ReconstructionModel; error?: string; code?: string };
    try {
      response = await fetch("http://localhost:3000/api/reconstruct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceName: basename(file),
          dataUrls: rendered.images,
          context,
          hints: { allowInferredGeometry: true },
        }),
        signal: controller.signal,
      });
      payload = await readAnalysisResponse(response, (event) => {
        if (event.stage) console.log(`${basename(file)}: ${event.stage}`);
      });
    } finally {
      clearTimeout(timeout);
    }
    await writeFile(
      join(outputDirectory, `${stem}-response.json`),
      JSON.stringify(payload, null, 2),
    );

    if (!response.ok || !payload.model) {
      return {
        file: basename(file),
        httpStatus: response.status,
        error: payload.error || payload.code || "Неизвестная ошибка",
      };
    }

    const model = payload.model;
    const preview = pngPreviewDataUrl(model as unknown as Record<string, unknown>);
    await writeFile(
      join(outputDirectory, `${stem}-model.png`),
      Buffer.from(preview.slice(preview.indexOf(",") + 1), "base64"),
    );
    if (model.parts.length) {
      const dae = exportReconstructionDae(model);
      await writeFile(
        join(outputDirectory, `${stem}-sketchup${model.canExport ? "" : "-draft"}.dae`),
        Buffer.from(await dae.arrayBuffer()),
      );
    }
    return {
      file: basename(file),
      httpStatus: response.status,
      title: model.title,
      method: model.method,
      status: model.status,
      parts: model.parts.length,
      canExport: model.canExport,
      confidence: model.overallConfidence,
      objectName: model.analysis?.objectName,
      views: model.analysis?.detectedViews.length || 0,
      dimensions: model.analysis?.dimensions.length || 0,
      features: model.analysis?.features.length || 0,
      entities: cad.entityCount,
      truncation: cad.truncation,
      agent: model.agentTrace && {
        model: model.agentTrace.model,
        completed: model.agentTrace.completed,
        solver: model.agentTrace.solver,
        previewCompared: model.agentTrace.previewCompared,
        reviewConfidence: model.agentTrace.reviewConfidence,
        verifiedElements: model.agentTrace.verifiedElements,
        mismatches: model.agentTrace.mismatches,
        steps: model.agentTrace.steps.map((step) => step.action),
      },
      unresolved: model.unresolved.map((issue) => `${issue.severity}:${issue.label}`),
      warnings: model.warnings,
    };
  } finally {
    parser.dwg_free(pointer);
  }
}

for (const file of files) {
  const startedAt = Date.now();
  console.log(JSON.stringify({ event: "started", file: basename(file) }));
  try {
    const result = await validate(file);
    console.log(
      JSON.stringify({
        event: "finished",
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        ...result,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "failed",
        file: basename(file),
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
