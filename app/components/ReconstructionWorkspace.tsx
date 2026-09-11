"use client";
import { downloadBlob as download } from "../lib/browser/download";
import { readAnalysisResponse } from "../lib/ai/readResponse";

import {
  AlertTriangle,
  Box,
  Check,
  Download,
  FileImage,
  FileText,
  FileUp,
  LoaderCircle,
  RefreshCw,
  Ruler,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createArchiveId, saveArchiveEntry, type ReconstructionArchiveEntry } from "../lib/archive";
import { exportReconstructionDae, exportReconstructionGlb } from "../lib/reconstruction/modelScene";
import { prepareDrawing } from "../lib/reconstruction/prepareDrawing";
import type {
  PreparedDrawing,
  ReconstructionHints,
  ReconstructionModel,
  ReconstructionPart,
  ReconstructionUnit,
} from "../lib/reconstruction/types";
import ReconstructionViewport from "./ReconstructionViewport";

const initialHints: ReconstructionHints = { allowInferredGeometry: true };

const unitLabels: Record<ReconstructionUnit, string> = {
  mm: "миллиметры",
  cm: "сантиметры",
  m: "метры",
  in: "дюймы",
};

function safeFileStem(name: string) {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zа-яё0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "aedexa-model"
  );
}

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type ReconstructionEvent = {
  stage?: string;
  percent?: number;
  done?: boolean;
  model?: ReconstructionModel;
  error?: string;
};

function compactNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
}

function partGeometry(part: ReconstructionPart, unit: ReconstructionUnit) {
  if (part.kind === "box")
    return `${compactNumber(part.size.x)} × ${compactNumber(part.size.y)} × ${compactNumber(part.size.z)} ${unit}`;
  if (part.kind === "cylinder")
    return `Ø ${compactNumber(part.radius * 2)} × ${compactNumber(part.height)} ${unit}`;
  if (part.kind === "extrusion")
    return `${part.profile.length} точек · H ${compactNumber(part.height)} ${unit}`;
  if (part.kind === "revolution") return `${part.profile.length} точек профиля вращения`;
  return `${part.faces.length.toLocaleString("ru-RU")} граней`;
}

function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

type ReconstructionWorkspaceProps = {
  archivedEntry?: ReconstructionArchiveEntry;
};

export default function ReconstructionWorkspace({ archivedEntry }: ReconstructionWorkspaceProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const archiveIdRef = useRef<string | undefined>(archivedEntry?.id);
  const archiveCreatedAtRef = useRef<string | undefined>(archivedEntry?.createdAt);
  const sourceFileRef = useRef<File | undefined>(archivedEntry?.sourceFile);
  const [hasSourceFile, setHasSourceFile] = useState(() => Boolean(archivedEntry?.sourceFile));
  const [prepared, setPrepared] = useState<PreparedDrawing | null>(null);
  const [model, setModel] = useState<ReconstructionModel | null>(
    () => archivedEntry?.payload ?? null,
  );
  const [hints, setHints] = useState<ReconstructionHints>(
    () => archivedEntry?.hints ?? initialHints,
  );
  const [processing, setProcessing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState("");
  /** Начало запроса к модели */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const [dragging, setDragging] = useState(false);

  const saveReconstructionArchive = (nextModel: ReconstructionModel) => {
    const archiveId = archiveIdRef.current;
    const createdAt = archiveCreatedAtRef.current;
    if (!archiveId || !createdAt) return;
    void saveArchiveEntry({
      schema: 1,
      id: archiveId,
      kind: "reconstruction",
      title: nextModel.title || nextModel.sourceName.replace(/\.[^.]+$/, "") || "3D-модель",
      sourceName: nextModel.sourceName,
      summary: `${nextModel.parts.length} деталей · ${Math.round(nextModel.overallConfidence * 100)}% уверенности · ${nextModel.summary}`,
      status:
        nextModel.status === "ready"
          ? "ready"
          : nextModel.status === "unsupported"
            ? "blocked"
            : "review",
      createdAt,
      updatedAt: new Date().toISOString(),
      sourceFile: sourceFileRef.current,
      hints,
      payload: nextModel,
    }).catch((reason) =>
      setError(
        reason instanceof Error ? reason.message : "Не удалось сохранить 3D-результат в архив.",
      ),
    );
  };

  const analyzeWithAi = async (source: PreparedDrawing) => {
    setProcessing(true);
    setError("");
    setStartedAt(Date.now());
    setProgress(14);
    setProgressLabel(
      hints.allowInferredGeometry === false
        ? "ИИ читает чертёж, строит 3D и проверяет соответствие исходным видам"
        : "ИИ читает лист, восстанавливает 3D и повторно сопоставляет модель с чертежом",
    );
    try {
      const response = await fetch("/api/reconstruct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceName: source.name,
          dataUrl: source.apiDataUrl,
          dataUrls: source.apiDataUrls,
          context: source.context,
          hints,
        }),
      });
      const payload = await readAnalysisResponse<ReconstructionEvent>(response, (event) => {
        if (typeof event.percent === "number") setProgress(event.percent);
        if (event.stage) setProgressLabel(event.stage);
      });
      if (!response.ok || !payload.model)
        throw new Error(payload.error || "Анализ не вернул проверяемую геометрию.");
      setProgress(94);
      setProgressLabel(
        hints.allowInferredGeometry === false
          ? "Инженерная перепроверка завершена"
          : "3D‑черновик с AI‑допущениями готов",
      );
      setModel(payload.model);
      saveReconstructionArchive(payload.model);
      setProgress(100);
    } catch (caught) {
      setModel(null);
      setError(caught instanceof Error ? caught.message : "Не удалось проанализировать чертёж.");
    } finally {
      setProcessing(false);
      setStartedAt(null);
    }
  };

  const loadFile = async (file: File, preserveArchiveEntry = false) => {
    setProcessing(true);
    setPrepared(null);
    setModel(null);
    setError("");
    setProgress(12);
    setProgressLabel("Проверяем формат и размер файла");
    sourceFileRef.current = file;
    setHasSourceFile(true);
    if (!preserveArchiveEntry) {
      archiveIdRef.current = createArchiveId("reconstruction");
      archiveCreatedAtRef.current = new Date().toISOString();
    }
    try {
      setProgress(28);
      setProgressLabel(
        file.name.toLowerCase().endsWith(".dwg") || file.name.toLowerCase().endsWith(".dxf")
          ? "Читаем CAD-сущности, размеры и координаты"
          : "Готовим чертёж без потери мелких надписей",
      );
      const source = await prepareDrawing(file);
      setPrepared(source);
      if (source.exactModel) {
        setModel(source.exactModel);
        saveReconstructionArchive(source.exactModel);
        setProgress(100);
        setProgressLabel("Точная CAD-геометрия готова");
        setProcessing(false);
        return;
      }
      setProcessing(false);
      await analyzeWithAi(source);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось открыть файл.");
      setProcessing(false);
    }
  };

  const clear = () => {
    setPrepared(null);
    setModel(null);
    setError("");
    setProgress(0);
    setProgressLabel("");
    archiveIdRef.current = undefined;
    archiveCreatedAtRef.current = undefined;
    sourceFileRef.current = undefined;
    setHasSourceFile(false);
  };

  const rebuild = () => {
    if (prepared) {
      void analyzeWithAi(prepared);
      return;
    }
    if (sourceFileRef.current) {
      void loadFile(sourceFileRef.current, true);
      return;
    }
    inputRef.current?.click();
  };

  const exportGlb = async () => {
    if (!model?.parts.length) return;
    setExporting(true);
    setError("");
    try {
      download(
        `${safeFileStem(model.sourceName)}${model.canExport ? "" : "-draft"}.glb`,
        await exportReconstructionGlb(model),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось экспортировать GLB.");
    } finally {
      setExporting(false);
    }
  };

  const exportDae = () => {
    if (!model?.parts.length) return;
    setExporting(true);
    setError("");
    try {
      download(
        `${safeFileStem(model.sourceName)}-sketchup${model.canExport ? "" : "-draft"}.dae`,
        exportReconstructionDae(model),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Не удалось экспортировать модель для SketchUp.",
      );
    } finally {
      setExporting(false);
    }
  };

  const exportAudit = () => {
    if (!model) return;
    download(
      `${safeFileStem(model.sourceName)}-audit.json`,
      new Blob([JSON.stringify(model, null, 2)], { type: "application/json" }),
    );
  };

  const confidence = Math.round((model?.overallConfidence || 0) * 100);
  const statusLabel =
    model?.status === "ready"
      ? "Готово к экспорту"
      : model?.status === "unsupported"
        ? "Формат чертежа не распознан"
        : model?.parts.length
          ? "3D‑черновик готов"
          : "Нужны исходные размеры";

  return (
    <section className="reconstruction-page" id="placement-workspace">
      <div className="reconstruction-hero">
        <div>
          <p className="placement-eyebrow">ДОКАЗАТЕЛЬНАЯ РЕКОНСТРУКЦИЯ</p>
          <h1>Из полного 2D‑чертежа — в проверяемую 3D‑модель</h1>
          <p>
            DWG, SVG или изображение. AEDEXA сопоставляет виды и размеры, а недостающую геометрию
            восстанавливает как явно помеченное инженерное AI‑допущение.
          </p>
        </div>
        <div className="reconstruction-principle">
          <ShieldCheck size={19} />
          <div>
            <strong>Контролируемые AI‑допущения</strong>
            <small>ИИ достраивает 3D, но не выдаёт предположение за точный размер.</small>
          </div>
        </div>
      </div>

      {processing && !prepared && (
        <div className="placement-progress reconstruction-progress" role="status">
          <LoaderCircle className="spin" size={18} />
          <span>{progressLabel}</span>
          <div>
            <i style={{ width: `${progress}%` }} />
          </div>
          <strong>{progress}%</strong>
        </div>
      )}
      {error && (
        <div className="placement-error reconstruction-error" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Закрыть ошибку">
            <X size={15} />
          </button>
        </div>
      )}

      <div className="reconstruction-grid">
        <div className="reconstruction-main">
          <header className="reconstruction-panel-head">
            <div>
              <p className="placement-eyebrow">
                {model
                  ? "3D‑РЕЗУЛЬТАТ"
                  : processing && prepared
                    ? "ПОСТРОЕНИЕ 3D"
                    : prepared
                      ? "ИСХОДНЫЙ ЛИСТ"
                      : "ИСХОДНЫЙ ФАЙЛ"}
              </p>
              <h2>{model?.title || prepared?.name || "Новый объект"}</h2>
            </div>
            {prepared ? (
              <button type="button" className="reconstruction-clear" onClick={clear}>
                <X size={15} /> Убрать файл
              </button>
            ) : (
              model && (
                <button
                  type="button"
                  className="reconstruction-clear"
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload size={15} /> Заменить исходник
                </button>
              )
            )}
          </header>

          {model ? (
            <ReconstructionViewport model={model} />
          ) : !prepared ? (
            <button
              type="button"
              className={`reconstruction-dropzone ${dragging ? "dragging" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) void loadFile(file);
              }}
              disabled={processing}
            >
              <span className="reconstruction-drop-icon">
                <FileUp size={30} />
              </span>
              <span className="placement-eyebrow">ШАГ 01</span>
              <strong>Перетащите полный чертёж объекта</strong>
              <small>
                Лучший результат дают листы с главным видом, видом сверху/сбоку и нанесёнными
                размерами.
              </small>
              <span className="placement-upload-action">
                <Upload size={17} /> Выбрать DWG или изображение
              </span>
              <span className="reconstruction-format-row">
                <b>CAD до 80 МБ</b>
                <b>Изображение до 15 МБ</b>
                <b>PNG · JPEG · WEBP · SVG</b>
              </span>
            </button>
          ) : processing ? (
            <div className="reconstruction-building-state" role="status" aria-live="polite">
              <span className="reconstruction-building-icon" aria-hidden="true">
                <Box size={36} />
              </span>
              <p className="placement-eyebrow">РАБОЧЕЕ ОКНО 3D</p>
              <strong>
                <LoaderCircle className="spin" size={19} aria-hidden="true" /> Модель строится в
                этом окне
              </strong>
              <p>{progressLabel}</p>
              <div
                className="reconstruction-building-progress"
                role="progressbar"
                aria-label="Построение 3D-модели"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <i style={{ width: `${progress}%` }} />
              </div>
              <small>
                {progress}% · {formatElapsed(elapsed)} · обычно 3–6 минут на открытой модели ·
                готовый объект появится здесь автоматически
              </small>
            </div>
          ) : (
            <div className="reconstruction-source-preview">
              {prepared.previewDataUrl ? (
                <Image
                  src={prepared.previewDataUrl}
                  alt={`Подготовленный 2D-чертёж ${prepared.name}`}
                  fill
                  sizes="(max-width: 1120px) 100vw, calc(100vw - 430px)"
                  unoptimized
                />
              ) : (
                <div className="reconstruction-pdf-placeholder">
                  <FileText size={42} />
                  <strong>{prepared.name}</strong>
                  <small>Превью исходника не сохранено.</small>
                </div>
              )}
            </div>
          )}

          {model && (
            <footer className="reconstruction-model-footer">
              <span>
                <i className={`reconstruction-status-dot ${model.status}`} />
                {statusLabel}
              </span>
              <span>{model.parts.length} деталей</span>
              <span>{unitLabels[model.unit]}</span>
              <span>
                {model.method === "cad_exact"
                  ? "Прямая CAD-геометрия"
                  : model.method === "cad_parametric"
                    ? "Параметрическая CAD-сборка"
                    : model.method === "ai_agent"
                      ? "Облачный ИИ-агент + CAD-инструменты"
                      : "Облачный ИИ + инженерная перепроверка"}
              </span>
            </footer>
          )}
        </div>

        <aside className="reconstruction-inspector">
          <section className="reconstruction-card">
            <div className="inspector-heading">
              <div>
                <p className="placement-eyebrow">ТОЧНОСТЬ И МАСШТАБ</p>
                <h2>Подтверждённые размеры</h2>
              </div>
              <Ruler size={18} />
            </div>
            <p>
              Заполняйте только то, что известно точно. Эти значения имеют приоритет над
              распознаванием.
            </p>
            <label className="reconstruction-field full">
              <span>Неизвестные размеры</span>
              <select
                value={hints.allowInferredGeometry === false ? "strict" : "assisted"}
                onChange={(event) =>
                  setHints({ ...hints, allowInferredGeometry: event.target.value === "assisted" })
                }
              >
                <option value="assisted">ИИ восстанавливает сам</option>
                <option value="strict">Только доказанные размеры</option>
              </select>
            </label>
            <label className="reconstruction-field full">
              <span>Единицы чертежа</span>
              <select
                value={hints.unit ?? ""}
                onChange={(event) =>
                  setHints({
                    ...hints,
                    unit: event.target.value
                      ? (event.target.value as ReconstructionUnit)
                      : undefined,
                  })
                }
              >
                <option value="">Определить по чертежу</option>
                {Object.entries(unitLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="reconstruction-dimensions">
              <label className="reconstruction-field">
                <span>Ширина X</span>
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  value={hints.width ?? ""}
                  onChange={(event) =>
                    setHints({ ...hints, width: optionalNumber(event.target.value) })
                  }
                  placeholder="неизвестно"
                />
              </label>
              <label className="reconstruction-field">
                <span>Высота Y</span>
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  value={hints.height ?? ""}
                  onChange={(event) =>
                    setHints({ ...hints, height: optionalNumber(event.target.value) })
                  }
                  placeholder="неизвестно"
                />
              </label>
              <label className="reconstruction-field">
                <span>Глубина Z</span>
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  value={hints.depth ?? ""}
                  onChange={(event) =>
                    setHints({ ...hints, depth: optionalNumber(event.target.value) })
                  }
                  placeholder="неизвестно"
                />
              </label>
            </div>
            <label className="reconstruction-field full">
              <span>Примечание к видам</span>
              <textarea
                rows={3}
                maxLength={800}
                value={hints.notes ?? ""}
                onChange={(event) => setHints({ ...hints, notes: event.target.value })}
                placeholder="Например: слева главный вид, справа разрез A–A"
              />
            </label>
            {(prepared || hasSourceFile) &&
              (!model || model.method !== "cad_exact" || model.status !== "ready") && (
                <button
                  type="button"
                  className="placement-button primary wide"
                  disabled={processing}
                  onClick={rebuild}
                >
                  {processing ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <RefreshCw size={17} />
                  )}{" "}
                  {model ? "Перестроить с уточнениями" : "Запустить анализ"}
                </button>
              )}
          </section>

          {!model ? (
            <section className="reconstruction-card reconstruction-pipeline">
              <p className="placement-eyebrow">КОНВЕЙЕР</p>
              <h2>Что система проверяет</h2>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <strong>Формат и векторы</strong>
                    <small>CAD читается как сущности, снимки — с максимальной детализацией.</small>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <strong>Виды и размеры</strong>
                    <small>Сопоставляются фасад, план, разрезы, оси и размерные цепочки.</small>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <strong>Параметрическая геометрия</strong>
                    <small>
                      ИИ выбирает наиболее вероятную конструкцию по видам, симметрии и размерным
                      цепочкам.
                    </small>
                  </div>
                </li>
                <li>
                  <span>04</span>
                  <div>
                    <strong>Контроль допущений</strong>
                    <small>
                      Каждый восстановленный размер помечается и остаётся черновым до подтверждения.
                    </small>
                  </div>
                </li>
              </ol>
            </section>
          ) : (
            <>
              <section className={`reconstruction-card reconstruction-verdict ${model.status}`}>
                <div className="reconstruction-score">
                  <span>{confidence}%</span>
                  <small>общая уверенность</small>
                </div>
                <div>
                  <p className="placement-eyebrow">РЕЗУЛЬТАТ ПРОВЕРКИ</p>
                  <h2>{statusLabel}</h2>
                  <p>{model.summary}</p>
                </div>
              </section>

              {model.analysis && (
                <section className="reconstruction-card reconstruction-ai-audit">
                  <div className="inspector-heading">
                    <div>
                      <p className="placement-eyebrow">AI‑АНАЛИЗ ЧЕРТЕЖА</p>
                      <h2>Как ИИ понял лист</h2>
                    </div>
                    <ShieldCheck size={18} />
                  </div>
                  <p>{model.analysis.summary}</p>
                  <div className="reconstruction-audit-status">
                    <strong>
                      {model.analysis.sufficientFor3d
                        ? "Данных достаточно для 3D"
                        : model.parts.length
                          ? "3D построен с проверяемыми допущениями"
                          : "Нужны дополнительные данные"}
                    </strong>
                    <span>{Math.round(model.analysis.overallConfidence * 100)}% уверенности</span>
                  </div>
                  <div className="reconstruction-audit-tags">
                    {model.analysis.detectedViews.map((view) => (
                      <span key={view}>{view}</span>
                    ))}
                    <span>
                      {model.analysis.unit === "unknown"
                        ? "Единицы не определены"
                        : `Единицы: ${model.analysis.unit}`}
                    </span>
                  </div>
                  {model.analysis.conclusions.length > 0 && (
                    <div className="reconstruction-conclusions">
                      {model.analysis.conclusions.slice(0, 8).map((conclusion) => (
                        <article key={conclusion.id}>
                          <span>{Math.round(conclusion.confidence * 100)}%</span>
                          <p>{conclusion.statement}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {model.agentTrace && (
                <section className="reconstruction-card reconstruction-ai-audit">
                  <div className="inspector-heading">
                    <div>
                      <p className="placement-eyebrow">ПРОТОКОЛ ИИ‑АГЕНТА</p>
                      <h2>Что программа сделала сама</h2>
                    </div>
                    <ShieldCheck size={18} />
                  </div>
                  <p>
                    Это фактические серверные вызовы текущего запуска, а не описание заранее
                    подготовленной модели.
                  </p>
                  <div className="reconstruction-audit-status">
                    <strong>
                      {model.agentTrace.completed
                        ? "ИИ проверил и принял 3D"
                        : model.parts.length
                          ? "ИИ нашёл расхождения — показан черновик"
                          : "ИИ передал модель на универсальную реконструкцию"}
                    </strong>
                    <span>ИИ · {model.agentTrace.model}</span>
                  </div>
                  <div className="reconstruction-audit-tags">
                    <span>
                      {model.agentTrace.llmInvoked
                        ? "LLM действительно вызвана"
                        : "LLM не вызывалась"}
                    </span>
                    <span>
                      {model.agentTrace.solver === "none"
                        ? "Без специального решателя"
                        : `Решатель: ${model.agentTrace.solver}`}
                    </span>
                    <span>
                      {model.agentTrace.previewCompared
                        ? "Проекции 3D просмотрены ИИ"
                        : "Проекции ещё не проверены"}
                    </span>
                    {model.agentTrace.previewCompared && (
                      <span>
                        Сверка видов: {Math.round((model.agentTrace.reviewConfidence ?? 0) * 100)}%
                      </span>
                    )}
                    {model.agentTrace.previewCompared && (
                      <span>
                        Проверено узлов: {model.agentTrace.verifiedElements?.length ?? 0}/
                        {model.agentTrace.solver === "building_massing" ? 11 : 9}
                      </span>
                    )}
                  </div>
                  <div className="reconstruction-conclusions">
                    {model.agentTrace.steps.map((step) => (
                      <article key={`${step.sequence}-${step.action}`}>
                        <span>{String(step.sequence).padStart(2, "0")}</span>
                        <p>
                          <strong>{step.action}</strong>
                          <br />
                          {step.reason}
                        </p>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {model.unresolved.length > 0 && (
                <section className="reconstruction-card">
                  <div className="inspector-heading">
                    <div>
                      <p className="placement-eyebrow">НЕОПРЕДЕЛЁННОСТИ</p>
                      <h2>Что нельзя доказать</h2>
                    </div>
                    <AlertTriangle size={18} />
                  </div>
                  <div className="reconstruction-issues">
                    {model.unresolved.map((issue) => (
                      <article key={issue.id} className={issue.severity}>
                        <strong>{issue.label}</strong>
                        <p>{issue.reason}</p>
                        <small>{issue.requiredFromUser}</small>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              <section className="reconstruction-card">
                <div className="inspector-heading">
                  <div>
                    <p className="placement-eyebrow">СОСТАВ МОДЕЛИ</p>
                    <h2>Детали и основания</h2>
                  </div>
                  <Box size={18} />
                </div>
                <div className="reconstruction-parts">
                  {model.parts.map((part) => (
                    <article key={part.id}>
                      <span>{Math.round(part.confidence * 100)}%</span>
                      <div>
                        <strong>{part.name}</strong>
                        <small>{partGeometry(part, model.unit)}</small>
                        <p>{part.evidence[0] || "Основание не указано"}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section
                className={`reconstruction-card reconstruction-export ${model.canExport ? "" : "draft"}`}
              >
                <div className="inspector-heading">
                  <div>
                    <p className="placement-eyebrow">ЭКСПОРТ</p>
                    <h2>
                      {model.canExport
                        ? "Передача модели"
                        : model.parts.length
                          ? "Черновик для проверки"
                          : "Геометрия не построена"}
                    </h2>
                  </div>
                  {model.canExport ? <Check size={18} /> : <AlertTriangle size={18} />}
                </div>
                <p>
                  {model.canExport
                    ? "COLLADA DAE экспортируется в метрах и напрямую импортируется в SketchUp с названиями деталей и материалами."
                    : model.parts.length
                      ? "Можно скачать и проверить построенную геометрию. Файл помечен как draft: размеры не подтверждены, использовать его для производства нельзя."
                      : "ИИ не построил ни одной детали, поэтому создавать пустой 3D-файл нельзя. Скачайте аудит и добавьте недостающие виды или размеры."}
                </p>
                <button
                  type="button"
                  className="placement-button primary wide"
                  disabled={!model.parts.length || exporting}
                  onClick={exportDae}
                >
                  {exporting ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{" "}
                  {model.canExport
                    ? "Скачать для SketchUp (.DAE)"
                    : "Скачать черновик для SketchUp"}
                </button>
                <button
                  type="button"
                  className="placement-button secondary wide"
                  disabled={!model.parts.length || exporting}
                  onClick={() => void exportGlb()}
                >
                  <Download size={17} /> {model.canExport ? "Скачать GLB" : "Скачать черновик GLB"}
                </button>
                <button
                  type="button"
                  className="placement-button secondary wide"
                  onClick={exportAudit}
                >
                  <FileImage size={17} /> Скачать аудит JSON
                </button>
              </section>
            </>
          )}
        </aside>
      </div>

      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".dwg,.svg,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void loadFile(file);
          event.target.value = "";
        }}
      />
      <footer className="placement-disclaimer reconstruction-disclaimer">
        <ShieldCheck size={17} />
        <p>
          <strong>Граница точности:</strong> AI‑режим создаёт пригодный для просмотра и SketchUp
          черновик даже при неполном листе. Для производства всё равно нужны подтверждённые виды,
          размеры и проверка конструктора.
        </p>
      </footer>
    </section>
  );
}
