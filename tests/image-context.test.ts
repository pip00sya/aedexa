import assert from "node:assert/strict";
import test from "node:test";
import { buildContextObjects } from "../app/lib/placement/imageAnalysis";

test("по снимку обводятся крупные массивы зелени и дорог", () => {
  const width = 100;
  const height = 30;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = x < 40 ? [55, 130, 52] : [150, 150, 150];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }

  const objects = buildContextObjects(pixels, width, height, 10);
  assert.equal(objects.filter((item) => item.kind === "vegetation").length, 1);
  assert.equal(objects.filter((item) => item.kind === "road").length, 1);
});
