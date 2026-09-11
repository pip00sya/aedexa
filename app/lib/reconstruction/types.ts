export type ReconstructionUnit = "mm" | "cm" | "m" | "in";
export type ReconstructionStatus = "ready" | "needs_input" | "unsupported";
export type ReconstructionMethod = "ai_vision" | "ai_agent" | "cad_exact" | "cad_parametric";
export type ReconstructionPartKind = "box" | "cylinder" | "extrusion" | "revolution" | "mesh";

export interface ReconstructionVector3 {
  x: number;
  y: number;
  z: number;
}

export interface ReconstructionProfilePoint {
  x: number;
  z: number;
}

export interface ReconstructionFace {
  a: number;
  b: number;
  c: number;
}

export interface ReconstructionPart {
  id: string;
  name: string;
  kind: ReconstructionPartKind;
  position: ReconstructionVector3;
  rotationDegrees: ReconstructionVector3;
  size: ReconstructionVector3;
  radius: number;
  height: number;
  profile: ReconstructionProfilePoint[];
  holes: ReconstructionProfilePoint[][];
  vertices: ReconstructionVector3[];
  faces: ReconstructionFace[];
  color: string;
  confidence: number;
  evidence: string[];
}

export interface ReconstructionDimension {
  label: string;
  value: number;
  unit: ReconstructionUnit;
  source: "drawing" | "cad" | "user" | "inferred";
  confidence: number;
}

export interface ReconstructionIssue {
  id: string;
  label: string;
  reason: string;
  requiredFromUser: string;
  severity: "critical" | "warning";
}

export interface DrawingFeature {
  id: string;
  name: string;
  kind: "solid" | "cut" | "hole" | "slot" | "fillet" | "chamfer" | "pattern" | "axis" | "unknown";
  relatedViews: string[];
  evidence: string[];
  confidence: number;
}

export interface DrawingConclusion {
  id: string;
  statement: string;
  evidence: string[];
  confidence: number;
  affectsGeometry: boolean;
}

export interface DrawingAnalysis {
  version: "1.0";
  objectName: string;
  documentType: "orthographic" | "perspective" | "mixed" | "unknown";
  unit: ReconstructionUnit | "unknown";
  summary: string;
  detectedViews: string[];
  dimensions: ReconstructionDimension[];
  features: DrawingFeature[];
  conclusions: DrawingConclusion[];
  unresolved: ReconstructionIssue[];
  sufficientFor3d: boolean;
  overallConfidence: number;
}

export interface ReconstructionAgentStep {
  sequence: number;
  action: string;
  reason: string;
  result: string;
}

export interface ReconstructionAgentTrace {
  model: string;
  llmInvoked: boolean;
  completed: boolean;
  solver: string;
  previewCompared: boolean;
  reviewConfidence: number;
  verifiedElements: string[];
  mismatches: string[];
  steps: ReconstructionAgentStep[];
}

export interface ReconstructionModel {
  version: "1.0";
  sourceName: string;
  method: ReconstructionMethod;
  status: ReconstructionStatus;
  title: string;
  unit: ReconstructionUnit;
  summary: string;
  detectedViews: string[];
  dimensions: ReconstructionDimension[];
  parts: ReconstructionPart[];
  unresolved: ReconstructionIssue[];
  warnings: string[];
  overallConfidence: number;
  canExport: boolean;
  analysis?: DrawingAnalysis;
  agentTrace?: ReconstructionAgentTrace;
}

export interface ReconstructionHints {
  unit?: ReconstructionUnit;
  width?: number;
  height?: number;
  depth?: number;
  notes?: string;
  allowInferredGeometry?: boolean;
}

export interface PreparedDrawing {
  name: string;
  sourceKind: "image" | "svg" | "cad";
  previewDataUrl?: string;
  apiDataUrl: string;
  apiDataUrls?: string[];
  context: string;
  exactModel?: ReconstructionModel;
}
