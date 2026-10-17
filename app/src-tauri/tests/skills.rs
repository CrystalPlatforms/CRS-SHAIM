//! SkillStore integration tests (#17 import & persistence, #18 management).
//!
//! Assumptions these tests encode:
//! - A `.skill` file is a zip of a skill folder; `SKILL.md` may sit at the
//!   archive root or inside one top-level folder. Side files are copied
//!   as-is — Shaim never executes them, it only stores them.
//! - Name/description come from YAML frontmatter (`name`, `description`
//!   keys), falling back to the file/folder name + first body paragraph
//!   (capped at 200 chars).
//! - The library lives in its own directory (simulating the app-data dir);
//!   metadata rows live in the Store. "Restart" is simulated by dropping
//!   both and reopening — the app process itself is not spawned.
//! - Importing a skill whose name already exists fails with a clear error;
//!   nothing is overwritten.
//! - The size cap (32 KiB) applies to the SUM of *enabled* skill content
//!   bodies — frontmatter is metadata, not injected content.
//!
//! Injection into requests lives in `tests/skills_injection.rs` (S3/S4); the
//! Settings UI itself stays at component level.

use std::io::Write;
use std::path::{Path, PathBuf};

use shaim_lib::skills::SkillStore;
use shaim_lib::store::Store;

/// Unique per-test temp dir; cleared before the run so leftovers never
/// interfere.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "shaim-skills-tests-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir should be creatable");
    dir
}

/// Builds a zip fixture at `path` from (entry name, text content) pairs.
fn write_zip(path: &Path, entries: &[(&str, &str)]) {
    let file = std::fs::File::create(path).expect("fixture zip should be creatable");
    let mut zip = zip::ZipWriter::new(file);
    for (name, content) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .expect("zip entry should start");
        zip.write_all(content.as_bytes()).expect("zip entry should write");
    }
    zip.finish().expect("fixture zip should finish");
}

#[test]
fn a_markdown_skill_without_frontmatter_falls_back_to_filename_and_first_paragraph() {
    let dir = temp_dir("markdown-fallback");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let source = dir.join("greeting.md");
    std::fs::write(
        &source,
        "Greeting protocol\nsay hello warmly and keep it short.\n\n## Details\n\nMore text.",
    )
    .expect("fixture should write");

    let skill = skills.import(&store, &source).expect("import should succeed");

    // Name from the file stem; description from the first paragraph — the
    // block of text before the first blank line, its lines joined.
    assert_eq!(skill.name, "greeting");
    assert_eq!(skill.description, "Greeting protocol say hello warmly and keep it short.");
}

#[test]
fn an_overlong_first_paragraph_is_truncated_at_a_word_boundary() {
    let dir = temp_dir("markdown-cap");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let long_words = "word ".repeat(60); // 300 chars, no risk of a lucky fit
    let source = dir.join("wall-of-text.md");
    std::fs::write(&source, &long_words).expect("fixture should write");

    let skill = skills.import(&store, &source).expect("import should succeed");

    assert!(skill.description.chars().count() <= 200, "capped at 200 chars");
    assert!(skill.description.ends_with('…'), "truncation is marked");
}

#[test]
fn a_zip_without_skill_md_fails_with_a_clear_error() {
    let dir = temp_dir("no-skill-md");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let package = dir.join("broken.skill");
    write_zip(&package, &[("README.md", "not a skill")]);

    let error = skills
        .import(&store, &package)
        .expect_err("an archive without SKILL.md must not import");

    assert!(
        error.to_string().contains("SKILL.md"),
        "error should name the missing file, got: {error}"
    );
    assert!(
        store.list_skills().expect("list should succeed").is_empty(),
        "a failed import leaves no metadata row"
    );
}

#[test]
fn a_package_wrapped_in_a_folder_is_found_one_level_deep() {
    let dir = temp_dir("wrapped-package");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let package = dir.join("wrapped.skill");
    write_zip(
        &package,
        &[
            (
                "code-review/SKILL.md",
                "---\nname: Code review\ndescription: Review habits for pull requests\n---\n\nReview body.",
            ),
            ("code-review/assets/rubric.md", "Criteria."),
        ],
    );

    let skill = skills.import(&store, &package).expect("import should succeed");

    assert_eq!(skill.name, "Code review");
    let skill_dir = PathBuf::from(&skill.path);
    assert!(skill_dir.join("SKILL.md").exists());
    assert!(skill_dir.join("assets/rubric.md").exists());
}

#[test]
fn library_files_and_metadata_survive_a_simulated_restart() {
    let dir = temp_dir("restart");
    let package = dir.join("cooler-master.skill");
    write_zip(
        &package,
        &[
            (
                "SKILL.md",
                "---\nname: Cooler Master\ndescription: Legacy cooler reference sheets\n---\n\nReference body.",
            ),
            ("reference.md", "Hyper 212"),
        ],
    );

    // First launch: import, then drop everything the way app shutdown would.
    {
        let store = Store::open(&dir.join("shaim.db")).expect("store should open");
        let skills = SkillStore::open(&dir.join("skills")).expect("library should open");
        skills.import(&store, &package).expect("import should succeed");
    }

    // Second launch: the row and the files are still there.
    let store = Store::open(&dir.join("shaim.db")).expect("reopen should succeed");
    let rows = store.list_skills().expect("list should succeed");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Cooler Master");
    let stored =
        std::fs::read_to_string(PathBuf::from(&rows[0].path).join("SKILL.md")).expect("file survives");
    assert!(stored.contains("Reference body."));
}

#[test]
fn toggling_enabled_flips_the_store_and_survives_restart() {
    let dir = temp_dir("toggle-restart");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let source = dir.join("release-checklist.md");
    std::fs::write(&source, "# Checklist\n\nBump, test, tag.").expect("fixture should write");
    let skill = skills.import(&store, &source).expect("import should succeed");
    assert!(!skill.enabled, "skills ship disabled");

    skills
        .set_enabled(&store, skill.id, true)
        .expect("enabling should succeed");

    // Restart: the enabled flag is a persisted property, not UI state.
    drop(store);
    let store = Store::open(&dir.join("shaim.db")).expect("reopen should succeed");
    let rows = store.list_skills().expect("list should succeed");
    assert!(rows[0].enabled, "enabled flag survives a restart");
}

#[test]
fn editing_saves_the_body_and_preserves_frontmatter() {
    let dir = temp_dir("edit-body");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let source = dir.join("release-checklist.md");
    std::fs::write(
        &source,
        "---\nname: Release checklist\ndescription: Steps before tagging\n---\n\n1. Bump the version.\n",
    )
    .expect("fixture should write");
    let skill = skills.import(&store, &source).expect("import should succeed");

    // Reading hands the editor the body only — frontmatter is metadata.
    let content = skills.content(&store, skill.id).expect("content should read");
    assert_eq!(content, "1. Bump the version.\n");

    skills
        .save_content(&store, skill.id, "1. Bump the version.\n2. Run the suite.\n")
        .expect("save should succeed");

    // The file keeps its frontmatter verbatim and carries the new body.
    let stored = std::fs::read_to_string(&skill.path).expect("library file should exist");
    assert!(stored.starts_with("---\nname: Release checklist\ndescription: Steps before tagging\n---\n"));
    assert!(stored.contains("2. Run the suite."));

    // Size accounting follows the edit (the cap watches enabled content).
    let updated = store.get_skill(skill.id).expect("row should exist");
    assert_eq!(updated.size_bytes, "1. Bump the version.\n2. Run the suite.\n".len() as i64);
}

#[test]
fn delete_removes_metadata_and_library_files() {
    let dir = temp_dir("delete");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    // One package (a folder) and one markdown skill (a file).
    let package = dir.join("cooler-master.skill");
    write_zip(
        &package,
        &[("SKILL.md", "---\nname: Cooler Master\n---\n\nBody.")],
    );
    let packaged = skills.import(&store, &package).expect("import should succeed");
    let markdown = dir.join("notes.md");
    std::fs::write(&markdown, "Plain notes.").expect("fixture should write");
    let noted = skills.import(&store, &markdown).expect("import should succeed");

    skills.delete(&store, packaged.id).expect("delete should succeed");
    skills.delete(&store, noted.id).expect("delete should succeed");

    assert!(store.list_skills().expect("list should succeed").is_empty());
    assert!(!PathBuf::from(packaged.path).exists(), "package folder is gone");
    assert!(!PathBuf::from(noted.path).exists(), "markdown file is gone");
}

#[test]
fn enabled_size_accounts_only_for_enabled_skills() {
    let dir = temp_dir("size-accounting");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let first = dir.join("first.md");
    std::fs::write(&first, "First body.").expect("fixture should write");
    let small = skills.import(&store, &first).expect("import should succeed");
    let second = dir.join("second.md");
    std::fs::write(&second, "Second body.").expect("fixture should write");
    let large = skills.import(&store, &second).expect("import should succeed");

    assert_eq!(
        skills.enabled_total_size(&store).expect("size should compute"),
        0,
        "nothing enabled yet"
    );

    skills.set_enabled(&store, small.id, true).expect("enable");
    assert_eq!(
        skills.enabled_total_size(&store).expect("size should compute"),
        "First body.".len() as i64
    );

    skills.set_enabled(&store, large.id, true).expect("enable");
    assert_eq!(
        skills.enabled_total_size(&store).expect("size should compute"),
        ("First body.".len() + "Second body.".len()) as i64
    );

    // The cap constant is the owner's chosen budget: 32 KiB.
    assert_eq!(shaim_lib::skills::SIZE_CAP_BYTES, 32 * 1024);
}

#[test]
fn editing_a_package_skill_reads_and_writes_its_skill_md() {
    let dir = temp_dir("edit-package");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let package = dir.join("cooler-master.skill");
    write_zip(
        &package,
        &[(
            "SKILL.md",
            "---\nname: Cooler Master\ndescription: Legacy sheets\n---\n\nOld body.",
        )],
    );
    let skill = skills.import(&store, &package).expect("import should succeed");

    // The editor shows the SKILL.md body — not the folder (the old bug:
    // reading the folder path itself fails).
    let content = skills.content(&store, skill.id).expect("content should read");
    assert_eq!(content, "Old body.");

    skills
        .save_content(&store, skill.id, "New body.")
        .expect("save should succeed");

    let stored =
        std::fs::read_to_string(PathBuf::from(&skill.path).join("SKILL.md")).expect("SKILL.md exists");
    assert!(stored.contains("New body."));
    assert!(stored.starts_with("---\nname: Cooler Master\n"), "frontmatter kept");
}

#[test]
fn renaming_updates_the_file_frontmatter_and_the_store_row() {
    let dir = temp_dir("rename");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let package = dir.join("cooler-master.skill");
    write_zip(
        &package,
        &[(
            "SKILL.md",
            "---\nname: Cooler Master\ndescription: Legacy sheets\n---\n\nBody.",
        )],
    );
    let skill = skills.import(&store, &package).expect("import should succeed");

    skills
        .rename(&store, skill.id, "Cooler Master XT")
        .expect("rename should succeed");

    // The store row carries the new name…
    let row = store.get_skill(skill.id).expect("row should exist");
    assert_eq!(row.name, "Cooler Master XT");
    assert_eq!(row.description, "Legacy sheets", "description untouched");

    // …and the file's frontmatter `name:` line was rewritten in place.
    let stored =
        std::fs::read_to_string(PathBuf::from(&skill.path).join("SKILL.md")).expect("SKILL.md exists");
    assert!(stored.contains("name: Cooler Master XT"));
    assert!(stored.contains("description: Legacy sheets"), "other lines kept");
    assert!(stored.contains("Body."));

    // Renaming onto an existing name fails clearly instead of merging.
    let second = dir.join("notes.md");
    std::fs::write(&second, "Notes.").expect("fixture should write");
    let other = skills.import(&store, &second).expect("import should succeed");
    let error = skills
        .rename(&store, other.id, "Cooler Master XT")
        .expect_err("duplicate rename must fail");
    assert!(error.to_string().contains("already exists"), "got: {error}");
}

#[test]
fn importing_a_markdown_skill_parses_frontmatter_metadata() {
    let dir = temp_dir("markdown-frontmatter");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let source = dir.join("release-checklist.md");
    std::fs::write(
        &source,
        "---\nname: Release checklist\ndescription: Steps before tagging a Shaim release\n---\n\n1. Bump the version.\n2. Run the suite.\n",
    )
    .expect("fixture should write");

    let skill = skills.import(&store, &source).expect("import should succeed");

    assert_eq!(skill.name, "Release checklist");
    assert_eq!(skill.description, "Steps before tagging a Shaim release");
    assert_eq!(skill.kind, "markdown");
    assert!(!skill.enabled);

    // The library file is a verbatim copy of the source, frontmatter included.
    let stored = std::fs::read_to_string(&skill.path).expect("library file should exist");
    assert!(stored.contains("name: Release checklist"));
    assert!(stored.contains("1. Bump the version."));
}

#[test]
fn importing_a_skill_package_creates_library_folder_and_metadata_row() {
    let dir = temp_dir("tracer-package");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    let package = dir.join("cooler-master.skill");
    write_zip(
        &package,
        &[
            (
                "SKILL.md",
                "---\nname: Cooler Master\ndescription: Legacy cooler reference sheets\n---\n\n# Cooler Master\n\nReference body.",
            ),
            ("reference.md", "## Coolers\n\n- Hyper 212"),
        ],
    );

    let skill = skills.import(&store, &package).expect("import should succeed");

    assert_eq!(skill.name, "Cooler Master");
    assert_eq!(skill.description, "Legacy cooler reference sheets");
    assert_eq!(skill.kind, "package");
    // Skills ship disabled — enabling is an explicit owner decision.
    assert!(!skill.enabled);

    // The library folder holds SKILL.md plus the side file, byte-for-byte.
    let skill_dir = PathBuf::from(&skill.path);
    let stored = std::fs::read_to_string(skill_dir.join("SKILL.md")).expect("SKILL.md should exist");
    assert!(stored.contains("Reference body."));
    let side = std::fs::read_to_string(skill_dir.join("reference.md")).expect("side file should exist");
    assert!(side.contains("Hyper 212"));

    // Metadata landed in the Store, not just on disk.
    let rows = store.list_skills().expect("list should succeed");
    assert_eq!(rows.len(), 1, "exactly one metadata row after one import");
    assert_eq!(rows[0].id, skill.id);
    assert_eq!(rows[0].name, "Cooler Master");
    assert_eq!(rows[0].kind, "package");
}
