import { cleanText, record } from "../untrusted";
import type { CadGeometryGroup } from "./geometryGroups";
import { auditPlacedCadFeature } from "./objectRules";
import {
  cadKinds,
  type CadFeature,
  type CadGroupDecision,
  type CadGroupDictionary,
  type CadGroupRole,
  type CadKind,
  type CadProcessingResult,
  type CadSemanticStatus,
  type CadStripAnswer,
  type CadStripVerdict,
} from "./types";

const stripVerdicts = new Set<CadStripVerdict>(["passage", "plot", "unclear"]);
const groupRoles = new Set<CadGroupRole>([
  "road-edge",
  "road-surface",
  "building-outline",
  "other",
]);
const semanticStatuses = new Set<CadSemanticStatus>([
  "existing",
  "planned",
  "demolition",
  "unknown",
]);
const decisionKinds = new Set<string>(cadKinds);
const roadEdgeKinds = new Set<CadKind>(["road", "curb"]);

const MIN_STRIP_WIDTH_METERS = 2;
const MAX_STRIP_WIDTH_METERS = 14;
/** Меньше этого полоса слишком коротка, чтобы по ней о чем-то судить */
const MIN_STRIP_RUN_METERS = 8;

export function stripCandidates(groups: CadGeometryGroup[]) {
  return groups.filter((group) => {
    if (!group.corridor || !group.parallel || group.corridor.sampledStations < 8) return false;
    const width = group.parallel.medianSpacingMeters;
    return (
      width >= MIN_STRIP_WIDTH_METERS &&
      width <= MAX_STRIP_WIDTH_METERS &&
      group.corridor.longestPairedRunMeters >= MIN_STRIP_RUN_METERS
    );
  });
}

export const cadStripJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    answers: {
      type: "array",
      description: "По одному ответу на каждую группу из списка.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Буква группы ровно как в списке." },
          strip: {
            type: "string",
            enum: ["passage", "plot", "unclear"],
            description:
              "passage — полоса是 проход или проезд: пустая и тянется непрерывно. plot — внутренность участка: в полосе стоит дом, она обрывается на углах. unclear — по замеру не отличить.",
          },
          confidence: { type: "number", description: "Уверенность от 0 до 1." },
          why: { type: "string", description: "Какие именно числа замера привели к ответу." },
        },
        required: ["id", "strip", "confidence", "why"],
      },
    },
  },
  required: ["answers"],
} as const;

export const cadGroupDictionaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "1–3 предложения: что это за чертёж и как в нём устроены обозначения.",
    },
    decisions: {
      type: "array",
      description: "По одному решению на каждую группу из списка.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Идентификатор группы ровно как в списке." },
          kind: {
            type: "string",
            enum: [...cadKinds],
            description:
              "Класс объектов группы: road — дорога или покрытие, curb — бордюр и кромка покрытия, building — здание, fence — ограждение, boundary — граница участка, utility — сеть, ditch — арык или канава, vegetation — зелень, terrain — рельеф, site — площадка, annotation — служебное оформление, unknown — определить нельзя.",
          },
          role: {
            type: "string",
            enum: ["road-edge", "road-surface", "building-outline", "other"],
            description:
              "road-edge — линия является кромкой проезжей части, по паре таких кромок программа построит полотно. Ставь road-edge только вместе с kind road или curb.",
          },
          status: {
            type: "string",
            enum: ["existing", "planned", "demolition", "unknown"],
            description: "Существующее, проектируемое, под снос или неизвестно.",
          },
          confidence: { type: "number", description: "Уверенность от 0 до 1." },
          evidence: {
            type: "string",
            description:
              "Чем подтверждается: образец легенды, подпись, замер полосы, имя слоя, цвет.",
          },
        },
        required: ["id", "kind", "role", "status", "confidence", "evidence"],
      },
    },
  },
  required: ["summary", "decisions"],
} as const;

function clamp01(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

export function buildStripPrompt(groups: CadGeometryGroup[]) {
  const letters = new Map<string, string>();
  const lines: string[] = [];
  groups.forEach((group, index) => {
    const letter = String.fromCharCode(65 + index);
    letters.set(letter, group.id);
    const corridor = group.corridor!;
    const parallel = group.parallel!;
    lines.push(
      `Группа ${letter}:\n` +
        `  ширина полосы между парой линий: ${round(parallel.medianSpacingMeters)} м (разброс ${round(parallel.spacingSpreadMeters, 2)} м)\n` +
        `  в полосе: пусто ${Math.round(corridor.emptyRatio * 100)}%, стоит здание ${Math.round(corridor.buildingRatio * 100)}%, внутри другого контура ${Math.round(corridor.enclosedRatio * 100)}%\n` +
        `  непрерывный спаренный участок: ${round(corridor.longestPairedRunMeters, 0)} м\n` +
        `  линии спарены на ${Math.round(parallel.pairedRatio * 100)}% сечений, куски по ${round(group.medianChainLengthMeters ?? group.medianLengthMeters)} м`,
    );
  });
  return {
    letters,
    prompt: `Программа замерила парные линии на топосъёмке и то, что лежит в полосе между линиями каждой пары.\n\n${lines.join("\n\n")}\n\nДля каждой группы определи, чем является полоса между парой линий.`,
  };
}

export function parseStripAnswers(value: unknown, letters: Map<string, string>): CadStripAnswer[] {
  const input = record(value);
  if (!Array.isArray(input.answers)) throw new Error("answers: ожидается массив ответов");
  const seen = new Set<string>();
  const answers: CadStripAnswer[] = [];
  for (const raw of input.answers) {
    const item = record(raw);
    const groupId = letters.get(cleanText(item.id, 4).toUpperCase());
    if (!groupId || seen.has(groupId)) continue;
    const verdict = cleanText(item.strip, 20).toLowerCase() as CadStripVerdict;
    if (!stripVerdicts.has(verdict)) continue;
    seen.add(groupId);
    answers.push({
      groupId,
      verdict,
      confidence: clamp01(item.confidence),
      why: cleanText(item.why, 400),
    });
  }
  return answers;
}

export function buildGroupPrompt(
  fileName: string,
  unitLabel: string,
  groups: CadGeometryGroup[],
  strips: CadStripAnswer[],
  legend: Array<{ text: string; sample: string }>,
  mixedColorLayers: string[],
) {
  const stripById = new Map(strips.map((answer) => [answer.groupId, answer]));
  const stripLabel: Record<CadStripVerdict, string> = {
    passage: "полоса между линиями — ПРОХОД или ПРОЕЗД",
    plot: "полоса между линиями — внутренность участка",
    unclear: "по полосе различить не удалось",
  };
  const lines = groups.map((group) => {
    const parts = [
      `${group.id} — слой «${group.layer}», цвет ${group.colorFamily}${group.colorIndex !== undefined ? ` (ACI ${group.colorIndex})` : ""}, ${group.form}, ${group.count} шт.`,
      group.lineType
        ? `  тип линии «${group.lineType}»${group.lineWeightMm ? `, толщина ${group.lineWeightMm} мм` : ""}`
        : "",
      group.patternName ? `  узор штриховки ${group.patternName}` : "",
      group.medianAreaMeters !== undefined
        ? `  медианная площадь ${round(group.medianAreaMeters, 2)} м², заполнение габарита ${round(group.medianFillRatio ?? 0, 2)}`
        : `  длина цепочки ${round(group.medianChainLengthMeters ?? group.medianLengthMeters)} м, всего ${round(group.totalLengthMeters, 0)} м, просвет между кусками ${round(group.medianEndGapMeters ?? 0, 2)} м`,
      group.parallel
        ? `  идут парами на ${Math.round(group.parallel.pairedRatio * 100)}% сечений, ширина ${round(group.parallel.medianSpacingMeters)} м`
        : "",
      stripById.has(group.id)
        ? `  ЗАМЕР ПОЛОСЫ: ${stripLabel[stripById.get(group.id)!.verdict]} (уверенность ${round(stripById.get(group.id)!.confidence, 2)})`
        : "",
      group.labels.length ? `  подписи внутри контуров: ${group.labels.join(", ")}` : "",
      `  правила по имени слоя дали «${group.ruleKind}» — это исходная догадка, а не истина`,
    ];
    return parts.filter(Boolean).join("\n");
  });

  return `Файл ${fileName}, единицы чертежа ${unitLabel}.

${legend.length ? `ЛЕГЕНДА чертежа (образец → подпись), прочитана программой:\n${legend.map((row) => `- ${row.sample} → «${row.text}»`).join("\n")}` : "Легенда в чертеже не найдена."}

${mixedColorLayers.length ? `В этих слоях автор осознанно различал объекты ЦВЕТОМ, поэтому имя слоя описывает слой целиком и может не описывать каждый объект в нём: ${mixedColorLayers.map((name) => `«${name}»`).join(", ")}.` : ""}

ГРУППЫ ГЕОМЕТРИИ:
${lines.join("\n\n")}

Определи класс каждой группы. Порядок улик по силе: совпадение сигнатуры с образцом легенды — сильнейшая; затем подписи внутри контуров; затем замер полосы; затем имя слоя и цвет. Если легенда закрепила цвет за одним значением, другой цвет в том же слое значит другое.`;
}

export function parseGroupDictionary(
  value: unknown,
  knownIds: Iterable<string>,
): Omit<CadGroupDictionary, "strips"> {
  const known = new Set(knownIds);
  const input = record(value);
  if (!Array.isArray(input.decisions)) throw new Error("decisions: ожидается массив решений");
  const seen = new Set<string>();
  const decisions: CadGroupDecision[] = [];
  for (const raw of input.decisions) {
    const item = record(raw);
    const groupId = cleanText(item.id, 12);
    if (!known.has(groupId) || seen.has(groupId)) continue;
    const kind = cleanText(item.kind, 20).toLowerCase();
    if (!decisionKinds.has(kind)) continue;
    let role = cleanText(item.role, 24).toLowerCase() as CadGroupRole;
    if (!groupRoles.has(role)) role = "other";
    if (role === "road-edge" && !roadEdgeKinds.has(kind as CadKind)) role = "other";
    const status = cleanText(item.status, 20).toLowerCase() as CadSemanticStatus;
    seen.add(groupId);
    decisions.push({
      groupId,
      kind: kind as CadKind,
      role,
      status: semanticStatuses.has(status) ? status : "unknown",
      confidence: clamp01(item.confidence),
      evidence: cleanText(item.evidence, 500),
    });
  }
  if (!decisions.length)
    throw new Error("decisions: не осталось ни одного решения по известной группе");
  return { summary: cleanText(input.summary, 600), decisions };
}

const weakSources = new Set<NonNullable<CadFeature["classificationSource"]>>([
  "CAD_GEOMETRY",
  "CAD_COLOR",
  "UNKNOWN",
]);

export function applyGroupDictionary(
  result: CadProcessingResult,
  groups: CadGeometryGroup[],
  dictionary: Omit<CadGroupDictionary, "strips">,
): { result: CadProcessingResult; appliedCount: number } {
  const decisionByFeature = new Map<string, CadGroupDecision>();
  const groupById = new Map(groups.map((group) => [group.id, group]));
  for (const decision of dictionary.decisions) {
    const group = groupById.get(decision.groupId);
    if (!group || decision.kind === "unknown") continue;
    for (const id of group.featureIds) decisionByFeature.set(id, decision);
  }

  let appliedCount = 0;
  const features = result.features.map((feature) => {
    const decision = decisionByFeature.get(feature.id);
    if (!decision || decision.kind === feature.kind) return feature;
    if (feature.semantic) return feature;
    const weak =
      feature.kind === "unknown" ||
      feature.confidence < 0.9 ||
      (feature.classificationSource !== undefined && weakSources.has(feature.classificationSource));
    if (!weak || decision.confidence < 0.6) return feature;
    appliedCount += 1;
    return auditPlacedCadFeature({
      ...feature,
      kind: decision.kind,
      confidence: Math.min(0.85, decision.confidence),
      reason: `ИИ по отпечатку группы: ${decision.evidence || decision.kind}`,
      classificationSource: "AI_DRAWING",
      qaStatus: "REVIEW",
    });
  });

  return { result: { ...result, features }, appliedCount };
}

export function roadEdgeFeatures(
  result: CadProcessingResult,
  groups: CadGeometryGroup[],
  dictionary: Pick<CadGroupDictionary, "decisions">,
): CadFeature[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const allowed = new Set<string>();
  for (const decision of dictionary.decisions) {
    if (decision.role !== "road-edge") continue;
    for (const id of groupById.get(decision.groupId)?.featureIds ?? []) allowed.add(id);
  }
  if (!allowed.size) return [];
  return result.features.filter(
    (feature) => allowed.has(feature.id) && roadEdgeKinds.has(feature.kind),
  );
}
