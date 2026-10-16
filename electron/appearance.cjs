'use strict';

// Appearance settings: validation (shared by every window through store.cjs) and the small
// per-shell theme files the shell integration re-reads at every prompt, so a color change
// reaches already-open shells on their next prompt without restarting them.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const PRESETS = require('./appearance-presets.json');

const PRESET_IDS = Object.freeze(Object.keys(PRESETS));
const UI_KEYS = Object.freeze(['background', 'panel', 'text', 'muted', 'accent', 'border', 'flag']);
const ANSI_KEYS = Object.freeze(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']);
const TERMINAL_KEYS = Object.freeze(['background', 'foreground', 'cursor', 'selection', ...ANSI_KEYS]);
const PROMPT_KEYS = Object.freeze(['path', 'gitLabel', 'branch', 'ahead', 'behind', 'arrow', 'flag']);
const DEFAULT_FONTS = Object.freeze({ terminalFamily: '', lineHeight: 1.22, uiFamily: '' });
const FONT_LIMIT = 120;
const HEX = /^#[0-9a-f]{6}$/i;
// A comma-separated list of font names; quotes, semicolons, parentheses and the like never
// reach CSS or xterm.js.
const FONT = /^[\p{L}\p{N} ._,-]*$/u;
// The flag highlighter's built-in color, used while `prompt.flag` is left on its default.
const DEFAULT_FLAG = '#2f81f7';

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function hex(value) { return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null; }

function pickColors(source, keys, fallback, allowEmpty = false) {
  const value = isObject(source) ? source : {};
  return Object.fromEntries(keys.map(key => {
    if (allowEmpty && value[key] === '') return [key, ''];
    return [key, hex(value[key]) ?? fallback[key]];
  }));
}

function fontFamily(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length <= FONT_LIMIT && FONT.test(trimmed) ? trimmed : '';
}

function normalizeFonts(value) {
  const fonts = isObject(value) ? value : {};
  const lineHeight = typeof fonts.lineHeight === 'number' && Number.isFinite(fonts.lineHeight)
    ? Math.round(Math.min(1.8, Math.max(1, fonts.lineHeight)) * 100) / 100 : DEFAULT_FONTS.lineHeight;
  return { terminalFamily: fontFamily(fonts.terminalFamily), lineHeight, uiFamily: fontFamily(fonts.uiFamily) };
}

function presetColors(id) {
  const preset = PRESETS[id];
  return { ui: { ...preset.ui }, terminal: { ...preset.terminal }, prompt: { ...preset.prompt } };
}

function defaultAppearance(theme = 'dark') {
  const preset = theme === 'light' ? 'mullion-light' : 'mullion-dark';
  return { preset, ...presetColors(preset), fonts: { ...DEFAULT_FONTS } };
}

/**
 * Returns `{ appearance, theme }`. A named preset always carries its own published colors (so a
 * stored copy can never drift) and decides the light/dark base; the two Mullion presets instead
 * follow `theme`, so the Light/Dark switch keeps working exactly as before. `custom` keeps every
 * valid stored color and fills anything missing or malformed from the Mullion preset for `theme`.
 * Unknown keys are dropped everywhere.
 */
function normalizeAppearance(value, theme = 'dark') {
  const raw = isObject(value) ? value : {};
  const fonts = normalizeFonts(raw.fonts);
  let preset = raw.preset === 'custom' || PRESET_IDS.includes(raw.preset) ? raw.preset : `mullion-${theme}`;
  if (preset === 'mullion-dark' || preset === 'mullion-light') preset = `mullion-${theme}`;
  if (preset !== 'custom') return { appearance: { preset, ...presetColors(preset), fonts }, theme: PRESETS[preset].theme };
  const base = PRESETS[`mullion-${theme}`];
  return {
    appearance: {
      preset,
      ui: pickColors(raw.ui, UI_KEYS, base.ui),
      terminal: pickColors(raw.terminal, TERMINAL_KEYS, base.terminal),
      prompt: pickColors(raw.prompt, PROMPT_KEYS, base.prompt, true),
      fonts,
    },
    theme,
  };
}

function rgb(color) { return [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16)); }

// Nearest entry of xterm's fixed 256-color palette (the 6×6×6 cube and the gray ramp; the first
// 16 are theme-dependent, so never chosen) — what zsh older than 5.7 gets instead of %F{#rrggbb}.
function nearest256(color) {
  const levels = [0, 95, 135, 175, 215, 255];
  const [r, g, b] = rgb(color);
  const nearestLevel = channel => levels.reduce((best, level, index) => Math.abs(level - channel) < Math.abs(levels[best] - channel) ? index : best, 0);
  const cube = [nearestLevel(r), nearestLevel(g), nearestLevel(b)];
  const cubeColor = cube.map(index => levels[index]);
  const grayIndex = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  const distance = ([x, y, z]) => (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2;
  return distance([gray, gray, gray]) < distance(cubeColor) ? 232 + grayIndex : 16 + 36 * cube[0] + 6 * cube[1] + cube[2];
}

function truecolorCode(color) { return `38;2;${rgb(color).join(';')}`; }

// The prompt's built-in colors (plain ANSI, remapped through the terminal palette) for anything
// left on its default. PowerShell's path and ❯ were never colored, so they stay plain there.
const ANSI_DEFAULTS = Object.freeze({ path: 36, gitLabel: 90, branch: 35, ahead: 32, behind: 31, arrow: 33 });
const ZSH_DEFAULTS = Object.freeze({ path: 'cyan', gitLabel: '8', branch: 'magenta', ahead: '2', behind: '1', arrow: 'yellow' });
const ZSH_NAMES = Object.freeze({ path: 'path', gitLabel: 'git', branch: 'branch', ahead: 'ahead', behind: 'behind', arrow: 'arrow' });

/** Shell code/data for the prompt colors. Every color is re-validated here, so nothing but
 * `#rrggbb` (or an empty default) can ever reach generated shell code. */
function shellThemes(appearance) {
  const prompt = pickColors(appearance?.prompt, PROMPT_KEYS, Object.fromEntries(PROMPT_KEYS.map(key => [key, ''])), true);
  const flag = prompt.flag || DEFAULT_FLAG;
  const keys = PROMPT_KEYS.filter(key => key !== 'flag');
  const zshLine = (key, truecolor) => {
    const color = prompt[key];
    return `__mullion_c_${ZSH_NAMES[key]}='%F{${color ? truecolor ? color : nearest256(color) : ZSH_DEFAULTS[key]}}'`;
  };
  const zsh = [
    '# Generated by Mullion Terminal; rewritten whenever the appearance changes.',
    'if (( __mullion_truecolor )); then',
    ...keys.map(key => `  ${zshLine(key, true)}`),
    `  __mullion_highlight_face='fg=${flag}'`,
    'else',
    ...keys.map(key => `  ${zshLine(key, false)}`),
    `  __mullion_highlight_face='fg=${nearest256(flag)}'`,
    'fi',
    '',
  ].join('\n');
  const bash = [
    '# Generated by Mullion Terminal; rewritten whenever the appearance changes.',
    ...keys.map(key => `__mullion_c_${ZSH_NAMES[key]}='\\[\\e[${prompt[key] ? truecolorCode(prompt[key]) : ANSI_DEFAULTS[key]}m\\]'`),
    '',
  ].join('\n');
  // PowerShell reads this as data (key=SGR parameters), never as a script: dot-sourcing a file
  // would be refused under Windows' default execution policy.
  const powershell = [
    ...keys.map(key => `${ZSH_NAMES[key]}=${prompt[key] ? truecolorCode(prompt[key]) : key === 'path' || key === 'arrow' ? '' : ANSI_DEFAULTS[key]}`),
    `flag=${truecolorCode(flag)}`,
    '',
  ].join('\n');
  return { zsh, bash, powershell };
}

const THEME_FILES = Object.freeze({ zsh: 'theme.zsh', bash: 'theme.bash', powershell: 'theme-powershell.txt' });

function themeFiles(directory) {
  return Object.fromEntries(Object.entries(THEME_FILES).map(([shell, name]) => [shell, path.join(directory, name)]));
}

/** Atomically (re)writes the three theme files; a prompt reading one mid-update sees either
 * the old or the new file, never half of one. */
async function writeShellThemes(directory, appearance) {
  const themes = shellThemes(appearance);
  const files = themeFiles(directory);
  await Promise.all(Object.entries(themes).map(async ([shell, content]) => {
    const temporary = path.join(directory, `.theme-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, files[shell]);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }));
}

module.exports = {
  PRESETS, PRESET_IDS, UI_KEYS, ANSI_KEYS, TERMINAL_KEYS, PROMPT_KEYS, DEFAULT_FONTS, DEFAULT_FLAG,
  defaultAppearance, normalizeAppearance, normalizeFonts, nearest256, shellThemes, themeFiles, writeShellThemes,
};
