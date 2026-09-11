// TODO: сверить значения с официальным текстом СП РК

export type NormRuleStatus = "operator" | "unverified";

export type NormRule = {
  id: string;
  domain: "placement" | "utility" | "insolation" | "tep" | "sgp" | "vertical";
  title: string;
  document: string;
  clause: string;
  /** Редакция, из которой взяты значения, - со слов того, кто их внес */
  editionDate: string;
  /** Когда правило внесено в реестр */
  addedAt: string;
  verifiedBy: NormRuleStatus;
  applicability: string;
  parameters: Record<string, number | string>;
  sourceUrl?: string;
  notes?: string;
};

export const PLANNING_DOCUMENT = "СП РК 3.01-101-2013*";

const rules: NormRule[] = [
  {
    id: "utility.water-supply",
    domain: "utility",
    title: "Расстояние от здания до водопровода",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Водопровод и напорная канализация вне зоны фундаментов",
    parameters: { distanceMeters: 5 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.sewer",
    domain: "utility",
    title: "Расстояние от здания до самотёчной канализации",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Бытовая и дождевая самотёчная канализация",
    parameters: { distanceMeters: 3 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.drainage",
    domain: "utility",
    title: "Расстояние от здания до дренажа и арыков",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Дренажные линии, арыки, лотки",
    parameters: { distanceMeters: 3 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.gas-low",
    domain: "utility",
    title: "Расстояние от здания до газопровода низкого давления",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Газопровод низкого давления",
    parameters: { distanceMeters: 2 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.gas-medium",
    domain: "utility",
    title: "Расстояние от здания до газопровода среднего давления",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Газопровод среднего давления",
    parameters: { distanceMeters: 4 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.gas-high",
    domain: "utility",
    title: "Расстояние от здания до газопровода высокого давления",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability:
      "Газопровод высокого давления; также консервативное значение для газопровода без указанного давления",
    parameters: { distanceMeters: 7 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.heat",
    domain: "utility",
    title: "Расстояние от здания до тепловых сетей",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Тепловые сети (от наружной стенки канала или оболочки)",
    parameters: { distanceMeters: 5 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.power-cable",
    domain: "utility",
    title: "Расстояние от здания до силовых кабелей",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Подземные силовые кабели всех напряжений",
    parameters: { distanceMeters: 0.6 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.communication",
    domain: "utility",
    title: "Расстояние от здания до кабелей связи",
    document: PLANNING_DOCUMENT,
    clause: "таблица расстояний до инженерных сетей",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Кабели связи и слаботочные сети",
    parameters: { distanceMeters: 0.6 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "utility.overhead-0_4",
    domain: "utility",
    title: "Охранная зона ВЛ до 1 кВ",
    document: "Правила охраны электрических сетей",
    clause: "охранные зоны воздушных линий",
    editionDate: "типовая редакция",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Воздушная линия напряжением до 1 кВ",
    parameters: { distanceMeters: 2 },
    notes:
      "Отсчитывается от крайних проводов; здесь применяется от снятой оси как консервативное приближение.",
  },
  {
    id: "utility.overhead-10",
    domain: "utility",
    title: "Охранная зона ВЛ 1–20 кВ",
    document: "Правила охраны электрических сетей",
    clause: "охранные зоны воздушных линий",
    editionDate: "типовая редакция",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Воздушная линия напряжением 1–20 кВ; также ВЛ без указанного напряжения",
    parameters: { distanceMeters: 10 },
    notes:
      "Отсчитывается от крайних проводов; здесь применяется от снятой оси как консервативное приближение.",
  },
  {
    id: "utility.overhead-35",
    domain: "utility",
    title: "Охранная зона ВЛ 35 кВ",
    document: "Правила охраны электрических сетей",
    clause: "охранные зоны воздушных линий",
    editionDate: "типовая редакция",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Воздушная линия напряжением 35 кВ",
    parameters: { distanceMeters: 15 },
  },
  {
    id: "utility.overhead-110",
    domain: "utility",
    title: "Охранная зона ВЛ 110 кВ",
    document: "Правила охраны электрических сетей",
    clause: "охранные зоны воздушных линий",
    editionDate: "типовая редакция",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Воздушная линия напряжением 110 кВ",
    parameters: { distanceMeters: 20 },
  },
  {
    id: "tep.loggia-coefficient",
    domain: "tep",
    title: "Коэффициент площади лоджий",
    document: "СП РК 3.02-101 (правила подсчёта площадей)",
    clause: "приложение по подсчёту площадей",
    editionDate: "типовая редакция",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Лоджии при подсчёте площади квартиры",
    parameters: { coefficient: 0.5 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "tep.balcony-coefficient",
    domain: "tep",
    title: "Коэффициент площади балконов и террас",
    document: "СП РК 3.02-101 (правила подсчёта площадей)",
    clause: "приложение по подсчёту площадей",
    editionDate: "типовая редакция",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Балконы и террасы при подсчёте площади квартиры",
    parameters: { coefficient: 0.3 },
    notes: "Типовое значение; проверить по действующей редакции перед подтверждением.",
  },
  {
    id: "placement.waste-to-house",
    domain: "placement",
    title: "Разрыв от площадки для мусоросборников до жилого дома",
    document: PLANNING_DOCUMENT,
    clause: "санитарные разрывы на территории жилой застройки",
    editionDate: "2013",
    addedAt: "2026-09-08",
    verifiedBy: "unverified",
    applicability: "Контейнерная площадка на территории жилой застройки",
    parameters: { distanceMeters: 20 },
    notes:
      "Типовое значение 20 м до жилых домов, детских и спортивных площадок; проверить по действующей редакции и местным правилам.",
  },
  {
    id: "placement.well-to-septic",
    domain: "placement",
    title: "Разрыв от источника воды до септика и выгреба",
    document: PLANNING_DOCUMENT,
    clause: "санитарная охрана источников водоснабжения",
    editionDate: "2013",
    addedAt: "2026-09-08",
    verifiedBy: "unverified",
    applicability: "Индивидуальный колодец или скважина хозяйственно-питьевого назначения",
    parameters: { distanceMeters: 20 },
    notes:
      "Зависит от водопроницаемости грунта и глубины водоносного горизонта; значение требует подтверждения гидрогеологом.",
  },
  {
    id: "placement.tree-to-wall",
    domain: "placement",
    title: "Расстояние от ствола дерева до стены здания",
    document: PLANNING_DOCUMENT,
    clause: "озеленение территории",
    editionDate: "2013",
    addedAt: "2026-09-08",
    verifiedBy: "unverified",
    applicability: "Существующие и проектируемые деревья на участке",
    parameters: { distanceMeters: 5 },
    notes:
      "Типовое значение 5 м для дерева, 1,5 м для кустарника; зависит от породы и диаметра кроны.",
  },
  {
    id: "vertical.min-drain-slope",
    domain: "vertical",
    title: "Минимальный уклон площадки для стока",
    document: PLANNING_DOCUMENT,
    clause: "вертикальная планировка",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Спланированные площадки без специального водоотвода",
    parameters: { minSlope: 0.005 },
    notes: "Типовое значение 5‰; проверить по действующей редакции перед подтверждением.",
  },
];

const ruleIndex = new Map(rules.map((rule) => [rule.id, rule]));

export function findNormRule(id: string): NormRule | undefined {
  return ruleIndex.get(id);
}

export function normRuleDistance(id: string, fallback: number): number {
  const rule = ruleIndex.get(id);
  const value = rule?.parameters.distanceMeters;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function listNormRules(domain?: NormRule["domain"]): NormRule[] {
  return domain ? rules.filter((rule) => rule.domain === domain) : [...rules];
}

/** Несверенное правило не может подтвердить чистый PASS */
export function ruleCapStatus(id: string): "operator" | "unverified" {
  return ruleIndex.get(id)?.verifiedBy === "operator" ? "operator" : "unverified";
}
