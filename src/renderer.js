const appEl = document.getElementById("app");
const sidebar = document.getElementById("sidebar");
const sidebarList = document.getElementById("noteList");
const searchInput = document.getElementById("searchInput");
const newNoteBtn = document.getElementById("newNoteBtn");
const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
const revealSidebarBtn = document.getElementById("revealSidebarBtn");
const titleInput = document.getElementById("titleInput");
const bodyEditor = document.getElementById("bodyEditor");
const wordCountEl = document.getElementById("wordCount");
const saveAsBtn = document.getElementById("saveAsBtn");
const boldBtn = document.getElementById("boldBtn");
const italicBtn = document.getElementById("italicBtn");
const underlineBtn = document.getElementById("underlineBtn");
const bulletBtn = document.getElementById("bulletBtn");
const numberBtn = document.getElementById("numberBtn");
const fontSelect = document.getElementById("fontSelect");

let notes = [];
let currentId = null;
let saveTimer = null;
let searchQuery = "";
let draggedId = null;

function uid() {
  return "note-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

// ---------- Persistence ----------

async function loadAll() {
  const data = await window.notesAPI.getAll();
  notes = data.notes || [];
  if (notes.length === 0) {
    notes.push({ id: uid(), title: "", bodyHtml: "", pinned: false, fontFamily: "", order: 0, updatedAt: Date.now() });
  }
  // One-time migration: notes saved before drag-to-reorder existed have no
  // `order` field. Derive one from the old pinned+recency sort so nothing
  // visually jumps around the first time this loads.
  if (notes.some((n) => typeof n.order !== "number")) {
    notes.sort((a, b) => (b.pinned === true) - (a.pinned === true) || b.updatedAt - a.updatedAt);
    notes.forEach((n, i) => { if (typeof n.order !== "number") n.order = i; });
    persist();
  }
  sortNotes();
  currentId = notes[0].id;
}

function sortNotes() {
  notes.sort((a, b) => (b.pinned === true) - (a.pinned === true) || a.order - b.order);
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.notesAPI.saveAll({ notes });
  }, 400);
}

// ---------- Rendering ----------

function renderSidebar() {
  const q = searchQuery.trim().toLowerCase();
  const filtered = notes.filter((n) => {
    if (!q) return true;
    const title = (n.title || "").toLowerCase();
    const body = stripHtml(n.bodyHtml || "").toLowerCase();
    return title.includes(q) || body.includes(q);
  });

  sidebarList.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = q ? "No notes match your search." : "No notes yet.";
    sidebarList.appendChild(empty);
    return;
  }

  filtered.forEach((note) => {
    const tab = document.createElement("div");
    tab.className = "note-tab" + (note.id === currentId ? " active" : "");

    const pinBtn = document.createElement("button");
    pinBtn.className = "note-tab-pin" + (note.pinned ? " pinned" : "");
    pinBtn.textContent = "\u{1F4CC}";
    pinBtn.title = note.pinned ? "Unpin" : "Pin to top";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(note.id);
    });

    const info = document.createElement("div");
    info.className = "note-tab-info";
    const titleEl = document.createElement("div");
    titleEl.className = "note-tab-title";
    titleEl.textContent = note.title?.trim() || "Untitled";
    const previewEl = document.createElement("div");
    previewEl.className = "note-tab-preview";
    previewEl.textContent = stripHtml(note.bodyHtml || "").slice(0, 60) || "No additional text";
    info.appendChild(titleEl);
    info.appendChild(previewEl);

    const delBtn = document.createElement("button");
    delBtn.className = "note-tab-delete";
    delBtn.textContent = "\u00D7";
    delBtn.title = "Delete note";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteNote(note.id);
    });

    tab.appendChild(pinBtn);
    tab.appendChild(info);
    tab.appendChild(delBtn);
    tab.addEventListener("click", () => selectNote(note.id));

    // Dragging while a search filter is active would reorder a subset in a
    // way that doesn't map cleanly back onto the full list, so it's only
    // enabled with no active search.
    if (!q) {
      tab.draggable = true;
      tab.addEventListener("dragstart", () => {
        draggedId = note.id;
        tab.classList.add("dragging");
      });
      tab.addEventListener("dragend", () => {
        tab.classList.remove("dragging");
        draggedId = null;
        document.querySelectorAll(".note-tab.drag-over").forEach((t) => t.classList.remove("drag-over"));
      });
      tab.addEventListener("dragover", (e) => {
        if (!draggedId || draggedId === note.id) return;
        e.preventDefault();
        tab.classList.add("drag-over");
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("drag-over"));
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        tab.classList.remove("drag-over");
        if (!draggedId || draggedId === note.id) return;
        reorderNotes(draggedId, note.id);
      });
    }

    sidebarList.appendChild(tab);
  });
}

function reorderNotes(fromId, toId) {
  const fromIdx = notes.findIndex((n) => n.id === fromId);
  const toIdx = notes.findIndex((n) => n.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [item] = notes.splice(fromIdx, 1);
  notes.splice(toIdx, 0, item);
  // Lock the new arrangement in as the persisted manual order.
  notes.forEach((n, i) => { n.order = i; });
  persist();
  renderSidebar();
}

function renderEditor() {
  const note = notes.find((n) => n.id === currentId);
  if (!note) {
    titleInput.value = "";
    bodyEditor.innerHTML = "";
    bodyEditor.style.fontFamily = "";
    fontSelect.value = "";
    updateWordCount();
    return;
  }
  titleInput.value = note.title || "";
  bodyEditor.innerHTML = note.bodyHtml || "";
  bodyEditor.style.fontFamily = note.fontFamily || "";
  fontSelect.value = note.fontFamily || "";
  updateWordCount();
}

function updateWordCount() {
  const text = stripHtml(bodyEditor.innerHTML).trim();
  const count = text ? text.split(/\s+/).length : 0;
  wordCountEl.textContent = count === 1 ? "1 word" : `${count} words`;
}

// ---------- Actions ----------

function selectNote(id) {
  currentId = id;
  renderSidebar();
  renderEditor();
}

function newNote() {
  const note = { id: uid(), title: "", bodyHtml: "", pinned: false, fontFamily: "", order: -Date.now(), updatedAt: Date.now() };
  notes.unshift(note);
  currentId = note.id;
  persist();
  renderSidebar();
  renderEditor();
  titleInput.focus();
}

function deleteNote(id) {
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  notes.splice(idx, 1);
  if (notes.length === 0) {
    notes.push({ id: uid(), title: "", bodyHtml: "", pinned: false, fontFamily: "", updatedAt: Date.now() });
  }
  if (currentId === id) currentId = notes[0].id;
  persist();
  renderSidebar();
  renderEditor();
}

function togglePin(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.pinned = !note.pinned;
  sortNotes();
  persist();
  renderSidebar();
}

function touchCurrentNote() {
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  note.title = titleInput.value;
  note.bodyHtml = bodyEditor.innerHTML;
  note.updatedAt = Date.now();
  note.order = -Date.now(); // most recently edited floats to the top of its group
  sortNotes();
  persist();
  renderSidebar();
}

// ---------- Formatting ----------

function updateFormatButtons() {
  boldBtn.classList.toggle("active", document.queryCommandState("bold"));
  italicBtn.classList.toggle("active", document.queryCommandState("italic"));
  underlineBtn.classList.toggle("active", document.queryCommandState("underline"));
  bulletBtn.classList.toggle("active", document.queryCommandState("insertUnorderedList"));
  numberBtn.classList.toggle("active", document.queryCommandState("insertOrderedList"));
}

function runCommand(command) {
  bodyEditor.focus();
  document.execCommand(command);
  updateFormatButtons();
  touchCurrentNote();
}

boldBtn.addEventListener("click", () => runCommand("bold"));
italicBtn.addEventListener("click", () => runCommand("italic"));
underlineBtn.addEventListener("click", () => runCommand("underline"));
bulletBtn.addEventListener("click", () => runCommand("insertUnorderedList"));
numberBtn.addEventListener("click", () => runCommand("insertOrderedList"));

fontSelect.addEventListener("change", () => {
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  note.fontFamily = fontSelect.value;
  bodyEditor.style.fontFamily = fontSelect.value;
  note.updatedAt = Date.now();
  persist();
});

bodyEditor.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); runCommand("bold"); }
  if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); runCommand("italic"); }
  if (mod && e.key.toLowerCase() === "u") { e.preventDefault(); runCommand("underline"); }
});

document.addEventListener("selectionchange", () => {
  if (document.activeElement === bodyEditor) updateFormatButtons();
});

// ---------- Title -> Enter moves into the body ----------

titleInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  bodyEditor.focus();
  // Place the cursor at the very start of the body.
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(bodyEditor);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
});

// ---------- Sidebar toggle ----------

function applySidebarState(collapsed) {
  sidebar.classList.toggle("collapsed", collapsed);
  appEl.classList.toggle("sidebar-collapsed", collapsed);
  localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
}

toggleSidebarBtn.addEventListener("click", () => applySidebarState(true));
revealSidebarBtn.addEventListener("click", () => applySidebarState(false));

// ---------- Save As ----------

saveAsBtn.addEventListener("click", async () => {
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  const baseName = (note.title || "note").trim().replace(/[\\/:*?"<>|]/g, "-");
  const content = stripHtml(note.bodyHtml || "");
  const res = await window.notesAPI.saveAs({ defaultName: `${baseName}.txt`, content });
  if (res?.ok) {
    const original = saveAsBtn.textContent;
    saveAsBtn.textContent = "Saved!";
    setTimeout(() => (saveAsBtn.textContent = original), 1200);
  }
});

// ---------- Input wiring ----------

titleInput.addEventListener("input", () => {
  touchCurrentNote();
});

bodyEditor.addEventListener("input", () => {
  touchCurrentNote();
  updateWordCount();
});

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderSidebar();
});

newNoteBtn.addEventListener("click", newNote);

// ---------- Init ----------

(async function init() {
  applySidebarState(localStorage.getItem("sidebarCollapsed") === "1");
  await loadAll();
  renderSidebar();
  renderEditor();
})();
