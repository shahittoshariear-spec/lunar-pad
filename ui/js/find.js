/**
 * Find and replace within the open note.
 *
 * Matches are collected by walking the editor's text nodes, and painted with
 * the CSS Custom Highlight API. That matters: the alternative is wrapping each
 * hit in a `<mark>` element, which would mutate the document the user is
 * editing — corrupting the undo stack and re-triggering the save path on every
 * keystroke in the find box.
 *
 * Limitation worth knowing: a match that straddles two text nodes (say, the
 * query "hello" against `hel<b>lo</b>`) is not found, because each node is
 * searched independently. Formatting boundaries almost always fall on word
 * boundaries, so this does not come up in practice.
 */

import { $, debounce } from './dom.js';
import { currentNote, updateContent } from './state.js';

const bar = $('#findBar');
const findInput = $('#findInput');
const replaceInput = $('#replaceInput');
const replaceRow = $('#replaceRow');
const countEl = $('#findCount');
const editorBody = $('#editorBody');

/** Whether the highlight API is usable in this engine. */
const SUPPORTS_HIGHLIGHTS =
  typeof CSS !== 'undefined' &&
  'highlights' in CSS &&
  typeof globalThis.Highlight === 'function';

let matches = [];
let index = 0;

// ============================================================== matching ===

/** Text nodes with something in them, in document order. */
function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue && node.nodeValue.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function collect(query) {
  const needle = query.toLowerCase();
  const found = [];

  if (!needle) return found;

  for (const node of textNodes(editorBody)) {
    const haystack = node.nodeValue.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      found.push({ node, start: at, end: at + needle.length });
      // Advance past this hit so overlapping matches are not double-counted.
      from = at + needle.length;
    }
  }

  return found;
}

function rangeFor(match) {
  const range = document.createRange();
  range.setStart(match.node, match.start);
  range.setEnd(match.node, match.end);
  return range;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================ decoration ===

function paint() {
  if (!SUPPORTS_HIGHLIGHTS) return;

  const all = new Highlight();
  for (const match of matches) all.add(rangeFor(match));

  CSS.highlights.set('find-matches', all);

  if (matches[index]) {
    const current = new Highlight();
    current.add(rangeFor(matches[index]));
    CSS.highlights.set('find-current', current);
  } else {
    CSS.highlights.delete('find-current');
  }
}

function clearPaint() {
  if (!SUPPORTS_HIGHLIGHTS) return;
  CSS.highlights.delete('find-matches');
  CSS.highlights.delete('find-current');
}

function updateCount() {
  const total = matches.length;
  countEl.textContent = `${total === 0 ? 0 : index + 1}/${total}`;
  countEl.classList.toggle('is-empty', total === 0 && findInput.value.trim() !== '');
}

// ============================================================== movement ===

function focusMatch(behaviour = 'smooth') {
  const match = matches[index];
  if (!match) return;

  const range = rangeFor(match);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  // Scroll the match into the middle of the view, which reads better than
  // letting it land wherever the scroll container decides.
  const rect = range.getBoundingClientRect();
  const viewport = $('#editorScroll').getBoundingClientRect();
  const offset = rect.top - viewport.top - viewport.height * 0.4;
  $('#editorScroll').scrollBy({ top: offset, behavior: behaviour });
}

function step(delta) {
  if (matches.length === 0) return;
  index = (index + delta + matches.length) % matches.length;
  paint();
  updateCount();
  focusMatch();
}

// ============================================================== replacing ==

function replaceCurrent() {
  const match = matches[index];
  if (!match) return;

  const replacement = replaceInput.value;
  const value = match.node.nodeValue;
  match.node.nodeValue = value.slice(0, match.start) + replacement + value.slice(match.end);

  // Indices have shifted, so recompute from scratch and try to stay put.
  search({ keepIndex: true });

  commit();
}

function replaceEverywhere() {
  const query = findInput.value;
  if (!query) return;

  const pattern = new RegExp(escapeRegExp(query), 'gi');
  let replaced = 0;

  for (const node of textNodes(editorBody)) {
    const before = node.nodeValue;
    const after = before.replace(pattern, () => {
      replaced += 1;
      return replaceInput.value;
    });
    if (after !== before) node.nodeValue = after;
  }

  if (replaced > 0) {
    search({ keepIndex: true });
    commit();
    countEl.textContent = `${replaced} replaced`;
  }
}

/** Push a replacement through the normal save path. */
function commit() {
  const note = currentNote();
  if (!note) return;
  updateContent(note.id, { body: editorBody.innerHTML });
  editorBody.dispatchEvent(new Event('input', { bubbles: true }));
}

// ================================================================ search ===

const runSearch = debounce(() => search(), 110);

function search({ keepIndex = false } = {}) {
  const query = findInput.value;
  matches = collect(query);

  if (!keepIndex || index >= matches.length) index = 0;
  paint();
  updateCount();

  if (matches.length > 0) focusMatch('auto');
}

// ================================================================ public ===

export function openFind({ replace = false } = {}) {
  bar.hidden = false;
  replaceRow.hidden = !replace;

  // Seed the find box from the editor's selection, which is what people expect
  // after selecting a word and hitting Ctrl+F.
  const selection = window.getSelection();
  const selected = selection && !selection.isCollapsed ? selection.toString().trim() : '';
  if (selected && !selected.includes('\n')) findInput.value = selected;

  findInput.focus();
  findInput.select();
  search();
}

export function closeFind() {
  bar.hidden = true;
  clearPaint();
  matches = [];
  index = 0;
  editorBody.focus();
}

export function isFindOpen() {
  return !bar.hidden;
}

export function initFind() {
  $('#findBtn').addEventListener('click', () => {
    if (isFindOpen()) closeFind();
    else openFind({ replace: true });
  });

  $('#findClose').addEventListener('click', closeFind);
  $('#findNext').addEventListener('click', () => step(1));
  $('#findPrev').addEventListener('click', () => step(-1));
  $('#replaceOne').addEventListener('click', replaceCurrent);
  $('#replaceAll').addEventListener('click', replaceEverywhere);

  findInput.addEventListener('input', runSearch);
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (matches.length === 0) search();
      else step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });

  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      replaceCurrent();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });

  // The note's text can change underneath an open find bar (an undo, a symbol
  // insert), so recount whenever it does.
  editorBody.addEventListener('input', () => {
    if (!bar.hidden && findInput.value) runSearch();
  });
}
