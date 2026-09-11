import { parseDxf } from "./dxf";
import { decodeDxf } from "../cad/dxfEncoding";
import { placementSourceFromDxf } from "./dxfAdapter";
import type { PlacementSource } from "./types";

export const PLACEMENT_DEMOS = [
  {
    id: "ravnina",
    file: "demo/uchastok-1-ravnina.dxf",
    name: "Участок 1",
    note: "равнина, 8 соток",
  },
  { id: "sklon", file: "demo/uchastok-2-sklon.dxf", name: "Участок 2", note: "склон, 12 соток" },
  {
    id: "vodoprovod",
    file: "demo/uchastok-3-vodoprovod.dxf",
    name: "Участок 3",
    note: "с водопроводом, 10 соток",
  },
  {
    id: "otmetki",
    file: "demo/uchastok-4-otmetki.dxf",
    name: "Участок 4",
    note: "рельеф отметками",
  },
] as const;

export type PlacementDemoId = (typeof PLACEMENT_DEMOS)[number]["id"];

export async function loadPlacementDemo(id: PlacementDemoId): Promise<PlacementSource> {
  const demo = PLACEMENT_DEMOS.find((item) => item.id === id);
  if (!demo) throw new Error("Такого готового участка нет.");
  const response = await fetch(`/${demo.file}`);
  if (!response.ok) throw new Error(`Готовый участок не загрузился: ${response.status}`);
  const drawing = parseDxf(
    decodeDxf(await response.arrayBuffer()),
    demo.file.split("/").pop() ?? demo.file,
  );
  return placementSourceFromDxf(drawing, { name: `${demo.name} · ${demo.note}`, source: "demo" });
}
