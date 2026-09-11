import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clearedSessionCookie,
  createAccount,
  createSessionToken,
  endSession,
  findAccountByEmail,
  hashPassword,
  hashSessionToken,
  looksLikeEmail,
  normalizeEmail,
  passwordProblem,
  readCookie,
  readSession,
  sessionCookie,
  startSession,
  verifyPassword,
  SESSION_COOKIE,
  type Database,
} from "../app/lib/auth/accounts.ts";

function memoryDatabase(): Database & { accounts: Map<string, Record<string, string>> } {
  const accounts = new Map<string, Record<string, string>>();
  const sessions = new Map<string, { accountId: string; expiresAt: string }>();

  return {
    accounts,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM accounts WHERE email")) {
                const row = accounts.get(String(values[0]));
                return (row as T) ?? null;
              }
              if (query.includes("FROM sessions s JOIN accounts")) {
                const session = sessions.get(String(values[0]));
                if (!session) return null;
                const account = [...accounts.values()].find(
                  (item) => item.id === session.accountId,
                );
                if (!account) return null;
                return { ...account, expiresAt: session.expiresAt } as T;
              }
              return null;
            },
            async run() {
              if (query.startsWith("INSERT INTO accounts")) {
                const [id, email, name, passwordHash, createdAt] = values.map(String);
                accounts.set(email, { id, email, name, passwordHash, createdAt });
              }
              if (query.startsWith("INSERT INTO sessions")) {
                const [tokenHash, accountId, expiresAt] = values.map(String);
                sessions.set(tokenHash, { accountId, expiresAt });
              }
              if (query.startsWith("DELETE FROM sessions")) sessions.delete(String(values[0]));
              return undefined;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

test("пароль не хранится открытым, а проверка отличает верный от неверного", async () => {
  const stored = await hashPassword("правильная-лошадь-батарейка");

  assert.equal(stored.includes("правильная"), false, "пароль попал в хранимую строку");
  assert.match(
    stored,
    /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/u,
    "формат хеша с параметрами",
  );
  assert.equal(await verifyPassword("правильная-лошадь-батарейка", stored), true);
  assert.equal(await verifyPassword("правильная-лошадь-батарейкА", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("одинаковые пароли дают разные хеши: соль случайна", async () => {
  const first = await hashPassword("одна-и-та-же-строка");
  const second = await hashPassword("одна-и-та-же-строка");
  assert.notEqual(first, second, "без соли одинаковые пароли выдают друг друга");
  assert.equal(await verifyPassword("одна-и-та-же-строка", first), true);
  assert.equal(await verifyPassword("одна-и-та-же-строка", second), true);
});

test("испорченная строка хеша не пропускает никого", async () => {
  for (const broken of ["", "не-хеш", "pbkdf2$", "sha1$1$aa$bb", "pbkdf2$100000$aa"]) {
    assert.equal(await verifyPassword("любой", broken), false, `пропустила строка «${broken}»`);
  }
});

test("в базе лежит хеш сессии, а не сам ключ", async () => {
  const token = createSessionToken();
  assert.match(token, /^[0-9a-f]{64}$/u, "256 бит случайности");

  const hash = await hashSessionToken(token);
  assert.notEqual(hash, token, "по строке из базы войти нельзя");
  assert.equal(await hashSessionToken(token), hash, "хеш устойчив");
  assert.notEqual(await hashSessionToken(createSessionToken()), hash);
});

test("требования к паролю говорят о длине, а не о наборе символов", () => {
  assert.match(passwordProblem("короткий") ?? "", /короче десяти/u);
  assert.match(passwordProblem("1234567890123") ?? "", /из одних цифр/u);
  assert.equal(passwordProblem("длинный пароль из слов"), null);
  assert.match(passwordProblem("x".repeat(201)) ?? "", /длиннее двухсот/u);
});

test("адрес приводится к нижнему регистру и проверяется по форме", () => {
  assert.equal(normalizeEmail("  Иван@Пример.KZ "), "иван@пример.kz");
  assert.equal(looksLikeEmail("a@b.kz"), true);
  assert.equal(looksLikeEmail("без-собаки.kz"), false);
  assert.equal(looksLikeEmail("два@@собаки.kz"), false);
  assert.equal(looksLikeEmail("нет@домена"), false);
});

test("cookie сессии закрыт от скриптов и от чужого поддомена", () => {
  const cookie = sessionCookie("токен", new Date("2026-10-09T00:00:00Z"));
  assert.ok(cookie.startsWith("__Host-aedexa-session=токен"), "префикс __Host- обязателен");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
    assert.ok(cookie.includes(flag), `нет флага ${flag}`);
  }
  assert.ok(clearedSessionCookie().includes("Max-Age=0"), "выход сбрасывает cookie");
});

test("cookie читается из заголовка, включая соседние", () => {
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=xyz; b=2`, SESSION_COOKIE), "xyz");
  assert.equal(readCookie("a=1; b=2", SESSION_COOKIE), null);
  assert.equal(readCookie(null, SESSION_COOKIE), null);
});

test("полный путь: регистрация, вход по сессии, выход", async () => {
  const db = memoryDatabase();
  const account = await createAccount(
    db,
    "  Проектировщик@Бюро.KZ ",
    "  Асель  ",
    "длинный пароль из слов",
  );

  assert.equal(account.email, "проектировщик@бюро.kz", "адрес нормализован");
  assert.equal(account.name, "Асель", "имя обрезано по краям");

  const stored = await findAccountByEmail(db, "ПРОЕКТИРОВЩИК@бюро.kz");
  assert.ok(stored, "аккаунт находится независимо от регистра");
  assert.equal(await verifyPassword("длинный пароль из слов", stored.passwordHash), true);

  const session = await startSession(db, account.id);
  const restored = await readSession(db, session.token);
  assert.equal(restored?.email, "проектировщик@бюро.kz", "сессия возвращает своего владельца");
  assert.equal(await readSession(db, createSessionToken()), null, "чужой ключ не пускает");

  await endSession(db, session.token);
  assert.equal(await readSession(db, session.token), null, "после выхода сессия мертва");
});

test("просроченная сессия не пускает", async () => {
  const db = memoryDatabase();
  const account = await createAccount(db, "a@b.kz", "Имя", "длинный пароль из слов");
  const session = await startSession(db, account.id);

  // Подменяем срок на прошедший: чистка идет отдельно, но пускать нельзя
  const hash = await hashSessionToken(session.token);
  await db
    .prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)")
    .bind(hash, account.id, new Date(Date.now() - 1000).toISOString())
    .run();

  assert.equal(await readSession(db, session.token), null);
});

test("маршруты берут базу из общего модуля привязки", async () => {
  for (const route of ["auth", "projects"]) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.ok(!source.includes("process.env"), `${route}: привязка читается не из process.env`);
    assert.ok(source.includes('from "../../lib/auth/db"'), `${route}: база берётся общим модулем`);
  }
});
