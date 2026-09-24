//! Ranked full-text search over the note collection.
//!
//! The query language is deliberately tiny but genuinely useful:
//!
//! * bare words are AND-ed together
//! * `"two words"` matches a phrase
//! * `#tag` (or `tag:work`) requires a tag
//! * `-word` / `-#tag` excludes
//!
//! Matching is case-insensitive. Ranking favours titles over bodies, earlier
//! matches over later ones, and recent notes over stale ones, which is the
//! ordering that tends to feel right in a notes list.

use serde::{Deserialize, Serialize};

use crate::model::Note;

/// A matching note, ready to render.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub score: i32,
    /// A window of body text around the first match, for the sidebar preview.
    pub snippet: String,
}

/// One parsed element of a query.
#[derive(Debug, Clone)]
enum Term {
    /// A word or phrase that must appear in the title or body.
    Text(String),
    /// A tag the note must carry.
    Tag(String),
}

/// What the user typed, after parsing.
#[derive(Debug, Clone, Default)]
struct Query {
    required: Vec<Term>,
    excluded: Vec<String>,
}

impl Query {
    fn is_empty(&self) -> bool {
        self.required.is_empty() && self.excluded.is_empty()
    }

    /// Parse a raw query string. Unbalanced quotes are treated as literal text
    /// rather than an error, so the results update smoothly while typing.
    fn parse(raw: &str) -> Self {
        let mut query = Query::default();
        let mut chars = raw.chars().peekable();

        while let Some(&ch) = chars.peek() {
            if ch.is_whitespace() {
                chars.next();
                continue;
            }

            let negated = ch == '-';
            if negated {
                chars.next();
            }

            // Consume one token: either a quoted phrase or a run of non-spaces.
            let mut token = String::new();
            if chars.peek() == Some(&'"') {
                chars.next();
                for c in chars.by_ref() {
                    if c == '"' {
                        break;
                    }
                    token.push(c);
                }
            } else {
                for c in chars.by_ref() {
                    if c.is_whitespace() {
                        break;
                    }
                    token.push(c);
                }
            }

            let token = token.trim().to_lowercase();
            if token.is_empty() {
                continue;
            }

            if negated {
                query
                    .excluded
                    .push(token.trim_start_matches('#').to_string());
                continue;
            }

            if let Some(tag) = token
                .strip_prefix('#')
                .or_else(|| token.strip_prefix("tag:"))
            {
                if !tag.is_empty() {
                    query.required.push(Term::Tag(tag.to_string()));
                }
            } else {
                query.required.push(Term::Text(token));
            }
        }

        query
    }
}

/// Score one note against a parsed query. `None` means "does not match".
fn score(note: &Note, query: &Query, now: i64) -> Option<i32> {
    let title = note.title.to_lowercase();
    let plain = note.plain.to_lowercase();
    let tags: Vec<String> = note.tags.iter().map(|t| t.to_lowercase()).collect();

    let mut total: i32 = 0;

    for term in &query.required {
        match term {
            Term::Tag(wanted) => {
                if !tags.iter().any(|t| t == wanted) {
                    return None;
                }
                // Tag matches are strong signals about intent.
                total += 900;
            }
            Term::Text(needle) => {
                let in_title = title.contains(needle.as_str());
                let body_hits = count_occurrences(&plain, needle);

                if !in_title && body_hits == 0 {
                    return None;
                }

                if in_title {
                    total += 600;
                    // A title that *starts* with the query is almost always
                    // the note the user means.
                    if title.starts_with(needle.as_str()) {
                        total += 400;
                    }
                    if title == *needle {
                        total += 800;
                    }
                }
                // Diminishing returns, so a long note can't win on sheer length.
                total += (body_hits.min(20) as i32) * 25;
            }
        }
    }

    for term in &query.excluded {
        if title.contains(term.as_str()) || plain.contains(term.as_str()) {
            return None;
        }
    }

    // Recency is a tiebreaker only: at most ~30 points, decaying over a month.
    let age_days = ((now - note.updated).max(0) as f64 / 86_400_000.0).min(30.0);
    total += (30.0 - age_days) as i32;

    Some(total)
}

/// Number of (possibly overlapping) occurrences of `needle` in `haystack`.
fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.matches(needle).count()
}

/// Build a preview window centred on the first match of any required text
/// term, so the sidebar can show *why* a note matched.
fn build_snippet(note: &Note, query: &Query, budget: usize) -> String {
    let plain = &note.plain;

    // With no text terms there is nothing to centre on; show the top.
    let anchor = query.required.iter().find_map(|term| match term {
        Term::Text(needle) => find_char_index(&plain.to_lowercase(), needle),
        Term::Tag(_) => None,
    });

    let chars: Vec<char> = plain.chars().collect();
    if chars.is_empty() {
        return String::new();
    }

    let Some(anchor) = anchor else {
        return note.preview(budget);
    };

    // Start a little before the match for context, without going negative.
    let context = budget / 4;
    let start = anchor.saturating_sub(context);
    let end = (start + budget).min(chars.len());

    let mut out = String::with_capacity(budget + 4);
    if start > 0 {
        out.push('…');
    }
    let slice: String = chars[start..end].iter().collect();
    out.push_str(&collapse_whitespace(&slice));
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Character index of the first occurrence of `needle` in `haystack`.
///
/// Both are expected to already be lowercase. `to_lowercase` occasionally
/// changes a string's character count, so the mapping from a byte offset in
/// the folded text back onto the original is a close approximation rather
/// than an exact one — good enough to centre a preview window, and it can
/// never panic or split a character.
fn find_char_index(haystack_lower: &str, needle: &str) -> Option<usize> {
    let byte_offset = haystack_lower.find(needle)?;
    Some(haystack_lower[..byte_offset].chars().count())
}

/// Collapse runs of whitespace so previews read as one tidy line.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

/// Run a query over `notes`, returning matches best-first.
///
/// `now` is injected so results are deterministic in tests.
pub fn run(notes: &[Note], raw_query: &str, now: i64) -> Vec<SearchHit> {
    let query = Query::parse(raw_query);
    if query.is_empty() {
        return Vec::new();
    }

    let mut hits: Vec<SearchHit> = notes
        .iter()
        .filter(|note| !note.trashed)
        .filter_map(|note| {
            let score = score(note, &query, now)?;
            Some(SearchHit {
                id: note.id.clone(),
                score,
                snippet: build_snippet(note, &query, 90),
            })
        })
        .collect();

    // Highest score first; ties broken by recency for a stable, sensible order.
    hits.sort_by(|a, b| {
        let by_score = b.score.cmp(&a.score);
        if by_score != std::cmp::Ordering::Equal {
            return by_score;
        }
        let a_updated = notes
            .iter()
            .find(|n| n.id == a.id)
            .map(|n| n.updated)
            .unwrap_or(0);
        let b_updated = notes
            .iter()
            .find(|n| n.id == b.id)
            .map(|n| n.updated)
            .unwrap_or(0);
        b_updated.cmp(&a_updated)
    });

    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, title: &str, plain: &str) -> Note {
        Note {
            id: id.into(),
            title: title.into(),
            plain: plain.into(),
            updated: 1_000_000,
            tags: Vec::new(),
            ..Default::default()
        }
    }

    #[test]
    fn empty_query_matches_nothing() {
        let notes = vec![note("a", "Alpha", "body")];
        assert!(run(&notes, "   ", 1_000_000).is_empty());
    }

    #[test]
    fn title_matches_outrank_body_matches() {
        let notes = vec![
            note("body", "Unrelated", "alpha appears in the body"),
            note("title", "Alpha", "nothing here"),
        ];
        let hits = run(&notes, "alpha", 1_000_000);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "title");
    }

    #[test]
    fn every_bare_word_must_match() {
        let notes = vec![note("a", "Alpha beta", "x")];
        assert_eq!(run(&notes, "alpha beta", 1_000_000).len(), 1);
        assert_eq!(run(&notes, "alpha gamma", 1_000_000).len(), 0);
    }

    #[test]
    fn quoted_phrases_match_across_words() {
        let notes = vec![
            note("a", "x", "the quick brown fox"),
            note("b", "x", "quick the brown"),
        ];
        let hits = run(&notes, "\"quick brown\"", 1_000_000);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn tag_filters_are_exact() {
        let mut tagged = note("a", "x", "hello");
        tagged.tags = vec!["work".into()];
        let notes = vec![tagged, note("b", "x", "hello")];

        let hits = run(&notes, "#work", 1_000_000);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn exclusion_removes_matches() {
        let notes = vec![note("a", "Alpha", "keep"), note("b", "Alpha", "drop")];
        let hits = run(&notes, "alpha -drop", 1_000_000);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn trashed_notes_never_match() {
        let mut trashed = note("a", "Alpha", "x");
        trashed.trashed = true;
        let hits = run(&[trashed], "alpha", 1_000_000);
        assert!(hits.is_empty());
    }

    #[test]
    fn snippet_is_centred_on_the_match() {
        let long_body = format!("{} needle {}", "word ".repeat(40), "word ".repeat(40));
        let notes = vec![note("a", "x", &long_body)];
        let hits = run(&notes, "needle", 1_000_000);
        let snippet = &hits[0].snippet;
        assert!(snippet.contains("needle"), "snippet was {snippet:?}");
        assert!(snippet.len() < 140, "snippet too long: {snippet:?}");
        assert!(snippet.starts_with('…'));
    }

    #[test]
    fn tag_only_queries_use_the_body_preview() {
        let mut tagged = note("a", "Recipe", "flour, butter, sugar");
        tagged.tags = vec!["cooking".into()];
        let hits = run(&[tagged], "#cooking", 1_000_000);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.starts_with("flour"), "{:?}", hits[0].snippet);
    }
}
