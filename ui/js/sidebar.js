/**
 * The note list.
 *
 * Notes are rendered as tabs stacked down the left, which is the app's core
 * idea: every note is one click away and nothing hides behind a menu.
 *
 * Rendering is split in two so that typing does not rebuild the world. Text
 * edits patch the one affected tab in place; structural changes do a full pass.
 * The full pass is what carries the staggered entrance, which is why it is
 * reserved for moments where the list genuinely changed shape.
 */

import { $, $$, el, icon, replace } from './dom.js';
import {
  displayTitle,
  emptyTrash,
  hitFor,
  moveNote,
  noteById,
  on,
  purgeNote,
  restoreExact,
  restoreNote,
  selectNote,
  state,
  togglePin,
  trashNote,
  visibleNotes,
} from './state.js';
import { absoluteTime, highlightInto } from './text.js';
import { confirmDialog } from './dialogs.js';
import { toast } from './toast.js';

const listEl = $('#noteList');

let draggedId = null;
/** Where a dragged tab would land: `{ id, after }`. */
let dropTarget = null;

const tabFor = (id) => $(`.note-tab[data-id="${CSS.escape(id)}"]`, listEl);

// ============================================================== render =====

function buildEmptyState() {
  const isTrash = state.view === 'trash';
  const query = state.query.trim();

  return el('div', { class: 'empty-state' }, [
    icon(query ? 'i-search' : isTrash ? 'i-trash' : 'i-note'),
    el('strong', {
      text: query ? 'No matches' : isTrash ? 'Trash is empty' : 'No notes yet',
    }),
    el('span', {
      text: query
        ? `Nothing matches “${query}”.`
        : isTrash
          ? 'Deleted notes rest here, and can be brought back.'
          : 'Press Ctrl+N, or use the button below.',
    }),
  ]);
}

/** The text a preview shows when there is no search to excerpt. */
function previewFor(note) {
  return (note.plain || '').split('\n').slice(0, 2).join(' ').slice(0, 90);
}

function buildTab(note, index, query) {
  const isActive = note.id === state.currentId;

  const title = el('span', { class: 'note-tab-title' });
  highlightInto(title, displayTitle(note), query);

  // While searching, the preview becomes the matching excerpt, so the reason a
  // note matched is visible without opening it.
  const hit = hitFor(note.id);
  const previewText = hit?.snippet || previewFor(note) || 'No additional text';
  const preview = el('div', { class: 'note-tab-preview' });
  if (query) highlightInto(preview, previewText, query);
  else preview.textContent = previewText;

  const main = el('div', { class: 'note-tab-main' }, [title, preview]);

  if ((note.tags || []).length > 0) {
    const tagRow = el('div', { class: 'note-tab-tags' });
    for (const tag of note.tags.slice(0, 3)) {
      const chip = el('span', { class: 'chip', text: `#${tag}` });
      // A span rather than a button: nested interactive elements inside a
      // tab stop would make the list ambiguous to screen readers and to the
      // drag handler. Filtering from the chip is available via the palette.
      tagRow.append(chip);
    }
    main.append(tagRow);
  }

  const actions = el('div', { class: 'note-tab-actions' });

  if (note.trashed) {
    actions.append(
      button(
        'note-tab-pin',
        'i-undo',
        'Restore this note',
        async (event) => {
          event.stopPropagation();
          await withDust(tabFor(note.id), () => restoreNote(note.id));
          toast('Note restored', { iconName: 'i-undo' });
        },
      ),
      button('note-tab-del', 'i-x', 'Delete permanently', async (event) => {
        event.stopPropagation();
        const ok = await confirmDialog({
          title: `Delete “${displayTitle(note)}” permanently?`,
          body: 'This cannot be undone. The note will not be kept in the trash.',
          confirmLabel: 'Delete forever',
        });
        if (!ok) return;
        await withDust(tabFor(note.id), () => purgeNote(note.id));
        toast('Note deleted permanently', { iconName: 'i-trash' });
      }),
    );
  } else {
    actions.append(
      button(
        'note-tab-pin',
        'i-pin',
        note.pinned ? 'Unpin' : 'Pin to top',
        async (event) => {
          event.stopPropagation();
          await togglePin(note.id);
        },
      ),
      button('note-tab-del', 'i-trash', 'Move to trash', (event) => {
        event.stopPropagation();
        void requestTrash(note);
      }),
    );
  }

  const tab = el(
    'div',
    {
      class: [
        'note-tab',
        'anim-stagger',
        isActive && 'is-active',
        note.pinned && 'is-pinned',
        note.trashed && 'is-trashed',
      ]
        .filter(Boolean)
        .join(' '),
      style: { '--i': String(index) },
      role: 'option',
      tabindex: isActive ? 0 : -1,
      'aria-selected': isActive ? 'true' : 'false',
      'aria-label': `${displayTitle(note)}${note.pinned ? ', pinned' : ''}`,
      title: `Updated ${absoluteTime(note.updated)}`,
      dataset: { id: note.id },
      onClick: () => selectNote(note.id),
      onKeydown: (event) => handleTabKeydown(event, note),
    },
    [el('span', { class: 'note-tab-rail' }), main, actions],
  );

  if (!note.trashed && !query) attachDragHandlers(tab, note);
  return tab;
}

/** Small helper for the icon-only row actions. */
function button(className, iconId, label, onClick) {
  return el(
    'button',
    {
      class: className,
      type: 'button',
      title: label,
      'aria-label': label,
      onClick,
    },
    [icon(iconId)],
  );
}

/** Up/Down move the selection, Enter opens, Delete trashes. */
function handleTabKeydown(event, note) {
  const notes = visibleNotes();
  const index = notes.findIndex((entry) => entry.id === note.id);

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = notes[Math.min(notes.length - 1, Math.max(0, index + step))];
    if (!next) return;
    selectNote(next.id);
    // Focus follows selection so the list stays navigable from the keyboard.
    requestAnimationFrame(() => tabFor(next.id)?.focus());
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectNote(note.id);
    return;
  }

  if (event.key === 'Delete') {
    event.preventDefault();
    if (note.trashed) {
      void purgeNote(note.id);
    } else {
      void requestTrash(note);
    }
  }
}

/** Trash a note, with an undo that survives the animation. */
async function requestTrash(note) {
  const index = state.notes.indexOf(note);
  const snapshot = { ...note };

  await withDust(tabFor(note.id), () => trashNote(note.id));

  toast('Moved to trash', {
    iconName: 'i-trash',
    action: 'Undo',
    onAction: async () => {
      await restoreExact(snapshot, Math.max(0, index));
      toast('Note restored', { iconName: 'i-undo' });
    },
    duration: 6500,
  });
}

// =============================================================== dust =====

/**
 * Play the dissolve animation for a tab, then run the change.
 *
 * Particles take the accent colours so the effect belongs to whichever theme
 * is active. Reduced-motion users go straight to the change.
 */
function withDust(tab, work) {
  const reduceMotion =
    state.settings.reducedMotion ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduceMotion || !tab) return Promise.resolve(work());

  return new Promise((resolve) => {
    const rect = tab.getBoundingClientRect();
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--accent').trim() || '#6d7cff';
    const companion = styles.getPropertyValue('--accent-2').trim() || accent;

    const overlay = el('div', {
      class: 'dust-overlay',
      style: {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      },
    });

    for (let i = 0; i < 30; i += 1) {
      const size = 2 + Math.random() * 4.5;
      overlay.append(
        el('span', {
          class: 'dust-particle',
          style: {
            left: `${Math.random() * rect.width}px`,
            top: `${Math.random() * rect.height}px`,
            width: `${size}px`,
            height: `${size}px`,
            background: Math.random() > 0.5 ? accent : companion,
            '--dx': `${(Math.random() - 0.5) * 130}px`,
            '--dy': `${18 + Math.random() * 80}px`,
            '--rot': `${(Math.random() - 0.5) * 540}deg`,
            animationDelay: `${Math.random() * 150}ms`,
          },
        }),
      );
    }

    document.body.append(overlay);
    tab.classList.add('is-leaving');

    setTimeout(() => {
      overlay.remove();
      resolve(work());
    }, 280);
  });
}

// =========================================================== drag & drop ==

/**
 * Reordering by dragging.
 *
 * Dropping in the lower half of a tab means "after it", which is what makes
 * this feel precise rather than approximate. The dragged tab stays in place
 * and dims, so the list never jumps around mid-drag.
 */
function attachDragHandlers(tab, note) {
  tab.draggable = true;

  tab.addEventListener('dragstart', (event) => {
    draggedId = note.id;
    dropTarget = null;
    tab.classList.add('is-dragging');
    // A text payload keeps the drag legal in every engine.
    event.dataTransfer.setData('text/plain', note.id);
    event.dataTransfer.effectAllowed = 'move';
  });

  tab.addEventListener('dragend', () => {
    draggedId = null;
    dropTarget = null;
    tab.classList.remove('is-dragging');
    clearDropMarkers();
  });

  tab.addEventListener('dragover', (event) => {
    if (!draggedId || draggedId === note.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const rect = tab.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;

    if (dropTarget?.id === note.id && dropTarget.after === after) return;
    dropTarget = { id: note.id, after };

    clearDropMarkers();
    tab.classList.add('is-drop-target');
    tab.dataset.dropSide = after ? 'after' : 'before';
  });

  tab.addEventListener('dragleave', (event) => {
    // Leaving into a child fires constantly; only a real exit should clear.
    if (tab.contains(event.relatedTarget)) return;
    if (dropTarget?.id === note.id) dropTarget = null;
    tab.classList.remove('is-drop-target');
    delete tab.dataset.dropSide;
  });

  tab.addEventListener('drop', (event) => {
    event.preventDefault();
    const source = draggedId;
    const target = dropTarget;
    draggedId = null;
    dropTarget = null;
    clearDropMarkers();
    if (!source || !target || source === target.id) return;
    void moveNote(source, target.id, { after: target.after });
  });
}

function clearDropMarkers() {
  for (const node of $$('.note-tab.is-drop-target', listEl)) {
    node.classList.remove('is-drop-target');
    delete node.dataset.dropSide;
  }
}

// ============================================================== updates ====

/**
 * Patch one tab's text without rebuilding the list.
 *
 * This runs on every keystroke, so it stays cheap: three text nodes, nothing
 * else. Returns false when the tab is not on screen, which tells the caller a
 * full pass is needed.
 */
function refreshTab(id, query) {
  const tab = tabFor(id);
  const note = noteById(id);
  if (!tab || !note) return false;

  const titleNode = tab.querySelector('.note-tab-title');
  if (titleNode) highlightInto(titleNode, displayTitle(note), query);

  const previewNode = tab.querySelector('.note-tab-preview');
  if (previewNode) {
    const text = hitFor(id)?.snippet || previewFor(note) || 'No additional text';
    if (query) highlightInto(previewNode, text, query);
    else previewNode.textContent = text;
  }

  tab.title = `Updated ${absoluteTime(note.updated)}`;
  return true;
}

/** Move the active styling without a rebuild. */
function refreshActive() {
  for (const tab of $$('.note-tab', listEl)) {
    const active = tab.dataset.id === state.currentId;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  }
}

// ============================================================= full pass ==

export function renderSidebar({ animate = false } = {}) {
  const notes = visibleNotes();
  const query = state.query.trim();

  const fragment = document.createDocumentFragment();

  if (state.view === 'trash' && notes.length > 0) {
    fragment.append(
      el('div', { class: 'list-label' }, [
        el('span', { text: 'In the trash' }),
        el('span', { class: 'count', text: String(notes.length) }),
      ]),
      el(
        'button',
        {
          class: 'view-row is-danger',
          type: 'button',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Empty the trash?',
              body: `${notes.length} note${notes.length === 1 ? '' : 's'} will be permanently deleted. This cannot be undone.`,
              confirmLabel: 'Empty trash',
            });
            if (!ok) return;
            const removed = await emptyTrash();
            toast(`${removed} note${removed === 1 ? '' : 's'} deleted`, { iconName: 'i-trash' });
          },
        },
        [icon('i-alert'), el('span', { text: 'Empty trash' })],
      ),
    );
  }

  if (notes.length === 0) {
    fragment.append(buildEmptyState());
  } else {
    notes.forEach((note, index) => {
      const tab = buildTab(note, index, query);
      // Suppressing the entrance is what makes a search feel immediate.
      if (!animate) tab.style.animation = 'none';
      fragment.append(tab);
    });
  }

  replace(listEl, []);
  listEl.append(fragment);
}

// ================================================================ init ====

export function initSidebar() {
  on('notes-changed', ({ reason }) => {
    const query = state.query.trim();

    // A write completing only updates the authoritative plain text, which the
    // UI already has a local copy of — nothing visible changes.
    if (reason === 'saved') return;

    if ((reason === 'content' || reason === 'update') && refreshTab(state.currentId, query)) {
      refreshActive();
      return;
    }

    renderSidebar({ animate: true });
  });

  on('current-changed', () => {
    refreshActive();
    tabFor(state.currentId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  on('view-changed', () => renderSidebar({ animate: true }));
  on('search-changed', () => renderSidebar({ animate: true }));

  // Only the sort mode changes what the list looks like; other settings (font
  // size, starfield) would otherwise rebuild it for nothing.
  let lastSort = state.settings.sort;
  on('settings-changed', (settings) => {
    if (settings.sort === lastSort) return;
    lastSort = settings.sort;
    renderSidebar({ animate: false });
  });

  renderSidebar({ animate: true });
}
