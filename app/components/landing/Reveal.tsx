"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Появление по мере прокрутки */

type RevealProps = {
  children: ReactNode;
  /** Задержка внутри группы, миллисекунды */
  delay?: number;
  /** Откуда приходит блок */
  from?: "up" | "left" | "right" | "scale";
  className?: string;
  as?: "div" | "section" | "li" | "article" | "header" | "footer" | "figure";
};

/** Готовы ли мы прятать */
function canHide() {
  return (
    document.visibilityState === "visible" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Разрешение на скрытие живет на корневом узле и общее для всех блоков */
let watchers = 0;
let listening = false;

function syncStage() {
  document.documentElement.toggleAttribute("data-reveal", canHide());
}

function watchStage() {
  watchers += 1;
  syncStage();
  if (!listening) {
    document.addEventListener("visibilitychange", syncStage);
    listening = true;
  }
  return () => {
    watchers -= 1;
    if (watchers > 0 || !listening) return;
    document.removeEventListener("visibilitychange", syncStage);
    listening = false;
    document.documentElement.removeAttribute("data-reveal");
  };
}

export default function Reveal({
  children,
  delay = 0,
  from = "up",
  className,
  as: Tag = "div",
}: RevealProps) {
  const holder = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const release = watchStage();
    const node = holder.current;
    if (!node || shown) return release;

    // Блок, попавший на первый экран, не ждет наблюдателя
    const box = node.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) {
      queueMicrotask(() => setShown(true));
      return release;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setShown(true);
          observer.disconnect();
        }
      },
      // Порог небольшой
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      release();
    };
  }, [shown]);

  return (
    <Tag
      ref={holder as React.Ref<never>}
      className={`reveal reveal-${from}${shown ? " shown" : ""}${className ? ` ${className}` : ""}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
