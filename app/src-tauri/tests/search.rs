//! Full-text search across conversations (issue #10).
//!
//! Assumptions these tests encode:
//! - The FTS5 index is kept in sync purely by triggers, so it stays correct
//!   through edits and deletes without any explicit maintenance call.
//! - Terms are ANDed and matched as prefixes ("zebr" hits "zebra"); every
//!   term is quoted, so user input can never inject FTS syntax.
//! - Hits carry conversation context (title) so the UI can jump to them.
//! - A 10 000-message corpus answers a full-text query in well under 200 ms.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use shaim_lib::store::Store;

fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "shaim-search-tests-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("shaim.db")
}

fn open(name: &str) -> Store {
    Store::open(&temp_db(name)).expect("store should open")
}

// ---- Correctness -------------------------------------------------------------

#[test]
fn search_finds_hits_with_conversation_context() {
    let store = open("search-context");
    let conv = store.create_conversation(Some("Otter research")).unwrap();
    let target = store
        .insert_message(conv.id, "user", "the swift brown otter jumps")
        .unwrap();
    let other = store.create_conversation(Some("Unrelated")).unwrap();
    store
        .insert_message(other.id, "user", "grocery list: apples")
        .unwrap();

    let hits = store.search("otter", 50).unwrap();
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    assert_eq!(hit.message_id, target);
    assert_eq!(hit.conversation_id, conv.id);
    assert_eq!(hit.conversation_title, "Otter research");
    assert_eq!(hit.role, "user");
    assert!(hit.snippet.contains("otter"), "snippet: {}", hit.snippet);

    // The unrelated conversation never shows up.
    let hits = store.search("apples", 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].conversation_id, other.id);
}

#[test]
fn search_matches_prefixes_and_ands_terms() {
    let store = open("search-prefix");
    let conv = store.create_conversation(None).unwrap();
    store
        .insert_message(conv.id, "user", "kernel panics are fun")
        .unwrap();
    store
        .insert_message(conv.id, "user", "pancake recipes")
        .unwrap();

    // Prefix match: "pan" hits both panic and pancake.
    let hits = store.search("pan", 50).unwrap();
    assert_eq!(hits.len(), 2);

    // Terms are ANDed: only the panic message has both.
    let hits = store.search("kernel pan", 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].snippet.contains("kernel"));
}

#[test]
fn search_index_stays_correct_after_edit_and_delete() {
    let store = open("search-edit-delete");
    let conv = store.create_conversation(None).unwrap();
    let message = store
        .insert_message(conv.id, "user", "quantum flux capacitor notes")
        .unwrap();

    // Edit: the old text disappears from the index, the new text appears.
    store
        .update_message_content(message, "steam engine notes")
        .unwrap();
    let hits = store.search("flux", 50).unwrap();
    assert!(hits.iter().all(|hit| hit.message_id != message));
    let hits = store.search("steam", 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id, message);

    // Delete: the hit is gone from the index entirely.
    store.delete_message(message).unwrap();
    let hits = store.search("steam", 50).unwrap();
    assert!(hits.is_empty(), "deleted message must leave the index");

    // Deleting a whole conversation cascades to the index too.
    let conv2 = store.create_conversation(None).unwrap();
    store
        .insert_message(conv2.id, "user", "unique xylophone melody")
        .unwrap();
    assert_eq!(store.search("xylophone", 50).unwrap().len(), 1);
    store.delete_conversation(conv2.id).unwrap();
    assert!(store.search("xylophone", 50).unwrap().is_empty());
}

#[test]
fn search_of_hostile_or_empty_input_never_errors() {
    let store = open("search-hostile");
    let conv = store.create_conversation(None).unwrap();
    store
        .insert_message(conv.id, "user", "plain words only")
        .unwrap();

    // FTS syntax in user input must be inert, not a 500 or a panic.
    for hostile in [
        "\" OR 1=1 --",
        "plain NEAR words",
        "(* AND *)",
        "plain",
        "",
        "   ",
    ] {
        let hits = store.search(hostile, 50);
        assert!(hits.is_ok(), "query {hostile:?} must not error");
        if hostile == "plain" {
            assert_eq!(hits.unwrap().len(), 1);
        }
    }
}

// ---- Performance ---------------------------------------------------------------

#[test]
fn search_over_10k_messages_returns_correct_hits_under_200ms() {
    let store = open("search-performance");
    let conv = store.create_conversation(Some("Bulk corpus")).unwrap();
    let needle_ids: Vec<i64> = (0..100)
        .map(|index| {
            store
                .insert_message(
                    conv.id,
                    "user",
                    &format!("pangram zebra checkpoint {index}"),
                )
                .unwrap()
        })
        .collect();
    // Fill to 10 000 messages with filler that never matches the needle.
    for index in 0..9_900usize {
        store
            .insert_message(conv.id, "assistant", &format!("filler row {index} lorem ipsum dolor"))
            .unwrap();
    }

    let start = Instant::now();
    let hits = store.search("zebra", 50).unwrap();
    let elapsed = start.elapsed();

    assert!(
        elapsed < Duration::from_millis(200),
        "full-text query over 10 000 messages took {elapsed:?}, budget is 200 ms"
    );
    // Correct hits, best-first, capped by the limit.
    assert_eq!(hits.len(), 50);
    assert!(hits
        .iter()
        .all(|hit| needle_ids.contains(&hit.message_id)));
    assert_eq!(hits[0].conversation_title, "Bulk corpus");
}
