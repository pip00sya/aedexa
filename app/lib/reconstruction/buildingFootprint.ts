import polygonClipping from "polygon-clipping";
import type { ReconstructionPart } from "./types";

export function buildFootprintBases(
  shells: readonly ReconstructionPart[],
  thickness: number,
  color: string,
): ReconstructionPart[] {
  const polygons: polygonClipping.Polygon[] = [];
  for (const part of shells) {
    if (Math.abs(part.position.y - part.size.y / 2) > 1e-6) continue;
    if (part.kind !== "box" && part.kind !== "extrusion") continue;
    const outer =
      part.kind === "extrusion"
        ? part.profile
        : [
            { x: -part.size.x / 2, z: -part.size.z / 2 },
            { x: part.size.x / 2, z: -part.size.z / 2 },
            { x: part.size.x / 2, z: part.size.z / 2 },
            { x: -part.size.x / 2, z: part.size.z / 2 },
          ];
    const angle = (part.rotationDegrees.y * Math.PI) / 180;
    const rings = [outer, ...part.holes].map((ring) =>
      ring.map(
        (point) =>
          [
            part.position.x + point.x * Math.cos(angle) + point.z * Math.sin(angle),
            part.position.z - point.x * Math.sin(angle) + point.z * Math.cos(angle),
          ] as [number, number],
      ),
    );
    if (rings[0].length >= 3) polygons.push(rings);
  }
  if (!polygons.length) return [];
  return polygonClipping.union(polygons[0], ...polygons.slice(1)).map((rings, index) => {
    const outer = rings[0];
    const minX = Math.min(...outer.map((point) => point[0]));
    const maxX = Math.max(...outer.map((point) => point[0]));
    const minZ = Math.min(...outer.map((point) => point[1]));
    const maxZ = Math.max(...outer.map((point) => point[1]));
    const x = (minX + maxX) / 2;
    const z = (minZ + maxZ) / 2;
    const local = rings.map((ring) =>
      ring.slice(0, -1).map((point) => ({ x: point[0] - x, z: point[1] - z })),
    );
    return {
      id: `footprint-base-${index + 1}`,
      name: `Основание по контуру здания ${index + 1} · допущение`,
      kind: "extrusion",
      position: { x, y: -thickness / 2, z },
      rotationDegrees: { x: 0, y: 0, z: 0 },
      size: { x: maxX - minX, y: thickness, z: maxZ - minZ },
      height: thickness,
      radius: 0,
      profile: local[0],
      holes: local.slice(1),
      vertices: [],
      faces: [],
      color,
      confidence: Math.min(0.65, ...shells.map((part) => part.confidence)),
      evidence: [
        "AI-допущение: основание повторяет объединённый контур наземных объёмов. Толщина условная; тип и конструкцию фундамента необходимо подтвердить проектом.",
      ],
    };
  });
}
