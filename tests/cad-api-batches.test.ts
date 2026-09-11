import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { POST as semantics } from "../app/api/cad-semantics/route.ts";
import { POST as groups } from "../app/api/cad-groups/route.ts";

function mockProvider(t: TestContext, answers: unknown[]) {
  const before = { ...process.env };
  t.after(() => {
    process.env = before;
  });
  process.env.FEATHERLESS_API_KEY = "test-only";
  process.env.FEATHERLESS_MODEL = "test-model";
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    assert.ok(answers.length, "лишний запрос к провайдеру");
    return Response.json({
      choices: [{ message: { content: JSON.stringify(answers.shift()) }, finish_reason: "stop" }],
    });
  });
  return requests;
}

test("подписи CAD сохраняют все порции и высоту, найденную в чужой порции", async (t) => {
  const labels = Array.from({ length: 49 }, (_, index) =>
    index === 48 ? "Высота h=6, 2 этажа" : `Тип-${index}`,
  );
  const answers = [labels.slice(0, 24), labels.slice(24, 48), labels.slice(48)].map((batch) => ({
    summary: "Read",
    notes: ["Общее примечание"],
    entries: batch.map((label) => ({
      label,
      kind: "building",
      meaning: "Дом",
      floors: 2,
      heightMeters: 6,
      confidence: 0.8,
      evidence: "Высота указана в примечании",
    })),
  }));
  const requests = mockProvider(t, answers);
  const response = await semantics(
    new Request("http://localhost/api/cad-semantics", {
      method: "POST",
      body: JSON.stringify({ texts: labels.map((text) => ({ text })) }),
    }),
  );
  assert.equal(response.status, 200);
  const { dictionary } = await response.json();
  assert.deepEqual(
    dictionary.entries.map((entry: { label: string }) => entry.label),
    labels,
  );
  assert.equal(dictionary.entries[0].heightMeters, 6);
  assert.equal(dictionary.entries[0].floors, 2);
  assert.deepEqual(dictionary.notes, ["Общее примечание"]);
  assert.deepEqual(
    requests.map((request) => request.max_tokens),
    [4000, 4000, 4000],
  );
});

test("геометрия CAD сохраняет решения по всем порциям", async (t) => {
  const items = Array.from({ length: 41 }, (_, index) => ({
    id: `G${index}`,
    layer: "Здания",
    form: "closed",
  }));
  const answers = [items.slice(0, 20), items.slice(20, 40), items.slice(40)].map((batch) => ({
    summary: "Read",
    decisions: batch.map(({ id }) => ({
      id,
      kind: "building",
      role: "building-outline",
      confidence: 0.8,
    })),
  }));
  const requests = mockProvider(t, answers);
  const response = await groups(
    new Request("http://localhost/api/cad-groups", {
      method: "POST",
      body: JSON.stringify({ groups: items }),
    }),
  );
  assert.equal(response.status, 200);
  const { dictionary } = await response.json();
  assert.deepEqual(
    dictionary.decisions.map((entry: { groupId: string }) => entry.groupId),
    items.map((item) => item.id),
  );
  assert.deepEqual(dictionary.strips, []);
  assert.deepEqual(
    requests.map((request) => request.max_tokens),
    [4000, 4000, 4000],
  );
});
