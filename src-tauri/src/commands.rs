//! The bridge between the webview and the Rust core.
//!
//! Every command that touches the store or the disk is declared `async` so it
//! runs off the main thread, which keeps the window responsive. Blocking work
//! is pushed onto the blocking pool explicitly, and the store mutex is never
//! held across an `await`.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::export::{self, ExportFormat};
use crate::model::{normalise_tags, Note};
use crate::search::{self, SearchHit};
use crate::settings::Settings;
use crate::store::{SharedStore, Workspace};

/// Standard message for a poisoned or unavailable lock.
fn lock_error() -> String {
    "internal error: the note store is unavailable".to_string()
}

/// Current data directory, so the UI can show users where their notes live.
#[tauri::command]
pub fn data_dir(state: State<'_, SharedStore>) -> Result<String, String> {
    let store = state.lock().map_err(|_| lock_error())?;
    Ok(store.data_dir())
}

/// Everything the UI needs to render its first frame.
#[tauri::command]
pub async fn bootstrap(state: State<'_, SharedStore>) -> Result<Workspace, String> {
    let mut store = state.lock().map_err(|_| lock_error())?;
    let purged = store.purge_expired_trash();

    // Seed a welcome note on a genuinely fresh install so the editor is never
    // staring at an empty screen.
    if store.notes.is_empty() && !store.settings.seeded {
        store.notes.push(welcome_note());
        store.settings.seeded = true;
        store.mark_notes_dirty();
        store.mark_settings_dirty();
    }

    let workspace = Workspace {
        notes: store.notes.clone(),
        settings: store.settings.clone(),
        data_dir: store.data_dir(),
    };

    store.flush().map_err(|e| format!("could not save: {e}"))?;
    if purged > 0 {
        eprintln!("purged {purged} expired note(s) from the trash");
    }

    Ok(workspace)
}

/// Insert or update a single note, returning the stored version.
///
/// This is the hot path — it fires on a debounce while typing, so it touches
/// one record rather than rewriting the whole collection.
#[tauri::command]
pub async fn save_note(mut note: Note, state: State<'_, SharedStore>) -> Result<Note, String> {
    note.tags = normalise_tags(&note.tags);
    // The plain-text projection is derived, never trusted from the client, so
    // search, previews and word counts can never drift from the stored markup.
    note.plain = crate::export::html_to_text(&note.body);

    let mut store = state.lock().map_err(|_| lock_error())?;
    match store.notes.iter_mut().find(|n| n.id == note.id) {
        Some(existing) => {
            // Creation time is owned by the store, never the client.
            note.created = existing.created;
            if note.updated == 0 {
                note.updated = crate::now_ms();
            }
            *existing = note.clone();
        }
        None => {
            if note.created == 0 {
                note.created = crate::now_ms();
            }
            if note.updated == 0 {
                note.updated = note.created;
            }
            store.notes.push(note.clone());
        }
    }
    store.mark_notes_dirty();
    store.flush().map_err(|e| format!("could not save: {e}"))?;
    Ok(note)
}

/// Replace the whole collection. Used for structural changes like drag
/// reordering, bulk tag edits and restoring from the trash.
#[tauri::command]
pub async fn save_all(notes: Vec<Note>, state: State<'_, SharedStore>) -> Result<(), String> {
    let mut store = state.lock().map_err(|_| lock_error())?;
    store.notes = notes
        .into_iter()
        .filter(|n| !n.id.is_empty())
        .map(|mut n| {
            n.tags = normalise_tags(&n.tags);
            n.plain = crate::export::html_to_text(&n.body);
            n
        })
        .collect();
    store.mark_notes_dirty();
    store.flush().map_err(|e| format!("could not save: {e}"))
}

/// Move a note to the trash, stamping the time so retention can expire it.
#[tauri::command]
pub async fn trash_note(id: String, state: State<'_, SharedStore>) -> Result<i64, String> {
    let now = crate::now_ms();
    let mut store = state.lock().map_err(|_| lock_error())?;
    if let Some(note) = store.notes.iter_mut().find(|n| n.id == id) {
        note.trashed = true;
        note.trashed_at = now;
        note.pinned = false;
        store.mark_notes_dirty();
        store.flush().map_err(|e| format!("could not save: {e}"))?;
    }
    Ok(now)
}

#[tauri::command]
pub async fn restore_note(id: String, state: State<'_, SharedStore>) -> Result<(), String> {
    let mut store = state.lock().map_err(|_| lock_error())?;
    if let Some(note) = store.notes.iter_mut().find(|n| n.id == id) {
        note.trashed = false;
        note.trashed_at = 0;
        store.mark_notes_dirty();
        store.flush().map_err(|e| format!("could not save: {e}"))?;
    }
    Ok(())
}

/// Irreversibly remove one note.
#[tauri::command]
pub async fn purge_note(id: String, state: State<'_, SharedStore>) -> Result<(), String> {
    let mut store = state.lock().map_err(|_| lock_error())?;
    let before = store.notes.len();
    store.notes.retain(|n| n.id != id);
    if store.notes.len() != before {
        store.mark_notes_dirty();
        store.flush().map_err(|e| format!("could not save: {e}"))?;
    }
    Ok(())
}

/// Irreversibly remove everything in the trash. Returns how many went.
#[tauri::command]
pub async fn empty_trash(state: State<'_, SharedStore>) -> Result<usize, String> {
    let mut store = state.lock().map_err(|_| lock_error())?;
    let before = store.notes.len();
    store.notes.retain(|n| !n.trashed);
    let removed = before - store.notes.len();
    if removed > 0 {
        store.mark_notes_dirty();
        store.flush().map_err(|e| format!("could not save: {e}"))?;
    }
    Ok(removed)
}

/// Persist preferences and apply the ones the window itself cares about.
#[tauri::command]
pub async fn save_settings(
    settings: Settings,
    app: AppHandle,
    state: State<'_, SharedStore>,
) -> Result<(), String> {
    {
        let mut store = state.lock().map_err(|_| lock_error())?;
        store.settings = settings.clone();
        store.mark_settings_dirty();
        store.flush().map_err(|e| format!("could not save settings: {e}"))?;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(settings.always_on_top);
    }
    Ok(())
}

/// Ranked search, performed in Rust over the plain-text projection.
#[tauri::command]
pub async fn search_notes(query: String, state: State<'_, SharedStore>) -> Result<Vec<SearchHit>, String> {
    let store = state.lock().map_err(|_| lock_error())?;
    Ok(search::run(&store.notes, &query, crate::now_ms()))
}

/// Render a note to a string, so the UI can put Markdown on the clipboard.
#[tauri::command]
pub async fn render_note(
    id: String,
    format: String,
    state: State<'_, SharedStore>,
) -> Result<String, String> {
    let store = state.lock().map_err(|_| lock_error())?;
    let note = store.notes.iter().find(|n| n.id == id).ok_or("note not found")?;
    Ok(export::render(note, ExportFormat::parse(&format)))
}

/// Ask for a destination and write one note there. Returns the path written.
#[tauri::command]
pub async fn export_note(
    id: String,
    format: String,
    app: AppHandle,
    state: State<'_, SharedStore>,
) -> Result<Option<String>, String> {
    let fmt = ExportFormat::parse(&format);

    // Read everything we need, then release the lock before showing a dialog
    // the user might sit on.
    let (file_name, contents) = {
        let store = state.lock().map_err(|_| lock_error())?;
        let note = store.notes.iter().find(|n| n.id == id).ok_or("note not found")?;
        (
            format!("{}.{}", export::slugify(&note.display_title()), fmt.extension()),
            export::render(note, fmt),
        )
    };

    let app_for_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let picked = app_for_task
            .dialog()
            .file()
            .set_title("Export note")
            .set_file_name(&file_name)
            .add_filter(fmt.name(), &[fmt.extension()])
            .add_filter("All files", &["*"])
            .blocking_save_file();

        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, contents).map_err(|e| format!("could not write the file: {e}"))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
}

/// Bundle every note into one file.
#[tauri::command]
pub async fn export_all(
    format: String,
    app: AppHandle,
    state: State<'_, SharedStore>,
) -> Result<Option<String>, String> {
    let fmt = ExportFormat::parse(&format);

    let (file_name, contents) = {
        let store = state.lock().map_err(|_| lock_error())?;
        let live: Vec<&Note> = store.notes.iter().filter(|n| !n.trashed).collect();
        if live.is_empty() {
            return Err("there are no notes to export".into());
        }
        let stamp = crate::stamp();
        (
            format!("lunar-pad-{stamp}.{}", fmt.extension()),
            render_bundle(&live, fmt),
        )
    };

    let app_for_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let picked = app_for_task
            .dialog()
            .file()
            .set_title("Export all notes")
            .set_file_name(&file_name)
            .add_filter(fmt.name(), &[fmt.extension()])
            .add_filter("All files", &["*"])
            .blocking_save_file();

        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, contents).map_err(|e| format!("could not write the file: {e}"))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
}

/// Combine notes into a single document, with separators between them.
fn render_bundle(notes: &[&Note], fmt: ExportFormat) -> String {
    match fmt {
        ExportFormat::Json => {
            let file = serde_json::json!({
                "version": 2,
                "exportedAt": crate::now_ms(),
                "notes": notes,
            });
            serde_json::to_string_pretty(&file).unwrap_or_else(|_| "{}".into())
        }
        ExportFormat::Html => {
            let mut body = String::new();
            for note in notes {
                body.push_str("<article>\n");
                body.push_str(&format!("<h1>{}</h1>\n", export::escape_html(&note.display_title())));
                body.push_str(&note.body);
                body.push_str("\n</article>\n<hr>\n");
            }
            let title = format!("Lunar Pad — {} notes", notes.len());
            export::render_bundle_html(&title, &body)
        }
        _ => {
            let mut out = String::new();
            for (index, note) in notes.iter().enumerate() {
                if index > 0 {
                    out.push_str(if fmt == ExportFormat::Markdown { "\n\n---\n\n" } else { "\n\n" });
                }
                out.push_str(&export::render(note, fmt));
            }
            out
        }
    }
}

/// Write a timestamped snapshot of everything into the backups folder.
#[tauri::command]
pub async fn backup_now(state: State<'_, SharedStore>) -> Result<String, String> {
    let store = state.lock().map_err(|_| lock_error())?;
    let path = store.backup_now().map_err(|e| format!("backup failed: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Merge notes from a `notes.json` (or exported backup) back into the store.
///
/// Conflicts are resolved by modification time, so this is safe to run over a
/// live workspace and never silently discards newer work.
#[tauri::command]
pub async fn import_backup(
    app: AppHandle,
    state: State<'_, SharedStore>,
) -> Result<Option<usize>, String> {
    let picked = {
        let app_for_task = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app_for_task
                .dialog()
                .file()
                .set_title("Import notes")
                .add_filter("Lunar Pad backup", &["json"])
                .blocking_pick_file()
        })
        .await
        .map_err(|e| format!("import task failed: {e}"))?
    };

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path: PathBuf = picked.into_path().map_err(|e| e.to_string())?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("could not read the file: {e}"))?;

    // Accept both the storage envelope and a plain exported array.
    let incoming: Vec<Note> = serde_json::from_str::<crate::store::NotesEnvelope>(&raw)
        .map(|envelope| envelope.notes)
        .or_else(|_| serde_json::from_str::<Vec<Note>>(&raw))
        .map_err(|_| "that file does not look like a Lunar Pad backup".to_string())?;

    let mut added = 0usize;
    let mut store = state.lock().map_err(|_| lock_error())?;
    for mut note in incoming {
        if note.id.is_empty() {
            continue;
        }
        note.tags = normalise_tags(&note.tags);
        match store.notes.iter_mut().find(|n| n.id == note.id) {
            Some(existing) if existing.updated >= note.updated => {}
            Some(existing) => {
                let created = existing.created;
                note.created = created;
                *existing = note;
                added += 1;
            }
            None => {
                store.notes.push(note);
                added += 1;
            }
        }
    }
    store.mark_notes_dirty();
    store.flush().map_err(|e| format!("could not save: {e}"))?;
    Ok(Some(added))
}

/// Notes removed by [`import_backup`]'s merge when the file held newer copies.
/// Exposed so the UI can show the imported collection immediately.
#[tauri::command]
pub async fn all_notes(state: State<'_, SharedStore>) -> Result<Vec<Note>, String> {
    let store = state.lock().map_err(|_| lock_error())?;
    Ok(store.notes.clone())
}

/// Flush any pending writes. Called before the window closes.
#[tauri::command]
pub async fn flush(state: State<'_, SharedStore>) -> Result<(), String> {
    let mut store = state.lock().map_err(|_| lock_error())?;
    store.flush().map_err(|e| format!("could not save: {e}"))
}

// ---------- Window chrome ----------
// The window is undecorated, so the UI draws its own title bar and drives the
// window through these.

#[tauri::command]
pub fn window_minimise(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn window_toggle_maximise(app: AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let maximised = window.is_maximized().unwrap_or(false);
    if maximised {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
    !maximised
}

#[tauri::command]
pub fn window_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn window_is_maximised(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_maximized().ok())
        .unwrap_or(false)
}

/// The note a brand-new install starts with.
fn welcome_note() -> Note {
    let now = crate::now_ms();
    Note {
        id: format!("note-{now:x}-welcome"),
        title: "Welcome to Lunar Pad".into(),
        body: WELCOME_BODY.into(),
        plain: "Everything you type is saved automatically — there is no save button, and nothing leaves your computer. Type / on an empty line for the quick-insert menu, or press Ctrl+K to jump anywhere.".into(),
        tags: vec!["getting started".into()],
        created: now,
        updated: now,
        ..Default::default()
    }
}

const WELCOME_BODY: &str = "<h2>Welcome to Lunar Pad</h2>\
<p>Everything you type is saved automatically — there is no save button, and nothing leaves your computer.</p>\
<p>Notes live as tabs down the left. Drag one to reorder it, click the pin to keep it on top, or type in the search box to filter instantly.</p>\
<h3>Worth knowing</h3>\
<ul>\
<li><b>Ctrl+K</b> opens the command palette — jump to any note or run any action without touching the mouse.</li>\
<li><b>Ctrl+P</b> pins the current note; <b>Ctrl+D</b> duplicates it.</li>\
<li>Deleted notes go to the <b>trash</b> first, so a mistake is always recoverable.</li>\
<li>Type <b>#tags</b> to group notes, then search with <code>#tag</code> to filter by them.</li>\
<li>Type <b>\\theta</b> followed by a space to get θ, or use the Ω button.</li>\
<li>Switch on <b>focus mode</b> in settings to dim everything but the line you are on.</li>\
</ul>\
<p>Delete this note whenever you are ready.</p>";
