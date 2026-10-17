//! SkillStore — sole owner of the on-disk skill library.
//!
//! Deep module: import, listing, toggle, content read/write, delete and
//! size accounting all go through it; nothing else touches skill files.
//! Shaim never executes skill scripts — it only stores them and hands the
//! instruction text to the consumer at send time: the server-model system
//! prompt and the agent CLI prompt (see [`SkillPrompt`]).

use std::io::Read;
use std::path::{Path, PathBuf};

use zip::ZipArchive;

use crate::store::{Skill, Store, StoreError};

pub type Result<T> = std::result::Result<T, SkillError>;

/// Total content budget for *enabled* skills. Passing it is the owner's cue
/// to prune — the cap keeps request assembly from bloating system prompts,
/// and the Settings → Skills section surfaces the warning.
pub const SIZE_CAP_BYTES: i64 = 32 * 1024;

/// One skill's instructions as request assembly consumes them: what a
/// system prompt or an agent prompt receives (frontmatter stripped).
#[derive(Debug, Clone, PartialEq)]
pub struct SkillPrompt {
    pub name: String,
    pub content: String,
}

impl SkillStore {
    /// The enabled set, capped. Skills travel in listing order; one that
    /// would push the running total past [`SIZE_CAP_BYTES`] is skipped (a
    /// later smaller one can still fit). An unreadable library file skips
    /// that one skill rather than failing the whole send.
    pub fn enabled_prompts(&self, store: &Store) -> Result<Vec<SkillPrompt>> {
        let mut prompts = Vec::new();
        let mut total = 0i64;
        for skill in store.list_skills()?.into_iter().filter(|s| s.enabled) {
            if total + skill.size_bytes > SIZE_CAP_BYTES {
                continue;
            }
            let Ok(content) = self.content(store, skill.id) else {
                continue;
            };
            total += skill.size_bytes;
            prompts.push(SkillPrompt {
                name: skill.name,
                content,
            });
        }
        Ok(prompts)
    }

    /// One skill's instructions for a single-invocation attach. A DISABLED
    /// skill is unavailable everywhere — the palette hides it and this
    /// refuses it, so neither the user nor the assistant can reach it
    /// (owner decision, 2026-10-17).
    pub fn skill_prompt(&self, store: &Store, id: i64) -> Result<SkillPrompt> {
        let skill = store.get_skill(id)?;
        if !skill.enabled {
            return Err(SkillError::DisabledSkill(skill.name));
        }
        Ok(SkillPrompt {
            content: self.content(store, id)?,
            name: skill.name,
        })
    }
}

/// Formats prompts into the block that rides in a system/agent prompt.
/// Empty input yields an empty string — the caller then injects nothing.
pub fn prompt_block(prompts: &[SkillPrompt]) -> String {
    if prompts.is_empty() {
        return String::new();
    }
    let mut block =
        String::from("## Active skills\n\nFollow these instructions for this request:\n");
    for prompt in prompts {
        block.push_str(&format!("\n### {}\n\n{}\n", prompt.name, prompt.content.trim_end()));
    }
    block
}

/// Merges a skills block into an optional system prompt. An empty block
/// leaves the prompt untouched; otherwise the skills come after whatever
/// base prompt the user configured.
pub fn with_skill_block(base: Option<String>, block: &str) -> Option<String> {
    if block.is_empty() {
        return base;
    }
    Some(match base {
        Some(base) if !base.trim().is_empty() => format!("{}\n\n{}", base.trim_end(), block),
        _ => block.to_string(),
    })
}

#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error("the archive has no SKILL.md — a .skill package must contain a skill folder with SKILL.md")]
    NoSkillMd,
    #[error("a skill named “{0}” already exists")]
    DuplicateName(String),
    #[error("skill name cannot be empty")]
    EmptyName,
    #[error("skill “{0}” is disabled — enable it in Settings → Skills first")]
    DisabledSkill(String),
    #[error("unsupported skill file: {0} — import a .skill package or a .md file")]
    UnsupportedExtension(String),
    #[error("unreadable archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    Store(#[from] StoreError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// The library directory plus every file operation on it.
pub struct SkillStore {
    lib_dir: PathBuf,
}

impl SkillStore {
    /// Opens (creating as needed) the skill library directory.
    pub fn open(lib_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(lib_dir)?;
        Ok(Self {
            lib_dir: lib_dir.to_path_buf(),
        })
    }

    /// Imports a `.skill` package (a zip of a skill folder) or a `.md`
    /// instruction file into the library and records its metadata row.
    pub fn import(&self, store: &Store, source: &Path) -> Result<Skill> {
        let extension = source
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        match extension.as_str() {
            "skill" => self.import_package(store, source),
            "md" => self.import_markdown(store, source),
            other => Err(SkillError::UnsupportedExtension(other.to_string())),
        }
    }

    /// Copies a markdown instruction file into the library verbatim
    /// (frontmatter stays in the file; metadata is mirrored to the Store).
    fn import_markdown(&self, store: &Store, source: &Path) -> Result<Skill> {
        let raw = std::fs::read_to_string(source)?;
        let (frontmatter, body) = split_frontmatter(&raw);
        let fallback_name = source
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("skill");
        let name = frontmatter
            .and_then(|fm| frontmatter_field(fm, "name"))
            .unwrap_or_else(|| fallback_name.to_string());
        let description = frontmatter
            .and_then(|fm| frontmatter_field(fm, "description"))
            .unwrap_or_else(|| first_paragraph(body));

        let target = self.lib_dir.join(format!("{}.md", slugify(&name)));
        self.ensure_new(store, &name, &target)?;
        std::fs::write(&target, raw.as_bytes())?;
        Ok(store.create_skill(&name, &description, "markdown", &target, body.len() as i64)?)
    }

    /// Flips the global enable switch. Enabled skills are the only ones that
    /// ever reach server-model request assembly.
    pub fn set_enabled(&self, store: &Store, id: i64, enabled: bool) -> Result<()> {
        Ok(store.set_skill_enabled(id, enabled)?)
    }

    /// The file holding a skill's instructions: SKILL.md inside a package
    /// folder, the file itself for markdown skills.
    fn instruction_file(skill: &Skill) -> PathBuf {
        if skill.kind == "package" {
            PathBuf::from(&skill.path).join("SKILL.md")
        } else {
            PathBuf::from(&skill.path)
        }
    }

    /// The skill's instruction body (frontmatter stripped) — what the editor
    /// shows and what request assembly would append.
    pub fn content(&self, store: &Store, id: i64) -> Result<String> {
        let skill = store.get_skill(id)?;
        let raw = std::fs::read_to_string(Self::instruction_file(&skill))?;
        let (_, body) = split_frontmatter(&raw);
        Ok(body.to_string())
    }

    /// Saves an edited body back to the library file, keeping the file's
    /// frontmatter byte-for-byte, and updates the size accounting.
    pub fn save_content(&self, store: &Store, id: i64, body: &str) -> Result<()> {
        let skill = store.get_skill(id)?;
        let file = Self::instruction_file(&skill);
        let raw = std::fs::read_to_string(&file)?;
        let (frontmatter, _) = split_frontmatter(&raw);
        let updated = match frontmatter {
            Some(frontmatter) => format!("---\n{frontmatter}---\n\n{body}"),
            None => body.to_string(),
        };
        std::fs::write(&file, updated.as_bytes())?;
        store.update_skill_size(id, body.len() as i64)?;
        Ok(())
    }

    /// Renames a skill: rewrites the `name:` frontmatter line in place
    /// (every other line stays byte-for-byte) and updates the store row.
    /// The library folder keeps its slug — paths stay stable.
    pub fn rename(&self, store: &Store, id: i64, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(SkillError::EmptyName);
        }
        if store
            .list_skills()?
            .iter()
            .any(|skill| skill.id != id && skill.name == name)
        {
            return Err(SkillError::DuplicateName(name.to_string()));
        }
        let skill = store.get_skill(id)?;
        let file = Self::instruction_file(&skill);
        let raw = std::fs::read_to_string(&file)?;
        let (frontmatter, body) = split_frontmatter(&raw);
        let updated = match frontmatter {
            Some(frontmatter) => {
                let frontmatter = replace_frontmatter_field(frontmatter, "name", name);
                format!("---\n{frontmatter}---\n\n{body}")
            }
            // No frontmatter yet — add a minimal block so the name sticks.
            None => format!("---\nname: {name}\n---\n\n{raw}"),
        };
        std::fs::write(&file, updated.as_bytes())?;
        store.rename_skill(id, name)?;
        Ok(())
    }

    /// Deletes a skill: metadata row plus the library files themselves
    /// (the whole folder for packages, the single file for markdown skills).
    pub fn delete(&self, store: &Store, id: i64) -> Result<()> {
        let skill = store.get_skill(id)?;
        let path = PathBuf::from(&skill.path);
        if skill.kind == "package" {
            std::fs::remove_dir_all(path)?;
        } else {
            std::fs::remove_file(path)?;
        }
        store.delete_skill(id)?;
        Ok(())
    }

    /// Total content bytes of the *enabled* set — what the Settings cap
    /// warning watches. Frontmatter never counts (it is not injected).
    pub fn enabled_total_size(&self, store: &Store) -> Result<i64> {
        Ok(store.enabled_skill_size()?)
    }

    fn import_package(&self, store: &Store, source: &Path) -> Result<Skill> {
        let file = std::fs::File::open(source)?;
        let mut archive = ZipArchive::new(file)?;

        // Collect the file entries up front so SKILL.md can sit at the
        // archive root or inside one top-level folder.
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let raw_name = entry.name()?.to_string();
            if entry.is_dir() || raw_name.ends_with('/') || !is_safe_entry_name(&raw_name) {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            entries.push((raw_name.trim_start_matches("./").to_string(), bytes));
        }

        // Root SKILL.md wins; otherwise one exactly one folder deep.
        let prefix = entries
            .iter()
            .find(|(name, _)| name == "SKILL.md")
            .map(|_| String::new())
            .or_else(|| {
                entries.iter().find_map(|(name, _)| {
                    name.strip_suffix("/SKILL.md")
                        .filter(|folder| !folder.contains('/'))
                        .map(|folder| format!("{folder}/"))
                })
            })
            .ok_or(SkillError::NoSkillMd)?;

        let skill_md = &entries
            .iter()
            .find(|(name, _)| *name == format!("{prefix}SKILL.md"))
            .expect("prefix exists only because SKILL.md was found")
            .1;
        let text = String::from_utf8_lossy(skill_md);
        let (frontmatter, body) = split_frontmatter(&text);

        // Name fallback: the folder the zip wrapped, else the file's stem.
        let wrapped_folder = prefix.trim_end_matches('/');
        let fallback_name = if wrapped_folder.is_empty() {
            source
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("skill")
        } else {
            wrapped_folder
        };
        let name = frontmatter
            .and_then(|fm| frontmatter_field(fm, "name"))
            .unwrap_or_else(|| fallback_name.to_string());
        let description = frontmatter
            .and_then(|fm| frontmatter_field(fm, "description"))
            .unwrap_or_default();

        let target = self.lib_dir.join(slugify(&name));
        self.ensure_new(store, &name, &target)?;

        std::fs::create_dir_all(&target)?;
        for (entry_name, bytes) in &entries {
            let Some(relative) = entry_name.strip_prefix(&prefix) else {
                continue;
            };
            if relative.is_empty() {
                continue;
            }
            let destination = target.join(relative);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(destination, bytes)?;
        }

        Ok(store.create_skill(&name, &description, "package", &target, body.len() as i64)?)
    }
}

/// Rejects entries that would write outside the library folder (zip-slip).
fn is_safe_entry_name(name: &str) -> bool {
    !name.starts_with('/') && !name.split('/').any(|part| part == "..")
}

impl SkillStore {
    /// Imports never overwrite: an existing name — or its library slot —
    /// fails with a clear error instead of clobbering the import.
    fn ensure_new(&self, store: &Store, name: &str, target: &Path) -> Result<()> {
        let taken = store.list_skills()?.iter().any(|skill| skill.name == name)
            || target.exists();
        if taken {
            return Err(SkillError::DuplicateName(name.to_string()));
        }
        Ok(())
    }
}

/// Splits an optional `---` YAML frontmatter block off the front of a
/// markdown document. Returns (frontmatter text without fences, body).
fn split_frontmatter(raw: &str) -> (Option<&str>, &str) {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return (None, raw);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\n', '\r']) == "---" {
            // One blank line after the closing fence is the separator, not
            // body content.
            let body = rest[offset + line.len()..].strip_prefix('\n').unwrap_or(&rest[offset + line.len()..]);
            return (Some(&rest[..offset]), body);
        }
        offset += line.len();
    }
    // No closing fence — the whole document is the body.
    (None, raw)
}

/// Reads one `key: value` (or `key: "value"`) line out of frontmatter text.
fn frontmatter_field(frontmatter: &str, key: &str) -> Option<String> {
    frontmatter.lines().find_map(|line| {
        let (field, value) = line.split_once(':')?;
        if field.trim() != key {
            return None;
        }
        let value = value.trim().trim_matches(['"', '\'']);
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Rewrites one `key: value` line in frontmatter text, keeping every other
/// line as-is (appending the key when it was missing).
fn replace_frontmatter_field(frontmatter: &str, key: &str, value: &str) -> String {
    let mut out = String::new();
    let mut replaced = false;
    for line in frontmatter.lines() {
        let matches = line
            .split_once(':')
            .is_some_and(|(field, _)| field.trim() == key);
        if matches {
            out.push_str(&format!("{key}: {value}\n"));
            replaced = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !replaced {
        out.push_str(&format!("{key}: {value}\n"));
    }
    out
}

/// First non-empty body paragraph, lines joined; capped at 200 characters
/// (cut at the last word boundary with an ellipsis when truncated).
fn first_paragraph(body: &str) -> String {
    let mut paragraph = String::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(line);
    }
    if paragraph.chars().count() > 200 {
        let truncated: String = paragraph.chars().take(200).collect();
        let cut = truncated.rfind(' ').unwrap_or(200);
        return format!("{}…", &truncated[..cut]);
    }
    paragraph
}

/// Library folder/file name for a skill: lowercase ASCII letters and digits,
/// separators collapsed to single dashes.
fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch.is_whitespace() || ch == '-' || ch == '_')
            && !slug.is_empty()
            && !slug.ends_with('-')
        {
            slug.push('-');
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed.to_string()
    }
}
