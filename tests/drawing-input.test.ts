import assert from "node:assert/strict";
import test from "node:test";
import { prepareDrawing } from "../app/lib/reconstruction/prepareDrawing.ts";

test("неподдерживаемый DXF для реконструкции предлагает замену до загрузки браузерного CAD", async () => {
  const file = new File(["0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"], "drawing.dxf");
  await assert.rejects(prepareDrawing(file), /DXF доступен в модуле посадки/);
});

test("пустой вход реконструкции отбивается до разбора", async () => {
  await assert.rejects(prepareDrawing(new File([], "empty.dwg")), /Файл пустой/);
});
