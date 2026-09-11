import { type ReconstructionHints, type DrawingAnalysis } from "../types";
export function enforceAssistedDraft(model: Record<string, unknown>, hints: ReconstructionHints) {
  if (hints.allowInferredGeometry === false) return model;
  const warnings = Array.isArray(model.warnings)
    ? model.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const warning =
    "Режим AI-допущений включён: модель создана как проверяемый черновик; подтвердите восстановленные размеры перед производственным использованием.";
  return {
    ...model,
    status: "needs_input",
    canExport: false,
    warnings: warnings.includes(warning) ? warnings : [...warnings, warning],
  };
}

export function normalizeAiCoordinateConvention(
  model: Record<string, unknown>,
  analysis: DrawingAnalysis,
) {
  const parts = Array.isArray(model.parts)
    ? model.parts.filter((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)),
      )
    : [];
  const dimensionValues = analysis.dimensions
    .map((dimension) => dimension.value)
    .filter((value) => value > 0);
  const coordinate = (part: Record<string, unknown>, key: "y" | "z") => {
    const position =
      part.position && typeof part.position === "object"
        ? (part.position as Record<string, unknown>)
        : {};
    return typeof position[key] === "number" && Number.isFinite(position[key])
      ? (position[key] as number)
      : 0;
  };
  const matchesDimension = (value: number) =>
    dimensionValues.some(
      (dimension) => Math.abs(Math.abs(value) - dimension) <= Math.max(5, dimension * 0.01),
    );
  const yMatches = parts.filter((part) => matchesDimension(coordinate(part, "y"))).length;
  const zMatches = parts.filter((part) => matchesDimension(coordinate(part, "z"))).length;
  const yNearZero = parts.filter((part) => Math.abs(coordinate(part, "y")) < 1e-6).length;
  if (parts.length < 3 || zMatches < 2 || zMatches <= yMatches || yNearZero / parts.length < 0.7)
    return model;

  const commonQuarterTurn =
    parts.filter((part) => {
      const rotation =
        part.rotationDegrees && typeof part.rotationDegrees === "object"
          ? (part.rotationDegrees as Record<string, unknown>)
          : {};
      return (
        typeof rotation.y === "number" &&
        Math.abs(Math.abs(rotation.y) - 90) <= 1 &&
        Math.abs(typeof rotation.x === "number" ? rotation.x : 0) <= 1 &&
        Math.abs(typeof rotation.z === "number" ? rotation.z : 0) <= 1
      );
    }).length /
      parts.length >=
    0.7;

  const swapYz = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const vector = value as Record<string, unknown>;
    return { x: vector.x, y: vector.z, z: vector.y };
  };
  const span = analysis.dimensions.find((dimension) => /^\s*lp\b/i.test(dimension.label))?.value;
  const normalizedParts = parts.map((part) => {
    const size = swapYz(part.size) as Record<string, unknown>;
    const position = swapYz(part.position) as Record<string, unknown>;
    if (
      span &&
      typeof size.x === "number" &&
      typeof position.x === "number" &&
      Math.abs(size.x - span) <= span * 0.02 &&
      Math.abs(Math.abs(position.x) - span / 2) <= span * 0.02
    ) {
      position.x = 0;
    }
    return {
      ...part,
      position,
      rotationDegrees: commonQuarterTurn ? { x: 0, y: 0, z: 0 } : swapYz(part.rotationDegrees),
      size,
    };
  });
  const warning =
    "Система координат AI автоматически приведена к X — ширина, Y — высота, Z — глубина.";
  const warnings = Array.isArray(model.warnings)
    ? model.warnings.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...model,
    parts: normalizedParts,
    warnings: warnings.includes(warning) ? warnings : [...warnings, warning],
  };
}

export function stabilizePedestrianBridgeDraft(
  model: Record<string, unknown>,
  analysis: DrawingAnalysis,
  hints: ReconstructionHints = { allowInferredGeometry: true },
) {
  if (
    !/пешеходн[а-яё]*\s+переход/iu.test(analysis.objectName) ||
    analysis.unit === "unknown" ||
    hints.allowInferredGeometry === false
  )
    return model;

  type Metric = { value: number; evidence: string; inferred: boolean };
  const numbers = (text: string) =>
    (text.match(/\d[\d\s]*(?:[.,]\d+)?/g) || [])
      .map((value) => Number(value.replace(/\s+/g, "").replace(",", ".")))
      .filter((value) => Number.isFinite(value) && value > 0);
  const matchingMetric = (
    pattern: RegExp,
    minimum: number,
    maximum: number,
  ): Metric | undefined => {
    const dimension = analysis.dimensions.find(
      (entry) => pattern.test(entry.label) && entry.value >= minimum && entry.value <= maximum,
    );
    if (dimension)
      return {
        value: dimension.value,
        evidence: `размер «${dimension.label}» = ${dimension.value} ${dimension.unit}`,
        inferred: dimension.source === "inferred",
      };
    const conclusion = analysis.conclusions.find((entry) => pattern.test(entry.statement));
    const value =
      conclusion &&
      numbers(conclusion.statement).find((entry) => entry >= minimum && entry <= maximum);
    return value
      ? {
          value,
          evidence: `вывод аудита «${conclusion!.statement}»`,
          inferred: conclusion!.confidence < 0.85,
        }
      : undefined;
  };
  const fallbackMetric = (
    minimum: number,
    maximum: number,
    target: number,
    label: string,
  ): Metric | undefined => {
    const candidates = analysis.dimensions.filter(
      (entry) => entry.value >= minimum && entry.value <= maximum,
    );
    const selected = candidates.sort(
      (left, right) => Math.abs(left.value - target) - Math.abs(right.value - target),
    )[0];
    return selected
      ? {
          value: selected.value,
          evidence: `${label} выбран из размерной цепочки: ${selected.value} ${selected.unit}`,
          inferred: true,
        }
      : undefined;
  };
  const fromMillimeters = (value: number) =>
    analysis.unit === "mm"
      ? value
      : analysis.unit === "cm"
        ? value / 10
        : analysis.unit === "m"
          ? value / 1_000
          : value / 25.4;
  const measuredValues = analysis.dimensions
    .map((entry) => entry.value)
    .filter((value) => value > 0);
  const spanCandidates = measuredValues.filter(
    (value) => value >= fromMillimeters(10_000) && value <= fromMillimeters(500_000),
  );
  const span =
    matchingMetric(
      /(?:^|\s)lp\s*=|длин[а-яё]*.*(?:переход|прол[её]т|мост)|прол[её]т.*длин/iu,
      fromMillimeters(10_000),
      fromMillimeters(500_000),
    ) ||
    (spanCandidates.length
      ? {
          value: Math.max(...spanCandidates),
          evidence: "наибольший продольный размер размерной цепочки",
          inferred: true,
        }
      : undefined);
  const walkway =
    matchingMetric(
      /ширин[а-яё]*.*(?:марш|проход|переход|настил)|(?:марш|проход).*ширин/iu,
      fromMillimeters(900),
      fromMillimeters(6_000),
    ) ||
    fallbackMetric(
      fromMillimeters(1_200),
      fromMillimeters(3_500),
      fromMillimeters(2_250),
      "ширина прохода",
    );
  if (!span || !walkway) return model;

  const metricOr = (
    pattern: RegExp,
    minimum: number,
    maximum: number,
    fallback: number,
    label: string,
  ) =>
    matchingMetric(pattern, minimum, maximum) ||
    fallbackMetric(minimum, maximum, fallback, label) || {
      value: fallback,
      evidence: `${label} принят как консервативное AI-допущение`,
      inferred: true,
    };
  const assumption = (value: number, label: string): Metric => ({
    value,
    evidence: `${label} принят как явно помеченное инженерное допущение`,
    inferred: true,
  });
  const overallLength = matchingMetric(
    /общ[а-яё]*\s+длин[а-яё]*\s+переход/iu,
    fromMillimeters(20_000),
    fromMillimeters(500_000),
  );
  const liftHeight = metricOr(
    /высот[а-яё]*.*(?:подъ[её]м|до.*переход)|(?:подъ[её]м|переход).*высот/iu,
    fromMillimeters(4_500),
    fromMillimeters(10_000),
    fromMillimeters(6_600),
    "высота подъёма до перехода",
  );
  const frameBottomOffset =
    matchingMetric(
      /нижн[а-яё]*\s+гран[а-яё]*.*рамн[а-яё]*\s+зон/iu,
      fromMillimeters(1_800),
      fromMillimeters(3_000),
    ) || assumption(fromMillimeters(2_338), "отметка низа верхней рамной зоны");
  const frameHeight =
    matchingMetric(
      /высот[а-яё]*.*верхн[а-яё]*\s+рамн[а-яё]*\s+зон/iu,
      fromMillimeters(1_000),
      fromMillimeters(2_000),
    ) || assumption(fromMillimeters(1_456), "высота верхней рамной зоны");
  const guardHeight =
    matchingMetric(
      /огражден[а-яё]*.*высот|высот[а-яё]*.*огражден/iu,
      fromMillimeters(900),
      fromMillimeters(1_500),
    ) || assumption(fromMillimeters(1_165), "высота ограждения перехода");
  const frameStep =
    matchingMetric(
      /стойк[а-яё]*.*шаг|шаг.*стойк|рамн[а-яё]*.*шаг/iu,
      fromMillimeters(1_500),
      fromMillimeters(2_500),
    ) || assumption(fromMillimeters(2_000), "шаг рам пролёта");
  const towerDepth = metricOr(
    /глубин[а-яё]*.*башн|башн.*глубин/iu,
    fromMillimeters(8_000),
    fromMillimeters(20_000),
    fromMillimeters(13_430),
    "глубина лестничной башни",
  );
  const towerLength =
    matchingMetric(
      /длин[а-яё]*.*башн|башн.*длин/iu,
      fromMillimeters(5_000),
      fromMillimeters(12_000),
    ) ||
    (overallLength && overallLength.value > span.value
      ? assumption((overallLength.value - span.value) / 2, "длина концевой башни")
      : assumption(fromMillimeters(7_800), "длина концевой башни"));
  const stairRun = metricOr(
    /горизонт[а-яё]*.*марш|марш.*горизонт/iu,
    fromMillimeters(3_000),
    fromMillimeters(7_000),
    fromMillimeters(4_470),
    "горизонтальная проекция лестничного марша",
  );
  const stairWidth = metricOr(
    /ширин[а-яё]*.*марш|марш.*ширин/iu,
    fromMillimeters(1_300),
    fromMillimeters(2_100),
    fromMillimeters(1_750),
    "ширина лестничного марша",
  );
  const deckThickness =
    matchingMetric(
      /толщин[а-яё]*.*(?:настил|балк)|(?:настил|балк).*толщин/iu,
      fromMillimeters(150),
      fromMillimeters(500),
    ) || assumption(fromMillimeters(250), "толщина настила");
  const foundationHeight =
    matchingMetric(
      /(?:глубин|высот|толщин).*?(?:фундамент|основан)|(?:фундамент|основан).*?(?:глубин|высот|толщин)/iu,
      fromMillimeters(300),
      fromMillimeters(1_200),
    ) || assumption(fromMillimeters(600), "толщина фундаментных плит");

  const confidence = Math.min(
    0.65,
    analysis.overallConfidence,
    typeof model.overallConfidence === "number" && Number.isFinite(model.overallConfidence)
      ? model.overallConfidence
      : 0.65,
  );
  const blankGeometry = { radius: 0, height: 0, profile: [], holes: [], vertices: [], faces: [] };
  const box = (
    id: string,
    name: string,
    position: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    color: string,
    evidence: string,
    rotationDegrees = { x: 0, y: 0, z: 0 },
  ) => ({
    id,
    name,
    kind: "box",
    position,
    rotationDegrees,
    size,
    ...blankGeometry,
    color,
    confidence,
    evidence: [evidence],
  });

  const floorY = liftHeight.value;
  const deckY = floorY - deckThickness.value / 2;
  const upperFrameBottomY = floorY + frameBottomOffset.value;
  const roofY = upperFrameBottomY + frameHeight.value;
  const chordSize = fromMillimeters(160);
  const postSize = fromMillimeters(120);
  const panelCount = Math.max(4, Math.round(span.value / frameStep.value));
  const panelWidth = span.value / panelCount;
  const wallZ = walkway.value / 2 + postSize / 2;
  const stairFlightCount = 3;
  const stairRise = liftHeight.value / stairFlightCount;
  const stairLength = Math.hypot(stairRun.value, stairRise);
  const stairAngle = (Math.atan2(stairRise, stairRun.value) * 180) / Math.PI;
  const stairThickness = fromMillimeters(180);
  const treadCount = 11;
  const canopyAngle =
    analysis.conclusions
      .filter(
        (entry) =>
          entry.id === "cad-canopy-angle" ||
          /угол.*(?:навес|кровл)|(?:навес|кровл).*угол/iu.test(entry.statement),
      )
      .flatMap((entry) => numbers(entry.statement))
      .find((value) => value >= 5 && value <= 30) || 15;
  const geometryEvidence = `Проекционная параметрическая сборка: ${span.evidence}; ${liftHeight.evidence}; ${frameBottomOffset.evidence}; ${frameHeight.evidence}; ${walkway.evidence}; ${towerDepth.evidence}.`;
  const parts: Record<string, unknown>[] = [
    box(
      "bridge-deck",
      "Пролётный настил",
      { x: 0, y: deckY, z: 0 },
      { x: span.value, y: deckThickness.value, z: walkway.value },
      "#7894b8",
      geometryEvidence,
    ),
    box(
      "bridge-roof",
      "Кровля перехода",
      { x: 0, y: roofY, z: 0 },
      { x: span.value, y: chordSize, z: walkway.value + postSize * 2 },
      "#4f7096",
      frameHeight.evidence,
    ),
  ];
  const beamXY = (
    id: string,
    name: string,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    z: number,
    thickness: number,
    color: string,
    evidence: string,
  ) => {
    const length = Math.hypot(bx - ax, by - ay);
    parts.push(
      box(
        id,
        name,
        { x: (ax + bx) / 2, y: (ay + by) / 2, z },
        { x: length, y: thickness, z: thickness },
        color,
        evidence,
        { x: 0, y: 0, z: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI },
      ),
    );
  };
  const beamYZ = (
    id: string,
    name: string,
    x: number,
    ay: number,
    az: number,
    by: number,
    bz: number,
    thickness: number,
    color: string,
    evidence: string,
  ) => {
    const length = Math.hypot(by - ay, bz - az);
    parts.push(
      box(
        id,
        name,
        { x, y: (ay + by) / 2, z: (az + bz) / 2 },
        { x: thickness, y: thickness, z: length },
        color,
        evidence,
        { x: (-Math.atan2(by - ay, bz - az) * 180) / Math.PI, y: 0, z: 0 },
      ),
    );
  };

  const railCount = 6;
  for (const [depthSide, depthId, sideName] of [
    [-1, "front", "передней"],
    [1, "back", "задней"],
  ] as const) {
    const z = depthSide * wallZ;
    for (let rail = 0; rail < railCount; rail += 1) {
      const y = floorY + (guardHeight.value * (rail + 1)) / railCount;
      beamXY(
        `bridge-guard-rail-${depthId}-${rail}`,
        `Ригель ${sideName} ограждения ${rail + 1}`,
        -span.value / 2,
        y,
        span.value / 2,
        y,
        z,
        fromMillimeters(55),
        "#4f6d8f",
        guardHeight.evidence,
      );
    }
    beamXY(
      `bridge-frame-bottom-${depthId}`,
      `Нижний пояс ${sideName} верхней рамы`,
      -span.value / 2,
      upperFrameBottomY,
      span.value / 2,
      upperFrameBottomY,
      z,
      chordSize,
      "#355270",
      frameBottomOffset.evidence,
    );
    beamXY(
      `bridge-frame-top-${depthId}`,
      `Верхний пояс ${sideName} верхней рамы`,
      -span.value / 2,
      roofY,
      span.value / 2,
      roofY,
      z,
      chordSize,
      "#355270",
      frameHeight.evidence,
    );
    for (let panel = 0; panel <= panelCount; panel += 1) {
      const x = -span.value / 2 + panel * panelWidth;
      parts.push(
        box(
          `bridge-frame-post-${depthId}-${panel}`,
          `Стойка ${sideName} верхней рамы ${panel + 1}`,
          { x, y: upperFrameBottomY + frameHeight.value / 2, z },
          { x: postSize, y: frameHeight.value, z: postSize },
          "#4f6d8f",
          frameStep.evidence,
        ),
      );
      parts.push(
        box(
          `bridge-guard-post-${depthId}-${panel}`,
          `Стойка ${sideName} ограждения ${panel + 1}`,
          { x, y: floorY + guardHeight.value / 2, z },
          { x: fromMillimeters(65), y: guardHeight.value, z: fromMillimeters(65) },
          "#4f6d8f",
          guardHeight.evidence,
        ),
      );
    }
  }
  for (let cross = 0; cross <= panelCount; cross += 2) {
    const x = -span.value / 2 + cross * panelWidth;
    parts.push(
      box(
        `bridge-crossbeam-${cross}`,
        `Поперечная балка пола ${cross / 2 + 1}`,
        { x, y: floorY - deckThickness.value - chordSize / 2, z: 0 },
        { x: chordSize, y: chordSize, z: walkway.value + postSize * 2 },
        "#5d83b5",
        geometryEvidence,
      ),
    );
  }
  for (let frame = 0; frame <= panelCount; frame += 1) {
    const x = -span.value / 2 + frame * panelWidth;
    parts.push(
      box(
        `bridge-roof-frame-${frame}`,
        `Поперечная рама кровли ${frame + 1}`,
        { x, y: roofY - chordSize, z: 0 },
        { x: postSize, y: postSize, z: walkway.value + postSize * 2 },
        "#355270",
        geometryEvidence,
      ),
    );
  }

  for (const side of [-1, 1]) {
    const sideId = side < 0 ? "left" : "right";
    const sideLabel = side < 0 ? "Левая" : "Правая";
    const sideMale = side < 0 ? "Левый" : "Правый";
    const innerX = (side * span.value) / 2;
    const outerX = overallLength
      ? (side * overallLength.value) / 2
      : side * (span.value / 2 + towerLength.value);
    const towerCenterX = overallLength
      ? side * (overallLength.value / 2 - towerLength.value / 2)
      : (innerX + outerX) / 2;
    const innerColumnX = innerX + side * fromMillimeters(550);
    const outerColumnX = outerX - side * fromMillimeters(550);
    const columnSize = fromMillimeters(260);
    const depthMargin = Math.max(
      fromMillimeters(250),
      (towerDepth.value - stairRun.value - fromMillimeters(6_000)) / 2,
    );
    const zFrames = [
      -towerDepth.value / 2 + depthMargin,
      -towerDepth.value / 2 + depthMargin + fromMillimeters(3_000),
      towerDepth.value / 2 - depthMargin - fromMillimeters(3_000),
      towerDepth.value / 2 - depthMargin,
    ];
    const canopyDepth = towerDepth.value + fromMillimeters(300);
    const canopyRadians = (side * canopyAngle * Math.PI) / 180;
    const canopyLowY = floorY + fromMillimeters(1_300);
    const canopyCenterY = canopyLowY + (Math.tan((canopyAngle * Math.PI) / 180) * canopyDepth) / 2;
    const canopyYAt = (z: number) => canopyCenterY - Math.tan(canopyRadians) * z;
    for (const [columnX, columnId, xName] of [
      [innerColumnX, "inner", "внутренняя"],
      [outerColumnX, "outer", "наружная"],
    ] as const) {
      for (let frame = 0; frame < zFrames.length; frame += 1) {
        const z = zFrames[frame];
        const height = Math.max(floorY, canopyYAt(z) - fromMillimeters(80));
        parts.push(
          box(
            `tower-column-${sideId}-${columnId}-${frame}`,
            `${sideLabel} ${xName} стойка башни ${frame + 1}`,
            { x: columnX, y: height / 2, z },
            { x: columnSize, y: height, z: columnSize },
            "#4f6d8f",
            `четыре рамные оси по цепочке 3000 + ${stairRun.value} + 3000; ${liftHeight.evidence}`,
          ),
        );
        parts.push(
          box(
            `tower-foundation-${sideId}-${columnId}-${frame}`,
            `${sideLabel} отдельный фундамент стойки ${frame + 1}`,
            { x: columnX, y: -foundationHeight.value / 2, z },
            { x: fromMillimeters(2_200), y: foundationHeight.value, z: fromMillimeters(2_200) },
            "#6b7280",
            foundationHeight.evidence,
          ),
        );
      }
    }

    const towerBeamSize = fromMillimeters(160);
    for (let level = 1; level <= stairFlightCount; level += 1) {
      const y = level * stairRise;
      for (const [columnX, columnId] of [
        [innerColumnX, "inner"],
        [outerColumnX, "outer"],
      ] as const) {
        parts.push(
          box(
            `tower-frame-long-${sideId}-${columnId}-${level}`,
            `${sideLabel} продольная балка уровня ${level}`,
            { x: columnX, y, z: 0 },
            { x: towerBeamSize, y: towerBeamSize, z: zFrames[3] - zFrames[0] },
            "#355270",
            geometryEvidence,
          ),
        );
      }
      for (let frame = 0; frame < zFrames.length; frame += 1) {
        parts.push(
          box(
            `tower-frame-cross-${sideId}-${level}-${frame}`,
            `${sideLabel} поперечная балка уровня ${level}.${frame + 1}`,
            { x: (innerColumnX + outerColumnX) / 2, y, z: zFrames[frame] },
            { x: Math.abs(outerColumnX - innerColumnX), y: towerBeamSize, z: towerBeamSize },
            "#355270",
            geometryEvidence,
          ),
        );
      }
    }

    const landingDepth = fromMillimeters(3_000);
    const stairGap = fromMillimeters(300);
    const stairPairWidth = stairWidth.value * 2 + stairGap;
    const stairZoneCenterX = towerCenterX;
    const flightOffsetX = (stairWidth.value + stairGap) / 2;
    const endLandingZ = stairRun.value / 2 + landingDepth / 2;
    const railingSize = fromMillimeters(48);
    const railingHeight = fromMillimeters(1_150);
    const railingOffsets = [230, 460, 690, 920, 1_150].map(fromMillimeters);
    for (let level = 0; level <= stairFlightCount; level += 1) {
      const atPositiveEnd = level % 2 === 1;
      const landingXSize =
        level === stairFlightCount ? towerLength.value : stairPairWidth + fromMillimeters(400);
      parts.push(
        box(
          `tower-landing-${sideId}-${level}`,
          `${sideLabel} лестничная площадка уровня ${level}`,
          {
            x: towerCenterX,
            y: level * stairRise - deckThickness.value / 2,
            z: (atPositiveEnd ? 1 : -1) * endLandingZ,
          },
          { x: landingXSize, y: deckThickness.value, z: landingDepth },
          "#6f8fb5",
          level === stairFlightCount ? liftHeight.evidence : stairRun.evidence,
        ),
      );
      const landingStartZ = ((atPositiveEnd ? 1 : -1) * stairRun.value) / 2;
      const landingEndZ = (atPositiveEnd ? 1 : -1) * (stairRun.value / 2 + landingDepth);
      for (const edge of [-1, 1]) {
        const railX = stairZoneCenterX + edge * (stairPairWidth / 2 - railingSize / 2);
        railingOffsets.forEach((offset, rail) =>
          beamYZ(
            `tower-landing-rail-${sideId}-${level}-${edge < 0 ? "a" : "b"}-${rail}`,
            `${sideLabel} ригель ограждения площадки ${level}.${rail + 1}`,
            railX,
            level * stairRise + offset,
            landingStartZ,
            level * stairRise + offset,
            landingEndZ,
            railingSize,
            "#4f6d8f",
            "Ограждения площадок показаны на обоих поперечных видах DWG.",
          ),
        );
        parts.push(
          box(
            `tower-landing-post-${sideId}-${level}-${edge < 0 ? "a" : "b"}`,
            `${sideLabel} стойка ограждения площадки ${level}`,
            {
              x: railX,
              y: level * stairRise + railingHeight / 2,
              z: (landingStartZ + landingEndZ) / 2,
            },
            { x: railingSize, y: railingHeight, z: railingSize },
            "#4f6d8f",
            "Средние стойки ограждений видны в поперечных проекциях.",
          ),
        );
      }
    }

    for (let flight = 0; flight < stairFlightCount; flight += 1) {
      const forward = flight % 2 === 0;
      const flightX = stairZoneCenterX + (forward ? -side : side) * flightOffsetX;
      for (const stringerSide of [-1, 1]) {
        const stringerX = flightX + stringerSide * (stairWidth.value / 2 - fromMillimeters(120));
        parts.push(
          box(
            `tower-stair-stringer-${sideId}-${flight}-${stringerSide < 0 ? "a" : "b"}`,
            `${sideMale} косоур марша ${flight + 1}`,
            { x: stringerX, y: flight * stairRise + stairRise / 2, z: 0 },
            { x: fromMillimeters(180), y: stairThickness, z: stairLength },
            "#5d83b5",
            `Два раздельных косоура видны под ступенями; ${stairRun.evidence}`,
            { x: forward ? -stairAngle : stairAngle, y: 0, z: 0 },
          ),
        );
      }
      for (let tread = 0; tread < treadCount; tread += 1) {
        const progress = (tread + 0.5) / treadCount;
        const z = forward
          ? -stairRun.value / 2 + progress * stairRun.value
          : stairRun.value / 2 - progress * stairRun.value;
        const y = flight * stairRise + ((tread + 1) / treadCount) * stairRise;
        parts.push(
          box(
            `tower-tread-${sideId}-${flight}-${tread}`,
            `${sideLabel} ступень ${flight * treadCount + tread + 1}`,
            { x: flightX, y, z },
            {
              x: stairWidth.value,
              y: fromMillimeters(90),
              z: stairRun.value / treadCount + fromMillimeters(20),
            },
            "#a2b4c8",
            stairRun.evidence,
          ),
        );
      }
      const startZ = forward ? -stairRun.value / 2 : stairRun.value / 2;
      const endZ = -startZ;
      const startY = flight * stairRise;
      const endY = (flight + 1) * stairRise;
      for (const edge of [-1, 1]) {
        const railX = flightX + edge * (stairWidth.value / 2 - railingSize / 2);
        railingOffsets.forEach((offset, rail) =>
          beamYZ(
            `tower-stair-rail-${sideId}-${flight}-${edge < 0 ? "a" : "b"}-${rail}`,
            `${sideLabel} поручень марша ${flight + 1}.${rail + 1}`,
            railX,
            startY + offset,
            startZ,
            endY + offset,
            endZ,
            railingSize,
            "#4f6d8f",
            "Пять параллельных ригелей проходят вдоль обоих краёв каждого марша.",
          ),
        );
        for (let baluster = 0; baluster < 4; baluster += 1) {
          const progress = baluster / 3;
          const z = startZ + (endZ - startZ) * progress;
          const baseY = startY + (endY - startY) * progress;
          parts.push(
            box(
              `tower-stair-post-${sideId}-${flight}-${edge < 0 ? "a" : "b"}-${baluster}`,
              `${sideLabel} стойка поручня марша ${flight + 1}`,
              { x: railX, y: baseY + railingHeight / 2, z },
              { x: railingSize, y: railingHeight, z: railingSize },
              "#4f6d8f",
              "Вертикальные стойки поручней прочитаны по поперечным видам.",
            ),
          );
        }
      }
    }

    const liftSize = walkway.value;
    const liftX = towerCenterX;
    const liftZ = -side * (towerDepth.value / 2 + liftSize / 2 + fromMillimeters(750));
    const liftShaftHeight = roofY;
    parts.push(
      box(
        `tower-lift-${sideId}`,
        `${sideLabel} внешняя шахта подъёмника`,
        { x: liftX, y: liftShaftHeight / 2, z: liftZ },
        { x: liftSize, y: liftShaftHeight, z: liftSize },
        "#8ba4bf",
        `шахта вынесена за габарит башни по плану; ${walkway.evidence}`,
      ),
    );
    const liftFrameSize = fromMillimeters(150);
    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        parts.push(
          box(
            `tower-lift-post-${sideId}-${xSign < 0 ? "a" : "b"}-${zSign < 0 ? "a" : "b"}`,
            `${sideLabel} стойка каркаса подъёмника`,
            {
              x: liftX + (xSign * liftSize) / 2,
              y: liftShaftHeight / 2,
              z: liftZ + (zSign * liftSize) / 2,
            },
            { x: liftFrameSize, y: liftShaftHeight, z: liftFrameSize },
            "#355270",
            "Контур каркаса шахты показан на плане и поперечном виде.",
          ),
        );
      }
    }
    [fromMillimeters(150), floorY / 2, floorY, liftShaftHeight - fromMillimeters(150)].forEach(
      (y, ring) => {
        for (const zSign of [-1, 1])
          parts.push(
            box(
              `tower-lift-ring-x-${sideId}-${ring}-${zSign < 0 ? "a" : "b"}`,
              `${sideLabel} горизонтальная рама подъёмника`,
              { x: liftX, y, z: liftZ + (zSign * liftSize) / 2 },
              { x: liftSize, y: liftFrameSize, z: liftFrameSize },
              "#355270",
              "Горизонтальные деления шахты показаны на поперечном виде.",
            ),
          );
        for (const xSign of [-1, 1])
          parts.push(
            box(
              `tower-lift-ring-z-${sideId}-${ring}-${xSign < 0 ? "a" : "b"}`,
              `${sideLabel} поперечная рама подъёмника`,
              { x: liftX + (xSign * liftSize) / 2, y, z: liftZ },
              { x: liftFrameSize, y: liftFrameSize, z: liftSize },
              "#355270",
              "Горизонтальные деления шахты показаны на поперечном виде.",
            ),
          );
      },
    );
    parts.push(
      box(
        `tower-lift-foundation-${sideId}`,
        `${sideLabel} фундамент подъёмника`,
        { x: liftX, y: -foundationHeight.value / 2, z: liftZ },
        {
          x: liftSize + fromMillimeters(800),
          y: foundationHeight.value,
          z: liftSize + fromMillimeters(800),
        },
        "#6b7280",
        foundationHeight.evidence,
      ),
    );
    parts.push(
      box(
        `tower-canopy-${sideId}`,
        `${sideMale} наклонный навес`,
        { x: towerCenterX, y: canopyCenterY, z: 0 },
        { x: towerLength.value + fromMillimeters(600), y: fromMillimeters(160), z: canopyDepth },
        "#4f7096",
        `угол навеса ${canopyAngle}° по DWG`,
        { x: side * canopyAngle, y: 0, z: 0 },
      ),
    );
    for (const [edgeX, edgeId] of [
      [innerColumnX, "inner"],
      [outerColumnX, "outer"],
    ] as const) {
      beamYZ(
        `tower-canopy-edge-${sideId}-${edgeId}`,
        `${sideLabel} продольная балка навеса`,
        edgeX,
        canopyYAt(-canopyDepth / 2),
        -canopyDepth / 2,
        canopyYAt(canopyDepth / 2),
        canopyDepth / 2,
        towerBeamSize,
        "#355270",
        `наклон ${canopyAngle}° по DWG`,
      );
    }
    zFrames.forEach((z, frame) =>
      parts.push(
        box(
          `tower-canopy-purlin-${sideId}-${frame}`,
          `${sideLabel} поперечная балка навеса ${frame + 1}`,
          { x: towerCenterX, y: canopyYAt(z) - fromMillimeters(80), z },
          { x: towerLength.value + fromMillimeters(600), y: towerBeamSize, z: towerBeamSize },
          "#355270",
          "Четыре опорные оси навеса соответствуют рамным осям башни.",
        ),
      ),
    );

    const braceLevelHeight = floorY / 2;
    for (const [braceX, braceId] of [
      [innerColumnX, "inner"],
      [outerColumnX, "outer"],
    ] as const) {
      for (let level = 0; level < 2; level += 1) {
        const lowY = level * braceLevelHeight + fromMillimeters(250);
        const highY = (level + 1) * braceLevelHeight - fromMillimeters(250);
        for (const bay of [0, 2]) {
          beamYZ(
            `tower-brace-${sideId}-${braceId}-${level}-${bay}-a`,
            `${sideMale} раскос крайнего пролёта`,
            braceX,
            lowY,
            zFrames[bay],
            highY,
            zFrames[bay + 1],
            postSize,
            "#4f6d8f",
            geometryEvidence,
          );
          beamYZ(
            `tower-brace-${sideId}-${braceId}-${level}-${bay}-b`,
            `${sideMale} встречный раскос крайнего пролёта`,
            braceX,
            lowY,
            zFrames[bay + 1],
            highY,
            zFrames[bay],
            postSize,
            "#4f6d8f",
            geometryEvidence,
          );
        }
      }
    }
  }

  const warning =
    "Геометрия надземного перехода собрана детерминированным решателем: ИИ определил смысл и размеры, программа рассчитала позиции, симметрию и соединения.";
  const warnings = Array.isArray(model.warnings)
    ? model.warnings.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...model,
    title: analysis.objectName,
    unit: analysis.unit,
    status: "needs_input",
    summary:
      "Детализированный 3D-черновик надземного перехода собран по главному виду, плану и двум поперечным видам: раздельные верхняя рама и ограждение пролёта, три марша с косоурами, ступенями и поручнями, площадочные ограждения, рамные балки, Х-связи, отдельные фундаменты, каркасы подъёмников и навесы 15°.",
    parts,
    overallConfidence: confidence,
    canExport: false,
    warnings: warnings.includes(warning) ? warnings : [...warnings, warning],
  };
}

export function needsTopologyRepair(analysis: DrawingAnalysis, model: Record<string, unknown>) {
  const solidFeatures = analysis.features.filter((feature) => feature.kind === "solid").length;
  const parts = Array.isArray(model.parts) ? model.parts.length : 0;
  if (solidFeatures < 4) return false;
  const minimumParts = Math.min(8, Math.max(4, Math.ceil(solidFeatures * 0.75)));
  return parts < minimumParts;
}

export function sanitizeAiModel(model: Record<string, unknown>) {
  const positive = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  const parts = Array.isArray(model.parts) ? model.parts : [];
  const validParts = parts
    .filter((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const part = value as Record<string, unknown>;
      if (part.kind === "box") {
        const size =
          part.size && typeof part.size === "object" ? (part.size as Record<string, unknown>) : {};
        return positive(size.x) && positive(size.y) && positive(size.z);
      }
      if (part.kind === "cylinder") return positive(part.radius) && positive(part.height);
      if (part.kind === "extrusion")
        return positive(part.height) && Array.isArray(part.profile) && part.profile.length >= 3;
      if (part.kind === "revolution")
        return Array.isArray(part.profile) && part.profile.length >= 2;
      return false;
    })
    .map((value) => {
      const part = value as Record<string, unknown>;
      const normalized = { ...part, vertices: [], faces: [] };
      if (part.kind === "box" || part.kind === "cylinder")
        return { ...normalized, profile: [], holes: [] };
      if (part.kind === "revolution") return { ...normalized, holes: [] };
      return {
        ...normalized,
        holes: Array.isArray(part.holes)
          ? part.holes.filter((hole) => Array.isArray(hole) && hole.length >= 3)
          : [],
      };
    });
  if (validParts.length === parts.length) return { ...model, parts: validParts };
  const warning = `Строгая проверка удалила ${parts.length - validParts.length} деталей с нулевыми или неполными размерами.`;
  const warnings = Array.isArray(model.warnings)
    ? model.warnings.filter((value): value is string => typeof value === "string").slice(0, 39)
    : [];
  return {
    ...model,
    parts: validParts,
    status: "needs_input",
    canExport: false,
    warnings: warnings.includes(warning) ? warnings : [...warnings, warning],
  };
}
