/**
 * Theme engine.
 *
 * Two kinds of theme:
 *
 *  * **Presets** — hand-designed token sets that live entirely in CSS. This
 *    module only needs their id so it can set `data-theme` on the root.
 *  * **Custom** — generated from a hue angle, which means the tokens have to
 *    be computed here and written as inline custom properties.
 *
 * The metadata below is the single source of truth for the picker (name,
 * swatch colours) and for which colour scheme a preset uses, so native widgets
 * and the app's own shadows stay in agreement.
 */

/** Picker metadata, in display order: dark themes, then light. */
export const PRESETS = [
  { id: 'lunar', name: 'Lunar', scheme: 'dark', accent: '#6d7cff', bg: '#07070f', panel: '#0c0c19' },
  { id: 'midnight', name: 'Midnight', scheme: 'dark', accent: '#5b9bd9', bg: '#0b1523', panel: '#111c2e' },
  { id: 'nebula', name: 'Nebula', scheme: 'dark', accent: '#b06bff', bg: '#0b0715', panel: '#130d24' },
  { id: 'eclipse', name: 'Eclipse', scheme: 'dark', accent: '#f0a44a', bg: '#0a0908', panel: '#121110' },
  { id: 'sunset', name: 'Sunset', scheme: 'dark', accent: '#ff8a4c', bg: '#150c08', panel: '#1f130c' },
  { id: 'forest', name: 'Forest', scheme: 'dark', accent: '#34d399', bg: '#060d0a', panel: '#0a1512' },
  { id: 'terminal', name: 'Terminal', scheme: 'dark', accent: '#4ade80', bg: '#050807', panel: '#0a0f0d' },
  { id: 'slate', name: 'Slate', scheme: 'dark', accent: '#94a3b8', bg: '#0e0f12', panel: '#16181d' },
  { id: 'frost', name: 'Frost', scheme: 'light', accent: '#2f6fd0', bg: '#f2f5f9', panel: '#ffffff' },
  { id: 'paper', name: 'Paper', scheme: 'light', accent: '#a8621f', bg: '#f7f4ee', panel: '#fffdf9' },
  { id: 'sandy', name: 'Sandy', scheme: 'light', accent: '#b8860b', bg: '#faf6ef', panel: '#fffdf8' },
  { id: 'mint', name: 'Mint', scheme: 'light', accent: '#159a5c', bg: '#f0f8f3', panel: '#ffffff' },
  { id: 'orchid', name: 'Orchid', scheme: 'light', accent: '#8b5cf6', bg: '#f8f4fb', panel: '#ffffff' },
  { id: 'rosegold', name: 'Rose Gold', scheme: 'light', accent: '#d2643f', bg: '#fbf3f0', panel: '#ffffff' },
];

export const DEFAULT_THEME = { mode: 'preset', preset: 'lunar', hue: 232, scheme: 'dark' };

const CUSTOM_TOKEN_NAMES = [
  '--bg',
  '--bg-panel',
  '--bg-elevated',
  '--bg-editor',
  '--border',
  '--border-strong',
  '--text',
  '--text-dim',
  '--text-faint',
  '--accent',
  '--accent-2',
  '--accent-soft',
  '--accent-glow',
  '--accent-ink',
  '--selection',
];

const presetIndex = new Map(PRESETS.map((preset) => [preset.id, preset]));

export function presetById(id) {
  return presetIndex.get(id) || presetIndex.get(DEFAULT_THEME.preset);
}

/**
 * Derive a full palette from one hue.
 *
 * Saturation is kept moderate and lightness is spread deliberately rather than
 * evenly: background tiers need to be close together to read as layers, while
 * the accent needs enough contrast to work as a fill behind white text.
 */
export function customTokens(hue, scheme = 'dark') {
  const h = ((Number(hue) || 0) % 360 + 360) % 360;
  const companion = (h + 38) % 360;

  if (scheme === 'light') {
    return {
      '--bg': `hsl(${h} 40% 97%)`,
      '--bg-panel': `hsl(${h} 44% 99.4%)`,
      '--bg-elevated': '#ffffff',
      '--bg-editor': `hsl(${h} 40% 98.4%)`,
      '--border': `hsl(${h} 28% 89%)`,
      '--border-strong': `hsl(${h} 26% 79%)`,
      '--text': `hsl(${h} 32% 13%)`,
      '--text-dim': `hsl(${h} 18% 40%)`,
      '--text-faint': `hsl(${h} 15% 56%)`,
      '--accent': `hsl(${h} 72% 45%)`,
      '--accent-2': `hsl(${companion} 68% 54%)`,
      '--accent-soft': `hsl(${h} 72% 45% / 0.12)`,
      '--accent-glow': `hsl(${h} 72% 45% / 0.3)`,
      '--accent-ink': '#ffffff',
      '--selection': `hsl(${h} 72% 45% / 0.22)`,
    };
  }

  return {
    '--bg': `hsl(${h} 30% 5%)`,
    '--bg-panel': `hsl(${h} 28% 8%)`,
    '--bg-elevated': `hsl(${h} 26% 12.5%)`,
    '--bg-editor': `hsl(${h} 30% 6.2%)`,
    '--border': `hsl(${h} 22% 16%)`,
    '--border-strong': `hsl(${h} 22% 25%)`,
    '--text': `hsl(${h} 24% 94%)`,
    '--text-dim': `hsl(${h} 16% 64%)`,
    '--text-faint': `hsl(${h} 13% 45%)`,
    '--accent': `hsl(${h} 72% 64%)`,
    '--accent-2': `hsl(${companion} 70% 68%)`,
    '--accent-soft': `hsl(${h} 72% 64% / 0.16)`,
    '--accent-glow': `hsl(${h} 72% 64% / 0.42)`,
    '--accent-ink': '#0b0b12',
    '--selection': `hsl(${h} 72% 64% / 0.3)`,
  };
}

function clearCustomTokens() {
  for (const name of CUSTOM_TOKEN_NAMES) {
    document.documentElement.style.removeProperty(name);
  }
}

/**
 * Cross-fade colours across the whole UI.
 *
 * The class is removed on a timer rather than on transitionend, because with
 * hundreds of elements there is no single event that reliably marks the end.
 */
let transitionTimer = null;
function flashThemeTransition() {
  const root = document.documentElement;
  if (root.dataset.reducedMotion === 'true') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  root.classList.add('theme-transition');
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 400);
}

/**
 * Apply a theme configuration to the document.
 *
 * `animate` is off during startup, so the first paint is not a fade from the
 * default palette to the user's chosen one.
 */
export function applyTheme(config, { animate = true } = {}) {
  const root = document.documentElement;
  const theme = { ...DEFAULT_THEME, ...config };

  if (animate) flashThemeTransition();

  if (theme.mode === 'custom') {
    clearCustomTokens();
    const scheme = theme.scheme === 'light' ? 'light' : 'dark';
    root.dataset.theme = 'custom';
    root.dataset.scheme = scheme;
    const tokens = customTokens(theme.hue, scheme);
    for (const [name, value] of Object.entries(tokens)) {
      root.style.setProperty(name, value);
    }
    return;
  }

  clearCustomTokens();
  const preset = presetById(theme.preset);
  root.dataset.theme = preset.id;
  root.dataset.scheme = preset.scheme;
}

/** The palette a configuration resolves to, for building UI previews. */
export function resolvePalette(config) {
  const theme = { ...DEFAULT_THEME, ...config };
  if (theme.mode === 'custom') {
    const tokens = customTokens(theme.hue, theme.scheme);
    return {
      id: 'custom',
      name: 'Custom',
      scheme: theme.scheme,
      accent: tokens['--accent'],
      bg: tokens['--bg'],
      panel: tokens['--bg-panel'],
    };
  }
  return presetById(theme.preset);
}

/**
 * True when a configuration would render on a light background, so callers can
 * pick contrasting chrome (e.g. the window backdrop colour).
 */
export function isLight(config) {
  return resolvePalette(config).scheme === 'light';
}

/** Move a hue to the nearest preset-equivalent for the wheel's start position. */
export function hueFromPreset(id) {
  const preset = presetById(id);
  // Rough hue of each preset accent, used only to seed the custom wheel.
  const seeds = {
    lunar: 232,
    midnight: 210,
    nebula: 274,
    eclipse: 33,
    sunset: 20,
    forest: 158,
    terminal: 141,
    slate: 214,
    frost: 215,
    paper: 32,
    sandy: 44,
    mint: 152,
    orchid: 262,
    rosegold: 15,
  };
  return seeds[preset.id] ?? DEFAULT_THEME.hue;
}
