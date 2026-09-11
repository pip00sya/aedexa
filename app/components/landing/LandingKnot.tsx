"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";

/** Знак первой страницы */

const LiveKnot = dynamic(() => import("./PortalTetrahedron"), { ssr: false });

type Knot = "wait" | "record" | "live" | "still";

const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)");

/** Спокойный режим включают и не перезагружая страницу */
function subscribe(update: () => void) {
  const query = calm();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

/** Есть ли на машине 3D */
let spatial: boolean | undefined;
function has3d() {
  if (spatial === undefined) {
    try {
      const probe = document.createElement("canvas");
      spatial = Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
    } catch {
      spatial = false;
    }
  }
  return spatial;
}

function pick(): Knot {
  if (calm().matches) return "still";
  // WebKit узнается по `vendor`
  if (!navigator.vendor.startsWith("Apple")) return "record";
  return has3d() ? "live" : "still";
}

const waiting = (): Knot => "wait";

/** Какую запись брать */
const record = () =>
  window.devicePixelRatio > 1.6 ? "/landing/tetra-2x.webm" : "/landing/tetra.webm";

export default function LandingKnot() {
  const knot = useSyncExternalStore(subscribe, pick, waiting);

  if (knot === "wait") return <div className="landing-knot-placeholder" aria-hidden="true" />;

  if (knot === "live") return <LiveKnot size={650} className="landing-knot-canvas" />;

  if (knot === "still")
    return (
      <img
        className="landing-knot-canvas"
        src="/landing/tetra-still.webp"
        alt=""
        aria-hidden="true"
        decoding="async"
      />
    );

  return (
    <video
      className="landing-knot-canvas"
      src={record()}
      poster="/landing/tetra-still.webp"
      autoPlay
      loop
      muted
      playsInline
      aria-hidden="true"
    />
  );
}
