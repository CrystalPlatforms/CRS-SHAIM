# Plan: Klepai Alpha v.0.0.1

> Source PRD: `PRD.md` in this repository (Klepai by CrystalPlatforms — private Self-Hosted LLM Manager). Every phase traces to numbered user stories in that PRD.

## Architectural decisions

Durable decisions that apply across all phases:

- **Architecture style**: Tauri v2 desktop app — Rust core + React/TypeScript UI with shadcn/ui. One codebase builds macOS, Windows, Linux. All UI copy in English. No backend process; the Rust core is the app.
- **Deep modules (Rust core)**:
  - **Store** — sole owner of one SQLite file in the OS app-data directory (`rusqlite`, FTS5 enabled). Narrow CRUD + search + fork interface; no SQL from the frontend.
  - **ModelGateway** — sole component that speaks to model servers. Surface: `listModels(server)`, `chat(server, model, messages, options) -> stream`. Two internal dialects (Ollama native API; OpenAI-compatible `/v1/chat/completions` with Bearer auth) are invisible to the rest of the app. Streaming flows to the UI over Tauri events/channels.
  - **AgentRunner** — spawns coding-agent CLIs headless in a user-chosen project directory; a trait with one adapter per CLI (Claude Code, Codex); adapter output converts to chat messages + collapsible activity blocks. Adapters are isolated because CLI flags drift between versions.
- **Data model (key entities)**: `Server {id, name, kind: ollama | openai_compatible, base_url, api_key?, status}`, `Conversation {id, title, server_id?, model_id?, mode, settings {system_prompt, temperature, context_len, thinking}}`, `Message {id, conversation_id, role, content, thinking?, images[], reaction?, created_at}`, `Settings {default_server_id, default_model_id}`.
- **Modes as configuration**: mode is an enum on the conversation (`Natural | Agent`, extensible post-Alpha with Brainstorm/Unrestricted). Natural routes through ModelGateway; Agent routes through AgentRunner. Not separate code paths.
- **Fork semantics**: "Fork from this" copies the selected message and everything after it into a new conversation; nothing before is cloned; original untouched. Regenerate replaces the last assistant message (no variant tree).
- **Security posture**: LAN-only, single user, no accounts/login/telemetry/cloud sync. Outbound network limited to user-configured model servers and spawned agent CLIs.
- **Design source**: CRS-Theme CSS variables from the tweakcn export (primary `#2bc585`, dark-first); Klepai logo/icon assets from `assets/`.
- **Landing**: one static `index.html` (inline CSS, no build step) deployed to Cloudflare Pages at `klepai.pages.dev`.
- **Provenance**: zero code from the predecessor codebase (Inline); this repo starts from the PRD alone.

---

## Phase 1: Landing on Cloudflare Pages

**User stories**: 38, 39

### What to build

A single static `index.html`: hero "Klepai — self-hosted LLM manager", feature list (connect Ollama & any OpenAI-compatible server; rich chat with code blocks and thinking; agents in chat — Alpha), footer "by CrystalPlatforms". Styled with CRS-Theme variables (dark, primary `#2bc585`) and the Klepai logo from `assets/`. Inline CSS, no build step, no backend; deployed to Cloudflare Pages as `klepai.pages.dev`.

### Assumptions carried in

- `klepai.pages.dev` subdomain is available at deploy time; Cloudflare Pages free tier.
- Assets in `assets/` are the final brand files.

### Out of scope for this phase

- Any backend, forms, analytics, or multi-page structure.
- Download links / release distribution (app comes later).

### Acceptance criteria

- [ ] Deployed page loads in < 2 s on broadband with zero console errors — [observable: open `klepai.pages.dev`, check DevTools console + network timing]
- [ ] Hero, feature list, footer copy match the PRD; CRS-Theme colors and logo visible — [observable: visual check against PRD copy]
- [ ] Site is one static HTML file with no build artifacts — [observable: view-source]

---

## Phase 2: App skeleton (Tauri shell + Store init)

**User stories**: 34 (partial), 27 (partial)

### What to build

Tauri v2 project with React/TS + shadcn/ui. Window titled "Klepai", dark CRS-Theme applied via CSS variables from the tweakcn export, app icon generated from `assets/` for all platforms. Three-pane shell (sidebar / chat / detail) as static placeholders. Rust core initializes the Store: SQLite file created in the OS app-data directory with the schema for servers, conversations, messages, settings (FTS5 available). Nothing talks to the network yet.

### Assumptions carried in

- Rust toolchain + Tauri prerequisites installed on the dev Mac.
- tweakcn CRS-Theme export is the design source of truth.

### Out of scope for this phase

- Any model traffic, agent CLIs, search UI, conversation behavior.
- Windows/Linux build validation (CI comes in Phase 13).

### Acceptance criteria

- [ ] App builds and launches on macOS with title "Klepai" — [command: `tauri dev` / `tauri build` exits 0]
- [ ] SQLite file exists in app-data dir containing the four entity tables after first launch — [observable: inspect DB file]
- [ ] Dark CRS-Theme (green primary) and Klepai icon visible — [observable: visual check]

---

## Phase 3: Conversations CRUD + persistence

**User stories**: 9 (partial), 27

### What to build

Sidebar lists real conversations from the Store; create, rename, delete. Chat pane is an empty state with a disabled composer placeholder. Everything persists across restarts. No model calls yet — this proves the Store path end to end through the UI.

### Assumptions carried in

- Store schema from Phase 2 is correct; no migrations needed yet.

### Out of scope for this phase

- Sending messages; auto-titles (manual rename only — auto-title lands with first send in Phase 5).

### Acceptance criteria

- [ ] Create → rename → delete conversation works; state survives quit + relaunch — [HITL: manual restart check]
- [ ] Store round-trip: conversation create/rename/delete via integration tests — [test: Rust integration test]
- [ ] Deleting a conversation removes its messages — [observable: DB row check]

---

## Phase 4: Model servers

**User stories**: 1, 2, 3, 4, 5, 8

### What to build

Settings → Servers. Add a server (name, kind: Ollama or OpenAI-compatible, base URL, optional API key); "Test connection" answers success or a clear failure reason within 3 s; per-server online status; model list fetched through `ModelGateway.listModels`. Edit and delete servers — deleting never touches past conversations. Keyed OpenAI-compatible servers send the key as a Bearer header.

### Assumptions carried in

- The Linux Ollama box is reachable on the LAN by IP during HITL checks.
- ModelGateway hides dialect differences (Ollama vs OpenAI-compatible) from the UI.

### Out of scope for this phase

- Sending chat; choosing default server/model (Phase 5); per-conversation model picker.

### Acceptance criteria

- [ ] Against mock Ollama + mock OpenAI-compatible servers: listModels works; bad URL fails with clear error in ≤ 3 s; Bearer header present when key configured — [test: Rust integration tests]
- [ ] Add the real Linux box by IP → Test connection succeeds → models appear; wrong IP → clear error ≤ 3 s — [HITL]
- [ ] Edit server details works; deleting a server leaves old conversations openable — [HITL + observable: open a conversation of the deleted server]
- [ ] Server row shows online/offline status — [observable]

---

## Phase 5: Streamed chat (first real conversation)

**User stories**: 6, 7, 10, 11, 19, 20

### What to build

The composer comes alive. Pick any model from any server (picker per conversation; default server + model configurable in Settings). Send → reply streams token-by-token; Stop halts generation; Enter sends, Shift+Enter newlines. New conversations auto-title from the first message (truncation). Rendered as plain text for now — rich rendering is the next slice.

### Assumptions carried in

- Phases 2–4 in place (Store, servers, ModelGateway streaming).
- Streaming Rust → UI over Tauri events stays responsive; typing never blocks.

### Out of scope for this phase

- Markdown/thinking rendering (Phase 6); regenerate/edit/per-conversation settings (Phase 7); message context menu (Phase 8).

### Acceptance criteria

- [ ] With the real Ollama box: send → text streams in; Stop halts within ~1 s; UI stays interactive while streaming; Enter sends / Shift+Enter breaks line — [HITL]
- [ ] ModelGateway streamed chat delivers full text; abort stops cleanly — [test: mock server integration test]
- [ ] Auto-title appears in the sidebar from the first message — [observable]
- [ ] Conversation + messages survive restart — [observable: relaunch check]

---

## Phase 6: Rich rendering

**User stories**: 16, 17, 18

### What to build

Markdown rendering for messages: headings, lists, tables, blockquotes, links, inline code, fenced code blocks with syntax highlighting and a copy button. Thinking content renders as a collapsible block. Image attachments on messages: stored with the message, visible in the thread, and sent to vision-capable models (Ollama images field / OpenAI image parts).

### Assumptions carried in

- Message schema already carries thinking + images fields (Phase 2); content upgrade is display + send-path only.

### Out of scope for this phase

- Message context menu (Phase 8); per-conversation settings (Phase 7).

### Acceptance criteria

- [ ] Fixture conversation (headings, lists, table, blockquote, link, code in 3+ languages with copy buttons, a thinking block, two images) renders correctly — [HITL: load fixture]
- [ ] Images round-trip through the Store and reach a vision model which answers about the image — [test: Store round-trip] + [HITL: vision check]

---

## Phase 7: Conversation control

**User stories**: 12, 13, 14, 15

### What to build

Regenerate replaces the last assistant response. Editing an earlier own message continues the conversation from that point (messages after it are dropped in this path). Per-conversation settings: system prompt, temperature, context length, thinking on/off. Switch models mid-conversation without losing history.

### Assumptions carried in

- Streaming and persistence from Phases 5–6 behave; control actions reuse the same send path.

### Out of scope for this phase

- Fork/variant navigation (Phase 8 for fork; variant tree stays out of Alpha per PRD).

### Acceptance criteria

- [ ] Regenerate replaces the last answer; edit → reply continues from the edited point; temperature/system prompt/thinking visibly change behavior; mid-conversation model switch keeps history — [HITL]
- [ ] Store semantics: regenerate replaces the last assistant message; edit truncates subsequent messages in the path — [test: integration test]

---

## Phase 8: Message actions + Fork from this

**User stories**: 21, 22, 23, 24, 25

### What to build

Right-click context menu on any message: **Delete** (with confirmation), **Edit**, **Reply** (quotes into composer), **React** (add/remove a personal emoji), **Fork from this** (new conversation containing that message and everything after — nothing before is cloned, original untouched), **Kopiuj** (copy raw text).

### Assumptions carried in

- Messages and conversations fully persisted; fork is a Store operation.

### Out of scope for this phase

- Multi-reaction sets, other users' reactions (single-user app), variant navigation.

### Acceptance criteria

- [ ] Forking a 1 000-message conversation completes < 100 ms, produces exactly the selected message onward, original byte-identical — [test: integration test]
- [ ] All six menu actions work; delete confirms; reaction toggles on/off — [HITL]
- [ ] Forked conversation appears in the sidebar immediately — [observable]

---

## Phase 9: Full-text search

**User stories**: 26

### What to build

Search across all conversations via FTS5: results with conversation context, click a result → jump to that message in its conversation.

### Assumptions carried in

- FTS5 enabled since Phase 2; message content is the search corpus.

### Out of scope for this phase

- Semantic/vector search; search inside thinking blocks (content search only).

### Acceptance criteria

- [ ] Seed 10 000 messages, full-text query returns correct hits in < 200 ms — [test: integration test]
- [ ] Searching a known phrase from an old conversation jumps to the right message — [HITL]

---

## Phase 10: Agent mode — Claude Code adapter

**User stories**: 28, 29, 30, 31

### What to build

Mode selector at the composer — **Natural** (default) and **Agent** (enum designed for post-Alpha Brainstorm/Unrestricted). An Agent conversation picks the agent (Claude Code first) and a project folder; AgentRunner spawns the CLI headless in that folder and streams its output into the chat as messages with collapsible tool/activity blocks between them. Stop terminates the agent process.

### Assumptions carried in

- Claude Code CLI installed on the machine running Klepai; headless flags verified against the installed version (adapter isolated for drift).
- ModelGateway untouched — agents run through AgentRunner, not the model servers.

### Out of scope for this phase

- Codex adapter (Phase 11); running agents on OSS models via a Klepai proxy (post-Alpha).

### Acceptance criteria

- [ ] Real Claude Code session on a scratch project: prompt → streamed replies + collapsible activity blocks; Stop kills the process (verified via Activity Monitor) — [HITL]
- [ ] Recorded agent stream fixture parses into messages + activity blocks — [test: AgentRunner fixture test]
- [ ] Mode selector defaults to Natural — [observable]

---

## Phase 11: Agent mode — Codex adapter + missing-CLI guidance

**User stories**: 29 (second adapter), 32

### What to build

Codex adapter on the same AgentRunner trait — proof the engine is extensible. When a chosen CLI binary is missing, Klepai shows a clear message with install guidance instead of a cryptic failure — for both agents.

### Assumptions carried in

- AgentRunner trait + streaming pipeline from Phase 10 work unchanged for a second adapter.

### Out of scope for this phase

- Gemini CLI or further adapters (architecture ready, adapters post-Alpha).

### Acceptance criteria

- [ ] Real Codex session on a scratch project streams replies + activity blocks — [HITL]
- [ ] Temporarily renaming a CLI binary → missing-CLI message with install guidance — [HITL]
- [ ] Missing-binary path returns a structured error, no crash — [test]

---

## Phase 12: Branding sweep

**User stories**: 34, 35

### What to build

Final pass so the product reads as Klepai everywhere: About section "Klepai Alpha v.0.0.1" + "CrystalPlatforms"; window title and app icons finalized from `assets/` on all platform targets; sweep every UI string and identifier — zero references to the predecessor product.

### Assumptions carried in

- Theme + icon already applied since Phase 2; this phase is the audit + fixes, not a re-skin.

### Out of scope for this phase

- New visual design beyond CRS-Theme; splash screens, installers artwork beyond icon.

### Acceptance criteria

- [ ] `grep -ri inline` over the repo (excluding third-party lockfiles/dependencies) returns no predecessor references — [command]
- [ ] About shows "Klepai Alpha v.0.0.1 / CrystalPlatforms"; correct icon on all platform targets — [observable]

---

## Phase 13: Polish + platform hardening

**User stories**: 33, 36, 37

### What to build

Settings screen complete (servers, defaults, about). Network audit: with servers stopped, the app makes no unexpected outbound calls. UI never blocks during long streams. `cargo test` green; `tauri build` macOS succeeds; CI pipeline produces Windows/Linux artifacts.

### Assumptions carried in

- All features are in; this phase hardens and verifies, it adds no features.

### Out of scope for this phase

- Hand-testing Windows/Linux installs (CI artifacts only in Alpha, per PRD); signing/notarization.

### Acceptance criteria

- [ ] `cargo test` green; `tauri build` for macOS exits 0 — [command]
- [ ] CI pipeline green with Windows + Linux artifacts — [observable: CI dashboard]
- [ ] Servers stopped → no unexpected outbound traffic in logs — [HITL]
- [ ] Long stream never freezes typing; Settings covers servers, defaults, about — [HITL + observable]

---

## Phase 14: Release — Klepai Alpha v.0.0.1

**User stories**: close-out of all 39 (full PRD Validation Strategy sweep)

### What to build

Run the complete PRD validation sweep: full Rust test suite (mock servers, fork, search, agent fixtures) + the manual HITL checklist covering every story. Fix findings. Tag the release and produce artifacts. Per house rules, commits/pushes/tags happen only on the owner's explicit command.

### Assumptions carried in

- Phases 1–13 are done and validated; this phase verifies the whole, not parts.

### Out of scope for this phase

- Post-Alpha items (Brainstorm, Unrestricted, Klepai-as-brain proxy, variant navigation) — see PRD Out of Scope.

### Acceptance criteria

- [ ] Full Rust test suite green; `tauri build` macOS succeeds — [command]
- [ ] Every PRD Validation Strategy entry checked off, including all HITL steps — [observable: completed checklist]
- [ ] Tag `v0.0.1` + release artifacts exist (on owner's command) — [observable]
