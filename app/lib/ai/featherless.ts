export interface AiConfig {
  /** Имя модели - для протоколов и карточек */
  model: string;
  key: string;
  /** Запасной ключ при временно занятой модели; не для обхода квот */
  backupKey?: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = "https://api.featherless.ai/v1";
/** Модель по умолчанию с поддержкой изображений */
const DEFAULT_MODEL = "Qwen/Qwen3-VL-32B-Instruct";

export class AiRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function aiConfig(): AiConfig {
  const key = process.env.FEATHERLESS_API_KEY?.trim();
  if (!key)
    throw new AiRequestError(
      "AI_NOT_CONFIGURED",
      "AI-анализ не настроен: добавьте FEATHERLESS_API_KEY.",
      503,
    );
  return {
    model: (process.env.FEATHERLESS_MODEL || "").trim() || DEFAULT_MODEL,
    key,
    backupKey: process.env.FEATHERLESS_API_KEY_2?.trim() || undefined,
    baseUrl: ((process.env.FEATHERLESS_BASE_URL || "").trim() || DEFAULT_BASE_URL).replace(
      /\/+$/u,
      "",
    ),
  };
}

function parseModelJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new AiRequestError("AI_ERROR", "Модель вернула ответ не в формате JSON.", 422);
  }
}

/** Сколько раз повторить запрос, когда сервис отвечает "модель занята" */
const ATTEMPTS = 5;
const busyDelay = (attempt: number) => Math.min(12_000, 1_500 * 2 ** (attempt - 1));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeSchemaShape(node: unknown, depth = 0): string {
  const schema = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues) return `одно из ${JSON.stringify(enumValues)}`;
  if (schema.type === "array") {
    return depth > 4 ? "[…]" : `[${describeSchemaShape(schema.items, depth + 1)}, …]`;
  }
  if (schema.type === "object") {
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    if (depth > 4) return "{…}";
    const entries = Object.entries(properties).map(([key, value]) => {
      const child = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const hint = typeof child.description === "string" ? ` // ${child.description}` : "";
      return `  "${key}": ${describeSchemaShape(value, depth + 1)}${hint}`;
    });
    return `{\n${entries.join("\n")}\n}`;
  }
  if (schema.type === "number" || schema.type === "integer") return "число";
  if (schema.type === "boolean") return "true или false";
  return "строка";
}

export async function requestFeatherless(
  config: AiConfig,
  dataUrls: string[],
  prompt: string,
  instructions: string,
  schema: unknown,
  maxOutputTokens: number,
  timeoutMs: number,
) {
  const content: Array<Record<string, unknown>> = dataUrls.map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  content.push({ type: "text", text: prompt });
  const system = `${instructions}\n\nВерни ровно один объект JSON такой формы и ничего больше — ни пояснений, ни описания схемы:\n${describeSchemaShape(schema)}`;

  const keys = [
    ...new Set([config.key, config.backupKey].filter((key): key is string => Boolean(key))),
  ];
  const usable = keys.filter((key) => /^[\x21-\x7e]+$/.test(key));
  if (!usable.length) {
    throw new AiRequestError(
      "AI_ERROR",
      keys.length
        ? "Ключ Featherless записан неверно: в нём есть знаки, недопустимые в заголовке запроса. Задайте его заново."
        : "Ключ Featherless не задан.",
      502,
    );
  }
  let lastBusy = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response: Response;
    let raw: string;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${usable[(attempt - 1) % usable.length]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxOutputTokens,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
        }),
        signal,
      });
      // Провайдер может отправить заголовки сразу, а затем зависнуть на теле
      raw = await response.text();
    } catch (error) {
      const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
      throw new AiRequestError(
        timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
        timedOut
          ? `Модель ${config.model} не ответила за отведённое время. Повторите запуск.`
          : "Сервис Featherless недоступен. Проверьте сеть и повторите запуск.",
        503,
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AiRequestError(
        "AI_ERROR",
        `Featherless ответил HTTP ${response.status}, тело не разбирается: ${
          raw.slice(0, 200) || "пусто"
        }`,
        502,
      );
    }

    // Ошибка приходит и с кодом 200 - смотрим тело, а не только статус
    const errorBody =
      payload.error && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : undefined;
    const message =
      typeof errorBody?.message === "string"
        ? errorBody.message
        : typeof payload.error === "string"
          ? payload.error
          : "";
    if (message || !response.ok) {
      // Ограничения аккаунта и закрытая модель не лечатся сменой ключа
      const accountError =
        [401, 402, 403, 429].includes(response.status) ||
        /gated|quota|rate.?limit|unauthori[sz]ed|invalid.?api.?key|billing|credits/iu.test(message);
      if (/busy/iu.test(message) && !accountError) {
        lastBusy = message;
        if (attempt === ATTEMPTS) break;
        if (attempt % keys.length === 0) await sleep(busyDelay(Math.ceil(attempt / keys.length)));
        continue;
      }
      if (/gated/iu.test(message)) {
        throw new AiRequestError(
          "AI_NOT_CONFIGURED",
          `Модель ${config.model} закрыта: выберите другую в FEATHERLESS_MODEL. ${message.slice(0, 200)}`,
          503,
        );
      }
      throw new AiRequestError(
        "AI_ERROR",
        (message || `Featherless ответил ${response.status}.`).slice(0, 500),
        response.status >= 500 ? 503 : 422,
      );
    }

    const choice = Array.isArray(payload.choices)
      ? (payload.choices[0] as Record<string, unknown>)
      : undefined;
    if (choice?.finish_reason === "length") {
      throw new AiRequestError(
        "AI_OUTPUT_LIMIT",
        `Модель ${config.model} не уложилась в лимит ответа даже с увеличенным запасом. Чертёж слишком подробный для этой модели: возьмите лист с одним объектом или укажите модель побольше в FEATHERLESS_MODEL.`,
        422,
      );
    }
    const answer =
      choice?.message && typeof choice.message === "object"
        ? (choice.message as Record<string, unknown>).content
        : undefined;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("MODEL_EMPTY_RESPONSE");
    return parseModelJson(answer);
  }
  throw new AiRequestError(
    "AI_UNAVAILABLE",
    `Модель ${config.model} занята: ${lastBusy.slice(0, 200)} Повторите запуск или выберите другую модель.`,
    503,
  );
}

/** Потолок запаса на повтор: выше модель все равно не отвечает */
const MAX_OUTPUT_BUDGET = 12_000;

export async function createStructuredResponse<T = unknown>(
  config: AiConfig,
  dataUrls: string[],
  prompt: string,
  instructions: string,
  schemaName: string,
  schema: unknown,
  maxOutputTokens: number,
  timeoutMs = 360_000,
  validate?: (value: unknown) => T,
): Promise<T> {
  const ask = (requestPrompt: string, budget: number) =>
    requestFeatherless(config, dataUrls, requestPrompt, instructions, schema, budget, timeoutMs);

  const request = async (requestPrompt: string) => {
    try {
      return await ask(requestPrompt, maxOutputTokens);
    } catch (error) {
      if (!(error instanceof AiRequestError) || error.code !== "AI_OUTPUT_LIMIT") throw error;
      const wider = Math.min(Math.round(maxOutputTokens * 1.8), MAX_OUTPUT_BUDGET);
      if (wider <= maxOutputTokens) throw error;
      console.warn(
        `${config.model}: ответ ${schemaName} не поместился в ${maxOutputTokens} токенов; повтор с ${wider}.`,
      );
      return ask(requestPrompt, wider);
    }
  };

  let current = await request(prompt);
  if (!validate) return current as T;
  for (let repairAttempt = 0; repairAttempt < 3; repairAttempt += 1) {
    try {
      return validate(current);
    } catch (validationError) {
      if (repairAttempt === 2) throw validationError;
      const reason =
        validationError instanceof Error ? validationError.message : String(validationError);
      console.warn(
        `${config.model}: ответ ${schemaName} не прошёл проверку, прошу исправить (${repairAttempt + 1}/2).`,
        reason,
      );
      const rejected = JSON.stringify(current).slice(0, 18_000);
      current = await request(
        `${prompt}\n\nСтрогая проверка сервера отклонила твой предыдущий структурированный ответ: ${reason.slice(0, 600)}.\n\nТвой отклонённый ответ:\n${rejected}\n\nСамостоятельно найди указанное поле в своём ответе, исправь причину ошибки и заново верни полный объект по заданной JSON-схеме. Все обязательные геометрические ширины, глубины и высоты должны быть конечными числами больше нуля; если масса не имеет доказуемого ненулевого размера, не создавай её.`,
      );
    }
  }
  throw new Error(`${schemaName}: исправления исчерпаны`);
}

/** Единый HTTP-ответ об ошибке ИИ для серверных маршрутов */
export function aiErrorResponse(error: unknown, fallbackCode: string, fallbackPrefix: string) {
  if (error instanceof AiRequestError)
    return Response.json({ code: error.code, error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  return Response.json(
    { code: fallbackCode, error: `${fallbackPrefix}: ${message}` },
    { status: 422 },
  );
}
