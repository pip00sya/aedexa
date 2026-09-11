"use client";

import { useEffect, useRef } from "react";
import {
  createBuildingMask,
  isGroundLineKind,
  WALL_TOUCH_TOLERANCE_METERS,
} from "../lib/cad/buildingMask";
import {
  cadPathWidthMeters,
  isBuildingFootprint,
  isCadFeatureRenderable,
  isPointCadObject,
  resolveCadObjectHeight,
} from "../lib/cad/objectRules";
import { createTerrainResolver, orientTerrainTriangles } from "../lib/cad/terrain";
import {
  cadKindMeta,
  cadKinds,
  type CadKind,
  type CadProcessingResult,
  type CadQaStatus,
} from "../lib/cad/types";
import { installSurfaceZoom } from "../lib/surfaceZoom";

type CadViewportProps = {
  result: CadProcessingResult;
  visibleKinds: Record<CadKind, boolean>;
  viewMode: "2d" | "3d";
  wireframe: boolean;
  displayTheme: "semantic" | "qa";
};

export default function CadViewport({
  result,
  visibleKinds,
  viewMode,
  wireframe,
  displayTheme,
}: CadViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};

    async function buildScene() {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (cancelled || !hostRef.current) return;

      const host = hostRef.current;
      const scene = new THREE.Scene();
      // Тот же белый мрамор, что под планом
      const sceneColor = viewMode === "2d" ? 0x101014 : 0xf5f3ee;
      scene.background = new THREE.Color(sceneColor);
      scene.fog = new THREE.FogExp2(sceneColor, 0.0015);

      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 420);
      camera.position.set(48, 30, 58);
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      host.replaceChildren(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.screenSpacePanning = true;
      controls.maxDistance = 320;
      controls.maxPolarAngle = Math.PI * 0.495;

      const { terrain } = result;
      const terrainBounds = terrain.vertices.reduce(
        (bounds, point) => ({
          minX: Math.min(bounds.minX, point.x),
          maxX: Math.max(bounds.maxX, point.x),
          minY: Math.min(bounds.minY, point.y),
          maxY: Math.max(bounds.maxY, point.y),
        }),
        {
          minX: Number.POSITIVE_INFINITY,
          maxX: Number.NEGATIVE_INFINITY,
          minY: Number.POSITIVE_INFINITY,
          maxY: Number.NEGATIVE_INFINITY,
        },
      );
      const displayBounds =
        viewMode === "3d" && terrain.vertices.length ? terrainBounds : result.bounds;
      const sourceWidth = Math.max(displayBounds.maxX - displayBounds.minX, 1e-6);
      const sourceDepth = Math.max(displayBounds.maxY - displayBounds.minY, 1e-6);
      const sourceSize = Math.max(sourceWidth, sourceDepth);
      const worldScale = 82 / sourceSize;
      const centerX = (displayBounds.minX + displayBounds.maxX) / 2;
      const centerY = (displayBounds.minY + displayBounds.maxY) / 2;
      const elevationBase = terrain.sampleCount ? terrain.minElevation : 0;
      const elevationScale = worldScale;
      const sourceUnitsPerMeter =
        result.unitLabel === "мм"
          ? 1_000
          : result.unitLabel === "см"
            ? 100
            : result.unitLabel === "км"
              ? 0.001
              : result.unitLabel === "футы"
                ? 3.28084
                : result.unitLabel === "дюймы"
                  ? 39.3701
                  : 1;

      const worldX = (value: number) => (value - centerX) * worldScale;
      const worldZ = (value: number) => (value - centerY) * worldScale;
      const worldHeight = (value: number) => (value - elevationBase) * elevationScale;
      const worldLength = (meters: number) => meters * sourceUnitsPerMeter * worldScale;
      const surfaceLift = Math.max(worldLength(0.03), 0.00001);
      const pavementLift = Math.max(worldLength(0.09), surfaceLift * 2);
      const terrainResolver = createTerrainResolver(result.terrain);
      const resolvedElevation = (value: (typeof result.features)[number]["points"][number]) =>
        viewMode === "2d"
          ? elevationBase
          : (value.resolvedZ ?? (value.zExplicit ? value.z : elevationBase));

      scene.add(new THREE.HemisphereLight(0xfffdf7, 0x6e6c68, 1.65));
      const keyLight = new THREE.DirectionalLight(0xfff6e6, 3.2);
      keyLight.position.set(-34, 58, 28);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1536, 1536);
      keyLight.shadow.camera.left = -60;
      keyLight.shadow.camera.right = 60;
      keyLight.shadow.camera.top = 60;
      keyLight.shadow.camera.bottom = -60;
      scene.add(keyLight);
      const rimLight = new THREE.DirectionalLight(0xe6e3dc, 0.8);
      rimLight.position.set(40, 18, -38);
      scene.add(rimLight);

      const grid = new THREE.GridHelper(100, 40, 0xc9c6bf, 0xdfdcd5);
      grid.position.y = -worldLength(0.15);
      grid.visible = viewMode === "3d";
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of gridMaterials) {
        material.transparent = true;
        material.opacity = viewMode === "3d" ? 0.2 : 0.42;
      }
      scene.add(grid);

      if (viewMode === "3d" && terrain.triangles.length) {
        const terrainGeometry = new THREE.BufferGeometry();
        const elevationRange = Math.max(terrain.maxElevation - terrain.minElevation, 1e-9);
        const lowColor = new THREE.Color(0x537056);
        const middleColor = new THREE.Color(0x89966d);
        const highColor = new THREE.Color(0xc8b982);
        const terrainColors = terrain.vertices.flatMap((point) => {
          const ratio = Math.min(1, Math.max(0, (point.z - terrain.minElevation) / elevationRange));
          const color =
            ratio < 0.52
              ? lowColor.clone().lerp(middleColor, ratio / 0.52)
              : middleColor.clone().lerp(highColor, (ratio - 0.52) / 0.48);
          return [color.r, color.g, color.b];
        });
        terrainGeometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(
            terrain.vertices.flatMap((point) => [
              worldX(point.x),
              worldHeight(point.z),
              worldZ(point.y),
            ]),
            3,
          ),
        );
        terrainGeometry.setAttribute("color", new THREE.Float32BufferAttribute(terrainColors, 3));
        terrainGeometry.setIndex(orientTerrainTriangles(terrain.vertices, terrain.triangles, "cw"));
        terrainGeometry.computeVertexNormals();
        const terrainMaterial = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          vertexColors: true,
          roughness: 0.92,
          metalness: 0,
          side: THREE.DoubleSide,
        });
        const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
        terrainMesh.castShadow = true;
        terrainMesh.receiveShadow = true;
        terrainMesh.visible = visibleKinds.terrain;
        scene.add(terrainMesh);
        if (wireframe) {
          const terrainEdges = new THREE.LineSegments(
            new THREE.WireframeGeometry(terrainGeometry),
            new THREE.LineBasicMaterial({
              color: 0x44624b,
              transparent: true,
              opacity: 0.34,
              toneMapped: false,
            }),
          );
          terrainEdges.visible = visibleKinds.terrain;
          terrainEdges.position.y = surfaceLift;
          scene.add(terrainEdges);
        }
      }

      const groups = Object.fromEntries(
        cadKinds.map((kind) => [kind, new THREE.Group()]),
      ) as Record<CadKind, InstanceType<typeof THREE.Group>>;
      for (const kind of cadKinds) {
        groups[kind].visible = visibleKinds[kind];
        scene.add(groups[kind]);
      }

      const qaStatuses: CadQaStatus[] = ["AUTO", "REVIEW", "REJECT"];
      const qaColors: Record<CadQaStatus, number> = {
        AUTO: 0x16a34a,
        REVIEW: 0xf59e0b,
        REJECT: 0xdc2626,
      };
      const lineMaterials = Object.fromEntries(
        cadKinds.map((kind) => [
          kind,
          Object.fromEntries(
            qaStatuses.map((status) => [
              status,
              new THREE.LineBasicMaterial({
                color:
                  displayTheme === "qa"
                    ? qaColors[status]
                    : viewMode === "2d" &&
                        ["terrain", "road", "curb", "fence", "pole", "manhole", "unknown"].includes(
                          kind,
                        )
                      ? 0xd2dae4
                      : cadKindMeta[kind].color,
                transparent: true,
                opacity:
                  viewMode === "2d"
                    ? kind === "unknown"
                      ? 0.72
                      : kind === "annotation"
                        ? 0.82
                        : 0.96
                    : kind === "terrain"
                      ? 0.42
                      : kind === "unknown"
                        ? 0.28
                        : kind === "annotation"
                          ? 0.34
                          : 0.96,
                depthWrite: false,
                toneMapped: false,
              }),
            ]),
          ),
        ]),
      ) as Record<CadKind, Record<CadQaStatus, InstanceType<typeof THREE.LineBasicMaterial>>>;

      const areaMaterials: Record<
        "road" | "site" | "water",
        InstanceType<typeof THREE.MeshStandardMaterial>
      > = {
        road: new THREE.MeshStandardMaterial({
          color: 0x505861,
          roughness: 0.94,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
        site: new THREE.MeshStandardMaterial({
          color: cadKindMeta.site.color,
          roughness: 0.9,
          side: THREE.DoubleSide,
        }),
        water: new THREE.MeshStandardMaterial({
          color: cadKindMeta.water.color,
          roughness: 0.48,
          transparent: true,
          opacity: 0.82,
          side: THREE.DoubleSide,
        }),
      };
      const buildingWallMaterial = new THREE.MeshStandardMaterial({
        color: cadKindMeta.building.color,
        roughness: 0.74,
        metalness: 0.02,
      });
      const defaultBuildingRoofColor = 0xb85c2d;
      const buildingRoofMaterials = new Map<
        number,
        InstanceType<typeof THREE.MeshStandardMaterial>
      >();
      const buildingRoofMaterialFor = (feature: (typeof result.features)[number]) => {
        const sourceColor =
          feature.sourceColor !== undefined &&
          feature.sourceColor >= 0 &&
          feature.sourceColor <= 0xffffff
            ? feature.sourceColor
            : defaultBuildingRoofColor;
        const existing = buildingRoofMaterials.get(sourceColor);
        if (existing) return existing;
        const color = new THREE.Color(sourceColor);
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        color.setHSL(hsl.h, Math.max(0.42, hsl.s), Math.min(0.74, hsl.l));
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.82 });
        buildingRoofMaterials.set(sourceColor, material);
        return material;
      };
      const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x7c4a24, roughness: 1 });
      const crownMaterial = new THREE.MeshStandardMaterial({ color: 0x22a447, roughness: 0.9 });
      const markerMaterials: Record<
        "pole" | "sign" | "manhole" | "waste" | "utility",
        InstanceType<typeof THREE.MeshStandardMaterial>
      > = {
        pole: new THREE.MeshStandardMaterial({ color: cadKindMeta.pole.color, roughness: 0.75 }),
        sign: new THREE.MeshStandardMaterial({ color: cadKindMeta.sign.color, roughness: 0.72 }),
        manhole: new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.72 }),
        waste: new THREE.MeshStandardMaterial({ color: 0xdc5b45, roughness: 0.8 }),
        utility: new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.72 }),
      };
      const pathMaterials: Record<
        "road" | "curb" | "ditch" | "utility" | "water" | "wire",
        InstanceType<typeof THREE.MeshStandardMaterial>
      > = {
        road: areaMaterials.road,
        curb: new THREE.MeshStandardMaterial({
          color: cadKindMeta.curb.color,
          roughness: 0.86,
          side: THREE.DoubleSide,
        }),
        ditch: new THREE.MeshStandardMaterial({
          color: cadKindMeta.ditch.color,
          roughness: 0.9,
          side: THREE.DoubleSide,
        }),
        utility: new THREE.MeshStandardMaterial({
          color: 0x7c3aed,
          roughness: 0.78,
          side: THREE.DoubleSide,
        }),
        water: areaMaterials.water,
        wire: new THREE.MeshStandardMaterial({
          color: cadKindMeta.wire.color,
          roughness: 0.72,
          side: THREE.DoubleSide,
        }),
      };
      const fenceMaterial = new THREE.MeshStandardMaterial({
        color: cadKindMeta.fence.color,
        roughness: 0.92,
        side: THREE.DoubleSide,
      });
      const qaMaterials: Record<CadQaStatus, InstanceType<typeof THREE.MeshStandardMaterial>> = {
        AUTO: new THREE.MeshStandardMaterial({ color: qaColors.AUTO, roughness: 0.82 }),
        REVIEW: new THREE.MeshStandardMaterial({ color: qaColors.REVIEW, roughness: 0.82 }),
        REJECT: new THREE.MeshStandardMaterial({ color: qaColors.REJECT, roughness: 0.82 }),
      };
      const featureMaterial = (
        feature: (typeof result.features)[number],
        semantic: InstanceType<typeof THREE.MeshStandardMaterial>,
      ) => (displayTheme === "qa" ? qaMaterials[feature.qaStatus ?? "REVIEW"] : semantic);

      let volumeCount = 0;
      const markerCounts = { vegetation: 0, pole: 0, sign: 0, manhole: 0, waste: 0, utility: 0 };
      const markerLimits = {
        vegetation: 700,
        pole: 700,
        sign: 260,
        manhole: 260,
        waste: 180,
        utility: 420,
      };
      const linePositions = Object.fromEntries(
        cadKinds.map((kind) => [
          kind,
          {
            AUTO: [] as number[],
            REVIEW: [] as number[],
            REJECT: [] as number[],
          },
        ]),
      ) as Record<CadKind, Record<CadQaStatus, number[]>>;
      const maxLineSegments = 350_000;
      // Пятна домов
      const insideBuilding = createBuildingMask(
        result.features,
        WALL_TOUCH_TOLERANCE_METERS * sourceUnitsPerMeter,
      );
      let lineSegmentCount = 0;
      const ribbonKinds = ["road", "curb", "ditch", "utility", "water", "wire"] as const;
      const ribbonBuckets = Object.fromEntries(
        ribbonKinds.map((kind) => [kind, { positions: [] as number[], indices: [] as number[] }]),
      ) as Record<(typeof ribbonKinds)[number], { positions: number[]; indices: number[] }>;
      const fenceBucket = { positions: [] as number[], indices: [] as number[] };
      const treePlacements: Array<{
        x: number;
        z: number;
        baseHeight: number;
        visibleHeight: number;
        qaStatus: CadQaStatus;
      }> = [];
      let ribbonSegmentCount = 0;
      let fenceSegmentCount = 0;
      const features = result.features;

      for (const feature of features) {
        if (viewMode === "3d" && feature.kind !== "terrain" && !isCadFeatureRenderable(feature))
          continue;
        if (feature.kind === "annotation" && feature.points.length <= 1) continue;
        const points = feature.points;
        if (!points.length) continue;
        const center = points.reduce(
          (sum, value) => ({
            x: sum.x + value.x / points.length,
            y: sum.y + value.y / points.length,
          }),
          { x: 0, y: 0 },
        );
        const baseElevation = feature.baseElevation ?? resolvedElevation(points[0]);
        const baseHeight = worldHeight(baseElevation) + surfaceLift;
        const qaStatus = feature.qaStatus ?? "REVIEW";
        const objectHeight = resolveCadObjectHeight(feature).heightMeters;

        if (
          viewMode === "3d" &&
          feature.kind === "terrain" &&
          points.length > 1 &&
          lineSegmentCount < maxLineSegments
        ) {
          const positions = linePositions.terrain[qaStatus];
          const limit = Math.min(points.length - 1, maxLineSegments - lineSegmentCount);
          for (let index = 0; index < limit; index += 1) {
            const a = points[index];
            const b = points[index + 1];
            positions.push(
              worldX(a.x),
              worldHeight(resolvedElevation(a)) + surfaceLift * 2,
              worldZ(a.y),
              worldX(b.x),
              worldHeight(resolvedElevation(b)) + surfaceLift * 2,
              worldZ(b.y),
            );
            lineSegmentCount += 1;
          }
          continue;
        }

        if (
          viewMode === "3d" &&
          isBuildingFootprint(feature) &&
          objectHeight &&
          volumeCount < 380
        ) {
          const shape = new THREE.Shape();
          points.forEach((value, index) => {
            const x = worldX(value.x);
            const y = -worldZ(value.y);
            if (index === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
          });
          const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: worldLength(objectHeight),
            bevelEnabled: false,
            curveSegments: 1,
          });
          geometry.rotateX(-Math.PI / 2);
          const buildingMaterials =
            displayTheme === "qa"
              ? [qaMaterials[qaStatus], qaMaterials[qaStatus]]
              : [buildingRoofMaterialFor(feature), buildingWallMaterial];
          const mesh = new THREE.Mesh(geometry, buildingMaterials);
          mesh.position.y = baseHeight;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          groups.building.add(mesh);
          volumeCount += 1;
          continue;
        }

        if (
          viewMode === "3d" &&
          ["road", "site", "water"].includes(feature.kind) &&
          feature.closed &&
          points.length >= 3 &&
          points.length <= 400 &&
          volumeCount < 520
        ) {
          // Покрытие ложится на рельеф
          const contour = points.map(
            (value) => new THREE.Vector2(worldX(value.x), worldZ(value.y)),
          );
          const elevations = points.map((value) => resolvedElevation(value));
          if (
            contour.length > 3 &&
            contour[0].distanceToSquared(contour[contour.length - 1]) < 1e-12
          ) {
            contour.pop();
            elevations.pop();
          }
          const vertices = contour.map((point, index) => ({
            x: point.x,
            z: point.y,
            elevation: elevations[index],
          }));
          const midpoints = new Map<string, number>();
          const maxEdge = worldLength(4);
          const midpoint = (a: number, b: number) => {
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            const existing = midpoints.get(key);
            if (existing !== undefined) return existing;
            const x = (vertices[a].x + vertices[b].x) / 2;
            const z = (vertices[a].z + vertices[b].z) / 2;
            const sampled = terrainResolver(x / worldScale + centerX, z / worldScale + centerY);
            const index =
              vertices.push({
                x,
                z,
                elevation: sampled ?? (vertices[a].elevation + vertices[b].elevation) / 2,
              }) - 1;
            midpoints.set(key, index);
            return index;
          };
          const triangles: number[][] = [];
          const edge = (a: number, b: number) =>
            Math.hypot(vertices[a].x - vertices[b].x, vertices[a].z - vertices[b].z);
          const subdivide = (a: number, b: number, c: number, depth: number) => {
            if (
              depth >= 5 ||
              triangles.length > 6_000 ||
              Math.max(edge(a, b), edge(b, c), edge(c, a)) <= maxEdge
            ) {
              triangles.push([a, b, c]);
              return;
            }
            const ab = midpoint(a, b);
            const bc = midpoint(b, c);
            const ca = midpoint(c, a);
            subdivide(a, ab, ca, depth + 1);
            subdivide(ab, b, bc, depth + 1);
            subdivide(ca, bc, c, depth + 1);
            subdivide(ab, bc, ca, depth + 1);
          };
          for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, []))
            subdivide(a, b, c, 0);
          const positions = new Float32Array(triangles.length * 9);
          triangles.forEach(([a, b, c], index) => {
            // Нормаль вверх
            const up =
              (vertices[b].z - vertices[a].z) * (vertices[c].x - vertices[a].x) -
              (vertices[b].x - vertices[a].x) * (vertices[c].z - vertices[a].z);
            const corners = up < 0 ? [a, c, b] : [a, b, c];
            corners.forEach((vertex, corner) => {
              const offset = index * 9 + corner * 3;
              positions[offset] = vertices[vertex].x;
              positions[offset + 1] = worldHeight(vertices[vertex].elevation) + surfaceLift;
              positions[offset + 2] = vertices[vertex].z;
            });
          });
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          geometry.computeVertexNormals();
          const mesh = new THREE.Mesh(
            geometry,
            featureMaterial(feature, areaMaterials[feature.kind as "road" | "site" | "water"]),
          );
          mesh.receiveShadow = true;
          groups[feature.kind].add(mesh);
          volumeCount += 1;
          continue;
        }

        if (
          viewMode === "3d" &&
          feature.kind === "vegetation" &&
          isPointCadObject(feature) &&
          markerCounts.vegetation < markerLimits.vegetation
        ) {
          const heightMeters = objectHeight ?? 0;
          if (!heightMeters) continue;
          const visibleHeight = worldLength(heightMeters);
          treePlacements.push({
            x: worldX(center.x),
            z: worldZ(center.y),
            baseHeight,
            visibleHeight,
            qaStatus,
          });
          markerCounts.vegetation += 1;
          continue;
        } else if (
          viewMode === "3d" &&
          ["pole", "sign", "waste", "manhole", "utility"].includes(feature.kind) &&
          isPointCadObject(feature) &&
          (feature.kind !== "utility" || points.length === 1) &&
          markerCounts[feature.kind as "pole" | "sign" | "waste" | "manhole" | "utility"] <
            markerLimits[feature.kind as "pole" | "sign" | "waste" | "manhole" | "utility"]
        ) {
          const markerKind = feature.kind as "pole" | "sign" | "waste" | "manhole" | "utility";
          const height =
            feature.kind === "manhole" || feature.kind === "utility"
              ? worldLength(0.06)
              : worldLength(objectHeight ?? 0);
          if (!height) continue;
          const semanticMaterial =
            markerMaterials[feature.kind as "pole" | "sign" | "manhole" | "waste" | "utility"];
          const marker = new THREE.Mesh(
            new THREE.CylinderGeometry(
              worldLength(
                feature.kind === "pole" || feature.kind === "sign"
                  ? 0.12
                  : feature.kind === "manhole"
                    ? 0.42
                    : 0.35,
              ),
              worldLength(
                feature.kind === "pole" || feature.kind === "sign"
                  ? 0.18
                  : feature.kind === "manhole"
                    ? 0.42
                    : 0.45,
              ),
              height,
              feature.kind === "manhole" ? 16 : 7,
            ),
            featureMaterial(feature, semanticMaterial),
          );
          marker.position.set(worldX(center.x), baseHeight + height / 2, worldZ(center.y));
          marker.castShadow = true;
          groups[feature.kind].add(marker);
          if (feature.kind === "sign") {
            const face = new THREE.Mesh(
              new THREE.BoxGeometry(worldLength(0.7), worldLength(0.65), worldLength(0.08)),
              featureMaterial(feature, markerMaterials.sign),
            );
            face.position.set(worldX(center.x), baseHeight + height * 0.82, worldZ(center.y));
            face.castShadow = true;
            groups.sign.add(face);
          }
          markerCounts[markerKind] += 1;
          continue;
        }

        if (
          viewMode === "3d" &&
          ribbonKinds.includes(feature.kind as (typeof ribbonKinds)[number]) &&
          points.length > 1 &&
          ribbonSegmentCount < 90_000
        ) {
          const kind = feature.kind as (typeof ribbonKinds)[number];
          const bucket = ribbonBuckets[kind];
          const halfWidth = worldLength(cadPathWidthMeters(feature)) / 2;
          const limit = Math.min(points.length - 1, 90_000 - ribbonSegmentCount);
          for (let index = 0; index < limit; index += 1) {
            const a = points[index];
            const b = points[index + 1];
            const ax = worldX(a.x);
            const az = worldZ(a.y);
            const bx = worldX(b.x);
            const bz = worldZ(b.y);
            const dx = bx - ax;
            const dz = bz - az;
            const length = Math.hypot(dx, dz);
            if (length < 1e-8) continue;
            const nx = (-dz / length) * halfWidth;
            const nz = (dx / length) * halfWidth;
            const pathLift = kind === "road" ? pavementLift : surfaceLift;
            const ay = worldHeight(resolvedElevation(a)) + pathLift;
            const by = worldHeight(resolvedElevation(b)) + pathLift;
            const offset = bucket.positions.length / 3;
            bucket.positions.push(
              ax + nx,
              ay,
              az + nz,
              ax - nx,
              ay,
              az - nz,
              bx + nx,
              by,
              bz + nz,
              bx - nx,
              by,
              bz - nz,
            );
            bucket.indices.push(offset, offset + 1, offset + 3, offset, offset + 3, offset + 2);
            ribbonSegmentCount += 1;
          }
          continue;
        }

        if (
          viewMode === "3d" &&
          feature.kind === "fence" &&
          points.length > 1 &&
          fenceSegmentCount < 45_000
        ) {
          const height = worldLength(objectHeight ?? 1.8);
          const limit = Math.min(points.length - 1, 45_000 - fenceSegmentCount);
          for (let index = 0; index < limit; index += 1) {
            const a = points[index];
            const b = points[index + 1];
            const ax = worldX(a.x);
            const az = worldZ(a.y);
            const bx = worldX(b.x);
            const bz = worldZ(b.y);
            const ay = worldHeight(resolvedElevation(a)) + surfaceLift;
            const by = worldHeight(resolvedElevation(b)) + surfaceLift;
            const offset = fenceBucket.positions.length / 3;
            fenceBucket.positions.push(
              ax,
              ay,
              az,
              bx,
              by,
              bz,
              ax,
              ay + height,
              az,
              bx,
              by + height,
              bz,
            );
            fenceBucket.indices.push(
              offset,
              offset + 1,
              offset + 3,
              offset,
              offset + 3,
              offset + 2,
            );
            fenceSegmentCount += 1;
          }
          continue;
        }

        if (viewMode === "3d" && points.length > 1 && lineSegmentCount < maxLineSegments) {
          const positions = linePositions[feature.kind][qaStatus];
          const limit = Math.min(points.length - 1, maxLineSegments - lineSegmentCount);
          const clipAtBuildings = isGroundLineKind(feature.kind);
          for (let index = 0; index < limit; index += 1) {
            const a = points[index];
            const b = points[index + 1];
            // Наземная линия обрывается на стене дома
            if (clipAtBuildings && insideBuilding((a.x + b.x) / 2, (a.y + b.y) / 2)) continue;
            positions.push(
              worldX(a.x),
              worldHeight(resolvedElevation(a)) + surfaceLift * 2,
              worldZ(a.y),
              worldX(b.x),
              worldHeight(resolvedElevation(b)) + surfaceLift * 2,
              worldZ(b.y),
            );
            lineSegmentCount += 1;
          }
          continue;
        }

        if (
          viewMode === "2d" &&
          points.length === 1 &&
          feature.kind !== "annotation" &&
          lineSegmentCount + 2 <= maxLineSegments
        ) {
          const value = points[0];
          const x = worldX(value.x);
          const z = worldZ(value.y);
          const y = worldHeight(resolvedElevation(value)) + surfaceLift;
          const radius = Math.max(worldLength(0.45), 0.06);
          linePositions[feature.kind][qaStatus].push(
            x - radius,
            y,
            z,
            x + radius,
            y,
            z,
            x,
            y,
            z - radius,
            x,
            y,
            z + radius,
          );
          lineSegmentCount += 2;
          continue;
        }

        if (viewMode === "2d" && points.length > 1 && lineSegmentCount < maxLineSegments) {
          const positions = linePositions[feature.kind][qaStatus];
          const segmentLimit = Math.min(points.length - 1, maxLineSegments - lineSegmentCount);
          for (let index = 0; index < segmentLimit; index += 1) {
            const a = points[index];
            const b = points[index + 1];
            positions.push(
              worldX(a.x),
              worldHeight(resolvedElevation(a)) + surfaceLift,
              worldZ(a.y),
              worldX(b.x),
              worldHeight(resolvedElevation(b)) + surfaceLift,
              worldZ(b.y),
            );
            lineSegmentCount += 1;
          }
          const first = points[0];
          const last = points[points.length - 1];
          if (
            feature.closed &&
            lineSegmentCount < maxLineSegments &&
            (Math.abs(first.x - last.x) > 1e-8 || Math.abs(first.y - last.y) > 1e-8)
          ) {
            positions.push(
              worldX(last.x),
              worldHeight(resolvedElevation(last)) + surfaceLift,
              worldZ(last.y),
              worldX(first.x),
              worldHeight(resolvedElevation(first)) + surfaceLift,
              worldZ(first.y),
            );
            lineSegmentCount += 1;
          }
        }
      }

      if (treePlacements.length) {
        const trunkGeometry = new THREE.CylinderGeometry(
          worldLength(0.16),
          worldLength(0.22),
          1,
          6,
        );
        const crownGeometry = new THREE.IcosahedronGeometry(1, 0);
        const qaTreeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
        const trunks = new THREE.InstancedMesh(
          trunkGeometry,
          displayTheme === "qa" ? qaTreeMaterial : trunkMaterial,
          treePlacements.length,
        );
        const crowns = new THREE.InstancedMesh(
          crownGeometry,
          displayTheme === "qa" ? qaTreeMaterial : crownMaterial,
          treePlacements.length,
        );
        const transform = new THREE.Object3D();
        treePlacements.forEach((tree, index) => {
          const trunkHeight = tree.visibleHeight * 0.5;
          const crownRadius = tree.visibleHeight * 0.16;
          transform.position.set(tree.x, tree.baseHeight + trunkHeight / 2, tree.z);
          transform.scale.set(1, trunkHeight, 1);
          transform.updateMatrix();
          trunks.setMatrixAt(index, transform.matrix);
          transform.position.set(
            tree.x,
            tree.baseHeight + trunkHeight + crownRadius * 0.62,
            tree.z,
          );
          transform.scale.setScalar(crownRadius);
          transform.updateMatrix();
          crowns.setMatrixAt(index, transform.matrix);
          if (displayTheme === "qa") {
            const color = new THREE.Color(qaColors[tree.qaStatus]);
            trunks.setColorAt(index, color);
            crowns.setColorAt(index, color);
          }
        });
        trunks.instanceMatrix.needsUpdate = true;
        crowns.instanceMatrix.needsUpdate = true;
        if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
        if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
        trunks.castShadow = true;
        crowns.castShadow = true;
        groups.vegetation.add(trunks, crowns);
      }

      for (const kind of ribbonKinds) {
        const bucket = ribbonBuckets[kind];
        if (!bucket.positions.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(bucket.positions, 3));
        geometry.setIndex(bucket.indices);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, pathMaterials[kind]);
        mesh.receiveShadow = true;
        groups[kind].add(mesh);
      }
      if (fenceBucket.positions.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(fenceBucket.positions, 3),
        );
        geometry.setIndex(fenceBucket.indices);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, fenceMaterial);
        mesh.castShadow = true;
        groups.fence.add(mesh);
      }

      for (const kind of cadKinds) {
        for (const status of qaStatuses) {
          const positions = linePositions[kind][status];
          if (!positions.length) continue;
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          groups[kind].add(new THREE.LineSegments(geometry, lineMaterials[kind][status]));
        }
      }

      const elevationWorld = Math.max(0, worldHeight(terrain.maxElevation));
      controls.target.set(0, Math.min(8, elevationWorld / 2), 0);
      if (viewMode === "2d") {
        camera.position.set(0, Math.max(92, elevationWorld + 60), 0.01);
        controls.enableRotate = false;
        controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      } else {
        camera.position.set(82, Math.max(64, elevationWorld + 54), 98);
        controls.enableRotate = true;
      }
      camera.lookAt(controls.target);

      // Колесо приближает к точке под курсором и останавливается перед рельефом или объектом (в 2D
      const zoomSurfaces: InstanceType<typeof THREE.Object3D>[] = [];
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) zoomSurfaces.push(object);
      });
      const disposeSurfaceZoom = installSurfaceZoom(controls, camera, host, {
        minDistance: 0.3,
        margin: 0.45,
        targets: () => zoomSurfaces,
        fallbackPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      });

      let frame = 0;
      const resize = () => {
        const width = Math.max(host.clientWidth, 1);
        const height = Math.max(host.clientHeight, 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();
      const animate = () => {
        controls.update();
        renderer.render(scene, camera);
        frame = requestAnimationFrame(animate);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        disposeSurfaceZoom();
        scene.traverse((object) => {
          const mesh = object as InstanceType<typeof THREE.Mesh>;
          if (mesh.geometry) mesh.geometry.dispose();
          const material = mesh.material;
          if (Array.isArray(material)) material.forEach((value) => value.dispose());
          else material?.dispose();
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    }

    void buildScene();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [displayTheme, result, visibleKinds, viewMode, wireframe]);

  return (
    <div className="cad-viewport-canvas" ref={hostRef} aria-label="Интерактивная 3D-модель DWG" />
  );
}
