import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorOf,
  buildingsToNeighbors,
  parseBuildings,
  parsePlaces,
  toLatLon,
  toLocal,
} from "../app/lib/placement/geo.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";

const almaty = { lat: 43.238949, lon: 76.889709, rotation: 0 };

test("метры ↔ градусы: туда и обратно без потерь, +Y — север", () => {
  const point = { x: 25, y: -12 };
  const place = toLatLon(point, almaty);
  assert.ok(place.lat < almaty.lat, "минус по Y — южнее");
  assert.ok(place.lon > almaty.lon, "плюс по X — восточнее");
  const back = toLocal(place, almaty);
  assert.ok(Math.abs(back.x - point.x) < 1e-6 && Math.abs(back.y - point.y) < 1e-6);
});

test("контур, обведённый на карте, становится участком в метрах с настоящей площадью", () => {
  // Прямоугольник 40 × 30 м, обведенный в градусах вокруг точки в Алматы
  const anchor = almaty;
  const corners = [
    toLatLon({ x: -20, y: -15 }, anchor),
    toLatLon({ x: 20, y: -15 }, anchor),
    toLatLon({ x: 20, y: 15 }, anchor),
    toLatLon({ x: -20, y: 15 }, anchor),
  ];
  const center = anchorOf(corners);
  assert.ok(
    Math.abs(center.lat - anchor.lat) < 1e-9 && Math.abs(center.lon - anchor.lon) < 1e-9,
    "привязка — центр контура",
  );
  const parcel = corners.map((corner) => toLocal(corner, center));
  assert.ok(
    Math.abs(polygonArea(parcel) - 1200) < 0.5,
    `площадь 1200 м², получено ${polygonArea(parcel).toFixed(1)}`,
  );
});

test("ответ Nominatim читается как данные: мусор отбрасывается", () => {
  const places = parsePlaces([
    { lat: "43.25", lon: "76.95", display_name: "Алматы, Сейфуллина 500" },
    { lat: "нет", lon: "76.9", display_name: "битая строка" },
    "не объект",
    { lat: "43.3", lon: "76.9", display_name: "" },
  ]);
  assert.deepEqual(places, [{ title: "Алматы, Сейфуллина 500", lat: 43.25, lon: 76.95 }]);
});

test("здания из Overpass становятся соседями в метрах, а свой участок — нет", () => {
  const anchor = almaty;
  const house = [
    { x: 30, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 18 },
    { x: 30, y: 18 },
  ].map((point) => toLatLon(point, anchor));
  const self = [
    { x: -20, y: -15 },
    { x: 20, y: -15 },
    { x: 20, y: 15 },
    { x: -20, y: 15 },
  ].map((point) => toLatLon(point, anchor));
  const data = {
    elements: [
      { type: "way", id: 1, tags: { building: "house" }, geometry: [...house, house[0]] },
      { type: "way", id: 2, tags: { building: "yes" }, geometry: [...self, self[0]] },
      { type: "way", id: 3, tags: { building: "yes" }, geometry: [house[0], house[1]] },
      { type: "node", id: 4 },
    ],
  };
  const buildings = parseBuildings(data);
  assert.equal(buildings.length, 2, "незамкнутое и не-way отброшены");

  const parcel = self.map((point) => toLocal(point, anchor));
  const neighbors = buildingsToNeighbors(buildings, anchor, parcel);
  assert.equal(neighbors.length, 1, "здание, совпадающее с участком, соседом не считается");
  assert.equal(neighbors[0].id, "osm-1");
  assert.ok(Math.abs(polygonArea(neighbors[0].polygon) - 80) < 0.5, "сосед 10 × 8 м");
});
