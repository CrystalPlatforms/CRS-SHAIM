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
    #[error("unknown server kind: {0}")]
    UnknownKind(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Dialect of a model server. Stored as `TEXT` in the schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerKind {
    Ollama,
    OpenAiCompatible,
}

impl ServerKind {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "ollama" => Ok(Self::Ollama),
            "openai_compatible" => Ok(Self::OpenAiCompatible),
            other => Err(StoreError::UnknownKind(other.to_string())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openai_compatible",
        }
    }
}

/// A conversation as surfaced to the UI. `server_id`/`model_id` may be unset,
/// in which case chat falls back to the Settings defaults.
#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub server_id: Option<i64>,
    pub model_id: Option<String>,
    pub mode: String,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub context_len: Option<i64>,
    pub thinking: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A model server configured by the user.
#[derive(Debug, Clone, Serialize)]
pub struct Server {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub api_key: Option<String>,
}

/// One chat message. `images` holds data URLs (`data:image/...;base64,...`),
/// serialized to the JSON column of the same name.
#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub images: Vec<String>,
    pub reaction: Option<String>,
    pub created_at: i64,
}

/// App-level defaults (single row, id = 1).
#[derive(Debug, Clone, Default, Serialize)]
pub struct Settings {
    pub default_server_id: Option<i64>,
    pub default_model_id: Option<String>,
}

/// Column lists shared by RETURNING/SELECT so every read maps in one order.
const CONVERSATION_COLUMNS: &str =
    "id, title, server_id, model_id, mode, system_prompt, temperature, context_len, thinking, created_at, updated_at";
const MESSAGE_COLUMNS: &str =
    "id, conversation_id, role, content, thinking, images, reaction, created_at";

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
                &format!("INSERT INTO conversations (title) VALUES (?1) RETURNING {CONVERSATION_COLUMNS}"),
                [t],
                row_to_conversation,
            ),
            None => self.conn.query_row(
                &format!("INSERT INTO conversations DEFAULT VALUES RETURNING {CONVERSATION_COLUMNS}"),
                [],
                row_to_conversation,
            ),
        }
        .map_err(StoreError::from)
    }

    /// One conversation by id.
    pub fn get_conversation(&self, id: i64) -> Result<Conversation> {
        self.conn
            .query_row(
                &format!("SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?1"),
                [id],
                row_to_conversation,
            )
            .map_err(StoreError::from)
    }

    /// Conversations, most recently active first.
    pub fn list_conversations(&self) -> Result<Vec<Conversation>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations
             ORDER BY updated_at DESC, id DESC"
        ))?;
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

    /// Bumps `updated_at` so the conversation moves to the top of the sidebar
    /// after activity (the schema has no trigger for updates).
    pub fn touch_conversation(&self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE conversations SET updated_at = unixepoch() WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    /// Auto-title: derives a short title from the first user message, applied
    /// only while the title still holds the schema default — so a manual
    /// rename is never overwritten and the title is set exactly once.
    pub fn maybe_autotitle(&self, id: i64, first_user_message: &str) -> Result<bool> {
        let title = autotitle_from(first_user_message);
        let changed = self.conn.execute(
            "UPDATE conversations SET title = ?1 WHERE id = ?2 AND title = 'New conversation'",
            rusqlite::params![title, id],
        )?;
        Ok(changed > 0)
    }

    /// Pins the server/model pair this conversation talks to. `None` values
    /// fall back to the Settings defaults at send time.
    pub fn set_conversation_model(
        &self,
        id: i64,
        server_id: Option<i64>,
        model_id: Option<&str>,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE conversations SET server_id = ?1, model_id = ?2 WHERE id = ?3",
            rusqlite::params![server_id, model_id, id],
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

    // ---- Servers ----------------------------------------------------------

    /// Creates a server. The schema CHECK validates `kind`.
    pub fn create_server(
        &self,
        name: &str,
        kind: &str,
        base_url: &str,
        api_key: Option<&str>,
    ) -> Result<Server> {
        ServerKind::parse(kind)?;
        self.conn
            .query_row(
                "INSERT INTO servers (name, kind, base_url, api_key) VALUES (?1, ?2, ?3, ?4)
                 RETURNING id, name, kind, base_url, api_key",
                rusqlite::params![name, kind, base_url, api_key],
                row_to_server,
            )
            .map_err(StoreError::from)
    }

    pub fn list_servers(&self) -> Result<Vec<Server>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, kind, base_url, api_key FROM servers ORDER BY id",
        )?;
        let rows = stmt.query_map([], row_to_server)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_server(&self, id: i64) -> Result<Server> {
        self.conn
            .query_row(
                "SELECT id, name, kind, base_url, api_key FROM servers WHERE id = ?1",
                [id],
                row_to_server,
            )
            .map_err(StoreError::from)
    }

    /// Rewrites all editable fields. `api_key = None` clears the key.
    pub fn update_server(
        &self,
        id: i64,
        name: &str,
        kind: &str,
        base_url: &str,
        api_key: Option<&str>,
    ) -> Result<()> {
        ServerKind::parse(kind)?;
        let changed = self.conn.execute(
            "UPDATE servers SET name = ?1, kind = ?2, base_url = ?3, api_key = ?4 WHERE id = ?5",
            rusqlite::params![name, kind, base_url, api_key, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Deletes a server. Conversations referencing it keep their messages and
    /// stay openable — the FK is ON DELETE SET NULL, a schema property, so no
    /// call site can forget it.
    pub fn delete_server(&self, id: i64) -> Result<()> {
        let changed = self.conn.execute("DELETE FROM servers WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    // ---- Messages ---------------------------------------------------------

    /// Inserts a message with the full payload used by chat (thinking and
    /// image attachments included).
    pub fn insert_message_full(
        &self,
        conversation_id: i64,
        role: &str,
        content: &str,
        thinking: Option<&str>,
        images: &[String],
    ) -> Result<Message> {
        let images_json = serde_json::to_string(images)
            .map_err(|e| StoreError::Sqlite(rusqlite::Error::ToSqlConversionFailure(e.into())))?;
        self.conn.query_row(
            &format!(
                "INSERT INTO messages (conversation_id, role, content, thinking, images)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 RETURNING {MESSAGE_COLUMNS}"
            ),
            rusqlite::params![conversation_id, role, content, thinking, images_json],
            row_to_message,
        )
        .map_err(StoreError::from)
    }

    /// Inserts a plain message. Kept for simple call sites and tests.
    pub fn insert_message(
        &self,
        conversation_id: i64,
        role: &str,
        content: &str,
    ) -> Result<i64> {
        self.insert_message_full(conversation_id, role, content, None, &[])
            .map(|m| m.id)
    }

    /// Messages of a conversation, oldest first.
    pub fn list_messages(&self, conversation_id: i64) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?1 ORDER BY id"
        ))?;
        let rows = stmt.query_map([conversation_id], row_to_message)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    // ---- Settings ---------------------------------------------------------

    /// App-level defaults. A missing row (never configured) reads as empty.
    pub fn get_settings(&self) -> Result<Settings> {
        self.conn
            .query_row(
                "SELECT default_server_id, default_model_id FROM settings WHERE id = 1",
                [],
                |row| {
                    Ok(Settings {
                        default_server_id: row.get(0)?,
                        default_model_id: row.get(1)?,
                    })
                },
            )
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(Settings::default()),
                other => Err(StoreError::Sqlite(other)),
            })
    }

    /// Sets the default server/model pair (upsert on the single settings row).
    pub fn set_default_model(
        &self,
        server_id: Option<i64>,
        model_id: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (id, default_server_id, default_model_id) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET default_server_id = ?1, default_model_id = ?2",
            rusqlite::params![server_id, model_id],
        )?;
        Ok(())
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
        server_id: row.get(2)?,
        model_id: row.get(3)?,
        mode: row.get(4)?,
        system_prompt: row.get(5)?,
        temperature: row.get(6)?,
        context_len: row.get(7)?,
        thinking: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn row_to_server(row: &rusqlite::Row<'_>) -> rusqlite::Result<Server> {
    Ok(Server {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        base_url: row.get(3)?,
        api_key: row.get(4)?,
    })
}

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let images_json: String = row.get(5)?;
    let images = serde_json::from_str(&images_json).unwrap_or_default();
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        thinking: row.get(4)?,
        images,
        reaction: row.get(6)?,
        created_at: row.get(7)?,
    })
}

/// Derives a conversation title from the first user message: the first
/// non-empty line, truncated to 48 characters on a char boundary.
fn autotitle_from(raw: &str) -> String {
    const MAX: usize = 48;
    let first_line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("New conversation");
    if first_line.chars().count() <= MAX {
        first_line.to_string()
    } else {
        let cut: String = first_line.chars().take(MAX - 1).collect();
        format!("{cut}…")
    }
}
