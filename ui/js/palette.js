/**
 * The command palette.
 *
 * Ctrl+K opens one list that searches both notes and actions, so the keyboard
 * is always a faster route than the mouse. Notes are matched on title, body
 * and tags; actions are matched on their label and keywords.
 *
 * Results are ranked by `fuzzyScore`, which rewards matches at word boundaries
 * and runs of consecutive characters — so `nn` finds "New note" ahead of an
 * incidental pair of letters deep inside another label.
 */

import { $, el, icon, replace } from './dom.js';
import { displayTitle, on, selectNote, setView, state } from './state.js';
import { fuzzyScore } from './text.js';

/** Actions, built lazily because they need to close over the app's modules. */
let actions = [];
/** Resolved once at init so the palette can switch view without a cycle. */
let provideActions = null;

/** Most recent note ids per action, so ordering stays stable between renders. */
const RECENT_LIMIT = 60;

// =============================================================== render ====

function noteRows(query) {
  const live = state.notes.filter((note) => !note.trashed);

  const scored = [];
  for (const note of live) {
    const title = displayTitle(note);

    if (!query) {
      scored.push({ note, score: note.pinned ? 60 : 0, title });
      continue;
    }

    const byTitle = fuzzyScore(title, query);
    const byBody = fuzzyScore((note.plain || '').slice(0, 400), query);
    const byTag = (note.tags || []).reduce(
      (best, tag) => Math.max(best, fuzzyScore(tag, query) ?? -1),
      -1,
    );

    // A title match is a far stronger signal than a body match, so the body
    // score is heavily discounted rather than treated as equal evidence.
    const best = Math.max(
      byTitle ?? -1,
      byTag >= 0 ? byTag - 4 : -1,
      byBody !== null ? byBody - 60 : -1,
    );
    if (best < 0) continue;

    scored.push({ note, score: best + (note.pinned ? 8 : 0), title });
  }

  scored.sort((a, b) => b.score - a.score || (b.note.updated || 0) - (a.note.updated || 0));
  return scored.slice(0, query ? 12 : RECENT_LIMIT);
}

function actionRows(query) {
  if (!query) return actions.map((action) => ({ action, score: 0 }));

  const scored = [];
  for (const action of actions) {
    const byLabel = fuzzyScore(action.label, query);
    const byKeyword = action.keywords ? fuzzyScore(action.keywords, query) : null;
    if (byLabel === null && byKeyword === null) continue;
    scored.push({
      action,
      score: Math.max(byLabel ?? -1, byKeyword ?? -1) + (action.priority ?? 0),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

// ================================================================ panel ====

let root = null;
let input = null;
let listEl = null;
let entries = [];
let activeIndex = 0;

function paint() {
  replace(listEl, []);

  const query = input.value.trim();
  const noteResults = noteRows(query);
  const actionResults = actionRows(query);

  entries = [];

  if (actionResults.length > 0) {
    listEl.append(el('div', { class: 'palette-group', text: query ? 'Actions' : 'Quick actions' }));
    for (const { action } of actionResults) {
      // The row's index is captured before the push, so hover can point at the
      // right entry without searching the list for it.
      const rowIndex = entries.length;
      const row = el(
        'button',
        {
          class: 'palette-item',
          type: 'button',
          onMouseenter: () => {
            activeIndex = rowIndex;
            highlight();
          },
          onClick: () => run(action),
        },
        [
          icon(action.iconId ?? 'i-sparkles'),
          el('span', { class: 'palette-item-label', text: action.label }),
          action.shortcut ? el('span', { class: 'kbd', text: action.shortcut }) : null,
        ],
      );
      entries.push({ kind: 'action', action, node: row });
      listEl.append(row);
    }
  }

  if (noteResults.length > 0) {
    listEl.append(el('div', { class: 'palette-group', text: 'Notes' }));
    for (const { note, title } of noteResults) {
      const preview = (note.plain || '').split('\n').slice(0, 1).join(' ').slice(0, 60);
      const rowIndex = entries.length;
      const row = el(
        'button',
        {
          class: 'palette-item',
          type: 'button',
          onMouseenter: () => {
            activeIndex = rowIndex;
            highlight();
          },
          onClick: () => openNote(note.id),
        },
        [
          icon(note.pinned ? 'i-pin' : 'i-note'),
          el('span', { class: 'palette-item-label', text: title }),
          preview ? el('span', { class: 'palette-item-note', text: preview }) : null,
        ],
      );
      entries.push({ kind: 'note', id: note.id, node: row });
      listEl.append(row);
    }
  }

  if (entries.length === 0) {
    listEl.append(
      el('div', {
        class: 'palette-empty',
        text: query ? `Nothing matches “${query}”` : 'Start typing to search',
      }),
    );
  }

  activeIndex = Math.min(Math.max(0, activeIndex), Math.max(0, entries.length - 1));
  highlight();
}

/** Run an action after the palette has closed, so dialogs do not stack. */
function run(action) {
  close();
  requestAnimationFrame(() => action.run());
}

function highlight() {
  entries.forEach((entry, i) => entry.node.classList.toggle('is-active', i === activeIndex));
  entries[activeIndex]?.node.scrollIntoView({ block: 'nearest' });
}

function openNote(id) {
  close();
  setView('notes');
  selectNote(id);
  requestAnimationFrame(() => {
    document.getElementById('editorBody')?.focus();
  });
}

// ================================================================ public ====

export function openPalette({ seed = '' } = {}) {
  if (root) return;

  input = el('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Search notes, or type a command…',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Command palette',
    onInput: () => {
      activeIndex = 0;
      paint();
    },
    onKeydown: handleKeydown,
  });

  listEl = el('div', { class: 'palette-list', role: 'listbox' });

  const card = el('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' }, [
    el('div', { class: 'palette-input-wrap' }, [
      icon('i-search'),
      input,
      el('span', { class: 'palette-hint', text: 'Esc' }),
    ]),
    listEl,
  ]);

  root = el('div', {
    class: 'palette-backdrop',
    onPointerdown: (event) => {
      if (event.target === root) close();
    },
  }, [card]);

  document.getElementById('overlayRoot').append(root);

  if (seed) input.value = seed;
  paint();
  input.focus();
  input.select();
}

export function close() {
  if (!root) return;
  root.remove();
  root = null;
  input = null;
  listEl = null;
  entries = [];
  activeIndex = 0;
}

export function isPaletteOpen() {
  return root !== null;
}

export function togglePalette() {
  if (root) close();
  else openPalette();
}

function handleKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeIndex = Math.min(activeIndex + 1, entries.length - 1);
    highlight();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    highlight();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const entry = entries[activeIndex];
    if (!entry) return;
    if (entry.kind === 'note') openNote(entry.id);
    else run(entry.action);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    close();
  } else if (event.key === 'Tab') {
    // Tab would otherwise leave the palette, which is never what is wanted.
    event.preventDefault();
  }
}

/**
 * @param {() => Array<{label: string, run: () => void, iconId?: string,
 *                      keywords?: string, shortcut?: string, priority?: number}>} provider
 */
export function initPalette(provider) {
  provideActions = provider;
  actions = provider();

  // Keep the action list fresh: several read the current note at call time.
  on('notes-changed', () => {
    actions = provideActions();
  });
}
