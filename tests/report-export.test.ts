import assert from "node:assert/strict";
import test from "node:test";
import { buildDxfText, encodeCp1251 } from "../app/lib/cad/exportDxf.ts";
import { buildXlsx } from "../app/lib/report/xlsx.ts";

function latin1(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

test("запись xlsx даёт корректную книгу в ZIP без сжатия", () => {
  const bytes = buildXlsx([
    {
      name: "ТЭП",
      columnWidths: [30, 12],
      rows: [
        [
          { value: "Показатель", bold: true },
          { value: "Значение", bold: true },
        ],
        ["Площадь застройки", 148.25],
        ["Этажность", 2],
      ],
    },
    { name: "Экспликация", rows: [["Комната", 20.4]] },
  ]);
  const text = latin1(bytes);
  assert.equal(text.slice(0, 4), "PK");
  assert.ok(text.includes("[Content_Types].xml"));
  assert.ok(text.includes("xl/workbook.xml"));
  assert.ok(text.includes("xl/worksheets/sheet1.xml"));
  assert.ok(text.includes("xl/worksheets/sheet2.xml"));
  assert.ok(text.includes("inlineStr"));
  assert.ok(text.includes("<v>148.25</v>"));
  const endOfCentralDirectory = text.lastIndexOf("PK");
  assert.ok(endOfCentralDirectory > 0);
  const entryCount = bytes[endOfCentralDirectory + 10] | (bytes[endOfCentralDirectory + 11] << 8);
  assert.equal(entryCount, 7);
  assert.throws(() => buildXlsx([]));
});

test("запись dxf даёт разделы R12 и кириллицу в CP1251", () => {
  const textDxf = buildDxfText(
    [{ name: "Картограмма", colorIndex: 3 }],
    [
      { type: "line", layer: "Картограмма", start: { x: 0, y: 0 }, end: { x: 10, y: 5 } },
      {
        type: "polyline",
        layer: "Картограмма",
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
        ],
        closed: true,
      },
      { type: "circle", layer: "0", center: { x: 1, y: 1 }, radius: 0.5 },
      { type: "text", layer: "0", position: { x: 2, y: 2 }, height: 2.5, value: "Отметка 653,50" },
    ],
  );
  assert.ok(textDxf.includes("AC1009"));
  assert.ok(textDxf.includes("ANSI_1251"));
  assert.ok(textDxf.includes("ENTITIES"));
  assert.ok(textDxf.includes("SEQEND"));
  assert.ok(textDxf.includes("Отметка 653,50"));
  assert.ok(textDxf.trimEnd().endsWith("EOF"));

  const bytes = encodeCp1251("Ж ё №");
  assert.equal(bytes[0], 0xc6);
  assert.equal(bytes[2], 0xb8);
  assert.equal(bytes[4], 0xb9);
});
