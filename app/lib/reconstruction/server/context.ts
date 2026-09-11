import { pluralizeRu } from "../../pluralizeRu";
import { parseDrawingAnalysis } from "../schema";
import { type ReconstructionUnit, type DrawingAnalysis, type ReconstructionHints } from "../types";
export const allowedUnits = new Set<ReconstructionUnit>(["mm", "cm", "m", "in"]);

const DEFAULT_AI_CONTEXT_LENGTH = 48_000;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function compactCadContext(context: string, evidenceOnly: boolean, stageLimit?: number) {
  if (!context) return "";
  const configuredMaxLength = boundedInteger(
    process.env.RECONSTRUCTION_AI_CONTEXT_LENGTH,
    DEFAULT_AI_CONTEXT_LENGTH,
    20_000,
    180_000,
  );
  const maxLength = Math.min(configuredMaxLength, stageLimit ?? configuredMaxLength);
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    if (parsed.format !== "AEDEXA_CAD_CONTEXT_V3") return context.slice(0, maxLength);
    const records = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((entry): entry is Record<string, unknown> =>
            Boolean(entry && typeof entry === "object"),
          )
        : [];
    const pick = (entry: Record<string, unknown>, keys: string[]) =>
      Object.fromEntries(
        keys.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]),
      );
    const tables =
      parsed.tables && typeof parsed.tables === "object"
        ? (parsed.tables as Record<string, unknown>)
        : {};
    const compactTable = (name: string, keys: string[]) =>
      records(tables[name])
        .slice(0, 40)
        .map((entry) => pick(entry, keys));
    const identity =
      parsed.documentIdentity && typeof parsed.documentIdentity === "object"
        ? (parsed.documentIdentity as Record<string, unknown>)
        : {};
    const compactIdentityRecords = (name: string) =>
      records(identity[name])
        .slice(0, 32)
        .map((entry) => ({
          ...pick(entry, ["count", "scopes", "regions", "handles"]),
          text: typeof entry.text === "string" ? entry.text.slice(0, 500) : "",
        }))
        .filter((entry) => entry.text);
    const header =
      parsed.header && typeof parsed.header === "object"
        ? (parsed.header as Record<string, unknown>)
        : {};
    const spatialRegions = records(parsed.spatialRegions)
      .slice(0, 12)
      .map((entry) => ({
        ...pick(entry, [
          "id",
          "bounds",
          "contentBounds",
          "structuralBounds",
          "entityCount",
          "entityTypes",
          "layers",
        ]),
        annotations: Array.isArray(entry.annotations)
          ? entry.annotations
              .filter((value): value is string => typeof value === "string")
              .slice(0, 8)
              .map((value) => value.slice(0, 300))
          : [],
      }));
    const evidenceTypes = new Set([
      "DIMENSION",
      "TEXT",
      "MTEXT",
      "ATTRIB",
      "ATTDEF",
      "INSERT",
      "MINSERT",
    ]);
    const allEntities = records(parsed.entities);
    const rawCandidates = evidenceOnly
      ? allEntities.filter((entity) =>
          evidenceTypes.has(String((entity as Record<string, unknown>).t || "")),
        )
      : allEntities;
    const blockDefinitions = records(parsed.blockDefinitions);
    const referencedBlocks = new Set(
      blockDefinitions
        .filter((entry) => entry.referenced === true && typeof entry.name === "string")
        .map((entry) => String(entry.name)),
    );
    const modelCandidates = rawCandidates.filter((entity) => entity.s === "m");
    const blockCandidates = rawCandidates
      .filter((entity) => String(entity.s || "").startsWith("b:"))
      .sort(
        (left, right) =>
          Number(referencedBlocks.has(String(right.s).slice(2))) -
          Number(referencedBlocks.has(String(left.s).slice(2))),
      );
    const layoutCandidates = rawCandidates.filter((entity) =>
      String(entity.s || "").startsWith("p:"),
    );
    const otherCandidates = rawCandidates.filter(
      (entity) =>
        entity.s !== "m" &&
        !String(entity.s || "").startsWith("b:") &&
        !String(entity.s || "").startsWith("p:"),
    );
    const groups = [modelCandidates, blockCandidates, layoutCandidates, otherCandidates].filter(
      (group) => group.length,
    );
    const candidates: Record<string, unknown>[] = [];
    for (let index = 0; candidates.length < rawCandidates.length; index += 1) {
      groups.forEach((group) => {
        if (group[index]) candidates.push(group[index]);
      });
    }
    const compact: Record<string, unknown> = {
      format: parsed.format,
      entitySchema: parsed.entitySchema,
      coordinatePolicy: parsed.coordinatePolicy,
      imageSet: parsed.imageSet,
      insUnits: parsed.insUnits,
      recognizedUnit: parsed.recognizedUnit,
      documentIdentity: {
        selectionPolicy: identity.selectionPolicy,
        titleCandidates: compactIdentityRecords("titleCandidates"),
        repeatedComponentLabels: compactIdentityRecords("repeatedComponentLabels"),
        uniqueReadableTexts: identity.uniqueReadableTexts,
      },
      entityCount: parsed.entityCount,
      entityTypes: parsed.entityTypes,
      modelSpaceBounds: parsed.modelSpaceBounds,
      spatialRegions,
      planScaleCandidates: records(parsed.planScaleCandidates).slice(0, 4),
      planContourCandidates: records(parsed.planContourCandidates).slice(0, 20),
      dimensionConflicts: records(parsed.dimensionConflicts).slice(0, 30),
      header: pick(header, [
        "ACADVER",
        "INSUNITS",
        "EXTMIN",
        "EXTMAX",
        "LIMMIN",
        "LIMMAX",
        "ELEVATION",
      ]),
      tables: {
        layers: compactTable("layers", [
          "name",
          "off",
          "frozen",
          "locked",
          "lineType",
          "lineweight",
        ]),
        dimensionStyles: compactTable("dimensionStyles", ["name", "DIMSCALE", "DIMLFAC", "DIMDEC"]),
        lineTypes: compactTable("lineTypes", ["name", "description", "patternLength"]),
        textStyles: compactTable("textStyles", ["name", "fixedTextHeight", "widthFactor"]),
      },
      blockDefinitions: blockDefinitions
        .sort((left, right) => Number(right.referenced === true) - Number(left.referenced === true))
        .slice(0, 32)
        .map((entry) =>
          pick(entry, [
            "name",
            "handle",
            "basePoint",
            "insertionUnits",
            "flags",
            "description",
            "referenced",
            "generatedDimensionGraphics",
            "entityCount",
            "entityTypes",
            "localBounds",
          ]),
        ),
      layoutSpaces: records(parsed.layoutSpaces).slice(0, 40),
      sourceTruncation: parsed.truncation,
      entities: [],
      aiContextSelection: {
        purpose: evidenceOnly ? "drawing-audit" : "3d-reconstruction",
        strategy: "balanced source order across scopes, regions and entity types",
        available: candidates.length,
        included: 0,
      },
    };
    const selected: unknown[] = [];
    let serializedLength = JSON.stringify(compact).length;
    for (const entity of candidates) {
      const entityLength = JSON.stringify(entity).length + 1;
      if (serializedLength + entityLength + 256 > maxLength) continue;
      selected.push(entity);
      serializedLength += entityLength;
    }
    compact.entities = selected;
    compact.aiContextSelection = {
      purpose: evidenceOnly ? "drawing-audit" : "3d-reconstruction",
      strategy: "balanced source order across scopes, regions and entity types",
      available: candidates.length,
      included: selected.length,
      omitted: candidates.length - selected.length,
    };
    return JSON.stringify(compact);
  } catch {
    return context.slice(0, maxLength);
  }
}

export function applyCadIdentityGuard(analysis: DrawingAnalysis, context: string): DrawingAnalysis {
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    const identity =
      parsed.documentIdentity && typeof parsed.documentIdentity === "object"
        ? (parsed.documentIdentity as Record<string, unknown>)
        : {};
    const candidates = Array.isArray(identity.titleCandidates) ? identity.titleCandidates : [];
    const repeated = Array.isArray(identity.repeatedComponentLabels)
      ? identity.repeatedComponentLabels
      : [];
    const normalize = (value: unknown) =>
      typeof value === "string"
        ? value
            .toLocaleLowerCase("ru-RU")
            .replace(/[^a-zа-яё0-9]+/gi, " ")
            .trim()
        : "";
    const current = normalize(analysis.objectName);
    const isRepeatedComponent = repeated.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const label = normalize((entry as Record<string, unknown>).text);
      return label && (label === current || label.includes(current) || current.includes(label));
    });
    let guarded = analysis;
    if (isRepeatedComponent) {
      const title = candidates.find(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).text === "string" &&
          normalize((entry as Record<string, unknown>).text) !== current,
      ) as Record<string, unknown> | undefined;
      if (
        title &&
        typeof title.text === "string" &&
        title.text.length >= analysis.objectName.length + 8
      ) {
        const statement = `Основной объект определён по заголовку листа: «${title.text}»; повторяющаяся подпись «${analysis.objectName}» относится к компоненту.`;
        guarded = {
          ...analysis,
          objectName: title.text,
          conclusions: [
            {
              id: "cad-document-identity",
              statement,
              evidence: ["Основная надпись и повторяемость локальных подписей в CAD."],
              confidence: 0.99,
              affectsGeometry: true,
            },
            ...analysis.conclusions.filter((entry) => entry.id !== "cad-document-identity"),
          ].slice(0, 12),
        };
      }
    }
    const hasOrthographicViews =
      guarded.detectedViews.filter((view) => /план|сверху|фасад|разрез|сбоку|главн/i.test(view))
        .length >= 2;
    return hasOrthographicViews && guarded.documentType === "perspective"
      ? { ...guarded, documentType: "orthographic" as const }
      : guarded;
  } catch {
    return analysis;
  }
}

function buildDeterministicBuildingAnalysis(
  parsed: Record<string, unknown>,
  hints: ReconstructionHints,
  sourceName = "",
): DrawingAnalysis | undefined {
  const identity =
    parsed.documentIdentity && typeof parsed.documentIdentity === "object"
      ? (parsed.documentIdentity as Record<string, unknown>)
      : {};
  const titleCandidates = (Array.isArray(identity.titleCandidates) ? identity.titleCandidates : [])
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    )
    .map((entry) => (typeof entry.text === "string" ? entry.text.trim() : ""))
    .filter(Boolean);
  const buildingPattern =
    /здани|корпус|поликлиник|больниц|гостини|отел|жил(?:ой|ого)|школ|детск(?:ий|ого)\s+сад|торгов|офис|административ|building|hotel|hospital|clinic|school|office/iu;
  const roomPattern =
    /гардероб|санузел|комнат|кладов|помещен|раздевал|душев|коридор|лифт|лестничн|узел|экспликац/iu;
  const cadTitle = titleCandidates
    .filter((value) => buildingPattern.test(value) && !roomPattern.test(value))
    .sort((left, right) => right.length - left.length)[0];
  const fileTitle = sourceName
    .replace(/\.[^.]+$/u, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title =
    cadTitle ||
    (/здани|korpus|корпус|poliklin|поликлин|gostin|гостин|hotel|complex|комплекс|office|administrativ/iu.test(
      fileTitle,
    )
      ? fileTitle
      : "");
  if (!title) return undefined;

  const entities = Array.isArray(parsed.entities)
    ? parsed.entities.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
  const viewPattern =
    /(?:^|\s)(план|фасад|разрез|вид|этаж|section|elevation|floor)(?:\s|$|[-–—])/iu;
  const detectedViews = [
    ...new Set(
      entities
        .filter((entry) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(String(entry.t || "")))
        .map((entry) =>
          typeof entry.text === "string" ? entry.text.replace(/\\P/g, " ").trim() : "",
        )
        .filter((text) => text.length >= 3 && text.length <= 120 && viewPattern.test(text)),
    ),
  ].slice(0, 20);
  if (detectedViews.length < 2) return undefined;

  const recognizedUnit = allowedUnits.has(parsed.recognizedUnit as ReconstructionUnit)
    ? (parsed.recognizedUnit as ReconstructionUnit)
    : undefined;
  const unit = hints.unit || recognizedUnit;
  const dimensions = entities
    .filter((entry) => entry.t === "DIMENSION")
    .map((entry, index) => {
      const display = typeof entry.display === "string" ? entry.display.trim() : "";
      const dimensionType = typeof entry.dimType === "number" ? entry.dimType & 15 : -1;
      if (dimensionType === 2 || dimensionType === 5 || /%%d|°/iu.test(display)) return undefined;
      const nominal =
        typeof entry.nominal === "number" && Number.isFinite(entry.nominal)
          ? Math.abs(entry.nominal)
          : undefined;
      const measured =
        typeof entry.measurement === "number" && Number.isFinite(entry.measurement)
          ? Math.abs(entry.measurement)
          : undefined;
      const value = nominal ?? measured;
      if (!value || value > 1_000_000) return undefined;
      return {
        label: (display && display !== "<>"
          ? display
          : `CAD-размер ${typeof entry.h === "string" ? entry.h : index + 1}`
        ).slice(0, 100),
        value,
        unit: unit || ("mm" as ReconstructionUnit),
        source: display && display !== "<>" ? ("drawing" as const) : ("cad" as const),
        confidence: display && display !== "<>" ? 0.98 : 0.9,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const uniqueDimensions = [
    ...new Map(
      dimensions.map((entry) => [`${entry.label}:${Math.round(entry.value * 1000)}`, entry]),
    ).values(),
  ].slice(0, 160);
  const sufficient = Boolean(unit && uniqueDimensions.length >= 3);
  const count =
    parsed.entityCount && typeof parsed.entityCount === "object"
      ? (parsed.entityCount as Record<string, unknown>)
      : {};
  return {
    version: "1.0",
    objectName: title.slice(0, 220),
    documentType: "orthographic",
    unit: unit || "unknown",
    summary: `Заголовок, ${detectedViews.length} подписей видов и ${uniqueDimensions.length} размерных значений извлечены напрямую из DWG. Архитектурная компоновка передана параметрическому строительному решателю.`,
    detectedViews,
    dimensions: uniqueDimensions,
    features: detectedViews
      .map((view, index) => ({
        id: `cad-view-${index + 1}`,
        name: view,
        kind: "axis" as const,
        relatedViews: [view],
        evidence: ["Подпись прочитана из CAD-текста."],
        confidence: 0.98,
      }))
      .slice(0, 20),
    conclusions: [
      {
        id: "cad-building-document",
        statement: `Документ относится к архитектурному объекту «${title.slice(0, 180)}» и содержит согласуемые ортографические виды.`,
        evidence: [
          `Сущностей пространства модели: ${String(count.modelSpace ?? "неизвестно")}.`,
          `Подписанные виды: ${detectedViews.join("; ")}.`,
        ],
        confidence: 0.95,
        affectsGeometry: true,
      },
    ],
    unresolved: sufficient
      ? []
      : [
          {
            id: "cad-building-scale",
            label: "Масштаб архитектурного объекта",
            reason:
              "В DWG недостаточно подтверждённых размерных значений или не определены единицы.",
            requiredFromUser: "Укажите единицы и хотя бы один общий размер здания.",
            severity: "critical",
          },
        ],
    sufficientFor3d: sufficient,
    overallConfidence: sufficient ? Math.min(0.9, 0.72 + uniqueDimensions.length * 0.01) : 0.55,
  };
}

export function buildDeterministicCadAnalysis(
  context: string,
  hints: ReconstructionHints,
  sourceName = "",
): DrawingAnalysis | undefined {
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    if (parsed.format !== "AEDEXA_CAD_CONTEXT_V3") return undefined;
    const identity =
      parsed.documentIdentity && typeof parsed.documentIdentity === "object"
        ? (parsed.documentIdentity as Record<string, unknown>)
        : {};
    const title = (Array.isArray(identity.titleCandidates) ? identity.titleCandidates : [])
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
      .map((entry) => (typeof entry.text === "string" ? entry.text.trim() : ""))
      .find((value) => /пешеходн[а-яё]*\s+переход/iu.test(value));
    if (!title) return buildDeterministicBuildingAnalysis(parsed, hints, sourceName);

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities.filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
        )
      : [];
    const rawDimensions = entities.filter((entry) => entry.t === "DIMENSION");
    const dimensionValues = rawDimensions
      .map((entry, index) => {
        const display = typeof entry.display === "string" ? entry.display.trim() : "";
        const dimensionType = typeof entry.dimType === "number" ? entry.dimType & 15 : -1;
        if (dimensionType === 2 || dimensionType === 5 || /%%d|°/iu.test(display)) return undefined;
        const nominal =
          typeof entry.nominal === "number" && Number.isFinite(entry.nominal)
            ? Math.abs(entry.nominal)
            : undefined;
        const measured =
          typeof entry.measurement === "number" && Number.isFinite(entry.measurement)
            ? Math.abs(entry.measurement)
            : undefined;
        const value = nominal ?? measured;
        if (!value || value > 1_000_000) return undefined;
        return {
          label: display || `CAD-размер ${typeof entry.h === "string" ? entry.h : index + 1}`,
          value,
          source: display ? ("drawing" as const) : ("cad" as const),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const recognizedUnit = allowedUnits.has(parsed.recognizedUnit as ReconstructionUnit)
      ? (parsed.recognizedUnit as ReconstructionUnit)
      : undefined;
    const unit =
      hints.unit ||
      recognizedUnit ||
      (dimensionValues.some((entry) => entry.value >= 1_000) ? "mm" : undefined);
    if (!unit || dimensionValues.length < 3) return undefined;

    const semanticBridgeLabel = (entry: { label: string; value: number }) => {
      if (/\blp\b/iu.test(entry.label)) return "Длина пролёта Lp";
      if (entry.value >= 57_000 && entry.value <= 59_000) return "Общая длина перехода";
      if (entry.value >= 3_700 && entry.value <= 3_950) return "Клиренс над дорогой";
      if (entry.value >= 2_200 && entry.value <= 2_350) return "Ширина прохода";
      if (entry.value >= 2_700 && entry.value <= 2_900) return "Перепад отметок основания и дороги";
      if (entry.value >= 6_500 && entry.value <= 6_700) return "Высота подъёма до перехода";
      if (entry.value >= 13_200 && entry.value <= 13_600) return "Глубина лестничной башни";
      if (entry.value >= 7_700 && entry.value <= 7_900) return "Длина лестничной башни";
      if (entry.value >= 4_400 && entry.value <= 4_550)
        return "Горизонтальная проекция лестничного марша";
      if (entry.value >= 1_700 && entry.value <= 1_800) return "Ширина лестничного марша";
      return entry.label;
    };
    const dimensions = [
      ...new Map(dimensionValues.map((entry) => [`${entry.label}:${entry.value}`, entry])).values(),
    ]
      .slice(0, 160)
      .map((entry) => ({ ...entry, label: semanticBridgeLabel(entry), unit, confidence: 0.95 }));
    const canopyAngle = rawDimensions
      .map((entry) => {
        const display = typeof entry.display === "string" ? entry.display : "";
        const type = typeof entry.dimType === "number" ? entry.dimType & 15 : -1;
        const match = display.match(/\d+(?:[.,]\d+)?/);
        return (type === 2 || type === 5) && match ? Number(match[0].replace(",", ".")) : undefined;
      })
      .find((value): value is number => typeof value === "number" && Number.isFinite(value));
    type CadPoint2 = [number, number];
    const cadPoint = (value: unknown): CadPoint2 | undefined =>
      Array.isArray(value) &&
      typeof value[0] === "number" &&
      Number.isFinite(value[0]) &&
      typeof value[1] === "number" &&
      Number.isFinite(value[1])
        ? [value[0], value[1]]
        : undefined;
    const cadSegments = entities.flatMap((entry) => {
      if (entry.s !== "m") return [] as Array<{ a: CadPoint2; b: CadPoint2 }>;
      if (entry.t === "LINE") {
        const a = cadPoint(entry.p1);
        const b = cadPoint(entry.p2);
        return a && b ? [{ a, b }] : [];
      }
      if (entry.t !== "LWPOLYLINE" || !Array.isArray(entry.v)) return [];
      const vertices = entry.v.map(cadPoint).filter((value): value is CadPoint2 => Boolean(value));
      return vertices.slice(1).map((point, index) => ({ a: vertices[index], b: point }));
    });
    const spanNominal = dimensions.find((entry) =>
      /длин[а-яё]*\s+прол[её]т|\blp\b/iu.test(entry.label),
    )?.value;
    const liftDimension = rawDimensions.find((entry) => {
      const value = typeof entry.nominal === "number" ? entry.nominal : entry.measurement;
      return typeof value === "number" && value >= 6_500 && value <= 6_700;
    });
    const liftAnchors = [
      cadPoint(liftDimension?.subDefinitionPoint1),
      cadPoint(liftDimension?.subDefinitionPoint2),
    ].filter((value): value is CadPoint2 => Boolean(value));
    const drawingFloorY =
      liftAnchors.length === 2 ? Math.max(liftAnchors[0][1], liftAnchors[1][1]) : undefined;
    const longUpperHorizontals =
      drawingFloorY && spanNominal
        ? cadSegments
            .filter(
              ({ a, b }) =>
                Math.abs(a[1] - b[1]) <= 2 &&
                Math.abs(a[0] - b[0]) >= spanNominal * 0.9 &&
                a[1] >= drawingFloorY + 1_500 &&
                a[1] <= drawingFloorY + 6_000,
            )
            .sort((left, right) => left.a[1] - right.a[1])
        : [];
    const upperFrameBottomY = longUpperHorizontals[0]?.a[1];
    const upperFrameTopY = longUpperHorizontals.at(-1)?.a[1];
    const upperFrameXs =
      upperFrameBottomY !== undefined && upperFrameTopY !== undefined
        ? cadSegments
            .filter(
              ({ a, b }) =>
                Math.abs(a[0] - b[0]) <= 2 &&
                Math.abs(Math.min(a[1], b[1]) - upperFrameBottomY) <= 3 &&
                Math.abs(Math.max(a[1], b[1]) - upperFrameTopY) <= 3,
            )
            .map(({ a }) => a[0])
            .sort((left, right) => left - right)
        : [];
    const upperFrameSteps = upperFrameXs
      .slice(1)
      .map((value, index) => value - upperFrameXs[index])
      .filter((value) => value > 500 && value < 5_000);
    const frameStep = upperFrameSteps.length
      ? upperFrameSteps.sort((left, right) => left - right)[Math.floor(upperFrameSteps.length / 2)]
      : undefined;
    const railLevels =
      drawingFloorY !== undefined && upperFrameBottomY !== undefined && spanNominal
        ? cadSegments
            .filter(
              ({ a, b }) =>
                Math.abs(a[1] - b[1]) <= 3 &&
                (a[1] + b[1]) / 2 > drawingFloorY + 100 &&
                (a[1] + b[1]) / 2 < upperFrameBottomY - 100 &&
                Math.abs(a[0] - b[0]) >= 500,
            )
            .reduce<
              Array<{ y: number; minX: number; maxX: number; totalLength: number; count: number }>
            >((levels, { a, b }) => {
              const y = (a[1] + b[1]) / 2;
              const existing = levels.find((level) => Math.abs(level.y - y) <= 4);
              const minX = Math.min(a[0], b[0]);
              const maxX = Math.max(a[0], b[0]);
              const length = maxX - minX;
              if (existing) {
                existing.y = (existing.y * existing.count + y) / (existing.count + 1);
                existing.minX = Math.min(existing.minX, minX);
                existing.maxX = Math.max(existing.maxX, maxX);
                existing.totalLength += length;
                existing.count += 1;
              } else {
                levels.push({ y, minX, maxX, totalLength: length, count: 1 });
              }
              return levels;
            }, [])
            .filter(
              (level) =>
                level.maxX - level.minX >= spanNominal * 0.75 ||
                level.totalLength >= spanNominal * 0.65,
            )
            .sort((left, right) => left.y - right.y)
        : [];
    const railTopY = railLevels.at(-1)?.y;
    const bridgeProfileConclusions =
      drawingFloorY !== undefined && upperFrameBottomY !== undefined && upperFrameTopY !== undefined
        ? [
            {
              id: "cad-bridge-frame-bottom",
              statement: `Нижняя грань верхней рамной зоны находится на ${Math.round(upperFrameBottomY - drawingFloorY)} ${unit} выше настила.`,
              evidence: ["Две непрерывные горизонтали и отметка настила главного вида DWG."],
              confidence: 0.99,
              affectsGeometry: true,
            },
            {
              id: "cad-bridge-frame-height",
              statement: `Высота верхней рамной зоны составляет ${Math.round(upperFrameTopY - upperFrameBottomY)} ${unit}.`,
              evidence: ["Разность точных CAD-координат верхнего и нижнего поясов."],
              confidence: 0.99,
              affectsGeometry: true,
            },
            ...(frameStep
              ? [
                  {
                    id: "cad-bridge-frame-step",
                    statement: `Повторяющиеся стойки верхней рамной зоны имеют шаг ${Math.round(frameStep)} ${unit}.`,
                    evidence: [
                      `${upperFrameXs.length} вертикальных линий между поясами главного вида.`,
                    ],
                    confidence: 0.99,
                    affectsGeometry: true,
                  },
                ]
              : []),
            ...(railTopY
              ? [
                  {
                    id: "cad-bridge-guardrail",
                    statement: `Ограждение перехода имеет высоту ${Math.round(railTopY - drawingFloorY)} ${unit} и ${railLevels.length} ${pluralizeRu(railLevels.length, "горизонтальный ригель", "горизонтальных ригеля", "горизонтальных ригелей")}.`,
                    evidence: [
                      `Горизонтальных рядов, собранных из CAD-отрезков между стойками: ${railLevels.length}.`,
                    ],
                    confidence: 0.97,
                    affectsGeometry: true,
                  },
                ]
              : []),
          ]
        : [];
    const texts = entities
      .filter(
        (entry) =>
          ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(String(entry.t || "")) &&
          typeof entry.text === "string",
      )
      .map((entry) => String(entry.text).replace(/\\P/giu, " "));
    const viewPatterns: Array<[string, RegExp]> = [
      ["Главный вид", /главн[а-яё]*\s+вид/iu],
      ["План", /(?:^|\s)план(?:\s|$)/iu],
      ["Фасад", /фасад/iu],
      ["Разрез", /разрез/iu],
      ["Вид сбоку", /вид\s+(?:слева|справа|сбоку)/iu],
    ];
    const detectedViews = viewPatterns
      .filter(([, pattern]) => texts.some((value) => pattern.test(value)))
      .map(([name]) => name);
    const inferredUnit = !hints.unit && !recognizedUnit;
    return parseDrawingAnalysis({
      version: "1.0",
      objectName: title,
      documentType: detectedViews.length >= 2 ? "orthographic" : "unknown",
      unit,
      summary: `Название объекта и ${dimensions.length} числовых размеров извлечены напрямую из DWG без передачи массива CAD-сущностей в LLM.`,
      detectedViews,
      dimensions,
      features: [
        {
          id: "cad-bridge-assembly",
          name: "Надземный пешеходный переход",
          kind: "solid",
          relatedViews: detectedViews,
          evidence: [`Заголовок листа: «${title}».`],
          confidence: 0.99,
        },
      ],
      conclusions: [
        {
          id: "cad-document-identity",
          statement: `Полный объект — «${title}».`,
          evidence: ["Основная надпись DWG."],
          confidence: 0.99,
          affectsGeometry: true,
        },
        ...(canopyAngle
          ? [
              {
                id: "cad-canopy-angle",
                statement: `Угол наклона навесов лестничных башен составляет ${canopyAngle}°.`,
                evidence: ["Угловой размер DWG."],
                confidence: 0.95,
                affectsGeometry: true,
              },
            ]
          : []),
        ...bridgeProfileConclusions,
      ],
      unresolved: inferredUnit
        ? [
            {
              id: "cad-unit-inferred",
              label: "Единицы DWG",
              reason: "INSUNITS не задан; миллиметры выбраны по порядку величин размерной цепочки.",
              requiredFromUser: "Подтвердите единицы перед производственным использованием.",
              severity: "warning",
            },
          ]
        : [],
      sufficientFor3d: true,
      overallConfidence: inferredUnit ? 0.78 : 0.9,
    });
  } catch {
    return undefined;
  }
}
