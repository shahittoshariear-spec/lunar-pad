//! Turning notes into files.
//!
//! The editor stores HTML because that is what a `contenteditable` region
//! produces. Export is where that markup has to become something portable, so
//! this module contains a small, dependency-free HTML scanner that converts to
//! plain text and Markdown.
//!
//! The scanner is intentionally not a general-purpose HTML parser. It handles
//! the tag set the editor can emit plus the common tags you get from pasted
//! rich text, and degrades to "strip the tag, keep the text" for anything else.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::model::Note;

/// Formats a single note can be written out in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Text,
    Markdown,
    Html,
    Json,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Text => "txt",
            ExportFormat::Markdown => "md",
            ExportFormat::Html => "html",
            ExportFormat::Json => "json",
        }
    }

    /// Human-readable name, used as the file-dialog filter label.
    pub fn name(self) -> &'static str {
        match self {
            ExportFormat::Text => "Plain text",
            ExportFormat::Markdown => "Markdown",
            ExportFormat::Html => "Web page",
            ExportFormat::Json => "JSON",
        }
    }

    /// Parse a format name, defaulting to Markdown for anything unrecognised.
    pub fn parse(name: &str) -> Self {
        match name.to_lowercase().as_str() {
            "txt" | "text" | "plain" => ExportFormat::Text,
            "html" | "htm" => ExportFormat::Html,
            "json" => ExportFormat::Json,
            _ => ExportFormat::Markdown,
        }
    }
}

/// Kinds of list we are inside, so we can indent and number correctly.
enum ListKind {
    Bullet,
    Ordered(u32),
}

/// Convert the subset of HTML the editor produces into Markdown.
pub fn html_to_markdown(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut lists: Vec<ListKind> = Vec::new();
    let mut in_pre = false;
    let mut chars = html.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '<' => {
                let mut raw = String::new();
                for c in chars.by_ref() {
                    if c == '>' {
                        break;
                    }
                    raw.push(c);
                }
                handle_tag(&mut out, &raw, &mut lists, &mut in_pre);
            }
            '&' => {
                let mut entity = String::new();
                let mut closed = false;
                while entity.len() < 12 {
                    match chars.next() {
                        Some(';') => {
                            closed = true;
                            break;
                        }
                        Some(c) => entity.push(c),
                        None => break,
                    }
                }
                if closed {
                    out.push_str(decode_entity(&entity));
                } else {
                    out.push('&');
                    out.push_str(&entity);
                }
            }
            _ if in_pre => out.push(ch),
            _ if ch.is_whitespace() => {
                if !out.ends_with([' ', '\n']) {
                    out.push(' ');
                }
            }
            _ => out.push(ch),
        }
    }

    tidy_markdown(&out)
}

/// Apply one tag's opening or closing marker.
fn handle_tag(out: &mut String, raw: &str, lists: &mut Vec<ListKind>, in_pre: &mut bool) {
    let trimmed = raw.trim();
    let is_close = trimmed.starts_with('/');
    let body = trimmed.trim_start_matches('/').trim_end_matches('/');

    let name: String = body
        .split(|c: char| c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_lowercase();

    // Markers that need a blank line around them.
    let block_break = |out: &mut String| {
        while out.ends_with(' ') {
            out.pop();
        }
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push('\n');
        }
    };

    match name.as_str() {
        "br" => out.push('\n'),
        "hr" => {
            block_break(out);
            out.push_str("\n---\n");
        }
        "p" | "div" | "section" | "article" | "blockquote" | "table" | "tr" => {
            block_break(out);
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            if is_close {
                out.push('\n');
            } else {
                block_break(out);
                out.push('\n');
                let level = name[1..].parse::<usize>().unwrap_or(1);
                for _ in 0..level {
                    out.push('#');
                }
                out.push(' ');
            }
        }
        "pre" => {
            *in_pre = !is_close;
            block_break(out);
            if !is_close {
                out.push_str("\n```\n");
            } else {
                out.push_str("\n```\n");
            }
        }
        "b" | "strong" => out.push_str("**"),
        "i" | "em" => out.push('*'),
        "s" | "strike" | "del" => out.push_str("~~"),
        "code" => out.push('`'),
        "mark" => out.push_str("=="),
        "u" => out.push_str(if is_close { "</u>" } else { "<u>" }),
        "ul" | "ol" => {
            if is_close {
                lists.pop();
                block_break(out);
            } else {
                block_break(out);
                lists.push(if name == "ol" {
                    ListKind::Ordered(1)
                } else {
                    ListKind::Bullet
                });
            }
        }
        "li" => {
            if is_close {
                out.push('\n');
            } else {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                let depth = lists.len().saturating_sub(1);
                for _ in 0..depth {
                    out.push_str("  ");
                }
                match lists.last_mut() {
                    Some(ListKind::Ordered(n)) => {
                        let _ = write!(out, "{n}. ");
                        *n += 1;
                    }
                    _ => out.push_str("- "),
                }
            }
        }
        "a" => {
            if !is_close {
                // The link label follows; the href is appended when the tag
                // closes. We stash it in a scratch buffer instead.
                if let Some(href) = attribute(body, "href") {
                    if !href.is_empty() {
                        out.push('[');
                        out.push_str(HREF_SENTINEL);
                        out.push_str(&href);
                        out.push(' ');
                    }
                }
            } else if out.contains(HREF_SENTINEL) {
                // Close the bracket group: `[sentinel href text]` becomes
                // `[text](href)`. Reorder what we already wrote.
                if let Some(start) = out.rfind('[') {
                    let tail = out[start + 1..].to_string();
                    out.truncate(start);
                    if let Some(rest) = tail.strip_prefix(HREF_SENTINEL) {
                        if let Some((href, text)) = rest.split_once(' ') {
                            let _ = write!(out, "[{text}]({href})");
                            return;
                        }
                    }
                    out.push('[');
                    out.push_str(&tail);
                }
            }
        }
        _ => {}
    }
}

/// Marker used to smuggle an anchor's href past the link text.
const HREF_SENTINEL: &str = "\u{1}";

/// Extract an attribute value from a tag body, handling both quote styles.
fn attribute(tag_body: &str, wanted: &str) -> Option<String> {
    let lower = tag_body.to_lowercase();
    let idx = lower.find(wanted)?;
    // Guard against matching a suffix of a longer attribute name.
    if idx > 0 {
        let prev = lower[..idx].chars().next_back();
        if prev.is_some_and(|c| c.is_alphanumeric() || c == '-') {
            return None;
        }
    }
    let rest = &tag_body[idx + wanted.len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let mut chars = rest.chars();
    match chars.next()? {
        quote @ ('"' | '\'') => {
            let end = rest[1..].find(quote)?;
            Some(rest[1..1 + end].to_string())
        }
        _ => {
            let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
            Some(rest[..end].to_string())
        }
    }
}

/// Decode the entities the editor (and pasted content) realistically produce.
fn decode_entity(entity: &str) -> &str {
    match entity {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" | "#39" => "'",
        "nbsp" => " ",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "bull" => "•",
        "middot" => "·",
        "times" => "×",
        "divide" => "÷",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "laquo" => "«",
        "raquo" => "»",
        "ldquo" => "“",
        "rdquo" => "”",
        "lsquo" => "‘",
        "rsquo" => "’",
        _ => match entity.strip_prefix('#') {
            Some(digits) => {
                let code = if let Some(hex) = digits
                    .strip_prefix('x')
                    .or_else(|| digits.strip_prefix('X'))
                {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    digits.parse::<u32>().ok()
                };
                // Only a fixed set of code points can be returned as `&str`,
                // so unknown ones keep their original entity text rather than
                // being dropped — losing characters from a note would be far
                // worse than leaving `&#8364;` visible.
                code.and_then(char::from_u32)
                    .and_then(char_slice)
                    .unwrap_or(entity)
            }
            None => entity,
        },
    }
}

/// Map the numeric entities that actually show up in practice onto their text.
///
/// Returns `None` for anything outside the table, letting the caller preserve
/// the raw entity instead of emitting an empty string.
fn char_slice(c: char) -> Option<&'static str> {
    Some(match c {
        '\u{a0}' => " ",
        '\u{a9}' => "©",
        '\u{ae}' => "®",
        '\u{2013}' => "–",
        '\u{2014}' => "—",
        '\u{2018}' => "‘",
        '\u{2019}' => "’",
        '\u{201c}' => "“",
        '\u{201d}' => "”",
        '\u{2022}' => "•",
        '\u{2026}' => "…",
        '\u{20ac}' => "€",
        '\u{2122}' => "™",
        '\u{2192}' => "→",
        '\u{2713}' => "✓",
        _ => return None,
    })
}

/// Strip markup entirely, keeping readable structure.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_pre = false;
    let mut chars = html.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '<' => {
                let mut raw = String::new();
                for c in chars.by_ref() {
                    if c == '>' {
                        break;
                    }
                    raw.push(c);
                }

                let trimmed = raw.trim();
                let is_close = trimmed.starts_with('/');
                let name: String = trimmed
                    .trim_start_matches('/')
                    .split(|c: char| c.is_whitespace() || c == '/')
                    .next()
                    .unwrap_or("")
                    .to_lowercase();

                match name.as_str() {
                    "br" => out.push('\n'),
                    "pre" => {
                        in_pre = !is_close;
                        out.push('\n');
                    }
                    "li" if !is_close => {
                        if !out.ends_with('\n') && !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str("  • ");
                    }
                    "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    | "blockquote" | "ul" | "ol" | "table" => out.push('\n'),
                    "hr" => out.push_str("\n────────\n"),
                    _ => {}
                }
            }
            '&' => {
                let mut entity = String::new();
                let mut closed = false;
                while entity.len() < 12 {
                    match chars.next() {
                        Some(';') => {
                            closed = true;
                            break;
                        }
                        Some(c) => entity.push(c),
                        None => break,
                    }
                }
                if closed {
                    out.push_str(decode_entity(&entity));
                } else {
                    out.push('&');
                    out.push_str(&entity);
                }
            }
            _ if in_pre => out.push(ch),
            _ if ch == '\u{a0}' => out.push(' '),
            _ => out.push(ch),
        }
    }

    tidy(&out)
}

/// Squash the whitespace artefacts left behind by tag replacement.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut newlines = 0usize;

    for line in text.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            newlines += 1;
            if newlines <= 2 {
                out.push('\n');
            }
        } else {
            newlines = 0;
            out.push_str(line);
            out.push('\n');
        }
    }

    out.trim().to_string()
}

/// Trim trailing space on each line and cap consecutive blank lines.
fn tidy_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blanks = 0usize;

    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            blanks += 1;
            // Paragraphs get one blank line; three in a row collapses to two.
            if blanks <= 1 {
                out.push('\n');
            }
        } else {
            blanks = 0;
            out.push_str(line);
            out.push('\n');
        }
    }

    out.trim().to_string()
}

/// Safe-ish filename derived from a note title.
pub fn slugify(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();

    let cleaned = cleaned.trim().trim_matches('.').trim();
    let mut out: String = cleaned.chars().take(80).collect();
    if out.is_empty() {
        out = "untitled".to_string();
    }
    out
}

/// Render one note into a file body.
pub fn render(note: &Note, format: ExportFormat) -> String {
    let title = note.display_title();
    match format {
        ExportFormat::Text => {
            let mut out = String::new();
            let _ = writeln!(out, "{title}");
            let _ = writeln!(out, "{}", "=".repeat(title.chars().count().max(3)));
            out.push('\n');
            out.push_str(&html_to_text(&note.body));
            out.push('\n');
            out
        }
        ExportFormat::Markdown => {
            let mut out = String::new();
            let _ = writeln!(out, "# {title}\n");
            if !note.tags.is_empty() {
                let tags: Vec<String> = note.tags.iter().map(|t| format!("#{t}")).collect();
                let _ = writeln!(out, "{}\n", tags.join(" "));
            }
            out.push_str(&html_to_markdown(&note.body));
            out.push('\n');
            out
        }
        ExportFormat::Html => {
            let mut out = String::new();
            let _ = write!(out, "{}", render_html_page(&title, &note.body, &note.tags));
            out
        }
        ExportFormat::Json => {
            serde_json::to_string_pretty(note).unwrap_or_else(|_| "{}".to_string())
        }
    }
}

/// A self-contained, theme-matched HTML page for a single note.
fn render_html_page(title: &str, body: &str, tags: &[String]) -> String {
    let escaped_title = escape_html(title);
    let tag_html: String = tags
        .iter()
        .map(|t| format!("<span class=\"tag\">#{}</span>", escape_html(t)))
        .collect::<Vec<_>>()
        .join("");

    render_document(
        &escaped_title,
        &format!("<h1>{escaped_title}</h1>\n{tag_html}\n<article>\n{body}\n</article>"),
    )
}

/// Wrap already-built article markup in the exported page shell.
///
/// Used by the "export all" path, where the body is a concatenation of every
/// note rather than a single one.
pub fn render_bundle_html(title: &str, body: &str) -> String {
    let escaped = escape_html(title);
    render_document(&escaped, body)
}

/// The shared page shell: dark, readable, and self-contained so an exported
/// note opens correctly anywhere with no assets or network access.
fn render_document(escaped_title: &str, body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escaped_title}</title>
<style>
  :root {{ color-scheme: dark light; }}
  body {{
    margin: 0 auto; padding: 3rem 1.5rem; max-width: 46rem;
    font: 17px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0b0b16; color: #e6e7f2;
  }}
  h1 {{ font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 .5rem; }}
  h2, h3 {{ letter-spacing: -0.01em; margin-top: 2rem; }}
  .tags {{ margin-bottom: 2rem; display: flex; gap: .4rem; flex-wrap: wrap; }}
  .tag {{
    font-size: .75rem; padding: .15rem .55rem; border-radius: 999px;
    background: rgba(109,124,255,.16); color: #9aa5ff;
  }}
  article + hr {{ border: none; border-top: 1px solid #23233a; margin: 3rem 0; }}
  a {{ color: #8f9bff; }}
  blockquote {{
    margin: 1.5rem 0; padding-left: 1rem;
    border-left: 3px solid rgba(109,124,255,.4); color: #a9abc4;
  }}
  pre {{ background: #12121f; padding: 1rem; border-radius: .6rem; overflow-x: auto; }}
  code {{ font-family: ui-monospace, Consolas, monospace; font-size: .92em; }}
  hr {{ border: none; border-top: 1px solid #23233a; margin: 2rem 0; }}
  img {{ max-width: 100%; border-radius: .5rem; }}
  mark {{ background: rgba(109,124,255,.3); color: inherit; padding: 0 .15em; border-radius: .2em; }}
</style>
</head>
<body>
{body}
</body>
</html>
"#
    )
}

pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bold_becomes_double_asterisks() {
        assert_eq!(html_to_markdown("a <b>bold</b> word"), "a **bold** word");
        assert_eq!(html_to_markdown("<strong>x</strong>"), "**x**");
    }

    #[test]
    fn headings_become_hashes() {
        assert_eq!(html_to_markdown("<h2>Title</h2>"), "## Title");
    }

    #[test]
    fn bullet_lists_become_dashes() {
        let html = "<ul><li>one</li><li>two</li></ul>";
        let md = html_to_markdown(html);
        assert!(md.contains("- one"), "{md:?}");
        assert!(md.contains("- two"), "{md:?}");
    }

    #[test]
    fn ordered_lists_number_upwards() {
        let html = "<ol><li>first</li><li>second</li></ol>";
        let md = html_to_markdown(html);
        assert!(md.contains("1. first"), "{md:?}");
        assert!(md.contains("2. second"), "{md:?}");
    }

    #[test]
    fn links_keep_their_target() {
        let md = html_to_markdown(r#"see <a href="https://example.com">the docs</a> now"#);
        assert!(md.contains("[the docs](https://example.com)"), "{md:?}");
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(html_to_text("a &amp; b &lt; c"), "a & b < c");
        assert_eq!(html_to_text("50&nbsp;kg"), "50 kg");
        assert_eq!(html_to_text("&hellip;"), "…");
    }

    #[test]
    fn text_export_keeps_paragraph_breaks() {
        let text = html_to_text("<p>one</p><p>two</p>");
        assert!(text.contains("one"));
        assert!(text.contains("two"));
        assert!(text.contains('\n'));
    }

    #[test]
    fn plain_text_strips_all_markup() {
        let text = html_to_text("<div><b>hi</b><span style=\"x\">there</span></div>");
        assert!(!text.contains('<'), "{text:?}");
        assert!(text.contains("hi"));
        assert!(text.contains("there"));
    }

    #[test]
    fn line_breaks_survive() {
        assert_eq!(html_to_text("a<br>b"), "a\nb");
    }

    #[test]
    fn bullet_text_export_is_indented() {
        let text = html_to_text("<ul><li>item</li></ul>");
        assert!(text.contains("• item"), "{text:?}");
    }

    #[test]
    fn slugify_removes_windows_reserved_characters() {
        assert_eq!(slugify(r#"a/b:c*d?e"f<g>h|i"#), "a-b-c-d-e-f-g-h-i");
        assert_eq!(slugify("   "), "untitled");
        assert_eq!(slugify("..."), "untitled");
    }

    #[test]
    fn format_parsing_is_forgiving() {
        assert_eq!(ExportFormat::parse("TXT"), ExportFormat::Text);
        assert_eq!(ExportFormat::parse("markdown"), ExportFormat::Markdown);
        assert_eq!(ExportFormat::parse("nonsense"), ExportFormat::Markdown);
    }

    #[test]
    fn markdown_export_includes_title_and_tags() {
        let note = Note {
            title: "Hello".into(),
            body: "<p>world</p>".into(),
            tags: vec!["work".into()],
            ..Default::default()
        };
        let md = render(&note, ExportFormat::Markdown);
        assert!(md.starts_with("# Hello"));
        assert!(md.contains("#work"));
        assert!(md.contains("world"));
    }

    #[test]
    fn html_export_escapes_the_title() {
        let note = Note {
            title: "<script>alert(1)</script>".into(),
            body: "<p>safe</p>".into(),
            ..Default::default()
        };
        let html = render(&note, ExportFormat::Html);
        assert!(!html.contains("<script>alert"), "title was not escaped");
        assert!(html.contains("&lt;script&gt;"));
    }
}
