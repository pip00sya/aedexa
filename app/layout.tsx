import type { Metadata } from "next";
import { Golos_Text, JetBrains_Mono, Jost } from "next/font/google";
import "./globals.css";
// Форма и материал ARCHE ложатся поверх раскладки, поэтому импорт идет следом
import "./arche.css";
// Первая страница
import "./landing.css";

// Две рабочие гарнитуры и одна на шесть букв имени
const ui = Golos_Text({
  variable: "--font-aedexa",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

const display = Golos_Text({
  variable: "--font-display",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Имя набирается латиницей
const mark = Jost({
  variable: "--font-mark",
  subsets: ["latin"],
  weight: ["200", "300"],
  display: "swap",
});

export function generateMetadata(): Metadata {
  const title = "AEDEXA — нормативная посадка здания";
  const description =
    "DWG или снимок плана: измеряемая основа, граница участка, окружающие объекты, нормативные отступы и допустимое пятно здания. DWG-топография сохранена отдельным рабочим режимом.";

  return {
    title,
    description,
    icons: { icon: "/icon.svg", shortcut: "/icon.svg" },
    // Карточка для ссылок без картинки
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body
        className={`${ui.variable} ${display.variable} ${mono.variable} ${mark.variable} antialiased`}
      >
        {process.env.NODE_ENV !== "production" && (
          // Правило написано для _document старого роутера
          // eslint-disable-next-line @next/next/no-page-custom-font
          <link
            rel="stylesheet"
            precedence="default"
            href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400..900&family=JetBrains+Mono:wght@400..700&family=Jost:wght@200..300&display=swap"
          />
        )}
        {children}
      </body>
    </html>
  );
}
