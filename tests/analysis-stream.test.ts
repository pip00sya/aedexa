import assert from "node:assert/strict";
import test from "node:test";
import { readAnalysisResponse } from "../app/lib/ai/readResponse.ts";
import { analysisResponse } from "../app/lib/ai/analysisResponse.ts";
import { AiRequestError } from "../app/lib/ai/featherless.ts";

test("поток анализа переживает разрезанные UTF-8 символы и последнюю строку без LF", async () => {
  const bytes = new TextEncoder().encode(
    '{"stage":"Проверка","percent":20}\n{"done":true,"value":"Готово"}',
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
  const stages: string[] = [];
  const result = await readAnalysisResponse<{ value: string }>(response, (event) =>
    stages.push(event.stage!),
  );
  assert.equal(result.value, "Готово");
  assert.deepEqual(stages, ["Проверка"]);
});

test("оборванный поток не выдаётся за завершённый анализ", async () => {
  const response = new Response('{"stage":"Чтение"}\n', {
    headers: { "content-type": "application/x-ndjson" },
  });
  await assert.rejects(readAnalysisResponse(response), /до завершения анализа/u);
});

test("долгий CAD-анализ отдаёт этапы до готового результата", async () => {
  const request = new Request("https://example.test/api/cad-groups", {
    headers: { accept: "application/x-ndjson" },
  });
  const response = await analysisResponse(
    request,
    async (report) => {
      report("Проверка кромок", 20);
      return { dictionary: { entries: ["road"] } };
    },
    "INVALID",
    "Ошибка анализа",
  );
  const progress: string[] = [];
  const result = await readAnalysisResponse<{ dictionary: { entries: string[] } }>(
    response,
    (event) => {
      if (event.stage) progress.push(event.stage);
    },
  );
  assert.ok(progress.includes("Проверка кромок"));
  assert.deepEqual(result.dictionary.entries, ["road"]);
});

test("поток сохраняет код отказа провайдера, JSON-клиент сохраняет HTTP-статус", async () => {
  const run = async () => {
    throw new AiRequestError("AI_TIMEOUT", "Время ожидания истекло", 503);
  };
  const streamed = await analysisResponse(
    new Request("https://example.test", { headers: { accept: "application/x-ndjson" } }),
    run,
    "INVALID",
    "Ошибка",
  );
  const result = await readAnalysisResponse<{ code: string }>(streamed);
  assert.equal(result.code, "AI_TIMEOUT");
  const json = await analysisResponse(
    new Request("https://example.test"),
    run,
    "INVALID",
    "Ошибка",
  );
  assert.equal(json.status, 503);
});
