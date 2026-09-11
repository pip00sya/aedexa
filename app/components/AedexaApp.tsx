"use client";
import { Box, FolderArchive, LandPlot, LoaderCircle, Map, ShieldCheck } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import Mark from "./Mark";
import PlacementWorkspace from "./placement/PlacementWorkspace";

export type ServerFeatures = { ai: boolean };

type WorkspaceMode = "placement" | "topography" | "reconstruction" | "archive";

const CadProcessingView = dynamic(() => import("./CadProcessingView"), {
  ssr: false,
  loading: () => (
    <div>
      <LoaderCircle className="spin" /> Загружаем DWG-модуль…
    </div>
  ),
});

const ReconstructionWorkspace = dynamic(() => import("./ReconstructionWorkspace"), {
  ssr: false,
  loading: () => <div>Загружаем модуль 2D → 3D…</div>,
});

const ArchiveWorkspace = dynamic(() => import("./ArchiveWorkspace"), {
  ssr: false,
  loading: () => <div>Открываем архив объектов…</div>,
});

/** Подпись под названием */
const MODE_CAPTION: Record<WorkspaceMode, string> = {
  placement: "Нормативная посадка здания",
  topography: "Рельеф и объекты участка",
  reconstruction: "Точная реконструкция объекта",
  archive: "Сохранённые результаты",
};

const MODE_STATUS: Record<WorkspaceMode, string> = {
  placement: "Предпроектная проверка",
  topography: "Чтение DWG на устройстве",
  reconstruction: "Геометрия с контролем точности",
  archive: "Автосохранение включено",
};

/** Разделы, на которые можно дать ссылку */
const MODE_IDS: WorkspaceMode[] = ["placement", "topography", "reconstruction", "archive"];

function modeFromAddress(): WorkspaceMode {
  if (typeof window === "undefined") return "placement";
  const asked = new URLSearchParams(window.location.search).get("mode");
  return MODE_IDS.find((id) => id === asked) ?? "placement";
}

export default function AedexaApp({ features = { ai: false } }: { features?: ServerFeatures }) {
  const [mode, setMode] = useState<WorkspaceMode>("placement");

  // Раздел читается из адреса при открытии, а сам адрес обновляется при переходе
  useEffect(() => {
    const asked = modeFromAddress();
    if (asked !== "placement") queueMicrotask(() => setMode(asked));
  }, []);

  const openMode = (next: WorkspaceMode) => {
    setMode(next);
    if (typeof window === "undefined") return;
    const address = new URL(window.location.href);
    if (next === "placement") address.searchParams.delete("mode");
    else address.searchParams.set("mode", next);
    window.history.replaceState(null, "", address);
  };

  // Режимы живут в неподвижной боковой панели
  const modes: Array<{ id: WorkspaceMode; label: string; icon: React.ReactNode; shown: boolean }> =
    [
      { id: "placement", label: "Посадка и отступы", icon: <LandPlot size={18} />, shown: true },
      { id: "topography", label: "DWG-топосъёмка", icon: <Map size={18} />, shown: true },
      { id: "reconstruction", label: "2D → 3D", icon: <Box size={18} />, shown: features.ai },
      { id: "archive", label: "Все объекты", icon: <FolderArchive size={18} />, shown: true },
    ];

  return (
    <div className="aedexa-shell">
      <a className="skip-link" href="#placement-workspace">
        Перейти к рабочей области
      </a>

      <nav className="aedexa-rail" aria-label="Разделы приложения">
        <Link className="aedexa-rail-brand" href="/" aria-label="AEDEXA — на главную">
          <Mark size={38} />
          <span>
            <strong className="aedexa-mark">AEDEXA</strong>
            <small>{MODE_CAPTION[mode]}</small>
          </span>
        </Link>

        <ul className="aedexa-rail-modes">
          {modes
            .filter((item) => item.shown)
            .map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={mode === item.id ? "active" : ""}
                  aria-current={mode === item.id ? "page" : undefined}
                  onClick={() => openMode(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
        </ul>

        <p className="aedexa-rail-status">
          <ShieldCheck size={15} />
          <span>{MODE_STATUS[mode]}</span>
        </p>
      </nav>

      <main className="placement-app">
        <PlacementWorkspace active={mode === "placement"} />
        {mode !== "placement" && (
          <div className="app-main">
            {mode === "topography" ? (
              <section className="topography-preserved" id="placement-workspace">
                <div className="topography-intro">
                  <div>
                    <p className="placement-eyebrow">РЕЛЬЕФ И ОБЪЕКТЫ УЧАСТКА</p>
                    <h1>DWG → рельеф и объекты топосъёмки</h1>
                    <p>
                      Чтение DWG, рельеф по отметкам, классификация объектов, экспорт DAE. Посадка —
                      в первом режиме.
                    </p>
                  </div>
                </div>
                <CadProcessingView onToast={() => undefined} />
              </section>
            ) : mode === "reconstruction" ? (
              <ReconstructionWorkspace />
            ) : mode === "archive" ? (
              <ArchiveWorkspace />
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
