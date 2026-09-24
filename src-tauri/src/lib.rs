//! Lunar Pad — a local-first notepad.
//!
//! The Rust core owns everything that matters: reading and writing notes,
//! ranked search, export, and window management. The webview is a view over
//! that state and holds no data of its own beyond the current editing session.
//!
//! Module map:
//!
//! * [`model`]    — the `Note` type and sort modes.
//! * [`settings`] — user preferences.
//! * [`store`]    — crash-safe persistence.
//! * [`search`]   — the query language and ranking.
//! * [`export`]   — HTML → text/Markdown/HTML conversion.
//! * [`commands`] — the Tauri command surface.

pub mod commands;
pub mod export;
pub mod model;
pub mod search;
pub mod settings;
pub mod store;

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

/// Milliseconds since the Unix epoch.
///
/// Timestamps are stored as `i64` milliseconds because that is what
/// JavaScript's `Date.now()` produces, which keeps the boundary between the
/// two runtimes free of unit conversions.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Compact, human-readable stamp for filenames: `20260924-153012`.
pub fn stamp() -> String {
    let now = now_ms();
    let secs = now / 1000;
    let days = secs / 86_400;
    let time_of_day = secs % 86_400;

    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60
    )
}

/// Convert days since 1970-01-01 into a civil date.
///
/// Howard Hinnant's `civil_from_days` algorithm — correct for all dates we
/// could plausibly care about, and avoids pulling in a date crate for the one
/// place a timestamp needs to be readable.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Shift the epoch to 0000-03-01 so leap days land at the end of the cycle.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);

    // 153 is the length of the five-month block starting in March.
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    if month <= 2 {
        year += 1;
    }

    (year, month, day)
}

/// Build and run the application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Resolve the data directory through Tauri so notes land in the
            // platform-correct place (`%APPDATA%\LunarPad` on Windows).
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));

            let store = store::Store::load(dir);
            app.manage(store::SharedStore::new(store));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::all_notes,
            commands::save_note,
            commands::save_all,
            commands::trash_note,
            commands::restore_note,
            commands::purge_note,
            commands::empty_trash,
            commands::save_settings,
            commands::search_notes,
            commands::render_note,
            commands::export_note,
            commands::export_all,
            commands::import_backup,
            commands::backup_now,
            commands::data_dir,
            commands::flush,
            commands::window_minimise,
            commands::window_toggle_maximise,
            commands::window_close,
            commands::window_is_maximised,
        ])
        .on_window_event(|window, event| {
            // Never lose the last keystrokes: flush synchronously as the
            // window goes away.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<store::SharedStore>() {
                    if let Ok(mut store) = state.lock() {
                        if let Err(err) = store.flush() {
                            eprintln!("final save failed: {err}");
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Lunar Pad failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        // 2024 was a leap year, so day 59 of the year is the 29th of February.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn stamp_has_the_expected_shape() {
        let stamp = stamp();
        assert_eq!(stamp.len(), 15, "unexpected stamp: {stamp}");
        assert_eq!(stamp.chars().nth(8), Some('-'), "unexpected stamp: {stamp}");
        assert!(stamp.chars().all(|c| c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn now_ms_is_after_the_year_2020() {
        assert!(now_ms() > 1_577_836_800_000);
    }
}
