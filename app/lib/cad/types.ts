export const cadKinds = [
  "terrain",
  "building",
  "road",
  "curb",
  "ditch",
  "boundary",
  "fence",
  "vegetation",
  "pole",
  "sign",
  "manhole",
  "utility",
  "wire",
  "water",
  "site",
  "waste",
  "annotation",
  "unknown",
] as const;

export type CadKind = (typeof cadKinds)[number];

/** Семейство цвета сущности DWG: серый, зеленый и т */
export type CadColorFamily =
  | "grey"
  | "neutral"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "magenta"
  | "unknown";

export type CadEvidenceSource =
  | "CAD_LAYER"
  | "CAD_BLOCK"
  | "CAD_TEXT"
  | "CAD_GEOMETRY"
  | "CAD_COLOR"
  | "AI_TEXT"
  | "AI_DRAWING"
  | "TIN"
  | "TEMPLATE"
  | "OPERATOR"
  | "UNKNOWN";

export type CadHeightQuality =
  | "MEASURED"
  | "DERIVED"
  | "ATTRIBUTE"
  | "ANNOTATION"
  | "TEMPLATE"
  | "UNKNOWN";
export type CadQaStatus = "AUTO" | "REVIEW" | "REJECT";

export type CadDrawingText = {
  text: string;
  count: number;
  layers: string[];
  /** Положения экземпляров подписи, не больше 60 */
  points: Array<{ x: number; y: number }>;
};

export type CadSemanticStatus = "existing" | "planned" | "demolition" | "unknown";

export type CadSemanticEntry = {
  label: string;
  meaning: string;
  kind: CadKind | "ignore";
  status: CadSemanticStatus;
  floors?: number;
  heightMeters?: number;
  use?: string;
  confidence: number;
  evidence: string;
};

export type CadSemanticDictionary = {
  summary: string;
  entries: CadSemanticEntry[];
  notes: string[];
  model?: string;
  createdAt: string;
};

export type CadStripVerdict = "passage" | "plot" | "unclear";

export type CadGroupRole = "road-edge" | "road-surface" | "building-outline" | "other";

/** Ответ ИИ по одной группе: класс, роль и на чем это основано */
export type CadGroupDecision = {
  groupId: string;
  kind: CadKind;
  role: CadGroupRole;
  status: CadSemanticStatus;
  confidence: number;
  evidence: string;
};

export type CadStripAnswer = {
  groupId: string;
  verdict: CadStripVerdict;
  confidence: number;
  why: string;
};

export type CadGroupDictionary = {
  summary: string;
  decisions: CadGroupDecision[];
  strips: CadStripAnswer[];
  model?: string;
};

export type CadGroupSemanticsState = {
  status: "idle" | "pending" | "ready" | "error" | "skipped";
  message: string;
  dictionary?: CadGroupDictionary;
  /** Сколько объектов сменили класс по решению ИИ */
  appliedCount: number;
};

export type CadSemanticsState = {
  status: "pending" | "ready" | "skipped" | "error";
  message: string;
  dictionary?: CadSemanticDictionary;
  appliedCount: number;
};

export type CadPoint = {
  x: number;
  y: number;
  z: number;
  zExplicit?: boolean;
  /** Отметка, с которой объект встает в 3D после увязки с рельефом */
  resolvedZ?: number;
};

export type CadBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type CadFeature = {
  id: string;
  sourceType: string;
  layer: string;
  blockName?: string;
  text?: string;
  /** Узор штриховки из чертежа: по нему объект узнается однозначно */
  patternName?: string;
  /** Цвет RGB, записанный прямо в сущности DWG, если он там есть */
  sourceColor?: number;
  sourceColorIndex?: number;
  colorFamily?: CadColorFamily;
  /** Толщина линии с учетом слоя, мм: тонкая - кромка, толстая - стена */
  lineWeightMm?: number;
  /** Имя типа линии (Continuous, DASHDOT...) с учетом слоя */
  lineType?: string;
  polylineWidthUnits?: number;
  kind: CadKind;
  confidence: number;
  reason: string;
  classificationSource?: CadEvidenceSource;
  closed: boolean;
  points: CadPoint[];
  /** Подписи чертежа, стоящие внутри этого контура */
  labels?: string[];
  /** Объяснение подписи от ИИ, примененное программой к объекту */
  semantic?: CadSemanticEntry;
  elevationMode?: "terrain" | "absolute" | "draped" | "leveled" | "unresolved";
  baseElevation?: number;
  /** Цепочка улик: по ней видно, откуда взялся каждый вывод об объекте */
  xySource?: CadEvidenceSource;
  zSource?: CadEvidenceSource;
  heightSource?: CadEvidenceSource;
  heightQuality?: CadHeightQuality;
  heightMeters?: number;
  geometryConfidence?: number;
  qaStatus?: CadQaStatus;
  qaIssues?: string[];
  modelRecipe?: string;
  auditVersion?: string;
  operatorDecision?: "accepted" | "rejected";
};

export type CadLayerSummary = {
  name: string;
  entityCount: number;
  kind: CadKind;
  confidence: number;
  reason: string;
};

export type CadPreflightCheck = {
  id:
    | "units"
    | "coordinates"
    | "reference"
    | "elevations"
    | "duplicates"
    | "breaklines"
    | "boundary"
    | "classification";
  label: string;
  status: "pass" | "review" | "fail";
  value: string;
  detail: string;
};

export type CadPreflightReport = {
  status: "ready" | "review" | "blocked";
  checks: CadPreflightCheck[];
};

export type CadSpatialReference = {
  horizontalCrs: string;
  verticalDatum: string;
  confirmedByOperator: boolean;
  detectionMethod?: "EMBEDDED" | "INFERRED" | "SOURCE_PRESERVED";
  confidence?: number;
  axisOrder?: "EASTING_NORTHING" | "NORTHING_EASTING" | "XY_UNRESOLVED";
  coordinatePolicy?: "SOURCE_UNCHANGED";
  evidence?: string[];
};

export type CadTerrainGrid = {
  /** Вершины сети в координатах чертежа */
  vertices: CadPoint[];
  /** Треугольники подряд идущими тройками номеров вершин */
  triangles: number[];
  sampleCount: number;
  minElevation: number;
  maxElevation: number;
  sourceSampleCount: number;
  trustedSampleCount: number;
  interpretedSampleCount: number;
  derivedBoundarySampleCount?: number;
  rejectedSampleCount: number;
  conflictingPointCount: number;
  structuralLineCount: number;
  method: "local-tin" | "none";
  quality: {
    status: "ready" | "review" | "insufficient";
    score: number;
    coverageRatio: number;
    retainedSampleRatio: number;
    rejectedGapTriangleCount: number;
    rejectedSlopeTriangleCount: number;
    patchCount: number;
  };
};

export type CadDrawingBox = [number, number, number, number];
export type CadDrawingPath = {
  t: "path";
  layer: string;
  color: number;
  /** Толщина линии, мм */
  weight?: number;
  /** Штрихи типа линии в единицах чертежа */
  dash?: number[];
  /** Ширина полилинии в единицах чертежа */
  width?: number;
  fill?: boolean;
  closed: boolean;
  /** Плоский список координат x0, y0, x1, y1... */
  pts: number[];
  b: CadDrawingBox;
};
export type CadDrawingHatchLine = { angle: number; spacing: number; dashes: number[] };
export type CadDrawingHatch = {
  t: "hatch";
  layer: string;
  color: number;
  solid: boolean;
  lines: CadDrawingHatchLine[];
  loops: number[][];
  b: CadDrawingBox;
};
export type CadDrawingLabel = {
  t: "text";
  layer: string;
  color: number;
  x: number;
  y: number;
  h: number;
  rot: number;
  text: string;
  lines?: string[];
  halign: "left" | "center" | "right";
  valign: "baseline" | "middle" | "top" | "bottom";
  /** Коэффициент ширины текста (стиль или сущность), если не 1 */
  xs?: number;
  /** Угол наклона букв в градусах, если не 0 */
  ob?: number;
  b: CadDrawingBox;
};
export type CadDrawingPrimitive = CadDrawingPath | CadDrawingHatch | CadDrawingLabel;
export type CadDrawing = {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  unitsPerMeter: number;
  primitives: CadDrawingPrimitive[];
  entityCount: number;
  omitted: number;
  /** Что именно не нарисовано, по типам сущностей DWG */
  omittedTypes?: Record<string, number>;
};

export type CadProcessingResult = {
  fileName: string;
  fileSize: number;
  formatVersion: string;
  entityCount: number;
  modelEntityCount: number;
  renderedEntityCount: number;
  omittedEntityCount: number;
  layers: CadLayerSummary[];
  features: CadFeature[];
  bounds: CadBounds;
  terrain: CadTerrainGrid;
  unitLabel: string;
  scopeMode: "all" | "primary-cluster";
  preflight: CadPreflightReport;
  spatialReference?: CadSpatialReference;
  warnings: string[];
  /** Все подписи чертежа с положениями - исходник для чтения ИИ */
  texts?: CadDrawingText[];
  /** Состояние и результат чтения подписей ИИ */
  semantics?: CadSemanticsState;
  /** Состояние и результат разбора групп геометрии ИИ */
  groupSemantics?: CadGroupSemanticsState;
  /** Точный 2D-чертеж: все сущности модели с исходным оформлением */
  drawing?: CadDrawing;
};

export const cadKindMeta: Record<CadKind, { label: string; short: string; color: number }> = {
  terrain: { label: "Рельеф и отметки", short: "Рельеф", color: 0x987550 },
  building: { label: "Здания и сооружения", short: "Здания", color: 0xe8ddcf },
  road: { label: "Дороги и покрытия", short: "Дороги", color: 0x3f444b },
  curb: { label: "Бордюры и кромки", short: "Бордюры", color: 0xd8d2c4 },
  ditch: { label: "Канавы и структурные линии", short: "Канавы", color: 0x497c74 },
  boundary: { label: "Границы и красные линии", short: "Границы", color: 0x16a34a },
  fence: { label: "Заборы и ограждения", short: "Ограждения", color: 0x9a6b3c },
  vegetation: { label: "Деревья и озеленение", short: "Зелень", color: 0x2f8f46 },
  pole: { label: "Столбы и опоры", short: "Опоры", color: 0x59636e },
  sign: { label: "Дорожные знаки", short: "Знаки", color: 0x2563eb },
  manhole: { label: "Колодцы и люки", short: "Колодцы", color: 0x334155 },
  utility: { label: "Инженерные сети", short: "Сети", color: 0x7c3aed },
  wire: { label: "Воздушные провода", short: "Провода", color: 0xdb2777 },
  water: { label: "Вода и гидрография", short: "Вода", color: 0x0ea5e9 },
  site: { label: "Площадки и благоустройство", short: "Площадки", color: 0xf59e0b },
  waste: { label: "Мусор и ТБО", short: "ТБО", color: 0xdc2626 },
  annotation: { label: "Тексты и оформление", short: "Аннотации", color: 0x2563eb },
  unknown: { label: "Технические данные без класса", short: "Технические", color: 0x94a3b8 },
};
