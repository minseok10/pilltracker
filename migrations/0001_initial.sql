CREATE TABLE IF NOT EXISTS users (
  username_key TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username_key TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (username_key) REFERENCES users(username_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
