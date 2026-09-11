import type { CadFeature, CadProcessingResult } from "../cad/types";
import { polylineLength } from "../geometry";
import { findNormRule, normRuleDistance, ruleCapStatus } from "../norms/registry";
import type { PlacementPolygon, RuleStatus, UtilityKind, UtilityRestriction } from "./types";

const MAX_UTILITY_LINES = 150;

export type UtilityDetection = {
  kind: UtilityKind;
  label: string;
  ruleId?: string;
  voltageKv?: number;
  assumed?: boolean;
};

function parseVoltageKv(signal: string): number | undefined {
  const match = signal.match(/(\d{1,3}(?:[.,]\d)?)\s*к[вВv]/iu);
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value > 0 && value <= 1150 ? value : undefined;
}

function overheadRuleId(voltageKv: number | undefined) {
  if (voltageKv === undefined) return "utility.overhead-10";
  if (voltageKv <= 1) return "utility.overhead-0_4";
  if (voltageKv <= 20) return "utility.overhead-10";
  if (voltageKv <= 35) return "utility.overhead-35";
  return "utility.overhead-110";
}

export function detectUtilityNetwork(
  layer: string,
  text = "",
  featureKind?: CadFeature["kind"],
): UtilityDetection {
  const signal = `${layer} ${text}`.toLowerCase();
  const voltageKv = parseVoltageKv(signal);

  const isCommunication = /связ|телефон|слаботоч|(?:^|[\s_.-])ткс(?:$|[\s_.-])|телеком/iu.test(
    signal,
  );
  if (isCommunication)
    return { kind: "communication", label: "Кабель связи", ruleId: "utility.communication" };

  const namesOverhead = /(?:^|[\s_.-])(?:вл|лэп)(?:$|[\s_.-])|воздуш[а-яё]*\s*лин/iu.test(signal);
  const namesCableWork = /кабел|подзем/iu.test(signal);
  if (namesOverhead && namesCableWork) {
    return {
      kind: "power-cable",
      label: "Подземная кабельная линия",
      ruleId: "utility.power-cable",
      voltageKv,
    };
  }
  if (namesOverhead || featureKind === "wire") {
    return {
      kind: "power-overhead",
      label: voltageKv !== undefined ? `ВЛ ${voltageKv} кВ` : "ВЛ (напряжение не указано)",
      ruleId: overheadRuleId(voltageKv),
      voltageKv,
      assumed: voltageKv === undefined,
    };
  }
  if (/кабел|силов|электр/iu.test(signal)) {
    return {
      kind: "power-cable",
      label: "Силовой кабель",
      ruleId: "utility.power-cable",
      voltageKv,
    };
  }

  if (/газ/iu.test(signal)) {
    if (/высок[а-яё]*\s*давл/iu.test(signal))
      return {
        kind: "gas-high",
        label: "Газопровод высокого давления",
        ruleId: "utility.gas-high",
      };
    if (/средн[а-яё]*\s*давл/iu.test(signal))
      return {
        kind: "gas-medium",
        label: "Газопровод среднего давления",
        ruleId: "utility.gas-medium",
      };
    if (/низк[а-яё]*\s*давл/iu.test(signal))
      return { kind: "gas-low", label: "Газопровод низкого давления", ruleId: "utility.gas-low" };
    return {
      kind: "gas-high",
      label: "Газопровод (давление не указано — принято высокое)",
      ruleId: "utility.gas-high",
      assumed: true,
    };
  }

  if (
    /теплосет|теплотрасс|(?:^|[\s_.-])тс(?:$|[\s_.-])|(?:^|[\s_.-])т[12](?:$|[\s_.-])|тепл/iu.test(
      signal,
    )
  ) {
    return { kind: "heat", label: "Тепловая сеть", ruleId: "utility.heat" };
  }

  if (/ливн|дожд|дренаж|арык|лоток|(?:^|[\s_.-])к2(?:$|[\s_.-])/iu.test(signal)) {
    return { kind: "drainage", label: "Ливнесток / дренаж / арык", ruleId: "utility.drainage" };
  }

  if (/канализ|фекальн|хозбыт|sewer|(?:^|[\s_.-])к1(?:$|[\s_.-])/iu.test(signal)) {
    return { kind: "sewer", label: "Канализация", ruleId: "utility.sewer" };
  }

  if (/водопровод|водоснабж|water|(?:^|[\s_.-])в[12](?:$|[\s_.-])/iu.test(signal)) {
    return { kind: "water", label: "Водопровод", ruleId: "utility.water-supply" };
  }

  return { kind: "unknown", label: "Сеть без распознанного типа", assumed: true };
}

function statusFor(detection: UtilityDetection): RuleStatus {
  if (detection.kind === "unknown") return "MISSING_DATA";
  if (!detection.ruleId) return "MISSING_DATA";
  return ruleCapStatus(detection.ruleId) === "operator" ? "PASS" : "EXPERT_REVIEW";
}

function scaledPolyline(feature: CadFeature, unitScale: number): PlacementPolygon {
  const polyline: PlacementPolygon = [];
  for (const point of feature.points) {
    const scaled = { x: point.x * unitScale, y: point.y * unitScale };
    const previous = polyline[polyline.length - 1];
    if (!previous || Math.hypot(previous.x - scaled.x, previous.y - scaled.y) > 1e-6)
      polyline.push(scaled);
  }
  return polyline;
}

export function utilityRestrictionsFromCad(
  result: CadProcessingResult,
  unitScale: number,
): UtilityRestriction[] {
  const restrictions: UtilityRestriction[] = [];
  for (const feature of result.features) {
    if (feature.kind !== "utility" && feature.kind !== "wire") continue;
    if (feature.points.length < 2) continue;
    const polyline = scaledPolyline(feature, unitScale);
    if (polyline.length < 2) continue;
    const detection = detectUtilityNetwork(feature.layer, feature.text ?? "", feature.kind);
    const rule = detection.ruleId ? findNormRule(detection.ruleId) : undefined;
    restrictions.push({
      id: `utility:${feature.id}`,
      kind: detection.kind,
      label: detection.label,
      polyline,
      distance: detection.kind === "unknown" ? 0 : normRuleDistance(detection.ruleId ?? "", 0),
      ruleId: detection.ruleId,
      clause: rule ? `${rule.document}, ${rule.clause}` : undefined,
      status: statusFor(detection),
      voltageKv: detection.voltageKv,
    });
  }
  return restrictions
    .sort((a, b) => polylineLength(b.polyline) - polylineLength(a.polyline))
    .slice(0, MAX_UTILITY_LINES);
}
