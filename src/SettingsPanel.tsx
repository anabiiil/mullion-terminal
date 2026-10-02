import { useEffect, useRef, useState } from 'react';
import { X, Sun, Moon, Trash2, Keyboard, Sparkles } from 'lucide-react';
import type { Settings } from './types';
interface Props { settings: Settings; update(settings: Settings): void; clearHistory(): void; close(): void; platform?: string; }
export default function SettingsPanel({ settings, update, clearHistory, close, platform }: Props) {
  const [confirm, setConfirm] = useState(false);
  // App-level shortcuts are Cmd on macOS and Ctrl+Shift elsewhere (plain Ctrl+T/W/B stay with the shell).
  const mac = platform === 'darwin';
  const chord = (key: 'T' | 'W' | 'B') => mac ? `⌘${key}` : `Ctrl+Shift+${key}`;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} tabIndex={-1} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const elements = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button, input, select')).filter(element => !element.hasAttribute('disabled'));
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="modal-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h2 id="settings-title">Settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={close}><X size={18} /></button></div>
      <div className="settings-section"><h3><Sparkles size={14} /> COMPLETION</h3>
        <label className="setting-row"><div><strong>Auto-complete</strong><p>On: suggestion list. Off: a faint inline completion.</p></div><input aria-label="Auto-complete" className="switch" type="checkbox" checked={settings.autoComplete} onChange={event => update({ ...settings, autoComplete: event.target.checked })} /></label>
        <div className="mode-explanation">{settings.autoComplete ? <><kbd>Enter</kbd> completes & runs · <kbd>Tab</kbd> completes only</> : <><kbd>Tab</kbd> accepts the inline text · <kbd>Enter</kbd> runs what you typed</>}</div>
        <label className="setting-row"><div><strong>Suggestions while typing</strong><p>Commands, paths, and your own command history.</p></div><input aria-label="Suggestions while typing" className="switch" type="checkbox" checked={settings.showSuggestions} onChange={event => update({ ...settings, showSuggestions: event.target.checked })} /></label>
      </div>
      <div className="settings-section"><h3>APPEARANCE</h3>
        <div className="setting-row"><div><strong>Theme</strong><p>The familiar Mullion palette.</p></div><div className="theme-selector"><button className={settings.theme === 'light' ? 'chosen' : ''} onClick={() => update({ ...settings, theme: 'light' })}><Sun size={14} /> Light</button><button className={settings.theme === 'dark' ? 'chosen' : ''} onClick={() => update({ ...settings, theme: 'dark' })}><Moon size={14} /> Dark</button></div></div>
        <label className="setting-row"><div><strong>Terminal font size</strong><p>SF Mono · Cascadia Code · Menlo · Consolas</p></div><select aria-label="Terminal font size" value={settings.fontSize} onChange={event => update({ ...settings, fontSize: Number(event.target.value) })}>{[11, 12, 13, 14, 15, 16, 18, 20].map(size => <option key={size} value={size}>{size} px</option>)}</select></label>
        <label className="setting-row"><div><strong>Show hidden files</strong><p>Include dotfiles in the directory tree.</p></div><input aria-label="Show hidden files" className="switch" type="checkbox" checked={settings.showHiddenFiles} onChange={event => update({ ...settings, showHiddenFiles: event.target.checked })} /></label>
      </div>
      {mac && <div className="settings-section"><h3>FINDER</h3>
        <label className="setting-row"><div><strong>Show “Open in Mullion Terminal” in Finder's right-click menu</strong><p>A Quick Action for any file or folder.</p></div><input aria-label="Show “Open in Mullion Terminal” in Finder's right-click menu" className="switch" type="checkbox" checked={settings.finderQuickAction} onChange={event => update({ ...settings, finderQuickAction: event.target.checked })} /></label>
      </div>}
      <div className="settings-section"><h3><Keyboard size={14} /> SHORTCUTS</h3><div className="shortcut-grid"><span>New terminal</span><kbd>{chord('T')}</kbd><span>Close tab</span><kbd>{chord('W')}</kbd><span>Toggle sidebar</span><kbd>{chord('B')}</kbd><span>Settings</span><kbd>⌘ / Ctrl + ,</kbd><span>Copy selection</span><kbd>⌘ / Ctrl + C</kbd><span>Paste</span><kbd>⌘ / Ctrl + V</kbd><span>Clear terminal</span><kbd>⌘ + K / Ctrl + Shift + K</kbd><span>Save (while editing)</span><kbd>{mac ? '⌘S' : 'Ctrl+S'}</kbd><span>Shell history</span><kbd>↑ when suggestions are closed</kbd></div></div>
      <div className="privacy-row"><div><strong>Learning stays on this device.</strong><p>Only commands you run in this app are saved.</p></div><button className="danger-button" onClick={() => { if (confirm) { clearHistory(); setConfirm(false); } else setConfirm(true); }}><Trash2 size={13} />{confirm ? 'Confirm clear' : 'Clear history'}</button></div>
    </div>
  </div>;
}
