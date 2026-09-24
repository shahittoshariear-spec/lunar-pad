//! Durable, crash-safe persistence for notes and settings.
//!
//! Design notes:
//!
//! * Every write goes to a temporary file first and is then renamed over the
//!   target. On Windows `rename` maps to `MoveFileEx` with
//!   `MOVEFILE_REPLACE_EXISTING`, so the swap is atomic — a crash mid-write can
//!   never leave a half-written `notes.json` behind.
//! * Before the *first* write of each session we snapshot the existing file
//!   into `backups/`. That gives one recovery point per launch without paying
//!   for a backup on every keystroke.
//! * Pruning keeps the backup directory bounded.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::model::Note;
use crate::settings::Settings;

const MAX_BACKUPS: usize = 12;

/// What we persist for the notes collection.
///
/// Public because the import path accepts this envelope as well as a bare
/// array, so a user can restore the app's own storage file directly.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotesEnvelope {
    /// Bumped when the on-disk shape changes so future builds can migrate.
    pub version: u32,
    pub notes: Vec<Note>,
}

/// Everything the webview needs on startup, in a single round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub notes: Vec<Note>,
    pub settings: Settings,
    /// Absolute path of the data directory, shown in the About panel so users
    /// can find (and back up) their own files.
    pub data_dir: String,
}

/// Owns the in-memory workspace and knows how to make it durable.
pub struct Store {
    pub notes: Vec<Note>,
    pub settings: Settings,
    dir: PathBuf,
    /// Guards the one-per-session backup so it happens exactly once.
    backed_up: bool,
    /// Coalesces rapid edits: the caller marks dirty, a flush writes.
    dirty_notes: bool,
    dirty_settings: bool,
}

impl Store {
    /// Load from `dir`, creating it if needed. A missing or unreadable file is
    /// treated as "start empty" rather than an error, so a corrupt file can
    /// never make the app unopenable.
    pub fn load(dir: PathBuf) -> Self {
        let notes_path = dir.join("notes.json");
        let settings_path = dir.join("settings.json");

        let notes = match fs::read_to_string(&notes_path) {
            Ok(raw) => match serde_json::from_str::<NotesEnvelope>(&raw) {
                Ok(file) => file.notes,
                // A parse failure is exactly when the backup matters, so keep
                // the bad file around instead of silently overwriting it.
                Err(err) => {
                    eprintln!("notes.json could not be parsed ({err}); starting from an empty set");
                    let _ = fs::rename(&notes_path, dir.join("notes.corrupt.json"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };

        // Any note missing an id would be unusable in the UI.
        let mut notes = notes;
        notes.retain(|n| !n.id.is_empty());

        let settings = fs::read_to_string(&settings_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .unwrap_or_default();

        let _ = fs::create_dir_all(dir.join("backups"));

        Self {
            notes,
            settings,
            dir,
            backed_up: false,
            dirty_notes: false,
            dirty_settings: false,
        }
    }

    pub fn data_dir(&self) -> String {
        self.dir.to_string_lossy().to_string()
    }

    pub fn notes_path(&self) -> PathBuf {
        self.dir.join("notes.json")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    pub fn mark_notes_dirty(&mut self) {
        self.dirty_notes = true;
    }

    pub fn mark_settings_dirty(&mut self) {
        self.dirty_settings = true;
    }

    pub fn has_pending(&self) -> bool {
        self.dirty_notes || self.dirty_settings
    }

    /// Take the existing on-disk notes file and park it in `backups/`.
    /// Called once per session, before the first overwrite.
    fn snapshot_once(&mut self) {
        if self.backed_up {
            return;
        }
        self.backed_up = true;

        let src = self.notes_path();
        if !src.exists() {
            return;
        }
        let dir = self.dir.join("backups");
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let stamp = crate::stamp();
        let _ = fs::copy(&src, dir.join(format!("notes-{stamp}.json")));
        prune_backups(&dir);
    }

    /// Write both files if they have changes. Safe to call on a timer.
    pub fn flush(&mut self) -> io::Result<()> {
        if !self.has_pending() {
            return Ok(());
        }
        self.snapshot_once();

        if self.dirty_notes {
            let file = NotesEnvelope {
                version: 2,
                notes: self.notes.clone(),
            };
            let json = serde_json::to_vec_pretty(&file)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            write_atomic(&self.notes_path(), &json)?;
            self.dirty_notes = false;
        }

        if self.dirty_settings {
            let json = serde_json::to_vec_pretty(&self.settings)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            write_atomic(&self.settings_path(), &json)?;
            self.dirty_settings = false;
        }

        Ok(())
    }

    /// Force a timestamped backup of the current state, on demand.
    pub fn backup_now(&self) -> io::Result<PathBuf> {
        let dir = self.dir.join("backups");
        fs::create_dir_all(&dir)?;
        let stamp = crate::stamp();
        let target = dir.join(format!("manual-{stamp}.json"));
        let file = NotesEnvelope {
            version: 2,
            notes: self.notes.clone(),
        };
        let json = serde_json::to_vec_pretty(&file)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        write_atomic(&target, &json)?;
        prune_backups(&dir);
        Ok(target)
    }

    /// Permanently remove trashed notes older than `retention_days`.
    /// Returns how many notes were purged.
    pub fn purge_expired_trash(&mut self) -> usize {
        let days = self.settings.trash_retention_days;
        if days == 0 {
            return 0;
        }
        let cutoff = crate::now_ms() - (days as i64 * 86_400_000);
        let before = self.notes.len();
        self.notes
            .retain(|n| !(n.trashed && n.trashed_at > 0 && n.trashed_at < cutoff));
        let removed = before - self.notes.len();
        if removed > 0 {
            self.mark_notes_dirty();
        }
        removed
    }
}

/// Write `bytes` to `path` atomically by way of a sibling temp file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");

    {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        // Flush to the platter before the rename, so the rename can only ever
        // publish fully-written content.
        file.sync_all()?;
    }

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

/// Keep only the newest `MAX_BACKUPS` files in the backup directory.
fn prune_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();

    if files.len() <= MAX_BACKUPS {
        return;
    }

    // Oldest first, so the excess is exactly the front of the list.
    files.sort_by_key(|(modified, _)| *modified);
    for (_, path) in files.iter().take(files.len() - MAX_BACKUPS) {
        let _ = fs::remove_file(path);
    }
}

/// Thread-safe handle used as Tauri managed state.
pub type SharedStore = Mutex<Store>;
