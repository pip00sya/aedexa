import { aiConfig, createStructuredResponse } from "../../lib/ai/featherless";
import { analysisResponse } from "../../lib/ai/analysisResponse";
import { cleanText } from "../../lib/untrusted";
import {
  cadSemanticDictionaryJsonSchema,
  parseCadSemanticDictionary,
  type CadSemanticInventory,
} from "../../lib/cad/semantics";
import { cadKinds, type CadKind, type CadSemanticDictionary } from "../../lib/cad/types";

export const runtime = "edge";

const MAX_BODY_LENGTH = 900_000;
const MAX_TEXTS = 800;
const kinds = new Set<string>(cadKinds);

const instructions = `Ты — инженер-генпланист. Тебе дают список всех текстовых подписей, легенды и примечаний с топосъёмки или генплана (Казахстан, СНГ, русский язык) и то, где каждая подпись стоит: внутри какого контура, на каком слое, рядом ли с образцом легенды.
Задача — объяснить каждое обозначение так, чтобы программа сразу знала, что делать с объектом в 3D-модели: класс объекта, статус (существующий, проектируемый, под снос), этажность, высота, назначение.
Правила:
1. Опирайся только на тексты чертежа и на принятые обозначения топосъёмки и генпланов СНГ (например: «2КЖ» — 2-этажное каменное жилое, «Н» — нежилое, «Д» — деревянное, «сущ.» — существующее, «проект.» — проектируемое, «сн.» или «под снос» — сносимое, «ТИП-1…ТИП-4» — типовые проекты домов, «ПАШНЯ», «САД», «ЛЕС» — угодья).
2. Если этажность или высота не следует ни из подписи, ни из примечаний, оставь 0 — не выдумывай.
3. Подписи-числа, площади, номера участков и домов, отметки, координаты, названия улиц, штампы — kind «ignore».
4. Подпись, стоящая внутри контура здания много раз (например «ТИП-3» ×35), — это тип дома: объясни его и укажи этажность, если она есть в легенде, примечаниях или самой подписи.
5. В notes перечисли общие указания чертежа, которые влияют на модель (этажность всех домов типа, что подлежит сносу, что проектируется), своими словами, но без домыслов.
6. Поле label — подпись ровно так, как она дана в списке. Не добавляй подписи, которых нет в списке.
7. Подписи с контекстом «строка легенды, образец: …» — это условные обозначения: программа применит их ко всему на плане с той же штриховкой (узор + цвет) или линией (цвет + слой). Для них класс особенно важен: заливка «участок общего пользования», площадка, двор — site; граница — boundary; забор, ограждение — fence; труба, лоток, кабель, сеть — utility; арык, канава — ditch; дом — building (с назначением в use); покрытие, дорога, тротуар — road.`;

type RequestBody = { fileName?: unknown; unitLabel?: unknown; texts?: unknown; layers?: unknown };

function sanitizeInventory(body: RequestBody): CadSemanticInventory {
  const texts = (Array.isArray(body.texts) ? body.texts : [])
    .map((raw) => {
      const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const count =
        typeof item.count === "number" && Number.isFinite(item.count)
          ? Math.max(1, Math.round(item.count))
          : 1;
      return {
        text: cleanText(item.text, 600),
        count,
        layers: (Array.isArray(item.layers) ? item.layers : [])
          .map((layer) => cleanText(layer, 80))
          .filter(Boolean)
          .slice(0, 8),
        contexts: (Array.isArray(item.contexts) ? item.contexts : [])
          .map((context) => cleanText(context, 220))
          .filter(Boolean)
          .slice(0, 3),
      };
    })
    .filter((item) => item.text.length >= 2)
    .slice(0, MAX_TEXTS);
  const layers = (Array.isArray(body.layers) ? body.layers : [])
    .map((raw) => {
      const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const kind = cleanText(item.kind, 20);
      return {
        name: cleanText(item.name, 80),
        kind: (kinds.has(kind) ? kind : "unknown") as CadKind,
        count:
          typeof item.count === "number" && Number.isFinite(item.count)
            ? Math.max(0, Math.round(item.count))
            : 0,
      };
    })
    .filter((layer) => layer.name)
    .slice(0, 80);
  return {
    fileName: cleanText(body.fileName, 200) || "drawing.dwg",
    unitLabel: cleanText(body.unitLabel, 20) || "единицы чертежа",
    texts,
    layers,
  };
}

function buildPrompt(inventory: CadSemanticInventory) {
  const textLines = inventory.texts.map((item) => {
    const where = item.contexts.length ? ` — где: ${item.contexts.join("; ")}` : "";
    const layers = item.layers.length ? ` — слои: ${item.layers.join(", ")}` : "";
    return `«${item.text}» ×${item.count}${layers}${where}`;
  });
  const layerLines = inventory.layers.map(
    (layer) => `${layer.name} — ${layer.kind}, ${layer.count} сущностей`,
  );
  return `Файл: ${inventory.fileName}. Единицы чертежа: ${inventory.unitLabel}.

Слои чертежа и их класс по имени:
${layerLines.join("\n") || "нет данных"}

Подписи чертежа (текст, сколько раз встречается, слои, где стоит):
${textLines.join("\n")}

Составь словарь обозначений по заданной JSON-схеме.`;
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_LENGTH) {
    return Response.json(
      { code: "FILE_TOO_LARGE", error: "Слишком много текста для одного запроса." },
      { status: 413 },
    );
  }
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json(
      { code: "INVALID_REQUEST", error: "Не удалось прочитать запрос." },
      { status: 400 },
    );
  }
  const inventory = sanitizeInventory(body);
  if (!inventory.texts.length) {
    return Response.json(
      { code: "NO_TEXTS", error: "В чертеже нет подписей, которые можно прочитать." },
      { status: 400 },
    );
  }
  return analysisResponse(
    request,
    async (report) => {
      const config = aiConfig();
      const batches: CadSemanticDictionary[] = [];
      const context = buildPrompt(inventory);
      for (let offset = 0; offset < inventory.texts.length; offset += 24) {
        const labels = inventory.texts.slice(offset, offset + 24).map((item) => item.text);
        report(
          `Чтение подписей ${offset + 1}–${offset + labels.length} из ${inventory.texts.length}`,
          10 + Math.round((80 * offset) / inventory.texts.length),
        );
        const dictionary = await createStructuredResponse(
          config,
          [],
          `${context}\n\nВ этом запросе заполни entries только для следующих подписей; остальные выше даны как контекст. Не повторяй одинаковые объяснения:\n${JSON.stringify(labels)}`,
          instructions,
          "cadSemanticDictionary",
          cadSemanticDictionaryJsonSchema,
          4_000,
          180_000,
          (value) =>
            parseCadSemanticDictionary(
              value,
              labels,
              inventory.texts.map((item) => item.text),
            ),
        );
        batches.push(dictionary);
      }
      return {
        dictionary: {
          summary: batches
            .map((batch) => batch.summary)
            .filter(Boolean)
            .join(" "),
          entries: batches.flatMap((batch) => batch.entries),
          notes: [...new Set(batches.flatMap((batch) => batch.notes))],
          createdAt: new Date().toISOString(),
          model: config.model,
        },
      };
    },
    "INVALID_DICTIONARY",
    "Словарь обозначений не прошёл проверку",
  );
}
