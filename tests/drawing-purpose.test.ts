import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDrawing,
  elevationsLookLikeTerrain,
  isAbsoluteElevation,
} from "../app/lib/placement/drawingPurpose.ts";
import type { DrawingEvidence } from "../app/lib/placement/drawingPurpose.ts";

const evidence = (layers: string[], over: Partial<DrawingEvidence> = {}): DrawingEvidence => ({
  layers,
  hasPlausibleParcel: true,
  parcelArea: 1200,
  markCount: 0,
  ...over,
});

/** Слои настоящей топосъемки topo.dwg */
const TOPO_LAYERS = [
  "SIT_LРЕЛЬЕФ",
  "SIT_LГРАНИЦЫ",
  "SIT_LДОРОГИ",
  "SIT_LГОРИЗОН",
  "SIT_LГИДРОГР",
  "ГП-Граница учасика ИЖС",
  "ГРАНИЦЫ",
  "Заливка",
  "РЕЛЬЕФ",
  "Арыки",
  "Газопроводы",
  "ГР.УЧ",
  "штамп",
  "текст",
  "РАЗМЕР",
];

/** Слои типового архитектурного комплекта из папки материалов */
const BUILDING_LAYERS = [
  "0",
  "WALL",
  "стены",
  "оси",
  "doors",
  "окна и двери",
  "размеры",
  "текст",
  "лестницы",
  "колонны",
];

/** Слои интерьерного чертежа: мебель и оборудование вместо конструкций */
const INTERIOR_LAYERS = [
  "0",
  "MEBEL",
  "оборудование",
  "фурнитура",
  "отделка",
  "сантехника",
  "текст",
  "рамка",
];

test("топосъёмка узнаётся по слоям границ и рельефа", () => {
  const result = classifyDrawing(evidence(TOPO_LAYERS));
  assert.equal(result.purpose, "site-survey");
  assert.equal(result.allowsPlacement, true);
  assert.ok(result.confidence > 0.7, `уверенность ${result.confidence}`);
  assert.ok(result.reasons.some((reason) => /границ/u.test(reason)));
  assert.ok(result.reasons.some((reason) => /рельеф/u.test(reason)));
});

test("демо-участок без сетей — тоже съёмка", () => {
  const result = classifyDrawing(
    evidence([
      "ГОРИЗОНТАЛИ",
      "ГРАНИЦА УЧАСТКА",
      "ДОРОГИ ПРОЕЗДЫ",
      "ЗЕЛЕНЫЕ НАСАЖДЕНИЯ",
      "ОГРАЖДЕНИЯ",
      "СУЩЕСТВУЮЩИЕ СТРОЕНИЯ",
    ]),
  );
  assert.equal(result.purpose, "site-survey");
  assert.equal(result.allowsPlacement, true);
});

test("участок без горизонталей — генплан, посадка доступна", () => {
  const result = classifyDrawing(
    evidence(["ГРАНИЦА УЧАСТКА", "ДОРОГИ ПРОЕЗДЫ", "ЗЕЛЕНЫЕ НАСАЖДЕНИЯ", "ОГРАЖДЕНИЯ"]),
  );
  assert.equal(result.purpose, "site-plan");
  assert.equal(result.allowsPlacement, true);
  assert.match(result.suggestion, /Рельеф проверяется отдельно/u);
});

test("комплект чертежей здания посадку не запускает", () => {
  const result = classifyDrawing(evidence(BUILDING_LAYERS));
  assert.equal(result.purpose, "building");
  assert.equal(
    result.allowsPlacement,
    false,
    "крупный контур здания не должен становиться участком",
  );
  assert.match(result.suggestion, /2D → 3D/u);
});

test("интерьер и технология отличаются от здания и тоже не считаются", () => {
  const result = classifyDrawing(evidence(INTERIOR_LAYERS));
  assert.equal(result.purpose, "detail");
  assert.equal(result.allowsPlacement, false);
  assert.match(result.suggestion, /Ни участка, ни здания целиком здесь нет/u);
});

test("замкнутый контур без слоёв участка участком не считается", () => {
  const blind = classifyDrawing(evidence(["0", "1", "layer5"], { hasPlausibleParcel: true }));
  assert.equal(blind.purpose, "unknown");
  assert.equal(blind.allowsPlacement, false, "контур сам по себе участком не делает");
  assert.match(blind.suggestion, /обведите границу вручную/u);

  const empty = classifyDrawing(evidence(["0"], { hasPlausibleParcel: false }));
  assert.equal(empty.allowsPlacement, false, "ни слоёв, ни контура — считать нечего");
});

test("сокращённые слои архитектора узнаются наравне с полными словами", () => {
  const abbreviated = classifyDrawing(
    evidence(["0", "AP_PEREGORODKA", "AP_OKNO", "AP_OBORUDOVANIE", "EQP", "gips"]),
  );
  assert.equal(abbreviated.allowsPlacement, false);
  assert.ok(
    ["building", "detail"].includes(abbreviated.purpose),
    `получено ${abbreviated.purpose}`,
  );
});

test("одно слово «границ» среди слоёв стен не делает чертёж съёмкой", () => {
  const stadium = classifyDrawing(
    evidence([
      "0",
      "Граница полов внутри помещений",
      "!ПОТОЛКИ-ОТМЕТКИ",
      "утеплитель",
      "СТЕНЫ",
      "- КИРПИЧ",
      "! САНТЕХНИКА",
      "ЛЕСТНИЦЫ",
      "перекрытия",
      "колонны",
      "двери",
      "окна",
      "перегородки",
      "кровля",
    ]),
  );
  assert.equal(stadium.allowsPlacement, false, `получено ${stadium.purpose}`);
});

test("слои участка перевешивают слои конструкций: на генплане есть и то и другое", () => {
  const result = classifyDrawing(
    evidence([...BUILDING_LAYERS, "ГРАНИЦА УЧАСТКА", "ГОРИЗОНТАЛИ", "В1 ВОДОПРОВОД"]),
  );
  assert.equal(result.purpose, "site-survey", "проектируемое здание на съёмке — обычное дело");
  assert.equal(result.allowsPlacement, true);
});

test("отметки принимаются за рельеф только при правдоподобном разбросе", () => {
  assert.equal(elevationsLookLikeTerrain(112, 25), true, "склон 25 м по 112 отметкам — рельеф");
  assert.equal(
    elevationsLookLikeTerrain(112, 702),
    false,
    "перепад 702 м — не участок, а мусор из чертежа",
  );
  assert.equal(elevationsLookLikeTerrain(4, 3), false, "четырёх отметок мало");
  assert.equal(elevationsLookLikeTerrain(40, 0), false, "нулевой разброс — плоскость, а не рельеф");

  assert.equal(
    elevationsLookLikeTerrain(112, 25, 40),
    false,
    "четверть высоты на сорока метрах — не склон",
  );
  assert.equal(
    elevationsLookLikeTerrain(112, 25, 400),
    true,
    "тот же перепад на четырёхстах метрах — обычный склон",
  );
  assert.equal(elevationsLookLikeTerrain(112, 3, 40), true, "три метра на сорока — пологий склон");

  assert.equal(isAbsoluteElevation(698.2), true);
  assert.equal(isAbsoluteElevation(0.15), false, "толщина пола, а не отметка");
  assert.equal(isAbsoluteElevation(17850), false, "миллиметры высотной отметки листа");
});
