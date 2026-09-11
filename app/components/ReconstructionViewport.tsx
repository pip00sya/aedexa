"use client";

import { Box, Scan, ScanLine, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  createReconstructionGroup,
  disposeReconstructionGroup,
  setReconstructionOutlineMode,
} from "../lib/reconstruction/modelScene";
import type { ReconstructionModel } from "../lib/reconstruction/types";
import { installSurfaceZoom } from "../lib/surfaceZoom";

interface Props {
  model: ReconstructionModel;
}

export default function ReconstructionViewport({ model }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const boundsRef = useRef<{ center: THREE.Vector3; distance: number } | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const outlineOnlyRef = useRef(false);
  const [outlineOnly, setOutlineOnly] = useState(false);

  const setView = (view: "iso" | "front" | "top") => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const bounds = boundsRef.current;
    if (!camera || !controls || !bounds) return;
    const { center, distance } = bounds;
    if (view === "front") camera.position.set(center.x, center.y, center.z + distance);
    else if (view === "top")
      camera.position.set(center.x, center.y + distance, center.z + distance * 0.001);
    else
      camera.position.set(
        center.x + distance * 0.78,
        center.y + distance * 0.62,
        center.z + distance * 0.78,
      );
    camera.up.set(0, 1, 0);
    controls.target.copy(center);
    controls.update();
    renderRef.current?.();
  };

  const toggleOutline = () => {
    setOutlineOnly((current) => {
      const next = !current;
      outlineOnlyRef.current = next;
      if (groupRef.current) setReconstructionOutlineMode(groupRef.current, next);
      renderRef.current?.();
      return next;
    });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      const message = document.createElement("p");
      message.className = "reconstruction-viewport-error";
      message.setAttribute("role", "alert");
      message.textContent = "3D-просмотр недоступен: браузер не смог запустить WebGL.";
      host.replaceChildren(message);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xe9f1f7, 1);
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", `Интерактивная 3D-модель: ${model.title}`);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1_000);
    cameraRef.current = camera;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8ca0b5, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.7);
    keyLight.position.set(4, 8, 6);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xb9d5ff, 1.2);
    fillLight.position.set(-5, 3, -4);
    scene.add(fillLight);

    const group = createReconstructionGroup(model);
    groupRef.current = group;
    setReconstructionOutlineMode(group, outlineOnlyRef.current);
    scene.add(group);
    const bounds = new THREE.Box3().setFromObject(group);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    const distance = span * 1.75;
    // Ближняя плоскость
    camera.near = Math.max(span * 0.005, 0.001);
    camera.far = Math.max(span * 40, camera.near * 1_000);
    camera.updateProjectionMatrix();
    boundsRef.current = { center, distance };

    const gridSize = Math.max(size.x, size.z, span) * 1.8;
    const grid = new THREE.GridHelper(gridSize, 20, 0x8fa9c2, 0xc5d4e2);
    grid.position.y = bounds.min.y - span * 0.02;
    scene.add(grid);
    const axes = new THREE.AxesHelper(span * 0.22);
    axes.position.set(bounds.min.x, grid.position.y, bounds.min.z);
    scene.add(axes);

    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.maxDistance = span * 30;
    const meshes: THREE.Object3D[] = [];
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object);
    });
    const disposeSurfaceZoom = installSurfaceZoom(controls, camera, host, {
      minDistance: span * 0.004,
      margin: span * 0.01,
      targets: () => meshes,
    });

    const render = () => renderer.render(scene, camera);
    renderRef.current = render;
    controls.addEventListener("change", render);
    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    setView("iso");
    resize();

    return () => {
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      disposeSurfaceZoom();
      disposeReconstructionGroup(group);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      axes.geometry.dispose();
      (axes.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      cameraRef.current = null;
      controlsRef.current = null;
      groupRef.current = null;
      boundsRef.current = null;
      renderRef.current = null;
    };
  }, [model]);

  return (
    <div className="reconstruction-viewport-shell">
      <div className="reconstruction-view-controls" aria-label="Режим просмотра 3D">
        <button type="button" onClick={() => setView("iso")}>
          <Box size={15} /> Объём
        </button>
        <button type="button" onClick={() => setView("front")}>
          <Square size={15} /> Фасад
        </button>
        <button type="button" onClick={() => setView("top")}>
          <ScanLine size={15} /> Сверху
        </button>
        <button
          type="button"
          className={outlineOnly ? "active" : ""}
          aria-pressed={outlineOnly}
          onClick={toggleOutline}
        >
          <Scan size={15} /> Контур
        </button>
      </div>
      <div ref={hostRef} className="reconstruction-viewport" />
    </div>
  );
}
