import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, Sun, Moon, Trash2, Keyboard, Sparkles, Palette, Type, RotateCcw, SlidersHorizontal, TerminalSquare, PanelsTopLeft } from 'lucide-react';
import type { AnsiColors, PresetId, PromptColors, Settings, TerminalColors, UiColors } from './types';
import {
  DEFAULT_TERMINAL_FONT, HEX_COLOR, PRESETS, PRESET_IDS, TERMINAL_FONT_SUGGESTIONS, UI_FONT_SUGGESTIONS,
  effectivePromptColor, fontStack, withAppearanceReset, withColor, withPreset, withSectionReset, type ColorGroup,
} from './appearance';

interface UpdateOptions { defer?: boolean }
interface Props { settings: Settings; update(settings: Settings, options?: UpdateOptions): void; clearHistory(): void; close(): void; platform?: string; }
type Tab = 'general' | 'appearance';
// The last tab stays selected while the app runs, so tweaking colors doesn't mean re-finding them.
let lastTab: Tab = 'general';

const UI_ROWS: [keyof UiColors, string, string][] = [
  ['background', 'Background', 'Title bar and window'],
  ['panel', 'Panels', 'Tabs, cards, dialogs'],
  ['text', 'Text', 'Primary text'],
  ['muted', 'Secondary text', 'Labels and hints'],
  ['accent', 'Accent', 'Switches, highlights'],
  ['border', 'Borders', 'Dividers and outlines'],
  ['flag', 'Command flags', 'In history lists'],
];
const TERMINAL_ROWS: [keyof TerminalColors, string][] = [['background', 'Background'], ['foreground', 'Text'], ['cursor', 'Cursor'], ['selection', 'Selection']];
const ANSI_ROWS: [keyof AnsiColors, string][] = [
  ['black', 'Black'], ['red', 'Red'], ['green', 'Green'], ['yellow', 'Yellow'], ['blue', 'Blue'], ['magenta', 'Magenta'], ['cyan', 'Cyan'], ['white', 'White'],
  ['brightBlack', 'Bright black'], ['brightRed', 'Bright red'], ['brightGreen', 'Bright green'], ['brightYellow', 'Bright yellow'], ['brightBlue', 'Bright blue'], ['brightMagenta', 'Bright magenta'], ['brightCyan', 'Bright cyan'], ['brightWhite', 'Bright white'],
];
// [key, label, what the default color is]
const PROMPT_ROWS: [keyof PromptColors, string, string][] = [
  ['path', 'Path', 'Terminal cyan'],
  ['gitLabel', 'git:( ) and upstream', 'Terminal bright black'],
  ['branch', 'Branch', 'Terminal magenta'],
  ['ahead', 'Ahead ↑', 'Terminal green'],
  ['behind', 'Behind ↓', 'Terminal red'],
  ['arrow', 'Prompt ❯', 'Terminal yellow'],
  ['flag', 'Flags while typing', 'Blue'],
];

interface ColorRowProps { id: string; label: string; hint?: string; value: string; shown: string; defaultLabel?: string; onChange(value: string, defer: boolean): void; }
/** Label, native color picker, and a #rrggbb field that applies once it's valid. A prompt color may
 * be left on its default (`value` is ''), shown with the color it currently resolves to. */
function ColorRow({ id, label, hint, value, shown, defaultLabel, onChange }: ColorRowProps) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const invalid = draft !== '' && !HEX_COLOR.test(draft);
  return <div className="color-row" data-color={id}>
    <label className="color-swatch" style={{ background: shown }}>
      <input type="color" aria-label={`${label} color`} value={shown} onChange={event => onChange(event.target.value.toLowerCase(), true)} />
    </label>
    <div className="color-label"><strong>{label}</strong>{value === '' && defaultLabel ? <span>Default · {defaultLabel}</span> : hint && <span>{hint}</span>}</div>
    <input className="color-hex" aria-label={`${label} hex value`} aria-invalid={invalid} spellCheck={false} maxLength={7} placeholder={defaultLabel ? 'Default' : '#rrggbb'} value={draft}
      onFocus={() => setEditing(true)}
      onBlur={() => { setEditing(false); setDraft(value); }}
      onChange={event => {
        const next = event.target.value.trim().toLowerCase();
        setDraft(next);
        const normalized = next.startsWith('#') ? next : `#${next}`;
        if (HEX_COLOR.test(normalized)) onChange(normalized, true);
        else if (next === '' && defaultLabel !== undefined) onChange('', true);
      }}
      onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
    {defaultLabel !== undefined && <button className="icon-button color-default" aria-label={`Use the default ${label} color`} title="Use the default color" disabled={value === ''} onClick={() => onChange('', false)}><RotateCcw size={12} /></button>}
  </div>;
}

function SectionHeading({ icon, title, onReset, resetLabel }: { icon: ReactNode; title: string; onReset(): void; resetLabel: string }) {
  return <div className="appearance-heading"><h3>{icon} {title}</h3><button className="text-button" aria-label={resetLabel} onClick={onReset}><RotateCcw size={11} /> Reset</button></div>;
}

function AppearanceTab({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  const { appearance } = settings;
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restored, setRestored] = useState<Settings | null>(null);
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => setRestored(null), 5000);
    return () => clearTimeout(timer);
  }, [restored]);
  const color = (group: ColorGroup) => (key: string, value: string, defer: boolean) => update(withColor(settings, group, key, value), { defer });
  const reset = (group: ColorGroup | 'ansi') => update(withSectionReset(settings, group));
  const fonts = (patch: Partial<Settings['appearance']['fonts']>, defer = true) => update({ ...settings, appearance: { ...appearance, fonts: { ...appearance.fonts, ...patch } } }, { defer });
  const prompt = (key: keyof PromptColors) => ({ color: effectivePromptColor(appearance, key) });
  const terminalFont = fontStack(appearance.fonts.terminalFamily, DEFAULT_TERMINAL_FONT);
  const base = settings.theme === 'light' ? 'Mullion Light' : 'Mullion Dark';
  const isDefault = appearance.preset === (settings.theme === 'light' ? 'mullion-light' : 'mullion-dark') && !appearance.fonts.terminalFamily && !appearance.fonts.uiFamily && appearance.fonts.lineHeight === 1.22 && settings.fontSize === 13;

  return <div className="appearance-tab" role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance">
    <div className="restore-bar">
      {confirmRestore
        ? <><span role="status">Restore the {base} colors and fonts?</span><div><button className="primary-button" onClick={() => { setRestored(settings); update(withAppearanceReset(settings)); setConfirmRestore(false); }}>Restore</button><button className="secondary-button" onClick={() => setConfirmRestore(false)}>Cancel</button></div></>
        : <><span>{isDefault ? `Using the default ${base} look.` : `Customized · default is ${base}.`}</span><button className="secondary-button restore-button" disabled={isDefault} onClick={() => setConfirmRestore(true)}><RotateCcw size={12} /> Restore default appearance</button></>}
    </div>

    <div className="appearance-preview" aria-label="Preview" role="img" style={{ background: appearance.terminal.background, color: appearance.terminal.foreground, fontFamily: terminalFont, fontSize: settings.fontSize, lineHeight: appearance.fonts.lineHeight }}>
      <div><span style={prompt('path')}>…/Packages/mullion</span> <span style={prompt('gitLabel')}>git:(</span><span style={prompt('branch')}>main</span><span style={prompt('gitLabel')}> → origin/main</span> <span style={prompt('ahead')}>↑1</span><span style={prompt('gitLabel')}>)</span> <span style={prompt('arrow')}>❯</span> git commit <span style={prompt('flag')}>--amend</span> <span style={prompt('flag')}>-m</span> "msg"</div>
      <div><span style={{ color: appearance.terminal.green }}>✔</span> [main 3f2c1a0] msg <span style={{ color: appearance.terminal.red }}>1 file changed</span></div>
      <div><span style={prompt('path')}>…/Packages/mullion</span> <span style={prompt('gitLabel')}>git:(</span><span style={prompt('branch')}>main</span><span style={prompt('gitLabel')}>)</span> <span style={prompt('arrow')}>❯</span> <span className="preview-cursor" style={{ background: appearance.terminal.cursor }} /></div>
    </div>

    <label className="setting-row"><div><strong>Preset</strong><p>Fills every color below. Editing any color makes it Custom.</p></div>
      <select aria-label="Color preset" value={appearance.preset} onChange={event => { if (event.target.value !== 'custom') update(withPreset(settings, event.target.value as PresetId)); }}>
        {PRESET_IDS.map(id => <option key={id} value={id}>{PRESETS[id].name}</option>)}
        {appearance.preset === 'custom' && <option value="custom">Custom</option>}
      </select>
    </label>

    <div className="settings-section"><div className="appearance-heading"><h3><Type size={12} /> FONTS</h3><button className="text-button" aria-label="Reset fonts" onClick={() => update({ ...settings, fontSize: 13, appearance: { ...appearance, fonts: { terminalFamily: '', lineHeight: 1.22, uiFamily: '' } } })}><RotateCcw size={11} /> Reset</button></div>
      <label className="setting-row"><div><strong>Terminal font</strong><p>Any installed font; the built-in monospace stack is the fallback.</p></div>
        <input className="font-input" aria-label="Terminal font" list="terminal-font-suggestions" placeholder="SF Mono, Menlo…" maxLength={120} value={appearance.fonts.terminalFamily} onChange={event => fonts({ terminalFamily: event.target.value })} />
      </label>
      <datalist id="terminal-font-suggestions">{TERMINAL_FONT_SUGGESTIONS.map(name => <option key={name} value={name} />)}</datalist>
      <label className="setting-row"><div><strong>Terminal font size</strong><p>10–24 px</p></div>
        <span className="range-field"><input type="range" aria-label="Terminal font size" min={10} max={24} step={1} value={settings.fontSize} onChange={event => update({ ...settings, fontSize: Number(event.target.value) }, { defer: true })} /><output>{settings.fontSize} px</output></span>
      </label>
      <label className="setting-row"><div><strong>Line height</strong><p>1.0–1.8</p></div>
        <span className="range-field"><input type="range" aria-label="Line height" min={1} max={1.8} step={0.02} value={appearance.fonts.lineHeight} onChange={event => fonts({ lineHeight: Math.round(Number(event.target.value) * 100) / 100 })} /><output>{appearance.fonts.lineHeight.toFixed(2)}</output></span>
      </label>
      <label className="setting-row"><div><strong>Interface font</strong><p>Menus, tabs and sidebars.</p></div>
        <input className="font-input" aria-label="Interface font" list="ui-font-suggestions" placeholder="Inter, system-ui…" maxLength={120} value={appearance.fonts.uiFamily} onChange={event => fonts({ uiFamily: event.target.value })} />
      </label>
      <datalist id="ui-font-suggestions">{UI_FONT_SUGGESTIONS.map(name => <option key={name} value={name} />)}</datalist>
    </div>

    <div className="settings-section"><SectionHeading icon={<PanelsTopLeft size={12} />} title="INTERFACE" resetLabel="Reset interface colors" onReset={() => reset('ui')} />
      <div className="color-grid">{UI_ROWS.map(([key, label, hint]) => <ColorRow key={key} id={`ui.${key}`} label={label} hint={hint} value={appearance.ui[key]} shown={appearance.ui[key]} onChange={(value, defer) => color('ui')(key, value, defer)} />)}</div>
    </div>

    <div className="settings-section"><SectionHeading icon={<TerminalSquare size={12} />} title="TERMINAL" resetLabel="Reset terminal colors" onReset={() => reset('terminal')} />
      <div className="color-grid">{TERMINAL_ROWS.map(([key, label]) => <ColorRow key={key} id={`terminal.${key}`} label={label} value={appearance.terminal[key]} shown={appearance.terminal[key]} onChange={(value, defer) => color('terminal')(key, value, defer)} />)}</div>
      <details className="ansi-details"><summary><SlidersHorizontal size={12} /> Advanced: 16 ANSI colors</summary>
        <div className="color-grid ansi">{ANSI_ROWS.map(([key, label]) => <ColorRow key={key} id={`terminal.${key}`} label={label} value={appearance.terminal[key]} shown={appearance.terminal[key]} onChange={(value, defer) => color('terminal')(key, value, defer)} />)}</div>
        <button className="text-button" aria-label="Reset ANSI colors" onClick={() => reset('ansi')}><RotateCcw size={11} /> Reset ANSI colors</button>
      </details>
    </div>

    <div className="settings-section"><SectionHeading icon={<Palette size={12} />} title="PROMPT" resetLabel="Reset prompt colors" onReset={() => reset('prompt')} />
      <p className="section-note">Open shells pick up changes at their next prompt.</p>
      <div className="color-grid">{PROMPT_ROWS.map(([key, label, fallback]) => <ColorRow key={key} id={`prompt.${key}`} label={label} defaultLabel={fallback} value={appearance.prompt[key]} shown={effectivePromptColor(appearance, key)} onChange={(value, defer) => color('prompt')(key, value, defer)} />)}</div>
    </div>

    {restored && <div className="undo-toast" role="status"><span>Default appearance restored.</span><button onClick={() => { update({ ...settings, theme: restored.theme, fontSize: restored.fontSize, appearance: restored.appearance }); setRestored(null); }}>Undo</button></div>}
  </div>;
}

export default function SettingsPanel({ settings, update, clearHistory, close, platform }: Props) {
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState<Tab>(lastTab);
  useEffect(() => { lastTab = tab; }, [tab]);
  // App-level shortcuts are Cmd on macOS and Ctrl+Shift elsewhere (plain Ctrl+T/W/B stay with the shell).
  const mac = platform === 'darwin';
  const chord = (key: 'T' | 'W' | 'B' | 'N') => mac ? `⌘${key}` : `Ctrl+Shift+${key}`;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  const mullion = settings.appearance.preset === 'mullion-dark' || settings.appearance.preset === 'mullion-light';
  const tabButton = (id: Tab, label: string) => <button role="tab" id={`settings-tab-${id}`} aria-selected={tab === id} aria-controls={`settings-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}
    onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = tab === 'general' ? 'appearance' : 'general'; setTab(next); document.getElementById(`settings-tab-${next}`)?.focus(); } }}>{label}</button>;
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} tabIndex={-1} className={`settings-modal ${tab}`} role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const elements = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button, input, select, summary')).filter(element => !element.hasAttribute('disabled') && element.tabIndex !== -1);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="modal-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h2 id="settings-title">Settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={close}><X size={18} /></button></div>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">{tabButton('general', 'General')}{tabButton('appearance', 'Appearance')}</div>
      {tab === 'appearance' ? <AppearanceTab settings={settings} update={update} /> : <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
        <div className="settings-section"><h3><Sparkles size={14} /> COMPLETION</h3>
          <label className="setting-row"><div><strong>Auto-complete</strong><p>On: suggestion list. Off: a faint inline completion.</p></div><input aria-label="Auto-complete" className="switch" type="checkbox" checked={settings.autoComplete} onChange={event => update({ ...settings, autoComplete: event.target.checked })} /></label>
          <div className="mode-explanation">{settings.autoComplete ? <><kbd>Enter</kbd> completes & runs · <kbd>Tab</kbd> completes only</> : <><kbd>Tab</kbd> accepts the inline text · <kbd>Enter</kbd> runs what you typed</>}</div>
          <label className="setting-row"><div><strong>Suggestions while typing</strong><p>Commands, paths, and your own command history.</p></div><input aria-label="Suggestions while typing" className="switch" type="checkbox" checked={settings.showSuggestions} onChange={event => update({ ...settings, showSuggestions: event.target.checked })} /></label>
        </div>
        <div className="settings-section"><h3>LOOK</h3>
          <div className="setting-row"><div><strong>Theme</strong><p>Mullion Light or Dark. <button className="inline-link" onClick={() => setTab('appearance')}>Presets, colors and fonts</button></p></div><div className="theme-selector"><button className={mullion && settings.theme === 'light' ? 'chosen' : ''} onClick={() => update(withPreset(settings, 'mullion-light'))}><Sun size={14} /> Light</button><button className={mullion && settings.theme === 'dark' ? 'chosen' : ''} onClick={() => update(withPreset(settings, 'mullion-dark'))}><Moon size={14} /> Dark</button></div></div>
          <label className="setting-row"><div><strong>Show hidden files</strong><p>{platform === 'win32' ? 'Include dotfiles and hidden items in the directory tree.' : 'Include dotfiles in the directory tree.'}</p></div><input aria-label="Show hidden files" className="switch" type="checkbox" checked={settings.showHiddenFiles} onChange={event => update({ ...settings, showHiddenFiles: event.target.checked })} /></label>
        </div>
        <div className="settings-section"><h3>OPENING FILES & FOLDERS</h3>
          <label className="setting-row"><div><strong>“Open with Mullion Terminal” opens in</strong><p>{mac ? 'Open With, a Dock drop, or a path on the command line.' : 'The plain menu entry, or a path on the command line.'}</p></div><select aria-label="Open with Mullion Terminal opens in" value={settings.openWithTarget} onChange={event => update({ ...settings, openWithTarget: event.target.value === 'window' ? 'window' : 'tab' })}><option value="tab">New tab</option><option value="window">New window</option></select></label>
          {mac && <label className="setting-row"><div><strong>Show “New Mullion Terminal Tab Here” and “New Mullion Terminal Window Here” in Finder's right-click menu</strong><p>Quick Actions for any file or folder.</p></div><input aria-label="Show Mullion Terminal Quick Actions in Finder's right-click menu" className="switch" type="checkbox" checked={settings.finderQuickAction} onChange={event => update({ ...settings, finderQuickAction: event.target.checked })} /></label>}
        </div>
        <div className="settings-section"><h3><Keyboard size={14} /> SHORTCUTS</h3><div className="shortcut-grid"><span>New terminal</span><kbd>{chord('T')}</kbd><span>New window</span><kbd>{chord('N')} · Ctrl+N</kbd><span>Close tab</span><kbd>{chord('W')}</kbd><span>Toggle sidebar</span><kbd>{chord('B')}</kbd><span>Settings</span><kbd>{mac ? '⌘ / Ctrl + ,' : 'Ctrl+,'}</kbd><span>Copy selection</span><kbd>{mac ? '⌘ / Ctrl + C' : 'Ctrl+C · Ctrl+Shift+C'}</kbd><span>Paste</span><kbd>{mac ? '⌘ / Ctrl + V' : 'Ctrl+V · Ctrl+Shift+V'}</kbd><span>Clear terminal</span><kbd>{mac ? '⌘ + K / Ctrl + Shift + K' : 'Ctrl+Shift+K'}</kbd><span>Save (while editing)</span><kbd>{mac ? '⌘S' : 'Ctrl+S'}</kbd><span>Shell history</span><kbd>↑ when suggestions are closed</kbd></div></div>
        <div className="privacy-row"><div><strong>Learning stays on this device.</strong><p>Only commands you run in this app are saved.</p></div><button className="danger-button" onClick={() => { if (confirm) { clearHistory(); setConfirm(false); } else setConfirm(true); }}><Trash2 size={13} />{confirm ? 'Confirm clear' : 'Clear history'}</button></div>
      </div>}
    </div>
  </div>;
}
