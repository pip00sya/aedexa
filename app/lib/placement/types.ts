import type { CadProcessingResult } from "../cad/types";
import type { DrawingClassification } from "./drawingPurpose";
import type { SiteContextMark } from "./siteContext";

export type PlacementPoint = { x: number; y: number };
export type PlacementPolygon = PlacementPoint[];
export type PlacementRect = { x: number; y: number; width: number; height: number };

export type PlacementSourceKind = "dwg" | "dxf" | "image" | "map";

export type PlacementAnchor = { lat: number; lon: number; rotation: number };
export type PlacementConfidence = "confirmed" | "local" | "pixel";
export type ImageSourceType = "satellite" | "drawing";
export type ImageContextKind = "building" | "road" | "vegetation" | "water";
export type BuildingProfile = "detached_house" | "multi_residential" | "public";
export type StreetType = "main" | "residential";
export type FireClass = "I–II" | "III" | "IIIа–V";
export type RuleStatus = "PASS" | "FAIL" | "MISSING_DATA" | "EXPERT_REVIEW";

export type PlacementRuleResult = {
  id: string;
  title: string;
  status: RuleStatus;
  requiredMeters?: number;
  detail: string;
  clause: string;
  sourceUrl: string;
};

export type NeighborBuilding = {
  id: string;
  polygon: PlacementPolygon;
};

export type PlacementParameters = {
  profile: BuildingProfile;
  streetType: StreetType;
  buildingWidth: number;
  buildingDepth: number;
  projectFireClass: FireClass;
  neighborFireClass: FireClass;
  seismicity: 8 | 9 | 10;
  officialRedLine: boolean;
  neighborDataConfirmed: boolean;
  apzSetback?: number;
};

export type PlacementContext = {
  parcel: PlacementPolygon;
  streetEdgeIndex: number;
  neighbors: NeighborBuilding[];
  parameters: PlacementParameters;
  /** Инженерные сети рядом с участком; undefined - источник о них не знает */
  utilities?: UtilityRestriction[];
  contextMarks?: SiteContextMark[];
};

export type FireRestriction = PlacementRect & {
  sourceId: string;
  distance: number;
};

export type UtilityKind =
  | "water"
  | "sewer"
  | "drainage"
  | "gas-low"
  | "gas-medium"
  | "gas-high"
  | "heat"
  | "power-cable"
  | "communication"
  | "power-overhead"
  | "unknown";

export type UtilityRestriction = {
  id: string;
  kind: UtilityKind;
  label: string;
  /** Ось сети в координатах посадки, в метрах */
  polyline: PlacementPolygon;
  /** Требуемый разрыв в метрах; 0 - тип сети не опознан */
  distance: number;
  ruleId?: string;
  clause?: string;
  status: RuleStatus;
  voltageKv?: number;
};

export type UtilityZone = {
  id: string;
  label: string;
  distance: number;
  status: RuleStatus;
  /** Контуры охранной зоны для отрисовки: по капсуле на каждое звено оси */
  outlines: PlacementPolygon[];
};

export type PlacementAnalysis = {
  parcelArea: number;
  buildableArea: number;
  buildable: PlacementPolygon;
  buildableSpots?: PlacementPolygon[][];
  spotsSubtracted?: boolean;
  building?: PlacementRect;
  fireRestrictions: FireRestriction[];
  utilityZones?: UtilityZone[];
  edgeSetbacks: number[];
  rules: PlacementRuleResult[];
};

export type PlanSegment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
};

export type ImagePlanAnalysis = {
  width: number;
  height: number;
  sourceType: ImageSourceType;
  segments: PlanSegment[];
  contextObjects: ImageContextObject[];
  drawingBounds: PlacementRect;
  darkPixelRatio: number;
};

export type ImageContextObject = {
  id: string;
  kind: ImageContextKind;
  polygon: PlacementPolygon;
  confidence: number;
};

export type ParcelCandidate = {
  id: string;
  label: string;
  polygon: PlacementPolygon;
  area: number;
  confidence: number;
  source: "closed-cad" | "stitched-cad";
  streetEdgeIndex: number;
};

export type PlacementSource = {
  kind: PlacementSourceKind;
  name: string;
  confidence: PlacementConfidence;
  unitLabel: string;
  coordinateLabel: string;
  parcel: PlacementPolygon | null;
  parcelConfirmed: boolean;
  streetEdgeIndex: number;
  neighbors: NeighborBuilding[];
  parcelCandidates?: ParcelCandidate[];
  selectedParcelCandidateId?: string;
  utilities?: UtilityRestriction[];
  cad?: CadProcessingResult;
  image?: ImagePlanAnalysis;
  imageUrl?: string;
  metersPerPixel?: number;
  /** Источник "карта": где на местности стоит центр участка */
  anchor?: PlacementAnchor;
  /** Рельеф и подоснова чертежа рядом с участком; нет у снимков и карты */
  relief?: PlacementRelief;
  purpose?: DrawingClassification;
  withheldParcel?: PlacementPolygon;
  warnings: string[];
};

/** Горизонталь: линия одной высоты, метры */
export type ReliefContour = { z: number; points: PlacementPolygon };

/** Высотная отметка: точка с известной высотой */
export type ReliefMark = {
  x: number;
  y: number;
  z: number;
  /** Высота из координаты Z, а не прочитана из подписи */
  fromGeometry: boolean;
};

export type ReliefLine = { layer: string; closed: boolean; points: PlacementPolygon };

export type PlacementRelief = {
  contours: ReliefContour[];
  marks: ReliefMark[];
  base: ReliefLine[];
  /** Сколько линий чертежа не влезло в подоснову и было отброшено */
  baseDropped: number;
};
