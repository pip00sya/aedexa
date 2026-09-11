import type {
  CadDrawing,
  CadDrawingHatch,
  CadDrawingLabel,
  CadDrawingPath,
  CadDrawingPrimitive,
} from "./types";

/** Фон как в AutoCAD: темный, цвет 7 - белый */
export const CAD_DRAWING_BACKGROUND = "#1f2830";

export type CadDrawingView = {
  /** Пикселей на единицу чертежа */
  scale: number;
  /** Мировая точка, попадающая в центр холста */
  centerX: number;
  centerY: number;
  width: number;
  height: number;
};

export function hexColor(color: number) {
  return `#${Math.max(0, Math.min(0xffffff, Math.round(color)))
    .toString(16)
    .padStart(6, "0")}`;
}

export function lineWeightPixels(weightMm: number | undefined) {
  if (weightMm === undefined || !Number.isFinite(weightMm) || weightMm <= 0.25) return 1;
  return Math.min(24, Math.round(weightMm * 6.7));
}

export function bulgeArcPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  bulge: number,
  maxStepRadians = Math.PI / 16,
) {
  if (!bulge || !Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return [];
  const chordX = to.x - from.x;
  const chordY = to.y - from.y;
  const chord = Math.hypot(chordX, chordY);
  if (chord < 1e-12) return [];
  const theta = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const apothem = Math.sqrt(Math.max(radius * radius - (chord / 2) * (chord / 2), 0));
  const side = bulge > 0 ? 1 : -1;
  const nx = (-chordY / chord) * side;
  const ny = (chordX / chord) * side;
  const centerX = midX + nx * apothem * (Math.abs(theta) > Math.PI ? -1 : 1);
  const centerY = midY + ny * apothem * (Math.abs(theta) > Math.PI ? -1 : 1);
  const startAngle = Math.atan2(from.y - centerY, from.x - centerX);
  const steps = Math.max(2, Math.ceil(Math.abs(theta) / maxStepRadians));
  const result: Array<{ x: number; y: number }> = [];
  for (let index = 1; index < steps; index += 1) {
    const angle = startAngle + (theta * index) / steps;
    result.push({ x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) });
  }
  return result;
}

/** Развертывает полилинию с выпуклостями в ломаную */
export function expandBulges<T extends { x: number; y: number }>(
  points: T[],
  bulges: number[],
  closed: boolean,
): Array<T | { x: number; y: number }> {
  const result: Array<T | { x: number; y: number }> = [];
  const count = closed ? points.length : points.length - 1;
  for (let index = 0; index < points.length; index += 1) {
    result.push(points[index]);
    if (index >= count) continue;
    const next = points[(index + 1) % points.length];
    result.push(...bulgeArcPoints(points[index], next, bulges[index] ?? 0));
  }
  return result;
}

/** Строки многострочного текста без кодов форматирования */
export function mtextLines(raw: string): string[] {
  return raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/gu, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\S([^;]*);/gu, (_match, stack: string) => stack.replace(/[#^]/gu, "/"))
    .replace(/\\[ACFHQTWfhpqtw][^;]*;/gu, "")
    .replace(/\\[LlOoKk]/gu, "")
    .replace(/%%[dD]/gu, "°")
    .replace(/%%[cC]/gu, "⌀")
    .replace(/%%[pP]/gu, "±")
    .replace(/%%[uUoO]/gu, "")
    .replace(/[{}]/gu, "")
    .replace(/\\~/gu, " ")
    .split(/\\P/u)
    .map((line) => line.replace(/\\\\/gu, "\\").trim())
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function primitiveBounds(primitive: CadDrawingPrimitive): Bounds {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };
  if (primitive.t === "path") {
    for (let index = 0; index + 1 < primitive.pts.length; index += 2)
      add(primitive.pts[index], primitive.pts[index + 1]);
  } else if (primitive.t === "hatch") {
    for (const loop of primitive.loops)
      for (let index = 0; index + 1 < loop.length; index += 2) add(loop[index], loop[index + 1]);
  } else {
    const reach =
      primitive.h *
      Math.max(1, ...(primitive.lines ?? [primitive.text]).map((line) => line.length * 0.7));
    add(primitive.x - reach, primitive.y - reach * 0.6);
    add(primitive.x + reach, primitive.y + reach * 0.6);
  }
  return bounds;
}

function worldToScreen(view: CadDrawingView) {
  return {
    x: (value: number) => (value - view.centerX) * view.scale + view.width / 2,
    y: (value: number) => (view.centerY - value) * view.scale + view.height / 2,
  };
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  pts: number[],
  closed: boolean,
  toX: (v: number) => number,
  toY: (v: number) => number,
) {
  ctx.beginPath();
  for (let index = 0; index + 1 < pts.length; index += 2) {
    const x = toX(pts[index]);
    const y = toY(pts[index + 1]);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  if (closed) ctx.closePath();
}

function drawHatch(
  ctx: CanvasRenderingContext2D,
  hatch: CadDrawingHatch,
  view: CadDrawingView,
  toX: (v: number) => number,
  toY: (v: number) => number,
  bounds: Bounds,
) {
  ctx.save();
  ctx.beginPath();
  for (const loop of hatch.loops) {
    for (let index = 0; index + 1 < loop.length; index += 2) {
      const x = toX(loop[index]);
      const y = toY(loop[index + 1]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  const color = hexColor(hatch.color);
  if (hatch.solid || !hatch.lines.length) {
    ctx.fillStyle = color;
    ctx.globalAlpha = hatch.solid ? 1 : 0.18;
    ctx.fill("evenodd");
    ctx.restore();
    return;
  }
  ctx.clip("evenodd");
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.7;
  const screenBounds = {
    minX: toX(bounds.minX),
    maxX: toX(bounds.maxX),
    minY: toY(bounds.maxY),
    maxY: toY(bounds.minY),
  };
  const diagonal = Math.hypot(
    screenBounds.maxX - screenBounds.minX,
    screenBounds.maxY - screenBounds.minY,
  );
  const centerX = (screenBounds.minX + screenBounds.maxX) / 2;
  const centerY = (screenBounds.minY + screenBounds.maxY) / 2;
  for (const family of hatch.lines) {
    const spacing = family.spacing * view.scale;
    if (!(spacing > 0)) continue;
    if (spacing < 2.2) {
      // Штрихи гуще пикселей сливаются в тон: рисуем полупрозрачную заливку
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.2;
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
      continue;
    }
    const angle = (-family.angle * Math.PI) / 180;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const normalX = -dirY;
    const normalY = dirX;
    const lineCount = Math.min(2_000, Math.ceil(diagonal / spacing) + 2);
    ctx.setLineDash(
      family.dashes.length
        ? family.dashes.map((dash) => Math.max(0.5, Math.abs(dash) * view.scale))
        : [],
    );
    ctx.beginPath();
    for (let index = -lineCount; index <= lineCount; index += 1) {
      const offset = index * spacing;
      const baseX = centerX + normalX * offset;
      const baseY = centerY + normalY * offset;
      ctx.moveTo(baseX - dirX * diagonal, baseY - dirY * diagonal);
      ctx.lineTo(baseX + dirX * diagonal, baseY + dirY * diagonal);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  item: CadDrawingLabel,
  view: CadDrawingView,
  toX: (v: number) => number,
  toY: (v: number) => number,
) {
  const heightPx = item.h * view.scale;
  if (heightPx < 2.5) return;
  ctx.save();
  ctx.translate(toX(item.x), toY(item.y));
  ctx.rotate((-item.rot * Math.PI) / 180);
  if (item.xs || item.ob)
    ctx.transform(item.xs ?? 1, 0, -Math.tan(((item.ob ?? 0) * Math.PI) / 180), 1, 0, 0);
  ctx.fillStyle = hexColor(item.color);
  ctx.font = `${heightPx.toFixed(2)}px "Arial Narrow", Arial, "Liberation Sans", sans-serif`;
  ctx.textAlign = item.halign;
  ctx.textBaseline = item.valign === "baseline" ? "alphabetic" : item.valign;
  const lines = item.lines ?? [item.text];
  const lineStep = heightPx * 1.67;
  const startOffset =
    item.valign === "top"
      ? 0
      : item.valign === "middle"
        ? -((lines.length - 1) * lineStep) / 2
        : -(lines.length - 1) * lineStep;
  lines.forEach((line, index) => {
    ctx.fillText(line, 0, startOffset + index * lineStep);
  });
  ctx.restore();
}

/** Рисует чертеж на холсте */
export function renderCadDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: CadDrawing,
  view: CadDrawingView,
  options: { background?: string; highlightLayer?: string } = {},
) {
  ctx.save();
  ctx.fillStyle = options.background ?? CAD_DRAWING_BACKGROUND;
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.restore();
  const { x: toX, y: toY } = worldToScreen(view);
  const visibleMinX = view.centerX - view.width / 2 / view.scale;
  const visibleMaxX = view.centerX + view.width / 2 / view.scale;
  const visibleMinY = view.centerY - view.height / 2 / view.scale;
  const visibleMaxY = view.centerY + view.height / 2 / view.scale;
  let drawn = 0;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const primitive of drawing.primitives) {
    const bounds = primitive.b;
    if (
      bounds[2] < visibleMinX ||
      bounds[0] > visibleMaxX ||
      bounds[3] < visibleMinY ||
      bounds[1] > visibleMaxY
    )
      continue;
    const widthPx = (bounds[2] - bounds[0]) * view.scale;
    const heightPx = (bounds[3] - bounds[1]) * view.scale;
    if (primitive.t !== "text" && widthPx < 0.3 && heightPx < 0.3 && drawn > 20_000) continue;
    drawn += 1;
    if (primitive.t === "path") {
      drawPath(ctx, primitive, view, toX, toY, options.highlightLayer);
    } else if (primitive.t === "hatch") {
      drawHatch(ctx, primitive, view, toX, toY, {
        minX: bounds[0],
        minY: bounds[1],
        maxX: bounds[2],
        maxY: bounds[3],
      });
    } else {
      drawText(ctx, primitive, view, toX, toY);
    }
  }
  return drawn;
}

function drawPath(
  ctx: CanvasRenderingContext2D,
  path: CadDrawingPath,
  view: CadDrawingView,
  toX: (v: number) => number,
  toY: (v: number) => number,
  highlightLayer?: string,
) {
  const color = hexColor(path.color);
  ctx.strokeStyle = color;
  ctx.globalAlpha = highlightLayer && path.layer !== highlightLayer ? 0.25 : 1;
  if (path.pts.length === 2) {
    // Точка (PDMODE 0): одна точка, как в AutoCAD
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(toX(path.pts[0]), toY(path.pts[1]), 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  const wide =
    path.width !== undefined &&
    path.width > 0 &&
    path.width * view.scale > lineWeightPixels(path.weight);
  ctx.lineWidth = wide
    ? Math.max(0.6, (path.width ?? 0) * view.scale)
    : lineWeightPixels(path.weight);
  ctx.setLineDash(
    path.dash && path.dash.length ? path.dash.map((dash) => Math.max(0.6, dash * view.scale)) : [],
  );
  tracePath(ctx, path.pts, path.closed, toX, toY);
  if (path.fill) {
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** Масштаб и центр, при которых заданная область целиком видна на холсте */
export function fitCadDrawingView(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
  margin = 0.04,
): CadDrawingView {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = Math.min((width * (1 - margin * 2)) / spanX, (height * (1 - margin * 2)) / spanY);
  return {
    scale,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    width,
    height,
  };
}

function escapeXml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function cadDrawingToSvg(drawing: CadDrawing, options: { background?: string } = {}) {
  const { bounds } = drawing;
  const width = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const parts: string[] = [];
  const defs: string[] = [];
  let patternIndex = 0;
  for (const primitive of drawing.primitives) {
    if (primitive.t === "path") {
      if (primitive.pts.length === 2) {
        parts.push(
          `<circle cx="${primitive.pts[0].toFixed(3)}" cy="${primitive.pts[1].toFixed(3)}" r="1.2" fill="${hexColor(primitive.color)}" vector-effect="non-scaling-stroke"/>`,
        );
        continue;
      }
      if (primitive.pts.length < 4) continue;
      const d =
        primitive.pts
          .map((value, index) =>
            index % 2 === 0 ? `${index ? "L" : "M"}${value.toFixed(3)}` : ` ${value.toFixed(3)}`,
          )
          .join("") + (primitive.closed ? " Z" : "");
      const wide = primitive.width !== undefined && primitive.width > 0;
      const stroke = wide
        ? `stroke-width="${primitive.width!.toFixed(4)}"`
        : `stroke-width="${lineWeightPixels(primitive.weight).toFixed(2)}" vector-effect="non-scaling-stroke"`;
      const dash =
        primitive.dash && primitive.dash.length
          ? ` stroke-dasharray="${primitive.dash.map((value) => value.toFixed(3)).join(" ")}"`
          : "";
      parts.push(
        `<path d="${d}" fill="${primitive.fill ? hexColor(primitive.color) : "none"}" stroke="${hexColor(primitive.color)}" ${stroke}${dash} stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    } else if (primitive.t === "hatch") {
      const d = primitive.loops
        .map(
          (loop) =>
            loop
              .map((value, index) =>
                index % 2 === 0
                  ? `${index ? "L" : "M"}${value.toFixed(3)}`
                  : ` ${value.toFixed(3)}`,
              )
              .join("") + " Z",
        )
        .join(" ");
      if (primitive.solid || !primitive.lines.length) {
        parts.push(
          `<path d="${d}" fill="${hexColor(primitive.color)}" fill-opacity="${primitive.solid ? 1 : 0.18}" fill-rule="evenodd" stroke="none"/>`,
        );
        continue;
      }
      const family = primitive.lines[0];
      const spacing = Math.max(family.spacing, 1e-6);
      const id = `hatch-${(patternIndex += 1)}`;
      const dash = family.dashes.length
        ? ` stroke-dasharray="${family.dashes.map((value) => Math.abs(value).toFixed(3)).join(" ")}"`
        : "";
      defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${(spacing * 4).toFixed(4)}" height="${spacing.toFixed(4)}" patternTransform="rotate(${(-family.angle).toFixed(2)})"><line x1="0" y1="0" x2="${(spacing * 4).toFixed(4)}" y2="0" stroke="${hexColor(primitive.color)}" stroke-width="${(spacing * 0.06).toFixed(4)}"${dash}/></pattern>`,
      );
      parts.push(`<path d="${d}" fill="url(#${id})" fill-rule="evenodd" stroke="none"/>`);
    } else {
      const lines = primitive.lines ?? [primitive.text];
      const anchor =
        primitive.halign === "center" ? "middle" : primitive.halign === "right" ? "end" : "start";
      const baseline =
        primitive.valign === "middle"
          ? "middle"
          : primitive.valign === "top"
            ? "hanging"
            : "alphabetic";
      const lineStep = primitive.h * 1.67;
      const startOffset =
        primitive.valign === "top"
          ? 0
          : primitive.valign === "middle"
            ? -((lines.length - 1) * lineStep) / 2
            : -(lines.length - 1) * lineStep;
      const spans = lines
        .map(
          (line, index) =>
            `<tspan x="0" y="${(-(startOffset + index * lineStep)).toFixed(3)}">${escapeXml(line)}</tspan>`,
        )
        .join("");
      const shape =
        primitive.xs || primitive.ob
          ? ` skewX(${(-(primitive.ob ?? 0)).toFixed(2)}) scale(${(primitive.xs ?? 1).toFixed(3)} 1)`
          : "";
      parts.push(
        `<text transform="translate(${primitive.x.toFixed(3)} ${primitive.y.toFixed(3)}) rotate(${(-primitive.rot).toFixed(2)}) scale(1 -1)${shape}" font-size="${primitive.h.toFixed(4)}" font-family="Arial Narrow, Arial, sans-serif" fill="${hexColor(primitive.color)}" text-anchor="${anchor}" dominant-baseline="${baseline}">${spans}</text>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX.toFixed(3)} ${(-bounds.maxY).toFixed(3)} ${width.toFixed(3)} ${height.toFixed(3)}" width="${Math.round(Math.min(4000, width))}" height="${Math.round(Math.min(4000, height))}">
<rect x="${bounds.minX.toFixed(3)}" y="${(-bounds.maxY).toFixed(3)}" width="${width.toFixed(3)}" height="${height.toFixed(3)}" fill="${options.background ?? CAD_DRAWING_BACKGROUND}"/>
<defs>${defs.join("")}</defs>
<g transform="scale(1 -1)">
${parts.join("\n")}
</g>
</svg>`;
}
