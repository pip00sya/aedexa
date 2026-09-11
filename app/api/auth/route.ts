import {
  clearedSessionCookie,
  createAccount,
  endSession,
  findAccountByEmail,
  looksLikeEmail,
  normalizeEmail,
  passwordProblem,
  readCookie,
  readSession,
  sessionCookie,
  startSession,
  verifyPassword,
  SESSION_COOKIE,
} from "../../lib/auth/accounts";
import { database } from "../../lib/auth/db";

export const runtime = "edge";

const NO_DATABASE = {
  code: "NO_DATABASE",
  error:
    "Учётные записи пока не подключены: база данных не создана. Расчёт и архив работают без аккаунта — они целиком на вашем устройстве.",
};

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(payload, { status, headers });

type Payload = { action?: unknown; email?: unknown; name?: unknown; password?: unknown };

export async function POST(request: Request) {
  const db = database();
  if (!db) return json(NO_DATABASE, 503);

  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return json({ code: "BAD_REQUEST", error: "Не удалось прочитать запрос." }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "logout") {
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (token) await endSession(db, token);
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!looksLikeEmail(email)) {
    return json({ code: "BAD_EMAIL", error: "Адрес почты выглядит неправильно." }, 400);
  }

  if (action === "register") {
    const problem = passwordProblem(password);
    if (problem) return json({ code: "WEAK_PASSWORD", error: problem }, 400);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2) {
      return json({ code: "BAD_NAME", error: "Укажите имя: по нему подписываются листы." }, 400);
    }

    if (await findAccountByEmail(db, email)) {
      return json({ code: "EMAIL_TAKEN", error: "Аккаунт с такой почтой уже есть." }, 409);
    }

    const account = await createAccount(db, email, name, password);
    const session = await startSession(db, account.id);
    return json({ account }, 201, { "set-cookie": sessionCookie(session.token, session.expires) });
  }

  if (action === "login") {
    const found = await findAccountByEmail(db, email);
    const stored =
      found?.passwordHash ??
      "pbkdf2$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";
    const matches = await verifyPassword(password, stored);

    if (!found || !matches) {
      return json({ code: "BAD_CREDENTIALS", error: "Почта или пароль не подходят." }, 401);
    }

    const session = await startSession(db, found.id);
    const account = {
      id: found.id,
      email: found.email,
      name: found.name,
      createdAt: found.createdAt,
    };
    return json({ account }, 200, { "set-cookie": sessionCookie(session.token, session.expires) });
  }

  return json({ code: "UNKNOWN_ACTION", error: "Неизвестное действие." }, 400);
}

export async function GET(request: Request) {
  const db = database();
  if (!db) return json({ ...NO_DATABASE, account: null }, 200);

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return json({ account: null });

  const account = await readSession(db, token);
  return json({ account });
}
