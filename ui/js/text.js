/**
 * Text utilities: HTML → plain text, statistics, highlighting, fuzzy matching.
 *
 * The authoritative plain-text projection of a note is computed in Rust when
 * the note is saved. These helpers exist for the paths that must be
 * instantaneous — a sidebar preview redrawing on the next keystroke cannot
 * wait for an IPC round trip.
 */

/**
 * Readable text from the editor's HTML.
 *
 * Block-level closes become newlines and list items get a bullet, so a
 * multi-paragraph note previews as prose rather than one run-on line. The
 * parsing itself is left to the browser, which means entities and nested
 * markup are handled correctly for free.
 */
export function htmlToPlain(html) {
  if (!html) return '';

  const carrier = document.createElement('div');
  carrier.innerHTML = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|pre|table|section)>/gi, '\n')
    .replace(/<(li|tr)\b[^>]*>/gi, '\u2022 ');

  const text = carrier.textContent || '';
  return text.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Word, character and reading-time counts for the status line. */
export function countStats(plain) {
  const trimmed = plain.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const chars = plain.length;
  const charsNoSpaces = plain.replace(/\s/g, '').length;
  // 220 wpm is the usual figure for silent reading of prose.
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(words / 220));
  return { words, chars, charsNoSpaces, minutes };
}

/** "1 word · 5 chars · <1 min read", with sensible singulars. */
export function formatStats(stats) {
  const { words, chars, minutes } = stats;
  const parts = [`${words} ${words === 1 ? 'word' : 'words'}`, `${chars} ${chars === 1 ? 'char' : 'chars'}`];
  if (minutes > 0) parts.push(`${minutes} min read`);
  return parts.join(' \u00b7 ');
}

/**
 * Render `text` into `node`, wrapping occurrences of `query` in <mark>.
 *
 * Built with DOM nodes rather than an HTML string so note content can never be
 * interpreted as markup.
 */
export function highlightInto(node, text, query) {
  node.replaceChildren();
  const needle = (query || '').trim().toLowerCase();

  if (!needle || !text) {
    node.textContent = text || '';
    return node;
  }

  const haystack = text.toLowerCase();
  let cursor = 0;

  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;

    if (at > cursor) node.appendChild(document.createTextNode(text.slice(cursor, at)));

    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    node.appendChild(mark);

    cursor = at + needle.length;
  }

  if (cursor < text.length) node.appendChild(document.createTextNode(text.slice(cursor)));
  return node;
}

/**
 * Subsequence match with position-aware scoring, for the command palette.
 *
 * Returns `null` when `query` is not a subsequence of `text`, otherwise a
 * score where higher is better. Matches at word boundaries and runs of
 * consecutive characters are favoured, which is what makes typing `wlp`
 * find "Welcome to Lunar Pad" ahead of an incidental letter match.
 */
export function fuzzyScore(text, query) {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (needle.length > haystack.length) return null;

  let score = 0;
  let streak = 0;
  let cursor = 0;

  for (let i = 0; i < needle.length; i += 1) {
    const found = haystack.indexOf(needle[i], cursor);
    if (found === -1) return null;

    if (found === cursor && i > 0) {
      streak += 1;
      score += 6 + streak * 3;
    } else {
      streak = 0;
      score += 1;
    }

    if (found === 0 || /[\s\-_/.·]/.test(haystack[found - 1])) score += 8;
    cursor = found + 1;
  }

  // Shorter targets are more specific, so a match inside them is worth more.
  score += Math.max(0, 20 - Math.floor(haystack.length / 8));
  return score;
}

/** Trim, drop a leading #, lowercase and de-duplicate a tag list. */
export function normaliseTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of tags || []) {
    const tag = String(raw).trim().replace(/^#/, '').toLowerCase();
    if (!tag || tag.length > 32 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length === 12) break;
  }
  return out;
}

/** Coarse relative time: "just now", "4h", "3d", then an actual date. */
export function relativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;

  const hours = seconds / 3600;
  if (hours < 24) return `${Math.round(hours)}h`;

  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d`;

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A full, unambiguous timestamp for tooltips. */
export function absoluteTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

/** Strip characters Windows will not accept in a filename. */
export function slugify(title) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '-')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
  return cleaned || 'untitled';
}

/** Unique-enough id, matching the shape the Rust side generates. */
export function newId() {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
