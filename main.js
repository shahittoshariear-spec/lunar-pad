const { app, BrowserWindow, ipcMain, session, dialog, Menu, MenuItem } = require("electron");
const path = require("path");
const fs = require("fs");

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
    return { notes: [] };
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
    autoHideMenuBar: true,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  session.defaultSession.setSpellCheckerLanguages(["en-US"]);
  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.webContents.on("context-menu", (event, params) => {
    const menu = new Menu();

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length === 0) {
        menu.append(new MenuItem({ label: "No spelling suggestions", enabled: false }));
      } else {
        params.dictionarySuggestions.slice(0, 5).forEach((suggestion) => {
          menu.append(new MenuItem({
            label: suggestion,
            click: () => mainWindow.webContents.replaceMisspelling(suggestion),
          }));
        });
      }
      menu.append(new MenuItem({
        label: "Add to dictionary",
        click: () => session.defaultSession.addWordToSpellCheckerDictionary(params.misspelledWord),
      }));
      menu.append(new MenuItem({ type: "separator" }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ label: "Cut", role: "cut", enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ label: "Copy", role: "copy", enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ label: "Paste", role: "paste", enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(new MenuItem({ label: "Select All", role: "selectAll" }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: "Copy", role: "copy" }));
    }

    if (menu.items.length > 0) menu.popup();
  });
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
