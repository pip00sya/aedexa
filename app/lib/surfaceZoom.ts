import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface SurfaceZoomOptions {
  minDistance: number;
  /** На каком расстоянии перед поверхностью камера останавливается */
  margin: number;
  targets: () => THREE.Object3D[];
  fallbackPlane?: THREE.Plane;
}

const RAYCAST_INTERVAL_MS = 40;

export function installSurfaceZoom(
  controls: OrbitControls,
  camera: THREE.PerspectiveCamera,
  element: HTMLElement,
  options: SurfaceZoomOptions,
): () => void {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const planeHit = new THREE.Vector3();
  let lastRaycastAt = 0;
  controls.zoomToCursor = true;
  controls.minDistance = options.minDistance;

  const onWheel = (event: WheelEvent) => {
    if (event.deltaY >= 0) {
      controls.minDistance = options.minDistance;
      return;
    }
    const now = performance.now();
    if (now - lastRaycastAt < RAYCAST_INTERVAL_MS) return;
    lastRaycastAt = now;

    const rect = (controls.domElement ?? element).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);

    let surfaceDistance =
      raycaster.intersectObjects(options.targets(), false)[0]?.distance ?? Number.POSITIVE_INFINITY;
    if (
      !Number.isFinite(surfaceDistance) &&
      options.fallbackPlane &&
      raycaster.ray.intersectPlane(options.fallbackPlane, planeHit)
    ) {
      surfaceDistance = raycaster.ray.origin.distanceTo(planeHit);
    }
    if (!Number.isFinite(surfaceDistance)) {
      controls.minDistance = options.minDistance;
      return;
    }
    const radius = camera.position.distanceTo(controls.target);
    const allowedTravel = Math.max(0, surfaceDistance - options.margin);
    controls.minDistance = Math.max(options.minDistance, radius - allowedTravel);
  };

  element.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => element.removeEventListener("wheel", onWheel, { capture: true });
}
