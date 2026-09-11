import type {
  DrawingAnalysis,
  DrawingConclusion,
  DrawingFeature,
  ReconstructionAgentTrace,
  ReconstructionDimension,
  ReconstructionFace,
  ReconstructionIssue,
  ReconstructionMethod,
  ReconstructionModel,
  ReconstructionPart,
  ReconstructionPartKind,
  ReconstructionProfilePoint,
  ReconstructionStatus,
  ReconstructionUnit,
  ReconstructionVector3,
} from "./types";

const units = new Set<ReconstructionUnit>(["mm", "cm", "m", "in"]);
const analysisUnits = new Set<DrawingAnalysis["unit"]>(["mm", "cm", "m", "in", "unknown"]);
const statuses = new Set<ReconstructionStatus>(["ready", "needs_input", "unsupported"]);
const methods = new Set<ReconstructionMethod>([
  "ai_vision",
  "ai_agent",
  "cad_exact",
  "cad_parametric",
]);
const kinds = new Set<ReconstructionPartKind>([
  "box",
  "cylinder",
  "extrusion",
  "revolution",
  "mesh",
]);
const sources = new Set<ReconstructionDimension["source"]>(["drawing", "cad", "user", "inferred"]);
const severities = new Set<ReconstructionIssue["severity"]>(["critical", "warning"]);
const documentTypes = new Set<DrawingAnalysis["documentType"]>([
  "orthographic",
  "perspective",
  "mixed",
  "unknown",
]);
const featureKinds = new Set<DrawingFeature["kind"]>([
  "solid",
  "cut",
  "hole",
  "slot",
  "fillet",
  "chamfer",
  "pattern",
  "axis",
  "unknown",
]);

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name}: ожидался объект`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 600) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}: ожидался текст`);
  return value.trim().slice(0, max);
}

function number(value: unknown, name: string, min = -1_000_000, max = 1_000_000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name}: недопустимое число`);
  }
  return value;
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`${name}: ожидалось логическое значение`);
  return value;
}

function array(value: unknown, name: string, max: number) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name}: недопустимый массив`);
  return value;
}

function enumValue<T extends string>(value: unknown, name: string, allowed: Set<T>): T {
  if (typeof value !== "string" || !allowed.has(value as T))
    throw new Error(`${name}: недопустимое значение`);
  return value as T;
}

function vector(value: unknown, name: string): ReconstructionVector3 {
  const item = object(value, name);
  return {
    x: number(item.x, `${name}.x`),
    y: number(item.y, `${name}.y`),
    z: number(item.z, `${name}.z`),
  };
}

function profilePoint(value: unknown, name: string): ReconstructionProfilePoint {
  const item = object(value, name);
  return { x: number(item.x, `${name}.x`), z: number(item.z, `${name}.z`) };
}

function face(value: unknown, name: string, vertexCount: number): ReconstructionFace {
  const item = object(value, name);
  const a = number(item.a, `${name}.a`, 0, vertexCount - 1);
  const b = number(item.b, `${name}.b`, 0, vertexCount - 1);
  const c = number(item.c, `${name}.c`, 0, vertexCount - 1);
  if (![a, b, c].every(Number.isInteger))
    throw new Error(`${name}: индексы граней должны быть целыми`);
  return { a, b, c };
}

function part(value: unknown, index: number): ReconstructionPart {
  const item = object(value, `parts[${index}]`);
  const vertices = array(item.vertices, `parts[${index}].vertices`, 20_000).map(
    (entry, vertexIndex) => vector(entry, `parts[${index}].vertices[${vertexIndex}]`),
  );
  const result: ReconstructionPart = {
    id: string(item.id, `parts[${index}].id`, 80),
    name: string(item.name, `parts[${index}].name`, 160),
    kind: enumValue(item.kind, `parts[${index}].kind`, kinds),
    position: vector(item.position, `parts[${index}].position`),
    rotationDegrees: vector(item.rotationDegrees, `parts[${index}].rotationDegrees`),
    size: vector(item.size, `parts[${index}].size`),
    radius: number(item.radius, `parts[${index}].radius`, 0),
    height: number(item.height, `parts[${index}].height`, 0),
    profile: array(item.profile, `parts[${index}].profile`, 240).map((entry, pointIndex) =>
      profilePoint(entry, `parts[${index}].profile[${pointIndex}]`),
    ),
    holes: array(item.holes, `parts[${index}].holes`, 32).map((hole, holeIndex) =>
      array(hole, `parts[${index}].holes[${holeIndex}]`, 120).map((entry, pointIndex) =>
        profilePoint(entry, `parts[${index}].holes[${holeIndex}][${pointIndex}]`),
      ),
    ),
    vertices,
    faces: array(item.faces, `parts[${index}].faces`, 40_000).map((entry, faceIndex) =>
      face(entry, `parts[${index}].faces[${faceIndex}]`, vertices.length),
    ),
    color: /^#[0-9a-f]{6}$/i.test(item.color as string) ? (item.color as string) : "#5d83b5",
    confidence: number(item.confidence, `parts[${index}].confidence`, 0, 1),
    evidence: array(item.evidence, `parts[${index}].evidence`, 20).map((entry, evidenceIndex) =>
      string(entry, `parts[${index}].evidence[${evidenceIndex}]`, 240),
    ),
  };

  if (result.kind === "box" && (result.size.x <= 0 || result.size.y <= 0 || result.size.z <= 0)) {
    throw new Error(`${result.name}: размеры параллелепипеда должны быть больше нуля`);
  }
  if (result.kind === "cylinder" && (result.radius <= 0 || result.height <= 0)) {
    throw new Error(`${result.name}: радиус и высота цилиндра должны быть больше нуля`);
  }
  if (result.kind === "extrusion" && (result.profile.length < 3 || result.height <= 0)) {
    throw new Error(`${result.name}: для выдавливания нужен замкнутый профиль и высота`);
  }
  if (result.kind === "extrusion" && result.holes.some((hole) => hole.length < 3)) {
    throw new Error(`${result.name}: отверстие должно содержать минимум три точки`);
  }
  if (result.kind === "revolution" && result.profile.length < 2) {
    throw new Error(`${result.name}: для тела вращения нужен профиль радиус/высота`);
  }
  if (result.kind === "mesh" && (!result.vertices.length || !result.faces.length)) {
    throw new Error(`${result.name}: сетка не содержит вершин или граней`);
  }
  return result;
}

function dimension(value: unknown, index: number): ReconstructionDimension {
  const item = object(value, `dimensions[${index}]`);
  return {
    label: string(item.label, `dimensions[${index}].label`, 160),
    value: number(item.value, `dimensions[${index}].value`, 0),
    unit: enumValue(item.unit, `dimensions[${index}].unit`, units),
    source: enumValue(item.source, `dimensions[${index}].source`, sources),
    confidence: number(item.confidence, `dimensions[${index}].confidence`, 0, 1),
  };
}

function issue(value: unknown, index: number): ReconstructionIssue {
  const item = object(value, `unresolved[${index}]`);
  return {
    id: string(item.id, `unresolved[${index}].id`, 80),
    label: string(item.label, `unresolved[${index}].label`, 160),
    reason: string(item.reason, `unresolved[${index}].reason`, 400),
    requiredFromUser: string(item.requiredFromUser, `unresolved[${index}].requiredFromUser`, 300),
    severity: enumValue(item.severity, `unresolved[${index}].severity`, severities),
  };
}

function drawingFeature(value: unknown, index: number): DrawingFeature {
  const item = object(value, `features[${index}]`);
  return {
    id: string(item.id, `features[${index}].id`, 80),
    name: string(item.name, `features[${index}].name`, 160),
    kind: enumValue(item.kind, `features[${index}].kind`, featureKinds),
    relatedViews: array(item.relatedViews, `features[${index}].relatedViews`, 12).map(
      (entry, viewIndex) => string(entry, `features[${index}].relatedViews[${viewIndex}]`, 120),
    ),
    evidence: array(item.evidence, `features[${index}].evidence`, 12).map((entry, evidenceIndex) =>
      string(entry, `features[${index}].evidence[${evidenceIndex}]`, 240),
    ),
    confidence: number(item.confidence, `features[${index}].confidence`, 0, 1),
  };
}

function drawingConclusion(value: unknown, index: number): DrawingConclusion {
  const item = object(value, `conclusions[${index}]`);
  return {
    id: string(item.id, `conclusions[${index}].id`, 80),
    statement: string(item.statement, `conclusions[${index}].statement`, 400),
    evidence: array(item.evidence, `conclusions[${index}].evidence`, 12).map(
      (entry, evidenceIndex) =>
        string(entry, `conclusions[${index}].evidence[${evidenceIndex}]`, 240),
    ),
    confidence: number(item.confidence, `conclusions[${index}].confidence`, 0, 1),
    affectsGeometry: boolean(item.affectsGeometry, `conclusions[${index}].affectsGeometry`),
  };
}

export function parseDrawingAnalysis(value: unknown): DrawingAnalysis {
  const item = object(value, "analysis");
  const unresolved = array(item.unresolved, "analysis.unresolved", 40).map(issue);
  const unit = enumValue(item.unit, "analysis.unit", analysisUnits);
  const sufficientFor3d =
    boolean(item.sufficientFor3d, "analysis.sufficientFor3d") &&
    unit !== "unknown" &&
    !unresolved.some((entry) => entry.severity === "critical");
  return {
    version: "1.0",
    objectName: string(item.objectName, "analysis.objectName", 220),
    documentType: enumValue(item.documentType, "analysis.documentType", documentTypes),
    unit,
    summary: string(item.summary, "analysis.summary", 800),
    detectedViews: array(item.detectedViews, "analysis.detectedViews", 20).map((entry, index) =>
      string(entry, `analysis.detectedViews[${index}]`, 120),
    ),
    dimensions: array(item.dimensions, "analysis.dimensions", 160).map(dimension),
    features: array(item.features, "analysis.features", 160).map(drawingFeature),
    conclusions: array(item.conclusions, "analysis.conclusions", 120).map(drawingConclusion),
    unresolved,
    sufficientFor3d,
    overallConfidence: number(item.overallConfidence, "analysis.overallConfidence", 0, 1),
  };
}

export function parseReconstructionModel(value: unknown): ReconstructionModel {
  const item = object(value, "model");
  const parts = array(item.parts, "parts", 700).map(part);
  const analysis = item.analysis === undefined ? undefined : parseDrawingAnalysis(item.analysis);
  const unresolved = array(item.unresolved, "unresolved", 40).map(issue);
  for (const analysisIssue of analysis?.unresolved || []) {
    if (!unresolved.some((entry) => entry.id === analysisIssue.id)) unresolved.push(analysisIssue);
  }
  const requestedStatus = enumValue(item.status, "status", statuses);
  const status = analysis && !analysis.sufficientFor3d ? "needs_input" : requestedStatus;
  // старые имена способов из сохранённых объектов приводятся к ai_*
  const rawMethod = String(item.method ?? "");
  const method = enumValue(
    /_(vision|agent)$/.test(rawMethod) ? "ai_" + rawMethod.split("_").pop() : item.method,
    "method",
    methods,
  );
  const hasCriticalIssue = unresolved.some((entry) => entry.severity === "critical");
  const unit = enumValue(item.unit, "unit", units);
  let agentTrace: ReconstructionAgentTrace | undefined;
  if (item.agentTrace !== undefined) {
    const trace = object(item.agentTrace, "agentTrace");
    agentTrace = {
      model: string(trace.model, "agentTrace.model", 160),
      llmInvoked: boolean(trace.llmInvoked, "agentTrace.llmInvoked"),
      completed: boolean(trace.completed, "agentTrace.completed"),
      solver: string(trace.solver, "agentTrace.solver", 160),
      previewCompared: boolean(trace.previewCompared, "agentTrace.previewCompared"),
      reviewConfidence: number(trace.reviewConfidence, "agentTrace.reviewConfidence", 0, 1),
      verifiedElements: array(trace.verifiedElements, "agentTrace.verifiedElements", 20).map(
        (value, index) => string(value, `agentTrace.verifiedElements[${index}]`, 80),
      ),
      mismatches: array(trace.mismatches, "agentTrace.mismatches", 20).map((value, index) =>
        string(value, `agentTrace.mismatches[${index}]`, 320),
      ),
      steps: array(trace.steps, "agentTrace.steps", 16).map((value, index) => {
        const step = object(value, `agentTrace.steps[${index}]`);
        return {
          sequence: number(step.sequence, `agentTrace.steps[${index}].sequence`, 1, 16),
          action: string(step.action, `agentTrace.steps[${index}].action`, 80),
          reason: string(step.reason, `agentTrace.steps[${index}].reason`, 500),
          result: string(step.result, `agentTrace.steps[${index}].result`, 800),
        };
      }),
    };
  }

  if (analysis && analysis.unit !== "unknown" && unit !== analysis.unit)
    throw new Error("model.unit: не совпадает с проверенным анализом");
  if (method !== "cad_exact" && parts.some((entry) => entry.kind === "mesh")) {
    throw new Error("AI-модель не может создавать недоказанную сетку");
  }

  return {
    version: "1.0",
    sourceName: string(item.sourceName, "sourceName", 220),
    method,
    status,
    title: string(item.title, "title", 220),
    unit,
    summary: string(item.summary, "summary", 800),
    detectedViews:
      analysis?.detectedViews ||
      array(item.detectedViews, "detectedViews", 20).map((entry, index) =>
        string(entry, `detectedViews[${index}]`, 120),
      ),
    dimensions: analysis?.dimensions || array(item.dimensions, "dimensions", 160).map(dimension),
    parts,
    unresolved,
    warnings: array(item.warnings, "warnings", 40).map((entry, index) =>
      string(entry, `warnings[${index}]`, 400),
    ),
    overallConfidence: Math.min(
      number(item.overallConfidence, "overallConfidence", 0, 1),
      analysis?.overallConfidence ?? 1,
    ),
    canExport:
      boolean(item.canExport, "canExport") &&
      status === "ready" &&
      parts.length > 0 &&
      !hasCriticalIssue,
    analysis,
    agentTrace,
  };
}

const vectorSchema = {
  type: "object",
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
  required: ["x", "y", "z"],
} as const;

const dimensionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string", maxLength: 100 },
    value: { type: "number" },
    unit: { type: "string", enum: ["mm", "cm", "m", "in"] },
    source: { type: "string", enum: ["drawing", "cad", "user", "inferred"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["label", "value", "unit", "source", "confidence"],
} as const;

const issueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", maxLength: 60 },
    label: { type: "string", maxLength: 120 },
    reason: { type: "string", maxLength: 260 },
    requiredFromUser: { type: "string", maxLength: 180 },
    severity: { type: "string", enum: ["critical", "warning"] },
  },
  required: ["id", "label", "reason", "requiredFromUser", "severity"],
} as const;

export const drawingAnalysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: ["1.0"] },
    objectName: { type: "string", maxLength: 120 },
    documentType: { type: "string", enum: ["orthographic", "perspective", "mixed", "unknown"] },
    unit: { type: "string", enum: ["mm", "cm", "m", "in", "unknown"] },
    summary: { type: "string", maxLength: 420 },
    detectedViews: { type: "array", maxItems: 16, items: { type: "string", maxLength: 80 } },
    dimensions: { type: "array", maxItems: 16, items: dimensionSchema },
    features: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: 60 },
          name: { type: "string", maxLength: 120 },
          kind: {
            type: "string",
            enum: [
              "solid",
              "cut",
              "hole",
              "slot",
              "fillet",
              "chamfer",
              "pattern",
              "axis",
              "unknown",
            ],
          },
          relatedViews: { type: "array", maxItems: 4, items: { type: "string", maxLength: 80 } },
          evidence: { type: "array", maxItems: 1, items: { type: "string", maxLength: 180 } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["id", "name", "kind", "relatedViews", "evidence", "confidence"],
      },
    },
    conclusions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: 60 },
          statement: { type: "string", maxLength: 260 },
          evidence: { type: "array", maxItems: 1, items: { type: "string", maxLength: 180 } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          affectsGeometry: { type: "boolean" },
        },
        required: ["id", "statement", "evidence", "confidence", "affectsGeometry"],
      },
    },
    unresolved: { type: "array", maxItems: 6, items: issueSchema },
    sufficientFor3d: { type: "boolean" },
    overallConfidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "version",
    "objectName",
    "documentType",
    "unit",
    "summary",
    "detectedViews",
    "dimensions",
    "features",
    "conclusions",
    "unresolved",
    "sufficientFor3d",
    "overallConfidence",
  ],
} as const;

export const reconstructionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: ["1.0"] },
    status: { type: "string", enum: ["ready", "needs_input", "unsupported"] },
    title: { type: "string", maxLength: 160 },
    unit: { type: "string", enum: ["mm", "cm", "m", "in"] },
    summary: { type: "string", maxLength: 420 },
    detectedViews: { type: "array", maxItems: 0, items: { type: "string" } },
    dimensions: {
      type: "array",
      maxItems: 0,
      items: dimensionSchema,
    },
    parts: {
      type: "array",
      maxItems: 28,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: 60 },
          name: { type: "string", maxLength: 120 },
          kind: { type: "string", enum: ["box", "cylinder", "extrusion", "revolution", "mesh"] },
          position: vectorSchema,
          rotationDegrees: vectorSchema,
          size: vectorSchema,
          radius: { type: "number", minimum: 0 },
          height: { type: "number", minimum: 0 },
          profile: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { x: { type: "number" }, z: { type: "number" } },
              required: ["x", "z"],
            },
          },
          holes: {
            type: "array",
            maxItems: 8,
            items: {
              type: "array",
              maxItems: 16,
              items: {
                type: "object",
                additionalProperties: false,
                properties: { x: { type: "number" }, z: { type: "number" } },
                required: ["x", "z"],
              },
            },
          },
          vertices: { type: "array", maxItems: 0, items: vectorSchema },
          faces: {
            type: "array",
            maxItems: 0,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                a: { type: "integer" },
                b: { type: "integer" },
                c: { type: "integer" },
              },
              required: ["a", "b", "c"],
            },
          },
          color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", maxItems: 1, items: { type: "string", maxLength: 140 } },
        },
        required: [
          "id",
          "name",
          "kind",
          "position",
          "rotationDegrees",
          "size",
          "radius",
          "height",
          "profile",
          "holes",
          "vertices",
          "faces",
          "color",
          "confidence",
          "evidence",
        ],
      },
    },
    unresolved: {
      type: "array",
      maxItems: 6,
      items: issueSchema,
    },
    warnings: { type: "array", maxItems: 6, items: { type: "string", maxLength: 180 } },
    overallConfidence: { type: "number", minimum: 0, maximum: 1 },
    canExport: { type: "boolean" },
  },
  required: [
    "version",
    "status",
    "title",
    "unit",
    "summary",
    "detectedViews",
    "dimensions",
    "parts",
    "unresolved",
    "warnings",
    "overallConfidence",
    "canExport",
  ],
} as const;

export const reconstructionReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    objectName: { type: "string", maxLength: 120 },
    summary: { type: "string", maxLength: 320 },
    accepted: { type: "boolean" },
    overallConfidence: { type: "number", minimum: 0, maximum: 1 },
    rejectedPartIds: { type: "array", maxItems: 12, items: { type: "string", maxLength: 60 } },
    corrections: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          partId: { type: "string", maxLength: 60 },
          position: vectorSchema,
          rotationDegrees: vectorSchema,
          size: vectorSchema,
          radius: { type: "number", minimum: 0 },
          height: { type: "number", minimum: 0 },
          reason: { type: "string", maxLength: 160 },
        },
        required: ["partId", "position", "rotationDegrees", "size", "radius", "height", "reason"],
      },
    },
    unresolved: { type: "array", maxItems: 6, items: issueSchema },
    warnings: { type: "array", maxItems: 6, items: { type: "string", maxLength: 180 } },
  },
  required: [
    "objectName",
    "summary",
    "accepted",
    "overallConfidence",
    "rejectedPartIds",
    "corrections",
    "unresolved",
    "warnings",
  ],
} as const;
