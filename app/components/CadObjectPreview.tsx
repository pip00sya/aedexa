"use client";
import { hex, shade } from "../lib/render/color";

import {
  cadObjectRules,
  cadPathWidthMeters,
  isPointCadObject,
  resolveCadObjectHeight,
} from "../lib/cad/objectRules";
import {
  cadKindMeta,
  type CadFeature,
  type CadKind,
  type CadSemanticStatus,
} from "../lib/cad/types";

/** Миниатюра объекта */

type Point = { x: number; y: number };
type Point3 = Point & { z: number };

type CadObjectPreviewProps = {
  kind: CadKind;
  feature?: CadFeature;
  /** Единиц чертежа в метре */
  unitsPerMeter?: number;
  status?: CadSemanticStatus;
  width?: number;
  height?: number;
  className?: string;
  title?: string;
};

const ISO_X = Math.cos(Math.PI / 6);
const ISO_Y = Math.sin(Math.PI / 6);
const MAX_PREVIEW_POINTS = 96;

/** Цвет крыши как в 3D-сцене */
function roofColor(feature?: CadFeature) {
  const source = feature?.sourceColor;
  if (source === undefined || source < 0 || source > 0xffffff) return 0xb85c2d;
  const r = ((source >> 16) & 255) / 255;
  const g = ((source >> 8) & 255) / 255;
  const b = (source & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta > 0) {
    hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  saturation = Math.max(0.42, saturation);
  const light = Math.min(0.74, lightness);
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = light - chroma / 2;
  const [cr, cg, cb] =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second];
  return (
    (Math.round((cr + base) * 255) << 16) |
    (Math.round((cg + base) * 255) << 8) |
    Math.round((cb + base) * 255)
  );
}

/** Типовая геометрия для класса, когда объекта из чертежа нет под рукой (в метрах) */
function syntheticPoints(kind: CadKind): { points: Point[]; closed: boolean } {
  const rect = (w: number, h: number): Point[] => [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  switch (kind) {
    case "building":
      return { points: rect(6, 4), closed: true };
    case "site":
      return { points: rect(6, 5), closed: true };
    case "water":
      return {
        points: [
          { x: 0, y: 1 },
          { x: 2, y: 0 },
          { x: 5, y: 0.5 },
          { x: 6, y: 3 },
          { x: 4, y: 4.5 },
          { x: 1, y: 4 },
        ],
        closed: true,
      };
    case "road":
      return {
        points: [
          { x: 0, y: 0 },
          { x: 8, y: 0.6 },
        ],
        closed: false,
      };
    case "fence":
      return {
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 3 },
        ],
        closed: false,
      };
    case "vegetation":
    case "pole":
    case "sign":
    case "manhole":
    case "waste":
      return { points: [{ x: 0, y: 0 }], closed: false };
    case "terrain":
      return {
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 1.2 },
          { x: 4, y: 0.8 },
          { x: 6, y: 1.6 },
          { x: 8, y: 1 },
        ],
        closed: false,
      };
    default:
      return {
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0.4 },
          { x: 8, y: 0 },
        ],
        closed: false,
      };
  }
}

function decimate(points: CadFeature["points"]): Point[] {
  if (points.length <= MAX_PREVIEW_POINTS) return points;
  const step = points.length / MAX_PREVIEW_POINTS;
  return Array.from(
    { length: MAX_PREVIEW_POINTS },
    (_, index) => points[Math.min(points.length - 1, Math.floor(index * step))],
  );
}

export default function CadObjectPreview({
  kind,
  feature,
  unitsPerMeter = 1,
  status,
  width = 56,
  height = 44,
  className,
  title,
}: CadObjectPreviewProps) {
  const rule = cadObjectRules[kind];
  const meta = cadKindMeta[kind];
  const source =
    feature && feature.points.length
      ? { points: decimate(feature.points), closed: feature.closed }
      : undefined;
  const upm = source ? unitsPerMeter : 1;
  const geometry = source ?? syntheticPoints(kind);
  const pointLike = feature ? isPointCadObject(feature) : Boolean(rule.pointLike);
  const heightMeters = feature
    ? (resolveCadObjectHeight(feature).heightMeters ?? 0)
    : (rule.defaultHeightMeters ?? 0);
  const objectHeight = heightMeters * upm;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of geometry.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY, (pointLike ? 3 : 2) * upm);
  const verticalExtent = extent + Math.max(objectHeight, 0);
  const scale = Math.min((width * 0.82) / (2 * ISO_X * extent), (height * 0.62) / verticalExtent);
  const originX = width / 2;
  const originY = height * 0.64;
  const project = ({ x, y, z }: Point3) => ({
    x: originX + (x - centerX - (y - centerY)) * ISO_X * scale,
    y: originY - (x - centerX + (y - centerY)) * ISO_Y * scale - z * scale,
  });
  const path = (points: Point3[], close = true) =>
    points
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${project(point).x.toFixed(1)} ${project(point).y.toFixed(1)}`,
      )
      .join(" ") + (close ? " Z" : "");
  const ground = geometry.points.map((point) => ({ ...point, z: 0 }));
  const kindColor = hex(meta.color);
  const dashed = status === "planned";
  const strokeDash = dashed ? "3 2" : undefined;
  const label = title ?? `${meta.label}: миниатюра объекта`;
  const shapes: React.ReactNode[] = [];

  if (pointLike) {
    const center = project({ x: centerX, y: centerY, z: 0 });
    const top = project({ x: centerX, y: centerY, z: objectHeight });
    if (kind === "vegetation") {
      const crown = Math.max(6, objectHeight * scale * 0.45);
      shapes.push(
        <ellipse
          key="shadow"
          cx={center.x}
          cy={center.y}
          rx={crown * 0.9}
          ry={crown * 0.45}
          fill="#00000014"
        />,
        <line
          key="trunk"
          x1={center.x}
          y1={center.y}
          x2={top.x}
          y2={top.y + crown * 0.4}
          stroke="#7c4a24"
          strokeWidth={2.2}
          strokeLinecap="round"
        />,
        <circle
          key="crown"
          cx={top.x}
          cy={top.y + crown * 0.2}
          r={crown}
          fill="#22a447"
          stroke="#15803d"
          strokeWidth={0.8}
        />,
      );
    } else if (kind === "manhole") {
      shapes.push(
        <ellipse
          key="disc"
          cx={center.x}
          cy={center.y}
          rx={8}
          ry={4}
          fill={kindColor}
          stroke="#0f172a"
          strokeWidth={0.8}
        />,
      );
    } else if (kind === "waste") {
      const box = [
        { x: centerX - 0.5 * upm, y: centerY - 0.4 * upm },
        { x: centerX + 0.5 * upm, y: centerY - 0.4 * upm },
        { x: centerX + 0.5 * upm, y: centerY + 0.4 * upm },
        { x: centerX - 0.5 * upm, y: centerY + 0.4 * upm },
      ];
      shapes.push(...extrude(box, objectHeight, meta.color, meta.color, project, "box"));
    } else {
      shapes.push(
        <ellipse key="shadow" cx={center.x} cy={center.y} rx={4} ry={2} fill="#00000014" />,
        <line
          key="post"
          x1={center.x}
          y1={center.y}
          x2={top.x}
          y2={top.y}
          stroke={kindColor}
          strokeWidth={2.4}
          strokeLinecap="round"
        />,
      );
      if (kind === "sign") {
        shapes.push(
          <rect
            key="board"
            x={top.x - 6}
            y={top.y - 2}
            width={12}
            height={9}
            rx={1.5}
            fill={kindColor}
            stroke="#1e3a8a"
            strokeWidth={0.8}
          />,
        );
      } else if (kind === "pole") {
        shapes.push(<circle key="lamp" cx={top.x} cy={top.y} r={2.4} fill="#facc15" />);
      }
    }
  } else if (geometry.closed && geometry.points.length >= 3) {
    if (kind === "building") {
      shapes.push(
        <path
          key="plan"
          d={path(ground)}
          fill="#0000000d"
          stroke="#64748b"
          strokeWidth={0.7}
          strokeDasharray={strokeDash}
        />,
      );
      shapes.push(
        ...extrude(
          geometry.points,
          objectHeight,
          meta.color,
          roofColor(feature),
          project,
          "building",
        ),
      );
    } else {
      const fill = kind === "road" || kind === "site" || kind === "water" ? meta.color : meta.color;
      shapes.push(
        <path
          key="area"
          d={path(ground)}
          fill={hex(fill)}
          fillOpacity={kind === "water" ? 0.75 : 0.85}
          stroke={hex(shade(fill, 0.7))}
          strokeWidth={0.9}
          strokeDasharray={strokeDash}
          strokeLinejoin="round"
        />,
      );
      if (kind === "fence" && objectHeight > 0) {
        shapes.push(
          ...panels([...geometry.points, geometry.points[0]], objectHeight, meta.color, project),
        );
      }
    }
  } else if (geometry.points.length >= 2) {
    if (kind === "fence" && objectHeight > 0) {
      shapes.push(
        <path
          key="plan"
          d={path(ground, false)}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={0.8}
          strokeDasharray={strokeDash}
        />,
      );
      shapes.push(...panels(geometry.points, objectHeight, meta.color, project));
    } else if (kind === "road" || kind === "curb") {
      const widthUnits = (feature ? cadPathWidthMeters(feature) : 3.4) * upm;
      shapes.push(
        <path
          key="strip"
          d={path(ribbon(geometry.points, Math.max(widthUnits, extent * 0.06)))}
          fill={kindColor}
          fillOpacity={0.9}
          stroke={hex(shade(meta.color, 0.7))}
          strokeWidth={0.7}
          strokeLinejoin="round"
        />,
      );
    } else {
      const lifted =
        kind === "wire"
          ? geometry.points.map((point) => ({ ...point, z: Math.max(objectHeight, 6 * upm) }))
          : ground;
      if (kind === "wire") {
        shapes.push(
          <path
            key="shadow"
            d={path(ground, false)}
            fill="none"
            stroke="#94a3b8"
            strokeWidth={0.6}
            strokeDasharray="2 2"
          />,
        );
      }
      shapes.push(
        <path
          key="line"
          d={path(lifted, false)}
          fill="none"
          stroke={kindColor}
          strokeWidth={kind === "terrain" || kind === "wire" ? 1.4 : 2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={
            kind === "boundary"
              ? "4 2"
              : kind === "unknown" || kind === "annotation"
                ? "2 2"
                : strokeDash
          }
        />,
      );
    }
  }

  if (status === "demolition") {
    shapes.push(
      <line
        key="x1"
        x1={4}
        y1={4}
        x2={width - 4}
        y2={height - 4}
        stroke="#dc2626"
        strokeWidth={1.6}
        strokeLinecap="round"
      />,
      <line
        key="x2"
        x1={width - 4}
        y1={4}
        x2={4}
        y2={height - 4}
        stroke="#dc2626"
        strokeWidth={1.6}
        strokeLinecap="round"
      />,
    );
  }

  return (
    <svg
      className={`cad-object-preview${className ? ` ${className}` : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {shapes}
    </svg>
  );
}

type Projector = (point: Point3) => { x: number; y: number };

/** Стены по контуру от дальних к ближним и крыша сверху */
function extrude(
  points: Point[],
  objectHeight: number,
  wallColor: number,
  topColor: number,
  project: Projector,
  keyPrefix: string,
) {
  const shapes: React.ReactNode[] = [];
  if (!(objectHeight > 0)) {
    shapes.push(
      <path
        key={`${keyPrefix}-flat`}
        d={polygonPath(
          points.map((point) => ({ ...point, z: 0 })),
          project,
        )}
        fill={hex(topColor)}
        stroke={hex(shade(topColor, 0.7))}
        strokeWidth={0.8}
      />,
    );
    return shapes;
  }
  const edges = points
    .map((point, index) => ({ from: point, to: points[(index + 1) % points.length] }))
    .map((edge) => ({ ...edge, depth: edge.from.x + edge.from.y + edge.to.x + edge.to.y }))
    .sort((left, right) => right.depth - left.depth);
  edges.forEach((edge, index) => {
    const angle = Math.atan2(edge.to.y - edge.from.y, edge.to.x - edge.from.x);
    const light = 0.72 + 0.28 * ((Math.cos(angle - Math.PI * 0.75) + 1) / 2);
    const quad = [
      { ...edge.from, z: 0 },
      { ...edge.to, z: 0 },
      { ...edge.to, z: objectHeight },
      { ...edge.from, z: objectHeight },
    ];
    shapes.push(
      <path
        key={`${keyPrefix}-wall-${index}`}
        d={polygonPath(quad, project)}
        fill={hex(shade(wallColor, light))}
        stroke={hex(shade(wallColor, 0.6))}
        strokeWidth={0.5}
        strokeLinejoin="round"
      />,
    );
  });
  shapes.push(
    <path
      key={`${keyPrefix}-top`}
      d={polygonPath(
        points.map((point) => ({ ...point, z: objectHeight })),
        project,
      )}
      fill={hex(topColor)}
      stroke={hex(shade(topColor, 0.65))}
      strokeWidth={0.7}
      strokeLinejoin="round"
    />,
  );
  return shapes;
}

/** Панели забора вдоль ломаной, от дальних к ближним */
function panels(points: Point[], objectHeight: number, color: number, project: Projector) {
  const segments = points
    .slice(1)
    .map((point, index) => ({ from: points[index], to: point }))
    .map((segment) => ({
      ...segment,
      depth: segment.from.x + segment.from.y + segment.to.x + segment.to.y,
    }))
    .sort((left, right) => right.depth - left.depth);
  return segments.map((segment, index) => {
    const quad = [
      { ...segment.from, z: 0 },
      { ...segment.to, z: 0 },
      { ...segment.to, z: objectHeight },
      { ...segment.from, z: objectHeight },
    ];
    return (
      <path
        key={`panel-${index}`}
        d={polygonPath(quad, project)}
        fill={hex(color)}
        fillOpacity={0.55}
        stroke={hex(shade(color, 0.6))}
        strokeWidth={0.8}
        strokeLinejoin="round"
      />
    );
  });
}

/** Полоса заданной ширины вдоль ломаной */
function ribbon(points: Point[], widthUnits: number): Point3[] {
  const half = widthUnits / 2;
  const left: Point3[] = [];
  const right: Point3[] = [];
  points.forEach((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const length = Math.hypot(next.x - previous.x, next.y - previous.y) || 1;
    const nx = -(next.y - previous.y) / length;
    const ny = (next.x - previous.x) / length;
    left.push({ x: point.x + nx * half, y: point.y + ny * half, z: 0 });
    right.push({ x: point.x - nx * half, y: point.y - ny * half, z: 0 });
  });
  return [...left, ...right.reverse()];
}

function polygonPath(points: Point3[], project: Projector) {
  return (
    points
      .map((point, index) => {
        const { x, y } = project(point);
        return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ") + " Z"
  );
}
