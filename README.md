# Lunar Pad

A local-first notepad with every note kept as a tab down the left side.
Everything saves as you type — there is no Save button, and nothing leaves
your computer.

Rebuilt from the ground up in Rust. The application core is Rust; the window is
rendered by your system's webview.

![Lunar Pad](assets/lunar-pad-icon.png)

## Why Rust

The previous build ran on Electron, which meant shipping a whole browser and a
Node runtime — around 180 MB installed. Lunar Pad is a Tauri application: the
Rust binary is **6.7 MB**, and it uses the WebView2 runtime Windows already has.

More importantly, the parts that matter are now actual Rust rather than
JavaScript:

| Concern | Where it lives |
| --- | --- |
| Reading and writing notes | `src-tauri/src/store.rs` |
| Search ranking and query parsing | `src-tauri/src/search.rs` |
| Export (HTML → Markdown/plain text) | `src-tauri/src/export.rs` |
| The command surface | `src-tauri/src/commands.rs` |
| Interface | `ui/` (HTML, CSS, ES modules) |

Storage, search, export and window management are all in Rust. The webview holds
no state of its own beyond the editing session.

## What is new

**Features**

- **Command palette** (`Ctrl+K`) — one list over every note and every action,
  fuzzy-matched, so the keyboard is always the fastest route.
- **Find and replace** (`Ctrl+F`) inside the open note, with live match
  highlighting, replace-one and replace-all.
- **Trash with undo** — deleting is always reversible. Notes are restorable
  from the trash, and purged automatically after an interval you choose.
- **Tags** — add `#tags` to a note, then search `#tag` to filter by them.
  Search supports quoted phrases and `-exclusions` too.
- **Slash menu** (`/` at the start of a line) — headings, lists, quotes, code
  blocks, dividers, dates, times, word counts.
- **Focus mode** and **typewriter scrolling** for distraction-free work.
- **Export** any note or every note as Markdown, plain text, HTML or JSON, and
  import a backup back in.
- **Automatic backups** — a snapshot is taken on every launch and pruned to the
  last twelve; you can also take one on demand.
- **Per-note fonts**, adjustable text size, line spacing and column width.
- **Statistics** — word count, characters and reading time.

**Animations**

- A drifting starfield behind the interface, tinted from the active theme, which
  stops rendering when the window is hidden.
- Notes dissolve into particles when deleted, in the theme's accent colours.
- Notes fade in on a stagger, and the editor cross-fades when you switch notes.
- Buttons emit ripples; the title bar's save indicator pulses on each write.
- The sidebar collapses with a spring-eased slide.
- Modals rise into place; menus and popups scale from their anchor.
- All of it is disabled by a single toggle, or automatically when your system
  asks for reduced motion.

**Themes**

Fourteen designed palettes — eight dark, six light — plus a hue ring that
generates a complete palette from one colour, in either direction. Switching
themes cross-fades every colour rather than snapping.

## Running it

You need the [Rust toolchain](https://rustup.rs) and the WebView2 runtime
(preinstalled on Windows 10 and 11).

```sh
cd src-tauri
cargo tauri dev
```

## Building an installer

```sh
cd src-tauri
cargo tauri build
```

This produces `Lunar Pad_2.0.0_x64-setup.exe` in
`src-tauri/target/release/bundle/nsis/`. Run it and it installs like any other
Windows app, with a Start Menu entry and an uninstaller.

## Tests

The Rust core has a test suite covering the parts where behaviour is not
obvious — search ranking, the query language, HTML-to-Markdown conversion,
entity handling, filename sanitising and date arithmetic:

```sh
cd src-tauri
cargo test
```

There is also a small helper that checks the interface modules for imports that
do not resolve:

```sh
node tools/lint-imports.mjs
```

## Where your notes are stored

```
%APPDATA%\com.lunarpad.app\
├── notes.json        every note, in your custom order
├── settings.json     your preferences
└── backups\          timestamped snapshots, newest twelve kept
```

Plain JSON throughout. Back it up, diff it, or move it between machines — it is
just a file. Nothing is sent anywhere.

## Keyboard

| | |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Ctrl+N` | New note |
| `Ctrl+F` | Find and replace in this note |
| `Ctrl+P` | Pin the current note |
| `Ctrl+D` | Duplicate the current note |
| `Ctrl+S` | Save immediately |
| `Ctrl+\` | Hide or show the note list |
| `Ctrl+,` | Settings |
| `Ctrl+/` | Every shortcut |
| `Ctrl+1…9` | Jump to the nth note |
| `Ctrl+B/I/U` | Bold, italic, underline |
| `Ctrl+Shift+X` | Strikethrough |
| `Ctrl+Shift+H` | Highlight |
| `\theta` then space | Inserts θ (300 symbols available) |

## Repository layout

```
src-tauri/          the Rust application
  src/
    lib.rs          app setup, time helpers
    model.rs        the Note type
    settings.rs     preferences
    store.rs        crash-safe persistence
    search.rs       query language and ranking
    export.rs       HTML → text, Markdown, HTML
    commands.rs     the Tauri command surface
  icons/            generated from assets/lunar-pad-icon.png
  tauri.conf.json   window, bundle and security configuration
ui/                 the interface
  js/               one module per concern
  css/              tokens, themes, layout, components, content, animation
tools/              development helpers
assets/             source artwork
```

### Notes on the design

**Storage is crash-safe.** Every write goes to a temporary file and is then
renamed over the target, which is atomic on Windows. A crash mid-write cannot
leave a half-written `notes.json`. A backup is taken before the first write of
each session; if `notes.json` ever fails to parse, the bad file is set aside as
`notes.corrupt.json` rather than overwritten.

**Notes are sanitised on the way in.** A note is untrusted input — it may have
been pasted from anywhere, or hand-edited in the JSON file. Stored markup is
reduced to a safe allow-list before it reaches the editor, so an
`<img onerror>` in a note file cannot run. Pasted content is cleaned the same
way, which also strips the foreign colours and fonts that make pasted text
unreadable.

**Remote images are not loaded.** Pasting an image embeds it; a remote image URL
is dropped, because fetching one would tell a third party that you opened the
note.

**Search runs in Rust.** It parses a small query language (bare words are AND-ed,
`"phrases"` and `#tags` are supported, `-word` excludes), scores titles far above
bodies, and returns a preview window centred on the match so the note list shows
*why* something matched.

## Licence

MIT
