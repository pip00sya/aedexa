import type { Metadata } from "next";
import AedexaApp from "../components/AedexaApp";

export const metadata: Metadata = {
  title: "AEDEXA — рабочая область",
  description:
    "Посадка и отступы, DWG-топосъёмка, реконструкция 2D → 3D и архив объектов в одном рабочем месте.",
};

/** Возможности, зависящие от окружения сервера */
function serverFeatures() {
  const ai = Boolean(process.env.FEATHERLESS_API_KEY);
  return { ai };
}

export default function WorkspacePage() {
  return <AedexaApp features={serverFeatures()} />;
}
