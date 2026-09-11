import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pluralizeRu } from "../app/lib/pluralizeRu.ts";

const root = new URL("../", import.meta.url);

try {
  process.loadEnvFile(fileURLToPath(new URL(".env", root)));
} catch {
  // Файла нет - значит и ключей нет: обычное состояние чистой копии
}

test("число правил склоняется по-русски", () => {
  const forms = ["пункт", "пункта", "пунктов"];
  assert.equal(pluralizeRu(1, ...forms), "пункт");
  assert.equal(pluralizeRu(2, ...forms), "пункта");
  assert.equal(pluralizeRu(5, ...forms), "пунктов");
  assert.equal(pluralizeRu(11, ...forms), "пунктов");
  assert.equal(pluralizeRu(21, ...forms), "пункт");
});

async function render(path = "/app") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: {
        accept: "text/html",
        host: "localhost",
        "x-forwarded-proto": "http",
      },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

/** Настроена ли языковая модель */
function hasModelKey() {
  return Boolean(process.env.FEATHERLESS_API_KEY);
}

test("главная страница отдаётся собранной на сервере", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>AEDEXA/);
  assert.match(html, /<h1[^>]*>AEDEXA<\/h1>/);
  assert.doesNotMatch(html, /Чертёж становится моделью|Среда ранней стадии|У каждого числа на листе/);
  assert.match(html, /Открыть рабочую область/);
  assert.match(html, /Создать аккаунт/);
  // Витрина не тянет за собой рабочую область: она сама по себе
  assert.doesNotMatch(html, /Загрузите окружение участка/);
});

test("оболочка приложения отдаётся собранной на сервере", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>AEDEXA/);
  assert.match(html, /Нормативная посадка здания/);
  assert.match(html, /Посадка и отступы/);
  assert.match(html, /DWG-топосъёмка/);
  const railItem = /<span>2D → 3D<\/span>/;
  const aiConfigured = hasModelKey();
  if (aiConfigured) assert.match(html, railItem);
  else assert.doesNotMatch(html, railItem);
  assert.match(html, /Все объекты/);
  // Режимы ТЭП и "Сравнение" из продукта удалены
  assert.doesNotMatch(html, />ТЭП<|> Сравнение</);
  assert.match(html, /Загрузите окружение участка/);
  assert.doesNotMatch(html, /AI-студия|>Студия</);
  assert.match(html, /og:title/);
  assert.doesNotMatch(html, /og:image|twitter:image/);
  assert.match(html, /Golos Text/);
  assert.match(html, /JetBrains Mono/);
  assert.match(html, /Jost/);
});

test("в сборку уходят готовые ресурсы, следов заготовки не остаётся", async () => {
  const [page, layout, app, archive, cadProcessing, reconstruction, viewport, css, packageJson] =
    await Promise.all([
      readFile(new URL("../app/app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      Promise.all(
        ["AedexaApp.tsx", "placement/PlacementWorkspace.tsx"].map((path) =>
          readFile(new URL(`../app/components/${path}`, import.meta.url), "utf8"),
        ),
      ).then((parts) => parts.join("\n")),
      readFile(new URL("../app/components/ArchiveWorkspace.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/components/CadProcessingView.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/components/ReconstructionWorkspace.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/components/CadViewport.tsx", import.meta.url), "utf8"),
      // Лист разбит на части; проверяем его целиком, вместе с импортами
      readFile(new URL("../app/globals.css", import.meta.url), "utf8").then(async (manifest) => {
        const parts = [...manifest.matchAll(/@import "\.\/([^"]+)"/g)].map((m) => m[1]);
        const bodies = await Promise.all(
          parts.map((name) => readFile(new URL(`../app/${name}`, import.meta.url), "utf8")),
        );
        return [manifest, ...bodies].join("\n");
      }),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);

  assert.match(page, /AedexaApp/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /нормативная посадка здания/);
  assert.match(app, /ОКРУЖЕНИЕ → УЧАСТОК → ОГРАНИЧЕНИЯ → ПОСАДКА/);
  assert.match(app, /ЧТО БУДЕТ СДЕЛАНО/);
  assert.match(app, /Проверяемая посадка/);
  assert.match(app, /placement-upload-card/);
  assert.doesNotMatch(app, /placement-empty/);
  assert.match(app, /contextObjects/);
  assert.match(app, /Замкнуть контур/);
  assert.match(app, /Нормативная база/);
  assert.match(app, /analyzePlacement/);
  assert.match(app, /CadProcessingView/);
  assert.match(app, /ReconstructionWorkspace/);
  assert.match(app, /archivedPlacement/);
  assert.match(archive, /PlacementWorkspace/);
  assert.match(archive, /CadProcessingView/);
  assert.match(archive, /ReconstructionWorkspace/);
  assert.doesNotMatch(archive, /PlacementArchivePreview|CadViewport|ReconstructionViewport/);
  assert.match(cadProcessing, /archivedEntry/);
  assert.match(reconstruction, /archivedEntry/);
  assert.doesNotMatch(app, /AI-студия|ПОЛНЫЙ ЦИКЛ · 12 ЭТАПОВ|placement-steps/);
  assert.doesNotMatch(
    viewport,
    /terrainMesh\.rotation/,
    "координаты рельефа не разворачиваются в вертикальную плоскость",
  );
  assert.match(viewport, /!isCadFeatureRenderable\(feature\)/);
  assert.match(viewport, /const elevationScale = worldScale/);
  assert.doesNotMatch(viewport, /verticalExaggeration/);
  assert.match(cadProcessing, /useState<"2d" \| "3d">\(\s*\(\) =>\s*archivedEntry/);
  assert.equal(
    cadProcessing.match(/setViewMode\("3d"\)/g)?.length,
    2,
    "годный рельеф открывается в объёме и остаётся отдельным режимом",
  );
  assert.match(viewport, /viewMode === "3d" && terrain\.triangles\.length/);
  assert.match(viewport, /viewMode === "3d" &&\s*isBuildingFootprint\(feature\)/);
  assert.match(viewport, /controls\.mouseButtons\.LEFT = THREE\.MOUSE\.PAN/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /button:focus-visible/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(packageJson, /@huggingface\/transformers/);
  assert.doesNotMatch(app, /imageAi|enrichPlanImageWithAi|AI-сегментация/);
  await assert.rejects(access(new URL("app/_sites-preview", root)));
});
