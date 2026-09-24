/**
 * Rich-text primitives for the `contenteditable` editor.
 *
 * The browser's editing commands (`document.execCommand`) are deprecated on
 * paper but remain the only cross-engine way to drive a contenteditable region,
 * so they are used here — wrapped, so the rest of the app never calls them
 * directly and the fallbacks live in one place.
 *
 * Anything that inserts user-supplied markup goes through `sanitizeHtml`,
 * which is what keeps a paste from a dark-themed website from painting
 * invisible text into a light note (and vice versa).
 */

import { el } from './dom.js';

const EDITOR = () => document.getElementById('editorBody');

// ========================================================== exec commands ==

/** Run an editing command, keeping focus in the editor. */
export function exec(command, value = null) {
  const editor = EDITOR();
  if (!editor) return false;
  editor.focus();
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

/** Is a formatting state currently active at the caret? */
export function queryState(command) {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

/** The block-level tag active at the caret, e.g. "h2", "li", "blockquote". */
export function queryBlock() {
  try {
    return (document.queryCommandValue('formatBlock') || '').toLowerCase();
  } catch {
    return '';
  }
}

// ================================================================ caret ====

/** True when the caret (or selection) sits inside the editor. */
export function selectionInEditor() {
  const editor = EDITOR();
  if (!editor) return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  return editor.contains(selection.getRangeAt(0).commonAncestorContainer);
}

/**
 * The editor's direct child that holds the caret.
 *
 * The paragraph is the unit that focus mode dims and typewriter scrolling
 * tracks, so this is the anchor for both.
 */
export function currentBlock() {
  const editor = EDITOR();
  if (!editor) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  if (!node || !editor.contains(node)) return null;

  while (node.parentNode && node.parentNode !== editor) node = node.parentNode;
  return node.parentNode === editor ? node : null;
}

/** True when the caret is inside a `ul` or `ol`. */
export function insideList() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== document.body) {
    const tag = node.tagName;
    if (tag === 'LI' || tag === 'UL' || tag === 'OL') return true;
    if (tag === 'DIV' && node.id === 'editorBody') return false;
    node = node.parentNode;
  }
  return false;
}

/** Screen rectangle of the caret, for anchoring popups to it. */
export function caretRect() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);

  let rect = range.getBoundingClientRect();
  // A collapsed range at a line boundary can report an empty rect; a temporary
  // element gives us something real to measure.
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    const marker = el('span', { text: '\u200b' });
    try {
      range.insertNode(marker);
      rect = marker.getBoundingClientRect();
    } catch {
      return null;
    } finally {
      marker.remove();
    }
  }

  return rect && rect.height > 0 ? rect : null;
}

// ============================================================== blocks ====

/**
 * Apply a block format, toggling back to a paragraph when already applied.
 *
 * `formatBlock` is inconsistent about whether it wants angle brackets, so both
 * forms are tolerated by the browsers in play.
 */
export function setBlock(tag) {
  const editor = EDITOR();
  if (!editor) return;
  editor.focus();

  const current = queryBlock();
  const target = current === tag.toLowerCase() ? 'p' : tag;
  exec('formatBlock', `<${target}>`);
}

/** Wrap the selection in `tag`, or remove an existing wrapper of that tag. */
export function toggleInline(tag) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const existing = closestTag(selection.anchorNode, tag);
  if (existing) {
    unwrap(existing);
    return;
  }

  const range = selection.getRangeAt(0);
  if (range.collapsed) return;

  const wrapper = document.createElement(tag);
  try {
    // Exact for a selection inside one text node, which is the common case.
    range.surroundContents(wrapper);
  } catch {
    // A selection spanning several nodes needs the contents lifted out first;
    // partially-selected elements are cloned by extractContents.
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  }

  selectNode(wrapper);
}

/** Nearest ancestor (or self) with the given tag name. */
function closestTag(node, tag) {
  let current = node;
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE && current.tagName === tag.toUpperCase()) {
      return current;
    }
    if (current.nodeType === Node.ELEMENT_NODE && current.id === 'editorBody') return null;
    current = current.parentNode;
  }
  return null;
}

/** Replace an element with its own children. */
export function unwrap(node) {
  const parent = node.parentNode;
  if (!parent) return;
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  // An empty result would leave a stray empty line, so put the caret there.
  const selection = window.getSelection();
  if (!node.firstChild && selection) {
    const range = document.createRange();
    range.setStartBefore(node);
    range.collapse(true);
    parent.insertBefore(node, node);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  parent.removeChild(node);
}

/** Select an element's contents, so a button press stays visibly applied. */
export function selectNode(node) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

// ============================================================== insert ====

/** Insert text at the caret, replacing any selection. */
export function insertText(text) {
  const editor = EDITOR();
  if (!editor) return;
  editor.focus();

  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && selectionInEditor()) {
    // `insertText` keeps native undo history intact, unlike direct DOM edits.
    if (exec('insertText', text)) return;
  }

  // No usable caret: append to the end.
  editor.textContent += text;
}

/** Insert sanitised HTML at the caret. */
export function insertHtml(html) {
  const editor = EDITOR();
  if (!editor) return;
  editor.focus();
  const safe = sanitizeHtml(html);
  if (!exec('insertHTML', safe)) {
    editor.insertAdjacentHTML('beforeend', safe);
  }
}

// =========================================================== sanitising ====

const ALLOWED_TAGS = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'MARK',
  'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
  'A', 'P', 'DIV', 'SPAN', 'BR', 'HR', 'IMG',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
  'SUB', 'SUP',
]);

/** Removed outright, along with everything inside them. */
const STRIPPED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'SVG', 'CANVAS',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'VIDEO', 'AUDIO', 'SOURCE',
  'BASE', 'NOSCRIPT', 'TEMPLATE',
]);

/** The only attributes kept, per tag. Everything else is stripped. */
const ALLOWED_ATTRS = {
  A: new Set(['href', 'title']),
  IMG: new Set(['src', 'alt', 'width', 'height']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan']),
  LI: new Set(['data-checked']),
};

/** Protocols that are safe to leave in an href. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Image sources are limited to embedded data.
 *
 * A remote image would silently tell a third party that this note was opened,
 * which is precisely the kind of leak a local-first notepad exists to avoid —
 * so a pasted web image is dropped rather than fetched.
 */
function isSafeImageSource(value) {
  const trimmed = String(value ?? '').trim().toLowerCase();
  return trimmed.startsWith('data:image/') || trimmed.startsWith('blob:');
}

/**
 * Clean pasted or stored HTML down to the subset the editor understands.
 *
 * Everything not in the allow-list is unwrapped (its text is kept) or removed
 * entirely if it is a script-like element. Every attribute except a small
 * allow-list is dropped, which is what removes the inline colours and fonts
 * that would otherwise make pasted text unreadable.
 * This is also what makes it safe to assign a stored note's HTML straight into
 * the editor: an `onerror` on an image, or a `javascript:` link, cannot survive
 * a round trip through here.
 */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  cleanNode(doc.body);
  return doc.body.innerHTML;
}

/** Replace an element with its own children. */
function unwrapNode(node) {
  const fragment = node.ownerDocument.createDocumentFragment();
  while (node.firstChild) fragment.appendChild(node.firstChild);
  node.replaceWith(fragment);
}

function cleanNode(parent) {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;

    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove();
      continue;
    }

    const tag = child.tagName;

    if (STRIPPED_TAGS.has(tag)) {
      child.remove();
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown but harmless: keep the text, lose the wrapper.
      cleanNode(child);
      unwrapNode(child);
      continue;
    }

    const allowed = ALLOWED_ATTRS[tag];
    for (const attribute of Array.from(child.attributes)) {
      const name = attribute.name.toLowerCase();

      if (name.startsWith('on')) {
        child.removeAttribute(attribute.name);
        continue;
      }
      if (!allowed?.has(name)) {
        child.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'href' && !isSafeUrl(attribute.value)) {
        child.removeAttribute(attribute.name);
      }
      if (name === 'src' && !isSafeImageSource(attribute.value)) {
        child.removeAttribute(attribute.name);
      }
    }

    // A link with no usable target, or an image with no usable source, is not
    // worth keeping — a broken image icon is worse than nothing.
    if (tag === 'A' && !child.getAttribute('href')) {
      unwrapNode(child);
      continue;
    }
    if (tag === 'IMG' && !child.getAttribute('src')) {
      child.remove();
      continue;
    }

    cleanNode(child);
  }
}

function isSafeUrl(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return true;
  try {
    return SAFE_PROTOCOLS.has(new URL(trimmed, 'https://lunar-pad.invalid').protocol);
  } catch {
    return false;
  }
}

// ============================================================== lists =====

/** Indent or outdent the current list item. */
export function adjustListIndent(outdent) {
  exec(outdent ? 'outdent' : 'indent');
}
