import * as THREE from "three";
import type { ReconstructionModel, ReconstructionPart } from "./types";

function geometryForPart(part: ReconstructionPart) {
  if (part.kind === "box") return new THREE.BoxGeometry(part.size.x, part.size.y, part.size.z);
  if (part.kind === "cylinder")
    return new THREE.CylinderGeometry(part.radius, part.radius, part.height, 64);
  if (part.kind === "extrusion") {
    const shape = new THREE.Shape();
    part.profile.forEach((point, index) => {
      if (index === 0) shape.moveTo(point.x, -point.z);
      else shape.lineTo(point.x, -point.z);
    });
    shape.closePath();
    part.holes.forEach((hole) => {
      const path = new THREE.Path();
      hole.forEach((point, index) => {
        if (index === 0) path.moveTo(point.x, -point.z);
        else path.lineTo(point.x, -point.z);
      });
      path.closePath();
      shape.holes.push(path);
    });
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: part.height,
      bevelEnabled: false,
      curveSegments: 24,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -part.height / 2, 0);
    return geometry;
  }
  if (part.kind === "revolution") {
    const geometry = new THREE.LatheGeometry(
      part.profile.map((point) => new THREE.Vector2(Math.abs(point.x), point.z)),
      64,
    );
    geometry.center();
    return geometry;
  }

  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  part.faces.forEach((face) => {
    [face.a, face.b, face.c].forEach((index) => {
      const vertex = part.vertices[index];
      positions.push(vertex.x, vertex.y, vertex.z);
    });
  });
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function createReconstructionGroup(model: ReconstructionModel) {
  const group = new THREE.Group();
  group.name = model.title;
  group.userData = {
    sourceName: model.sourceName,
    unit: model.unit,
    method: model.method,
    confidence: model.overallConfidence,
    exportStatus: model.canExport ? "verified" : "draft",
  };

  model.parts.forEach((part) => {
    const geometry = geometryForPart(part);
    const material = new THREE.MeshStandardMaterial({
      color: part.color,
      roughness: 0.62,
      metalness: 0.04,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = part.name;
    mesh.position.set(part.position.x, part.position.y, part.position.z);
    mesh.rotation.set(
      THREE.MathUtils.degToRad(part.rotationDegrees.x),
      THREE.MathUtils.degToRad(part.rotationDegrees.y),
      THREE.MathUtils.degToRad(part.rotationDegrees.z),
    );
    mesh.userData = { partId: part.id, confidence: part.confidence, evidence: part.evidence };

    if (part.faces.length < 5_000) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 28),
        new THREE.LineBasicMaterial({ color: 0x17304e, transparent: true, opacity: 0.42 }),
      );
      mesh.add(edges);
    }
    group.add(mesh);
  });
  return group;
}

export function setReconstructionOutlineMode(group: THREE.Group, outlineOnly: boolean) {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        material.transparent = outlineOnly;
        material.opacity = outlineOnly ? 0 : 1;
        material.depthWrite = !outlineOnly;
        material.colorWrite = !outlineOnly;
        material.needsUpdate = true;
      });
    } else if (object instanceof THREE.LineSegments) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        material.transparent = true;
        material.opacity = outlineOnly ? 0.92 : 0.42;
        material.depthTest = !outlineOnly;
        material.depthWrite = !outlineOnly;
        material.needsUpdate = true;
      });
      object.renderOrder = outlineOnly ? 10 : 0;
    }
  });
}

export function disposeReconstructionGroup(group: THREE.Group) {
  group.traverse((object) => {
    const candidate = object as THREE.Mesh;
    candidate.geometry?.dispose();
    const materials = Array.isArray(candidate.material)
      ? candidate.material
      : candidate.material
        ? [candidate.material]
        : [];
    materials.forEach((material) => material.dispose());
  });
}

function unitToMeters(unit: ReconstructionModel["unit"]) {
  if (unit === "mm") return 0.001;
  if (unit === "cm") return 0.01;
  if (unit === "in") return 0.0254;
  return 1;
}

function xml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function number(value: number) {
  if (!Number.isFinite(value)) throw new Error("Модель содержит недопустимую координату.");
  return Number(value.toFixed(9)).toString();
}

export function exportReconstructionDae(model: ReconstructionModel) {
  const group = createReconstructionGroup(model);
  group.scale.setScalar(unitToMeters(model.unit));
  group.updateMatrixWorld(true);

  try {
    const meshes = group.children.filter(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    );
    if (!meshes.length) throw new Error("В модели нет геометрии для экспорта в SketchUp.");

    const effects: string[] = [];
    const materials: string[] = [];
    const geometries: string[] = [];
    const nodes: string[] = [];

    meshes.forEach((mesh, meshIndex) => {
      const id = `part-${meshIndex}`;
      const positions = mesh.geometry.getAttribute("position");
      const normals = mesh.geometry.getAttribute("normal");
      const vertexCount = mesh.geometry.index?.count ?? positions?.count ?? 0;
      if (!positions || !normals || vertexCount === 0 || vertexCount % 3 !== 0) {
        throw new Error(`Деталь «${mesh.name}» не содержит корректной треугольной сетки.`);
      }

      const position = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      const positionValues: string[] = [];
      const normalValues: string[] = [];
      const triangleIndices: string[] = [];

      for (let cursor = 0; cursor < vertexCount; cursor += 1) {
        const sourceIndex = mesh.geometry.index?.getX(cursor) ?? cursor;
        position.fromBufferAttribute(positions, sourceIndex).applyMatrix4(mesh.matrixWorld);
        normal.fromBufferAttribute(normals, sourceIndex).applyNormalMatrix(normalMatrix);
        positionValues.push(number(position.x), number(position.y), number(position.z));
        normalValues.push(number(normal.x), number(normal.y), number(normal.z));
        triangleIndices.push(String(cursor), String(cursor));
      }

      const meshMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const color =
        meshMaterial instanceof THREE.MeshStandardMaterial
          ? meshMaterial.color
          : new THREE.Color(0x5d83b5);
      effects.push(
        `<effect id="effect-${id}"><profile_COMMON><technique sid="common"><lambert><diffuse><color>${number(color.r)} ${number(color.g)} ${number(color.b)} 1</color></diffuse></lambert></technique></profile_COMMON></effect>`,
      );
      materials.push(
        `<material id="material-${id}" name="${xml(mesh.name)}"><instance_effect url="#effect-${id}"/></material>`,
      );
      geometries.push(
        `<geometry id="geometry-${id}" name="${xml(mesh.name)}"><mesh><source id="geometry-${id}-positions"><float_array id="geometry-${id}-positions-array" count="${positionValues.length}">${positionValues.join(" ")}</float_array><technique_common><accessor source="#geometry-${id}-positions-array" count="${vertexCount}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><source id="geometry-${id}-normals"><float_array id="geometry-${id}-normals-array" count="${normalValues.length}">${normalValues.join(" ")}</float_array><technique_common><accessor source="#geometry-${id}-normals-array" count="${vertexCount}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="geometry-${id}-vertices"><input semantic="POSITION" source="#geometry-${id}-positions"/></vertices><triangles material="material-${id}-symbol" count="${vertexCount / 3}"><input semantic="VERTEX" source="#geometry-${id}-vertices" offset="0"/><input semantic="NORMAL" source="#geometry-${id}-normals" offset="1"/><p>${triangleIndices.join(" ")}</p></triangles></mesh></geometry>`,
      );
      nodes.push(
        `<node id="node-${id}" name="${xml(mesh.name)}"><instance_geometry url="#geometry-${id}"><bind_material><technique_common><instance_material symbol="material-${id}-symbol" target="#material-${id}"/></technique_common></bind_material></instance_geometry></node>`,
      );
    });

    const timestamp = new Date().toISOString();
    const content = `<?xml version="1.0" encoding="UTF-8"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><authoring_tool>AEDEXA 2D to 3D</authoring_tool></contributor><created>${timestamp}</created><modified>${timestamp}</modified><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis><extra><technique profile="AEDEXA"><source_name>${xml(model.sourceName)}</source_name><source_unit>${model.unit}</source_unit><confidence>${number(model.overallConfidence)}</confidence><export_status>${model.canExport ? "verified" : "draft"}</export_status></technique></extra></asset><library_effects>${effects.join("")}</library_effects><library_materials>${materials.join("")}</library_materials><library_geometries>${geometries.join("")}</library_geometries><library_visual_scenes><visual_scene id="Scene" name="${xml(model.title)}">${nodes.join("")}</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>`;
    return new Blob([content], { type: "model/vnd.collada+xml" });
  } finally {
    disposeReconstructionGroup(group);
  }
}

export async function exportReconstructionGlb(model: ReconstructionModel) {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const group = createReconstructionGroup(model);
  group.scale.setScalar(unitToMeters(model.unit));
  group.updateMatrixWorld(true);
  try {
    const result = await new GLTFExporter().parseAsync(group, {
      binary: true,
      onlyVisible: true,
    });
    if (!(result instanceof ArrayBuffer))
      throw new Error("Экспорт вернул текстовый glTF вместо GLB.");
    return new Blob([result], { type: "model/gltf-binary" });
  } finally {
    disposeReconstructionGroup(group);
  }
}
