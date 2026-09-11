"use client";

import { ArrowRight, ArrowUp, Box, FileCheck2, LandPlot, Layers, Map } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import Mark from "../Mark";
import LandingKnot from "./LandingKnot";
import Reveal from "./Reveal";

/** Первая страница */

/** Что делает продукт */
const CHAPTERS = [
  {
    tone: "light" as const,
    step: "01",
    eyebrow: "ЧТЕНИЕ",
    title: "Разбор исходника без ручной разметки",
    text: "DWG и DXF читаются прямо в браузере: слои, границы землепользования, инженерные сети, горизонтали, высотные отметки и единицы измерения. Программа сама определяет вид чертежа и назначение каждого слоя — размечать вручную нечего. Файл остаётся на вашем устройстве.",
    plate: "/arche/sketch/1_3f3943-strokes.png",
    alt: "Разрез и план: то, что читает программа",
    icon: <Layers size={18} />,
  },
  {
    tone: "dark" as const,
    step: "02",
    eyebrow: "ОТСТУПЫ",
    title: "Пятно застройки со ссылкой на пункт норматива",
    text: "Из контура участка вычитаются отступы от границ, охранные зоны инженерных сетей и противопожарные разрывы. Каждое ограничение подписано пунктом СП РК 3.01-101-2013* — видно, откуда взялся каждый метр. Труба поперёк участка делит пятно на части, и у каждой своя площадь.",
    plate: "/arche/sketch/23_db0855-strokes.png",
    alt: "Объём, вычтенный из плоскости листа",
    icon: <LandPlot size={18} />,
  },
  {
    tone: "light" as const,
    step: "03",
    eyebrow: "РЕЛЬЕФ",
    title: "Рельеф собирается из ваших отметок",
    text: "Горизонтали и высотные отметки сходятся в триангуляцию Делоне и обрезаются границей участка. Поверхность строится в пределах съёмки, поэтому уклоны, перепад высот и площади склонов — измерение по вашему чертежу, а не интерполяция.",
    plate: "/arche/sketch/39_e8ee6f-strokes.png",
    alt: "Разрез по склону: отметки задают поверхность",
    icon: <Map size={18} />,
  },
  {
    tone: "dark" as const,
    step: "04",
    eyebrow: "ОБЪЁМ",
    title: "Участок и постройки в объёме",
    text: "Дом, гараж, баня, септик, навес, площадка встают на поверхность и проверяются санитарными разрывами внутри участка. Срез и подсыпка считаются по рельефу — объём земляных работ известен до выезда на площадку.",
    plate: "/arche/sketch/27_dd3705-strokes.png",
    alt: "Объём, собранный из линий",
    icon: <Box size={18} />,
  },
  {
    tone: "light" as const,
    step: "05",
    eyebrow: "ДОКУМЕНТ",
    title: "СПОЗУ, который можно подшить",
    text: "Схема планировочной организации земельного участка выгружается в DXF: штамп, экспликация, условные обозначения и координаты углов. Каждая строка экспликации помнит свой источник — слой исходника или пункт норматива. Открывается в AutoCAD и nanoCAD.",
    plate: "/arche/sketch/Ink-Hatching-Architecture-Sketches-_-Black---Whi-strokes.png",
    alt: "Штриховка тушью: плотность вместо цвета",
    icon: <FileCheck2 size={18} />,
  },
];

/** Кадры рабочей области */
const SHOWCASE = [
  {
    src: "/showcase/site.webp",
    title: "Участок с карты",
    alt: "Контур из 5 точек по спутниковому снимку, соседние здания найдены сами",
  },
  {
    src: "/showcase/topo.webp",
    title: "Рельеф и объекты",
    alt: "DWG-топосъёмка в объёме: поверхность по 2 041 отметке, 82 здания, 617 деревьев",
  },
  {
    src: "/showcase/model.webp",
    title: "Чертёж в объёме",
    alt: "Пешеходный переход, собранный из видов чертежа: 587 деталей, точность помечена",
  },
];

const NUMBERS = [
  { value: "69", label: "чужих чертежей в прогоне", note: "63 разобраны, 6 не читаются" },
  { value: "276", label: "автоматических проверок", note: "на каждый выпуск" },
  { value: "19", label: "правил в реестре норм", note: "каждое со ссылкой" },
  {
    value: "0",
    label: "DWG-файлов уходит на сервер",
    note: "в 2D → 3D модель получает виды листа",
  },
];

/** Иллюстрация листа */
function Plate({ src, alt, tone }: { src: string; alt: string; tone: "light" | "dark" }) {
  return (
    <figure className={`landing-plate ${tone}`}>
      <img src={src} alt={alt} loading="lazy" decoding="async" />
      <figcaption>{alt}</figcaption>
    </figure>
  );
}

/** Кто вошел */
function useAccountName() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { account?: { name: string } | null } | null) => {
        if (alive) setName(payload?.account?.name ?? null);
      })
      .catch(() => {
        // Не ответили
      });
    return () => {
      alive = false;
    };
  }, []);

  return name;
}

/** Выход */
async function signOut() {
  await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "logout" }),
  });
  window.location.reload();
}

export default function Landing() {
  const account = useAccountName();

  return (
    <div className="landing" id="landing-top">
      <header className="landing-top">
        <Link className="landing-brand" href="/">
          <Mark size={30} />
          <strong className="aedexa-mark">AEDEXA</strong>
        </Link>
        {/* Вошедшему предлагать вход незачем */}
        {account ? (
          <nav className="landing-top-actions" aria-label="Учётная запись">
            <span className="landing-user">{account}</span>
            <button className="landing-link" type="button" onClick={signOut}>
              Выйти
            </button>
          </nav>
        ) : (
          <nav className="landing-top-actions" aria-label="Вход">
            <Link className="landing-link" href="/login">
              Войти
            </Link>
            <Link className="landing-pill" href="/register">
              Создать аккаунт
            </Link>
          </nav>
        )}
      </header>

      {/* Первый экран */}
      <section className="landing-hero">
        {/* Имя - по центру, поверх знака */}
        <div className="landing-hero-copy">
          <Reveal delay={120}>
            <h1 className="landing-title aedexa-mark">AEDEXA</h1>
          </Reveal>
        </div>

        <Reveal from="scale" delay={160} className="landing-knot">
          <LandingKnot />
        </Reveal>

        {/* Вход в работу */}
        <Reveal delay={280} className="landing-hero-enter">
          <Link className="landing-link large" href="/app">
            Открыть рабочую область <ArrowRight size={17} />
          </Link>
        </Reveal>
      </section>

      {/* Числа: утверждения, подкрепленные проверками */}
      <section className="landing-numbers">
        {NUMBERS.map((item, index) => (
          <Reveal as="article" key={item.label} delay={index * 90} className="landing-number">
            <strong>{item.value}</strong>
            <span>{item.label}</span>
            <small>{item.note}</small>
          </Reveal>
        ))}
      </section>

      {/* Альбом: листы чередуются тоном и стороной */}
      {CHAPTERS.map((chapter, index) => (
        <section
          key={chapter.step}
          className={`landing-chapter ${chapter.tone}${index % 2 ? " mirrored" : ""}`}
        >
          <Reveal from={index % 2 ? "right" : "left"} className="landing-chapter-copy">
            <p className="landing-eyebrow">
              <span className="landing-step">{chapter.step}</span> {chapter.eyebrow}
            </p>
            <h2>{chapter.title}</h2>
            <p>{chapter.text}</p>
            <span className="landing-chapter-icon">{chapter.icon}</span>
          </Reveal>
          <Reveal
            from={index % 2 ? "left" : "right"}
            delay={140}
            className="landing-chapter-figure"
          >
            <Plate src={chapter.plate} alt={chapter.alt} tone={chapter.tone} />
          </Reveal>
        </section>
      ))}

      {/* В работе: настоящие кадры рабочей области */}
      <section className="landing-showcase">
        <Reveal className="landing-showcase-head">
          <p className="landing-eyebrow">В РАБОТЕ</p>
          <h2>Так выглядит разбор участка</h2>
          <p>
            Кадры сняты с рабочей области на реальных участках — тот же путь пройдёт и ваш файл.
            Каждая линия на них построена расчётом, а не дорисована.
          </p>
        </Reveal>

        <div className="landing-shots">
          {SHOWCASE.map((shot, index) => (
            <Reveal
              as="figure"
              key={shot.src}
              from={index % 2 ? "left" : "right"}
              delay={index * 90}
              className="landing-shot"
            >
              <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
              <figcaption>
                <strong>{shot.title}</strong>
                <span>{shot.alt}</span>
              </figcaption>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Последний разворот */}
      <section className="landing-final">
        <Reveal from="scale">
          <Mark size={64} />
          <h2>Проверьте участок до первого эскиза</h2>
          <p>
            Загрузите свой DWG или откройте готовый участок — расчёт идёт на вашем устройстве и
            занимает секунды. Регистрация для этого не нужна.
          </p>
          <div className="landing-final-actions">
            <Link className="landing-pill large" href="/app">
              Открыть рабочую область <ArrowRight size={17} />
            </Link>
            <Link className="landing-link large" href="/login">
              У меня есть аккаунт
            </Link>
          </div>
          <div className="landing-final-back">
            <a href="#landing-top">
              <ArrowUp size={15} /> Попробуйте прямо сейчас
            </a>
          </div>
        </Reveal>
      </section>

      <footer className="landing-foot">
        <Mark size={22} />
        <span>
          <span className="aedexa-mark">AEDEXA</span> · предпроектная проверка участка
        </span>
        <span className="landing-foot-note">
          Автоматизированный расчёт. Требует проверки аттестованным специалистом.
        </span>
      </footer>
    </div>
  );
}
