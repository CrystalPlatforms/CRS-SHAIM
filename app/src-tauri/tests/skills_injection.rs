//! Skills injection into server-model request assembly (issue #19 S3) and
//! the one-shot invoked skill (issue #20 S4).
//!
//! Assumptions these tests encode:
//! - `resolve_target` + `apply_skill_injection` is the exact mapping both
//!   server-model send paths use (`stream_reply` for Natural, `run_tool_loop`
//!   for Agent mode with a server brain) — asserting on its output asserts
//!   on the real pipeline.
//! - Enabled skills ride in listing order; one that would push the running
//!   total past `SIZE_CAP_BYTES` is skipped (a later smaller one can still
//!   fit); the injected block never exceeds the cap.
//! - A one-shot invocation works only on an ENABLED skill — a disabled one
//!   is invisible to the palette and refused by the backend (owner decision,
//!   2026-10-17). An invoked skill rides on exactly ONE request: the next
//!   request without an id carries none.
//! - With no skills in play the system prompt is untouched — `None` stays
//!   `None`, a user prompt stays byte-identical.

use std::path::PathBuf;

use klepai_lib::commands::{apply_skill_injection, resolve_target};
use klepai_lib::gateway::ChatOptions;
use klepai_lib::skills::{SkillStore, SIZE_CAP_BYTES};
use klepai_lib::store::Store;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "klepai-injection-tests-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir should be creatable");
    dir
}

/// A conversation pinned to a server + model — the minimum `resolve_target`
/// needs to produce a real request target.
fn chat_ready_conversation(store: &Store) -> i64 {
    let server = store
        .create_server("mock", "ollama", "http://127.0.0.1:11434", None)
        .expect("server should create");
    let conv = store.create_conversation(None).expect("conversation");
    store
        .set_conversation_model(conv.id, Some(server.id), Some("llama3:8b"))
        .expect("model pin should set");
    conv.id
}

/// Imports a markdown skill named `name` with `body` as its instruction
/// content (frontmatter-stripped body = exactly `body`).
fn import_skill(skills: &SkillStore, store: &Store, dir: &PathBuf, name: &str, body: &str) -> i64 {
    let source = dir.join(format!("{name}.md"));
    std::fs::write(
        &source,
        format!("---\nname: {name}\ndescription: {name} does things\n---\n\n{body}"),
    )
    .expect("fixture should write");
    skills
        .import(store, &source)
        .expect("import should succeed")
        .id
}

fn injected_prompt(store: &Store, skills: &SkillStore, conv: i64, skill_id: Option<i64>) -> ChatOptions {
    let (_, _, mut options) = resolve_target(store, conv).expect("target should resolve");
    apply_skill_injection(store, skills, &mut options, skill_id)
        .expect("injection should succeed");
    options
}

#[test]
fn enabled_skill_content_reaches_the_system_prompt_and_disabled_does_not() {
    let dir = temp_dir("enabled-disabled");
    let store = Store::open(&dir.join("klepai.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");
    let conv = chat_ready_conversation(&store);

    let enabled = import_skill(
        &skills,
        &store,
        &dir,
        "greeter",
        "Always greet the user in Latin.",
    );
    // Imported but never enabled — the negative case.
    import_skill(&skills, &store, &dir, "whisperer", "Answer only in whispers.");
    skills
        .set_enabled(&store, enabled, true)
        .expect("enable should succeed");

    let options = injected_prompt(&store, &skills, conv, None);

    let prompt = options.system_prompt.expect("skills block should create a prompt");
    assert!(
        prompt.contains("Always greet the user in Latin."),
        "enabled skill content must ride in the system prompt"
    );
    assert!(
        !prompt.contains("whispers"),
        "a disabled skill must never reach the request"
    );
    assert!(
        prompt.contains("## Active skills") && prompt.contains("### greeter"),
        "the skill travels as a named section"
    );
}

#[test]
fn request_assembly_respects_the_size_cap() {
    let dir = temp_dir("cap");
    let store = Store::open(&dir.join("klepai.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");
    let conv = chat_ready_conversation(&store);

    let big = import_skill(&skills, &store, &dir, "big", &"a".repeat(20 * 1024));
    let also_big = import_skill(&skills, &store, &dir, "also-big", &"b".repeat(20 * 1024));
    let small = import_skill(&skills, &store, &dir, "small", &"c".repeat(5 * 1024));
    for id in [big, also_big, small] {
        skills.set_enabled(&store, id, true).expect("enable");
    }

    let options = injected_prompt(&store, &skills, conv, None);
    let prompt = options.system_prompt.expect("skills block expected");

    // Order inside the library listing must not matter: the small skill
    // always fits, the two 20 KiB ones can never ride together, and the
    // injected total never crosses the cap.
    assert!(
        prompt.contains("### small"),
        "the small skill fits whatever the listing order"
    );
    let bigs_in = ["big", "also-big"]
        .iter()
        .filter(|name| prompt.contains(&format!("### {name}")))
        .count();
    assert_eq!(
        bigs_in, 1,
        "exactly one 20 KiB skill fits under the cap, the other is skipped"
    );
    let prompts = skills.enabled_prompts(&store).expect("prompts");
    let content_total: i64 = prompts.iter().map(|p| p.content.len() as i64).sum();
    assert_eq!(
        prompts.len(),
        2,
        "two skills ride; the one that would overflow is skipped"
    );
    assert!(
        content_total <= SIZE_CAP_BYTES,
        "the injected content never exceeds the cap"
    );
}

#[test]
fn a_disabled_skill_is_unavailable_and_an_enabled_one_shot_rides_on_one_request() {
    let dir = temp_dir("one-shot");
    let store = Store::open(&dir.join("klepai.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");
    let conv = chat_ready_conversation(&store);

    let invoked = import_skill(
        &skills,
        &store,
        &dir,
        "translator",
        "Translate every reply to Polish.",
    );

    // The toggle is OFF — invoking by name must be refused, before anything
    // is injected (the palette already hides it; this is the backend guard).
    let (_, _, mut options) = resolve_target(&store, conv).expect("target should resolve");
    let error = apply_skill_injection(&store, &skills, &mut options, Some(invoked))
        .expect_err("a disabled skill must not be invocable");
    assert!(
        error.to_string().contains("disabled"),
        "the error names the problem: {error}"
    );
    assert_eq!(
        options.system_prompt, None,
        "a refused invocation leaves the request untouched"
    );

    // Enabled again: the one-shot attaches…
    skills.set_enabled(&store, invoked, true).expect("enable");
    let options = injected_prompt(&store, &skills, conv, Some(invoked));
    let prompt = options.system_prompt.expect("one-shot block expected");
    assert!(
        prompt.contains("Translate every reply to Polish."),
        "an enabled invoked skill attaches to its one request"
    );

    // …and the NEXT send without an invocation carries no skill.
    let next = resolve_target(&store, conv).expect("target should resolve").2;
    assert_eq!(
        next.system_prompt, None,
        "the one-shot must not leak into the following request"
    );
}

#[test]
fn no_skills_in_play_leaves_the_system_prompt_untouched() {
    let dir = temp_dir("untouched");
    let store = Store::open(&dir.join("klepai.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");
    let conv = chat_ready_conversation(&store);

    // The UI-directives hint (issue #22) always rides on a request — the
    // assistant cannot trigger the rich elements without knowing the syntax.
    let options = injected_prompt(&store, &skills, conv, None);
    assert_eq!(
        options.system_prompt.as_deref(),
        Some(klepai_lib::commands::UI_DIRECTIVES_HINT),
        "no skills — only the UI hint rides along"
    );

    store
        .set_conversation_settings(conv, Some("You are terse."), None, None)
        .expect("settings should save");
    let options = injected_prompt(&store, &skills, conv, None);
    let prompt = options.system_prompt.expect("prompt expected");
    assert!(
        prompt.starts_with("You are terse.\n\n---\n\n")
            && prompt.ends_with(klepai_lib::commands::UI_DIRECTIVES_HINT),
        "the user prompt passes through first, the hint trails: {prompt}"
    );
}
