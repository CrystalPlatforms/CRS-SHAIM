# Plan: Klepai Skills (Post-Alpha)

> Source PRD: issue #16 (annex to `PRD.md` / issue #1). Post-Alpha — every slice lands after the Alpha release (#15). Alpha scope is untouched.

## Architectural decisions

Durable decisions that apply across all phases:

- **Deep module SkillStore (Rust core)**: sole owner of the on-disk skill library (OS app-data dir) + skill metadata rows in the Store (`name`, `description`, `kind: package | markdown`, `enabled`, `path`). Import, listing, toggle, edit, delete, and library read all go through it; nothing else touches skill files.
- **Format model**: `.skill` = zip of a skill folder that must contain `SKILL.md`; `.md` = single instruction file. Name/description parsed from YAML frontmatter, falling back to filename + first paragraph.
- **Injection at boundaries only — server-model only (owner decision, 2026-10-16)**: enabled skills are appended to the system prompt during ModelGateway request assembly (Natural mode), with a total size cap (**32 KiB**) + warning. **Skills never reach Claude Code or Codex**: no native skills-directory handoff, no session-prompt injection into agent CLIs. The native agent-skills palette (the CLI's own installed skills, `list_agent_skills`) is a separate existing feature and stays untouched.
  > **SUPERSEDED (2026-10-17)** by PRD #16 stories 10 & 12 and issues #19/#20: enabled skills are handed to Agent-mode CLI sessions (session-prompt injection via `prompt_with_skills`), and the `/` palette works in both Natural and Agent composers. The 32 KiB cap and the untouched `list_agent_skills` palette still stand.
- **Slash palette is composer-level, Natural conversations only**: `/` opens a palette of all imported skills (name + description, filter, arrows + Enter); selection attaches the skill's content to the next outgoing message as a one-shot, independent of the global toggle. The palette does not appear in Agent (Claude Code / Codex) conversations.
- **No execution by Klepai**: skill scripts are only made available to agent CLIs inside their sessions.
- **Sequencing**: all phases depend on the Alpha stack (Store, ModelGateway, AgentRunner, composer) already existing — guaranteed by the #15 blocker at issue level.

---

## Phase S1: SkillStore — import & persistence

**User stories (PRD #16)**: 1, 2, 8

### What to build

The SkillStore module plus the import path behind "Add skill": accepting a `.skill` file unzips it into the library (validating `SKILL.md` exists; clear error otherwise) and a `.md` file is copied in as a markdown skill. Metadata (name, description, kind, enabled=false by default, path) is written to the Store. Library files + metadata persist across restarts.

### Assumptions carried in

- Alpha stack merged (Store schema mechanisms, app-data dir conventions from Phase 2 of the Alpha plan).
- Fixture `.skill`/`.md` files derived from the owner's real library for tests.

### Out of scope for this phase

- Any UI; injection; palette. This phase is module + import + persistence.

### Acceptance criteria

- [ ] Integration test: importing a fixture `.skill` (zip) creates a library folder with `SKILL.md` + side files and a metadata row with correct name/description/kind — [test]
- [ ] Integration test: importing a fixture `.md` creates a markdown skill with frontmatter-parsed (or filename fallback) metadata — [test]
- [ ] Integration test: a zip without `SKILL.md` fails with a clear, user-readable error — [test]
- [ ] Integration test: library files + metadata survive a simulated restart — [test]

---

## Phase S2: Settings — Skills section

**User stories (PRD #16)**: 3, 4, 5, 6, 7

### What to build

Settings → Skills: the list (name, short description, kind badge), a global enable/disable toggle per skill, in-app editing of the markdown content (SKILL.md body for packages), delete with confirmation, and a visible warning when enabled skills exceed the total size cap.

### Assumptions carried in

- SkillStore from S1 provides list/toggle/edit/delete + size accounting.

### Out of scope for this phase

- Injection behavior; the composer palette; import UX beyond the "Add skill" button.

### Acceptance criteria

- [ ] List renders every imported skill with name, description, kind badge — [observable: screenshot in the PR]
- [ ] Toggle flips `enabled` in the Store; state survives restart — [test + observable]
- [ ] Editing saves changes to the library file and the UI reflects them — [test]
- [ ] Delete asks for confirmation and removes metadata + files — [test + observable]
- [ ] Enabling skills above the cap shows the size warning — [test]

---

## Phase S3: Injection — Natural & Agent

**User stories (PRD #16)**: 9, 10

### What to build

Enabled skills become active in Natural mode only: their content is appended to the system prompt during ModelGateway request assembly (respecting the 32 KiB cap + warning). **Agent mode is intentionally untouched** — Claude Code and Codex never receive Klepai skills (no native directory handoff, no prompt injection). Disabled skills never reach requests. Klepai itself never executes skill scripts.

### Assumptions carried in

- ModelGateway and AgentRunner extension points exist from the Alpha plan; SkillStore supplies the enabled set.

### Out of scope for this phase

- Per-message (slash) invocation; per-conversation overrides.

### Acceptance criteria

- [ ] Integration test: outgoing Natural request's system prompt contains enabled-skill content; a disabled skill is absent — [test]
- [ ] Cap (32 KiB) respected in request assembly — [test]
- [ ] Agent conversations carry no Klepai-skill content in the spawn handoff — [test]
- [ ] HITL: a real server-model conversation sees an enabled skill — [HITL: owner-run session]

---

## Phase S4: Slash palette in the composer

**User stories (PRD #16)**: 11, 12, 13

### What to build

Typing `/` in the composer opens the skill palette: all imported skills with name + description, text filtering, arrow-key + Enter selection. Selecting a skill attaches it to the next outgoing message as a one-shot (Natural sends only — Agent conversations get no skill palette), shown as an indicator on the composer/message; the next send without invocation carries no skill. Independent of the global toggle.

### Assumptions carried in

- SkillStore listing + content read from S1; send paths from S3 reuse the same attach mechanism.

### Out of scope for this phase

- Skill arguments/parameters; chained invocations; palette-driven skill creation.

### Acceptance criteria

- [ ] UI test: `/` opens the palette, filtering narrows, Enter selects — [test]
- [ ] Integration test: the invoked skill's content is attached to that one outgoing request and absent from the next — [test]
- [ ] Attached-skill indicator visible on composer/message — [observable]
- [ ] HITL: owner invokes a real skill with `/` in a live conversation — [HITL]
