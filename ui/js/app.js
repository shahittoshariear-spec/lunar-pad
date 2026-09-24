/**
 * Lunar Pad — application entry point.
 *
 * Wires the modules together, owns the global keyboard map, drives the custom
 * title bar, and translates settings changes into the CSS custom properties
 * the stylesheet is written against.
 */

import { $, clamp, el, icon, installRipples, prefersReducedMotion, rafThrottle } from './dom.js';
import { api, isDesktop } from './api.js';
import { createAmbient } from './ambient.js';
import {
  aboutDialog,
  closeMenu,
  exportAllMenu,
  exportMenu,
  openMenu,
  settingsDialog,
  shortcutsDialog,
  themeDialog,
} from './dialogs.js';
import { closeFind, initFind, isFindOpen, openFind } from './find.js';
import { initEditor } from './editor.js';
import { close as closePalette, initPalette, isPaletteOpen, togglePalette } from './palette.js';
import { closeSlashMenu, isSlashMenuOpen } from './slash.js';
import { close as closeSymbols, initSymbols, isOpen as symbolsOpen } from './symbols.js';
import { initSidebar } from './sidebar.js';
import { applyTheme } from './themes.js';
import { reportError, toast } from './toast.js';
import {
  createNote,
  currentNote,
  displayTitle,
  duplicateNote,
  emptyTrash,
  flushPending,
  load,
  on,
  runSearch,
  selectNote,
  setView,
  state,
  togglePin,
  trashNote,
  updateSettings,
  visibleNotes,
} from './state.js';

const appEl = $('#app');
const sidebarEl = $('#sidebar');
const saveStatus = $('#saveStatus');
const saveText = $('#saveText');
const searchWrap = $('#searchWrap');
const searchInput = $('#searchInput');
const sortSelect = $('#sortSelect');
const trashToggle = $('#trashToggle');
const focusBtn = $('#focusBtn');
const typerBtn = $('#typerBtn');
const ambientCanvas = $('#stars');

let ambient = null;

// =============================================================== settings ==

/** Editor width presets, as a CSS length for the reading column. */
const EDITOR_WIDTHS = {
  narrow: '38rem',
  cozy: '46rem',
  wide: '60rem',
  full: '100%',
};

/** Bounds for dragging the note list's edge. */
const SIDEBAR_MIN = 208;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 280;

/**
 * Push the settings into the document.
 *
 * All of this is expressed as custom properties or data attributes, so the
 * stylesheet remains the only place that decides how something looks.
 */
function applySettings(settings, { animateTheme = true } = {}) {
  const root = document.documentElement;

  const themeKey = `${settings.themeMode}:${settings.themePreset}:${settings.customHue}:${settings.themeScheme}`;
  const themeChanged = themeKey !== lastThemeKey;
  lastThemeKey = themeKey;

  applyTheme(
    {
      mode: settings.themeMode,
      preset: settings.themePreset,
      hue: settings.customHue,
      scheme: settings.themeScheme,
    },
    { animate: animateTheme && themeChanged },
  );

  root.style.setProperty('--base-size', `${settings.fontSize || 16}px`);
  root.style.setProperty('--editor-line', String(settings.lineHeight || 1.7));
  root.style.setProperty('--font-body', settings.font ? settings.font : 'var(--font-ui)');
  root.style.setProperty('--editor-measure', EDITOR_WIDTHS[settings.editorWidth] ?? EDITOR_WIDTHS.cozy);
  root.style.setProperty('--sidebar-w', `${settings.sidebarWidth || SIDEBAR_DEFAULT}px`);

  root.dataset.reducedMotion = settings.reducedMotion || prefersReducedMotion() ? 'true' : 'false';
  root.dataset.focusMode = settings.focusMode ? 'true' : 'false';

  appEl.classList.toggle('sidebar-hidden', Boolean(settings.sidebarCollapsed));

  // Match the window backdrop to the theme, so resizing never flashes a
  // different shade at the edges.
  const surface = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (surface) document.body.style.background = surface;

  ambient?.setEnabled(settings.ambient);
  ambient?.setStill(settings.reducedMotion || prefersReducedMotion());
  // Stars are tinted from the accent, so they must be re-read after a theme
  // change — but not on every settings write, which would be wasteful.
  if (themeChanged) ambient?.refresh();

  syncToggle(focusBtn, settings.focusMode);
  syncToggle(typerBtn, settings.typewriter);

  if (sortSelect.value !== settings.sort) sortSelect.value = settings.sort;
}

/** Identity of the applied theme, so unchanged writes cost nothing. */
let lastThemeKey = '';

function syncToggle(button, on) {
  button.classList.toggle('is-active', Boolean(on));
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// =========================================================== save status ==

const SAVE_LABELS = {
  idle: 'Ready',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};

function showSaveState({ state: status, error }) {
  saveStatus.dataset.state = status;
  saveText.textContent = SAVE_LABELS[status] ?? 'Ready';

  const dot = saveStatus.querySelector('.save-dot');
  dot.classList.remove('is-saving', 'is-saved');
  if (status === 'saving') dot.classList.add('is-saving');
  if (status === 'saved') {
    // Re-adding forces the pulse animation to restart on every save.
    void dot.offsetWidth;
    dot.classList.add('is-saved');
  }

  if (status === 'error') {
    reportError('Your last change could not be saved.', () => {
      void flushPending().catch(() => {});
    });
    console.error('save failed', error);
  }
}

// ============================================================== search ====

let searchTimer = null;

function initSearch() {
  searchInput.addEventListener('input', () => {
    searchWrap.classList.toggle('has-value', searchInput.value.length > 0);
    clearTimeout(searchTimer);
    // Short enough to feel instant, long enough to avoid a request per key.
    searchTimer = setTimeout(() => {
      // The search engine only indexes live notes, so searching always drops
      // back out of the trash view.
      if (searchInput.value.trim() && state.view === 'trash') trashToggle.click();
      void runSearch(searchInput.value);
    }, 130);
  });

  $('#searchClear').addEventListener('click', () => {
    searchInput.value = '';
    searchWrap.classList.remove('has-value');
    void runSearch('');
    searchInput.focus();
  });
}

// ============================================================ side panel ==

function initSidebarControls() {
  $('#newNoteBtn').addEventListener('click', () => {
    createNote();
    requestAnimationFrame(() => $('#titleInput').focus());
  });

  const collapse = (collapsed) =>
    updateSettings({ sidebarCollapsed: collapsed }, { immediate: true });

  $('#collapseSidebar').addEventListener('click', () => collapse(true));
  $('#revealSidebar').addEventListener('click', () => collapse(false));
  $('#focusBtn').addEventListener('click', () => updateSettings({ focusMode: !state.settings.focusMode }));
  $('#typerBtn').addEventListener('click', () => updateSettings({ typewriter: !state.settings.typewriter }));
  $('#themeBtn').addEventListener('click', () => themeDialog());
  $('#settingsBtn').addEventListener('click', () => settingsDialog());
  $('#helpBtn').addEventListener('click', () => shortcutsDialog());

  sortSelect.addEventListener('change', () => updateSettings({ sort: sortSelect.value }, { immediate: true }));

  trashToggle.addEventListener('click', () => {
    const next = state.view === 'trash' ? 'notes' : 'trash';
    setView(next);

    const inTrash = next === 'trash';
    trashToggle.classList.toggle('is-active', inTrash);
    trashToggle.setAttribute('aria-pressed', inTrash ? 'true' : 'false');
    trashToggle.title = inTrash ? 'Back to notes' : 'Show trash';
  });

  $('#moreBtn').addEventListener('click', (event) => {
    const trashCount = state.notes.filter((note) => note.trashed).length;

    openMenu(
      event.currentTarget,
      [
        { label: 'New note', iconId: 'i-plus', shortcut: 'Ctrl N', run: () => createNote() },
        { separator: true },
        {
          label: 'Change appearance',
          iconId: 'i-palette',
          shortcut: 'Ctrl ⇧ T',
          run: () => themeDialog(),
        },
        {
          label: state.settings.ambient ? 'Hide starfield' : 'Show starfield',
          iconId: 'i-sparkles',
          run: () => updateSettings({ ambient: !state.settings.ambient }),
        },
        {
          label: state.settings.sidebarCollapsed ? 'Show note list' : 'Hide note list',
          iconId: 'i-sidebar',
          shortcut: 'Ctrl \\',
          run: () => updateSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed }, { immediate: true }),
        },
        { separator: true },
        {
          label: 'Export all notes…',
          iconId: 'i-download',
          run: () => exportAllMenu($('#moreBtn')),
        },
        {
          label: 'Import notes…',
          iconId: 'i-upload',
          run: async () => {
            try {
              const added = await api.importBackup();
              if (added == null) return;
              toast(`${added} note${added === 1 ? '' : 's'} imported`, { iconName: 'i-upload' });
            } catch (error) {
              reportError(isDesktop ? 'That file could not be imported.' : 'Importing needs the desktop app.');
              console.error(error);
            }
          },
        },
        {
          label: 'Back up now',
          iconId: 'i-database',
          run: async () => {
            try {
              await api.backupNow();
              toast('Backup saved', { iconName: 'i-database' });
            } catch (error) {
              reportError('Could not write the backup.');
              console.error(error);
            }
          },
        },
        { separator: true },
        {
          label: trashCount > 0 ? `Empty trash (${trashCount})` : 'Trash is empty',
          iconId: 'i-trash',
          danger: true,
          run: async () => {
            if (trashCount === 0) {
              toast('The trash is already empty', { iconName: 'i-info' });
              return;
            }
            const { confirmDialog } = await import('./dialogs.js');
            const ok = await confirmDialog({
              title: 'Empty the trash?',
              body: `${trashCount} note${trashCount === 1 ? '' : 's'} will be permanently deleted.`,
              confirmLabel: 'Empty trash',
            });
            if (!ok) return;
            const removed = await emptyTrash();
            toast(`${removed} note${removed === 1 ? '' : 's'} deleted`, { iconName: 'i-trash' });
          },
        },
        { separator: true },
        { label: 'Keyboard shortcuts', iconId: 'i-keyboard', shortcut: 'Ctrl /', run: () => shortcutsDialog() },
        { label: 'About Lunar Pad', iconId: 'i-info', run: () => aboutDialog() },
      ],
      { align: 'left' },
    );
  });
}

// ============================================================== window ====

/**
 * Dragging the note list's edge to resize it.
 *
 * Pointer capture keeps the drag alive when the pointer leaves the 8px strip,
 * which is essential — nobody drags in a perfectly straight line. The width is
 * written straight to the CSS variable during the drag (with the sidebar's
 * transition suspended) and only persisted on release, so a drag does not
 * queue dozens of settings writes.
 */
function initSidebarResize() {
  const resizer = $('#sidebarResizer');
  if (!resizer) return;

  const root = document.documentElement;
  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  const applyWidth = (value) => root.style.setProperty('--sidebar-w', `${value}px`);

  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    dragging = true;
    startX = event.clientX;
    startWidth = sidebarEl.getBoundingClientRect().width;

    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('is-dragging');
    root.classList.add('is-resizing');
  });

  resizer.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const next = clamp(Math.round(startWidth + (event.clientX - startX)), SIDEBAR_MIN, SIDEBAR_MAX);
    applyWidth(next);
  });

  const finish = (event) => {
    if (!dragging) return;
    dragging = false;

    resizer.classList.remove('is-dragging');
    root.classList.remove('is-resizing');
    if (resizer.hasPointerCapture?.(event.pointerId)) resizer.releasePointerCapture(event.pointerId);

    updateSettings(
      { sidebarWidth: Math.round(sidebarEl.getBoundingClientRect().width) },
      { immediate: true },
    );
  };

  resizer.addEventListener('pointerup', finish);
  resizer.addEventListener('pointercancel', finish);

  // Double-click restores the default width. The horizontal axis makes this
  // guessable, and the two arrow keys make it reachable without a pointer.
  resizer.addEventListener('dblclick', () => {
    applyWidth(SIDEBAR_DEFAULT);
    updateSettings({ sidebarWidth: SIDEBAR_DEFAULT }, { immediate: true });
  });

  resizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 32 : 8;
    const current = sidebarEl.getBoundingClientRect().width;

    if (event.key === 'ArrowLeft') event.preventDefault();
    else if (event.key === 'ArrowRight') event.preventDefault();
    else if (event.key === 'Home') event.preventDefault();
    else return;

    const next =
      event.key === 'Home'
        ? SIDEBAR_DEFAULT
        : clamp(
            Math.round(current + (event.key === 'ArrowRight' ? step : -step)),
            SIDEBAR_MIN,
            SIDEBAR_MAX,
          );

    applyWidth(next);
    updateSettings({ sidebarWidth: next }, { immediate: true });
  });
}

function initWindowChrome() {
  $('#winMin').addEventListener('click', () => api.windowMinimise());

  const maxButton = $('#winMax');
  const maxIcon = $('#winMaxIcon');

  const syncMaxIcon = async () => {
    const maximised = await api.windowIsMaximised();
    maxIcon?.setAttribute('href', maximised ? '#i-restore-win' : '#i-maximise');
    maxButton.title = maximised ? 'Restore' : 'Maximise';
  };

  maxButton.addEventListener('click', async () => {
    await api.windowToggleMaximise();
    await syncMaxIcon();
  });

  // Double-clicking the empty part of the title bar should maximise, which is
  // what every native window does.
  const dragRegion = $('.titlebar-drag');
  dragRegion.addEventListener('dblclick', async () => {
    await api.windowToggleMaximise();
    await syncMaxIcon();
  });

  $('#winClose').addEventListener('click', async () => {
    // Never lose the last keystrokes on the way out.
    await flushPending().catch(() => {});
    api.windowClose();
  });

  // Maximise state can change without this window doing anything, so poll on
  // resize — throttled to a frame, since a drag-resize fires continuously.
  window.addEventListener('resize', rafThrottle(syncMaxIcon));
  void syncMaxIcon();
}

// =========================================================== shortcuts ====

/** Ctrl+1…9 jumps to the nth visible note. */
function jumpToNote(index) {
  const notes = visibleNotes();
  const note = notes[index];
  if (!note) return;
  selectNote(note.id);
}

function bumpFontSize(delta) {
  const current = state.settings.fontSize || 16;
  const next = delta === 0 ? 16 : Math.min(24, Math.max(12, current + delta));
  updateSettings({ fontSize: next }, { immediate: true });
  toast(`${next}px`, { duration: 1200 });
}

function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    // Another handler already dealt with this keystroke.
    if (event.defaultPrevented) return;

    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const lower = key.toLowerCase();

    // ---- Escape, in the order overlays stack
    if (key === 'Escape') {
      if (isSlashMenuOpen()) {
        closeSlashMenu();
        return;
      }
      if (isPaletteOpen()) {
        closePalette();
        return;
      }
      if (symbolsOpen()) {
        closeSymbols();
        return;
      }
      if (isFindOpen()) {
        closeFind();
        return;
      }
      closeMenu();
      return;
    }

    if (!mod) return;

    switch (lower) {
      case 'n':
        event.preventDefault();
        createNote();
        requestAnimationFrame(() => $('#titleInput').focus());
        return;

      case 'k':
      case 'p':
        // Ctrl+Shift+P is the other conventional palette binding; Ctrl+P on
        // its own is reserved for pinning, which is checked below.
        if (lower === 'k' || event.shiftKey) {
          event.preventDefault();
          togglePalette();
          return;
        }
        break;

      case 'f':
        event.preventDefault();
        openFind({ replace: true });
        return;

      case 's':
        event.preventDefault();
        void flushPending()
          .then(() => toast('Saved to disk', { iconName: 'i-check', duration: 1500 }))
          .catch(() => {});
        return;

      case 'd':
        event.preventDefault();
        {
          const note = currentNote();
          if (note) {
            void duplicateNote(note.id).then((copy) => {
              if (copy) toast('Note duplicated', { iconId: 'i-copy' });
            });
          }
        }
        return;

      case ',':
        event.preventDefault();
        settingsDialog();
        return;

      case '/':
        event.preventDefault();
        shortcutsDialog();
        return;

      case '\\':
        event.preventDefault();
        updateSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed }, { immediate: true });
        return;

      case 'delete':
      case 'backspace':
        if (!event.shiftKey) break;
        event.preventDefault();
        {
          const note = currentNote();
          if (note) void trashNote(note.id);
        }
        return;

      case '=':
      case '+':
        event.preventDefault();
        bumpFontSize(1);
        return;

      case '-':
        event.preventDefault();
        bumpFontSize(-1);
        return;

      case '0':
        event.preventDefault();
        bumpFontSize(0);
        return;

      default:
        break;
    }

    // Ctrl+Shift+T — appearance.
    if (event.shiftKey && lower === 't') {
      event.preventDefault();
      themeDialog();
      return;
    }

    // Ctrl+P with no shift pins the current note.
    if (!event.shiftKey && lower === 'p') {
      event.preventDefault();
      const note = currentNote();
      if (note) void togglePin(note.id);
      return;
    }

    // Ctrl+1…9.
    if (!event.shiftKey && !event.altKey && /^[1-9]$/.test(key)) {
      event.preventDefault();
      jumpToNote(Number(key) - 1);
    }
  });

  // F2 renames the current note, matching the convention in file managers.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'F2' || event.defaultPrevented) return;
    event.preventDefault();
    const input = $('#titleInput');
    input.focus();
    input.select();
  });
}

// ============================================================== palette ====

function paletteActions() {
  const note = currentNote();
  const trashCount = state.notes.filter((entry) => entry.trashed).length;

  const actions = [
    {
      label: 'New note',
      iconId: 'i-plus',
      shortcut: 'Ctrl N',
      keywords: 'create add blank',
      priority: 6,
      run: () => {
        createNote();
        requestAnimationFrame(() => $('#titleInput').focus());
      },
    },
    {
      label: 'Find and replace',
      iconId: 'i-search',
      shortcut: 'Ctrl F',
      keywords: 'search in note replace',
      run: () => openFind({ replace: true }),
    },
    {
      label: state.settings.focusMode ? 'Turn off focus mode' : 'Turn on focus mode',
      iconId: 'i-target',
      keywords: 'dim paragraph concentrate distraction',
      run: () => updateSettings({ focusMode: !state.settings.focusMode }),
    },
    {
      label: state.settings.typewriter ? 'Turn off typewriter scrolling' : 'Turn on typewriter scrolling',
      iconId: 'i-wrap',
      keywords: 'centre center caret line',
      run: () => updateSettings({ typewriter: !state.settings.typewriter }),
    },
    {
      label: state.settings.ambient ? 'Hide starfield' : 'Show starfield',
      iconId: 'i-sparkles',
      keywords: 'stars background motion ambient',
      run: () => updateSettings({ ambient: !state.settings.ambient }),
    },
    {
      label: 'Change appearance',
      iconId: 'i-palette',
      shortcut: 'Ctrl ⇧ T',
      keywords: 'theme colour color dark light',
      run: () => themeDialog(),
    },
    {
      label: 'Settings',
      iconId: 'i-sliders',
      shortcut: 'Ctrl ,',
      keywords: 'preferences options',
      run: () => settingsDialog(),
    },
    {
      label: 'Export all notes',
      iconId: 'i-download',
      keywords: 'save backup markdown text',
      run: () => exportAllMenu($('#moreBtn') ?? document.body),
    },
    {
      label: 'Back up now',
      iconId: 'i-database',
      keywords: 'snapshot archive safety',
      run: async () => {
        try {
          await api.backupNow();
          toast('Backup saved', { iconName: 'i-database' });
        } catch (error) {
          reportError('Could not write the backup.');
          console.error(error);
        }
      },
    },
    {
      label: 'Import notes',
      iconId: 'i-upload',
      keywords: 'restore merge bring in',
      run: async () => {
        try {
          const added = await api.importBackup();
          if (added == null) return;
          toast(`${added} note${added === 1 ? '' : 's'} imported`, { iconName: 'i-upload' });
        } catch (error) {
          reportError('That file could not be imported.');
          console.error(error);
        }
      },
    },
    {
      label: state.view === 'trash' ? 'Back to notes' : 'Show the trash',
      iconId: 'i-trash',
      keywords: 'deleted restore bin',
      run: () => trashToggle.click(),
    },
    {
      label: 'Keyboard shortcuts',
      iconId: 'i-keyboard',
      shortcut: 'Ctrl /',
      keywords: 'keys help bindings',
      run: () => shortcutsDialog(),
    },
    {
      label: 'About Lunar Pad',
      iconId: 'i-info',
      keywords: 'version credits',
      run: () => aboutDialog(),
    },
  ];

  if (note) {
    actions.unshift(
      {
        label: note.pinned ? 'Unpin this note' : 'Pin this note',
        iconId: 'i-pin',
        shortcut: 'Ctrl P',
        keywords: 'stick top keep',
        run: () => void togglePin(note.id),
      },
      {
        label: 'Duplicate this note',
        iconId: 'i-copy',
        shortcut: 'Ctrl D',
        keywords: 'copy clone',
        run: () => {
          void duplicateNote(note.id).then((copy) => {
            if (copy) toast('Note duplicated', { iconId: 'i-copy' });
          });
        },
      },
      {
        label: 'Export this note',
        iconId: 'i-download',
        keywords: 'save markdown text html json file',
        run: () => exportMenu($('#exportBtn') ?? document.body, note),
      },
      {
        label: `Move “${displayTitle(note)}” to the trash`,
        iconId: 'i-trash',
        shortcut: 'Ctrl ⇧ Del',
        keywords: 'delete remove bin',
        run: () => void trashNote(note.id),
      },
    );
  }

  if (trashCount > 0) {
    actions.push({
      label: `Empty the trash (${trashCount})`,
      iconId: 'i-alert',
      keywords: 'delete forever purge',
      run: async () => {
        const { confirmDialog } = await import('./dialogs.js');
        const ok = await confirmDialog({
          title: 'Empty the trash?',
          body: `${trashCount} note${trashCount === 1 ? '' : 's'} will be permanently deleted.`,
          confirmLabel: 'Empty trash',
        });
        if (!ok) return;
        const removed = await emptyTrash();
        toast(`${removed} note${removed === 1 ? '' : 's'} deleted`, { iconName: 'i-trash' });
      },
    });
  }

  return actions;
}

// ============================================================== preview ===

/** Say so, loudly, when the Rust core is not reachable. */
function showBridgeNotice() {
  const banner = el('div', { class: 'offline-banner', role: 'status' }, [
    icon('i-alert'),
    el('span', {
      text: 'Preview mode: the Rust core is not running, so nothing is being written to disk.',
    }),
  ]);
  $('.body').before(banner);
}

// ================================================================ boot ====

async function boot() {
  installRipples();

  if (!isDesktop) showBridgeNotice();

  // The starfield first, so the background is painted before anything else
  // claims a frame.
  ambient = createAmbient(ambientCanvas);

  try {
    await load();
  } catch (error) {
    console.error('could not read your notes', error);
    reportError('Your notes could not be read. Starting with an empty workspace.');
  }

  applySettings(state.settings, { animateTheme: false });

  initSidebar();
  initEditor();
  initSymbols();
  initFind();
  initPalette(paletteActions);
  initSidebarControls();
  initSidebarResize();
  initWindowChrome();
  initSearch();
  initShortcuts();

  // Last-chance flush if the window goes away without the title-bar button
  // being used (Alt+F4, task-bar close, a system shutdown).
  window.addEventListener('beforeunload', () => {
    void flushPending().catch(() => {});
  });

  searchWrap.classList.toggle('has-value', false);

  on('save-state', showSaveState);
  on('settings-changed', (settings) => applySettings(settings));

  // Focus the editor on launch only when there is something to edit.
  if (currentNote()) {
    requestAnimationFrame(() => $('#editorBody')?.focus());
  }
}

boot();
