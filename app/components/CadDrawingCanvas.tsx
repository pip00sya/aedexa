"use client";
import { downloadBlob } from "../lib/browser/download";

import { Download, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAD_DRAWING_BACKGROUND,
  cadDrawingToSvg,
  fitCadDrawingView,
  renderCadDrawing,
  type CadDrawingView,
} from "../lib/cad/drawing";
import type { CadDrawing } from "../lib/cad/types";

type CadDrawingCanvasProps = {
  drawing: CadDrawing;
  /** Область, которая показывается при открытии (рабочая область съемки) */
  focus?: { minX: number; minY: number; maxX: number; maxY: number };
  fileName?: string;
};

/** Исходный DWG как есть */
export default function CadDrawingCanvas({ drawing, focus, fileName }: CadDrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CadDrawingView | null>(null);
  const frameRef = useRef<number>(0);
  const dragRef = useRef<{ x: number; y: number; centerX: number; centerY: number } | null>(null);
  const [status, setStatus] = useState("");

  const scheduleRender = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const canvas = canvasRef.current;
      const view = viewRef.current;
      if (!canvas || !view) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const drawn = renderCadDrawing(context, drawing, view, {
        background: CAD_DRAWING_BACKGROUND,
      });
      setStatus(
        `${drawn.toLocaleString("ru-RU")} из ${drawing.primitives.length.toLocaleString("ru-RU")} сущностей в кадре · 1 px = ${(1 / view.scale / drawing.unitsPerMeter).toFixed(3)} м`,
      );
    });
  }, [drawing]);

  const fitToFocus = useCallback(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const width = host.clientWidth || 800;
    const height = host.clientHeight || 520;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    viewRef.current = fitCadDrawingView(focus ?? drawing.bounds, width, height);
    scheduleRender();
  }, [drawing, focus, scheduleRender]);

  // Колесо перехватывается напрямую
  const onWheel = useCallback(
    (event: WheelEvent) => {
      const view = viewRef.current;
      const canvas = canvasRef.current;
      if (!view || !canvas) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const worldX = view.centerX + (px - view.width / 2) / view.scale;
      const worldY = view.centerY - (py - view.height / 2) / view.scale;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const scale = Math.max(1e-6, Math.min(1e6, view.scale * factor));
      viewRef.current = {
        ...view,
        scale,
        centerX: worldX - (px - view.width / 2) / scale,
        centerY: worldY + (py - view.height / 2) / scale,
      };
      scheduleRender();
    },
    [scheduleRender],
  );

  useEffect(() => {
    fitToFocus();
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const observer = new ResizeObserver(() => fitToFocus());
    observer.observe(host);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    };
  }, [fitToFocus, onWheel]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const view = viewRef.current;
    if (!view || event.button !== 0) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      centerX: view.centerX,
      centerY: view.centerY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      const view = viewRef.current;
      if (!drag || !view) return;
      viewRef.current = {
        ...view,
        centerX: drag.centerX - (event.clientX - drag.x) / view.scale,
        centerY: drag.centerY + (event.clientY - drag.y) / view.scale,
      };
      scheduleRender();
    },
    [scheduleRender],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const omittedSummary = drawing.omittedTypes
    ? ` (${Object.entries(drawing.omittedTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([type, count]) => `${type} ${count.toLocaleString("ru-RU")}`)
        .join(", ")})`
    : "";

  const downloadSvg = useCallback(() => {
    const svg = cadDrawingToSvg(drawing);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    downloadBlob(`${(fileName ?? "drawing").replace(/\.dwg$/iu, "")}.svg`, blob);
  }, [drawing, fileName]);

  return (
    <div className="cad-drawing" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="cad-drawing-canvas"
        role="img"
        aria-label="Исходный чертёж DWG"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="cad-drawing-toolbar">
        <button type="button" onClick={fitToFocus} aria-label="Показать рабочую область целиком">
          <Maximize2 size={14} /> Вся площадка
        </button>
        <button type="button" onClick={downloadSvg}>
          <Download size={14} /> Скачать SVG
        </button>
      </div>
      <div className="cad-drawing-status">
        {status}
        {drawing.omitted
          ? ` · не нарисовано ${drawing.omitted.toLocaleString("ru-RU")}${omittedSummary}`
          : ""}
      </div>
    </div>
  );
}
