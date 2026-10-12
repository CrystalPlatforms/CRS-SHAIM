//! Store — sole owner of the Shaim SQLite file.
//!
//! Deep module: the frontend never sees SQL. It talks to a narrow interface
//! (conversations CRUD today; messages, search and forks come later) and this
//! module owns schema creation, migrations and every query.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// A conversation as surfaced to the UI. Per-conversation settings
/// (system prompt, temperature, …) stay in the schema until chat needs them.
#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS servers (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('ollama', 'openai_compatible')),
    base_url  TEXT NOT NULL,
    api_key   TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS conversations (
    id            INTEGER PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT 'New conversation',
    server_id     INTEGER REFERENCES servers(id) ON DELETE SET NULL,
    model_id      TEXT,
    mode          TEXT NOT NULL DEFAULT 'natural' CHECK (mode IN ('natural', 'agent')),
    system_prompt TEXT,
    temperature   REAL,
    context_len   INTEGER,
    thinking      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content         TEXT NOT NULL,
    thinking        TEXT,
    images          TEXT NOT NULL DEFAULT '[]',
    reaction        TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    default_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
    default_model_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

-- Full-text search over message bodies (external-content FTS5, kept in sync
-- by triggers so it can never drift from `messages`).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content = 'messages',
    content_rowid = 'id'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
"#;

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Opens (or creates on first launch) the database at `path`, creating
    /// parent directories as needed.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        // WAL keeps reads cheap while a stream is being written; FKs make
        // message deletion a property of the schema, not of call sites.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::migrate(&conn)?;
        Ok(Self { conn })
    }

    /// Creates the schema if it does not exist yet. Idempotent by design —
    /// every statement uses `IF NOT EXISTS`.
    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(SCHEMA)?;
        Ok(())
    }

    /// Creates a conversation. `None` title falls back to the schema default.
    pub fn create_conversation(&self, title: Option<&str>) -> Result<Conversation> {
        match title {
            Some(t) => self.conn.query_row(
                "INSERT INTO conversations (title) VALUES (?1) RETURNING id, title, mode, created_at, updated_at",
                [t],
                row_to_conversation,
            ),
            None => self.conn.query_row(
                "INSERT INTO conversations DEFAULT VALUES RETURNING id, title, mode, created_at, updated_at",
                [],
                row_to_conversation,
            ),
        }
        .map_err(StoreError::from)
    }

    /// Conversations, most recently active first.
    pub fn list_conversations(&self) -> Result<Vec<Conversation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, mode, created_at, updated_at
             FROM conversations
             ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], row_to_conversation)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// Renames a conversation. The `updated_at` trigger bumps the timestamp,
    /// which also moves it to the top of the sidebar.
    pub fn rename_conversation(&self, id: i64, title: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE conversations SET title = ?1 WHERE id = ?2",
            rusqlite::params![title, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Deletes a conversation; its messages go with it (FK ON DELETE CASCADE)
    /// and the FTS index is cleaned by trigger.
    pub fn delete_conversation(&self, id: i64) -> Result<()> {
        let changed = self
            .conn
            .execute("DELETE FROM conversations WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Inserts a message into a conversation. Minimal surface for now —
    /// thinking/images/reaction arrive with the chat phases.
    pub fn insert_message(
        &self,
        conversation_id: i64,
        role: &str,
        content: &str,
    ) -> Result<i64> {
        self.conn.query_row(
            "INSERT INTO messages (conversation_id, role, content) VALUES (?1, ?2, ?3) RETURNING id",
            rusqlite::params![conversation_id, role, content],
            |row| row.get(0),
        )
        .map_err(StoreError::from)
    }

    /// Message ids belonging to a conversation, oldest first.
    pub fn message_ids(&self, conversation_id: i64) -> Result<Vec<i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map([conversation_id], |row| row.get(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// Introspection: every table in the database, base and virtual alike.
    /// Used by diagnostics and tests to confirm the schema is in place.
    pub fn table_names(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}

fn row_to_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        mode: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}
