import type { ImageContextKind, ImageContextObject, ImagePlanAnalysis, PlanSegment } from "./types";

const MAX_SIDE = 1200;
const MAX_SEGMENTS = 520;
const MAX_CONTEXT_OBJECTS = 28;

type CellClass = ImageContextKind | null;

function pixelClass(red: number, green: number, blue: number) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const saturation = maximum ? (maximum - minimum) / maximum : 0;
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return {
    vegetation: green > 48 && green > red * 1.06 && green > blue * 1.04 && saturation > 0.12,
    water: blue > 58 && blue > red * 1.09 && blue > green * 1.02 && saturation > 0.12,
    warmRoof: red > 65 && red > green * 1.05 && red > blue * 1.08 && saturation > 0.1,
    neutral: saturation < 0.17 && luminance > 64 && luminance < 232,
    colorful: saturation > 0.13 && luminance > 28,
    luminance,
  };
}

export function buildContextObjects(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  cellSize: number,
) {
  const columns = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const classes: CellClass[] = Array(columns * rows).fill(null);
  const strengths = new Float32Array(columns * rows);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = column * cellSize;
      const y0 = row * cellSize;
      const x1 = Math.min(width, x0 + cellSize);
      const y1 = Math.min(height, y0 + cellSize);
      let total = 0;
      let vegetation = 0;
      let water = 0;
      let warmRoof = 0;
      let neutral = 0;
      let edges = 0;

      for (let y = y0; y < y1; y += 1) {
        let previousLuminance = -1;
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * 4;
          if (pixels[offset + 3] < 40) continue;
          const sample = pixelClass(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
          total += 1;
          if (sample.vegetation) vegetation += 1;
          else if (sample.water) water += 1;
          else if (sample.warmRoof) warmRoof += 1;
          if (sample.neutral) neutral += 1;
          if (previousLuminance >= 0 && Math.abs(sample.luminance - previousLuminance) > 24)
            edges += 1;
          previousLuminance = sample.luminance;
        }
      }

      if (!total) continue;
      const fractions = {
        vegetation: vegetation / total,
        water: water / total,
        warmRoof: warmRoof / total,
        neutral: neutral / total,
        edges: edges / total,
      };
      let kind: CellClass = null;
      let strength = 0;
      if (fractions.vegetation > 0.31) {
        kind = "vegetation";
        strength = fractions.vegetation;
      } else if (fractions.water > 0.34) {
        kind = "water";
        strength = fractions.water;
      } else if (fractions.warmRoof > 0.27 || (fractions.edges > 0.2 && fractions.neutral > 0.36)) {
        kind = "building";
        strength = Math.max(fractions.warmRoof, fractions.edges);
      } else if (fractions.neutral > 0.68 && fractions.edges < 0.2) {
        kind = "road";
        strength = fractions.neutral;
      }
      const index = row * columns + column;
      classes[index] = kind;
      strengths[index] = strength;
    }
  }

  const visited = new Uint8Array(classes.length);
  const objects: ImageContextObject[] = [];
  const minimumCells: Record<ImageContextKind, number> = {
    building: 2,
    road: 6,
    vegetation: 4,
    water: 4,
  };

  for (let index = 0; index < classes.length; index += 1) {
    const kind = classes[index];
    if (!kind || visited[index]) continue;
    const stack = [index];
    visited[index] = 1;
    let minColumn = columns;
    let minRow = rows;
    let maxColumn = 0;
    let maxRow = 0;
    let count = 0;
    let strength = 0;

    while (stack.length) {
      const current = stack.pop()!;
      const row = Math.floor(current / columns);
      const column = current % columns;
      minColumn = Math.min(minColumn, column);
      minRow = Math.min(minRow, row);
      maxColumn = Math.max(maxColumn, column);
      maxRow = Math.max(maxRow, row);
      count += 1;
      strength += strengths[current];
      const neighbors = [
        row > 0 ? current - columns : -1,
        row + 1 < rows ? current + columns : -1,
        column > 0 ? current - 1 : -1,
        column + 1 < columns ? current + 1 : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && !visited[neighbor] && classes[neighbor] === kind) {
          visited[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }

    if (count < minimumCells[kind]) continue;
    const boxWidth = maxColumn - minColumn + 1;
    const boxHeight = maxRow - minRow + 1;
    const aspect = Math.max(boxWidth, boxHeight) / Math.max(1, Math.min(boxWidth, boxHeight));
    if (kind === "road" && count < 18 && aspect < 1.6) continue;
    if (kind === "building" && (count > 90 || aspect > 5)) continue;

    const x0 = minColumn * cellSize;
    const y0 = minRow * cellSize;
    const x1 = Math.min(width, (maxColumn + 1) * cellSize);
    const y1 = Math.min(height, (maxRow + 1) * cellSize);
    objects.push({
      id: `${kind}-${objects.length + 1}`,
      kind,
      confidence: Math.max(0.5, Math.min(0.93, strength / count)),
      polygon: [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
    });
  }

  const area = (item: ImageContextObject) => {
    const [first, , third] = item.polygon;
    return Math.abs((third.x - first.x) * (third.y - first.y));
  };
  return objects.sort((a, b) => area(b) - area(a)).slice(0, MAX_CONTEXT_OBJECTS);
}

export async function analyzePlanImage(file: File): Promise<ImagePlanAnalysis> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Браузер не дал доступ к анализу изображения.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const pixels = context.getImageData(0, 0, width, height).data;
  const dark = new Uint8Array(width * height);
  let darkCount = 0;
  let colorfulCount = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const sample = pixelClass(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if (sample.colorful) colorfulCount += 1;
      if (pixels[offset + 3] > 40 && sample.luminance < 118) {
        dark[y * width + x] = 1;
        darkCount += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const sourceType = colorfulCount / (width * height) > 0.16 ? "satellite" : "drawing";
  const segments: PlanSegment[] = [];
  const addRuns = (vertical: boolean) => {
    const outer = vertical ? width : height;
    const inner = vertical ? height : width;
    const outerStep = Math.max(2, Math.round(outer / 260));
    const minimumRun = Math.max(10, Math.round(inner / 90));
    for (let a = 0; a < outer && segments.length < MAX_SEGMENTS; a += outerStep) {
      let start = -1;
      let gap = 0;
      for (let b = 0; b <= inner; b += 1) {
        const isDark = b < inner && dark[vertical ? b * width + a : a * width + b] === 1;
        if (isDark) {
          if (start < 0) start = b;
          gap = 0;
        } else if (start >= 0 && gap < 2) {
          gap += 1;
        } else if (start >= 0) {
          const end = b - gap - 1;
          if (end - start >= minimumRun) {
            segments.push(
              vertical
                ? { x1: a, y1: start, x2: a, y2: end, confidence: 0.62 }
                : { x1: start, y1: a, x2: end, y2: a, confidence: 0.62 },
            );
          }
          start = -1;
          gap = 0;
        }
      }
    }
  };
  addRuns(false);
  addRuns(true);

  if (!darkCount) {
    minX = 0;
    minY = 0;
    maxX = width;
    maxY = height;
  }

  const padding = Math.max(2, Math.round(Math.min(width, height) * 0.015));
  return {
    width,
    height,
    sourceType,
    segments: sourceType === "drawing" ? segments : [],
    contextObjects:
      sourceType === "satellite"
        ? buildContextObjects(
            pixels,
            width,
            height,
            Math.max(10, Math.round(Math.max(width, height) / 85)),
          )
        : [],
    drawingBounds: {
      x: Math.max(0, minX - padding),
      y: Math.max(0, minY - padding),
      width: Math.min(width, maxX + padding) - Math.max(0, minX - padding),
      height: Math.min(height, maxY + padding) - Math.max(0, minY - padding),
    },
    darkPixelRatio: darkCount / (width * height),
  };
}
