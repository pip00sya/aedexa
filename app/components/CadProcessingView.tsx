"use client";
import { downloadBlob } from "../lib/browser/download";
import { readAnalysisResponse } from "../lib/ai/readResponse";

import {
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  FileBox,
  FileUp,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Mountain,
  Rotate3d,
  Route,
  ScanLine,
  Sparkles,
} from "lucide-react";
import dynamic from "next/dynamic";
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  createArchiveId,
  loadArchiveDrawing,
  saveArchiveEntry,
  type TopographyArchiveEntry,
} from "../lib/archive";
import { createBuildingMask, WALL_TOUCH_TOLERANCE_METERS } from "../lib/cad/buildingMask";
import { cadColorFamilyLabels, findMixedColorLayers } from "../lib/cad/color";
import { exportDaeModel, type DaeExportStats } from "../lib/cad/exportDae";
import { downloadDxf, type DxfEntity } from "../lib/cad/exportDxf";
import { buildGeometryGroups, type CadGeometryGroup } from "../lib/cad/geometryGroups";
import { applyGroupDictionary, roadEdgeFeatures, stripCandidates } from "../lib/cad/groupSemantics";
import {
  auditPlacedCadFeature,
  CAD_AUDIT_VERSION,
  cadObjectRules,
  isCadFeatureRenderable,
} from "../lib/cad/objectRules";
import { processDwgFile } from "../lib/cad/processDwgClient";
import { buildRoadSurfaces, ROAD_SURFACE_SOURCE_TYPE } from "../lib/cad/roadSurface";
import {
  applyCadSemantics,
  buildSemanticInventory,
  describeSignature,
  findLegendRows,
} from "../lib/cad/semantics";
import { createTerrainResolver, placeFeaturesOnTerrain } from "../lib/cad/terrain";
import {
  cadKindMeta,
  cadKinds,
  type CadFeature,
  type CadKind,
  type CadProcessingResult,
  type CadQaStatus,
  type CadSemanticDictionary,
  type CadSemanticEntry,
  type CadSemanticsState,
  type CadStripVerdict,
} from "../lib/cad/types";
import { cadUnitsToMeters } from "../lib/cad/units";
import { downloadXlsx } from "../lib/report/xlsx";
import { computeEarthworks, earthworksXlsxSheets, type EarthworksResult } from "../lib/vertical";
import CadDrawingCanvas from "./CadDrawingCanvas";
import CadObjectPreview from "./CadObjectPreview";

/** Образец для миниатюры */
function pickPreviewSample(
  features: CadFeature[],
  accept: (feature: CadFeature) => boolean,
  unitsPerMeter: number,
) {
  let best: CadFeature | undefined;
  let bestScore = -Infinity;
  let bestExtent = 0;
  let seen = 0;
  for (const feature of features) {
    if (!accept(feature) || !feature.points.length) continue;
    seen += 1;
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
    const extentMeters = Math.max(maxX - minX, maxY - minY) / unitsPerMeter;
    const pointLike = Boolean(cadObjectRules[feature.kind].pointLike);
    const score =
      (isCadFeatureRenderable(feature) ? 4 : 0) +
      (feature.closed && feature.points.length >= 3 ? 1.5 : 0) +
      (pointLike ? 1 : (Math.min(extentMeters, 30) / 30) * 3) +
      (feature.points.length > 120 ? -2 : 0);
    if (score > bestScore) {
      best = feature;
      bestScore = score;
      bestExtent = pointLike ? Infinity : extentMeters;
    }
    if (seen >= 600) break;
  }
  // Слой из одних крошечных штрихов и кружков (условные знаки) миниатюрой не покажешь
  return bestExtent < 0.8 ? undefined : best;
}

/** Запускать ли ИИ сразу после разбора DWG */
const AI_RUNS_AUTOMATICALLY = false;

/** Показывать ли панели ИИ (подписи чертежа, группы геометрии) */
const SHOW_AI_PANELS = true;

const stripVerdictLabels: Record<CadStripVerdict, string> = {
  passage: "полоса — проход или проезд",
  plot: "полоса — внутренность участка",
  unclear: "по замеру различить не удалось",
};

const semanticStatusLabels: Record<CadSemanticEntry["status"], string> = {
  existing: "существующий",
  planned: "проектируемый",
  demolition: "под снос",
  unknown: "статус не указан",
};

function semanticKindLabel(kind: CadSemanticEntry["kind"]) {
  return kind === "ignore" ? "служебная подпись" : cadKindMeta[kind].short;
}

const CadViewport = dynamic(() => import("./CadViewport"), {
  ssr: false,
  loading: () => (
    <div className="cad-view-loading">
      <LoaderCircle className="spin" size={24} />
      <span>Собираем сцену из CAD-геометрии…</span>
    </div>
  ),
});

type CadProcessingViewProps = {
  onToast: (message: string) => void;
  archivedEntry?: TopographyArchiveEntry;
};

const initialVisibility = Object.fromEntries(cadKinds.map((kind) => [kind, true])) as Record<
  CadKind,
  boolean
>;

function formatVolume(value: number) {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

function formatCoordinate(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
}

function formatElevation(value: number, unitLabel: string) {
  const meters =
    unitLabel === "мм"
      ? value / 1_000
      : unitLabel === "см"
        ? value / 100
        : unitLabel === "км"
          ? value * 1_000
          : undefined;
  return meters === undefined ? `${value.toFixed(2)} ${unitLabel}` : `${meters.toFixed(2)} м`;
}

// TODO: разбить по шагам разбора
export default function CadProcessingView({ onToast, archivedEntry }: CadProcessingViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const archiveIdRef = useRef<string | undefined>(archivedEntry?.id);
  const archiveCreatedAtRef = useRef<string | undefined>(archivedEntry?.createdAt);
  const sourceFileRef = useRef<File | undefined>(archivedEntry?.sourceFile);
  const [result, setResult] = useState<CadProcessingResult | undefined>(
    () => archivedEntry?.payload,
  );
  // Чертеж архивной записи лежит отдельно и подгружается при открытии
  useEffect(() => {
    if (!archivedEntry || archivedEntry.payload.drawing) return;
    let cancelled = false;
    loadArchiveDrawing(archivedEntry.id)
      .then((drawing) => {
        if (cancelled || !drawing) return;
        setResult((current) =>
          current && current.fileName === archivedEntry.payload.fileName && !current.drawing
            ? { ...current, drawing }
            : current,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [archivedEntry]);
  const [preflightResult, setPreflightResult] = useState<CadProcessingResult>();
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Ожидаем DWG");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"2d" | "3d">(() =>
    archivedEntry?.payload.terrain.method === "none" ? "2d" : "3d",
  );
  const [wireframe, setWireframe] = useState(false);
  const [drawingSource, setDrawingSource] = useState<"source" | "classes">("source");
  const [displayTheme, setDisplayTheme] = useState<"semantic" | "qa">("semantic");
  const [visibleKinds, setVisibleKinds] = useState(initialVisibility);
  const [showQaDetails, setShowQaDetails] = useState(false);
  const [showAllLayers, setShowAllLayers] = useState(false);
  const [isExportingDae, setIsExportingDae] = useState(false);
  const [daeProgress, setDaeProgress] = useState(0);
  const [daeProgressLabel, setDaeProgressLabel] = useState("");
  const [lastDaeStats, setLastDaeStats] = useState<DaeExportStats>();
  const [verticalFields, setVerticalFields] = useState<Record<string, string>>({});
  const [verticalError, setVerticalError] = useState("");
  const [earthworks, setEarthworks] = useState<{
    computed: EarthworksResult;
    platform: { x: number; y: number }[];
  } | null>(null);
  // Отпечатки групп считаются один раз на чертеж
  const [geometryGroups, setGeometryGroups] = useState<CadGeometryGroup[]>([]);
  const [roadEdgeSelection, setRoadEdgeSelection] = useState<string[]>([]);
  const latestResultRef = useRef<CadProcessingResult | undefined>(result);
  useEffect(() => {
    latestResultRef.current = result;
  }, [result]);
  const semanticCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const feature of result?.features ?? []) {
      if (feature.semantic)
        counts.set(feature.semantic.label, (counts.get(feature.semantic.label) ?? 0) + 1);
    }
    return counts;
  }, [result]);
  const previewUnitsPerMeter = useMemo(() => {
    const metersPerUnit = result ? cadUnitsToMeters(result.unitLabel) : 1;
    return Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? 1 / metersPerUnit : 1;
  }, [result]);
  /** Образцы для миниатюр */
  const previewSamples = useMemo(() => {
    const features = result?.features ?? [];
    const byLabel = new Map<string, CadFeature | undefined>();
    for (const entry of result?.semantics?.dictionary?.entries ?? []) {
      byLabel.set(
        entry.label,
        pickPreviewSample(
          features,
          (feature) => feature.semantic?.label === entry.label,
          previewUnitsPerMeter,
        ),
      );
    }
    const byKind = new Map<CadKind, CadFeature | undefined>();
    for (const kind of cadKinds)
      byKind.set(
        kind,
        pickPreviewSample(features, (feature) => feature.kind === kind, previewUnitsPerMeter),
      );
    const byLayer = new Map<string, CadFeature | undefined>();
    for (const layer of result?.layers ?? []) {
      byLayer.set(
        layer.name,
        pickPreviewSample(
          features,
          (feature) => feature.layer === layer.name && feature.kind === layer.kind,
          previewUnitsPerMeter,
        ),
      );
    }
    return { byLabel, byKind, byLayer };
  }, [result, previewUnitsPerMeter]);

  const modelFeatures = useMemo(
    () => result?.features.filter(isCadFeatureRenderable) ?? [],
    [result],
  );
  const modelCounts = useMemo(() => {
    const counts = Object.fromEntries(cadKinds.map((kind) => [kind, 0])) as Record<CadKind, number>;
    for (const feature of viewMode === "2d" ? (result?.features ?? []) : modelFeatures)
      counts[feature.kind] += 1;
    if (result?.terrain.triangles.length) counts.terrain = 1;
    return counts;
  }, [modelFeatures, result, viewMode]);
  const unresolvedCount = useMemo(
    () => result?.features.filter((feature) => feature.elevationMode === "unresolved").length ?? 0,
    [result],
  );
  const qaCounts = useMemo(() => {
    const counts: Record<CadQaStatus, number> = { AUTO: 0, REVIEW: 0, REJECT: 0 };
    for (const feature of result?.features ?? []) counts[feature.qaStatus ?? "REVIEW"] += 1;
    return counts;
  }, [result]);
  const qaGroups = useMemo(() => {
    const groups = Object.fromEntries(
      cadKinds.map((kind) => [kind, { AUTO: 0, REVIEW: 0, REJECT: 0 }]),
    ) as Record<CadKind, Record<CadQaStatus, number>>;
    for (const feature of modelFeatures) groups[feature.kind][feature.qaStatus ?? "REVIEW"] += 1;
    if (result?.terrain.triangles.length) groups.terrain.AUTO = 1;
    return cadKinds
      .map((kind) => ({ kind, ...groups[kind] }))
      .filter((group) => group.AUTO + group.REVIEW + group.REJECT > 0);
  }, [modelFeatures, result]);
  const modelQaCounts = useMemo(
    () => ({
      AUTO:
        modelFeatures.filter((feature) => feature.qaStatus === "AUTO").length +
        (result?.terrain.triangles.length ? 1 : 0),
      REVIEW: modelFeatures.filter((feature) => feature.qaStatus === "REVIEW").length,
      REJECT: Math.max(0, (result?.features.length ?? 0) - modelFeatures.length),
    }),
    [modelFeatures, result],
  );

  const verticalDefaults = useMemo(() => {
    if (!result || result.terrain.method === "none") return null;
    const factor = cadUnitsToMeters(result.unitLabel);
    const minX = result.bounds.minX * factor;
    const minY = result.bounds.minY * factor;
    const spanX = Math.max(1, (result.bounds.maxX - result.bounds.minX) * factor);
    const spanY = Math.max(1, (result.bounds.maxY - result.bounds.minY) * factor);
    const width = Math.max(4, Math.round(spanX * 0.4));
    const height = Math.max(4, Math.round(spanY * 0.4));
    const round2 = (value: number) => Math.round(value * 100) / 100;
    return {
      x: round2(minX + (spanX - width) / 2),
      y: round2(minY + (spanY - height) / 2),
      width,
      height,
      elevation: round2(((result.terrain.minElevation + result.terrain.maxElevation) / 2) * factor),
      slope: 1.5,
      step: Math.max(1, Math.round(Math.max(width, height) / 40)),
      loosening: 1.15,
    };
  }, [result]);

  const verticalValue = (key: keyof NonNullable<typeof verticalDefaults>) => {
    const raw = verticalFields[key];
    return raw !== undefined && raw !== "" ? raw : String(verticalDefaults?.[key] ?? "");
  };

  const runEarthworks = () => {
    if (!result || !verticalDefaults) return;
    const numeric = (key: keyof typeof verticalDefaults) => {
      const parsed = Number(verticalValue(key).replace(",", "."));
      return Number.isFinite(parsed) ? parsed : verticalDefaults[key];
    };
    const factor = cadUnitsToMeters(result.unitLabel);
    const resolveSource = createTerrainResolver(result.terrain);
    const resolve = (x: number, y: number) => {
      const z = resolveSource(x / factor, y / factor);
      return z === undefined ? undefined : z * factor;
    };
    const x = numeric("x");
    const y = numeric("y");
    const width = Math.abs(numeric("width"));
    const height = Math.abs(numeric("height"));
    const platform = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
    try {
      const computed = computeEarthworks({
        platform,
        platformElevation: numeric("elevation"),
        slopeRatio: Math.max(0, numeric("slope")),
        gridStep: Math.max(0.5, numeric("step")),
        looseningFactor: Math.max(1, numeric("loosening")),
        resolve,
      });
      setEarthworks({ computed, platform });
      setVerticalError("");
    } catch (caught) {
      setEarthworks(null);
      setVerticalError(
        caught instanceof Error ? caught.message : "Не удалось рассчитать вертикальную планировку.",
      );
    }
  };

  const downloadEarthworksXlsx = () => {
    if (!earthworks || !result) return;
    downloadXlsx(
      `вертикальная-планировка-${result.fileName.replace(/\.dwg$/iu, "")}`,
      earthworksXlsxSheets(earthworks.computed, result.fileName),
    );
  };

  const downloadEarthworksDxf = () => {
    if (!earthworks || !result) return;
    const entities: DxfEntity[] = [
      { type: "polyline", layer: "AEDEXA_ПЛОЩАДКА", points: earthworks.platform, closed: true },
      ...earthworks.computed.zeroLine.map(
        (segment): DxfEntity => ({
          type: "line",
          layer: "AEDEXA_НУЛЕВЫЕ_РАБОТЫ",
          start: segment[0],
          end: segment[1],
        }),
      ),
    ];
    const labelStride = Math.max(1, Math.ceil(earthworks.computed.nodes.length / 400));
    earthworks.computed.nodes.forEach((node, index) => {
      if (index % labelStride) return;
      entities.push({
        type: "text",
        layer: "AEDEXA_РАБОЧИЕ_ОТМЕТКИ",
        position: { x: node.x, y: node.y },
        height: earthworks.computed.step * 0.25,
        value: `${node.work >= 0 ? "+" : ""}${node.work.toFixed(2)}`,
      });
    });
    downloadDxf(
      `картограмма-${result.fileName.replace(/\.dwg$/iu, "")}`,
      [
        { name: "AEDEXA_ПЛОЩАДКА", colorIndex: 3 },
        { name: "AEDEXA_НУЛЕВЫЕ_РАБОТЫ", colorIndex: 1 },
        { name: "AEDEXA_РАБОЧИЕ_ОТМЕТКИ", colorIndex: 7 },
      ],
      entities,
    );
  };

  const saveCadArchive = (
    processed: CadProcessingResult,
    archiveId = archiveIdRef.current,
    createdAt = archiveCreatedAtRef.current,
  ) => {
    if (!archiveId || !createdAt) return;
    const ready = processed.preflight.status === "ready" && processed.terrain.method !== "none";
    void saveArchiveEntry({
      schema: 1,
      id: archiveId,
      kind: "topography",
      title: processed.fileName.replace(/\.dwg$/iu, "") || "DWG-топосъёмка",
      sourceName: processed.fileName,
      summary: `${processed.features.length.toLocaleString("ru-RU")} объектов · ${processed.layers.length} слоёв · ${processed.terrain.method === "none" ? "без высотного рельефа" : "TIN-рельеф построен"}`,
      status: processed.preflight.status === "blocked" ? "blocked" : ready ? "ready" : "review",
      createdAt,
      updatedAt: new Date().toISOString(),
      sourceFile: sourceFileRef.current,
      payload: processed,
    }).catch((reason) =>
      setError(
        reason instanceof Error ? reason.message : "Не удалось сохранить DWG-результат в архив.",
      ),
    );
  };

  /** Подписи чертежа читает ИИ, применяет программа */
  const readDrawingSemantics = async (
    processed: CadProcessingResult,
    archiveId = archiveIdRef.current,
    createdAt = archiveCreatedAtRef.current,
  ) => {
    const inventory = buildSemanticInventory(processed);
    const publish = (semantics: CadSemanticsState, dictionary?: CadSemanticDictionary) => {
      const current = latestResultRef.current;
      if (!current || current.fileName !== processed.fileName) return 0;
      const applied = dictionary ? applyCadSemantics(current, dictionary) : undefined;
      const next: CadProcessingResult = {
        ...(applied ? applied.result : current),
        semantics: applied
          ? {
              ...semantics,
              appliedCount: applied.appliedCount,
              message: `Прочитано ${dictionary?.entries.length ?? 0} обозначений · пояснения получили ${applied.result.features.filter((feature) => feature.semantic).length.toLocaleString("ru-RU")} объектов · изменено ${applied.appliedCount.toLocaleString("ru-RU")} · ${dictionary?.model ? `модель ${dictionary.model}` : "ИИ"}`,
            }
          : semantics,
      };
      latestResultRef.current = next;
      setResult(next);
      saveCadArchive(next, archiveId, createdAt);
      return applied?.appliedCount ?? 0;
    };
    if (!inventory.texts.length) {
      publish({
        status: "skipped",
        message: "В чертеже нет текстовых подписей — читать нечего.",
        appliedCount: 0,
      });
      return;
    }
    publish({
      status: "pending",
      message: `ИИ читает ${inventory.texts.length.toLocaleString("ru-RU")} подписей и примечаний чертежа. Анализ может занять несколько минут.`,
      appliedCount: 0,
    });
    try {
      const response = await fetch("/api/cad-semantics", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(inventory),
      });
      const payload = (await readAnalysisResponse(response, (event) => {
        if (event.stage) publish({ status: "pending", message: event.stage, appliedCount: 0 });
      })) as {
        dictionary?: CadSemanticDictionary;
        code?: string;
        error?: string;
      };
      if (!response.ok || !payload.dictionary) {
        publish({
          status: payload.code === "AI_NOT_CONFIGURED" ? "skipped" : "error",
          message: payload.error || "ИИ не смог прочитать подписи чертежа.",
          appliedCount: 0,
        });
        return;
      }
      const appliedCount = publish(
        { status: "ready", message: "", dictionary: payload.dictionary, appliedCount: 0 },
        payload.dictionary,
      );
      onToast(
        `ИИ прочитал ${payload.dictionary.entries.length} обозначений чертежа, изменено ${appliedCount} объектов`,
      );
    } catch {
      publish({
        status: "error",
        message: "Сервис ИИ недоступен: подписи не прочитаны.",
        appliedCount: 0,
      });
    }
  };

  /** Проезжая часть по указанным кромкам */
  const buildRoadFromGroups = (
    processed: CadProcessingResult,
    groups: CadGeometryGroup[],
    selected: string[],
  ) => {
    const unitsPerMeter = 1 / cadUnitsToMeters(processed.unitLabel);
    const chosen = new Set(
      groups.filter((group) => selected.includes(group.id)).flatMap((group) => group.featureIds),
    );
    const edges = processed.features.filter((feature) => chosen.has(feature.id));
    // Асфальт не идет по домам
    const surfaces = edges.length
      ? buildRoadSurfaces(
          edges,
          unitsPerMeter,
          {},
          createBuildingMask(processed.features, WALL_TOUCH_TOLERANCE_METERS * unitsPerMeter),
        )
      : [];
    const draped =
      surfaces.length && processed.terrain.method !== "none"
        ? placeFeaturesOnTerrain(surfaces, processed.terrain)
        : surfaces;
    const next: CadProcessingResult = {
      ...processed,
      features: [
        ...processed.features.filter((feature) => feature.sourceType !== ROAD_SURFACE_SOURCE_TYPE),
        ...draped,
      ],
    };
    latestResultRef.current = next;
    setResult(next);
    saveCadArchive(next);
    onToast(
      draped.length
        ? `Построено полотен проезда: ${draped.length}`
        : "По выбранным кромкам пар нужной ширины не нашлось — полотно не построено",
    );
  };

  /** Разбор групп геометрии */
  const analyzeDrawingGroups = async (
    processed: CadProcessingResult,
    archiveId = archiveIdRef.current,
    createdAt = archiveCreatedAtRef.current,
  ) => {
    const unitsPerMeter = 1 / cadUnitsToMeters(processed.unitLabel);
    const groups = buildGeometryGroups(processed.features, unitsPerMeter);
    const publish = (
      groupSemantics: CadProcessingResult["groupSemantics"],
      next?: CadProcessingResult,
    ) => {
      const current = next ?? latestResultRef.current;
      if (!current || current.fileName !== processed.fileName) return;
      const merged: CadProcessingResult = { ...current, groupSemantics };
      latestResultRef.current = merged;
      setResult(merged);
      saveCadArchive(merged, archiveId, createdAt);
    };

    if (!groups.length) {
      publish({
        status: "skipped",
        message: "В чертеже нет групп геометрии для разбора.",
        appliedCount: 0,
      });
      return;
    }
    publish({
      status: "pending",
      message: `ИИ разбирает ${groups.length} групп геометрии…`,
      appliedCount: 0,
    });

    try {
      const response = await fetch("/api/cad-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          fileName: processed.fileName,
          unitLabel: processed.unitLabel,
          // Идентификаторы объектов остаются на клиенте
          groups: groups.map((group) => ({ ...group, featureIds: undefined })),
          legend: findLegendRows(processed).flatMap((row) =>
            row.signatures.map((signature) => ({
              text: row.text,
              sample: describeSignature(signature),
            })),
          ),
          mixedColorLayers: [
            ...findMixedColorLayers(
              processed.features.map((feature) => ({
                layer: feature.layer,
                sourceType: feature.sourceType,
                family: feature.colorFamily ?? "unknown",
              })),
            ),
          ],
        }),
      });
      const payload = (await readAnalysisResponse(response, (event) => {
        if (event.stage) publish({ status: "pending", message: event.stage, appliedCount: 0 });
      })) as {
        dictionary?: NonNullable<CadProcessingResult["groupSemantics"]>["dictionary"];
        code?: string;
        error?: string;
      };
      if (!response.ok || !payload.dictionary) {
        publish({
          status: payload.code === "AI_NOT_CONFIGURED" ? "skipped" : "error",
          message: payload.error || "ИИ не смог разобрать группы чертежа.",
          appliedCount: 0,
        });
        return;
      }

      const current = latestResultRef.current;
      if (!current || current.fileName !== processed.fileName) return;
      const applied = applyGroupDictionary(current, groups, payload.dictionary);
      const edges = roadEdgeFeatures(applied.result, groups, payload.dictionary);
      const surfaces = edges.length ? buildRoadSurfaces(edges, unitsPerMeter) : [];
      // Полотно выведено в плане
      const draped =
        surfaces.length && applied.result.terrain.method !== "none"
          ? placeFeaturesOnTerrain(surfaces, applied.result.terrain)
          : surfaces;
      const withSurfaces: CadProcessingResult = {
        ...applied.result,
        features: [
          ...applied.result.features.filter(
            (feature) => feature.sourceType !== ROAD_SURFACE_SOURCE_TYPE,
          ),
          ...draped,
        ],
      };
      const roadNote = draped.length
        ? ` · построено полотен проезда: ${draped.length} (между подтверждёнными кромками, разрывы не заполнялись)`
        : edges.length
          ? " · кромки найдены, но пар нужной ширины между ними нет — полотно не строилось"
          : "";
      publish(
        {
          status: "ready",
          message: `Разобрано групп: ${payload.dictionary.decisions.length} · сменили класс ${applied.appliedCount.toLocaleString("ru-RU")} объектов${roadNote} · модель ${payload.dictionary.model ?? "ИИ"}`,
          dictionary: payload.dictionary,
          appliedCount: applied.appliedCount,
        },
        withSurfaces,
      );
      onToast(
        `ИИ разобрал ${payload.dictionary.decisions.length} групп чертежа${draped.length ? `, построено ${draped.length} полотен проезда` : ""}`,
      );
    } catch {
      publish({
        status: "error",
        message: "Сервис ИИ недоступен: группы не разобраны.",
        appliedCount: 0,
      });
    }
  };

  const processFile = async (file?: File) => {
    if (!file || isProcessing) return;
    setError("");
    setResult(undefined);
    setPreflightResult(undefined);
    setVisibleKinds(initialVisibility);
    setShowQaDetails(false);
    setWireframe(false);
    setDisplayTheme("semantic");
    setEarthworks(null);
    setVerticalFields({});
    setVerticalError("");
    setProgress(2);
    setProgressLabel("Проверяем файл");
    setIsProcessing(true);
    const archiveId = createArchiveId("topography");
    const archiveCreatedAt = new Date().toISOString();
    sourceFileRef.current = file;
    archiveIdRef.current = archiveId;
    archiveCreatedAtRef.current = archiveCreatedAt;
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 60));
      const processed = await processDwgFile(file, (nextProgress, label) => {
        setProgress(nextProgress);
        setProgressLabel(label);
      });
      if (processed.terrain.method === "none") {
        setPreflightResult(processed);
        setViewMode("2d");
      } else {
        latestResultRef.current = processed;
        setResult(processed);
        setViewMode("3d");
      }
      setProgress(100);
      setProgressLabel(
        processed.terrain.method === "none" ? "Нужны высотные данные" : "Рельеф и объекты собраны",
      );
      saveCadArchive(processed, archiveId, archiveCreatedAt);
      // Сначала подписи и легенда
      if (processed.terrain.method !== "none") {
        // Замер групп нужен и без ИИ
        setGeometryGroups(
          buildGeometryGroups(processed.features, 1 / cadUnitsToMeters(processed.unitLabel)),
        );
        setRoadEdgeSelection([]);
      }
      if (AI_RUNS_AUTOMATICALLY && processed.terrain.method !== "none") {
        void readDrawingSemantics(processed, archiveId, archiveCreatedAt).then(() =>
          analyzeDrawingGroups(processed, archiveId, archiveCreatedAt),
        );
      }
      onToast(
        processed.terrain.method === "none"
          ? "DWG прочитан, но реальных высот недостаточно для рельефа"
          : "Готово: объекты распознаны и посажены на рельеф",
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Не удалось разобрать DWG";
      setError(message);
      setProgress(0);
      setProgressLabel("Обработка остановлена");
    } finally {
      setIsProcessing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    void processFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void processFile(event.dataTransfer.files?.[0]);
  };

  const openProcessedModel = () => {
    if (!preflightResult) return;
    setViewMode("2d");
    setResult(preflightResult);
    setPreflightResult(undefined);
    onToast("Открыт исходный DWG в плоском 2D-виде");
  };

  const changeLayerKind = (layerName: string, kind: CadKind) => {
    setResult((current) => {
      if (!current) return current;
      const next = {
        ...current,
        layers: current.layers.map((layer) =>
          layer.name === layerName
            ? { ...layer, kind, confidence: 1, reason: "назначено пользователем" }
            : layer,
        ),
        features: current.features.map((feature) =>
          feature.layer === layerName
            ? auditPlacedCadFeature({
                ...feature,
                kind,
                confidence: 1,
                reason: "назначено пользователем",
                classificationSource: "OPERATOR",
                heightMeters: undefined,
                heightQuality: undefined,
                heightSource: undefined,
              })
            : feature,
        ),
      };
      saveCadArchive(next);
      return next;
    });
    onToast(`Слой «${layerName}» переназначен`);
  };

  const exportProtocol = () => {
    if (!result) return;
    const protocol = {
      schema: "AEDEXA_OBJECT_AUDIT/1.0",
      auditVersion: CAD_AUDIT_VERSION,
      file: result.fileName,
      processedAt: new Date().toISOString(),
      formatVersion: result.formatVersion,
      units: result.unitLabel,
      spatialReference: result.spatialReference ?? {
        horizontalCrs: "UNKNOWN",
        verticalDatum: "UNKNOWN",
        confirmedByOperator: false,
      },
      preflight: result.preflight,
      entities: result.entityCount,
      modelEntities: result.modelEntityCount,
      renderedEntities: result.renderedEntityCount,
      bounds: result.bounds,
      terrain: {
        sampleCount: result.terrain.sampleCount,
        sourceSampleCount: result.terrain.sourceSampleCount,
        trustedSampleCount: result.terrain.trustedSampleCount,
        interpretedSampleCount: result.terrain.interpretedSampleCount,
        derivedBoundarySampleCount: result.terrain.derivedBoundarySampleCount ?? 0,
        triangleCount: result.terrain.triangles.length / 3,
        structuralLineCount: result.terrain.structuralLineCount,
        conflictingPointCount: result.terrain.conflictingPointCount,
        rejectedSampleCount: result.terrain.rejectedSampleCount,
        method: result.terrain.method,
        minElevation: result.terrain.minElevation,
        maxElevation: result.terrain.maxElevation,
        quality: result.terrain.quality,
      },
      elevationModes: Object.fromEntries(
        ["terrain", "absolute", "draped", "leveled", "unresolved"].map((mode) => [
          mode,
          result.features.filter((feature) => feature.elevationMode === mode).length,
        ]),
      ),
      qa: {
        auto: qaCounts.AUTO,
        review: qaCounts.REVIEW,
        reject: qaCounts.REJECT,
        note: "AUTO допускается в DAE; REVIEW экспортируется с явным происхождением; REJECT исключается. TEMPLATE не является измерением.",
      },
      heightQualities: Object.fromEntries(
        ["MEASURED", "DERIVED", "ATTRIBUTE", "ANNOTATION", "TEMPLATE", "UNKNOWN"].map((quality) => [
          quality,
          result.features.filter((feature) => feature.heightQuality === quality).length,
        ]),
      ),
      objectRules: cadObjectRules,
      semantics: result.semantics,
      layers: result.layers,
      objects: result.features.map((feature) => ({
        id: feature.id,
        sourceType: feature.sourceType,
        layer: feature.layer,
        blockName: feature.blockName,
        class: feature.kind,
        classConfidence: feature.confidence,
        classificationSource: feature.classificationSource,
        classificationReason: feature.reason,
        geometryConfidence: feature.geometryConfidence,
        pointCount: feature.points.length,
        closed: feature.closed,
        elevationMode: feature.elevationMode,
        baseElevation: feature.baseElevation,
        xySource: feature.xySource,
        zSource: feature.zSource,
        heightMeters: feature.heightMeters,
        heightQuality: feature.heightQuality,
        heightSource: feature.heightSource,
        modelRecipe: feature.modelRecipe,
        qaStatus: feature.qaStatus,
        qaIssues: feature.qaIssues,
        operatorDecision: feature.operatorDecision,
        labels: feature.labels,
        semantic: feature.semantic,
      })),
      warnings: result.warnings,
    };
    const blob = new Blob([JSON.stringify(protocol, null, 2)], { type: "application/json" });
    downloadBlob(`${result.fileName.replace(/\.dwg$/iu, "")}-aedexa-protocol.json`, blob);
    onToast("Протокол обработки скачан");
  };

  const exportDae = async () => {
    if (!result || isExportingDae || result.terrain.method === "none") return;
    setIsExportingDae(true);
    setDaeProgress(1);
    setDaeProgressLabel("Запускаем экспорт");
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const exported = await exportDaeModel(result, (nextProgress, label) => {
        setDaeProgress(nextProgress);
        setDaeProgressLabel(label);
      });
      const blob = new Blob([exported.content], {
        type: "model/vnd.collada+xml;charset=utf-8",
      });
      downloadBlob(`${result.fileName.replace(/\.dwg$/iu, "")}-aedexa.dae`, blob);
      setLastDaeStats(exported.stats);
      onToast(
        `DAE готов: ${exported.stats.triangleCount.toLocaleString("ru-RU")} треугольников, ${exported.stats.featureCount.toLocaleString("ru-RU")} объектов`,
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Не удалось собрать DAE";
      setDaeProgressLabel(message);
      onToast(message);
    } finally {
      setIsExportingDae(false);
    }
  };

  // Собственного заголовка у режима нет
  return (
    <section className="cad-workspace" aria-label="Топосъёмка DWG">
      {result && (
        <div className="cad-intro">
          <div className="cad-actions">
            <button
              type="button"
              className="cad-primary-export"
              onClick={() => void exportDae()}
              disabled={isExportingDae || result.terrain.method === "none"}
              aria-busy={isExportingDae}
            >
              {isExportingDae ? <LoaderCircle className="spin" size={17} /> : <Box size={17} />}
              {isExportingDae
                ? `${daeProgress}%`
                : result.terrain.method === "none"
                  ? "DAE недоступен без рельефа"
                  : "Скачать DAE"}
            </button>
            <button
              type="button"
              className="cad-secondary-action"
              onClick={exportProtocol}
              disabled={isExportingDae}
            >
              <Download size={16} /> Протокол JSON
            </button>
            {isExportingDae && (
              <div className="cad-export-progress" role="status" aria-live="polite">
                <span>{daeProgressLabel}</span>
                <i>
                  <b style={{ width: `${daeProgress}%` }} />
                </i>
              </div>
            )}
            {!isExportingDae && lastDaeStats && (
              <small className="cad-export-summary">
                Последний DAE: {lastDaeStats.triangleCount.toLocaleString("ru-RU")} треугольников ·{" "}
                {lastDaeStats.featureCount.toLocaleString("ru-RU")} объектов · без исходного
                2D-чертежа
              </small>
            )}
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".dwg,application/acad,application/x-acad,application/autocad_dwg"
        onChange={handleInput}
        aria-label="Выбрать DWG топосъёмки"
      />

      {!result && !preflightResult && !isProcessing && (
        <div className="cad-empty-layout">
          <div className="cad-main">
            <header className="cad-panel-head">
              <div>
                <p className="placement-eyebrow">ИСХОДНЫЙ ФАЙЛ</p>
                <h2>Новая топосъёмка</h2>
              </div>
            </header>
            <div
              className={`cad-dropzone ${isDragging ? "dragging" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <div className="cad-upload-icon">
                <FileUp size={30} strokeWidth={1.6} />
              </div>
              <span className="placement-eyebrow">ШАГ 01</span>
              <h3>Загрузите топосъёмку DWG</h3>
              <p>Перетащите файл сюда или выберите его на компьютере. До 80 МБ.</p>
              <button className="cad-primary-action" onClick={() => inputRef.current?.click()}>
                <FileBox size={17} /> Выбрать DWG
              </button>
              <div className="cad-local-note">
                <LockKeyhole size={14} /> DWG не покидает браузер
              </div>
            </div>
          </div>
          <div className="cad-pipeline-card">
            <p className="placement-eyebrow">ЧТО БУДЕТ СДЕЛАНО</p>
            <h2>Проверяемый рельеф</h2>
            <ol>
              <li>
                <span>01</span>
                <div>
                  <strong>Чтение и автопривязка</strong>
                  <small>Модель, блоки, слои, единицы, координаты, EPSG/UTM и система высот</small>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Отбор высот</strong>
                  <small>
                    Только реальные Z и строго числовые отметки — без пикетажа, размеров и подписей
                  </small>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Безопасный TIN</strong>
                  <small>Удалённые зоны, пустоты и неправдоподобные уклоны не соединяются</small>
                </div>
              </li>
              <li>
                <span>04</span>
                <div>
                  <strong>Размещение объектов</strong>
                  <small>Поднимаются только объекты внутри подтверждённой поверхности</small>
                </div>
              </li>
            </ol>
          </div>
        </div>
      )}

      {isProcessing && (
        <div className="cad-processing" role="status" aria-live="polite">
          <div className="cad-processing-visual">
            <ScanLine size={44} strokeWidth={1.25} />
            <i style={{ height: `${Math.max(8, progress)}%` }} />
          </div>
          <span className="cad-step-label">CAD-ЯДРО РАБОТАЕТ ЛОКАЛЬНО</span>
          <h3>{progressLabel}</h3>
          <div className="cad-progress-track">
            <i style={{ width: `${progress}%` }} />
          </div>
          <strong>{progress}%</strong>
          <p>Большие DWG могут занимать больше времени. Не закрывайте вкладку.</p>
        </div>
      )}

      {error && !isProcessing && (
        <div className="cad-error" role="alert">
          <AlertTriangle size={22} />
          <div>
            <strong>DWG не обработан</strong>
            <p>{error}</p>
          </div>
          <button onClick={() => inputRef.current?.click()}>Выбрать другой файл</button>
        </div>
      )}

      {preflightResult && !result && !isProcessing && (
        <section
          className={`cad-preflight ${preflightResult.preflight.status}`}
          aria-labelledby="cad-preflight-title"
        >
          <div className="cad-preflight-heading">
            <div>
              <p className="eyebrow">АВТОПРОВЕРКА ИСХОДНЫХ ДАННЫХ</p>
              <h3 id="cad-preflight-title">Для настоящего 3D не хватает высот</h3>
              <p>
                Программа уже проверила единицы, координаты, слои и отметки. Плоская подмена рельефа
                отключена, поэтому файл можно открыть в 2D, но система не станет выдавать его за
                готовую поверхность.
              </p>
            </div>
            <div className={`cad-preflight-state ${preflightResult.preflight.status}`}>
              НУЖНЫ РЕАЛЬНЫЕ Z
            </div>
          </div>

          <div className="cad-preflight-file">
            <FileBox size={18} />
            <span>
              <strong>{preflightResult.fileName}</strong>
              <small>
                {formatBytes(preflightResult.fileSize)} · {preflightResult.formatVersion}
              </small>
            </span>
            <button type="button" onClick={() => inputRef.current?.click()}>
              <FileUp size={15} /> Другой DWG
            </button>
          </div>

          <div className="cad-preflight-grid" role="list" aria-label="Проверки исходного DWG">
            {preflightResult.preflight.checks.map((check) => (
              <article className={check.status} role="listitem" key={check.id}>
                <span className="cad-preflight-icon">
                  {check.status === "pass" ? <Check size={15} /> : <AlertTriangle size={15} />}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <small>{check.detail}</small>
                </div>
                <b>{check.value}</b>
              </article>
            ))}
          </div>

          <div className="cad-preflight-decision">
            <p>
              <AlertTriangle size={17} /> В DWG недостаточно согласованных Z. Можно открыть исходный
              чертёж в 2D, но это не рельеф.
            </p>
            <div>
              <button type="button" className="cad-secondary-action" onClick={openProcessedModel}>
                <Layers3 size={16} /> Посмотреть исходный DWG в 2D
              </button>
            </div>
          </div>
        </section>
      )}

      {result && !isProcessing && (
        <>
          <div className="cad-kpis" aria-label="Результаты обработки DWG">
            <article>
              <FileBox size={17} />
              <small>Файл</small>
              <strong>{result.fileName}</strong>
              <span>{formatBytes(result.fileSize)}</span>
            </article>
            <article>
              <Box size={17} />
              <small>Сущности модели</small>
              <strong>{result.modelEntityCount.toLocaleString("ru-RU")}</strong>
              <span>{result.renderedEntityCount.toLocaleString("ru-RU")} в сцене</span>
            </article>
            <article>
              <Layers3 size={17} />
              <small>Слои</small>
              <strong>{result.layers.length}</strong>
              <span>{modelFeatures.length.toLocaleString("ru-RU")} объектов вошли в 3D</span>
            </article>
            <article>
              <Mountain size={17} />
              <small>
                {result.terrain.method === "none" ? "Рельеф не построен" : "Локальный TIN"}
              </small>
              <strong>{(result.terrain.triangles.length / 3).toLocaleString("ru-RU")}</strong>
              <span>
                {result.terrain.trustedSampleCount.toLocaleString("ru-RU")} реальных Z ·{" "}
                {Math.max(
                  0,
                  result.terrain.interpretedSampleCount -
                    (result.terrain.derivedBoundarySampleCount ?? 0),
                ).toLocaleString("ru-RU")}{" "}
                отметок · {(result.terrain.derivedBoundarySampleCount ?? 0).toLocaleString("ru-RU")}{" "}
                узлов границы
              </span>
            </article>
          </div>

          <section
            className={`cad-auto-reference ${result.spatialReference?.detectionMethod?.toLowerCase() ?? "source_preserved"}`}
            aria-label="Автоматическая геодезическая привязка"
          >
            <span className="cad-auto-reference-icon">
              {result.spatialReference?.detectionMethod === "EMBEDDED" ? (
                <Check size={18} />
              ) : (
                <ScanLine size={18} />
              )}
            </span>
            <div>
              <p className="eyebrow">АВТОМАТИЧЕСКАЯ ПРИВЯЗКА</p>
              <h3>{result.spatialReference?.horizontalCrs ?? "Исходная система координат DWG"}</h3>
              <p>
                {result.spatialReference?.verticalDatum ??
                  "Исходные Z сохранены без преобразования"}
              </p>
            </div>
            <dl>
              <div>
                <dt>Метод</dt>
                <dd>{result.spatialReference?.detectionMethod ?? "SOURCE_PRESERVED"}</dd>
              </div>
              <div>
                <dt>Уверенность</dt>
                <dd>{Math.round((result.spatialReference?.confidence ?? 0) * 100)}%</dd>
              </div>
              <div>
                <dt>Порядок осей</dt>
                <dd>{result.spatialReference?.axisOrder ?? "XY_UNRESOLVED"}</dd>
              </div>
              <div>
                <dt>Политика</dt>
                <dd>Исходные XYZ без сдвига</dd>
              </div>
            </dl>
          </section>

          <section
            className={`cad-terrain-quality ${result.terrain.quality.status}`}
            aria-label="Качество построения рельефа"
          >
            <div>
              <p className="eyebrow">КОНТРОЛЬ ГЕОМЕТРИИ</p>
              <h3>
                {result.terrain.quality.status === "ready"
                  ? "Рельеф готов к концептуальной работе"
                  : result.terrain.quality.status === "review"
                    ? "Рельеф требует проверки"
                    : "3D-поверхность не создана"}
              </h3>
              <p>Это проверка полноты геометрии, не подтверждение геодезической точности.</p>
            </div>
            <strong>
              {result.terrain.quality.score}
              <small>/100</small>
            </strong>
            <dl>
              <div>
                <dt>Покрытие</dt>
                <dd>{Math.round(result.terrain.quality.coverageRatio * 100)}%</dd>
              </div>
              <div>
                <dt>Сохранено отметок</dt>
                <dd>{Math.round(result.terrain.quality.retainedSampleRatio * 100)}%</dd>
              </div>
              <div>
                <dt>Удалено перемычек</dt>
                <dd>{result.terrain.quality.rejectedGapTriangleCount.toLocaleString("ru-RU")}</dd>
              </div>
              <div>
                <dt>Независимые участки</dt>
                <dd>{result.terrain.quality.patchCount.toLocaleString("ru-RU")}</dd>
              </div>
            </dl>
          </section>

          {verticalDefaults && (
            <section className="cad-vertical" aria-labelledby="cad-vertical-title">
              <div className="cad-vertical-head">
                <p className="eyebrow">ВЕРТИКАЛЬНАЯ ПЛАНИРОВКА</p>
                <h3 id="cad-vertical-title">Площадка, рабочие отметки и баланс земляных масс</h3>
                <p>
                  Плоская площадка с откосами по TIN съёмки, метод призм по сетке. Вне покрытия
                  объёмы не считаются, расчёт предварительный.
                </p>
              </div>
              <div className="cad-vertical-form">
                <label>
                  <span>X начала, м</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("x")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, x: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Y начала, м</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("y")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, y: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Ширина, м</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("width")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, width: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Глубина, м</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("height")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, height: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Проектная отметка, м</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("elevation")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, elevation: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Откос 1:m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("slope")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, slope: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Шаг сетки, м</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("step")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, step: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Кр разрыхления</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("loosening")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, loosening: event.target.value }))
                    }
                  />
                </label>
                <button type="button" className="cad-secondary-action" onClick={runEarthworks}>
                  <Mountain size={15} /> Рассчитать объёмы
                </button>
              </div>
              {verticalError && (
                <p className="cad-vertical-error" role="alert">
                  <AlertTriangle size={14} /> {verticalError}
                </p>
              )}
              {earthworks && (
                <>
                  <div className="cad-vertical-results" aria-label="Баланс земляных масс">
                    <article>
                      <span>ВЫЕМКА</span>
                      <strong>{formatVolume(earthworks.computed.cutVolume)}</strong>
                      <small>м³</small>
                    </article>
                    <article>
                      <span>НАСЫПЬ</span>
                      <strong>{formatVolume(earthworks.computed.fillVolume)}</strong>
                      <small>м³</small>
                    </article>
                    <article className={earthworks.computed.balance >= 0 ? "fill" : "cut"}>
                      <span>
                        {earthworks.computed.balance >= 0 ? "ЗАВОЗ ГРУНТА" : "ВЫВОЗ ГРУНТА"}
                      </span>
                      <strong>{formatVolume(Math.abs(earthworks.computed.balance))}</strong>
                      <small>м³ · Кр {earthworks.computed.looseningFactor}</small>
                    </article>
                    <article className={earthworks.computed.uncoveredCount ? "warning" : ""}>
                      <span>ВНЕ ПОКРЫТИЯ</span>
                      <strong>{earthworks.computed.uncoveredCount.toLocaleString("ru-RU")}</strong>
                      <small>узлов сетки площадки</small>
                    </article>
                  </div>
                  <div className="cad-vertical-actions">
                    <button
                      type="button"
                      className="cad-secondary-action"
                      onClick={downloadEarthworksXlsx}
                    >
                      <Download size={15} /> Ведомость XLSX
                    </button>
                    <button
                      type="button"
                      className="cad-secondary-action"
                      onClick={downloadEarthworksDxf}
                    >
                      <Download size={15} /> Картограмма DXF
                    </button>
                  </div>
                  {earthworks.computed.uncoveredCount > 0 && (
                    <p className="cad-vertical-note">
                      <AlertTriangle size={14} /> Часть площадки вне покрытия съёмки: объёмы
                      посчитаны только по подтверждённому рельефу и являются неполными.
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {SHOW_AI_PANELS && (
            <section className="cad-object-qa cad-semantics" aria-labelledby="cad-semantics-title">
              <div className="cad-object-qa-head">
                <div>
                  <p className="eyebrow">ПОДПИСИ И ОБОЗНАЧЕНИЯ ЧЕРТЕЖА</p>
                  <h3 id="cad-semantics-title">
                    ИИ читает подписи, программа применяет их к объектам
                  </h3>
                  <p>
                    Подписи, легенда и примечания собраны вместе с их местом на чертеже. Модель
                    меняется только по ним и только с указанием источника.
                  </p>
                </div>
                <button
                  type="button"
                  className="cad-secondary-action"
                  onClick={() => void readDrawingSemantics(result)}
                  disabled={
                    result.semantics?.status === "pending" ||
                    result.groupSemantics?.status === "pending"
                  }
                >
                  {result.semantics?.status === "pending" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  {result.semantics?.dictionary ? "Прочитать заново" : "Прочитать подписи"}
                </button>
              </div>
              <p className={`cad-semantics-status ${result.semantics?.status ?? "idle"}`}>
                {result.semantics?.message ||
                  `Найдено ${(result.texts?.length ?? 0).toLocaleString("ru-RU")} подписей. Разбор идёт на правилах программы — нажмите кнопку, если нужно прочитать подписи.`}
              </p>
              {result.semantics?.dictionary && (
                <>
                  {result.semantics.dictionary.summary && (
                    <p className="cad-semantics-summary">{result.semantics.dictionary.summary}</p>
                  )}
                  <ul className="cad-semantics-list">
                    {result.semantics.dictionary.entries
                      .filter((entry) => entry.kind !== "ignore")
                      .map((entry) => (
                        <li key={entry.label}>
                          <CadObjectPreview
                            kind={entry.kind === "ignore" ? "annotation" : entry.kind}
                            feature={previewSamples.byLabel.get(entry.label)}
                            unitsPerMeter={previewUnitsPerMeter}
                            status={entry.status}
                            title={`«${entry.label}»: как объект выглядит в модели`}
                          />
                          <strong>«{entry.label}»</strong>
                          <span className="kind">
                            {semanticKindLabel(entry.kind)} · {semanticStatusLabels[entry.status]}
                            {entry.floors ? ` · ${entry.floors} эт.` : ""}
                            {entry.heightMeters ? ` · ${entry.heightMeters} м` : ""}
                          </span>
                          <em>
                            {(semanticCounts.get(entry.label) ?? 0).toLocaleString("ru-RU")}{" "}
                            объектов
                          </em>
                          <small>
                            {entry.meaning}
                            {entry.use ? ` — ${entry.use}` : ""}
                          </small>
                          <small className="evidence">
                            Основание: {entry.evidence || "не указано"} · уверенность{" "}
                            {Math.round(entry.confidence * 100)}%
                          </small>
                        </li>
                      ))}
                  </ul>
                  {result.semantics.dictionary.entries.some((entry) => entry.kind === "ignore") && (
                    <p className="cad-semantics-note">
                      {result.semantics.dictionary.entries
                        .filter((entry) => entry.kind === "ignore")
                        .length.toLocaleString("ru-RU")}{" "}
                      подписей отнесены к служебным (площади, номера, отметки) и на модель не
                      влияют.
                    </p>
                  )}
                  {result.semantics.dictionary.notes.length > 0 && (
                    <div className="cad-semantics-notes">
                      <strong>Примечания и указания чертежа</strong>
                      <ul>
                        {result.semantics.dictionary.notes.map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <section className="cad-object-qa cad-semantics" aria-labelledby="cad-road-title">
            <div className="cad-object-qa-head">
              <div>
                <p className="eyebrow">ПРОЕЗЖАЯ ЧАСТЬ</p>
                <h3 id="cad-road-title">Укажите кромки — полотно построит программа</h3>
                <p>
                  Пары линий с дорожной шириной между ними найдены и измерены. Какая из них кромка
                  дороги, а какая граница участка — по чертежу не определить, отметьте нужные.
                  Полотно ляжет строго между ними: разрывы не заполняются.
                </p>
              </div>
              <button
                type="button"
                className="cad-secondary-action"
                onClick={() => buildRoadFromGroups(result, geometryGroups, roadEdgeSelection)}
                disabled={!roadEdgeSelection.length}
              >
                <Route size={15} />
                Построить проезжую часть
              </button>
            </div>
            {stripCandidates(geometryGroups).length ? (
              <ul className="cad-semantics-list">
                {stripCandidates(geometryGroups).map((group) => (
                  <li key={group.id}>
                    <label className="cad-road-edge-option">
                      <input
                        type="checkbox"
                        checked={roadEdgeSelection.includes(group.id)}
                        onChange={(event) =>
                          setRoadEdgeSelection((current) =>
                            event.target.checked
                              ? [...current, group.id]
                              : current.filter((id) => id !== group.id),
                          )
                        }
                      />
                      <strong>{group.layer}</strong>
                      <span className="kind">
                        {cadColorFamilyLabels[group.colorFamily]}
                        {group.colorIndex !== undefined ? ` · ACI ${group.colorIndex}` : ""}
                        {" · "}
                        {group.count.toLocaleString("ru-RU")} линий
                      </span>
                      <small className="evidence">
                        полоса {group.parallel!.medianSpacingMeters.toFixed(1)} м · пусто{" "}
                        {Math.round((group.corridor?.emptyRatio ?? 0) * 100)}% · непрерывно{" "}
                        {Math.round(group.corridor?.longestPairedRunMeters ?? 0)} м
                        {group.corridor && group.corridor.buildingRatio > 0.05
                          ? ` · в полосе стоят дома ${Math.round(group.corridor.buildingRatio * 100)}%`
                          : ""}
                      </small>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cad-semantics-status idle">
                Пар линий с полосой дорожной ширины между ними в чертеже не найдено.
              </p>
            )}
            {result.features.some((feature) => feature.sourceType === ROAD_SURFACE_SOURCE_TYPE) && (
              <p className="cad-semantics-note">
                Построено полотен:{" "}
                {
                  result.features.filter(
                    (feature) => feature.sourceType === ROAD_SURFACE_SOURCE_TYPE,
                  ).length
                }
                . Полотно выведено из пары кромок, а не измерено, поэтому помечено «нужна проверка».
              </p>
            )}
          </section>

          {SHOW_AI_PANELS && (
            <section className="cad-object-qa cad-semantics" aria-labelledby="cad-groups-title">
              <div className="cad-object-qa-head">
                <div>
                  <p className="eyebrow">ГРУППЫ ГЕОМЕТРИИ</p>
                  <h3 id="cad-groups-title">ИИ разбирает, что чем нарисовано, программа строит</h3>
                  <p>
                    Каждая группа «слой × цвет × форма» измеряется: длина цепочек, разрывы, идут ли
                    линии парами. ИИ отвечает на узкий вопрос по этим числам, класс собирается уже с
                    легендой и подписями.
                  </p>
                </div>
                <button
                  type="button"
                  className="cad-secondary-action"
                  onClick={() => void analyzeDrawingGroups(result)}
                  disabled={
                    result.groupSemantics?.status === "pending" ||
                    result.semantics?.status === "pending"
                  }
                >
                  {result.groupSemantics?.status === "pending" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  {result.groupSemantics?.dictionary ? "Разобрать заново" : "Разобрать группы"}
                </button>
              </div>
              <p className={`cad-semantics-status ${result.groupSemantics?.status ?? "idle"}`}>
                {result.groupSemantics?.message ||
                  "Классы и полотно строятся по правилам программы — нажмите кнопку, если нужен разбор групп."}
              </p>
              {result.groupSemantics?.dictionary && (
                <>
                  {result.groupSemantics.dictionary.summary && (
                    <p className="cad-semantics-summary">
                      {result.groupSemantics.dictionary.summary}
                    </p>
                  )}
                  {result.groupSemantics.dictionary.strips.length > 0 && (
                    <div className="cad-semantics-notes">
                      <strong>Что лежит в полосе между парой линий</strong>
                      <ul>
                        {result.groupSemantics.dictionary.strips.map((strip) => (
                          <li key={strip.groupId}>
                            {stripVerdictLabels[strip.verdict]} · уверенность{" "}
                            {Math.round(strip.confidence * 100)}% — {strip.why}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <ul className="cad-semantics-list">
                    {result.groupSemantics.dictionary.decisions.map((decision) => (
                      <li key={decision.groupId}>
                        <strong>{cadKindMeta[decision.kind]?.label ?? decision.kind}</strong>
                        <span className="kind">
                          {decision.role === "road-edge"
                            ? "кромка проезжей части"
                            : decision.role === "building-outline"
                              ? "контур здания"
                              : "—"}
                          {" · "}
                          {semanticStatusLabels[decision.status]}
                        </span>
                        <small className="evidence">
                          Основание: {decision.evidence || "не указано"} · уверенность{" "}
                          {Math.round(decision.confidence * 100)}%
                        </small>
                      </li>
                    ))}
                  </ul>
                  <p className="cad-semantics-note">
                    Решения ИИ по группам помечены статусом «нужна проверка»: класс назначен по
                    замерам чертежа, а не измерен. Уверенные правила по имени слоя ИИ не перебивает.
                  </p>
                </>
              )}
            </section>
          )}

          <section className="cad-object-qa" aria-labelledby="cad-object-qa-title">
            <div className="cad-object-qa-head">
              <div>
                <p className="eyebrow">АВТОМАТИЧЕСКАЯ ОБРАБОТКА ОБЪЕКТОВ</p>
                <h3 id="cad-object-qa-title">Ничего подтверждать по одному не нужно</h3>
                <p>
                  Где высота не записана — берётся безопасная оценка. Без надёжного класса или Z в
                  3D ничего не попадает.
                </p>
              </div>
            </div>
            <div className="cad-qa-summary" aria-label="Результат автоматической обработки">
              <article className="auto">
                <span>В 3D-МОДЕЛИ</span>
                <strong>{modelQaCounts.AUTO.toLocaleString("ru-RU")}</strong>
                <small>подтверждённые поверхности и объекты</small>
              </article>
              <article className="review">
                <span>С ДОПУЩЕНИЕМ</span>
                <strong>{modelQaCounts.REVIEW.toLocaleString("ru-RU")}</strong>
                <small>только распознанные объекты с типовой высотой</small>
              </article>
              <article className="reject">
                <span>НЕ ПОКАЗАНО</span>
                <strong>{modelQaCounts.REJECT.toLocaleString("ru-RU")}</strong>
                <small>2D-линии, дубли и объекты вне TIN</small>
              </article>
            </div>
            <div className="cad-evidence-channels" aria-label="Доступные каналы доказательств">
              <strong>3D собран в истинном масштабе 1:1</strong>
              <span>Отрицательные и удалённые 2D-копии не входят в модель и DAE.</span>
              <span>Подземные сети без измеренной глубины сохранены только в 2D-протоколе.</span>
            </div>
            <button
              type="button"
              className="cad-qa-details-toggle"
              onClick={() => setShowQaDetails((value) => !value)}
              aria-expanded={showQaDetails}
            >
              {showQaDetails ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              {showQaDetails
                ? "Скрыть техническую сводку"
                : "Показать техническую сводку по классам"}
            </button>
            {showQaDetails && (
              <div className="cad-qa-class-list">
                {qaGroups.map((group) => (
                  <article key={group.kind}>
                    <i
                      style={{
                        background: `#${cadKindMeta[group.kind].color.toString(16).padStart(6, "0")}`,
                      }}
                    />
                    <CadObjectPreview
                      kind={group.kind}
                      feature={previewSamples.byKind.get(group.kind)}
                      unitsPerMeter={previewUnitsPerMeter}
                      width={48}
                      height={38}
                    />
                    <div>
                      <strong>{cadKindMeta[group.kind].label}</strong>
                      <small>
                        {(group.AUTO + group.REVIEW + group.REJECT).toLocaleString("ru-RU")}{" "}
                        объектов
                      </small>
                    </div>
                    <dl>
                      <div>
                        <dt>Готово</dt>
                        <dd>{group.AUTO.toLocaleString("ru-RU")}</dd>
                      </div>
                      <div>
                        <dt>С оценкой</dt>
                        <dd>{group.REVIEW.toLocaleString("ru-RU")}</dd>
                      </div>
                      <div>
                        <dt>Не использовано</dt>
                        <dd>{group.REJECT.toLocaleString("ru-RU")}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="cad-result-grid">
            <div className="cad-scene-panel">
              <div className="cad-scene-toolbar">
                <div className="cad-segmented" aria-label="Режим вида">
                  <button
                    className={viewMode === "2d" ? "selected" : ""}
                    onClick={() => setViewMode("2d")}
                    aria-pressed={viewMode === "2d"}
                  >
                    Чертёж 2D
                  </button>
                  <button
                    className={viewMode === "3d" ? "selected" : ""}
                    onClick={() => setViewMode("3d")}
                    disabled={result.terrain.method === "none"}
                    aria-pressed={viewMode === "3d"}
                  >
                    Модель 3D
                  </button>
                </div>
                <div className="cad-segmented" aria-label="Тема отображения">
                  <button
                    className={displayTheme === "semantic" ? "selected" : ""}
                    onClick={() => setDisplayTheme("semantic")}
                    aria-pressed={displayTheme === "semantic"}
                  >
                    Классы
                  </button>
                  <button
                    className={displayTheme === "qa" ? "selected" : ""}
                    onClick={() => setDisplayTheme("qa")}
                    aria-pressed={displayTheme === "qa"}
                  >
                    Контроль
                  </button>
                </div>
                <span>
                  <Rotate3d size={14} />{" "}
                  {viewMode === "2d"
                    ? "ЛКМ — перемещение · колесо — масштаб"
                    : "ЛКМ — вращение · колесо — масштаб"}
                </span>
                <button
                  className={`cad-icon-control ${wireframe ? "active" : ""}`}
                  onClick={() => setWireframe((value) => !value)}
                  aria-label="Переключить каркас рельефа"
                  disabled={viewMode === "2d"}
                >
                  <ScanLine size={16} />
                </button>
              </div>
              <div className="cad-scene">
                {viewMode === "2d" && result.drawing && (
                  <div
                    className="cad-drawing-source"
                    role="group"
                    aria-label="Что показывать на чертеже"
                  >
                    <button
                      type="button"
                      className={drawingSource === "source" ? "selected" : ""}
                      onClick={() => setDrawingSource("source")}
                      aria-pressed={drawingSource === "source"}
                    >
                      Исходный DWG
                    </button>
                    <button
                      type="button"
                      className={drawingSource === "classes" ? "selected" : ""}
                      onClick={() => setDrawingSource("classes")}
                      aria-pressed={drawingSource === "classes"}
                    >
                      Распознанные классы
                    </button>
                  </div>
                )}
                {viewMode === "2d" && drawingSource === "source" && result.drawing ? (
                  <CadDrawingCanvas
                    drawing={result.drawing}
                    focus={result.bounds}
                    fileName={result.fileName}
                  />
                ) : (
                  <CadViewport
                    result={result}
                    visibleKinds={visibleKinds}
                    viewMode={viewMode}
                    wireframe={wireframe}
                    displayTheme={displayTheme}
                  />
                )}
                <div className="cad-scene-badge">
                  <span />{" "}
                  {viewMode === "3d"
                    ? `${result.terrain.trustedSampleCount ? "Поверхность по реальным Z" : "Поверхность по числовым отметкам DWG"} · ${(result.terrain.triangles.length / 3).toLocaleString("ru-RU")} треугольников · ${unresolvedCount.toLocaleString("ru-RU")} объектов вне`
                    : "Исходный план DWG · все распознанные слои"}
                </div>
                {viewMode === "3d" && result.terrain.method !== "none" && (
                  <div className="cad-terrain-legend" aria-label="Цветовая шкала высот рельефа">
                    <span>ВЫСОТА</span>
                    <i />
                    <small>{formatElevation(result.terrain.minElevation, result.unitLabel)}</small>
                    <small>{formatElevation(result.terrain.maxElevation, result.unitLabel)}</small>
                  </div>
                )}
                <div className="cad-scene-coordinates">
                  X {formatCoordinate(result.bounds.minX)}…{formatCoordinate(result.bounds.maxX)}
                  <br />Y {formatCoordinate(result.bounds.minY)}…
                  {formatCoordinate(result.bounds.maxY)}
                </div>
              </div>
            </div>

            <aside className="cad-inspector" aria-label="Настройки цифровой площадки">
              <div className="cad-inspector-head">
                <div>
                  <p className="eyebrow">МОДЕЛЬ</p>
                  <h3>Слои и объекты</h3>
                </div>
                <button className="cad-replace" onClick={() => inputRef.current?.click()}>
                  <FileUp size={14} /> Заменить
                </button>
              </div>

              <div className="cad-scale-lock">
                <LockKeyhole size={16} />
                <span>
                  <strong>Масштаб по высоте 1:1</strong>
                  <small>Без автоматического усиления и визуальных искажений</small>
                </span>
              </div>

              <div className="cad-kind-list">
                {cadKinds
                  .filter((kind) => modelCounts[kind] > 0)
                  .map((kind) => (
                    <label key={kind}>
                      <input
                        type="checkbox"
                        checked={visibleKinds[kind]}
                        onChange={() =>
                          setVisibleKinds((current) => ({ ...current, [kind]: !current[kind] }))
                        }
                      />
                      <span className="cad-checkbox">
                        <Check size={11} />
                      </span>
                      <CadObjectPreview
                        kind={kind}
                        feature={previewSamples.byKind.get(kind)}
                        unitsPerMeter={previewUnitsPerMeter}
                        width={48}
                        height={38}
                      />
                      <span>
                        <strong>{cadKindMeta[kind].short}</strong>
                        <small>
                          {kind === "terrain"
                            ? viewMode === "3d"
                              ? "1 подтверждённая поверхность"
                              : `${result.features.filter((feature) => feature.kind === "terrain").length.toLocaleString("ru-RU")} горизонталей и отметок`
                            : `${modelCounts[kind].toLocaleString("ru-RU")} объектов`}
                        </small>
                      </span>
                      <Eye size={14} />
                    </label>
                  ))}
              </div>
            </aside>
          </div>

          {result.warnings.length > 0 && (
            <div className="cad-warning-list">
              {result.warnings.map((warning) => (
                <p key={warning}>
                  <AlertTriangle size={15} /> {warning}
                </p>
              ))}
            </div>
          )}

          <div className="cad-layer-panel">
            <div className="cad-layer-heading">
              <div>
                <p className="eyebrow">ПРОТОКОЛ КЛАССИФИКАЦИИ</p>
                <h3>Как система поняла слои</h3>
                <p>
                  Классы назначены автоматически. Спорные строки оставлены ниже только для
                  дополнительного контроля.
                </p>
              </div>
              <button onClick={() => setShowAllLayers((value) => !value)}>
                {showAllLayers ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                {showAllLayers ? "Свернуть" : `Все ${result.layers.length} слоёв`}
              </button>
            </div>
            <div className="cad-layer-table" role="table" aria-label="Классификация слоёв DWG">
              <div className="cad-layer-row head" role="row">
                <span aria-hidden="true" />
                <span>Слой DWG</span>
                <span>Сущности</span>
                <span>Назначение</span>
                <span>Основание</span>
              </div>
              {(showAllLayers ? result.layers : result.layers.slice(0, 10)).map((layer) => (
                <div
                  className={`cad-layer-row ${layer.kind === "unknown" ? "needs-review" : ""}`}
                  role="row"
                  key={layer.name}
                >
                  <CadObjectPreview
                    kind={layer.kind}
                    feature={previewSamples.byLayer.get(layer.name)}
                    unitsPerMeter={previewUnitsPerMeter}
                    width={48}
                    height={38}
                    title={`Слой ${layer.name}: образец объекта`}
                  />
                  <strong title={layer.name}>{layer.name}</strong>
                  <span>{layer.entityCount.toLocaleString("ru-RU")}</span>
                  <select
                    value={layer.kind}
                    onChange={(event) => changeLayerKind(layer.name, event.target.value as CadKind)}
                    aria-label={`Назначение слоя ${layer.name}`}
                  >
                    {cadKinds.map((kind) => (
                      <option value={kind} key={kind}>
                        {cadKindMeta[kind].label}
                      </option>
                    ))}
                  </select>
                  <small>
                    {Math.round(layer.confidence * 100)}% · {layer.reason}
                  </small>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
