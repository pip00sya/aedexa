import { distancePointToSegment, pointInPolygon, polygonBounds } from "../geometry";
import type { CadFeature } from "./types";

export const WALL_TOUCH_TOLERANCE_METERS = 0.25;

type Footprint = {
  points: CadFeature["points"];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

export function createBuildingMask(features: readonly CadFeature[], toleranceUnits = 0) {
  const footprints: Footprint[] = [];
  for (const feature of features) {
    if (feature.kind !== "building" || !feature.closed || feature.points.length < 3) continue;
    const box = polygonBounds(feature.points);
    footprints.push({
      points: feature.points,
      minX: box.x,
      maxX: box.x + box.width,
      minY: box.y,
      maxY: box.y + box.height,
    });
  }

  const tolerance = Math.max(0, toleranceUnits);
  return (x: number, y: number) => {
    const point = { x, y };
    for (const footprint of footprints) {
      if (
        x < footprint.minX - tolerance ||
        x > footprint.maxX + tolerance ||
        y < footprint.minY - tolerance ||
        y > footprint.maxY + tolerance
      )
        continue;
      if (pointInPolygon(point, footprint.points)) return true;
      if (!tolerance) continue;
      const outline = footprint.points;
      for (let index = 0; index < outline.length; index += 1) {
        const start = outline[index];
        const end = outline[(index + 1) % outline.length];
        if (distancePointToSegment(point, start, end) <= tolerance) return true;
      }
    }
    return false;
  };
}

/** Классы, которые лежат на земле и не должны проходить сквозь дом в 3D */
const groundLineKinds = new Set<CadFeature["kind"]>([
  "boundary",
  "fence",
  "curb",
  "road",
  "site",
  "ditch",
]);

export function isGroundLineKind(kind: CadFeature["kind"]) {
  return groundLineKinds.has(kind);
}
