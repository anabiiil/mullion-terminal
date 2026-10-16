import type { ITheme } from '@xterm/xterm';
import presetData from '../electron/appearance-presets.json';
import type { Appearance, Fonts, PresetId, PromptColors, Settings, TerminalColors, UiColors } from './types';

// Renderer side of Settings › Appearance: presets, the CSS tokens and xterm.js theme derived from
// the chosen colors, and the edits the panel makes. electron/appearance.cjs validates every saved
// value with the same presets file; anything here only ever reads already-shaped settings.

type Theme = Settings['theme'];
interface Preset { name: string; theme: Theme; ui: UiColors; terminal: TerminalColors; prompt: PromptColors; }
export const PRESETS = presetData as Record<PresetId, Preset>;
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
export const DEFAULT_FONTS: Fonts = { terminalFamily: '', lineHeight: 1.22, uiFamily: '' };
export const DEFAULT_FONT_SIZE = 13;
export const DEFAULT_FLAG = '#2f81f7';
export const DEFAULT_TERMINAL_FONT = '"SF Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace';
export const DEFAULT_UI_FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
export const TERMINAL_FONT_SUGGESTIONS = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Source Code Pro', 'IBM Plex Mono', 'Ubuntu Mono', 'monospace'];
export const UI_FONT_SUGGESTIONS = ['Inter', 'system-ui', 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', 'Roboto', 'Ubuntu', 'sans-serif'];
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FONT = /^[\p{L}\p{N} ._,-]*$/u;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont']);

export function defaultAppearance(theme: Theme = 'dark'): Appearance {
  return presetAppearance(theme === 'light' ? 'mullion-light' : 'mullion-dark', DEFAULT_FONTS);
}

export function presetAppearance(id: PresetId, fonts: Fonts): Appearance {
  const preset = PRESETS[id];
  return { preset: id, ui: { ...preset.ui }, terminal: { ...preset.terminal }, prompt: { ...preset.prompt }, fonts: { ...fonts } };
}

function rgb(color: string): [number, number, number] {
  return [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16)) as [number, number, number];
}
function toHex(channels: number[]) {
  return `#${channels.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`;
}
/** `from` moved `amount` (0–1) of the way toward `to`. */
export function mix(from: string, to: string, amount: number) {
  const a = rgb(from), b = rgb(to);
  return toHex(a.map((value, index) => value + (b[index] - value) * amount));
}
export function alpha(color: string, opacity: number) { return `rgba(${rgb(color).join(',')},${opacity})`; }
/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(color: string) {
  const [r, g, b] = rgb(color).map(value => { const channel = value / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The stylesheet's hand-tuned in-between tokens for the two Mullion palettes. A derived token
// keeps its hand-tuned value while every color it is derived from is still the Mullion one, so
// the default look is exactly the stylesheet's; any change to an input derives it instead.
const TUNED: Record<Theme, { inset: string; row: string; faint: string; accentText: string; accentSoft: string }> = {
  dark: { inset: '#121722', row: '#1e2430', faint: '#5e6678', accentText: '#ff8e74', accentSoft: 'rgba(255,122,92,.12)' },
  light: { inset: '#f6f7fa', row: '#eef0f4', faint: '#a3a9b7', accentText: '#c4452a', accentSoft: 'rgba(255,107,74,.1)' },
};

/** The full set of UI tokens (CSS custom property → value) for a palette of seven colors. */
export function deriveUiTokens(ui: UiColors, theme: Theme): Record<string, string> {
  const reference = PRESETS[theme === 'light' ? 'mullion-light' : 'mullion-dark'].ui;
  const tuned = TUNED[theme];
  const same = (...keys: (keyof UiColors)[]) => keys.every(key => ui[key] === reference[key]);
  const dark = theme === 'dark';
  return {
    '--bg': ui.background,
    '--card': ui.panel,
    '--inset': same('background', 'panel') ? tuned.inset : mix(ui.background, ui.panel, 0.5),
    '--text': ui.text,
    '--muted': ui.muted,
    '--faint': same('muted', 'background') ? tuned.faint : mix(ui.muted, ui.background, 0.38),
    '--border': ui.border,
    '--row': same('panel', 'text') ? tuned.row : mix(ui.panel, ui.text, dark ? 0.045 : 0.065),
    '--accent': ui.accent,
    '--accent-text': same('accent', 'text') ? tuned.accentText : mix(ui.accent, ui.text, dark ? 0.15 : 0.3),
    '--accent-soft': same('accent') ? tuned.accentSoft : alpha(ui.accent, dark ? 0.12 : 0.1),
    '--flag': ui.flag,
  };
}

function cleanFamily(family: string) {
  const trimmed = family.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 120 && FONT.test(trimmed) ? trimmed : '';
}
/** A CSS font-family list: the chosen names first (quoted), then the built-in stack as fallback. */
export function fontStack(family: string, fallback: string) {
  const names = cleanFamily(family).split(',').map(name => name.trim()).filter(Boolean)
    .map(name => GENERIC_FONTS.has(name.toLowerCase()) ? name : `"${name}"`);
  return names.length ? `${names.join(', ')}, ${fallback}` : fallback;
}

/** Everything App sets on <html>: the UI tokens, the terminal area's own background and the fonts. */
export function cssVariables(appearance: Appearance, theme: Theme): Record<string, string> {
  return {
    ...deriveUiTokens(appearance.ui, theme),
    '--terminal-bg': appearance.terminal.background,
    '--mono': fontStack(appearance.fonts.terminalFamily, DEFAULT_TERMINAL_FONT),
    '--ui-font': fontStack(appearance.fonts.uiFamily, DEFAULT_UI_FONT),
  };
}

export function xtermTheme(appearance: Appearance, theme: Theme): ITheme {
  const { background, foreground, cursor, selection, ...ansi } = appearance.terminal;
  // Selection was always the cursor color, translucent: 25% on dark, 19% on light.
  return { ...ansi, background, foreground, cursor, cursorAccent: background, selectionBackground: `${selection}${theme === 'light' ? '30' : '40'}` };
}

// What a prompt color left on its default actually shows: the terminal palette entry the shell
// integration's plain ANSI code maps to (the flag highlight has its own fixed default).
const PROMPT_PALETTE: Record<Exclude<keyof PromptColors, 'flag'>, keyof TerminalColors> = { path: 'cyan', gitLabel: 'brightBlack', branch: 'magenta', ahead: 'green', behind: 'red', arrow: 'yellow' };
export function effectivePromptColor(appearance: Appearance, key: keyof PromptColors) {
  const chosen = appearance.prompt[key];
  if (chosen) return chosen;
  return key === 'flag' ? DEFAULT_FLAG : appearance.terminal[PROMPT_PALETTE[key]];
}

function samePalette(appearance: Appearance, preset: Preset) {
  const equal = <T extends object>(a: T, b: T) => (Object.keys(b) as (keyof T)[]).every(key => a[key] === b[key]);
  return equal(appearance.ui, preset.ui) && equal(appearance.terminal, preset.terminal) && equal(appearance.prompt, preset.prompt);
}

/** Settings after a palette edit: back on a named preset when the colors match one exactly,
 * otherwise `custom`, with light/dark following the interface background. */
export function withPalette(settings: Settings, appearance: Appearance): Settings {
  const match = PRESET_IDS.find(id => samePalette(appearance, PRESETS[id]));
  if (match) return { ...settings, theme: PRESETS[match].theme, appearance: { ...appearance, preset: match } };
  return { ...settings, theme: luminance(appearance.ui.background) < 0.4 ? 'dark' : 'light', appearance: { ...appearance, preset: 'custom' } };
}

export type ColorGroup = 'ui' | 'terminal' | 'prompt';
export function withColor(settings: Settings, group: ColorGroup, key: string, value: string): Settings {
  const appearance = settings.appearance;
  return withPalette(settings, { ...appearance, [group]: { ...appearance[group], [key]: value } });
}

export function withPreset(settings: Settings, id: PresetId): Settings {
  return { ...settings, theme: PRESETS[id].theme, appearance: presetAppearance(id, settings.appearance.fonts) };
}

/** One section back to the Mullion colors for the current light/dark base. */
export function withSectionReset(settings: Settings, group: ColorGroup | 'ansi'): Settings {
  const base = PRESETS[settings.theme === 'light' ? 'mullion-light' : 'mullion-dark'];
  const appearance = settings.appearance;
  if (group === 'ansi') {
    const { background, foreground, cursor, selection } = appearance.terminal;
    return withPalette(settings, { ...appearance, terminal: { ...base.terminal, background, foreground, cursor, selection } });
  }
  if (group === 'terminal') {
    const { background, foreground, cursor, selection } = base.terminal;
    return withPalette(settings, { ...appearance, terminal: { ...appearance.terminal, background, foreground, cursor, selection } });
  }
  return withPalette(settings, { ...appearance, [group]: { ...base[group] } });
}

/** Every color, font and the terminal font size back to the Mullion defaults for the current base. */
export function withAppearanceReset(settings: Settings): Settings {
  return { ...settings, fontSize: DEFAULT_FONT_SIZE, appearance: defaultAppearance(settings.theme) };
}
