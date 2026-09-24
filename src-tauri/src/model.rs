//! Core data types shared between the Rust core and the webview.
//!
//! Everything here is serialised with `camelCase` field names so the
//! JavaScript side can use idiomatic property access without a mapping layer.

use serde::{Deserialize, Serialize};

/// A single note.
///
/// `body` holds the editor's HTML verbatim so round-tripping is lossless.
/// `plain` is a cached text-only projection of that HTML, maintained by the
/// frontend. Keeping it on disk means search, previews and word counts never
/// have to re-parse markup, and it lets [`crate::search`] work on plain text.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub plain: String,
    pub pinned: bool,
    pub trashed: bool,
    pub tags: Vec<String>,
    /// Per-note font override; empty string means "use the theme's font".
    pub font: String,
    pub created: i64,
    pub updated: i64,
    /// Set when the note is moved to the trash, so we can auto-purge later.
    pub trashed_at: i64,
}

impl Note {
    /// First `limit` characters of the plain-text body, with runs of
    /// whitespace collapsed so list/preview text reads cleanly.
    pub fn preview(&self, limit: usize) -> String {
        let mut out = String::with_capacity(limit + 4);
        let mut last_was_space = false;
        let mut count = 0;

        for ch in self.plain.chars() {
            if count >= limit {
                break;
            }
            if ch.is_whitespace() {
                if !last_was_space && !out.is_empty() {
                    out.push(' ');
                    count += 1;
                }
                last_was_space = true;
            } else {
                out.push(ch);
                last_was_space = false;
                count += 1;
            }
        }

        if count >= limit {
            out.push('…');
        }
        out.trim_end().to_string()
    }

    /// Title to show in the UI, falling back to the first line of the body and
    /// finally to "Untitled", mirroring how notes read in most editors.
    pub fn display_title(&self) -> String {
        let title = self.title.trim();
        if !title.is_empty() {
            return title.to_string();
        }
        let from_body: String = self
            .plain
            .trim()
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .chars()
            .take(60)
            .collect();
        if from_body.is_empty() {
            "Untitled".to_string()
        } else {
            from_body
        }
    }
}

/// How the sidebar orders notes. Pinned notes always sort above unpinned ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SortMode {
    /// Drag-and-drop order, as stored in the notes array.
    Manual,
    #[default]
    Updated,
    Created,
    Title,
    /// Longest notes first.
    Size,
}

/// A note's tags, de-duplicated, trimmed, and lowercased for stable matching.
pub fn normalise_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let cleaned = tag.trim().trim_start_matches('#').to_lowercase();
        if cleaned.is_empty() || cleaned.chars().count() > 32 {
            continue;
        }
        if !out.contains(&cleaned) {
            out.push(cleaned);
        }
    }
    out.truncate(12);
    out
}
