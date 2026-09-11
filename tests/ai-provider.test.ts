import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  aiConfig,
  AiRequestError,
  createStructuredResponse,
  requestFeatherless,
  type AiConfig,
} from "../app/lib/ai/featherless.ts";

const config: AiConfig = {
  model: "test-model",
  key: "test-primary",
  backupKey: "test-backup",
  baseUrl: "https://provider.example/v1",
};
const success = () =>
  Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] });
const busy = () => Response.json({ error: { message: "Model is busy" } });
const request = (overrides: Partial<AiConfig> = {}) =>
  requestFeatherless(
    { ...config, ...overrides },
    [],
    "Read drawing",
    "Return evidence",
    { type: "object" },
    1000,
    10_000,
  );

function provider(t: TestContext, responses: Array<() => Response>) {
  const headers: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    headers.push(new Headers(init.headers).get("authorization")!);
    bodies.push(JSON.parse(String(init.body)));
    assert.ok(responses.length, "неожиданный повтор запроса");
    return responses.shift()!();
  });
  const delays: number[] = [];
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    delays.push(delay);
    return realTimeout(callback, 0);
  });
  return { headers, bodies, delays };
}

test("Featherless: успешный первый запрос не использует запасной ключ", async (t) => {
  const calls = provider(t, [success]);
  assert.deepEqual(await request(), { ok: true });
  assert.deepEqual(calls.headers, ["Bearer test-primary"]);
  assert.deepEqual(calls.delays, []);
  assert.deepEqual(calls.bodies[0].response_format, { type: "json_object" });
});

test("Featherless: тайм-аут после заголовков остаётся ошибкой доступности, а не словаря", async (t) => {
  provider(t, [
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException("Body timed out", "TimeoutError"));
          },
        }),
      ),
  ]);
  await assert.rejects(
    request(),
    (error: unknown) =>
      error instanceof AiRequestError && error.code === "AI_TIMEOUT" && error.status === 503,
  );
});

test("Featherless: busy с HTTP 200 переключает аккаунт без ожидания", async (t) => {
  const calls = provider(t, [busy, success]);
  assert.deepEqual(await request(), { ok: true });
  assert.deepEqual(calls.headers, ["Bearer test-primary", "Bearer test-backup"]);
  assert.deepEqual(calls.delays, []);
  assert.deepEqual(
    calls.bodies[0],
    calls.bodies[1],
    "при смене аккаунта исходный запрос не меняется",
  );
});

test("Featherless: оба аккаунта заняты — ограниченный повтор с паузой и AI_UNAVAILABLE", async (t) => {
  const calls = provider(
    t,
    Array.from({ length: 5 }, () => busy),
  );
  await assert.rejects(
    request(),
    (error: unknown) =>
      error instanceof AiRequestError && error.code === "AI_UNAVAILABLE" && error.status === 503,
  );
  assert.deepEqual(calls.headers, [
    "Bearer test-primary",
    "Bearer test-backup",
    "Bearer test-primary",
    "Bearer test-backup",
    "Bearer test-primary",
  ]);
  assert.deepEqual(calls.delays, [1500, 3000]);
});

for (const backup of [undefined, "test-primary"]) {
  test(`Featherless: отсутствующий или одинаковый запасной ключ не удваивает попытки (${backup})`, async (t) => {
    const calls = provider(t, [busy, success]);
    await request({ backupKey: backup });
    assert.deepEqual(calls.headers, ["Bearer test-primary", "Bearer test-primary"]);
    assert.deepEqual(calls.delays, [1500]);
  });
}

for (const status of [401, 402, 403, 429]) {
  test(`Featherless: HTTP ${status} не обходит ограничение аккаунта запасным ключом`, async (t) => {
    const calls = provider(t, [
      () => Response.json({ error: { message: "busy: account restricted" } }, { status }),
    ]);
    await assert.rejects(request(), AiRequestError);
    assert.equal(calls.headers.length, 1);
  });
}

test("Featherless: quota с HTTP 200 не повторяется", async (t) => {
  const calls = provider(t, [() => Response.json({ error: { message: "busy: quota exceeded" } })]);
  await assert.rejects(request(), AiRequestError);
  assert.equal(calls.headers.length, 1);
});

test("Featherless: строковая ошибка busy тоже переключает аккаунт", async (t) => {
  const calls = provider(t, [() => Response.json({ error: "Model is busy" }), success]);
  await request();
  assert.equal(calls.headers[1], "Bearer test-backup");
});

test("Featherless: обрезанный ответ повторяется с запасом, затем сохраняется валидация", async (t) => {
  const calls = provider(t, [
    () => Response.json({ choices: [{ finish_reason: "length" }] }),
    busy,
    success,
  ]);
  const result = await createStructuredResponse(
    config,
    [],
    "Read",
    "Evidence",
    "test",
    {},
    1000,
    10_000,
    (value) => {
      assert.deepEqual(value, { ok: true });
      return "validated";
    },
  );
  assert.equal(result, "validated");
  assert.deepEqual(
    calls.bodies.map((body) => body.max_tokens),
    [1000, 1800, 1800],
  );
  assert.deepEqual(calls.headers, [
    "Bearer test-primary",
    "Bearer test-primary",
    "Bearer test-backup",
  ]);
});

test("aiConfig читает запасной ключ из окружения", (t) => {
  const before = { ...process.env };
  t.after(() => {
    process.env = before;
  });
  process.env.FEATHERLESS_API_KEY = " test-primary ";
  process.env.FEATHERLESS_API_KEY_2 = " test-backup ";
  assert.equal(aiConfig().backupKey, "test-backup");
  assert.equal(aiConfig().key, "test-primary");
});
