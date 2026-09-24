/**
 * The slash menu.
 *
 * Typing `/` at the start of a line opens a filtered list of blocks and
 * inserts — the fastest way to add structure without leaving the keyboard.
 *
 * The menu reads the trigger straight out of the text node at the caret rather
 * than tracking state, which means it stays correct when the user deletes back
 * through the slash, pastes, or moves the caret away.
 */

import { el, icon, replace } from './dom.js';
import * as rt from './richtext.js';
import { htmlToPlain } from './text.js';

const editorPane = document.getElementById('editorPane');

/** Commands offered, in display order. */
const COMMANDS = [
  {
    id: 'h1', label: 'Heading 1', hint: 'Large section title', iconId: 'i-heading',
    keywords: 'h1 title big',
    run: () => rt.setBlock('h1'),
  },
  {
    id: 'h2', label: 'Heading 2', hint: 'Section title', iconId: 'i-heading',
    keywords: 'h2 subtitle',
    run: () => rt.setBlock('h2'),
  },
  {
    id: 'h3', label: 'Heading 3', hint: 'Subsection', iconId: 'i-heading',
    keywords: 'h3',
    run: () => rt.setBlock('h3'),
  },
  {
    id: 'bullet', label: 'Bulleted list', hint: 'Unordered items', iconId: 'i-ul',
    keywords: 'ul list bullet point',
    run: () => rt.exec('insertUnorderedList'),
  },
  {
    id: 'number', label: 'Numbered list', hint: 'Ordered items', iconId: 'i-ol',
    keywords: 'ol list number ordered',
    run: () => rt.exec('insertOrderedList'),
  },
  {
    id: 'quote', label: 'Quote', hint: 'Set text apart', iconId: 'i-quote',
    keywords: 'blockquote citation',
    run: () => rt.setBlock('blockquote'),
  },
  {
    id: 'code', label: 'Code block', hint: 'Monospaced and literal', iconId: 'i-code',
    keywords: 'pre monospace snippet',
    run: () => rt.setBlock('pre'),
  },
  {
    id: 'divider', label: 'Divider', hint: 'Horizontal rule', iconId: 'i-minus',
    keywords: 'hr line rule separator',
    run: () => rt.exec('insertHorizontalRule'),
  },
  {
    id: 'date', label: 'Today’s date', hint: new Date().toLocaleDateString(),
    iconId: 'i-clock', keywords: 'date day today time',
    run: () => rt.insertText(new Date().toLocaleDateString(undefined, { dateStyle: 'long' })),
  },
  {
    id: 'time', label: 'Current time', hint: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    iconId: 'i-clock', keywords: 'time clock now',
    run: () => rt.insertText(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
  },
  {
    id: 'stat', label: 'Word count', hint: 'Insert the note’s statistics',
    iconId: 'i-typesize', keywords: 'stats words count characters',
    run: () => {
      const counts = htmlToPlain(document.getElementById('editorBody').innerHTML);
      const words = counts.trim() ? counts.trim().split(/\s+/).length : 0;
      rt.insertText(`${words} words, ${counts.length} characters`);
    },
  },
  {
    id: 'tag', label: 'Add a tag', hint: 'Group this note', iconId: 'i-hash',
    keywords: 'tag label group',
    run: () => {
      document.getElementById('tagInput')?.focus();
    },
  },
];

let menu = null;
let activeIndex = 0;
let matches = COMMANDS;

// ============================================================== trigger ====

/** The `/query` immediately before the caret, or null. */
function readTrigger() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const before = node.textContent.slice(0, range.startOffset);
  // Anchored to a line start so a slash inside a URL never triggers it.
  const match = before.match(/(?:^|\s)\/([^/\s]*)$/);
  if (!match) return null;

  return { node, query: match[1], length: match[0].trimStart().length };
}

/** Remove the typed trigger, leaving the caret where the slash began. */
function stripTrigger(trigger) {
  const selection = window.getSelection();
  const offset = selection.getRangeAt(0).startOffset;
  const start = offset - trigger.length;

  trigger.node.textContent =
    trigger.node.textContent.slice(0, start) + trigger.node.textContent.slice(offset);

  const range = document.createRange();
  range.setStart(trigger.node, Math.max(0, start));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// ================================================================= menu ====

function filter(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return COMMANDS;

  const scored = [];
  for (const command of COMMANDS) {
    const haystack = `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`.toLowerCase();
    // Every command is small, so a simple contains-check is enough here; the
    // fuzzy matcher in the palette earns its keep only over long lists.
    const at = haystack.indexOf(needle);
    if (at !== -1) scored.push({ command, at });
  }
  scored.sort((a, b) => a.at - b.at);
  return scored.map((entry) => entry.command);
}

function paint() {
  if (!menu) return;
  const list = menu.querySelector('.palette-list');
  replace(list, []);

  if (matches.length === 0) {
    list.append(el('div', { class: 'palette-empty', text: 'No matching insert' }));
    return;
  }

  matches.forEach((command, index) => {
    list.append(
      el(
        'button',
        {
          class: `palette-item${index === activeIndex ? ' is-active' : ''}`,
          type: 'button',
          onMouseenter: () => {
            activeIndex = index;
            paint();
          },
          onClick: () => choose(command),
        },
        [
          icon(command.iconId),
          el('span', { class: 'palette-item-label', text: command.label }),
          command.hint ? el('span', { class: 'palette-item-note', text: command.hint }) : null,
        ],
      ),
    );
  });
}

/** Position the popup at the caret, keeping it inside the pane. */
function position(rect) {
  if (!menu || !rect) return;
  const paneRect = editorPane.getBoundingClientRect();

  const width = menu.offsetWidth;
  const height = menu.offsetHeight;

  let left = rect.left - paneRect.left;
  let top = rect.bottom - paneRect.top + 6;

  left = Math.max(10, Math.min(left, paneRect.width - width - 10));
  // Flip above the caret when there is no room below.
  if (top + height > paneRect.height - 10) top = Math.max(10, rect.top - paneRect.top - height - 6);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function choose(command) {
  const trigger = readTrigger();
  if (trigger) stripTrigger(trigger);
  closeSlashMenu();

  command.run();

  const editor = document.getElementById('editorBody');
  if (editor) {
    editor.focus();
    // Formatting commands do not emit `input`, so tell the editor explicitly.
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export function closeSlashMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  matches = COMMANDS;
  activeIndex = 0;
}

export function isSlashMenuOpen() {
  return menu !== null;
}

/**
 * Open the menu at the caret.
 *
 * Anchored inside `.editor-pane`, which is the nearest positioned ancestor.
 */
export function openSlashMenu(rect) {
  closeSlashMenu();

  menu = el('div', { class: 'popup slash-menu' }, [
    el('div', { class: 'palette-head' }, [
      icon('i-sparkles'),
      el('span', { class: 'popup-title', text: 'Insert' }),
      el('span', { class: 'palette-hint', text: 'Esc' }),
    ]),
    el('div', { class: 'palette-list' }),
  ]);

  editorPane.append(menu);
  paint();
  position(rect);
}

/**
 * Called on every editor input.
 *
 * Handles opening, filtering and closing in one place so the trigger logic
 * cannot drift out of sync with the visible list.
 */
export function updateSlashMenu() {
  const trigger = readTrigger();

  if (!trigger) {
    closeSlashMenu();
    return;
  }

  if (!menu) {
    const rect = rt.caretRect();
    if (!rect) return;
    openSlashMenu(rect);
  }

  matches = filter(trigger.query);
  activeIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));
  paint();
  position(rt.caretRect());
}

// The menu takes arrow keys and Enter while it is open, so the editor must not
// also act on them. Registered in the capture phase to run first.
document.addEventListener(
  'keydown',
  (event) => {
    if (!menu) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % Math.max(1, matches.length);
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + matches.length) % Math.max(1, matches.length);
      paint();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      if (matches[activeIndex]) {
        event.preventDefault();
        choose(matches[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSlashMenu();
    }
  },
  { capture: true },
);

// Any click elsewhere dismisses it.
document.addEventListener('pointerdown', (event) => {
  if (menu && !menu.contains(event.target)) closeSlashMenu();
});
