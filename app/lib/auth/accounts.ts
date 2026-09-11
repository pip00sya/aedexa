// Workers не принимает больше 100 000 итераций
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

/** Сколько живет сессия */
const SESSION_DAYS = 30;

export type Account = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
};

/** Что умеет привязка D1 - ровно столько, сколько используется */
export type Database = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
  };
};

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

async function derive(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;

  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromHex(salt) as BufferSource,
      iterations: Number(iterations),
    },
    key,
    HASH_BITS,
  );
  return equal(new Uint8Array(bits), fromHex(hash));
}

/** Идентификатор сессии: 256 случайных бит */
export function createSessionToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** В базе лежит хеш идентификатора: по украденной строке войти нельзя */
export async function hashSessionToken(token: string) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Проверка адреса без попытки угадать все допустимые формы */
export function looksLikeEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Пароль короче десяти знаков.";
  if (password.length > 200) return "Пароль длиннее двухсот знаков.";
  if (/^\d+$/u.test(password)) return "Пароль из одних цифр подбирается за секунды.";
  return null;
}

export async function findAccountByEmail(db: Database, email: string) {
  return db
    .prepare(
      "SELECT id, email, name, password_hash AS passwordHash, created_at AS createdAt FROM accounts WHERE email = ?",
    )
    .bind(normalizeEmail(email))
    .first<Account & { passwordHash: string }>();
}

export async function createAccount(db: Database, email: string, name: string, password: string) {
  const account: Account = {
    id: crypto.randomUUID(),
    email: normalizeEmail(email),
    name: name.trim().slice(0, 120),
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(
      "INSERT INTO accounts (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(account.id, account.email, account.name, await hashPassword(password), account.createdAt)
    .run();
  return account;
}

export async function startSession(db: Database, accountId: string) {
  const token = createSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db
    .prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)")
    .bind(await hashSessionToken(token), accountId, expires.toISOString())
    .run();
  return { token, expires };
}

export async function readSession(db: Database, token: string) {
  const row = await db
    .prepare(
      `SELECT a.id, a.email, a.name, a.created_at AS createdAt, s.expires_at AS expiresAt
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ?`,
    )
    .bind(await hashSessionToken(token))
    .first<Account & { expiresAt: string }>();

  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt,
  } satisfies Account;
}

export async function endSession(db: Database, token: string) {
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await hashSessionToken(token))
    .run();
}

/** Имя cookie сессии */
export const SESSION_COOKIE = "__Host-aedexa-session";

export function sessionCookie(token: string, expires: Date) {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
  ].join("; ");
}

export const clearedSessionCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
