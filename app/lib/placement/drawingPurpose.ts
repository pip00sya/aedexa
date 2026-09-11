export type DrawingPurpose =
  /** Топосъемка: границы, рельеф, сети - полный вход для посадки */
  | "site-survey"
  /** Генплан или благоустройство: участок есть, рельефа может не быть */
  | "site-plan"
  /** Комплект чертежей здания: планы, фасады, разрезы */
  | "building"
  /** Узел, интерьер, технология, ведомость: ни участка, ни здания целиком */
  | "detail"
  /** Улик не хватило: решение оставляем человеку */
  | "unknown";

export type DrawingEvidence = {
  /** Имена слоев чертежа */
  layers: string[];
  /** Найден ли замкнутый контур правдоподобной для участка площади */
  hasPlausibleParcel: boolean;
  /** Площадь найденного контура, м² */
  parcelArea?: number;
  /** Сколько высотных отметок прочитано */
  markCount: number;
  /** Разброс отметок, метры */
  elevationSpread?: number;
};

export type DrawingClassification = {
  purpose: DrawingPurpose;
  /** Уверенность 0...1: доля улик, которые сошлись */
  confidence: number;
  /** Почему решено так - человеческим языком, для показа пользователю */
  reasons: string[];
  /** Что делать дальше */
  suggestion: string;
  /** Можно ли считать посадку на этом чертеже */
  allowsPlacement: boolean;
};

const LAYER_SIGNALS = {
  /** Границы землепользования - главная улика участка */
  parcel:
    /границ|участк|участок|межев|кадастр|отвод|землепольз|шекара|boundary|parcel|property|lot.?line/iu,
  /** Рельеф: горизонтали и отметки */
  relief:
    /горизонт|изолин|рельеф|высотн|отметк|бергштрих|contour|isoline|topo|relief|spot.?level/iu,
  /** Инженерные сети на участке */
  utility:
    /водопровод|канализ|газопровод|теплотрасс|теплосет|кабел|лэп|электросет|связ|водосток|дренаж|\bв1\b|\bк1\b|\bт1\b|water.?main|sewer|gas.?line|utility/iu,
  /** Ситуация вокруг: дороги, зелень, гидрография, благоустройство */
  site: /генплан|благоустрой|ситуацион|проезд|тротуар|дорог|покрыти|озелен|насажден|гидрогр|арык|канав|растени|подпорн|site.?plan|landscape|road|pavement/iu,
  building:
    /стен|перегород|пере?гор|pereg|дверь|двери|окн\b|okno|проём|проем|перекрыт|лестниц|колонн|colon|column|фундамент|кровл|балк|ригел|плит[ыа]?\b|wall|door|window|slab|stair|beam|roof|floor.?plan|partition|brick|glass|gkl|гкл|gips|гипс|^ап?[_-]|^ap[_-]/iu,
  /** Наполнение помещений - верный признак планировки или интерьера */
  interior:
    /мебел|mebel|оборудован|oborud|\beqp\b|сантех|sanit|фурнитур|светильник|розетк|плинтус|отделк|потолк|потолок|\bпол(?:ы|ов|а|у)?\b|помещен|интерьер|furn|equip|lighting|ceiling|interior|mobiliario/iu,
  /** Оформление листа: само по себе ничего не говорит, но помогает счету */
  paper: /^0$|defpoints|рамк|штамп|размер|выноск|текст|штрих|hatch|frame|title|dim\b|text|anno/iu,
} as const;

/** Отметки съемки - абсолютные высоты местности, а не координаты мебели */
const MIN_ABSOLUTE_ELEVATION = 20;
const MAX_ABSOLUTE_ELEVATION = 5000;
const MAX_DROP_TO_SPAN_RATIO = 0.35;
/** Потолок на случай, когда размер участка неизвестен */
const MAX_PLAUSIBLE_DROP_METERS = 60;

function countMatching(layers: string[], pattern: RegExp) {
  return layers.filter((layer) => pattern.test(layer)).length;
}

function countSiteLayers(layers: string[], pattern: RegExp) {
  return layers.filter(
    (layer) =>
      pattern.test(layer) &&
      !LAYER_SIGNALS.building.test(layer) &&
      !LAYER_SIGNALS.interior.test(layer),
  ).length;
}

const plural = (count: number, one: string, few: string, many: string) => {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
};

export function elevationsLookLikeTerrain(
  markCount: number,
  spread: number | undefined,
  parcelSpanMeters?: number,
) {
  if (markCount < 8 || spread === undefined) return false;
  if (spread <= 0.05) return false;
  const ceiling =
    parcelSpanMeters && parcelSpanMeters > 0
      ? Math.min(MAX_PLAUSIBLE_DROP_METERS, parcelSpanMeters * MAX_DROP_TO_SPAN_RATIO)
      : MAX_PLAUSIBLE_DROP_METERS;
  return spread <= ceiling;
}

/** Похожа ли отметка на абсолютную высоту местности */
export function isAbsoluteElevation(value: number) {
  return (
    Number.isFinite(value) &&
    Math.abs(value) >= MIN_ABSOLUTE_ELEVATION &&
    Math.abs(value) <= MAX_ABSOLUTE_ELEVATION
  );
}

export function classifyDrawing(evidence: DrawingEvidence): DrawingClassification {
  const layers = evidence.layers.filter((layer) => layer.trim().length > 0);
  const parcel = countSiteLayers(layers, LAYER_SIGNALS.parcel);
  const relief = countSiteLayers(layers, LAYER_SIGNALS.relief);
  const utility = countSiteLayers(layers, LAYER_SIGNALS.utility);
  const site = countSiteLayers(layers, LAYER_SIGNALS.site);
  const building = countMatching(layers, LAYER_SIGNALS.building);
  const interior = countMatching(layers, LAYER_SIGNALS.interior);

  const reasons: string[] = [];
  const siteScore = parcel * 3 + relief * 2 + utility * 2 + site;
  const buildingScore = building * 2 + interior * 3;

  if (parcel)
    reasons.push(
      `${parcel} ${plural(parcel, "слой границ", "слоя границ", "слоёв границ")} землепользования`,
    );
  if (relief)
    reasons.push(`${relief} ${plural(relief, "слой рельефа", "слоя рельефа", "слоёв рельефа")}`);
  if (utility)
    reasons.push(
      `${utility} ${plural(utility, "слой инженерных сетей", "слоя инженерных сетей", "слоёв инженерных сетей")}`,
    );
  if (site)
    reasons.push(
      `${site} ${plural(site, "слой ситуации", "слоя ситуации", "слоёв ситуации")}: дороги, покрытия, озеленение`,
    );
  if (building)
    reasons.push(
      `${building} ${plural(building, "слой конструкций", "слоя конструкций", "слоёв конструкций")}: стены, проёмы, перекрытия`,
    );
  if (interior)
    reasons.push(
      `${interior} ${plural(interior, "слой наполнения", "слоя наполнения", "слоёв наполнения")}: мебель, оборудование, отделка`,
    );
  if (!reasons.length) reasons.push("узнаваемых по имени слоёв нет");

  const siteOutweighsBuilding = siteScore > buildingScore;

  if (parcel >= 1 && (relief >= 1 || utility >= 1)) {
    return {
      purpose: "site-survey",
      confidence: Math.min(0.95, 0.6 + siteScore * 0.04),
      reasons,
      suggestion: "Доступны рельеф, охранные зоны и посадка.",
      allowsPlacement: true,
    };
  }

  // Генплан: участок есть, рельефа может не быть
  if (parcel >= 1 || (site >= 2 && evidence.hasPlausibleParcel && siteOutweighsBuilding)) {
    return {
      purpose: "site-plan",
      confidence: Math.min(0.85, 0.5 + siteScore * 0.05),
      reasons,
      suggestion: "Посадка доступна. Рельеф проверяется отдельно — по горизонталям и отметкам.",
      allowsPlacement: true,
    };
  }

  if (buildingScore >= 4 && buildingScore > siteScore) {
    const detail = interior > building;
    return {
      purpose: detail ? "detail" : "building",
      confidence: Math.min(0.9, 0.55 + buildingScore * 0.03),
      reasons,
      suggestion: detail
        ? "Ни участка, ни здания целиком здесь нет. Для посадки нужна топосъёмка."
        : "Участка в нём нет. Откройте чертёж в режиме «2D → 3D», а для посадки загрузите топосъёмку.",
      allowsPlacement: false,
    };
  }

  return {
    purpose: "unknown",
    confidence: 0.3,
    reasons,
    suggestion: evidence.hasPlausibleParcel
      ? "Слоёв участка, рельефа и сетей нет. Замкнутый контур найден, но это может быть рамка листа или контур здания — обведите границу вручную, если это всё-таки съёмка."
      : "Ни слоёв участка, ни замкнутого контура подходящей площади.",
    allowsPlacement: false,
  };
}
