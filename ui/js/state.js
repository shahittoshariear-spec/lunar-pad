/**
 * Application state and persistence.
 *
 * Notes are held in the same order Rust stores them, which is the user's
 * custom order. Display ordering is derived on demand rather than being baked
 * into the array, so changing the sort mode can never disturb that order.
 *
 * Writes are debounced per note and funnelled through `flushPending()`. Any
 * structural change (trashing, reordering, editing tags) flushes first, so a
 * pending keystroke can never be overwritten by a later bulk write.
 */

import { api } from './api.js';
import { htmlToPlain, newId } from './text.js';

/** How long typing pauses before a note is written. */
const SAVE_DEBOUNCE = 450;

export const state = {
  notes: [],
  /** Mirrors the Rust `Settings` shape. Populated by `load()`. */
  settings: {
    themeMode: 'preset',
    themePreset: 'lunar',
    customHue: 232,
    themeScheme: 'dark',
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
  currentId: null,
  /** 'notes' or 'trash'. */
  view: 'notes',
  query: '',
  /** Map of note id → search hit, or null when no search is active. */
  results: null,
  dataDir: '',
  loaded: false,
};

// ============================================================== events =====

const listeners = new Map();

/** Subscribe to a state event. Returns an unsubscribe function. */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, detail) {
  for (const handler of listeners.get(event) ?? []) {
    try {
      handler(detail);
    } catch (error) {
      console.error(`listener for "${event}" failed`, error);
    }
  }
}

// ============================================================== saving =====

let saveTimer = null;
const dirtyIds = new Set();
/** Guards against two overlapping flushes writing the same note. */
let flushing = null;

function reportSave(saveState, error) {
  emit('save-state', { state: saveState, error });
}

/** Mark a note as needing a write, and restart the debounce. */
export function scheduleSave(id) {
  dirtyIds.add(id);
  reportSave('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushPending().catch(() => {
      /* surfaced through the save-state event */
    });
  }, SAVE_DEBOUNCE);
}

/**
 * Write every dirty note immediately.
 *
 * Safe to call concurrently: a second call joins the first rather than racing
 * it, which matters when a structural change lands mid-debounce.
 */
export function flushPending() {
  clearTimeout(saveTimer);

  if (flushing) {
    // Chain onto the in-flight flush, then handle anything still dirty.
    return flushing.then(() => (dirtyIds.size > 0 ? flushPending() : undefined));
  }

  if (dirtyIds.size === 0) return Promise.resolve();

  const ids = Array.from(dirtyIds);
  dirtyIds.clear();
  const payload = ids
    .map((id) => state.notes.find((note) => note.id === id))
    .filter(Boolean);

  if (payload.length === 0) {
    reportSave('saved');
    return Promise.resolve();
  }

  flushing = (async () => {
    try {
      const saved = await Promise.all(payload.map((note) => api.saveNote(note)));
      adoptSavedNotes(saved);
      reportSave('saved');
    } catch (error) {
      // Put the notes back in the queue so a retry cannot lose them.
      for (const id of ids) dirtyIds.add(id);
      reportSave('error', error);
      throw error;
    } finally {
      flushing = null;
    }
  })();

  return flushing;
}

/**
 * Accept the stored version of notes the core just returned.
 *
 * Rust recomputes the plain-text projection on every save, so this is also how
 * the frontend picks up an authoritative `plain`.
 */
function adoptSavedNotes(saved) {
  let changed = false;
  for (const note of saved) {
    const index = state.notes.findIndex((existing) => existing.id === note.id);
    if (index === -1) continue;
    const current = state.notes[index];
    // Keep the live object identity only if nothing meaningful differs, so we
    // do not clobber an edit the user made while the write was in flight.
    if (current.updated === note.updated) {
      state.notes[index] = note;
      changed = true;
    }
  }
  if (changed) emit('notes-changed', { reason: 'saved' });
}

/**
 * Run a structural change.
 *
 * Pending edits are flushed first so the change is applied to notes that match
 * what is on disk.
 */
async function structural(work) {
  await flushPending().catch(() => {});
  return work();
}

// ============================================================ ordering =====

/** Pinned notes always lead; `mode` orders them within their group. */
export function comparator(mode) {
  return (a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

    switch (mode) {
      case 'created':
        return (b.created || 0) - (a.created || 0);
      case 'title':
        return displayTitle(a).localeCompare(displayTitle(b), undefined, { sensitivity: 'base' });
      case 'size':
        return (b.plain || '').length - (a.plain || '').length;
      case 'manual':
        // The array order *is* the manual order.
        return 0;
      case 'updated':
      default:
        return (b.updated || 0) - (a.updated || 0);
    }
  };
}

/**
 * Notes to show, in the order to show them.
 *
 * While a search is active the result ranking wins, because relevance is a
 * stronger signal than recency.
 */
export function visibleNotes() {
  if (state.view === 'trash') {
    return state.notes
      .filter((note) => note.trashed)
      .sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
  }

  const live = state.notes.filter((note) => !note.trashed);

  if (state.query.trim()) {
    if (!state.results) return [];
    return live
      .filter((note) => state.results.has(note.id))
      .sort(
        (a, b) =>
          (state.results.get(b.id)?.score ?? 0) - (state.results.get(a.id)?.score ?? 0),
      );
  }

  return live.sort(comparator(state.settings.sort));
}

export function currentNote() {
  return state.notes.find((note) => note.id === state.currentId) ?? null;
}

export function noteById(id) {
  return state.notes.find((note) => note.id === id) ?? null;
}

/** Title to render, falling back to the first line of the body. */
export function displayTitle(note) {
  const title = (note.title || '').trim();
  if (title) return title;
  const firstLine = (note.plain || '').trim().split('\n')[0].trim();
  return firstLine ? firstLine.slice(0, 60) : 'Untitled';
}

/** The hit for a note in the current search, if any. */
export function hitFor(id) {
  return state.results?.get(id) ?? null;
}

// ================================================================ load =====

export async function load() {
  const workspace = await api.bootstrap();
  state.notes = workspace.notes ?? [];
  state.settings = { ...state.settings, ...(workspace.settings ?? {}) };
  state.dataDir = workspace.dataDir ?? '';
  state.loaded = true;

  // Land on the most recently edited note, which is nearly always the one the
  // user is coming back to.
  const live = state.notes.filter((note) => !note.trashed);
  const recent = live.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  state.currentId = recent[0]?.id ?? null;

  emit('settings-changed', state.settings);
  emit('notes-changed', { reason: 'load' });
  return state;
}

// ============================================================ mutations ====

function blankNote(overrides = {}) {
  const now = Date.now();
  return {
    id: newId(),
    title: '',
    body: '',
    plain: '',
    pinned: false,
    trashed: false,
    tags: [],
    font: '',
    created: now,
    updated: now,
    trashedAt: 0,
    ...overrides,
  };
}

export function createNote({ title = '', body = '' } = {}) {
  const note = blankNote({ title, body, plain: htmlToPlain(body) });
  state.notes.unshift(note);
  state.currentId = note.id;
  state.view = 'notes';

  structural(() => api.saveNote(note)).catch((error) => reportSave('error', error));

  emit('notes-changed', { reason: 'create', id: note.id });
  return note;
}

export async function duplicateNote(id) {
  const source = noteById(id);
  if (!source) return null;

  const copy = blankNote({
    title: `${displayTitle(source)} (copy)`,
    body: source.body,
    plain: source.plain,
    font: source.font,
    tags: [...(source.tags || [])],
    pinned: false,
  });

  return structural(async () => {
    const index = state.notes.findIndex((note) => note.id === id);
    state.notes.splice(Math.max(0, index), 0, copy);
    state.currentId = copy.id;
    await api.saveNote(copy);
    emit('notes-changed', { reason: 'duplicate', id: copy.id });
    return copy;
  });
}

/** Apply a patch to a note and queue a save. */
export function updateNote(id, patch, { immediate = false } = {}) {
  const note = noteById(id);
  if (!note) return null;

  Object.assign(note, patch, { updated: Date.now() });

  if (immediate) {
    dirtyIds.add(id);
    structural(() => flushPending()).catch((error) => reportSave('error', error));
  } else {
    scheduleSave(id);
  }

  emit('notes-changed', { reason: 'update', id });
  return note;
}

/**
 * Replace the note's text content and queue a save.
 *
 * `plain` is recomputed here so previews, stats and the search index are
 * correct before the write completes; Rust recomputes it again on arrival.
 */
export function updateContent(id, { title, body }) {
  const note = noteById(id);
  if (!note) return null;

  if (typeof title === 'string') note.title = title;
  if (typeof body === 'string') {
    note.body = body;
    note.plain = htmlToPlain(body);
  }
  note.updated = Date.now();

  scheduleSave(id);
  emit('notes-changed', { reason: 'content', id });
  return note;
}

export async function togglePin(id) {
  const note = noteById(id);
  if (!note) return;

  note.pinned = !note.pinned;
  note.updated = Date.now();
  dirtyIds.add(id);

  await structural(() => flushPending()).catch((error) => reportSave('error', error));
  emit('notes-changed', { reason: 'pin', id });
}

export async function setTags(id, tags) {
  const note = noteById(id);
  if (!note) return;

  note.tags = tags;
  note.updated = Date.now();
  dirtyIds.add(id);

  await structural(() => flushPending()).catch((error) => reportSave('error', error));
  emit('notes-changed', { reason: 'tags', id });
}

export async function moveNote(fromId, toId, { after = false } = {}) {
  if (fromId === toId) return;

  return structural(async () => {
    const from = state.notes.findIndex((note) => note.id === fromId);
    if (from === -1) return;
    const [moved] = state.notes.splice(from, 1);

    let to = state.notes.findIndex((note) => note.id === toId);
    if (to === -1) {
      state.notes.push(moved);
    } else {
      if (after) to += 1;
      state.notes.splice(to, 0, moved);
    }

    // Dragging is the one thing that only makes sense in custom order, so
    // perform the reorder *and* switch the sort for the user rather than
    // letting the list snap back to a different order.
    if (state.settings.sort !== 'manual') {
      updateSettings({ sort: 'manual' }, { immediate: true });
    }

    await api.saveAll(state.notes);
    emit('notes-changed', { reason: 'reorder' });
  });
}

/** Drag the sort for a note that was just pinned, keeping it near the top. */
export async function trashNote(id) {
  const note = noteById(id);
  if (!note) return;

  return structural(async () => {
    const stamp = await api.trashNote(id);
    note.trashed = true;
    note.trashedAt = typeof stamp === 'number' ? stamp : Date.now();
    note.pinned = false;

    if (state.currentId === id) {
      const next = visibleNotes()[0] ?? state.notes.find((n) => !n.trashed) ?? null;
      state.currentId = next?.id ?? null;
      emit('current-changed', state.currentId);
    }

    emit('notes-changed', { reason: 'trash', id });
  });
}

export async function restoreNote(id) {
  const note = noteById(id);
  if (!note) return;

  return structural(async () => {
    await api.restoreNote(id);
    note.trashed = false;
    note.trashedAt = 0;

    if (state.view === 'trash' && state.currentId === id) {
      const next = visibleNotes()[0] ?? null;
      state.currentId = next?.id ?? null;
      emit('current-changed', state.currentId);
    }

    emit('notes-changed', { reason: 'restore', id });
  });
}

export async function purgeNote(id) {
  const note = noteById(id);
  if (!note) return;

  return structural(async () => {
    await api.purgeNote(id);
    state.notes = state.notes.filter((existing) => existing.id !== id);

    if (state.currentId === id) {
      state.currentId = visibleNotes()[0]?.id ?? null;
      emit('current-changed', state.currentId);
    }

    emit('notes-changed', { reason: 'purge', id });
  });
}

export async function emptyTrash() {
  return structural(async () => {
    const removed = await api.emptyTrash();
    state.notes = state.notes.filter((note) => !note.trashed);

    if (!state.notes.some((note) => note.id === state.currentId)) {
      state.currentId = visibleNotes()[0]?.id ?? null;
      emit('current-changed', state.currentId);
    }

    emit('notes-changed', { reason: 'empty-trash' });
    return removed;
  });
}

/**
 * Put a note back where it was.
 *
 * `trashedAt` in milliseconds resolves to a stable position, because the trash
 * list is ordered by it.
 */
export async function restoreExact(note, index) {
  return structural(async () => {
    const restored = { ...note, trashed: false, trashedAt: 0 };
    state.notes.splice(Math.min(index, state.notes.length), 0, restored);
    state.currentId = restored.id;
    state.view = 'notes';
    await api.saveNote(restored);
    emit('notes-changed', { reason: 'restore-undo', id: restored.id });
    emit('view-changed', state.view);
    emit('current-changed', restored.id);
    return restored;
  });
}

// ============================================================= settings ====

let settingsTimer = null;

/** Update preferences, debounced, and notify the UI straight away. */
export function updateSettings(patch, { immediate = false } = {}) {
  Object.assign(state.settings, patch);
  emit('settings-changed', state.settings);

  clearTimeout(settingsTimer);
  const write = () => {
    api.saveSettings(state.settings).catch((error) => reportSave('error', error));
  };

  if (immediate) write();
  else settingsTimer = setTimeout(write, 300);
}

// =============================================================== search ====

let searchToken = 0;

/**
 * Run a search against the Rust engine.
 *
 * Results are applied only if they belong to the most recent query, so a slow
 * response for an earlier keystroke cannot overwrite a newer one.
 */
export async function runSearch(query) {
  state.query = query;

  if (!query.trim()) {
    state.results = null;
    emit('search-changed', { query, count: null });
    return;
  }

  const token = ++searchToken;
  try {
    const hits = await api.search(query);
    if (token !== searchToken) return;

    state.results = new Map(hits.map((hit) => [hit.id, hit]));
    emit('search-changed', { query, count: hits.length });
  } catch (error) {
    if (token !== searchToken) return;
    state.results = new Map();
    emit('search-changed', { query, count: 0, error });
  }
}

export function setView(view) {
  state.view = view;
  emit('view-changed', view);
}

export function selectNote(id, { preserveView = false } = {}) {
  if (state.currentId === id) return;
  state.currentId = id;
  if (!preserveView && state.view === 'trash') state.view = 'notes';
  emit('current-changed', id);
  emit('view-changed', state.view);
}
