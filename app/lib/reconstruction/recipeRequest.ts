import { AiRequestError, createStructuredResponse, type AiConfig } from "../ai/featherless";
import {
  buildingRecipeJsonSchema,
  parseBuildingRecipe,
  type BuildingRecipe,
} from "./buildingSolver";

type RecipePlan = Omit<BuildingRecipe, "masses"> & {
  masses: { id: string; name: string; evidence: string }[];
};

const planSchema = {
  ...buildingRecipeJsonSchema,
  properties: {
    ...buildingRecipeJsonSchema.properties,
    masses: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          evidence: {
            type: "string",
            description:
              "Вид и положение объёма относительно общего центра здания, не более 160 символов",
          },
        },
        required: ["id", "name", "evidence"],
      },
    },
  },
};

const massSchema = buildingRecipeJsonSchema.properties.masses.items;
const detailedMassSchema = {
  ...massSchema,
  properties: {
    ...massSchema.properties,
    assumptions: buildingRecipeJsonSchema.properties.assumptions,
    confidence: buildingRecipeJsonSchema.properties.confidence,
  },
  required: [...massSchema.required, "assumptions", "confidence"],
};

export function parseRecipePlan(value: unknown): RecipePlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("План рецепта: ожидался объект");
  const plan = value as Record<string, unknown>;
  if (plan.applicable !== true) throw new Error("План рецепта: здание не подтверждено исходником");
  if (typeof plan.reason !== "string" || !plan.reason.trim())
    throw new Error("План рецепта: требуется основание");
  if (!["mm", "cm", "m", "in"].includes(String(plan.unit)))
    throw new Error("План рецепта: неизвестные единицы");
  for (const field of ["overallWidth", "overallDepth", "floorHeight"]) {
    const number = plan[field];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < 0.01 ||
      number > 1_000_000
    )
      throw new Error(`План рецепта: неверный ${field}`);
  }
  if (
    typeof plan.confidence !== "number" ||
    !Number.isFinite(plan.confidence) ||
    plan.confidence < 0 ||
    plan.confidence > 1
  )
    throw new Error("План рецепта: неверная уверенность");
  if (!Array.isArray(plan.masses) || !plan.masses.length || plan.masses.length > 12)
    throw new Error("План рецепта: требуется 1–12 объёмов");
  const ids = new Set<string>();
  const masses = plan.masses.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("План рецепта: неверный объём");
    const mass = entry as Record<string, unknown>;
    if (
      typeof mass.id !== "string" ||
      !mass.id.trim() ||
      mass.id.length > 50 ||
      ids.has(mass.id.trim())
    )
      throw new Error("План рецепта: неверный или повторный id");
    if (
      typeof mass.name !== "string" ||
      !mass.name.trim() ||
      typeof mass.evidence !== "string" ||
      !mass.evidence.trim()
    )
      throw new Error("План рецепта: нужны имя и основание каждого объёма");
    ids.add(mass.id.trim());
    return {
      id: mass.id.trim(),
      name: mass.name.trim().slice(0, 100),
      evidence: mass.evidence.trim().slice(0, 160),
    };
  });
  return {
    applicable: true,
    reason: plan.reason.trim().slice(0, 420),
    unit: plan.unit as RecipePlan["unit"],
    overallWidth: plan.overallWidth as number,
    overallDepth: plan.overallDepth as number,
    floorHeight: plan.floorHeight as number,
    confidence: plan.confidence,
    masses,
    assumptions: Array.isArray(plan.assumptions)
      ? plan.assumptions
          .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
          .slice(0, 16)
          .map((s) => s.trim().slice(0, 220))
      : [],
  };
}

export async function requestBuildingRecipe(
  config: AiConfig,
  images: string[],
  prompt: string,
  instructions: string,
  progress: (stage: string, percent: number) => void,
): Promise<BuildingRecipe> {
  try {
    return await createStructuredResponse(
      config,
      images,
      prompt,
      instructions,
      "aedexa_building_recipe",
      buildingRecipeJsonSchema,
      2200,
      180_000,
      parseBuildingRecipe,
    );
  } catch (error) {
    if (!(error instanceof AiRequestError) || error.code !== "AI_OUTPUT_LIMIT") throw error;
  }

  progress("Подробный чертёж: составляем список объёмов для разбора по частям", 43);
  const plan = await createStructuredResponse(
    config,
    images,
    `${prompt}\n\nПолный рецепт не поместился в ответ. Сейчас верни только общий масштаб, единицы, высоту этажа и перечень masses: id, name, evidence. В evidence укажи вид и положение объёма относительно ЕДИНОГО центра здания. Детальные параметры будут запрошены отдельно. Не объединяй и не пропускай объёмы ради сокращения ответа.`,
    instructions,
    "aedexa_building_plan",
    planSchema,
    2200,
    180_000,
    parseRecipePlan,
  );
  const masses: BuildingRecipe["masses"] = [];
  const assumptions = new Set(plan.assumptions);
  let confidence = plan.confidence;
  for (const target of plan.masses) {
    progress(
      `Разбор объёма ${masses.length + 1} из ${plan.masses.length}: ${target.name}`,
      44 + Math.floor((9 * masses.length) / plan.masses.length),
    );
    const mass = await createStructuredResponse(
      config,
      images,
      `${prompt}\n\nОбщий план (единицы, габариты, высота этажа и центр неизменны):\n${JSON.stringify(plan)}\n\nУже разобранные объёмы в общей системе координат:\n${JSON.stringify(masses)}\n\nВерни ТОЛЬКО параметры одного объёма ${JSON.stringify(target)} по схеме. Сохрани его id. centerX/centerZ отсчитываются от общего центра здания, а не от центра фрагмента. Все допущения этого объёма перечисли в assumptions и укажи его confidence. Не создавай другие объёмы и не повторяй общий рецепт.`,
      instructions,
      "aedexa_building_mass",
      detailedMassSchema,
      1400,
      180_000,
      (value) => {
        if (!value || typeof value !== "object") throw new Error("Объём: ожидался объект");
        const detail = value as Record<string, unknown>;
        if (
          !Array.isArray(detail.assumptions) ||
          detail.assumptions.some((entry) => typeof entry !== "string")
        )
          throw new Error("Объём: нужен список допущений");
        const parsed = parseBuildingRecipe({
          ...plan,
          masses: [value],
          confidence: detail.confidence,
          assumptions: detail.assumptions,
        });
        if (parsed.masses[0].id !== target.id)
          throw new Error(`Ожидался объём ${target.id}, получен ${parsed.masses[0].id}`);
        return parsed;
      },
    );
    masses.push(mass.masses[0]);
    confidence = Math.min(confidence, mass.confidence);
    for (const assumption of mass.assumptions) assumptions.add(assumption);
  }
  const result = parseBuildingRecipe({ ...plan, masses, confidence });
  return { ...result, assumptions: [...assumptions] };
}
