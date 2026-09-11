import type { NeighborBuilding, PlacementAnchor, PlacementPoint, PlacementPolygon } from "./types";

export type LatLon = { lat: number; lon: number };

/** Метров в одном градусе широты */
const METRES_PER_DEGREE = 111_320;

/** Алматы - если про место ничего не известно, начинаем отсюда */
export const DEFAULT_ANCHOR: PlacementAnchor = { lat: 43.238949, lon: 76.889709, rotation: 0 };

export function toLatLon(point: PlacementPoint, anchor: PlacementAnchor): LatLon {
  const angle = (anchor.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const east = point.x * cos + point.y * sin;
  const north = -point.x * sin + point.y * cos;
  const lat = anchor.lat + north / METRES_PER_DEGREE;
  const lon = anchor.lon + east / (METRES_PER_DEGREE * Math.cos((anchor.lat * Math.PI) / 180) || 1);
  return { lat, lon };
}

/** Широта и долгота -> локальная точка */
export function toLocal(place: LatLon, anchor: PlacementAnchor): PlacementPoint {
  const north = (place.lat - anchor.lat) * METRES_PER_DEGREE;
  const east =
    (place.lon - anchor.lon) * METRES_PER_DEGREE * Math.cos((anchor.lat * Math.PI) / 180);
  const angle = (-anchor.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: east * cos + north * sin, y: -east * sin + north * cos };
}

/** Центр обведенного контура - точка привязки: от нее считаются метры */
export function anchorOf(vertices: readonly LatLon[]): PlacementAnchor {
  const lat =
    vertices.reduce((total, vertex) => total + vertex.lat, 0) / Math.max(1, vertices.length);
  const lon =
    vertices.reduce((total, vertex) => total + vertex.lon, 0) / Math.max(1, vertices.length);
  return { lat, lon, rotation: 0 };
}

export type Place = { title: string; lat: number; lon: number };

export function parsePlaces(data: unknown): Place[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      const title = String(row.display_name ?? "").trim();
      return Number.isFinite(lat) && Number.isFinite(lon) && title ? { title, lat, lon } : null;
    })
    .filter((item): item is Place => item !== null)
    .slice(0, 6);
}

export async function searchPlace(query: string, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("accept-language", "ru");
  url.searchParams.set("q", query);
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Поиск вернул ${response.status}`);
  return parsePlaces(await response.json());
}

export type OsmBuilding = { id: string; ring: LatLon[]; tags: Record<string, string> };

export function parseBuildings(data: unknown): OsmBuilding[] {
  const elements =
    data && typeof data === "object" ? (data as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return [];
  const buildings: OsmBuilding[] = [];
  for (const element of elements) {
    const row = element && typeof element === "object" ? (element as Record<string, unknown>) : {};
    if (row.type !== "way" || !Array.isArray(row.geometry)) continue;
    const ring = row.geometry
      .map((node) => {
        const point = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
        return { lat: Number(point.lat), lon: Number(point.lon) };
      })
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    if (ring.length < 4) continue;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first.lat === last.lat && first.lon === last.lon) ring.pop();
    if (ring.length < 3) continue;
    const tags =
      row.tags && typeof row.tags === "object" ? (row.tags as Record<string, string>) : {};
    buildings.push({ id: `osm-${String(row.id ?? buildings.length)}`, ring, tags });
  }
  return buildings;
}

export async function fetchNearbyBuildings(
  center: LatLon,
  radiusMetres: number,
  signal?: AbortSignal,
): Promise<OsmBuilding[]> {
  const dLat = radiusMetres / METRES_PER_DEGREE;
  const dLon = radiusMetres / (METRES_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180) || 1);
  const box = [center.lat - dLat, center.lon - dLon, center.lat + dLat, center.lon + dLon]
    .map((value) => value.toFixed(6))
    .join(",");
  const query = `[out:json][timeout:25];(way["building"](${box}););out geom;`;
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: query,
    signal,
  });
  if (!response.ok) throw new Error(`Overpass вернул ${response.status}`);
  return parseBuildings(await response.json());
}

/** Здания OSM в локальных метрах участка - соседи для пожарных разрывов */
export function buildingsToNeighbors(
  buildings: readonly OsmBuilding[],
  anchor: PlacementAnchor,
  exclude?: readonly PlacementPoint[],
): NeighborBuilding[] {
  return buildings
    .map((building) => ({
      id: building.id,
      polygon: building.ring.map((point) => toLocal(point, anchor)),
    }))
    .filter((neighbor) => !exclude || !overlaps(neighbor.polygon, exclude));
}

function overlaps(a: PlacementPolygon, b: readonly PlacementPoint[]) {
  const boxOf = (points: readonly PlacementPoint[]) => ({
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  });
  const first = boxOf(a);
  const second = boxOf(b);
  const width = Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX);
  const height = Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY);
  if (width <= 0 || height <= 0) return false;
  const inner = Math.min(
    (first.maxX - first.minX) * (first.maxY - first.minY),
    (second.maxX - second.minX) * (second.maxY - second.minY),
  );
  return inner > 0 && (width * height) / inner > 0.5;
}

export type TileSource = { url: string; credit: string; maxZoom: number };

export const TILE_SOURCES: Record<"plan" | "satellite", TileSource> = {
  plan: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    credit: "© OpenStreetMap",
    maxZoom: 19,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "Снимок: Esri, Maxar, Earthstar Geographics",
    maxZoom: 19,
  },
};
