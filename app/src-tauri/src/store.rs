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

/// Which headless coding agent an Agent conversation runs. The enum is
/// designed to grow (Brainstorm/Unrestricted modes come post-Alpha); stored
/// as `TEXT` on the conversation, next to its project folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
}

impl AgentKind {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "claude_code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            other => Err(StoreError::UnknownKind(other.to_string())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }

    /// Every agent offered in the UI, in display order.
    pub const ALL: [AgentKind; 2] = [AgentKind::ClaudeCode, AgentKind::Codex];
}

/// A conversation as surfaced to the UI. `server_id`/`model_id` may be unset,
/// in which case chat falls back to the Settings defaults. Agent conversations
/// carry `agent_kind` + `project_path` instead of a model pin.
#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub server_id: Option<i64>,
    pub model_id: Option<String>,
    pub mode: String,
    pub agent_kind: Option<String>,
    pub project_path: Option<String>,
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

/// Storage shape of an imported skill: `.skill` packages are unzipped
/// folders, markdown skills are single files. Shaim never executes skill
/// scripts — it stores the files and this metadata row.
#[derive(Debug, Clone, Serialize)]
pub struct Skill {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub kind: String,
    pub enabled: bool,
    pub path: String,
    pub size_bytes: i64,
    pub created_at: i64,
}

/// Kind of an imported skill. Stored as `TEXT` in the schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillKind {
    Package,
    Markdown,
}

impl SkillKind {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "package" => Ok(Self::Package),
            "markdown" => Ok(Self::Markdown),
            other => Err(StoreError::UnknownKind(other.to_string())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Package => "package",
            Self::Markdown => "markdown",
        }
    }
}

/// One chat message. `images` holds data URLs (`data:image/...;base64,...`),
/// serialized to the JSON column of the same name. `skill_name` records the
/// skill invoked with `/` on a user message — display metadata only (the
/// instructions themselves never enter the stored text).
#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub images: Vec<String>,
    pub reaction: Option<String>,
    pub skill_name: Option<String>,
    pub created_at: i64,
}

/// App-level defaults (single row, id = 1).
#[derive(Debug, Clone, Default, Serialize)]
pub struct Settings {
    pub default_server_id: Option<i64>,
    pub default_model_id: Option<String>,
    pub default_system_prompt: Option<String>,
}

/// One full-text search hit: the message plus the context the UI needs to
/// jump into its conversation.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub message_id: i64,
    pub conversation_id: i64,
    pub conversation_title: String,
    pub role: String,
    pub snippet: String,
    pub created_at: i64,
}

/// Column lists shared by RETURNING/SELECT so every read maps in one order.
const CONVERSATION_COLUMNS: &str =
    "id, title, server_id, model_id, mode, agent_kind, project_path, system_prompt, temperature, context_len, thinking, created_at, updated_at";
const MESSAGE_COLUMNS: &str =
    "id, conversation_id, role, content, thinking, images, reaction, skill_name, created_at";
const SKILL_COLUMNS: &str =
    "id, name, description, kind, enabled, path, size_bytes, created_at";

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
    agent_kind    TEXT CHECK (agent_kind IN ('claude_code', 'codex')),
    project_path  TEXT,
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
    skill_name      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    default_server_id     INTEGER REFERENCES servers(id) ON DELETE SET NULL,
    default_model_id      TEXT,
    default_system_prompt TEXT
);

CREATE TABLE IF NOT EXISTS skills (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL CHECK (kind IN ('package', 'markdown')),
    enabled     INTEGER NOT NULL DEFAULT 0,
    path        TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
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
    /// every statement uses `IF NOT EXISTS`, and column additions are
    /// guarded by a `pragma_table_info` check so older database files
    /// migrate in place on reopen.
    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(SCHEMA)?;
        // Column additions are guarded by pragma checks so older database
        // files migrate in place on reopen.
        let conversation_columns: Vec<String> = {
            let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('conversations')")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        if !conversation_columns.iter().any(|name| name == "agent_kind") {
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN agent_kind TEXT
                 CHECK (agent_kind IN ('claude_code', 'codex'))",
                [],
            )?;
        }
        if !conversation_columns.iter().any(|name| name == "project_path") {
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN project_path TEXT",
                [],
            )?;
        }
        let has_system_prompt: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('settings')
             WHERE name = 'default_system_prompt'",
            [],
            |row| row.get(0),
        )?;
        if has_system_prompt == 0 {
            conn.execute(
                "ALTER TABLE settings ADD COLUMN default_system_prompt TEXT",
                [],
            )?;
        }
        let message_columns: Vec<String> = {
            let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('messages')")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        if !message_columns.iter().any(|name| name == "skill_name") {
            conn.execute("ALTER TABLE messages ADD COLUMN skill_name TEXT", [])?;
        }
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

    /// Switches the conversation between `natural` (chat) and `agent` (a
    /// headless coding agent). Unknown modes are rejected before SQL.
    pub fn set_conversation_mode(&self, id: i64, mode: &str) -> Result<()> {
        if mode != "natural" && mode != "agent" {
            return Err(StoreError::UnknownKind(mode.to_string()));
        }
        let changed = self.conn.execute(
            "UPDATE conversations SET mode = ?1 WHERE id = ?2",
            rusqlite::params![mode, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Configures an Agent conversation in one write: which agent runs and in
    /// which project folder. Also flips the mode to `agent` — an agent pick
    /// without the mode is a state the UI never creates. `agent_kind = None`
    /// means the brain is a server model (the conversation's model pin).
    pub fn set_conversation_agent(
        &self,
        id: i64,
        agent_kind: Option<AgentKind>,
        project_path: &str,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE conversations
             SET agent_kind = ?1, project_path = ?2, mode = 'agent'
             WHERE id = ?3",
            rusqlite::params![
                agent_kind.map(|kind| kind.as_str()),
                project_path,
                id
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Switches the conversation's brain between a server model (`None`) and
    /// a headless CLI agent — without touching the mode. The server pin
    /// (server_id/model_id) is never cleared: it simply becomes irrelevant
    /// while a CLI is the brain.
    pub fn set_conversation_brain(&self, id: i64, agent_kind: Option<AgentKind>) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE conversations SET agent_kind = ?1 WHERE id = ?2",
            rusqlite::params![agent_kind.map(|kind| kind.as_str()), id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Persists the per-conversation chat settings in one write. `None`
    /// clears system prompt / temperature / context length (the request then
    /// omits them). Reasoning (`thinking`) is always on — no per-row toggle.
    pub fn set_conversation_settings(
        &self,
        id: i64,
        system_prompt: Option<&str>,
        temperature: Option<f64>,
        context_len: Option<i64>,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE conversations
             SET system_prompt = ?1, temperature = ?2, context_len = ?3
             WHERE id = ?4",
            rusqlite::params![system_prompt, temperature, context_len, id],
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

    // ---- Skills -------------------------------------------------------------

    /// Creates a skill metadata row (library files are the SkillStore's job).
    /// `enabled` starts at 0 — schema default; skills ship disabled.
    pub fn create_skill(
        &self,
        name: &str,
        description: &str,
        kind: &str,
        path: &Path,
        size_bytes: i64,
    ) -> Result<Skill> {
        SkillKind::parse(kind)?;
        self.conn
            .query_row(
                &format!(
                    "INSERT INTO skills (name, description, kind, path, size_bytes)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     RETURNING {SKILL_COLUMNS}"
                ),
                rusqlite::params![name, description, kind, path.to_string_lossy(), size_bytes],
                row_to_skill,
            )
            .map_err(StoreError::from)
    }

    pub fn list_skills(&self) -> Result<Vec<Skill>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SKILL_COLUMNS} FROM skills ORDER BY name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map([], row_to_skill)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_skill(&self, id: i64) -> Result<Skill> {
        self.conn
            .query_row(
                &format!("SELECT {SKILL_COLUMNS} FROM skills WHERE id = ?1"),
                [id],
                row_to_skill,
            )
            .map_err(StoreError::from)
    }

    pub fn set_skill_enabled(&self, id: i64, enabled: bool) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE skills SET enabled = ?1 WHERE id = ?2",
            rusqlite::params![enabled, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Re-accounts content size after an edit.
    pub fn update_skill_size(&self, id: i64, size_bytes: i64) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE skills SET size_bytes = ?1 WHERE id = ?2",
            rusqlite::params![size_bytes, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    pub fn delete_skill(&self, id: i64) -> Result<()> {
        let changed = self.conn.execute("DELETE FROM skills WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    pub fn rename_skill(&self, id: i64, name: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE skills SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Sum of content sizes across enabled skills (0 when none).
    pub fn enabled_skill_size(&self) -> Result<i64> {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM skills WHERE enabled = 1",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }

    // ---- Messages ---------------------------------------------------------

    /// Inserts a message with the full payload used by chat (thinking, image
    /// attachments and the invoked-skill name included).
    pub fn insert_message_full(
        &self,
        conversation_id: i64,
        role: &str,
        content: &str,
        thinking: Option<&str>,
        images: &[String],
        skill_name: Option<&str>,
    ) -> Result<Message> {
        let images_json = serde_json::to_string(images)
            .map_err(|e| StoreError::Sqlite(rusqlite::Error::ToSqlConversionFailure(e.into())))?;
        self.conn.query_row(
            &format!(
                "INSERT INTO messages (conversation_id, role, content, thinking, images, skill_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 RETURNING {MESSAGE_COLUMNS}"
            ),
            rusqlite::params![conversation_id, role, content, thinking, images_json, skill_name],
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
        self.insert_message_full(conversation_id, role, content, None, &[], None)
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

    // ---- Message control (edit / regenerate / delete) ----------------------

    /// One message by id.
    pub fn get_message(&self, id: i64) -> Result<Message> {
        self.conn
            .query_row(
                &format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1"),
                [id],
                row_to_message,
            )
            .map_err(StoreError::from)
    }

    /// Newest message of a conversation, if any.
    pub fn last_message(&self, conversation_id: i64) -> Result<Option<Message>> {
        self.conn
            .query_row(
                &format!(
                    "SELECT {MESSAGE_COLUMNS} FROM messages
                     WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1"
                ),
                [conversation_id],
                row_to_message,
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(StoreError::from(other)),
            })
    }

    /// Deletes one message; the FTS index is cleaned by trigger.
    pub fn delete_message(&self, id: i64) -> Result<()> {
        let changed = self.conn.execute("DELETE FROM messages WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Rewrites one message's content in place; the FTS index follows by
    /// trigger.
    pub fn update_message_content(&self, id: i64, content: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2",
            rusqlite::params![content, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Deletes every message of the conversation strictly after `after_id` —
    /// id order is the conversation path in the Alpha. Returns how many were
    /// removed; the FTS index follows row by row by trigger.
    pub fn truncate_after(&self, conversation_id: i64, after_id: i64) -> Result<usize> {
        let changed = self.conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND id > ?2",
            rusqlite::params![conversation_id, after_id],
        )?;
        Ok(changed)
    }

    /// Sets or clears (`None`) the message's personal emoji reaction.
    pub fn set_reaction(&self, id: i64, reaction: Option<&str>) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE messages SET reaction = ?1 WHERE id = ?2",
            rusqlite::params![reaction, id],
        )?;
        if changed == 0 {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Forks the conversation at `from_message_id`: that message and
    /// everything after it are copied into a brand-new conversation; nothing
    /// before is cloned and the original is left byte-identical. The fork
    /// inherits the conversation settings (server/model pin included) and
    /// takes its title from the message it starts at.
    pub fn fork_conversation(
        &self,
        conversation_id: i64,
        from_message_id: i64,
    ) -> Result<Conversation> {
        // Fails loudly when either the conversation or the message is gone,
        // and when the message lives somewhere else.
        self.get_conversation(conversation_id)?;
        let start = self.get_message(from_message_id)?;
        if start.conversation_id != conversation_id {
            return Err(StoreError::Sqlite(
                rusqlite::Error::InvalidParameterName(
                    "message does not belong to this conversation".into(),
                ),
            ));
        }
        let title = autotitle_from(&start.content);

        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO conversations (title, server_id, model_id, mode, system_prompt, temperature, context_len, thinking)
             SELECT ?1, server_id, model_id, mode, system_prompt, temperature, context_len, thinking
             FROM conversations WHERE id = ?2",
            rusqlite::params![title, conversation_id],
        )?;
        let new_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO messages (conversation_id, role, content, thinking, images, reaction, skill_name, created_at)
             SELECT ?1, role, content, thinking, images, reaction, skill_name, created_at
             FROM messages
             WHERE conversation_id = ?2 AND id >= ?3
             ORDER BY id",
            rusqlite::params![new_id, conversation_id, from_message_id],
        )?;
        tx.commit()?;

        self.get_conversation(new_id)
    }

    // ---- Search ------------------------------------------------------------

    /// Full-text search across all conversations via the FTS5 index. The
    /// index itself is kept in sync by triggers (insert / update / delete),
    /// so there is nothing to maintain here. Terms are ANDed and matched as
    /// prefixes ("ker" hits "kernel"); every term is double-quoted so user
    /// input can never inject FTS syntax. `limit` caps the result count,
    /// best matches first.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let fts_query = build_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT m.id, m.conversation_id, c.title, m.role,
                    snippet(messages_fts, 0, '', '', '…', 16), m.created_at
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             JOIN conversations c ON c.id = m.conversation_id
             WHERE messages_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![fts_query, limit as i64],
            |row| {
                Ok(SearchHit {
                    message_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    conversation_title: row.get(2)?,
                    role: row.get(3)?,
                    snippet: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    // ---- Settings ---------------------------------------------------------

    /// App-level defaults. A missing row (never configured) reads as empty.
    pub fn get_settings(&self) -> Result<Settings> {
        self.conn
            .query_row(
                "SELECT default_server_id, default_model_id, default_system_prompt
                 FROM settings WHERE id = 1",
                [],
                |row| {
                    Ok(Settings {
                        default_server_id: row.get(0)?,
                        default_model_id: row.get(1)?,
                        default_system_prompt: row.get(2)?,
                    })
                },
            )
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(Settings::default()),
                other => Err(StoreError::Sqlite(other)),
            })
    }

    /// Sets (or clears with `None`) the app-wide default system prompt.
    /// The server/model defaults, if configured, are left untouched.
    pub fn set_default_system_prompt(&self, prompt: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (id, default_system_prompt) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET default_system_prompt = ?1",
            rusqlite::params![prompt],
        )?;
        Ok(())
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
        agent_kind: row.get(5)?,
        project_path: row.get(6)?,
        system_prompt: row.get(7)?,
        temperature: row.get(8)?,
        context_len: row.get(9)?,
        thinking: row.get::<_, i64>(10)? != 0,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
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

fn row_to_skill(row: &rusqlite::Row<'_>) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        kind: row.get(3)?,
        enabled: row.get::<_, i64>(4)? != 0,
        path: row.get(5)?,
        size_bytes: row.get(6)?,
        created_at: row.get(7)?,
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
        skill_name: row.get(7)?,
        created_at: row.get(8)?,
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

/// Turns free text into a safe FTS5 query: every whitespace-separated term
/// is double-quoted (so punctuation can never inject FTS syntax) and made a
/// prefix match; terms are ANDed together.
fn build_fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}
