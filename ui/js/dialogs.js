/**
 * Dialogs and anchored menus.
 *
 * Everything here is built on one modal shell, so focus trapping, Escape,
 * backdrop dismissal and the entrance animation are implemented once. The
 * settings and appearance panels are the two substantial ones; the rest are
 * confirmations and menus.
 */

import { $, el, icon, replace, trapFocus } from './dom.js';
import { api, isDesktop } from './api.js';
import { state, updateSettings } from './state.js';
import { applyTheme, hueFromPreset, PRESETS, resolvePalette } from './themes.js';
import { symbolCount } from './symbols.js';
import { toast, reportError } from './toast.js';

const overlayRoot = $('#overlayRoot');

/**
 * Open dialogs, innermost last.
 *
 * Escape must peel the stack one layer at a time — a settings panel that
 * opened the appearance panel should not close both at once.
 */
const modalStack = [];

// ================================================================ modal ====

/**
 * Open a modal.
 *
 * Returns a handle so callers can close it programmatically; the promise-based
 * helpers below are usually what you want instead.
 */
function openModal({
  title,
  subtitle,
  iconId,
  tone = 'default',
  wide = false,
  body = [],
  footer = [],
  onClose,
}) {
  const releaseTrap = { current: null };

  const closeButton = el('button', {
    class: 'btn btn-icon',
    type: 'button',
    title: 'Close',
    'aria-label': 'Close',
    onClick: () => close(),
  }, [icon('i-x')]);

  const entry = {};

  const close = () => {
    if (!root.isConnected) return;
    const at = modalStack.indexOf(entry);
    if (at !== -1) modalStack.splice(at, 1);
    releaseTrap.current?.();
    document.removeEventListener('keydown', onKeydown, true);
    root.remove();
    onClose?.();
  };

  const onKeydown = (event) => {
    if (event.key !== 'Escape') return;
    // Only the topmost dialog reacts.
    if (modalStack[modalStack.length - 1] !== entry) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const card = el('div', { class: `modal-card${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'modal-head' }, [
      iconId
        ? el('div', { class: `confirm-icon${tone === 'default' ? ' is-neutral' : ''}` }, [icon(iconId)])
        : null,
      el('div', { class: 'modal-headings' }, [
        el('h2', { text: title }),
        subtitle ? el('p', { text: subtitle }) : null,
      ]),
      closeButton,
    ]),
    el('div', { class: 'modal-body' }, body),
    footer.length > 0 ? el('div', { class: 'modal-foot' }, footer) : null,
  ]);

  const root = el('div', {
    class: 'modal',
    onPointerdown: (event) => {
      if (event.target === root) close();
    },
  }, [card]);

  overlayRoot.append(root);
  modalStack.push(entry);

  // Stop app-level shortcuts from firing while a dialog is up.
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation();
  });
  document.addEventListener('keydown', onKeydown, true);

  releaseTrap.current = trapFocus(card);
  requestAnimationFrame(() => {
    const focusable = card.querySelector('[data-autofocus]') ?? card.querySelector('button, input, select');
    focusable?.focus();
  });

  return { root, card, close };
}

// ============================================================== confirm ====

/**
 * Ask the user to confirm something destructive.
 *
 * Resolves `true` only when the confirming button is pressed, so callers can
 * `if (!(await confirmDialog(...)))` and be done.
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', tone = 'danger' }) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };

    const dialog = openModal({
      title,
      iconId: tone === 'danger' ? 'i-alert' : 'i-info',
      tone,
      body: body ? [el('p', { style: { fontSize: '13px', lineHeight: '1.65', color: 'var(--text-dim)' }, text: body })] : [],
      footer: [
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-outline',
          type: 'button',
          text: 'Cancel',
          'data-autofocus': '',
          onClick: () => finish(false),
        }),
        el('button', {
          class: `btn ${tone === 'danger' ? 'btn-danger' : 'btn-accent'}`,
          type: 'button',
          text: confirmLabel,
          onClick: () => finish(true),
        }),
      ],
      onClose: () => finish(false),
    });
  });
}

// ============================================================== settings ====

/** A labelled on/off row. */
function switchRow(label, hint, checked, onChange) {
  const button = el('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
    onClick: () => {
      const next = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    },
  });

  return el('div', { class: 'setting' }, [
    el('div', { class: 'setting-text' }, [
      el('div', { class: 'setting-label', text: label }),
      hint ? el('div', { class: 'setting-hint', text: hint }) : null,
    ]),
    el('div', { class: 'setting-control' }, [button]),
  ]);
}

/** A labelled dropdown row. */
function selectRow(label, hint, value, options, onChange) {
  const select = el(
    'select',
    { class: 'select', 'aria-label': label, onChange: () => onChange(select.value) },
    options.map((option) =>
      el('option', { value: option.value, text: option.label, selected: option.value === value }),
    ),
  );

  return el('div', { class: 'setting' }, [
    el('div', { class: 'setting-text' }, [
      el('div', { class: 'setting-label', text: label }),
      hint ? el('div', { class: 'setting-hint', text: hint }) : null,
    ]),
    el('div', { class: 'setting-control' }, [select]),
  ]);
}

/** A labelled range row, with the current value shown. */
function rangeRow(label, hint, { min, max, step, value, format }, onChange) {
  const output = el('span', {
    class: 'setting-hint',
    style: { minWidth: '3.2em', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
    text: format(value),
  });

  const input = el('input', {
    type: 'range',
    class: 'range',
    min,
    max,
    step,
    value,
    'aria-label': label,
    style: { width: '126px', accentColor: 'var(--accent)' },
    onInput: () => {
      const next = Number(input.value);
      output.textContent = format(next);
      onChange(next);
    },
  });

  return el('div', { class: 'setting' }, [
    el('div', { class: 'setting-text' }, [
      el('div', { class: 'setting-label', text: label }),
      hint ? el('div', { class: 'setting-hint', text: hint }) : null,
    ]),
    el('div', { class: 'setting-control' }, [input, output]),
  ]);
}

export function settingsDialog() {
  const settings = state.settings;

  const body = [
    el('div', { class: 'section-title', text: 'Appearance' }),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-text' }, [
        el('div', { class: 'setting-label', text: 'Theme' }),
        el('div', { class: 'setting-hint', text: 'Presets, or a colour of your own' }),
      ]),
      el('div', { class: 'setting-control' }, [
        el('button', {
          class: 'btn btn-soft',
          type: 'button',
          onClick: () => themeDialog(),
        }, [icon('i-palette'), 'Change…']),
      ]),
    ]),

    selectRow(
      'Editor width',
      'How wide the writing column runs',
      settings.editorWidth,
      [
        { value: 'narrow', label: 'Narrow' },
        { value: 'cozy', label: 'Cozy' },
        { value: 'wide', label: 'Wide' },
        { value: 'full', label: 'Full' },
      ],
      (value) => updateSettings({ editorWidth: value }),
    ),

    selectRow(
      'Editor font',
      'Used unless a note overrides it',
      settings.font,
      [
        { value: '', label: 'Theme default' },
        { value: 'Georgia, "Times New Roman", serif', label: 'Serif' },
        { value: 'Consolas, ui-monospace, monospace', label: 'Monospace' },
        { value: '"Segoe UI Variable Display", Nunito, "Segoe UI", sans-serif', label: 'Rounded' },
      ],
      (value) => updateSettings({ font: value }),
    ),

    rangeRow(
      'Text size',
      null,
      { min: 13, max: 22, step: 1, value: settings.fontSize, format: (v) => `${v}px` },
      (value) => updateSettings({ fontSize: value }),
    ),

    rangeRow(
      'Line spacing',
      null,
      {
        min: 1.3,
        max: 2.2,
        step: 0.05,
        value: settings.lineHeight,
        format: (v) => v.toFixed(2),
      },
      (value) => updateSettings({ lineHeight: value }),
    ),

    el('div', { class: 'section-title', text: 'Writing' }),

    switchRow('Check spelling', 'Underlines misspelled words as you type', settings.spellcheck, (value) =>
      updateSettings({ spellcheck: value }),
    ),

    switchRow(
      'Typewriter scrolling',
      'Keeps the line you are editing centred',
      settings.typewriter,
      (value) => updateSettings({ typewriter: value }),
    ),

    switchRow('Focus mode', 'Dims every paragraph except the one you are in', settings.focusMode, (value) =>
      updateSettings({ focusMode: value }),
    ),

    el('div', { class: 'section-title', text: 'Atmosphere' }),

    switchRow('Starfield', 'A slowly drifting background', settings.ambient, (value) =>
      updateSettings({ ambient: value }),
    ),

    switchRow('Reduce motion', 'Turns off animations throughout', settings.reducedMotion, (value) =>
      updateSettings({ reducedMotion: value }),
    ),

    switchRow('Always on top', 'Keeps this window above others', settings.alwaysOnTop, (value) =>
      updateSettings({ alwaysOnTop: value }, { immediate: true }),
    ),

    el('div', { class: 'section-title', text: 'Your notes' }),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-text' }, [
        el('div', { class: 'setting-label', text: 'Stored on this computer' }),
        el('div', {
          class: 'setting-hint',
          style: { fontFamily: 'var(--font-mono)', fontSize: '10.5px', wordBreak: 'break-all' },
          text: state.dataDir || 'unknown',
        }),
      ]),
    ]),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-text' }, [
        el('div', { class: 'setting-label', text: 'Backups' }),
        el('div', {
          class: 'setting-hint',
          text: 'A snapshot is kept on every launch, and you can take one now.',
        }),
      ]),
      el('div', { class: 'setting-control' }, [
        el('button', {
          class: 'btn btn-outline',
          type: 'button',
          onClick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              const path = await api.backupNow();
              toast('Backup saved', { iconName: 'i-database' });
              console.info('backup written to', path);
            } catch (error) {
              reportError(isDesktop ? 'Could not write the backup.' : 'Backups need the desktop app.');
              console.error(error);
            } finally {
              button.disabled = false;
            }
          },
        }, [icon('i-database'), 'Back up now']),
      ]),
    ]),

    selectRow(
      'Empty the trash after',
      'Notes in the trash are removed automatically',
      String(settings.trashRetentionDays),
      [
        { value: '7', label: '7 days' },
        { value: '30', label: '30 days' },
        { value: '90', label: '90 days' },
        { value: '0', label: 'Never' },
      ],
      (value) => updateSettings({ trashRetentionDays: Number(value) }, { immediate: true }),
    ),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-text' }, [
        el('div', { class: 'setting-label', text: 'Export everything' }),
        el('div', { class: 'setting-hint', text: 'Writes every note to one file you can keep.' }),
      ]),
      el('div', { class: 'setting-control' }, [
        el('button', {
          class: 'btn btn-outline',
          type: 'button',
          onClick: (event) => exportAllMenu(event.currentTarget),
        }, [icon('i-download'), 'Export all']),
      ]),
    ]),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-text' }, [
        el('div', { class: 'setting-label', text: 'Import notes' }),
        el('div', {
          class: 'setting-hint',
          text: 'Merges a Lunar Pad backup, keeping the newest copy of each note.',
        }),
      ]),
      el('div', { class: 'setting-control' }, [
        el('button', {
          class: 'btn btn-outline',
          type: 'button',
          onClick: async () => {
            try {
              const added = await api.importBackup();
              if (added === null || added === undefined) return;
              toast(`${added} note${added === 1 ? '' : 's'} imported`, { iconName: 'i-upload' });
            } catch (error) {
              reportError(isDesktop ? 'That file could not be imported.' : 'Importing needs the desktop app.');
              console.error(error);
            }
          },
        }, [icon('i-upload'), 'Import…']),
      ]),
    ]),
  ];

  const dialog = openModal({
    title: 'Settings',
    subtitle: `${state.notes.length} notes · ${symbolCount()} symbols available`,
    iconId: 'i-sliders',
    wide: true,
    body,
    footer: [
      el('button', {
        class: 'btn btn-outline',
        type: 'button',
        onClick: () => shortcutsDialog(),
      }, [icon('i-keyboard'), 'Shortcuts']),
      el('button', {
        class: 'btn btn-outline',
        type: 'button',
        onClick: () => aboutDialog(),
      }, [icon('i-info'), 'About']),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-accent',
        type: 'button',
        text: 'Done',
        'data-autofocus': '',
        onClick: () => dialog.close(),
      }),
    ],
  });

  return dialog;
}

// =============================================================== themes ====

export function themeDialog() {
  let current = {
    mode: state.settings.themeMode,
    preset: state.settings.themePreset,
    hue: state.settings.customHue,
    scheme: state.settings.themeScheme === 'light' ? 'light' : 'dark',
  };

  const preview = el('div', { class: 'hue-swatches' });
  const customScheme = { value: current.scheme };

  function refreshPreview() {
    const palette = resolvePalette(current);
    replace(preview, []);
    for (const [label, colour] of [
      ['Background', palette.bg],
      ['Surface', palette.panel],
      ['Accent', palette.accent],
    ]) {
      preview.append(
        el('span', {
          class: 'hue-swatch',
          style: { background: colour },
          title: `${label}: ${colour}`,
        }),
      );
    }
  }

  // ---- preset grid
  const grid = el('div', { class: 'theme-grid' });

  function paintGrid() {
    replace(grid, []);
    for (const preset of PRESETS) {
      const card = el(
        'button',
        {
          class: `theme-card${current.mode === 'preset' && current.preset === preset.id ? ' is-active' : ''}`,
          type: 'button',
          title: preset.name,
          onClick: () => {
            // Picking a preset also adopts its scheme, so a later switch to a
            // custom palette starts from a sensible place.
            current = { mode: 'preset', preset: preset.id, hue: current.hue, scheme: preset.scheme };
            applyTheme(current);
            persist();
            paintGrid();
            refreshPreview();
          },
        },
        [
          el('div', { class: 'theme-preview', style: { background: preset.bg } }, [
            el('div', { class: 'theme-preview-side', style: { background: preset.panel } }),
            el('div', { class: 'theme-preview-main', style: { background: preset.panel } }, [
              el('div', { class: 'theme-preview-line', style: { background: preset.accent, width: '68%' } }),
              el('div', {
                class: 'theme-preview-line',
                style: { background: preset.accent, width: '42%', opacity: '0.55' },
              }),
              el('div', {
                class: 'theme-preview-line',
                style: { background: preset.accent, width: '54%', opacity: '0.35' },
              }),
            ]),
          ]),
          el('span', { class: 'theme-name', text: preset.name }),
        ],
      );
      grid.append(card);
    }
  }

  // ---- custom wheel
  const handle = el('div', { class: 'hue-handle' });
  const ring = el('div', { class: 'hue-ring', title: 'Drag to pick a colour' }, [handle]);

  const RADIUS = 66;
  const setHandle = (hue) => {
    const angle = ((hue - 90) * Math.PI) / 180;
    handle.style.left = `${66 + RADIUS * Math.cos(angle)}px`;
    handle.style.top = `${66 + RADIUS * Math.sin(angle)}px`;
  };

  const hueFromPointer = (clientX, clientY) => {
    const rect = ring.getBoundingClientRect();
    const angle =
      (Math.atan2(clientY - (rect.top + rect.height / 2), clientX - (rect.left + rect.width / 2)) *
        180) /
      Math.PI;
    return Math.round((angle + 90 + 360) % 360);
  };

  let dragging = false;

  const applyCustom = () => {
    current = { mode: 'custom', preset: current.preset, hue: current.hue, scheme: customScheme.value };
    applyTheme(current);
    persist();
    refreshPreview();
  };

  ring.addEventListener('pointerdown', (event) => {
    dragging = true;
    ring.setPointerCapture(event.pointerId);
    current.hue = hueFromPointer(event.clientX, event.clientY);
    setHandle(current.hue);
    applyCustom();
    refreshPreview();
  });

  ring.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    current.hue = hueFromPointer(event.clientX, event.clientY);
    setHandle(current.hue);
    applyCustom();
    refreshPreview();
  });

  ring.addEventListener('pointerup', () => {
    dragging = false;
  });

  const schemeButtons = { value: null };

  const makeSchemeButton = (label, value) => {
    const button = el('button', {
      class: `btn ${customScheme.value === value ? 'btn-soft' : 'btn-outline'}`,
      type: 'button',
      text: label,
      onClick: () => {
        customScheme.value = value;
        for (const [key, node] of Object.entries(schemeButtons.value)) {
          const active = key === value;
          node.classList.toggle('btn-soft', active);
          node.classList.toggle('btn-outline', !active);
        }
        applyCustom();
      },
    });
    schemeButtons.value = { ...(schemeButtons.value ?? {}), [value]: button };
    return button;
  };

  const schemeToggle = el('div', { class: 'foot-row' }, [
    makeSchemeButton('Dark', 'dark'),
    makeSchemeButton('Light', 'light'),
  ]);

  function persist() {
    updateSettings(
      {
        themeMode: current.mode,
        themePreset: current.preset,
        customHue: current.hue,
        themeScheme: current.scheme,
      },
      { immediate: true },
    );
  }

  const startHue = current.mode === 'custom' ? current.hue : hueFromPreset(current.preset);
  setHandle(startHue);
  paintGrid();
  refreshPreview();

  const dialog = openModal({
    title: 'Appearance',
    subtitle: 'Pick a preset, or drag the ring for a colour of your own',
    iconId: 'i-palette',
    wide: true,
    body: [
      el('div', { class: 'section-title', text: 'Presets' }),
      grid,
      el('div', { class: 'section-title', text: 'Your own colour' }),
      el('div', { class: 'hue-wrap' }, [
        ring,
        el('div', { class: 'hue-preview' }, [
          preview,
          el('div', {
            class: 'setting-hint',
            text: 'The whole palette is generated from this hue, so every surface stays in tune.',
          }),
          schemeToggle,
        ]),
      ]),
    ],
    footer: [
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-outline',
        type: 'button',
        text: 'Close',
        onClick: () => dialog.close(),
      }),
    ],
  });

  return dialog;
}

// ============================================================ shortcuts ====

const SHORTCUTS = [
  ['Ctrl + N', 'New note'],
  ['Ctrl + K', 'Command palette'],
  ['Ctrl + F', 'Find and replace in this note'],
  ['Ctrl + P', 'Pin the current note'],
  ['Ctrl + D', 'Duplicate the current note'],
  ['Ctrl + S', 'Save immediately'],
  ['Ctrl + \\', 'Hide or show the note list'],
  ['Ctrl + ,', 'Settings'],
  ['Ctrl + Shift + T', 'Change appearance'],
  ['Ctrl + /', 'Keyboard shortcuts'],
  ['Ctrl + Shift + Delete', 'Move this note to the trash'],
  ['Ctrl + B / I / U', 'Bold, italic, underline'],
  ['Ctrl + Shift + X', 'Strikethrough'],
  ['Ctrl + Shift + H', 'Highlight'],
  ['Ctrl + 1…9', 'Jump to the nth note'],
  ['Ctrl + = / − / 0', 'Text size up, down, reset'],
  ['Esc', 'Close whatever is open'],
  ['↑ / ↓ in the list', 'Move between notes'],
  ['Drag a note tab', 'Reorder notes'],
  ['/ at the start of a line', 'Quick insert'],
  ['\\theta then space', 'Insert θ (and 300 more symbols)'],
];

export function shortcutsDialog() {
  const rows = SHORTCUTS.map(([keys, description]) =>
    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-text' }, [el('div', { class: 'setting-label', text: description })]),
      el(
        'div',
        { class: 'setting-control' },
        keys.split(' / ').map((part) => el('span', { class: 'kbd', text: part })),
      ),
    ]),
  );

  const dialog = openModal({
    title: 'Keyboard shortcuts',
    subtitle: 'Everything is reachable without the mouse',
    iconId: 'i-keyboard',
    wide: true,
    body: rows,
    footer: [
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-accent',
        type: 'button',
        text: 'Got it',
        'data-autofocus': '',
        onClick: () => dialog.close(),
      }),
    ],
  });

  return dialog;
}

// ================================================================ about ====

export function aboutDialog() {
  const dialog = openModal({
    title: 'Lunar Pad',
    subtitle: 'Version 2.0.0',
    iconId: 'i-lunar',
    body: [
      el('p', {
        style: { fontSize: '13px', lineHeight: '1.7', color: 'var(--text-dim)' },
        text: 'A notepad that keeps every note a click away. Written in Rust, rendered by your system webview, and entirely yours — no accounts, no sync, no telemetry.',
      }),
      el('div', { class: 'section-title', text: 'Where things are' }),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-text' }, [
          el('div', { class: 'setting-label', text: 'Notes and settings' }),
          el('div', {
            class: 'setting-hint',
            style: { fontFamily: 'var(--font-mono)', fontSize: '10.5px', wordBreak: 'break-all' },
            text: state.dataDir || 'unknown',
          }),
        ]),
      ]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-text' }, [
          el('div', { class: 'setting-label', text: 'Format' }),
          el('div', {
            class: 'setting-hint',
            text: 'Plain JSON. Back it up, diff it, move it between machines — it is just a file.',
          }),
        ]),
      ]),
    ],
    footer: [
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-outline',
        type: 'button',
        text: 'Shortcuts',
        onClick: () => {
          dialog.close();
          shortcutsDialog();
        },
      }),
      el('button', {
        class: 'btn btn-accent',
        type: 'button',
        text: 'Close',
        'data-autofocus': '',
        onClick: () => dialog.close(),
      }),
    ],
  });

  return dialog;
}

// =============================================================== menus ====

let openMenuNode = null;

/** Position a fixed-position menu next to its anchor, flipping when needed. */
function placeMenu(menu, anchor, { align = 'left' } = {}) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const margin = 8;

  let left = align === 'right' ? rect.right - width : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  // Prefer below; flip above when there is no room.
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - 6);
  }

  // Menus that hang off the top or bottom get clamped rather than clipped.
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/**
 * Open an anchored menu.
 *
 * Closes on outside pointer-down, Escape, or any scroll/resize — a menu that
 * stays put while its anchor moves is worse than one that vanishes.
 */
export function openMenu(anchor, items, options = {}) {
  closeMenu();

  const menu = el(
    'div',
    { class: 'menu', role: 'menu', style: { position: 'fixed', visibility: 'hidden' } },
    items.map((item) => {
      if (item.separator) return el('div', { class: 'menu-sep' });

      return el(
        'button',
        {
          class: `menu-item${item.danger ? ' is-danger' : ''}`,
          type: 'button',
          role: 'menuitem',
          onClick: () => {
            closeMenu();
            item.run?.();
          },
        },
        [
          item.iconId ? icon(item.iconId) : null,
          el('span', { text: item.label }),
          item.shortcut ? el('span', { class: 'kbd', text: item.shortcut }) : null,
          item.hint ? el('span', { class: 'menu-hint setting-hint', text: item.hint }) : null,
        ],
      );
    }),
  );

  overlayRoot.append(menu);
  menu.style.visibility = '';
  placeMenu(menu, anchor, options);
  openMenuNode = menu;

  const onPointerDown = (event) => {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    closeMenu();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  };

  const teardown = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', closeMenu, true);
    window.removeEventListener('resize', closeMenu);
  };

  menu.__teardown = teardown;

  // Deferred so the click that opened the menu does not immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
  }, 0);

  return menu;
}

export function closeMenu() {
  if (!openMenuNode) return;
  openMenuNode.__teardown?.();
  openMenuNode.remove();
  openMenuNode = null;
}

/** Export options for one note. */
export function exportMenu(anchor, note) {
  const run = async (format) => {
    try {
      const path = await api.exportNote(note.id, format);
      if (path) toast('Note exported', { iconName: 'i-check' });
    } catch (error) {
      reportError(isDesktop ? 'That note could not be exported.' : 'Export needs the desktop app.');
      console.error(error);
    }
  };

  return openMenu(
    anchor,
    [
      { label: 'Markdown (.md)', iconId: 'i-note', run: () => run('markdown') },
      { label: 'Plain text (.txt)', iconId: 'i-typesize', run: () => run('text') },
      { label: 'Web page (.html)', iconId: 'i-code', run: () => run('html') },
      { label: 'JSON (.json)', iconId: 'i-database', run: () => run('json') },
      { separator: true },
      {
        label: 'Copy as Markdown',
        iconId: 'i-copy',
        run: async () => {
          try {
            const markdown = await api.renderNote(note.id, 'markdown');
            await navigator.clipboard.writeText(markdown);
            toast('Copied as Markdown', { iconName: 'i-check' });
          } catch (error) {
            reportError('The clipboard could not be written to.');
            console.error(error);
          }
        },
      },
    ],
    { align: 'right' },
  );
}

/** Export-all options, shared by the settings panel and the overflow menu. */
export function exportAllMenu(anchor) {
  const run = async (format) => {
    try {
      const path = await api.exportAll(format);
      if (path) toast('All notes exported', { iconName: 'i-check' });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes('no notes to export')) {
        toast('There are no notes to export', { iconName: 'i-info' });
        return;
      }
      reportError(isDesktop ? 'The export could not be written.' : 'Export needs the desktop app.');
      console.error(error);
    }
  };

  return openMenu(
    anchor,
    [
      {
        label: 'Markdown (.md)',
        iconId: 'i-note',
        hint: 'One file, all notes',
        run: () => run('markdown'),
      },
      { label: 'Plain text (.txt)', iconId: 'i-typesize', run: () => run('text') },
      { label: 'Web page (.html)', iconId: 'i-code', run: () => run('html') },
      { label: 'JSON backup (.json)', iconId: 'i-database', run: () => run('json') },
    ],
    { align: 'right' },
  );
}

// Re-exported so app.js does not need to reach into palette internals.
export { openModal };
