# Notepad (vertical tabs)

A local notepad app: notes appear as vertical tabs down the left side, everything
auto-saves the instant you stop typing (no "Save As" dialog, ever), with a
search bar and basic Bold/Italic formatting.

## Running it (development mode - fastest way to try it)

You'll need [Node.js](https://nodejs.org) installed (the LTS version is fine).

1. Open a terminal (PowerShell or Command Prompt) in this folder.
2. Install dependencies:
   ```
   npm install
   ```
3. Run the app:
   ```
   npm start
   ```

That opens the app in a window immediately - no installer needed. Great for
trying it out or making further tweaks.

## Building a real Windows installer (.exe)

Once you're happy with it:
```
npm run build
```
This uses `electron-builder` to produce a proper installer in the `dist`
folder (something like `Notepad Setup 1.0.0.exe`). Run that installer and
it'll install like any normal Windows app, with a Start Menu entry.

First build can take a few minutes since electron-builder downloads some
tooling the first time. You'll need an internet connection for both `npm
install` and the first `npm run build`.

## Where your notes are stored

Everything is saved to a single `notes.json` file in:
```
%APPDATA%\notepad-app\notes.json
```
(Replace `notepad-app` with whatever `name` you've set in `package.json` if
you change it.) No cloud sync, nothing sent anywhere - it's just a JSON file
on your PC. Worth backing that file up occasionally if your notes matter to
you, since there's no built-in export feature yet.

## Notes on what's here

- `main.js` - the Electron main process; owns the window and reads/writes `notes.json`.
- `preload.js` - a small, deliberately limited bridge so the UI can only ever
  call the two specific save/load functions it needs, not arbitrary Node/file APIs.
- `src/` - the actual app UI (HTML/CSS/JS).

Feel free to come back and ask for changes - more formatting options, note
folders, export to .txt, keyboard shortcuts for switching notes, etc.
