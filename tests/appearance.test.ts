import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRESETS, PRESET_IDS, cssVariables, defaultAppearance, deriveUiTokens, effectivePromptColor, fontStack, luminance, mix,
  withAppearanceReset, withColor, withPreset, withSectionReset, xtermTheme, DEFAULT_TERMINAL_FONT,
} from '../src/appearance';
import type { Settings } from '../src/types';

const base: Settings = { autoComplete: true, showSuggestions: true, fontSize: 13, theme: 'dark', showHiddenFiles: false, finderQuickAction: true, openWithTarget: 'tab', appearance: defaultAppearance('dark') };

// The stylesheet's own tokens: the default appearance must reproduce them exactly.
function stylesheetTokens(selector: string) {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const block = css.split('\n').find(line => line.startsWith(`${selector} {`))!;
  return Object.fromEntries([...block.matchAll(/(--[a-z-]+):([^;]+);/g)].map(match => [match[1], match[2]]));
}

test('the default palettes derive exactly the stylesheet tokens', () => {
  for (const [theme, selector] of [['dark', ':root'], ['light', ':root[data-theme=light]']] as const) {
    const sheet = stylesheetTokens(selector);
    const derived = deriveUiTokens(defaultAppearance(theme).ui, theme);
    for (const [name, value] of Object.entries(derived)) {
      const expected = sheet[name] === '#fff' ? '#ffffff' : sheet[name];
      assert.equal(value, expected, `${theme} ${name}`);
    }
  }
});

test('the default xterm.js themes match the previous built-in ones', () => {
  const dark = xtermTheme(defaultAppearance('dark'), 'dark');
  assert.equal(dark.background, '#161c28');
  assert.equal(dark.cursorAccent, '#161c28');
  assert.equal(dark.selectionBackground, '#ff7a5c40');
  assert.equal(dark.magenta, '#d68cf0');
  const light = xtermTheme(defaultAppearance('light'), 'light');
  assert.equal(light.background, '#ffffff');
  assert.equal(light.selectionBackground, '#ff6b4a30');
  // Light only ever set bright black; the rest were xterm.js's own defaults.
  assert.equal(light.brightBlack, '#6b7385');
  assert.equal(light.brightRed, '#ef2929');
  assert.equal(light.brightWhite, '#eeeeec');
});

test('changed colors derive coherent in-between tokens', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  const ui = { ...defaultAppearance('dark').ui, background: '#000000', panel: '#202020', accent: '#00ff00' };
  const tokens = deriveUiTokens(ui, 'dark');
  assert.equal(tokens['--inset'], '#101010', 'between background and panels');
  assert.equal(tokens['--accent-soft'], 'rgba(0,255,0,0.12)');
  assert.notEqual(tokens['--accent-text'], '#ff8e74');
  assert.equal(tokens['--faint'], mix(ui.muted, '#000000', 0.38));
  assert.ok(luminance('#ffffff') > 0.99 && luminance('#000000') === 0);
});

test('a preset fills every color; editing one makes it custom; matching colors return to the preset', () => {
  const dracula = withPreset(base, 'dracula');
  assert.equal(dracula.appearance.preset, 'dracula');
  assert.equal(dracula.theme, 'dark');
  assert.deepEqual(dracula.appearance.terminal, PRESETS.dracula.terminal);
  const solarized = withPreset(dracula, 'solarized-light');
  assert.equal(solarized.theme, 'light');
  const edited = withColor(dracula, 'prompt', 'branch', '#ff0000');
  assert.equal(edited.appearance.preset, 'custom');
  assert.equal(edited.appearance.prompt.branch, '#ff0000');
  assert.equal(edited.appearance.ui.background, PRESETS.dracula.ui.background, 'other colors are kept');
  assert.equal(withColor(edited, 'prompt', 'branch', PRESETS.dracula.prompt.branch).appearance.preset, 'dracula');
  // Light/dark follows the interface background for a custom palette.
  assert.equal(withColor(base, 'ui', 'background', '#fafafa').theme, 'light');
  assert.equal(withColor(withPreset(base, 'mullion-light'), 'ui', 'background', '#101010').theme, 'dark');
  const withFonts = { ...base, appearance: { ...base.appearance, fonts: { terminalFamily: 'Menlo', lineHeight: 1.4, uiFamily: '' } } };
  for (const id of PRESET_IDS) assert.deepEqual(withPreset(withFonts, id).appearance.fonts, withFonts.appearance.fonts, `${id} keeps the chosen fonts`);
});

test('section and full resets return to the Mullion defaults for the current base', () => {
  const custom = withColor(withColor(withColor(base, 'ui', 'accent', '#00ff00'), 'terminal', 'red', '#123456'), 'prompt', 'path', '#abcdef');
  const fonts = { ...custom, fontSize: 18, appearance: { ...custom.appearance, fonts: { terminalFamily: 'Fira Code', lineHeight: 1.5, uiFamily: 'Roboto' } } };
  const uiReset = withSectionReset(fonts, 'ui');
  assert.equal(uiReset.appearance.ui.accent, '#ff7a5c');
  assert.equal(uiReset.appearance.terminal.red, '#123456', 'other sections are untouched');
  assert.equal(withSectionReset(fonts, 'ansi').appearance.terminal.red, PRESETS['mullion-dark'].terminal.red);
  const all = withSectionReset(withSectionReset(uiReset, 'ansi'), 'prompt');
  assert.equal(all.appearance.preset, 'mullion-dark', 'every section back to Mullion is the Mullion preset again');
  const restored = withAppearanceReset(fonts);
  assert.deepEqual(restored.appearance, defaultAppearance('dark'));
  assert.equal(restored.fontSize, 13);
  assert.equal(restored.autoComplete, fonts.autoComplete);
  assert.deepEqual(withAppearanceReset({ ...fonts, theme: 'light' }).appearance, defaultAppearance('light'));
});

test('prompt colors left on default show the terminal palette color they map to', () => {
  const appearance = defaultAppearance('dark');
  assert.equal(effectivePromptColor(appearance, 'path'), appearance.terminal.cyan);
  assert.equal(effectivePromptColor(appearance, 'gitLabel'), appearance.terminal.brightBlack);
  assert.equal(effectivePromptColor(appearance, 'branch'), appearance.terminal.magenta);
  assert.equal(effectivePromptColor(appearance, 'flag'), '#2f81f7');
  assert.equal(effectivePromptColor({ ...appearance, prompt: { ...appearance.prompt, branch: '#ff0000' } }, 'branch'), '#ff0000');
});

test('font stacks quote names, keep generic families, and always fall back', () => {
  assert.equal(fontStack('', DEFAULT_TERMINAL_FONT), DEFAULT_TERMINAL_FONT);
  assert.equal(fontStack('JetBrains Mono', DEFAULT_TERMINAL_FONT), `"JetBrains Mono", ${DEFAULT_TERMINAL_FONT}`);
  assert.equal(fontStack('Fira Code, monospace', 'x'), '"Fira Code", monospace, x');
  assert.equal(fontStack('x"; color: red', 'fallback'), 'fallback', 'anything but plain names is ignored');
  const variables = cssVariables(defaultAppearance('dark'), 'dark');
  assert.equal(variables['--terminal-bg'], '#161c28');
  assert.equal(variables['--mono'], DEFAULT_TERMINAL_FONT);
});
