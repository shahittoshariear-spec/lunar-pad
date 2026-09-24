# Downloads

Two builds of Lunar Pad 2.0.0 for Windows x64. Both are the same application.

| File | Size | Use it if… |
| --- | --- | --- |
| `LunarPad-Setup-2.0.0.exe` | 1.7 MB | You want it installed properly — Start Menu entry, uninstaller, updates over an older copy. **Most people want this one.** |
| `LunarPad.exe` | 6.4 MB | You want to run it without installing anything. Put it wherever you like and double-click it. |

Both need the **WebView2 runtime**, which is already present on Windows 10 and
11. If you are on an older build of Windows 10 without it, install
[WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) first.

Nothing else is required — no Node, no .NET, no Visual C++ redistributable.

## Your notes are not in here

These are just the program. Your notes are written to:

```
%APPDATA%\com.lunarpad.app\notes.json
```

Paste that path into the address bar of File Explorer to open the folder.
Upgrading or reinstalling never touches it.

## A note for whoever maintains this repository

These binaries are committed directly because it keeps downloading them simple.
It is worth knowing the tradeoff: Git stores every version of every file
forever, so each rebuild adds another ~8 MB to the repository permanently, and
that cannot be undone by deleting the file later.

If releases become frequent, [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github)
is the better home for build artifacts — it keeps history clean and gives
people a stable download link. The source is all that strictly needs to live in
the repository; `cargo tauri build` reproduces these files exactly.
