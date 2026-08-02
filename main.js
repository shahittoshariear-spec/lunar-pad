const { app, BrowserWindow, ipcMain, session, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

// Memory-saving flags. Disabling hardware acceleration removes Electron's
// separate GPU process entirely - for a plain text app with no animations
// or video, that process isn't buying much, but it does cost real memory.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=128");

function getNotesPath() {
  return path.join(app.getPath("userData"), "notes.json");
}

function loadNotes() {
  try {
    const raw = fs.readFileSync(getNotesPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.notes)) return { notes: [] };
    return parsed;
  } catch (e) {
    return { notes: [] }; // first run, or file doesn't exist yet
  }
}

function saveNotesToDisk(data) {
  fs.writeFileSync(getNotesPath(), JSON.stringify(data, null, 2), "utf-8");
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: "#0d1420",
    autoHideMenuBar: true, // no File/Edit/... menu bar - keeps it clean like a simple notepad
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  session.defaultSession.setSpellCheckerLanguages(["en-US"]);
  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("notes:getAll", () => loadNotes());
ipcMain.handle("notes:saveAll", (event, data) => {
  saveNotesToDisk(data);
  return true;
});

ipcMain.handle("file:saveAs", async (event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: "Text", extensions: ["txt"] },
      { name: "Markdown", extensions: ["md"] },
      { name: "Python", extensions: ["py"] },
      { name: "JSON", extensions: ["json"] },
      { name: "JavaScript", extensions: ["js"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  fs.writeFileSync(result.filePath, content, "utf-8");
  return { ok: true, path: result.filePath };
});
