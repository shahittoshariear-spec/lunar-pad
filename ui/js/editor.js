/**
 * The editor pane: title, tags, toolbar, body and statistics.
 *
 * The body is a `contenteditable` region, which means the browser owns the
 * document model. This module's job is to keep that DOM, the in-memory note
 * and what the toolbar reports in agreement, and to do it without getting in
 * the way of typing.
 */

import { $, $$, debounce, el, icon, rafThrottle, replace } from './dom.js';
import * as rt from './richtext.js';
import {
  currentNote,
  displayTitle,
  duplicateNote,
  on,
  setTags,
  state,
  togglePin,
  trashNote,
  updateContent,
  updateNote,
} from './state.js';
import { countStats, formatStats, htmlToPlain, normaliseTags } from './text.js';
import { confirmDialog, exportMenu } from './dialogs.js';
import { updateSlashMenu } from './slash.js';
import { tryAutoReplace } from './symbols.js';
import { toast } from './toast.js';

const editorPane = $('#editorPane');
const editorHead = $('#editorHead');
const toolbar = $('#toolbar');
const editorScroll = $('#editorScroll');
const bodyEditor = $('#editorBody');
const titleInput = $('#titleInput');
const statsEl = $('#stats');
const tagRow = $('#tagRow');
const fontSelect = $('#fontSelect');
const pinBtn = $('#pinBtn');

/** Shown in place of the editor when there is nothing to edit. */
let emptyPane = null;

// ============================================================== render =====

function ensureEmptyPane() {
  if (!emptyPane) {
    emptyPane = el('div', { class: 'empty-pane', hidden: true }, [
      icon('i-lunar'),
      el('h3', { text: 'Nothing open' }),
      el('p', {
        text: 'Every note has been deleted. Create one with Ctrl+N, or restore something from the trash.',
      }),
    ]);
    editorPane.append(emptyPane);
  }
  return emptyPane;
}

/** Show the editor for `state.currentId`, or the empty pane. */
export function renderEditor({ animate = true } = {}) {
  const note = currentNote();

  if (!note) {
    ensureEmptyPane().hidden = false;
    editorHead.hidden = true;
    toolbar.hidden = true;
    editorScroll.hidden = true;
    return;
  }

  ensureEmptyPane().hidden = true;
  editorHead.hidden = false;
  toolbar.hidden = false;
  editorScroll.hidden = false;

  titleInput.value = note.title || '';
  if (bodyEditor.innerHTML !== (note.body || '')) {
    // A stored note is untrusted input: it may have been pasted from anywhere,
    // or hand-edited in the JSON file. Sanitising on the way in means markup
    // like an `<img onerror>` in a note can never run.
    bodyEditor.innerHTML = rt.sanitizeHtml(note.body || '');
  }
  bodyEditor.style.fontFamily = note.font || '';
  fontSelect.value = note.font || '';
  bodyEditor.spellcheck = Boolean(state.settings.spellcheck);

  renderTags();
  updateStats();
  updateToolbarState();
  applyFocusMode();

  if (animate) {
    // Restart the entrance by clearing the animation, forcing a reflow, then
    // re-applying it — the only reliable way to replay a CSS animation.
    bodyEditor.style.animation = 'none';
    void bodyEditor.offsetHeight;
    bodyEditor.style.animation = 'note-enter 260ms var(--ease-out) both';
    setTimeout(() => {
      bodyEditor.style.animation = '';
    }, 340);
  }

  editorScroll.scrollTop = 0;
}

/** Tag chips plus the add-tag affordance. */
function renderTags() {
  const note = currentNote();
  const tags = note?.tags ?? [];
  const fragment = document.createDocumentFragment();

  for (const tag of tags) {
    fragment.append(
      el('button', {
        class: 'chip',
        type: 'button',
        title: `Remove #${tag}`,
        onClick: () => {
          const next = (currentNote()?.tags ?? []).filter((entry) => entry !== tag);
          void setTags(note.id, next);
        },
      }, [
        el('span', { text: `#${tag}` }),
        el('span', { class: 'chip-x', text: '×' }),
      ]),
    );
  }

  const input = el('input', {
    class: 'tag-input',
    type: 'text',
    id: 'tagInput',
    placeholder: tags.length ? 'Add' : 'Add tag',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Add a tag',
    onKeydown: (event) => {
      if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
        if (!input.value.trim()) return;
        event.preventDefault();
        commitTag(input.value);
      } else if (event.key === 'Backspace' && !input.value && tags.length > 0) {
        event.preventDefault();
        void setTags(note.id, tags.slice(0, -1));
      } else if (event.key === 'Escape') {
        input.blur();
      }
    },
    onBlur: () => {
      if (input.value.trim()) commitTag(input.value);
    },
  });

  fragment.append(
    el('label', { class: 'tag-add', title: 'Add a tag' }, [
      icon('i-plus'),
      input,
    ]),
  );

  replace(tagRow, []);
  tagRow.append(fragment);
}

function commitTag(raw) {
  const note = currentNote();
  if (!note) return;
  // Accept several tags at once, so pasting "a, b, c" works.
  const incoming = String(raw).split(',').map((value) => value.trim()).filter(Boolean);
  const next = normaliseTags([...(note.tags ?? []), ...incoming]);
  void setTags(note.id, next);
  renderTags();
}

// =============================================================== stats =====

function updateStats() {
  const plain = htmlToPlain(bodyEditor.innerHTML);
  statsEl.textContent = formatStats(countStats(plain));
}

// ============================================================= toolbar =====

/** Reflect the caret's formatting in the toolbar's pressed states. */
export function updateToolbarState() {
  if (!rt.selectionInEditor()) return;

  const states = {
    bold: rt.queryState('bold'),
    italic: rt.queryState('italic'),
    underline: rt.queryState('underline'),
    strikeThrough: rt.queryState('strikeThrough'),
    insertUnorderedList: rt.queryState('insertUnorderedList'),
    insertOrderedList: rt.queryState('insertOrderedList'),
    justifyLeft: rt.queryState('justifyLeft'),
    justifyCenter: rt.queryState('justifyCenter'),
    justifyRight: rt.queryState('justifyRight'),
  };

  for (const [command, active] of Object.entries(states)) {
    const node = $(`.tool[data-cmd="${command}"]`, toolbar);
    if (node) {
      node.classList.toggle('is-active', Boolean(active));
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  const block = rt.queryBlock();
  for (const node of $$('.tool[data-block]', toolbar)) {
    node.classList.toggle('is-active', node.dataset.block === block);
  }

  const highlightNode = $('.tool[data-highlight]', toolbar);
  if (highlightNode) {
    highlightNode.classList.toggle('is-active', inTag('MARK'));
  }
}

/** True when the selection's common ancestor sits inside `tagName`. */
function inTag(tagName) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== bodyEditor) {
    if (node.tagName === tagName) return true;
    node = node.parentNode;
  }
  return false;
}

/**
 * After a formatting change, push the new HTML into the note.
 *
 * Formatting does not raise an `input` event, so without this the change would
 * live only in the DOM until the next keystroke.
 */
function syncFormattingToNote() {
  const note = currentNote();
  if (!note) return;
  updateContent(note.id, { body: bodyEditor.innerHTML });
  updateStats();
  updateToolbarState();
}

function initToolbar() {
  toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('.tool');
    if (!button) return;
    if (button.id === 'symbolBtn' || button.id === 'findBtn' || button.id === 'clearFormatBtn') return;

    event.preventDefault();

    if (button.dataset.cmd) {
      rt.exec(button.dataset.cmd);
      syncFormattingToNote();
      return;
    }

    if (button.dataset.block) {
      rt.setBlock(button.dataset.block);
      syncFormattingToNote();
      return;
    }

    if (button.dataset.highlight) {
      rt.toggleInline('mark');
      syncFormattingToNote();
    }
  });

  // Buttons must not steal focus, or the selection is lost before the command
  // runs — the single most common bug in contenteditable toolbars.
  toolbar.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.tool') || event.target.closest('.select')) event.preventDefault();
  });

  $('#clearFormatBtn').addEventListener('click', () => {
    rt.exec('removeFormat');
    rt.exec('formatBlock', '<p>');
    syncFormattingToNote();
  });

  fontSelect.addEventListener('change', () => {
    const note = currentNote();
    if (!note) return;
    bodyEditor.style.fontFamily = fontSelect.value;
    updateNote(note.id, { font: fontSelect.value }, { immediate: false });
  });
}

// ============================================================ focus mode ==

/** Dim every block except the one being edited. */
function applyFocusMode() {
  const enabled = Boolean(state.settings.focusMode);
  document.documentElement.dataset.focusMode = enabled ? 'true' : 'false';
  if (!enabled) {
    for (const node of $$('.is-focused', bodyEditor)) node.classList.remove('is-focused');
    return;
  }
  refreshFocusTarget();
}

function refreshFocusTarget() {
  if (!state.settings.focusMode) return;
  const block = rt.currentBlock();
  for (const node of Array.from(bodyEditor.children)) {
    node.classList.toggle('is-focused', node === block);
  }
}

// ======================================================= typewriter scroll =

/**
 * Keep the caret's line at a comfortable height in the viewport.
 *
 * Uses a direct `scrollTop` adjustment rather than `scrollIntoView`, because
 * the latter insists on placing the caret at an edge and fights smooth
 * scrolling.
 */
function typewriterScroll() {
  if (!state.settings.typewriter) return;
  if (document.activeElement !== bodyEditor) return;
  if (rt.currentBlock() === null) return;

  const rect = rt.caretRect();
  if (!rect) return;

  const viewport = editorScroll.getBoundingClientRect();
  const target = viewport.top + viewport.height * 0.42;
  const delta = rect.top - target;

  // A dead zone stops the page creeping on every keystroke.
  if (Math.abs(delta) > 6) editorScroll.scrollTop += delta;
}

// ============================================================== editing ====

/**
 * React to a change in the body.
 *
 * Keystrokes are the hot path, so the work is split: state updates
 * immediately, statistics and the note write are debounced, and the focus
 * highlight waits for the next frame.
 */
const debouncedStats = debounce(updateStats, 180);
const afterTyping = debounce(() => {
  const note = currentNote();
  if (!note) return;
  updateContent(note.id, { body: bodyEditor.innerHTML });
}, 700);

function handleBodyInput() {
  const note = currentNote();
  if (!note) return;

  // Autocorrect first, so the note stores the replaced text rather than the
  // `\name` the user typed.
  tryAutoReplace();

  // Schedule the write before doing any DOM reading, so a slow read cannot
  // delay persistence.
  updateContent(note.id, { body: bodyEditor.innerHTML });

  debouncedStats();
  afterTyping();
  editorBodyPlaceholder();
}

/** Hide the placeholder as soon as there is any content. */
function editorBodyPlaceholder() {
  bodyEditor.classList.toggle('is-empty', bodyEditor.textContent.trim() === '');
}

function initBody() {
  bodyEditor.addEventListener('input', () => {
    handleBodyInput();
    updateSlashMenu();
  });

  bodyEditor.addEventListener('keydown', handleBodyKeydown);

  // Paste from the outside world is cleaned before it lands, so foreign
  // colours and fonts cannot make text unreadable.
  bodyEditor.addEventListener('paste', (event) => {
    const html = event.clipboardData?.getData('text/html');
    const text = event.clipboardData?.getData('text/plain') ?? '';

    if (!html) return; // Plain text pastes are already safe.

    event.preventDefault();
    // Converting a plain-text paste to blocks keeps paragraph breaks.
    if (!html.trim()) {
      rt.insertText(text);
      return;
    }
    rt.insertHtml(html);
    handleBodyInput();
  });

  // Dropping text or images into the note.
  bodyEditor.addEventListener('drop', (event) => {
    const text = event.dataTransfer?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    rt.insertText(text);
    handleBodyInput();
  });

  bodyEditor.addEventListener('focus', () => {
    document.documentElement.dataset.editing = 'true';
    refreshFocusTarget();
  });
  bodyEditor.addEventListener('blur', () => {
    delete document.documentElement.dataset.editing;
  });

  // `selectionchange` fires on document, so it is throttled to one pass per
  // frame — a caret drag can otherwise fire it hundreds of times a second.
  const onSelectionChange = rafThrottle(() => {
    if (!rt.selectionInEditor()) return;
    updateToolbarState();
    refreshFocusTarget();
    typewriterScroll();
  });
  document.addEventListener('selectionchange', onSelectionChange);

  editorScroll.addEventListener('scroll', rafThrottle(refreshFocusTarget), { passive: true });
}

/** Editor-local keyboard handling. Global shortcuts live in app.js. */
function handleBodyKeydown(event) {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'b') {
    event.preventDefault();
    rt.exec('bold');
    syncFormattingToNote();
    return;
  }
  if (mod && key === 'i') {
    event.preventDefault();
    rt.exec('italic');
    syncFormattingToNote();
    return;
  }
  if (mod && key === 'u') {
    event.preventDefault();
    rt.exec('underline');
    syncFormattingToNote();
    return;
  }
  if (mod && event.shiftKey && key === 'x') {
    event.preventDefault();
    rt.exec('strikeThrough');
    syncFormattingToNote();
    return;
  }
  if (mod && event.shiftKey && key === 'h') {
    event.preventDefault();
    rt.toggleInline('mark');
    syncFormattingToNote();
    return;
  }

  // Tab indents a list item rather than moving focus, which is the behaviour
  // users expect inside a list. Outside one, Tab is left alone so the editor
  // stays keyboard-escapeable.
  if (event.key === 'Tab' && rt.insideList()) {
    event.preventDefault();
    rt.adjustListIndent(event.shiftKey);
    syncFormattingToNote();
  }
}

// The slash menu owns its own trigger detection on every input; the editor only
// has to keep the popup anchored to the caret as it moves.

// ============================================================== title ======

function initTitle() {
  const debouncedTitle = debounce(() => {
    const note = currentNote();
    if (!note) return;
    updateContent(note.id, { title: titleInput.value });
  }, 260);

  titleInput.addEventListener('input', debouncedTitle);

  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // Enter in the title drops into the body, which is where the cursor was
      // almost certainly headed.
      event.preventDefault();
      const note = currentNote();
      if (note) updateContent(note.id, { title: titleInput.value });
      bodyEditor.focus();
      const range = document.createRange();
      range.selectNodeContents(bodyEditor);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      bodyEditor.focus();
    }
  });
}

// ============================================================ note bar =====

function initNoteActions() {
  pinBtn.addEventListener('click', () => {
    const note = currentNote();
    if (note) void togglePin(note.id);
  });

  $('#duplicateBtn').addEventListener('click', () => {
    const note = currentNote();
    if (!note) return;
    void duplicateNote(note.id).then((copy) => {
      if (copy) toast('Note duplicated', { iconName: 'i-copy' });
    });
  });

  $('#trashNoteBtn').addEventListener('click', async () => {
    const note = currentNote();
    if (!note) return;

    const ok = await confirmDialog({
      title: `Move “${displayTitle(note)}” to the trash?`,
      body: 'It stays in the trash and can be restored at any time.',
      confirmLabel: 'Move to trash',
      tone: 'danger',
    });
    if (!ok) return;

    await trashNote(note.id);
    toast('Moved to trash', { iconName: 'i-trash' });
  });

  $('#exportBtn').addEventListener('click', () => {
    const note = currentNote();
    if (!note) return;
    exportMenu($('#exportBtn'), note);
  });
}

// =============================================================== update ====

export function initEditor() {
  initToolbar();
  initBody();
  initTitle();
  initNoteActions();
  editorBodyPlaceholder();

  on('current-changed', () => renderEditor({ animate: true }));

  // Edits made elsewhere (an undo, a tag change) need reflecting, but the
  // editor is usually the source of them — so only sync what differs.
  on('notes-changed', ({ reason, id }) => {
    if (reason === 'saved') return;
    const note = currentNote();
    if (!note || (id && id !== note.id)) return;

    if (reason === 'tags') {
      renderTags();
      return;
    }
    if (reason === 'pin' || reason === 'update') {
      pinBtn.classList.toggle('is-active', note.pinned);
      pinBtn.setAttribute('aria-pressed', note.pinned ? 'true' : 'false');
      if (reason === 'pin') renderTags();
    }
  });

  on('settings-changed', () => {
    bodyEditor.spellcheck = Boolean(state.settings.spellcheck);
    applyFocusMode();
  });

  // Keep the save indicator and stats honest when the note changes underneath.
  on('view-changed', () => renderEditor({ animate: false }));

  renderEditor({ animate: false });
}

export { bodyEditor };
