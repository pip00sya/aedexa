"use client";

import { useEffect, useRef, useState } from "react";
import type { ArchiveEntry } from "../lib/archive";
import { drawArchivePreview } from "../lib/archivePreview";

/** Картинка результата на карточке архива */
export default function ArchivePreview({ entry }: { entry: ArchiveEntry }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 150;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    setEmpty(!drawArchivePreview(context, entry, width, height));
  }, [entry]);

  return (
    <div className={`archive-card-preview${empty ? " empty" : ""}`}>
      <canvas ref={ref} role="img" aria-label={`${entry.title}: как выглядит результат`} />
      {empty && <span>Предпросмотр недоступен</span>}
    </div>
  );
}
