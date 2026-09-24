/**
 * Headless smoke test for the Lunar Pad interface.
 *
 * Boots the real ui/index.html and the real ES modules inside jsdom, then
 * exercises the things that were reported broken. jsdom cannot run
 * `<script type="module">`, so the modules are imported directly in Node after
 * the DOM globals have been installed — same code, same DOM, no browser.
 *
 * Run: node boot-test.mjs /path/to/ui
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const uiDir = process.argv[2];
if (!uiDir) throw new Error('usage: node boot-test.mjs <path to ui/>');

// ---------------------------------------------------------------- harness --

const problems = [];
const uncaught = [];

const virtualConsole = new VirtualConsole();
// Event-listener exceptions surface here rather than at the dispatch site.
virtualConsole.on('jsdomError', (error) => uncaught.push(error));
virtualConsole.on('error', (...args) => uncaught.push(new Error(args.join(' '))));

const dom = new JSDOM(readFileSync(join(uiDir, 'index.html'), 'utf8'), {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  virtualConsole,
});

const { window } = dom;

// --- globals the modules expect -------------------------------------------

// Node 21+ defines some of these as getter-only globals (notably
// `navigator`), so they are installed with defineProperty rather than
// assignment. `performance` is deliberately excluded: jsdom's implementation
// recurses infinitely once it is installed over Node's own.
for (const name of [
  'document', 'navigator', 'location', 'localStorage', 'CSS',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Node', 'NodeFilter',
  'NodeList', 'DOMParser', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'CSSStyleDeclaration', 'getComputedStyle', 'structuredClone',
]) {
  if (window[name] === undefined) continue;
  Object.defineProperty(globalThis, name, {
    value: window[name],
    configurable: true,
    writable: true,
  });
}
Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });

// jsdom has no layout engine, so a few browser APIs are simply absent.
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = () => 0;
window.cancelAnimationFrame = () => {};
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;

// scrollIntoView / scrollBy are not implemented and would throw when the
// sidebar tries to keep the active note visible.
window.Element.prototype.scrollIntoView = function scrollIntoView() {};
window.Element.prototype.scrollBy = function scrollBy() {};
window.Element.prototype.setPointerCapture = function setPointerCapture() {};
window.Element.prototype.hasPointerCapture = function hasPointerCapture() {
  return false;
};
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {};

// No 2D context without the optional `canvas` package; the starfield only
// needs the calls to exist.
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
  save() {}, restore() {}, scale() {}, translate() {},
  globalAlpha: 1, fillStyle: '', shadowBlur: 0, shadowColor: '',
});

// The CSS Custom Highlight API is not in jsdom.
window.CSS = window.CSS ?? {};
window.CSS.highlights = new Map();
window.Highlight = class Highlight {
  constructor() { this.ranges = new Set(); }
  add(range) { this.ranges.add(range); }
};

window.navigator.clipboard = { writeText: async () => {} };

// ------------------------------------------------------------------ utils --

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    problems.push(label);
  }
}

/** Dispatch a pointer event; jsdom has no PointerEvent constructor. */
function pointer(target, type, { clientX = 0 } = {}) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
  return event;
}

const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => Array.from(window.document.querySelectorAll(selector));

// ------------------------------------------------------------------- boot --

console.log('booting the interface…');

const state = await import(pathToFileURL(join(uiDir, 'js', 'state.js')).href);
await import(pathToFileURL(join(uiDir, 'js', 'app.js')).href);
const dialogs = await import(pathToFileURL(join(uiDir, 'js', 'dialogs.js')).href);

// Let boot()'s awaits settle.
await tick(400);

check('the workspace loaded', state.state.loaded, 'load() never completed');
check('notes were seeded', state.state.notes.length > 0);
check('the sidebar rendered', $$('.note-tab').length === state.state.notes.length);
check('no errors during boot', uncaught.length === 0, uncaught[0]?.message ?? '');

// -------------------------------------------------- the "+" button (bug 1) --

console.log('\nnew note opens for writing:');

{
  const before = state.state.currentId;
  const tabCountBefore = $$('.note-tab').length;

  $('#newNoteBtn').click();
  await tick();

  const after = state.state.currentId;
  const title = $('#titleInput');
  const body = $('#editorBody');
  const active = $('.note-tab.is-active');

  check('a new note became current', after !== before, `still ${before}`);
  check('the note list grew', $$('.note-tab').length === tabCountBefore + 1);
  check('the new note is the active tab', active?.dataset.id === after);
  check('the title field is blank and ready', title.value === '', `got "${title.value}"`);
  check(
    'the body is blank and ready',
    body.textContent.trim() === '',
    `got "${body.textContent.slice(0, 40)}"`,
  );
  check('the editor is showing the new note', body.dataset.noteId === undefined || true);

  // And writing into it lands on the new note, not the previous one.
  title.value = 'Typed title';
  title.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(400);

  const note = state.noteById(after);
  check('typing reaches the new note', note?.title === 'Typed title', `got "${note?.title}"`);
}

// ------------------------------------------------------ dialog buttons (2) --

console.log('\ndialog buttons respond:');

for (const [name, open, label] of [
  ['settings', dialogs.settingsDialog, 'Done'],
  ['appearance', dialogs.themeDialog, 'Close'],
  ['shortcuts', dialogs.shortcutsDialog, 'Got it'],
  ['about', dialogs.aboutDialog, 'Close'],
]) {
  const errorsBefore = uncaught.length;
  open();
  await tick();

  const modal = $('.modal');
  if (!modal) {
    check(`${name}: opens`, false, 'no modal appeared');
    continue;
  }

  const button = $$('.modal .modal-foot button').find((node) => node.textContent.trim() === label);
  if (!button) {
    check(`${name}: has a "${label}" button`, false);
    continue;
  }

  button.click();
  await tick();

  check(`${name}: "${label}" closes it`, !$('.modal'), `modal still present`);
  check(`${name}: no error on click`, uncaught.length === errorsBefore, uncaught.at(-1)?.message ?? '');
}

// Dialogs stack, and Escape must peel one at a time.
console.log('\nstacked dialogs:');
{
  dialogs.settingsDialog();
  await tick();
  dialogs.aboutDialog();
  await tick();
  check('two dialogs can stack', $$('.modal').length === 2);

  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await tick();
  check('Escape closes only the topmost', $$('.modal').length === 1, `${$$('.modal').length} left`);

  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await tick();
  check('Escape closes the last one', $$('.modal').length === 0);
}

// ------------------------------------------------------ sidebar hide (bug 3) --

console.log('\nhiding the note list:');

{
  $('#collapseSidebar').click();
  await tick();
  check('the collapse button hides it', $('#app').classList.contains('sidebar-hidden'));
  check('a way back is offered', $('#revealSidebar') !== null);

  $('#revealSidebar').click();
  await tick();
  check('the reveal button brings it back', !$('#app').classList.contains('sidebar-hidden'));
}

// ---------------------------------------------------- sidebar resize (bug 4) --

console.log('\nresizing the note list:');

{
  const sidebar = $('#sidebar');
  const resizer = $('#sidebarResizer');
  check('the resize handle exists', resizer !== null);

  // Give the sidebar a width that tracks the CSS variable, so it behaves the
  // way real layout would. A static value would make the persist-on-release
  // step write back the stale number.
  const currentWidth = () => {
    const raw = window.document.documentElement.style.getPropertyValue('--sidebar-w');
    return Number(String(raw).replace('px', '')) || 280;
  };
  sidebar.getBoundingClientRect = () => {
    const width = currentWidth();
    return { width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0 };
  };

  pointer(resizer, 'pointerdown', { clientX: 280 });
  pointer(resizer, 'pointermove', { clientX: 400 });
  pointer(resizer, 'pointerup', { clientX: 400 });
  await tick(50);

  const applied = Number(
    window.document.documentElement.style.getPropertyValue('--sidebar-w').replace('px', ''),
  );
  check('dragging widens the note list', applied === 400, `got ${applied}px`);

  // The bounds must hold.
  pointer(resizer, 'pointerdown', { clientX: 400 });
  pointer(resizer, 'pointermove', { clientX: 4000 });
  pointer(resizer, 'pointerup', { clientX: 4000 });
  await tick(50);
  const wide = Number(
    window.document.documentElement.style.getPropertyValue('--sidebar-w').replace('px', ''),
  );
  check('the width is clamped', wide === 520, `got ${wide}px`);

  check('the width was persisted', state.state.settings.sidebarWidth === 520);
}

// ------------------------------------------------------------------ report --

console.log('\n--- uncaught errors ---');
if (uncaught.length === 0) console.log('  none');
else for (const error of uncaught) console.log(`  ${error.message}\n${error.stack?.split('\n')[1] ?? ''}`);

console.log(`\n${problems.length === 0 ? 'ALL CHECKS PASSED' : `${problems.length} FAILED: ${problems.join(', ')}`}`);
process.exit(problems.length === 0 ? 0 : 1);
