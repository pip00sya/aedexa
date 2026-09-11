export function pngPreviewDataUrl(model: Record<string, unknown>) {
  const width = 1536;
  const height = 840;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  const setPixel = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = 255;
  };
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: [number, number, number],
    thickness = 1,
  ) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))));
    for (let index = 0; index <= steps; index += 1) {
      const x = x1 + ((x2 - x1) * index) / steps;
      const y = y1 + ((y2 - y1) * index) / steps;
      for (let dx = -Math.floor(thickness / 2); dx <= Math.floor(thickness / 2); dx += 1) {
        for (let dy = -Math.floor(thickness / 2); dy <= Math.floor(thickness / 2); dy += 1)
          setPixel(x + dx, y + dy, color);
      }
    }
  };
  const parts = Array.isArray(model.parts)
    ? model.parts.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
  const projections: Array<{ a: "x" | "z"; b: "y" | "z"; left: number }> = [
    { a: "x", b: "y", left: 16 },
    { a: "x", b: "z", left: 528 },
    { a: "z", b: "y", left: 1040 },
  ];
  for (const projection of projections) {
    const panel = { left: projection.left, top: 16, width: 480, height: 808 };
    line(panel.left, panel.top, panel.left + panel.width, panel.top, [190, 205, 225]);
    line(panel.left, panel.top, panel.left, panel.top + panel.height, [190, 205, 225]);
    const shapes = parts.map((part) => {
      const position =
        part.position && typeof part.position === "object"
          ? (part.position as Record<string, unknown>)
          : {};
      const size =
        part.size && typeof part.size === "object" ? (part.size as Record<string, unknown>) : {};
      const rotation =
        part.rotationDegrees && typeof part.rotationDegrees === "object"
          ? (part.rotationDegrees as Record<string, unknown>)
          : {};
      const numberAt = (source: Record<string, unknown>, axis: "x" | "y" | "z", fallback = 0) =>
        typeof source[axis] === "number" && Number.isFinite(source[axis])
          ? (source[axis] as number)
          : fallback;
      const center = {
        x: numberAt(position, "x"),
        y: numberAt(position, "y"),
        z: numberAt(position, "z"),
      };
      const fallbackSpan = typeof part.radius === "number" && part.radius > 0 ? part.radius * 2 : 1;
      const half = {
        x: Math.max(1, numberAt(size, "x", fallbackSpan)) / 2,
        y:
          Math.max(
            1,
            numberAt(size, "y", typeof part.height === "number" ? part.height : fallbackSpan),
          ) / 2,
        z: Math.max(1, numberAt(size, "z", fallbackSpan)) / 2,
      };
      const radians = {
        x: (numberAt(rotation, "x") * Math.PI) / 180,
        y: (numberAt(rotation, "y") * Math.PI) / 180,
        z: (numberAt(rotation, "z") * Math.PI) / 180,
      };
      const rotate = (point: { x: number; y: number; z: number }) => {
        const x1 = point.x;
        const y1 = point.y * Math.cos(radians.x) - point.z * Math.sin(radians.x);
        const z1 = point.y * Math.sin(radians.x) + point.z * Math.cos(radians.x);
        const x2 = x1 * Math.cos(radians.y) + z1 * Math.sin(radians.y);
        const y2 = y1;
        const z2 = -x1 * Math.sin(radians.y) + z1 * Math.cos(radians.y);
        return {
          x: center.x + x2 * Math.cos(radians.z) - y2 * Math.sin(radians.z),
          y: center.y + x2 * Math.sin(radians.z) + y2 * Math.cos(radians.z),
          z: center.z + z2,
        };
      };
      const profile =
        part.kind === "extrusion" && Array.isArray(part.profile)
          ? part.profile.flatMap((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return [];
              const point = value as Record<string, unknown>;
              return typeof point.x === "number" &&
                Number.isFinite(point.x) &&
                typeof point.z === "number" &&
                Number.isFinite(point.z)
                ? [{ x: point.x, z: point.z }]
                : [];
            })
          : [];
      const points =
        profile.length >= 3
          ? [
              ...profile.map((point) => rotate({ x: point.x, y: -half.y, z: point.z })),
              ...profile.map((point) => rotate({ x: point.x, y: half.y, z: point.z })),
            ]
          : Array.from({ length: 8 }, (_, index) =>
              rotate({
                x: index & 4 ? half.x : -half.x,
                y: index & 2 ? half.y : -half.y,
                z: index & 1 ? half.z : -half.z,
              }),
            );
      const edges: Array<[number, number]> =
        profile.length >= 3
          ? profile.flatMap((_point, index) => {
              const next = (index + 1) % profile.length;
              return [
                [index, next],
                [index + profile.length, next + profile.length],
                [index, index + profile.length],
              ] as Array<[number, number]>;
            })
          : [
              [0, 1],
              [0, 2],
              [0, 4],
              [1, 3],
              [1, 5],
              [2, 3],
              [2, 6],
              [3, 7],
              [4, 5],
              [4, 6],
              [5, 7],
              [6, 7],
            ];
      const id = String(part.id || "");
      const color: [number, number, number] = id.includes("canopy")
        ? [202, 102, 32]
        : id.includes("window")
          ? [0, 139, 201]
          : id.includes("entrance")
            ? [0, 108, 150]
            : id.includes("stair") || id.includes("tread")
              ? [32, 91, 190]
              : id.includes("lift")
                ? [107, 70, 193]
                : id.includes("foundation")
                  ? [94, 105, 120]
                  : [23, 48, 78];
      return {
        points,
        edges,
        color,
        emphasis: id.includes("window") || id.includes("entrance") || id.includes("roof"),
      };
    });
    const allPoints = shapes.flatMap((shape) => shape.points);
    const minA = allPoints.length ? Math.min(...allPoints.map((point) => point[projection.a])) : 0;
    const maxA = allPoints.length ? Math.max(...allPoints.map((point) => point[projection.a])) : 1;
    const minB = allPoints.length ? Math.min(...allPoints.map((point) => point[projection.b])) : 0;
    const maxB = allPoints.length ? Math.max(...allPoints.map((point) => point[projection.b])) : 1;
    const scale = Math.min(
      (panel.width - 8) / Math.max(1, maxA - minA),
      (panel.height - 8) / Math.max(1, maxB - minB),
    );
    shapes.forEach((shape) => {
      const projected = shape.points.map((point) => ({
        x: panel.left + 4 + (point[projection.a] - minA) * scale,
        y: panel.top + panel.height - 4 - (point[projection.b] - minB) * scale,
      }));
      shape.edges.forEach(([start, end]) =>
        line(
          projected[start].x,
          projected[start].y,
          projected[end].x,
          projected[end].y,
          shape.color,
          shape.emphasis ? 2 : 1,
        ),
      );
    });
  }
  const scanline = width * 4 + 1;
  const raw = new Uint8Array(scanline * height);
  for (let y = 0; y < height; y += 1)
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * scanline + 1);
  const adler32 = (data: Uint8Array) => {
    let a = 1;
    let b = 0;
    data.forEach((value) => {
      a = (a + value) % 65521;
      b = (b + a) % 65521;
    });
    return ((b << 16) | a) >>> 0;
  };
  const zlib: number[] = [0x78, 0x01];
  for (let offset = 0; offset < raw.length; ) {
    const length = Math.min(65_535, raw.length - offset);
    const final = offset + length === raw.length ? 1 : 0;
    zlib.push(
      final,
      length & 255,
      length >>> 8,
      ~length & 255,
      (~length >>> 8) & 255,
      ...raw.subarray(offset, offset + length),
    );
    offset += length;
  }
  const checksum = adler32(raw);
  zlib.push(checksum >>> 24, (checksum >>> 16) & 255, (checksum >>> 8) & 255, checksum & 255);
  const crc32 = (data: Uint8Array) => {
    let crc = 0xffffffff;
    data.forEach((value) => {
      crc ^= value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    });
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Uint8Array) => {
    const type = new TextEncoder().encode(name);
    const result = new Uint8Array(data.length + 12);
    new DataView(result.buffer).setUint32(0, data.length);
    result.set(type, 4);
    result.set(data, 8);
    new DataView(result.buffer).setUint32(
      result.length - 4,
      crc32(result.subarray(4, result.length - 4)),
    );
    return result;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(zlib)),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(chunks.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  chunks.forEach((value) => {
    png.set(value, offset);
    offset += value.length;
  });
  let binary = "";
  for (let index = 0; index < png.length; index += 0x8000)
    binary += String.fromCharCode(...png.subarray(index, index + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
