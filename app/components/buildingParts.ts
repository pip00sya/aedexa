import * as THREE from "three";
import type { SiteObjectKind } from "../lib/placement/siteObjects";

/** Форма постройки в объеме */

export type BuildingParts = {
  /** Стены и стойки */
  solid: THREE.BufferGeometry;
  /** Кровля отдельно */
  roof: THREE.BufferGeometry | null;
  /** Полная высота вместе с коньком */
  top: number;
};

/** Свес кровли, метры */
const eaveOf = (width: number, depth: number) => Math.min(0.45, Math.min(width, depth) * 0.06);

export function buildingParts(
  kind: SiteObjectKind,
  width: number,
  depth: number,
  height: number,
): BuildingParts {
  if (kind === "canopy") return canopy(width, depth, height);
  if (kind === "septic") return flat(width, depth, Math.max(height, 0.25));
  if (kind === "yard") return flat(width, depth, 0.06);
  // Уклон кровли
  return gabled(width, depth, height, kind === "house" ? 0.34 : 0.22);
}

/** Порядок вершин призмы кровли */
const RIDGE_ALONG_X = [0, 5, 1, 0, 4, 5, 3, 2, 5, 3, 5, 4, 0, 3, 4, 1, 5, 2, 0, 1, 2, 0, 2, 3];

const RIDGE_ALONG_Z = [0, 3, 5, 0, 5, 4, 1, 4, 5, 1, 5, 2, 0, 4, 1, 3, 2, 5, 0, 1, 2, 0, 2, 3];

/** Дом с двускатной кровлей */
function gabled(width: number, depth: number, height: number, pitch: number): BuildingParts {
  const walls = new THREE.BoxGeometry(width, height, depth);
  walls.translate(0, height / 2, 0);

  const eave = eaveOf(width, depth);
  const halfWidth = width / 2 + eave;
  const halfDepth = depth / 2 + eave;
  // Конек идет вдоль длинной стороны
  const alongX = width >= depth;
  const rise = (alongX ? depth : width) * pitch;
  const ridge = height + rise;

  const points = [
    -halfWidth,
    height,
    -halfDepth,
    halfWidth,
    height,
    -halfDepth,
    halfWidth,
    height,
    halfDepth,
    -halfWidth,
    height,
    halfDepth,
    ...(alongX
      ? [-halfWidth, ridge, 0, halfWidth, ridge, 0]
      : [0, ridge, -halfDepth, 0, ridge, halfDepth]),
  ];

  const roof = new THREE.BufferGeometry();
  roof.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  roof.setIndex(alongX ? [...RIDGE_ALONG_X] : [...RIDGE_ALONG_Z]);
  roof.computeVertexNormals();

  return { solid: walls, roof, top: ridge };
}

/** Навес: кровля на четырех стойках, стен нет */
function canopy(width: number, depth: number, height: number): BuildingParts {
  const post = Math.min(0.22, Math.min(width, depth) * 0.05);
  const inset = post * 1.6;
  const legs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.BoxGeometry(post, height, post);
      leg.translate(sx * (width / 2 - inset), height / 2, sz * (depth / 2 - inset));
      legs.push(leg);
    }
  }

  const eave = eaveOf(width, depth);
  const slab = new THREE.BoxGeometry(width + eave * 2, 0.18, depth + eave * 2);
  slab.translate(0, height + 0.09, 0);

  return { solid: mergeAll(legs), roof: slab, top: height + 0.18 };
}

/** Плоское: септик и площадка */
function flat(width: number, depth: number, height: number): BuildingParts {
  const slab = new THREE.BoxGeometry(width, height, depth);
  slab.translate(0, height / 2, 0);
  return { solid: slab, roof: null, top: height };
}

/** Складывает геометрии в одну, без зависимости от BufferGeometryUtils */
function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of parts) {
    const plain = part.index ? part.toNonIndexed() : part;
    const position = plain.getAttribute("position").array as Float32Array;
    const normal = plain.getAttribute("normal")?.array as Float32Array | undefined;
    // Поэлементно, а не спредом: спред от больших массивов переполняет стек
    for (let i = 0; i < position.length; i += 1) positions.push(position[i]);
    if (normal) for (let i = 0; i < normal.length; i += 1) normals.push(normal[i]);
    if (plain !== part) plain.dispose();
    part.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length)
    merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  else merged.computeVertexNormals();
  return merged;
}
