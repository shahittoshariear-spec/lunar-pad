//! User preferences, persisted alongside the notes.

use serde::{Deserialize, Serialize};

use crate::model::SortMode;

/// How the theme was chosen: a curated preset, or a generated one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThemeMode {
    #[default]
    Preset,
    /// Generated from a single hue angle by the frontend.
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EditorWidth {
    Narrow,
    #[default]
    Cozy,
    Wide,
    Full,
}

/// Which way round a *generated* theme should be built. Presets carry their own
/// scheme, but a custom hue needs to be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThemeScheme {
    #[default]
    Dark,
    Light,
}

/// Anything the user can tune. Every field has a sensible default and is
/// individually optional in JSON, so a settings file written by an older
/// build keeps working after an upgrade.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme_mode: ThemeMode,
    pub theme_preset: String,
    pub custom_hue: f32,
    /// Only consulted when `theme_mode` is `Custom`.
    pub theme_scheme: ThemeScheme,
    /// Optional second accent used for gradients; empty means "derive it".
    pub theme_accent: String,

    pub sort: SortMode,
    pub sidebar_collapsed: bool,

    pub font: String,
    pub font_size: u32,
    pub line_height: f32,
    pub editor_width: EditorWidth,

    pub spellcheck: bool,
    /// Keep the cursor's line vertically centred while typing.
    pub typewriter: bool,
    /// Dim everything except the current paragraph.
    pub focus_mode: bool,
    /// Drifting starfield behind the UI.
    pub ambient: bool,
    /// Honour the OS "reduce motion" preference and disable animations.
    pub reduced_motion: bool,
    pub always_on_top: bool,

    /// Set once the welcome note has been seeded.
    pub seeded: bool,
    /// How long the trash keeps notes before they are purged, in days.
    /// `0` disables automatic purging.
    pub trash_retention_days: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme_mode: ThemeMode::Preset,
            theme_preset: "lunar".into(),
            custom_hue: 232.0,
            theme_scheme: ThemeScheme::Dark,
            theme_accent: String::new(),

            sort: SortMode::Updated,
            sidebar_collapsed: false,

            font: String::new(),
            font_size: 16,
            line_height: 1.7,
            editor_width: EditorWidth::Cozy,

            spellcheck: true,
            typewriter: false,
            focus_mode: false,
            ambient: true,
            reduced_motion: false,
            always_on_top: false,

            seeded: false,
            trash_retention_days: 30,
        }
    }
}
