-- Учётные записи и сессии.
--
-- Пароль лежит хешем PBKDF2 вместе со своими параметрами; идентификатор
-- сессии — тоже хешем, чтобы украденная строка базы не давала вход.
--
-- Применяется командой:
--   npx wrangler d1 migrations apply aedexa --remote

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Выборка сессий одного аккаунта нужна при выходе со всех устройств.
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
-- Чистка просроченных сессий идёт по сроку.
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
