/**
 * Symbols.
 *
 * Two ways to get a character that is not on the keyboard:
 *
 *  1. An autocorrect trigger — type `\theta` followed by a space and it
 *     becomes θ, the same way Word's Math AutoCorrect behaves.
 *  2. The Ω toolbar button, which opens a browsable panel grouped by category.
 *
 * Both paths share one table, so a symbol added here is reachable either way.
 */

import { $, el } from './dom.js';
import * as rt from './richtext.js';

const panel = $('#symbolPanel');
const panelBody = $('#symbolBody');
const symbolBtn = $('#symbolBtn');

/**
 * Categories are ordered by how often they are reached for in note-taking:
 * Greek and maths first, then the punctuation and marks that people hunt for.
 */
const CATEGORIES = [
  {
    label: 'Greek',
    items: [
      ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'],
      ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['iota', 'ι'], ['kappa', 'κ'],
      ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'],
      ['rho', 'ρ'], ['sigma', 'σ'], ['tau', 'τ'], ['phi', 'φ'], ['chi', 'χ'],
      ['psi', 'ψ'], ['omega', 'ω'],
      ['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'],
      ['Pi', 'Π'], ['Sigma', 'Σ'], ['Phi', 'Φ'], ['Psi', 'Ψ'], ['Omega', 'Ω'],
    ],
  },
  {
    label: 'Maths',
    items: [
      ['pm', '±'], ['mp', '∓'], ['times', '×'], ['div', '÷'], ['cdot', '·'],
      ['sqrt', '√'], ['infty', '∞'], ['partial', '∂'], ['nabla', '∇'], ['sum', '∑'],
      ['prod', '∏'], ['int', '∫'], ['oint', '∮'], ['propto', '∝'], ['degree', '°'],
      ['angle', '∠'], ['perp', '⊥'], ['parallel', '∥'], ['hbar', 'ℏ'], ['aleph', 'ℵ'],
      ['prime', '′'], ['therefore', '∴'], ['because', '∵'], ['approx', '≈'], ['neq', '≠'],
    ],
  },
  {
    label: 'Sets & logic',
    items: [
      ['in', '∈'], ['notin', '∉'], ['subset', '⊂'], ['supset', '⊃'], ['subseteq', '⊆'],
      ['supseteq', '⊇'], ['cup', '∪'], ['cap', '∩'], ['emptyset', '∅'],
      ['forall', '∀'], ['exists', '∃'], ['nexists', '∄'], ['leq', '≤'], ['geq', '≥'],
      ['equiv', '≡'], ['sim', '∼'], ['land', '∧'], ['lor', '∨'], ['lnot', '¬'],
    ],
  },
  {
    label: 'Arrows',
    items: [
      ['rightarrow', '→'], ['leftarrow', '←'], ['leftrightarrow', '↔'], ['Rightarrow', '⇒'],
      ['Leftarrow', '⇐'], ['Leftrightarrow', '⇔'], ['uparrow', '↑'], ['downarrow', '↓'],
      ['mapsto', '↦'], ['hookrightarrow', '↪'],
    ],
  },
  {
    label: 'Punctuation',
    items: [
      ['ldots', '…'], ['mdash', '—'], ['ndash', '–'], ['bullet', '•'], ['dagger', '†'],
      ['doubledagger', '‡'], ['section', '§'], ['para', '¶'], ['laquo', '«'], ['raquo', '»'],
      ['lsquo', '‘'], ['rsquo', '’'], ['ldquo', '“'], ['rdquo', '”'], ['lsaquo', '‹'],
      ['rsaquo', '›'],
    ],
  },
  {
    label: 'Marks',
    items: [
      ['check', '✓'], ['xmark', '✗'], ['starf', '★'], ['star', '☆'], ['heart', '♥'],
      ['spade', '♠'], ['club', '♣'], ['diamond', '♦'], ['circle', '●'], ['square', '■'],
      ['triangle', '▲'], ['warn', '⚠'],
    ],
  },
  {
    label: 'Fractions',
    items: [
      ['half', '½'], ['third', '⅓'], ['quarter', '¼'], ['threequarters', '¾'],
      ['eighth', '⅛'], ['fifth', '⅕'],
    ],
  },
  {
    label: 'Currency',
    items: [
      ['pound', '£'], ['euro', '€'], ['yen', '¥'], ['cent', '¢'], ['rupee', '₹'],
      ['ruble', '₽'], ['won', '₩'], ['bitcoin', '₿'],
    ],
  },
  {
    label: 'Misc',
    items: [
      ['copyright', '©'], ['reg', '®'], ['trade', '™'], ['micro', 'µ'], ['ohm', 'Ω'],
      ['prime', '″'], ['numero', '№'], ['not', '¬'], ['numero2', '℔'],
    ],
  },
];

/** Flattened name → glyph table, for the autocorrect path. */
const BY_NAME = new Map(
  CATEGORIES.flatMap((category) => category.items).map(([name, glyph]) => [name, glyph]),
);

let built = false;

function build() {
  if (built) return;
  panelBody.replaceChildren();

  for (const category of CATEGORIES) {
    panelBody.append(el('div', { class: 'symbol-cat', text: category.label }));

    const grid = el('div', { class: 'symbol-grid' });
    for (const [name, glyph] of category.items) {
      grid.append(
        el('button', {
          class: 'symbol-item',
          type: 'button',
          text: glyph,
          title: `${name}  \\${name}`,
          'aria-label': `${name}, inserts ${glyph}`,
          onClick: () => insertSymbol(glyph),
        }),
      );
    }
    panelBody.append(grid);
  }

  built = true;
}

// ============================================================== insertion ==

/**
 * Where to insert when the panel sent focus away from the editor.
 *
 * Opening the panel moves focus to a button, which collapses the visible
 * selection — so the range is captured while the caret is still in the editor
 * and replayed on insert.
 */
let savedRange = null;

document.addEventListener('selectionchange', () => {
  if (!rt.selectionInEditor()) return;
  const selection = window.getSelection();
  if (selection.rangeCount > 0) savedRange = selection.getRangeAt(0).cloneRange();
});

function insertSymbol(glyph) {
  const editor = document.getElementById('editorBody');
  editor.focus();

  if (savedRange) {
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedRange);
  }

  rt.insertText(glyph);
  savedRange = null;
  close();
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

// ================================================================ panel ====

export function open() {
  build();
  panel.hidden = false;
  symbolBtn.setAttribute('aria-expanded', 'true');
}

export function close() {
  panel.hidden = true;
  symbolBtn.setAttribute('aria-expanded', 'false');
}

export function toggle() {
  if (panel.hidden) open();
  else close();
}

export function isOpen() {
  return !panel.hidden;
}

// =========================================================== autocorrect ===

/**
 * Replace `\name` with its glyph in the text node before the caret.
 *
 * Runs on every keystroke, so the cheap rejection comes first: the character
 * just typed must be a terminator and there must be a backslash shortly before
 * the caret.
 */
export function tryAutoReplace() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  if (!range.collapsed) return false;

  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return false;

  const offset = range.startOffset;
  const before = node.textContent.slice(Math.max(0, offset - 40), offset);

  // A backslash name followed by a space or closing punctuation.
  const match = before.match(/\\([A-Za-z]+)([ .,;:!?)\]])$/);
  if (!match) return false;

  const glyph = BY_NAME.get(match[1]) ?? BY_NAME.get(match[1].toLowerCase());
  if (!glyph) return false;

  const absoluteStart = offset - match[0].length;

  const edit = document.createRange();
  edit.setStart(node, absoluteStart);
  edit.setEnd(node, offset);
  edit.deleteContents();

  const replacement = document.createTextNode(glyph + match[2]);
  edit.insertNode(replacement);

  // Leave the caret after the inserted punctuation.
  const caret = document.createRange();
  caret.setStart(replacement, replacement.length);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);

  return true;
}

/** Total number of symbols on offer, for the settings/about copy. */
export function symbolCount() {
  return BY_NAME.size;
}

// ================================================================ wiring ===

/**
 * Wire the toolbar button and the panel's dismissal.
 *
 * Autocorrect is *not* wired here: it is invoked from the editor's own input
 * handler, before the note is read back, so the replacement is persisted in
 * the same pass that noticed the keystroke.
 */
export function initSymbols() {
  symbolBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });

  $('#symbolClose').addEventListener('click', close);

  document.addEventListener('pointerdown', (event) => {
    if (panel.hidden) return;
    if (panel.contains(event.target) || symbolBtn.contains(event.target)) return;
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
      document.getElementById('editorBody')?.focus();
    }
  });
}
