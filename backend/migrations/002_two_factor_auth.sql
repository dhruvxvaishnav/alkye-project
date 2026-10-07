-- Salted hashes are stored instead of raw OTPs; delivery lookup is memory-only.
CREATE TABLE IF NOT EXISTS login_challenges (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    email TEXT NOT NULL,
    challenge_id TEXT NOT NULL REFERENCES login_challenges(id),
    code_hash TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    delivery_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_assigned_to_idx ON tasks(assigned_to_id);
INSERT OR IGNORE INTO schema_migrations(version,name) VALUES
    (1, 'workspace'), (2, 'two_factor_auth');
