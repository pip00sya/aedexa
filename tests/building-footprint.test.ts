import assert from "node:assert/strict";
import test from "node:test";
import { Mesh } from "three";
import { buildFootprintBases } from "../app/lib/reconstruction/buildingFootprint.ts";
import { createReconstructionGroup } from "../app/lib/reconstruction/modelScene.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";
import type { ReconstructionPart, ReconstructionModel } from "../app/lib/reconstruction/types.ts";

const box = (x: number, z: number, width: number, depth: number): ReconstructionPart => ({
  id: "shell",
  name: "Объём",
  kind: "box",
  position: { x, y: 2, z },
  rotationDegrees: { x: 0, y: 0, z: 0 },
  size: { x: width, y: 4, z: depth },
  radius: 0,
  height: 0,
  profile: [],
  holes: [],
  vertices: [],
  faces: [],
  color: "#808080",
  confidence: 0.9,
  evidence: [],
});
const area = (part: ReconstructionPart) =>
  polygonArea(part.profile.map((p) => ({ x: p.x, y: p.z }))) -
  part.holes.reduce((sum, ring) => sum + polygonArea(ring.map((p) => ({ x: p.x, y: p.z }))), 0);

test("Г-образное основание не заполняет свободный угол общей прямоугольной плитой", () => {
  const bases = buildFootprintBases([box(0, 0, 10, 4), box(-3, 4, 4, 4)], 0.3, "#777777");
  assert.equal(bases.length, 1);
  assert.equal(area(bases[0]), 56);
  assert.ok(bases[0].profile.length >= 6);
  assert.ok(bases[0].confidence <= 0.65);
});

test("основание сохраняет внутренний двор и не создаётся под поднятым объёмом", () => {
  const raised = box(30, 0, 5, 5);
  raised.position.y = 8;
  const bases = buildFootprintBases(
    [box(0, -4, 10, 2), box(0, 4, 10, 2), box(-4, 0, 2, 6), box(4, 0, 2, 6), raised],
    0.3,
    "#777777",
  );
  assert.equal(bases.length, 1);
  assert.equal(bases[0].holes.length, 1);
  assert.equal(area(bases[0]), 64);
});

test("экструзия в 3D сохраняет знаки X/Z и локальное начало координат профиля", () => {
  const part: ReconstructionPart = {
    ...box(10, 20, 3, 4),
    kind: "extrusion",
    height: 4,
    profile: [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 0, z: 4 },
    ],
  };
  const group = createReconstructionGroup({
    title: "Контроль профиля",
    parts: [part],
  } as ReconstructionModel);
  const mesh = group.children[0] as Mesh;
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox!;
  assert.ok(Math.abs(bounds.min.x) < 1e-6);
  assert.ok(Math.abs(bounds.min.z) < 1e-6);
  assert.ok(Math.abs(bounds.max.z - 4) < 1e-6);
  assert.equal(bounds.min.y, -2);
  mesh.geometry.dispose();
});
