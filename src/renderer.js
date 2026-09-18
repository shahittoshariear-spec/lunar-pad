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
const themeBtn = document.getElementById("themeBtn");
const themeOverlay = document.getElementById("themeOverlay");
const hueWheel = document.getElementById("hueWheel");
const hueHandle = document.getElementById("hueHandle");
const themeContinueBtn = document.getElementById("themeContinueBtn");
const confirmOverlay = document.getElementById("confirmOverlay");
const confirmTitle = document.getElementById("confirmTitle");
const confirmCancel = document.getElementById("confirmCancel");
const confirmDelete = document.getElementById("confirmDelete");
const symbolBtn = document.getElementById("symbolBtn");
const symbolPanel = document.getElementById("symbolPanel");
const duplicateBtn = document.getElementById("duplicateBtn");
const presetGrid = document.getElementById("presetGrid");
const undoToast = document.getElementById("undoToast");
const undoBtn = document.getElementById("undoBtn");

let lastDeleted = null;
let undoTimer = null;

let notes = [];
let currentId = null;
let saveTimer = null;
let searchQuery = "";
let draggedId = null;
let pendingDeleteId = null;

const PIN_SVG = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v6M14 11v6"/></svg>`;

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
    empty.textContent = q ? "No notes match your search." : "No notes yet - click + above to start one.";
    sidebarList.appendChild(empty);
    return;
  }

  filtered.forEach((note) => {
    const tab = document.createElement("div");
    tab.className = "note-tab" + (note.id === currentId ? " active" : "");
    tab.dataset.id = note.id;

    const pinBtn = document.createElement("button");
    pinBtn.className = "note-tab-pin" + (note.pinned ? " pinned" : "");
    pinBtn.innerHTML = PIN_SVG;
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
    delBtn.innerHTML = TRASH_SVG;
    delBtn.title = "Delete note";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteNote(note.id);
    });

    tab.appendChild(pinBtn);
    tab.appendChild(info);
    tab.appendChild(delBtn);
    tab.addEventListener("click", () => selectNote(note.id));

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
  // textContent reads the live DOM directly - avoids creating and parsing
  // a new element on every keystroke, which stripHtml() would otherwise do.
  const text = bodyEditor.textContent.trim();
  const wordCount = text ? text.split(/\s+/).length : 0;
  const charCount = bodyEditor.textContent.length;
  wordCountEl.textContent = `${wordCount === 1 ? "1 word" : `${wordCount} words`} · ${charCount} char${charCount === 1 ? "" : "s"}`;
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

function duplicateCurrentNote() {
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  const copy = {
    ...note,
    id: uid(),
    title: (note.title?.trim() || "Untitled") + " (copy)",
    pinned: false,
    order: -Date.now(),
    updatedAt: Date.now(),
  };
  notes.unshift(copy);
  currentId = copy.id;
  persist();
  sortNotes();
  renderSidebar();
  renderEditor();
}
duplicateBtn.addEventListener("click", duplicateCurrentNote);

function deleteNote(id) {
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  notes.splice(idx, 1);
  if (notes.length === 0) {
    notes.push({ id: uid(), title: "", bodyHtml: "", pinned: false, fontFamily: "", order: -Date.now(), updatedAt: Date.now() });
  }
  if (currentId === id) currentId = notes[0].id;
  persist();
  renderSidebar();
  renderEditor();
}

function confirmDeleteNote(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  pendingDeleteId = id;
  confirmTitle.textContent = `Delete "${note.title?.trim() || "Untitled"}"?`;
  confirmOverlay.hidden = false;
}

function closeConfirm() {
  confirmOverlay.hidden = true;
  pendingDeleteId = null;
}

confirmCancel.addEventListener("click", closeConfirm);
confirmOverlay.addEventListener("click", (e) => {
  if (e.target === confirmOverlay) closeConfirm();
});

confirmDelete.addEventListener("click", async () => {
  const id = pendingDeleteId;
  confirmOverlay.hidden = true;
  pendingDeleteId = null;
  if (!id) return;
  const tabEl = sidebarList.querySelector(`.note-tab[data-id="${id}"]`);
  if (tabEl) await playDustAnimation(tabEl);

  const idx = notes.findIndex((n) => n.id === id);
  if (idx !== -1) lastDeleted = { note: notes[idx], index: idx };

  deleteNote(id);
  showUndoToast();
});

function showUndoToast() {
  clearTimeout(undoTimer);
  undoToast.hidden = false;
  undoTimer = setTimeout(() => {
    undoToast.hidden = true;
    lastDeleted = null;
  }, 5000);
}

undoBtn.addEventListener("click", () => {
  if (!lastDeleted) return;
  clearTimeout(undoTimer);
  notes.splice(Math.min(lastDeleted.index, notes.length), 0, lastDeleted.note);
  currentId = lastDeleted.note.id;
  lastDeleted = null;
  undoToast.hidden = true;
  sortNotes();
  persist();
  renderSidebar();
  renderEditor();
});

function playDustAnimation(tabEl) {
  return new Promise((resolve) => {
    const rect = tabEl.getBoundingClientRect();
    const color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#5b9bd9";
    const overlay = document.createElement("div");
    overlay.className = "dust-overlay";
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    for (let i = 0; i < 26; i++) {
      const p = document.createElement("span");
      p.className = "dust-particle";
      const startX = Math.random() * rect.width;
      const startY = Math.random() * rect.height;
      const dx = (Math.random() - 0.5) * 100;
      const dy = 24 + Math.random() * 70;
      const size = 2 + Math.random() * 4;
      p.style.left = `${startX}px`;
      p.style.top = `${startY}px`;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      p.style.background = color;
      p.style.setProperty("--dx", `${dx}px`);
      p.style.setProperty("--dy", `${dy}px`);
      p.style.animationDelay = `${Math.random() * 140}ms`;
      overlay.appendChild(p);
    }
    document.body.appendChild(overlay);
    tabEl.classList.add("dust-fading");
    setTimeout(() => { overlay.remove(); resolve(); }, 800);
  });
}

function togglePin(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.pinned = !note.pinned;
  sortNotes();
  persist();
  renderSidebar();
}

function updateActiveTabInPlace() {
  const note = notes.find((n) => n.id === currentId);
  const tabEl = sidebarList.querySelector(`.note-tab[data-id="${currentId}"]`);
  if (!note || !tabEl) return false;
  const titleEl = tabEl.querySelector(".note-tab-title");
  const previewEl = tabEl.querySelector(".note-tab-preview");
  if (titleEl) titleEl.textContent = note.title?.trim() || "Untitled";
  if (previewEl) previewEl.textContent = stripHtml(note.bodyHtml || "").slice(0, 60) || "No additional text";
  return true;
}

function touchCurrentNote() {
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  note.title = titleInput.value;
  note.bodyHtml = bodyEditor.innerHTML;
  note.updatedAt = Date.now();

  // If this note is already first within its pinned/unpinned group, editing
  // it further won't change anywhere it sits - so skip the full re-sort +
  // rebuild and just refresh its own tab's text. This is the common case:
  // after the first keystroke on a note, every subsequent keystroke in the
  // same typing session hits this fast path instead of rebuilding the
  // entire sidebar on every character.
  const siblingsInGroup = notes.filter((n) => n.pinned === note.pinned);
  const alreadyFirst = siblingsInGroup[0]?.id === note.id;

  note.order = -Date.now();

  if (alreadyFirst) {
    persist();
    if (!updateActiveTabInPlace()) renderSidebar(); // fall back if not currently visible (e.g. filtered out)
  } else {
    sortNotes();
    persist();
    renderSidebar();
  }
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

// ---------- Symbols ----------
// Type a backslash-name (like \theta) followed by a space or punctuation,
// and it auto-converts to the symbol - same idea as Word's Math AutoCorrect.
// The same symbols are also browsable/clickable via the Ω toolbar button.

const SYMBOL_CATEGORIES = [
  {
    label: "Greek (lowercase)",
    items: [
      ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"],
      ["zeta", "ζ"], ["eta", "η"], ["theta", "θ"], ["iota", "ι"], ["kappa", "κ"],
      ["lambda", "λ"], ["mu", "μ"], ["nu", "ν"], ["xi", "ξ"], ["omicron", "ο"],
      ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"], ["upsilon", "υ"],
      ["phi", "φ"], ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"],
    ],
  },
  {
    label: "Greek (uppercase)",
    items: [
      ["Gamma", "Γ"], ["Delta", "Δ"], ["Theta", "Θ"], ["Lambda", "Λ"], ["Xi", "Ξ"],
      ["Pi", "Π"], ["Sigma", "Σ"], ["Phi", "Φ"], ["Psi", "Ψ"], ["Omega", "Ω"],
    ],
  },
  {
    label: "Math operators",
    items: [
      ["pm", "±"], ["mp", "∓"], ["times", "×"], ["div", "÷"], ["cdot", "·"],
      ["sqrt", "√"], ["infty", "∞"], ["partial", "∂"], ["nabla", "∇"], ["sum", "∑"],
      ["prod", "∏"], ["int", "∫"], ["oint", "∮"], ["propto", "∝"], ["degree", "°"],
    ],
  },
  {
    label: "Comparison & logic",
    items: [
      ["leq", "≤"], ["geq", "≥"], ["neq", "≠"], ["approx", "≈"], ["equiv", "≡"],
      ["sim", "∼"], ["forall", "∀"], ["exists", "∃"], ["nexists", "∄"], ["therefore", "∴"],
      ["because", "∵"], ["notin", "∉"],
    ],
  },
  {
    label: "Set theory",
    items: [
      ["in", "∈"], ["subset", "⊂"], ["supset", "⊃"], ["subseteq", "⊆"], ["supseteq", "⊇"],
      ["cup", "∪"], ["cap", "∩"], ["emptyset", "∅"],
    ],
  },
  {
    label: "Arrows",
    items: [
      ["rightarrow", "→"], ["leftarrow", "←"], ["leftrightarrow", "↔"], ["Rightarrow", "⇒"],
      ["Leftarrow", "⇐"], ["Leftrightarrow", "⇔"], ["uparrow", "↑"], ["downarrow", "↓"],
    ],
  },
  {
    label: "Misc & currency",
    items: [
      ["angle", "∠"], ["perp", "⊥"], ["parallel", "∥"], ["hbar", "ℏ"], ["aleph", "ℵ"],
      ["star", "★"], ["bullet", "•"], ["dagger", "†"], ["section", "§"], ["para", "¶"],
      ["copyright", "©"], ["reg", "®"], ["trade", "™"], ["check", "✓"], ["xmark", "✗"],
      ["heart", "♥"], ["spade", "♠"], ["club", "♣"], ["diamond", "♦"],
      ["half", "½"], ["quarter", "¼"], ["threequarters", "¾"],
      ["pound", "£"], ["euro", "€"], ["yen", "¥"], ["cent", "¢"], ["ldots", "…"],
    ],
  },
];

const SYMBOL_MAP = {};
SYMBOL_CATEGORIES.forEach((cat) => cat.items.forEach(([name, glyph]) => { SYMBOL_MAP[name] = glyph; }));

function buildSymbolPanel() {
  symbolPanel.innerHTML = "";
  SYMBOL_CATEGORIES.forEach((cat) => {
    const label = document.createElement("div");
    label.className = "symbol-cat-label";
    label.textContent = cat.label;
    symbolPanel.appendChild(label);

    const grid = document.createElement("div");
    grid.className = "symbol-grid";
    cat.items.forEach(([name, glyph]) => {
      const btn = document.createElement("button");
      btn.className = "symbol-item";
      btn.textContent = glyph;
      btn.title = `${name}  (\\${name})`;
      btn.addEventListener("click", () => insertSymbol(glyph));
      grid.appendChild(btn);
    });
    symbolPanel.appendChild(grid);
  });
}

let savedRange = null;
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && bodyEditor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
});

function insertSymbol(glyph) {
  bodyEditor.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  if (savedRange) sel.addRange(savedRange);
  document.execCommand("insertText", false, glyph);
  touchCurrentNote();
  updateWordCount();
  closeSymbolPanel();
}

function openSymbolPanel() {
  if (symbolPanel.children.length === 0) buildSymbolPanel();
  symbolPanel.hidden = false;
}
function closeSymbolPanel() {
  symbolPanel.hidden = true;
}
symbolBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (symbolPanel.hidden) openSymbolPanel();
  else closeSymbolPanel();
});
document.addEventListener("click", (e) => {
  if (!symbolPanel.hidden && !symbolPanel.contains(e.target) && e.target !== symbolBtn) closeSymbolPanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !symbolPanel.hidden) closeSymbolPanel();
});

function trySymbolAutoReplace() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const offset = range.startOffset;
  const textBefore = node.textContent.slice(0, offset);
  const match = textBefore.match(/\\([a-zA-Z]+)([ .,;:!?)\]])$/);
  if (!match) return;
  const glyph = SYMBOL_MAP[match[1]];
  if (!glyph) return;

  const matchStart = offset - match[0].length;
  const editRange = document.createRange();
  editRange.setStart(node, matchStart);
  editRange.setEnd(node, offset);
  editRange.deleteContents();
  const replacement = document.createTextNode(glyph + match[2]);
  editRange.insertNode(replacement);

  const caretRange = document.createRange();
  caretRange.setStart(replacement, replacement.length);
  caretRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caretRange);
}

// ---------- Title -> Enter moves into the body ----------

titleInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  bodyEditor.focus();
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
  trySymbolAutoReplace();
});

let searchDebounce = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = searchInput.value;
    renderSidebar();
  }, 120);
});

newNoteBtn.addEventListener("click", newNote);

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === "n") { e.preventDefault(); newNote(); }
  else if (key === "f") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (key === "d" && document.activeElement !== searchInput) { e.preventDefault(); duplicateCurrentNote(); }
});

// ---------- Theme ----------
// Two ways to theme the app: pick one of the curated presets below (each a
// fully hand-set palette, not just a hue rotation - some are even light
// themes), or drag the ring to craft an infinite custom dark accent.

const THEME_PRESETS = [
  {
    id: "midnight",
    name: "Midnight",
    swatch: "#5b9bd9",
    vars: {
      "--bg": "#0d1420", "--bg-panel": "#131b28", "--bg-editor": "#0f1826",
      "--border": "#202b3d", "--text": "#e7ecf5", "--text-dim": "#7c8aa3",
      "--text-faint": "#4d5871", "--accent": "#5b9bd9", "--accent-soft": "rgba(91, 155, 217, 0.14)",
    },
  },
  {
    id: "mint",
    name: "Mint",
    swatch: "#2fa86b",
    vars: {
      "--bg": "#f4faf6", "--bg-panel": "#ffffff", "--bg-editor": "#fbfffd",
      "--border": "#d8ece0", "--text": "#1c2b22", "--text-dim": "#5b7568",
      "--text-faint": "#8ba796", "--accent": "#2fa86b", "--accent-soft": "rgba(47, 168, 107, 0.14)",
    },
  },
  {
    id: "pastel",
    name: "Pastel Dream",
    swatch: "#b47fd1",
    vars: {
      "--bg": "#faf6fb", "--bg-panel": "#ffffff", "--bg-editor": "#fdfaff",
      "--border": "#ecdff0", "--text": "#2b2035", "--text-dim": "#7a6a88",
      "--text-faint": "#a698b5", "--accent": "#b47fd1", "--accent-soft": "rgba(180, 127, 209, 0.14)",
    },
  },
  {
    id: "ocean",
    name: "Ocean Breeze",
    swatch: "#0fa3a3",
    vars: {
      "--bg": "#f1fbfb", "--bg-panel": "#ffffff", "--bg-editor": "#f7fefe",
      "--border": "#d3eeee", "--text": "#0f2b2b", "--text-dim": "#4c7c7c",
      "--text-faint": "#83aeae", "--accent": "#0fa3a3", "--accent-soft": "rgba(15, 163, 163, 0.14)",
    },
  },
  {
    id: "sunset",
    name: "Sunset",
    swatch: "#ff7a45",
    vars: {
      "--bg": "#1f1410", "--bg-panel": "#2a1c16", "--bg-editor": "#241813",
      "--border": "#3d2a20", "--text": "#fbe9df", "--text-dim": "#c9a08c",
      "--text-faint": "#8f6a5a", "--accent": "#ff7a45", "--accent-soft": "rgba(255, 122, 69, 0.16)",
    },
  },
  {
    id: "rosegold",
    name: "Rose Gold",
    swatch: "#d98e5f",
    vars: {
      "--bg": "#fdf4f1", "--bg-panel": "#ffffff", "--bg-editor": "#fffaf8",
      "--border": "#f3ddd4", "--text": "#3a2420", "--text-dim": "#8a6b62",
      "--text-faint": "#b89890", "--accent": "#d98e5f", "--accent-soft": "rgba(217, 142, 95, 0.15)",
    },
  },
];

const wheelRadius = 100;
let previewHue = null;

function paletteFromHue(hue) {
  return {
    "--bg": `hsl(${hue} 24% 8%)`,
    "--bg-panel": `hsl(${hue} 22% 11%)`,
    "--bg-editor": `hsl(${hue} 22% 9%)`,
    "--border": `hsl(${hue} 18% 19%)`,
    "--text": `hsl(${hue} 20% 92%)`,
    "--text-dim": `hsl(${hue} 12% 62%)`,
    "--text-faint": `hsl(${hue} 10% 40%)`,
    "--accent": `hsl(${hue} 68% 62%)`,
    "--accent-soft": `hsl(${hue} 68% 62% / 0.16)`,
  };
}

function applyVars(vars) {
  Object.entries(vars).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
}

function applyTheme(hue) {
  applyVars(paletteFromHue(hue));
}

function getThemeConfig() {
  const raw = localStorage.getItem("themeConfig");
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  }
  // Back-compat with the earlier hue-only storage format.
  const oldHue = localStorage.getItem("themeHue");
  if (oldHue !== null) return { mode: "hue", hue: Number(oldHue) };
  return null;
}

function saveThemeConfig(config) {
  localStorage.setItem("themeConfig", JSON.stringify(config));
}

function applyStoredTheme(config) {
  if (config.mode === "preset") {
    const preset = THEME_PRESETS.find((p) => p.id === config.presetId) || THEME_PRESETS[0];
    applyVars(preset.vars);
  } else {
    applyTheme(config.hue);
  }
}

function buildPresetGrid(activeConfig) {
  presetGrid.innerHTML = "";
  THEME_PRESETS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.className = "preset-swatch";
    if (activeConfig?.mode === "preset" && activeConfig.presetId === preset.id) {
      btn.classList.add("active");
    }
    btn.innerHTML = `<span class="preset-swatch-dot" style="background:${preset.swatch}"></span><span class="preset-swatch-name">${preset.name}</span>`;
    btn.addEventListener("click", () => {
      applyVars(preset.vars);
      saveThemeConfig({ mode: "preset", presetId: preset.id });
      themeOverlay.hidden = true;
    });
    presetGrid.appendChild(btn);
  });
}

function setHandlePosition(hue) {
  const angle = (hue - 90) * (Math.PI / 180);
  const r = wheelRadius - 14;
  const x = 100 + r * Math.cos(angle);
  const y = 100 + r * Math.sin(angle);
  hueHandle.style.left = `${x}px`;
  hueHandle.style.top = `${y}px`;
}

function hueFromPointer(clientX, clientY) {
  const rect = hueWheel.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const angle = Math.atan2(clientY - cy, clientX - cx) * (180 / Math.PI);
  return (angle + 90 + 360) % 360;
}

function openThemePicker() {
  const current = getThemeConfig();
  previewHue = current?.mode === "hue" ? current.hue : 205;
  setHandlePosition(previewHue);
  buildPresetGrid(current);
  themeOverlay.hidden = false;
}

let draggingHue = false;
hueWheel.addEventListener("mousedown", (e) => {
  draggingHue = true;
  previewHue = hueFromPointer(e.clientX, e.clientY);
  setHandlePosition(previewHue);
  applyTheme(previewHue);
});
document.addEventListener("mousemove", (e) => {
  if (!draggingHue) return;
  previewHue = hueFromPointer(e.clientX, e.clientY);
  setHandlePosition(previewHue);
  applyTheme(previewHue);
});
document.addEventListener("mouseup", () => { draggingHue = false; });

themeBtn.addEventListener("click", openThemePicker);
themeContinueBtn.addEventListener("click", () => {
  saveThemeConfig({ mode: "hue", hue: previewHue });
  themeOverlay.hidden = true;
});

// ---------- Init ----------

(async function init() {
  applySidebarState(localStorage.getItem("sidebarCollapsed") === "1");
  const storedTheme = getThemeConfig();
  if (storedTheme) applyStoredTheme(storedTheme);
  else openThemePicker();
  await loadAll();
  renderSidebar();
  renderEditor();
})();
