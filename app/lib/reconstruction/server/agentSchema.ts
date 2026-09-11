export type CadAgentAction =
  | "inspect_summary"
  | "inspect_measurements"
  | "inspect_entities"
  | "run_parametric_solver"
  | "inspect_model"
  | "finish"
  | "generic_reconstruction";

export type CadSolver = "none" | "pedestrian_bridge" | "building_massing";

export const bridgeReviewElements = [
  "bridge_span",
  "left_tower",
  "right_tower",
  "stair_flights",
  "landings",
  "guardrails",
  "lift_shafts",
  "canopies",
  "foundations",
] as const;

export const buildingReviewElements = [
  "overall_massing",
  "footprint",
  "floor_count",
  "floor_heights",
  "facade_proportions",
  "window_rhythm",
  "roof",
  "entrances",
  "balconies_porch",
  "vertical_cores",
  "foundations",
] as const;

const allCadReviewElements = [...bridgeReviewElements, ...buildingReviewElements] as const;

export type CadReviewElement = (typeof allCadReviewElements)[number];

type BuildingDetailPresence = "present" | "absent" | "unclear";

export interface BuildingDetailInventory {
  balcony: BuildingDetailPresence;
  porchSteps: BuildingDetailPresence;
  balconyEvidence: string;
  porchEvidence: string;
}

export const buildingDetailInventoryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    balcony: { type: "string", enum: ["present", "absent", "unclear"] },
    porchSteps: { type: "string", enum: ["present", "absent", "unclear"] },
    balconyEvidence: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "Непустое обоснование статуса balcony по конкретному исходному виду.",
    },
    porchEvidence: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "Непустое обоснование статуса porchSteps по конкретному исходному виду.",
    },
  },
  required: ["balcony", "porchSteps", "balconyEvidence", "porchEvidence"],
} as const;

export function parseBuildingDetailInventory(value: unknown): BuildingDetailInventory {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("buildingDetailInventory: ожидался объект");
  const item = value as Record<string, unknown>;
  const allowed = new Set<BuildingDetailPresence>(["present", "absent", "unclear"]);
  if (typeof item.balcony !== "string" || !allowed.has(item.balcony as BuildingDetailPresence))
    throw new Error("buildingDetailInventory.balcony: недопустимое значение");
  if (
    typeof item.porchSteps !== "string" ||
    !allowed.has(item.porchSteps as BuildingDetailPresence)
  )
    throw new Error("buildingDetailInventory.porchSteps: недопустимое значение");
  const balconyEvidence =
    typeof item.balconyEvidence === "string" ? item.balconyEvidence.trim() : "";
  const porchEvidence = typeof item.porchEvidence === "string" ? item.porchEvidence.trim() : "";
  const settle = (presence: BuildingDetailPresence, evidence: string): BuildingDetailPresence =>
    presence === "present" && !evidence ? "unclear" : presence;
  return {
    balcony: settle(item.balcony as BuildingDetailPresence, balconyEvidence),
    porchSteps: settle(item.porchSteps as BuildingDetailPresence, porchEvidence),
    balconyEvidence: (balconyEvidence || "обоснование не указано").slice(0, 240),
    porchEvidence: (porchEvidence || "обоснование не указано").slice(0, 240),
  };
}

export interface CadAgentStepDecision {
  action: CadAgentAction;
  reason: string;
  entityTypes: string[];
  layerContains: string;
  scope: "all" | "model" | "blocks" | "layouts";
  region: string;
  limit: number;
  solver: CadSolver;
  verifiedElements: CadReviewElement[];
  mismatches: Array<{
    element: CadReviewElement;
    severity: "critical" | "warning";
    description: string;
  }>;
  visualConfidence: number;
}

export const cadAgentStepJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "inspect_summary",
        "inspect_measurements",
        "inspect_entities",
        "run_parametric_solver",
        "inspect_model",
        "finish",
        "generic_reconstruction",
      ],
    },
    reason: { type: "string", maxLength: 420 },
    entityTypes: { type: "array", maxItems: 8, items: { type: "string", maxLength: 40 } },
    layerContains: { type: "string", maxLength: 80 },
    scope: { type: "string", enum: ["all", "model", "blocks", "layouts"] },
    region: { type: "string", maxLength: 40 },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    solver: { type: "string", enum: ["none", "pedestrian_bridge", "building_massing"] },
    verifiedElements: {
      type: "array",
      maxItems: allCadReviewElements.length,
      items: { type: "string", enum: allCadReviewElements },
    },
    mismatches: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          element: { type: "string", enum: allCadReviewElements },
          severity: { type: "string", enum: ["critical", "warning"] },
          description: { type: "string", maxLength: 240 },
        },
        required: ["element", "severity", "description"],
      },
    },
    visualConfidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "action",
    "reason",
    "entityTypes",
    "layerContains",
    "scope",
    "region",
    "limit",
    "solver",
    "verifiedElements",
    "mismatches",
    "visualConfidence",
  ],
} as const;

export const cadFinalReviewJsonSchema = {
  ...cadAgentStepJsonSchema,
  properties: {
    ...cadAgentStepJsonSchema.properties,
    action: { type: "string", enum: ["finish", "generic_reconstruction"] },
  },
} as const;

export function parseCadAgentStep(value: unknown): CadAgentStepDecision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("agent: ожидался объект");
  const item = value as Record<string, unknown>;
  const actions = new Set<CadAgentAction>([
    "inspect_summary",
    "inspect_measurements",
    "inspect_entities",
    "run_parametric_solver",
    "inspect_model",
    "finish",
    "generic_reconstruction",
  ]);
  const scopes = new Set<CadAgentStepDecision["scope"]>(["all", "model", "blocks", "layouts"]);
  const solvers = new Set<CadAgentStepDecision["solver"]>([
    "none",
    "pedestrian_bridge",
    "building_massing",
  ]);
  const reviewElements = new Set<CadReviewElement>(allCadReviewElements);
  if (typeof item.action !== "string" || !actions.has(item.action as CadAgentAction))
    throw new Error("agent.action: недопустимое действие");
  if (typeof item.reason !== "string" || !item.reason.trim())
    throw new Error("agent.reason: требуется обоснование");

  const text = (value: unknown, maxLength: number) =>
    (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").slice(
      0,
      maxLength,
    );
  const stringList = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter(
            (entry): entry is string | number =>
              typeof entry === "string" || typeof entry === "number",
          )
          .map(String)
      : typeof value === "string"
        ? value.split(/[,;\s]+/u).filter(Boolean)
        : [];
  const number = (value: unknown) =>
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  const rawLimit = number(item.limit);
  const rawConfidence = number(item.visualConfidence);
  const scope =
    typeof item.scope === "string" && scopes.has(item.scope as CadAgentStepDecision["scope"])
      ? (item.scope as CadAgentStepDecision["scope"])
      : "all";
  const solver =
    typeof item.solver === "string" && solvers.has(item.solver as CadAgentStepDecision["solver"])
      ? (item.solver as CadAgentStepDecision["solver"])
      : "none";
  const verifiedElements = [
    ...new Set(
      stringList(item.verifiedElements).filter((entry): entry is CadReviewElement =>
        reviewElements.has(entry as CadReviewElement),
      ),
    ),
  ];
  const mismatches = (Array.isArray(item.mismatches) ? item.mismatches : [])
    .flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const mismatch = value as Record<string, unknown>;
      const description = text(mismatch.description, 240).trim();
      if (
        typeof mismatch.element !== "string" ||
        !reviewElements.has(mismatch.element as CadReviewElement) ||
        !description
      )
        return [];
      const severity: "critical" | "warning" =
        mismatch.severity === "critical" ? "critical" : "warning";
      return [{ element: mismatch.element as CadReviewElement, severity, description }];
    })
    .slice(0, 12);
  return {
    action: item.action as CadAgentAction,
    reason: item.reason.trim().slice(0, 420),
    entityTypes: stringList(item.entityTypes)
      .filter((entry) => !/^(all|any|\*)$/iu.test(entry))
      .slice(0, 8),
    layerContains: text(item.layerContains, 80),
    scope,
    region: text(item.region, 40),
    limit: Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.round(rawLimit))) : 1,
    solver,
    verifiedElements,
    mismatches,
    visualConfidence: Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0,
  };
}
