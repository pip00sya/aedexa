import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AiRequestError, type AiConfig } from "../app/lib/ai/featherless.ts";
import { parseRecipePlan, requestBuildingRecipe } from "../app/lib/reconstruction/recipeRequest.ts";

const config: AiConfig = {
  model: "test",
  key: "test-primary",
  baseUrl: "https://provider.example/v1",
};
const mass = (id: string, centerX: number) => ({
  id,
  name: id,
  shape: "box",
  centerX,
  centerZ: 0,
  width: 10,
  depth: 8,
  startLevel: 0,
  levels: 2,
  rotationDegrees: 0,
  arcSweepDegrees: 0,
  roof: "flat",
  roofHeight: 0,
  windowColumnsFront: 3,
  windowColumnsSide: 2,
  windowWidth: 1,
  windowHeight: 1.5,
  entrance: true,
  porchSteps: 0,
  balconyLevels: [],
  cores: 1,
  footprintHandle: "",
});
const common = {
  applicable: true,
  reason: "Two wings on plan",
  unit: "m",
  overallWidth: 20,
  overallDepth: 8,
  floorHeight: 3,
  confidence: 0.8,
  assumptions: ["Window depth not dimensioned"],
};
const plan = {
  ...common,
  masses: [
    { id: "west", name: "West wing", evidence: "Left of common origin on floor plan" },
    { id: "east", name: "East wing", evidence: "Right of common origin on floor plan" },
  ],
};
const full = { ...common, masses: [mass("west", -5), mass("east", 5)] };
const detail = (id: string, x: number) => ({ ...mass(id, x), confidence: 0.8, assumptions: [] });
const answer = (value: unknown) => () =>
  Response.json({
    choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
  });
const truncated = () => Response.json({ choices: [{ finish_reason: "length" }] });

function provider(t: TestContext, replies: Array<() => Response>) {
  const requests: { messages: { content: unknown }[]; max_tokens: number }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    assert.ok(replies.length, "неожиданный запрос после завершения сценария");
    return replies.shift()!();
  });
  return requests;
}
const request = (progress: (stage: string, percent: number) => void = () => undefined) =>
  requestBuildingRecipe(
    config,
    ["data:image/png;base64,AA=="],
    "Original drawing evidence",
    "Only measured evidence",
    progress,
  );

test("Простой рецепт остаётся одним запросом", async (t) => {
  const calls = provider(t, [answer(full)]);
  assert.deepEqual(await request(), full);
  assert.equal(calls.length, 1);
});

test("После двух обрывов рецепт разбирается полностью по объёмам в общей системе", async (t) => {
  const calls = provider(t, [
    truncated,
    truncated,
    answer(plan),
    answer(detail("west", -5)),
    answer(detail("east", 5)),
  ]);
  const stages: string[] = [];
  assert.deepEqual(await request((stage) => stages.push(stage)), full);
  assert.deepEqual(
    calls.map((call) => call.max_tokens),
    [2200, 3960, 2200, 1400, 1400],
  );
  const finalPrompt = JSON.stringify(calls[4].messages);
  assert.match(finalPrompt, /Original drawing evidence/);
  assert.ok(finalPrompt.includes("overallWidth"));
  assert.ok(finalPrompt.includes("centerX"));
  assert.match(finalPrompt, /west/);
  assert.match(finalPrompt, /east/);
  assert.equal(stages.length, 3);
});

test("Ошибка авторизации не запускает разбор по частям", async (t) => {
  const calls = provider(t, [
    () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
  ]);
  await assert.rejects(request(), AiRequestError);
  assert.equal(calls.length, 1);
});

test("Неверный id отдельного объёма не принимается и не превращается в частичный результат", async (t) => {
  const calls = provider(t, [
    truncated,
    truncated,
    answer(plan),
    ...Array.from({ length: 3 }, () => answer(detail("other", 0))),
  ]);
  await assert.rejects(request(), /Ожидался объём west/);
  assert.equal(calls.length, 6);
});

test("Неудача второго объёма не возвращает только первый", async (t) => {
  provider(t, [
    truncated,
    truncated,
    answer(plan),
    answer(detail("west", -5)),
    truncated,
    truncated,
  ]);
  await assert.rejects(
    request(),
    (error: unknown) => error instanceof AiRequestError && error.code === "AI_OUTPUT_LIMIT",
  );
});

test("План требует уникальные объёмы, основания и конечные положительные габариты", () => {
  assert.equal(parseRecipePlan(plan).masses.length, 2);
  for (const invalid of [
    { ...plan, masses: [plan.masses[0], plan.masses[0]] },
    { ...plan, masses: [] },
    { ...plan, masses: [{ ...plan.masses[0], evidence: "" }] },
    { ...plan, overallWidth: 0 },
    { ...plan, floorHeight: Infinity },
    { ...plan, confidence: NaN },
    { ...plan, unit: "unknown" },
    { ...plan, applicable: false },
  ])
    assert.throws(() => parseRecipePlan(invalid));
});

test("Поэтапный рецепт сохраняет допущения всех объёмов и снижает общую уверенность", async (t) => {
  const west = Array.from({ length: 12 }, (_, i) => `West assumption ${i}`);
  const east = Array.from({ length: 12 }, (_, i) => `East assumption ${i}`);
  provider(t, [
    truncated,
    truncated,
    answer(plan),
    answer({ ...detail("west", -5), confidence: 0.7, assumptions: west }),
    answer({ ...detail("east", 5), confidence: 0.5, assumptions: east }),
  ]);
  const result = await request();
  assert.equal(result.confidence, 0.5);
  assert.deepEqual(result.assumptions, [...common.assumptions, ...west, ...east]);
});
