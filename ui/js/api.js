/**
 * The bridge to the Rust core.
 *
 * On the desktop the webview talks to Tauri commands over IPC. If that bridge
 * is missing — opened in a plain browser while iterating on the UI, or a
 * misconfigured build — the app falls back to a small in-memory implementation
 * so the interface still renders and edits rather than showing a blank window.
 * `isDesktop` tells the caller which mode it is in so it can say so out loud.
 */

const core = globalThis.__TAURI__?.core;
export const isDesktop = typeof core?.invoke === 'function';

/** Tauri's `invoke`, with a clearer failure than "undefined is not a function". */
function invoke(command, args) {
  return core.invoke(command, args);
}

// ====================================================== preview fallback ====
// Deliberately minimal: enough storage to open, write and organise notes.
// Search, export and import stay desktop-only rather than being reimplemented
// here with subtly different behaviour.

const preview = (() => {
  const STORAGE_KEY = 'lunar-pad-preview';
  const listeners = new Set();

  let state = {
    notes: [],
    settings: {
      themeMode: 'preset',
      themePreset: 'lunar',
      customHue: 232,
      themeAccent: '',
      sort: 'updated',
      sidebarCollapsed: false,
      font: '',
      fontSize: 16,
      lineHeight: 1.7,
      editorWidth: 'cozy',
      spellcheck: true,
      typewriter: false,
      focusMode: false,
      ambient: true,
      reducedMotion: false,
      alwaysOnTop: false,
      seeded: true,
      trashRetentionDays: 30,
    },
    dataDir: 'preview mode (no files are written)',
  };

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state = { ...state, ...JSON.parse(saved) };
  } catch {
    /* a corrupt preview cache is not worth reporting */
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* quota or private mode: the preview is still usable in memory */
    }
    for (const listener of listeners) listener(state.notes);
  }

  const notInPreview = () => {
    throw new Error('This action needs the desktop app.');
  };

  return async function previewInvoke(command, args = {}) {
    switch (command) {
      case 'bootstrap':
        if (state.notes.length === 0) {
          const now = Date.now();
          state.notes.push({
            id: `note-${now.toString(36)}`,
            title: 'Welcome to Lunar Pad',
            body: '<p>Everything you type is saved automatically. This window is running in preview mode, so nothing is written to disk — open the desktop app for the full experience.</p>',
            plain: 'Everything you type is saved automatically.',
            pinned: false,
            trashed: false,
            tags: ['getting started'],
            font: '',
            color: '',
            created: now,
            updated: now,
            trashedAt: 0,
          });
          persist();
        }
        return structuredClone(state);

      case 'save_note': {
        const note = { ...args.note };
        const index = state.notes.findIndex((n) => n.id === note.id);
        if (index === -1) {
          note.created ||= Date.now();
          state.notes.push(note);
        } else {
          note.created = state.notes[index].created;
          state.notes[index] = note;
        }
        persist();
        return note;
      }

      case 'save_all':
        state.notes = args.notes.filter((n) => n.id);
        persist();
        return null;

      case 'trash_note': {
        const now = Date.now();
        const note = state.notes.find((n) => n.id === args.id);
        if (note) Object.assign(note, { trashed: true, trashedAt: now, pinned: false });
        persist();
        return now;
      }

      case 'restore_note': {
        const note = state.notes.find((n) => n.id === args.id);
        if (note) Object.assign(note, { trashed: false, trashedAt: 0 });
        persist();
        return null;
      }

      case 'purge_note':
        state.notes = state.notes.filter((n) => n.id !== args.id);
        persist();
        return null;

      case 'empty_trash': {
        const before = state.notes.length;
        state.notes = state.notes.filter((n) => !n.trashed);
        persist();
        return before - state.notes.length;
      }

      case 'save_settings':
        state.settings = args.settings;
        persist();
        return null;

      // A simple substring match stands in for the ranked search, so the
      // interface is still explorable.
      case 'search_notes': {
        const needle = String(args.query || '').trim().toLowerCase();
        if (!needle || needle.startsWith('#') || needle.startsWith('-')) return [];
        return state.notes
          .filter((n) => !n.trashed)
          .filter(
            (n) =>
              n.title.toLowerCase().includes(needle) ||
              (n.plain || '').toLowerCase().includes(needle),
          )
          .map((n) => ({ id: n.id, score: 1, snippet: (n.plain || '').slice(0, 90) }));
      }

      case 'all_notes':
        return structuredClone(state.notes);

      case 'data_dir':
        return state.dataDir;

      case 'flush':
        return null;

      case 'window_is_maximised':
        return false;

      case 'export_note':
      case 'export_all':
      case 'import_backup':
      case 'backup_now':
      case 'render_note':
        return notInPreview();

      default:
        if (command.startsWith('window_')) return null;
        return notInPreview();
    }
  };
})();

/** Choose the transport once, at module load. */
const call = isDesktop ? invoke : preview;

// ========================================================== command set ====

export const api = {
  /** Everything needed for the first render. */
  bootstrap: () => call('bootstrap'),

  /** Insert or update one note; the stored version comes back. */
  saveNote: (note) => call('save_note', { note }),

  /** Replace the collection wholesale, for structural changes. */
  saveAll: (notes) => call('save_all', { notes }),

  allNotes: () => call('all_notes'),

  trashNote: (id) => call('trash_note', { id }),
  restoreNote: (id) => call('restore_note', { id }),
  purgeNote: (id) => call('purge_note', { id }),
  emptyTrash: () => call('empty_trash'),

  saveSettings: (settings) => call('save_settings', { settings }),

  search: (query) => call('search_notes', { query }),

  renderNote: (id, format) => call('render_note', { id, format }),

  exportNote: (id, format) => call('export_note', { id, format }),
  exportAll: (format) => call('export_all', { format }),
  importBackup: () => call('import_backup'),
  backupNow: () => call('backup_now'),

  dataDir: () => call('data_dir'),
  flush: () => call('flush'),

  windowMinimise: () => call('window_minimise'),
  windowToggleMaximise: () => call('window_toggle_maximise'),
  windowClose: () => call('window_close'),
  windowIsMaximised: () => call('window_is_maximised'),
};
