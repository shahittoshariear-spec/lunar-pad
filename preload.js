const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notesAPI", {
  getAll: () => ipcRenderer.invoke("notes:getAll"),
  saveAll: (data) => ipcRenderer.invoke("notes:saveAll", data),
  saveAs: (data) => ipcRenderer.invoke("file:saveAs", data),
});
