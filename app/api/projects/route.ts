import {
  readCookie,
  readSession,
  SESSION_COOKIE,
  type Account,
  type Database,
} from "../../lib/auth/accounts";
import { database } from "../../lib/auth/db";

export const runtime = "edge";

/** Больше мегабайта запись быть не должна: чертеж хранится на устройстве */
const MAX_PAYLOAD = 1_000_000;

const NO_DATABASE = {
  code: "NO_DATABASE",
  error:
    "Синхронизация пока не подключена: база данных не создана. Архив работает на вашем устройстве.",
};

async function requireAccount(
  request: Request,
): Promise<{ db: Database; account: Account } | Response> {
  const db = database();
  if (!db) return Response.json(NO_DATABASE, { status: 503 });

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const account = token ? await readSession(db, token) : null;
  if (!account) {
    return Response.json({ code: "NO_SESSION", error: "Нужно войти в аккаунт." }, { status: 401 });
  }
  return { db, account };
}

/** Список записей без содержимого: он нужен, чтобы показать, что есть */
export async function GET(request: Request) {
  const context = await requireAccount(request);
  if (context instanceof Response) return context;

  const { results } = await context.db
    .prepare(
      `SELECT id, kind, title, source_name AS sourceName, summary, status,
              created_at AS createdAt, updated_at AS updatedAt
       FROM projects WHERE account_id = ? ORDER BY updated_at DESC`,
    )
    .bind(context.account.id)
    .all();

  return Response.json({ projects: results });
}

export async function PUT(request: Request) {
  const context = await requireAccount(request);
  if (context instanceof Response) return context;

  let entry: Record<string, unknown>;
  try {
    entry = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { code: "BAD_REQUEST", error: "Не удалось прочитать запись." },
      { status: 400 },
    );
  }

  const id = typeof entry.id === "string" ? entry.id : "";
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  if (!id || !kind) {
    return Response.json(
      { code: "BAD_ENTRY", error: "У записи нет идентификатора или вида." },
      { status: 400 },
    );
  }

  const payload = JSON.stringify(entry.payload ?? null);
  if (payload.length > MAX_PAYLOAD) {
    return Response.json(
      {
        code: "TOO_LARGE",
        error: "Запись больше мегабайта. Сам чертёж хранится на устройстве и на сервер не уходит.",
      },
      { status: 413 },
    );
  }

  const now = new Date().toISOString();
  const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

  await context.db
    .prepare(
      `INSERT INTO projects
         (id, account_id, kind, title, source_name, summary, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         source_name = excluded.source_name,
         summary = excluded.summary,
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at
       WHERE projects.account_id = excluded.account_id`,
    )
    .bind(
      id,
      context.account.id,
      kind,
      text(entry.title, "Без названия"),
      text(entry.sourceName),
      text(entry.summary),
      text(entry.status, "review"),
      payload,
      text(entry.createdAt, now),
      now,
    )
    .run();

  return Response.json({ ok: true, id, updatedAt: now });
}

/** Одна запись целиком: ее открывают, когда пользователь выбрал проект */
export async function POST(request: Request) {
  const context = await requireAccount(request);
  if (context instanceof Response) return context;

  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id)
    return Response.json({ code: "BAD_REQUEST", error: "Не указана запись." }, { status: 400 });

  const row = await context.db
    .prepare(
      `SELECT id, kind, title, source_name AS sourceName, summary, status, payload,
              created_at AS createdAt, updated_at AS updatedAt
       FROM projects WHERE id = ? AND account_id = ?`,
    )
    .bind(id, context.account.id)
    .first<Record<string, unknown>>();

  if (!row)
    return Response.json({ code: "NOT_FOUND", error: "Запись не найдена." }, { status: 404 });

  return Response.json({
    project: { ...row, payload: JSON.parse(String(row.payload ?? "null")) },
  });
}

export async function DELETE(request: Request) {
  const context = await requireAccount(request);
  if (context instanceof Response) return context;

  const id = new URL(request.url).searchParams.get("id");
  if (!id)
    return Response.json({ code: "BAD_REQUEST", error: "Не указана запись." }, { status: 400 });

  await context.db
    .prepare("DELETE FROM projects WHERE id = ? AND account_id = ?")
    .bind(id, context.account.id)
    .run();

  return Response.json({ ok: true });
}
