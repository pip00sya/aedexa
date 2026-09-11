-- Проекты пользователя.
--
-- Запись хранится одним документом JSON: сервер её не считает и не ищет
-- внутри неё, он только отдаёт её обратно владельцу. Чертёж на сервер не
-- уходит — он остаётся на устройстве.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'review',
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Список проектов одного пользователя отдаётся по свежести.
CREATE INDEX IF NOT EXISTS projects_account ON projects (account_id, updated_at DESC);
