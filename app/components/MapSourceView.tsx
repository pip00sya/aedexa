"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ArrowLeft, Building2, Check, Crosshair, Search, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isSimplePolygon } from "../lib/geometry";
import {
  anchorOf,
  buildingsToNeighbors,
  DEFAULT_ANCHOR,
  fetchNearbyBuildings,
  searchPlace,
  TILE_SOURCES,
  toLocal,
  type LatLon,
  type OsmBuilding,
  type Place,
} from "../lib/placement/geo";
import type { PlacementSource } from "../lib/placement/types";

/** Карта как источник участка */

type Basemap = "plan" | "satellite";

type Props = {
  onSource: (source: PlacementSource) => void;
  onCancel: () => void;
};

/** Радиус, в котором берутся соседние здания из OpenStreetMap, м */
const NEIGHBOR_RADIUS_METERS = 120;

export default function MapSourceView({ onSource, onCancel }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const drawing = useRef<L.LayerGroup | null>(null);
  const around = useRef<L.LayerGroup | null>(null);
  const request = useRef<AbortController | null>(null);

  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [contourError, setContourError] = useState(false);
  const [vertices, setVertices] = useState<LatLon[]>([]);
  const [buildings, setBuildings] = useState<OsmBuilding[]>([]);
  const [nearbyState, setNearbyState] = useState<"idle" | "busy" | "done" | "error">("idle");

  // карта создается один раз
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    const instance = L.map(node, {
      zoomControl: false,
      attributionControl: true,
      doubleClickZoom: false,
    });
    L.control.zoom({ position: "bottomright" }).addTo(instance);
    instance.attributionControl.setPrefix("");
    instance.setView([DEFAULT_ANCHOR.lat, DEFAULT_ANCHOR.lon], 16);
    map.current = instance;
    drawing.current = L.layerGroup().addTo(instance);
    around.current = L.layerGroup().addTo(instance);

    // Слушатель ставится один раз, поэтому вершина добавляется через функцию обновления
    const click = (event: L.LeafletMouseEvent) => {
      setVertices((previous) => [...previous, { lat: event.latlng.lat, lon: event.latlng.lng }]);
    };
    instance.on("click", click);

    return () => {
      instance.off("click", click);
      instance.remove();
      map.current = null;
      drawing.current = null;
      around.current = null;
      request.current?.abort();
    };
  }, []);

  // подложка
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    tiles.current?.remove();
    const source = TILE_SOURCES[basemap];
    tiles.current = L.tileLayer(source.url, {
      maxZoom: source.maxZoom,
      attribution: source.credit,
    }).addTo(instance);
  }, [basemap]);

  // обводка участка
  useEffect(() => {
    const layer = drawing.current;
    if (!layer) return;
    layer.clearLayers();
    const path = vertices.map((vertex) => [vertex.lat, vertex.lon] as [number, number]);
    if (path.length >= 3) {
      L.polygon(path, {
        color: "#2563eb",
        weight: 2,
        fillColor: "#2563eb",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(layer);
    } else if (path.length === 2) {
      L.polyline(path, { color: "#2563eb", weight: 2, interactive: false }).addTo(layer);
    }
    path.forEach((point, index) => {
      L.circleMarker(point, {
        radius: 5,
        color: "#fff",
        weight: 2,
        fillColor: index === 0 ? "#16a34a" : "#2563eb",
        fillOpacity: 1,
        interactive: false,
      }).addTo(layer);
    });
  }, [vertices]);

  // соседние здания из OpenStreetMap
  useEffect(() => {
    const layer = around.current;
    if (!layer) return;
    layer.clearLayers();
    for (const building of buildings) {
      L.polygon(
        building.ring.map((point) => [point.lat, point.lon] as [number, number]),
        {
          color: "#94a3b8",
          weight: 1.2,
          fillColor: "#cbd5e1",
          fillOpacity: 0.35,
          interactive: false,
        },
      ).addTo(layer);
    }
  }, [buildings]);

  const search = async () => {
    const text = query.trim();
    if (text.length < 3) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSearching(true);
    setSearchFailed(false);
    try {
      setFound(await searchPlace(text, controller.signal));
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("Поиск места не удался", error);
        setSearchFailed(true);
        setFound(null);
      }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };

  const goTo = (place: Place) => {
    map.current?.setView([place.lat, place.lon], 18);
    setFound(null);
  };

  const loadNeighbors = async () => {
    const instance = map.current;
    if (!instance) return;
    const center = vertices.length
      ? anchorOf(vertices)
      : { lat: instance.getCenter().lat, lon: instance.getCenter().lng };
    setNearbyState("busy");
    try {
      setBuildings(await fetchNearbyBuildings(center, NEIGHBOR_RADIUS_METERS));
      setNearbyState("done");
    } catch (error) {
      console.error("Соседние здания не получены", error);
      setNearbyState("error");
    }
  };

  const useParcel = () => {
    if (vertices.length < 3) return;
    const anchor = anchorOf(vertices);
    const parcel = vertices.map((vertex) => toLocal(vertex, anchor));
    if (!isSimplePolygon(parcel)) {
      setContourError(true);
      return;
    }
    setContourError(false);
    const neighbors = buildingsToNeighbors(buildings, anchor, parcel);
    const warnings = [
      "Контур обведён по спутниковому снимку: точность — точность снимка и руки. Подтвердите границу по кадастру.",
      "Красная линия не задана: показан предварительный отступ от выбранной уличной стороны.",
    ];
    if (neighbors.length)
      warnings.push(
        "Соседние здания — из OpenStreetMap: там нанесено не всё и не точно, огнестойкость неизвестна.",
      );
    else warnings.push("Соседние здания не загружены: пожарные разрывы не построены.");
    onSource({
      kind: "map",
      name: `Карта · ${anchor.lat.toFixed(5)}, ${anchor.lon.toFixed(5)}`,
      confidence: "local",
      unitLabel: "м",
      coordinateLabel: "Спутниковый снимок · метры от центра участка, +Y — север",
      parcel,
      parcelConfirmed: false,
      streetEdgeIndex: 0,
      neighbors,
      anchor,
      warnings,
    });
  };

  return (
    <div className="map-source">
      <div className="map-source__bar">
        <div className="map-source__search">
          <input
            type="search"
            value={query}
            placeholder="Адрес или место: Алматы, Сейфуллина 500"
            aria-label="Поиск места по адресу"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
          />
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => void search()}
            disabled={query.trim().length < 3 || searching}
          >
            <Search size={15} /> {searching ? "Ищем…" : "Найти"}
          </button>
        </div>
        <div className="map-source__seg" role="group" aria-label="Подложка">
          <button
            type="button"
            className={basemap === "satellite" ? "active" : ""}
            onClick={() => setBasemap("satellite")}
          >
            Спутник
          </button>
          <button
            type="button"
            className={basemap === "plan" ? "active" : ""}
            onClick={() => setBasemap("plan")}
          >
            Схема
          </button>
        </div>
      </div>

      {searchFailed && (
        <p className="map-source__note warn">
          Поиск не ответил: открытый сервис OpenStreetMap иногда ограничивает запросы. Найдите
          место, двигая карту.
        </p>
      )}
      {contourError && (
        <p role="alert" className="map-source__note warn">
          Контур вырожден или пересекает себя. Укажите разные углы участка по порядку.
        </p>
      )}
      {found?.length === 0 && (
        <p className="map-source__note">Ничего не нашлось. Уточните запрос.</p>
      )}
      {found && found.length > 0 && (
        <ul className="map-source__results">
          {found.map((place) => (
            <li key={`${place.lat},${place.lon}`}>
              <button type="button" onClick={() => goTo(place)}>
                <Crosshair size={14} /> {place.title}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        ref={holder}
        className="map-source__map"
        aria-label="Карта: кликните по углам участка, чтобы обвести его"
      />

      <div className="map-source__bar bottom">
        <span className="map-source__hint">
          {vertices.length < 3
            ? `Кликните по углам участка на снимке: точек ${vertices.length}, нужно не меньше трёх`
            : `Контур из ${vertices.length} точек готов`}
        </span>
        <div className="map-source__actions">
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => setVertices(vertices.slice(0, -1))}
            disabled={!vertices.length}
          >
            <Undo2 size={15} /> Точку назад
          </button>
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => setVertices([])}
            disabled={!vertices.length}
          >
            <X size={15} /> Очистить
          </button>
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => void loadNeighbors()}
            disabled={nearbyState === "busy"}
          >
            <Building2 size={15} />{" "}
            {nearbyState === "busy"
              ? "Запрашиваем…"
              : nearbyState === "done"
                ? `Соседи: ${buildings.length}`
                : "Соседние здания"}
          </button>
          <button
            type="button"
            className="placement-button primary"
            onClick={useParcel}
            disabled={vertices.length < 3}
          >
            <Check size={15} /> Использовать участок
          </button>
          <button type="button" className="placement-button secondary" onClick={onCancel}>
            <ArrowLeft size={15} /> Назад
          </button>
        </div>
      </div>
      {nearbyState === "error" && (
        <p className="map-source__note warn">
          Overpass не ответил — открытый сервис отвечает не всегда. Попробуйте через минуту.
        </p>
      )}
      <p className="map-source__note">
        Карта и поиск — открытые сервисы OpenStreetMap и Esri: наружу уходит только точка, на
        которую вы смотрите, и текст запроса. Подземных сетей в открытых данных нет — их берут из
        чертежа или справки.
      </p>
    </div>
  );
}
