# PRD — Shaim by CrystalPlatforms

**Product:** Shaim — private Self-Hosted LLM Manager
**Developer:** CrystalPlatforms
**First release:** Shaim Alpha v.0.0.1
**Status of this document:** seed document of a brand-new repository (CRS-SHAIM). Zero code is carried over from the previous codebase (Inline); this PRD is the single source of truth for Alpha.

---

## Problem Statement

I run open-source LLMs on my own machines — primarily Ollama with Qwen models on a Linux box across the LAN. Today, using them means raw terminals, `curl`, or Ollama's bare-bones web page. There is no single, private, native-feeling place where I can:

- chat with any of my self-hosted models from any of my computers,
- keep a searchable local history of those conversations,
- and talk to coding agents (Claude Code, Codex) in the same window.

Existing chat UIs are either cloud-first, bloated, or treat self-hosted servers as an afterthought.

## Solution

**Shaim** is a private, single-user, cross-platform (macOS / Windows / Linux) desktop chat application built with Tauri. It connects directly to model servers on the LAN (Ollama first-class, plus any OpenAI-compatible endpoint), streams answers with rich rendering (code blocks, tables, thinking blocks), keeps everything in a local SQLite database, and offers an input-mode switch: **Natural** (plain model chat) and **Agent** (chat with a coding-agent CLI that has access to a chosen project folder). No accounts, no login, no telemetry, LAN only.

---

## User Stories

### Servers & models

1. As the user, I want to add a model server (name, type: Ollama or OpenAI-compatible, base URL like `http://192.168.x.x:11434`, optional API key), so that Shaim knows where my models live.
2. As the user, I want a "Test connection" action when adding/editing a server, so that I immediately know if the address works (success, or a clear failure reason within a 3 s timeout).
3. As the user, I want to edit a server's details later, so that I can fix an IP or key without re-adding it.
4. As the user, I want to delete a server, so that my list stays clean — and its past conversations must be preserved (only new sends require a reachable server).
5. As the user, I want to see each server's online/offline status and its list of available models, so that I know what I can use right now.
6. As the user, I want to pick any model from any server for a conversation, so that I am not locked to one default.
7. As the user, I want a configurable default server + model for new conversations, so that I don't reselect it every time.
8. As the user, I want servers that require an API key to send it as a Bearer header, so that protected endpoints (e.g. LM Studio with auth, OpenAI-compatible gateways) work.

### Chat

9. As the user, I want to start a new conversation, see all conversations in a sidebar, rename and delete them, so that my work stays organized.
10. As the user, I want my message sent to a model and the reply streamed token-by-token into the chat, so that I see progress immediately.
11. As the user, I want a Stop button that halts generation mid-stream, so that I don't waste compute on a bad answer.
12. As the user, I want to regenerate the last assistant response (it is replaced), so that I can retry a weak answer.
13. As the user, I want to edit my own earlier message, so that the conversation continues from that point (messages after it are dropped in this conversation path).
14. As the user, I want per-conversation settings — system prompt, temperature, context length, thinking on/off — so that I control model behavior.
15. As the user, I want to switch models mid-conversation, so that I can compare answers without losing history.
16. As the user, I want rich markdown rendering — headings, lists, tables, blockquotes, links, inline code, and fenced code blocks with syntax highlighting and a copy button — so that technical answers are readable.
17. As the user, I want "thinking" content rendered as a collapsible block, so that reasoning is available but out of the way.
18. As the user, I want to attach images to a message for vision-capable models, so that I can ask about screenshots and photos; sent images stay visible in the thread.
19. As the user, I want Enter to send and Shift+Enter for a newline in a multiline composer, so that writing feels natural.
20. As the user, I want new conversations auto-titled from the first message (simple truncation), so that the sidebar is navigable; I can rename anytime.

### Message actions

21. As the user, I want to copy a message's raw text via its context menu, so that I can paste it elsewhere.
22. As the user, I want to delete a message (with confirmation) via its context menu, so that I can clean up a thread.
23. As the user, I want a Reply action that quotes the message into the composer, so that I can reference it.
24. As the user, I want to add/remove a personal emoji reaction on any message, so that I can mark important answers.
25. As the user, I want a right-click action **"Fork from this"** that creates a new conversation containing that message and everything after it (nothing before it is cloned; the original conversation is untouched), so that I can branch an experiment without losing the original.

### Search & persistence

26. As the user, I want full-text search across all conversations with jump-to-result, so that I can find an old answer in seconds.
27. As the user, I want everything (conversations, messages, servers, settings) persisted locally in SQLite, so that history survives restarts with zero setup.

### Modes & agents

28. As the user, I want a mode selector at the composer — **Natural** (default) and **Agent** in Alpha — designed so Brainstorm/Unrestricted can be added after Alpha, so that the input stays simple today.
29. As the user, I want an Agent conversation where I pick an agent (Claude Code or Codex) and a project folder, and the agent's output streams into the chat as messages, so that I can drive coding work from Shaim.
30. As the user, I want the agent's tool/command activity rendered as collapsible blocks between its messages, so that I can see what it did without the noise.
31. As the user, I want to stop an agent session, which terminates its process, so that a runaway agent doesn't keep working.
32. As the user, I want Shaim to detect a missing agent CLI and show a clear message with install guidance, so that failures are understandable.

### App & platform

33. As the user, I want one codebase that builds for macOS, Windows and Linux (Tauri), so that no machine is left out; Alpha is validated on macOS, Windows/Linux installers come from CI.
34. As the user, I want a dark, native-feeling UI in the CRS-Theme palette (primary green `#2bc585`) with the Shaim logo as the app icon and window title "Shaim", so that the app feels like a real product.
35. As the user, I want the About section to show "Shaim Alpha v.0.0.1" and "CrystalPlatforms", with zero references to the predecessor product anywhere in the app, so that branding is clean.
36. As the user, I want the app fully local — no accounts, no login, no telemetry, no outbound calls except to the servers I configured (and agent CLIs I launch), so that my data stays mine.
37. As the user, I want a settings screen (servers, defaults, about), so that everything has one obvious home.

### Landing

38. As the user, I want a landing page at `shaim.pages.dev` — a single static `index.html` in English: hero ("Shaim — self-hosted LLM manager"), feature list (connect Ollama & OpenAI-compatible servers, rich chat, agents in chat — Alpha), footer "by CrystalPlatforms" — styled with CRS-Theme colors and the Shaim logo.
39. As the user, I want the landing deployed on Cloudflare Pages with no backend, so that it is free, fast, and maintenance-free.

---

## Implementation Decisions

- **Architecture:** Tauri v2 desktop app. Rust core (Shaim Core) + React + TypeScript UI with shadcn/ui. UI copy in English. Dark-first CRS-Theme (tweakcn export; primary `#2bc585`). Branding: Shaim, developer CrystalPlatforms, provided logo (two rounded chat faces on black) as app icon and landing mark.
- **Deep module — Store:** the Rust core owns a single SQLite file in the OS app-data directory (via `rusqlite`; FTS5 for search). Narrow interface: create/read/update/delete for conversations, messages, servers, settings; search; fork. All UI persistence goes through it — no direct SQL from the frontend.
- **Deep module — ModelGateway:** the only component that talks to model servers. Public surface: `listModels(server)` and `chat(server, model, messages, options) -> stream`. Inside: Ollama native API first-class (including thinking output) and a generic OpenAI-compatible client (`/v1/chat/completions`, Bearer auth) — the rest of the app cannot tell the difference. Streaming flows Rust → UI over Tauri events/channels.
- **Deep module — AgentRunner:** spawns agent CLIs as child processes in a user-chosen project directory and converts their streamed output into chat messages and collapsible activity blocks. Implemented as a trait with one adapter per CLI (Claude Code, Codex); adding Gemini CLI later means adding an adapter, not touching the engine. Exact headless flags (e.g. `claude -p --output-format stream-json`, `codex exec --json`) are verified during implementation; adapters are expected to drift with CLI versions and are isolated for that reason.
- **Modes as configuration:** Natural and Agent are session configurations consumed by the modules above, not separate code paths. The mode enum is designed for Brainstorm and Unrestricted post-Alpha.
- **Fork semantics:** "Fork from this" copies the selected message and all subsequent messages into a brand-new conversation; the original is never modified. Regenerate replaces the last assistant message (no variant tree in Alpha).
- **Message extras:** reactions are single-user emoji marks on messages; Reply quotes text into the composer; images are stored with the message and sent to vision-capable models (Ollama images field / OpenAI image parts).
- **No auth, no server:** the app is LAN-only and single-user; there is no login, no accounts, no cloud sync, no telemetry.
- **Landing:** one static `index.html` (inline CSS, no build step, no backend), deployed to Cloudflare Pages at `shaim.pages.dev`.
- **Repository:** brand-new empty repo named **CRS-SHAIM**; this PRD is its seed document. Nothing is imported from the predecessor codebase.
- **Delivery order (owner-approved):** landing → foundation (Tauri + React + SQLite skeleton) → functioning (chat, servers, modes) → branding → polish → **Shaim Alpha v.0.0.1** release.

## Assumptions

- The Linux box runs Ollama, stays powered and reachable over the home LAN; local-area network is a trusted environment (this is why there is no auth).
- Single user only; no concurrent access to the SQLite file or to agent sessions.
- Claude Code and Codex CLIs are installed and kept current on the machine running Shaim; their headless output formats may change between versions (mitigated by isolating adapters).
- OSS models available to me (e.g. Qwen family) are adequate for chat and, where advertised, vision; coding-agent answer quality depends on model capability and is not a Shaim defect.
- Tauri v2 remains stable and builds on all three OSes; macOS is the validated platform in Alpha, Windows/Linux artifacts are produced by CI but not hand-tested in Alpha.
- The CRS-Theme tweakcn export remains the design source of truth; the logo PNG is sufficient resolution for app icon and landing use (raster-only in Alpha).
- `shaim.pages.dev` remains available as a Cloudflare Pages subdomain at deploy time.
- Alpha is a first full private release ("not an MVP"): the full chat feature list above is in scope for v.0.0.1.

## Tradeoffs Considered

- **Reworking the predecessor (Inline) codebase in place** — rejected because its multiplayer/realtime server machinery is dead weight for a single-user desktop app; a fresh start is faster and cleaner.
- **Native Swift macOS app** — rejected because it locks out Windows/Linux; Tauri covers all three from one codebase.
- **Electron** — rejected for memory footprint and bundle size versus Tauri.
- **Bun/Node sidecar server inside Tauri** — rejected because the Rust core already covers HTTP streaming and process spawning; a second runtime doubles packaging complexity.
- **PostgreSQL + Drizzle (predecessor stack)** — rejected because a desktop app must not require a running database server; SQLite is zero-config.
- **Shaim as an API "brain" for agent CLIs (Anthropic/OpenAI-compatible proxy so agents run on OSS models)** — deferred to post-Alpha full harness; Alpha ships agents-in-chat only.
- **Ollama-only support** — rejected because a generic OpenAI-compatible client is cheap and covers LM Studio, llama.cpp and vLLM for free.
- **Login/auth** — rejected: LAN-only private app on a trusted network.
- **Cloudflare Tunnel remote access** — rejected for Alpha (LAN-only decision); revisit if remote access is ever wanted.
- **ChatGPT-style variant navigation (`<` `>` between regenerated answers)** — rejected for Alpha; regenerate replaces, "Fork from this" covers branching.
- **LLM-generated conversation titles** — rejected for Alpha (extra calls, latency); first-message truncation is instant and good enough.

## Validation Strategy

Automated checks live in the Rust core (fast, headless); everything user-facing is verified by manual HITL steps. "Done" for each component = its validation entries pass.

- **Servers & models (stories 1–8):** Rust integration tests run a mock Ollama server and a mock OpenAI-compatible server on localhost and cover: list-models, streamed chat, Bearer header presence, bad-URL failure with ≤ 3 s timeout. Manual HITL: add the real Linux box by IP → Test connection succeeds → model list appears; enter a wrong IP → clear error within 3 s; edit and delete a server → its old conversations remain openable (story 4).
- **Chat engine (9–15):** manual HITL with the real Ollama box: send → text streams in; Stop halts within ~1 s; Regenerate replaces the last answer; Edit an earlier message → conversation continues from there; switch model mid-conversation → history intact; per-conversation settings (system prompt, temperature, thinking) visibly change behavior. UI must stay interactive while streaming (typing is never blocked) — checked manually and, later, by a Playwright smoke pass.
- **Rendering (16–19):** a fixture conversation containing headings, lists, tables, blockquotes, links, code in 3+ languages (with copy button), a thinking block, and two images renders correctly; Enter sends, Shift+Enter breaks line.
- **Message actions (21–25):** manual HITL for copy/reply/react/delete; automated Rust test for Fork: forking a 1 000-message conversation completes in < 100 ms, produces a new conversation containing exactly the selected message onward, and leaves the original byte-identical.
- **Search & persistence (26–27):** automated test: seed 10 000 messages, full-text query returns in < 200 ms; manual HITL: quit and relaunch the app → all conversations, servers and settings intact.
- **Modes & agents (28–32):** manual HITL with real CLIs: Agent conversation on a scratch project folder → Claude Code and Codex both stream replies and collapsible activity blocks; Stop terminates the process (verified via `ps`/Activity Monitor); temporarily renaming the CLI binary → Shaim shows the missing-CLI message with guidance. Mode selector defaults to Natural.
- **App & platform (33–37):** `cargo test` + `tauri build` for macOS must pass locally; CI produces Windows/Linux artifacts (green pipeline = pass). Manual: dark CRS-Theme applied, logo icon shown, About reads "Shaim Alpha v.0.0.1 / CrystalPlatforms"; `grep -ri inline` over shipped UI strings and identifiers returns nothing (story 35); with servers stopped, no unexpected outbound network calls appear in logs (story 36).
- **Landing (38–39):** deployed page loads in < 2 s on broadband, zero console errors, single HTML file, correct hero/features/footer, CRS-Theme colors, logo; Cloudflare Pages shows the `shaim.pages.dev` deployment.

## Out of Scope (Alpha)

- **Brainstorm** and **Unrestricted** modes (post-Alpha; the pipeline `ask → blueprint → carve → dispatch → propose TDD` lands then).
- **Shaim-as-brain proxy** (OpenAI/Anthropic-compatible endpoint that lets terminal agent CLIs run on OSS models) — post-Alpha full harness, together with agents-in-chat forming the complete harness.
- Variant navigation (`<` `>`) between regenerated answers.
- Multi-user features of any kind: accounts, login, sharing, sync, cloud storage.
- Remote (non-LAN) access, tunnels, exposure to the internet.
- Voice input, RAG/documents, MCP client, plugin system, agent marketplace.
- Telemetry, auto-update, crash reporting, app-store signing/notarization pipelines.
- Hand-validated Windows/Linux installs (CI artifacts only in Alpha).
- Gemini CLI or further agent adapters (architecture ready, adapters post-Alpha).

## Further Notes

- **Delivery phases (owner-approved):** repo cleanup (owner deletes the old codebase and starts the new empty CRS-SHAIM repo) → landing → foundation → functioning → branding → polish → **Shaim Alpha v.0.0.1**.
- **Design source:** CRS-Theme on tweakcn (`https://tweakcn.com/themes/cmt74d0k7000004l091oj50cy?p=colors`) — export CSS variables during foundation; primary `#2bc585`, dark background, neutral grays.
- **Logo:** `shaim-logo.PNG` (two rounded chat faces on black) — app icon (all platforms), landing mark.
- **Landing copy (EN):** hero "Shaim — self-hosted LLM manager"; features: connect Ollama & any OpenAI-compatible server, rich chat (code blocks, thinking), agents in chat (Alpha); footer "by CrystalPlatforms".
- **Free-tier infra:** Cloudflare Pages (landing) is free; if remote access is ever revisited, Cloudflare Tunnel is the known free option.
- **Language policy:** app UI and this PRD are in English; conversation with the developer is in Polish.

---
✻ Brewed for 9s · done 2:57 PM

──────────────
