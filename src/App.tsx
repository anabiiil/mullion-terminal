import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, FolderTree, History, Settings as SettingsIcon, Plus, X, Star, Search, Copy, Check, Minus, Square, FolderOpen, FolderPlus, Trash2 } from 'lucide-react';
import type { Bootstrap, HistoryEntry, SessionInfo, Settings } from './types';
import ShellPane, { type ShellHandle } from './ShellPane';
import DirectoryTree from './DirectoryTree';
import SettingsPanel from './SettingsPanel';
import CommandText from './CommandText';
import EditorLauncher from './EditorLauncher';
import { frequentCommands, isBasicCommand } from './completion';
import { subscribe, latestSessionState } from './events';
import { commonAncestor, containsPath } from './explorer-path';
import { nanoEditCommand } from './tree-actions';
import MarkdownPreview from './MarkdownPreview';
import { isMarkdownPath } from './markdown';

const defaults: Settings = { autoComplete: true, showSuggestions: true, fontSize: 13, theme: 'dark', showHiddenFiles: false, finderQuickAction: true };
function basename(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Terminal'; }
// App-level shortcuts are Cmd on macOS and Ctrl+Shift elsewhere (plain Ctrl+T/W/B stay with the shell).
function shortcutLabel(platform: string | undefined, key: 'T' | 'W' | 'B') { return platform === 'darwin' ? `⌘${key}` : `Ctrl+Shift+${key}`; }
function settingsShortcutLabel(platform: string | undefined) { return platform === 'darwin' ? '⌘,' : 'Ctrl+,'; }
function compactPath(path: string, home: string, platform?: string) {
  const separator = platform === 'win32' ? '\\' : '/';
  const display = path === home ? '~' : home && path.startsWith(home + separator) ? '~' + path.slice(home.length) : path;
  const parts = display.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? '…' + separator + parts.slice(-2).join(separator) : display;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [explorerRoots, setExplorerRoots] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState(defaults);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sidebar, setSidebar] = useState<'files' | 'history' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historySort, setHistorySort] = useState<'frequent' | 'recent'>('frequent');
  // A preview belongs to the tab it was opened in, so it never leaks into other tabs.
  const [preview, setPreview] = useState<{ path: string; fragment?: string; sessionId: string } | null>(null);
  const [undo, setUndo] = useState<HistoryEntry | null>(null);
  const [quickMenu, setQuickMenu] = useState<{ command: string; x: number; y: number } | null>(null);
  const handles = useRef(new Map<string, ShellHandle>());
  const settingsRevision = useRef(0);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Session id -> file path, for an "Open with Mullion Terminal" file target
  // whose tab was just created: opened once that session reports ready.
  const pendingOpenFiles = useRef(new Map<string, string>());
  const latest = useRef({ sessions, activeId, explorerRoots, settings, settingsOpen, home: bootstrap?.home ?? '' });
  latest.current = { sessions, activeId, explorerRoots, settings, settingsOpen, home: bootstrap?.home ?? '' };
  const active = sessions.find(session => session.id === activeId);
  const home = bootstrap?.home ?? '';
  const api = window.terminalAPI;

  const reportError = useCallback((value: unknown) => setError(value instanceof Error ? value.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(value)), []);
  const register = useCallback((id: string, handle: ShellHandle | null) => { if (handle) handles.current.set(id, handle); else handles.current.delete(id); }, []);
  const create = useCallback(async (cwd?: string, explicitRoot?: string) => {
    if (!window.terminalAPI) return undefined;
    const inheritedRoot = explicitRoot ?? latest.current.explorerRoots[latest.current.activeId];
    setCreating(true);
    try {
      const created = await window.terminalAPI.createSession(cwd);
      const session = latestSessionState(created.id) ?? created;
      const root = inheritedRoot ? commonAncestor(inheritedRoot, session.cwd, session.platform) : session.cwd;
      setExplorerRoots(value => ({ ...value, [session.id]: root }));
      setSessions(value => value.some(item => item.id === session.id) ? value.map(item => item.id === session.id ? session : item) : [...value, session]);
      setActiveId(session.id);
      return session.id;
    } catch (value) { reportError(value); return undefined; }
    finally { setCreating(false); }
  }, [reportError]);

  useEffect(() => {
    if (!api) return;
    const unsubscribe = subscribe(event => {
      if (event.type === 'history') setHistory(event.history);
      if (event.type === 'state') {
        setSessions(value => value.map(session => session.id === event.session.id ? event.session : session));
        if (event.session.ready) setExplorerRoots(value => {
          const root = value[event.session.id];
          if (!root || containsPath(root, event.session.cwd, event.session.platform)) return value;
          return { ...value, [event.session.id]: commonAncestor(root, event.session.cwd, event.session.platform) };
        });
      }
      if (event.type === 'exit') setSessions(value => value.map(session => session.id === event.id ? { ...session, alive: false, ready: false } : session));
    });
    api.bootstrap().then(value => {
      setBootstrap(value); setSettings(value.settings); setHistory(value.history);
      // "Open with Mullion Terminal" (or a CLI launch with a path) already has
      // one or more `open-path` events queued for delivery — open those tabs
      // instead of the usual blank one at Home.
      if (!value.openPathCount) return create();
    }).catch(reportError);
    return unsubscribe;
  }, []);
  // Delivers an "Open with Mullion Terminal" request: a folder opens a new
  // tab there; a file opens a new tab in its parent folder and, once that
  // session reports ready, opens the file the same way the tree's
  // double-click does (markdown preview, or `nano` in the active shell).
  useEffect(() => {
    if (!api) return;
    return subscribe(event => {
      if (event.type !== 'open-path') return;
      create(event.path, event.path).then(id => { if (id && event.filePath) pendingOpenFiles.current.set(id, event.filePath); });
    });
  }, [api, create]);
  useEffect(() => {
    if (!pendingOpenFiles.current.size) return;
    for (const [id, filePath] of pendingOpenFiles.current) {
      const session = sessions.find(item => item.id === id);
      if (!session || !session.alive) { pendingOpenFiles.current.delete(id); continue; }
      if (session.ready && activeId === id) { pendingOpenFiles.current.delete(id); openFile(filePath); }
    }
  }, [sessions, activeId]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 9000); return () => clearTimeout(timer); }, [error]);

  async function closeSession(id: string) {
    try {
      await api!.closeSession(id);
      const remaining = latest.current.sessions.filter(session => session.id !== id);
      setSessions(remaining);
      setPreview(value => value?.sessionId === id ? null : value);
      setExplorerRoots(value => { const next = { ...value }; delete next[id]; return next; });
      if (latest.current.activeId === id) setActiveId(remaining.at(-1)?.id ?? '');
    } catch (value) { reportError(value); }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Plain Ctrl+T/B/W belong to the shell and full-screen editors, so app
      // shortcuts use Cmd on macOS and Ctrl+Shift elsewhere.
      const mod = bootstrap?.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey;
      if (event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      // Ctrl+, has no shell meaning, so Settings keeps it on every platform.
      if (key === ',' && (event.metaKey || event.ctrlKey) && !event.shiftKey) { event.preventDefault(); setSettingsOpen(value => !value); return; }
      if (!mod) return;
      if (key === ',') { event.preventDefault(); setSettingsOpen(value => !value); }
      else if (!latest.current.settingsOpen && key === 't') { event.preventDefault(); void create(latest.current.home || undefined, latest.current.home || undefined); }
      else if (!latest.current.settingsOpen && key === 'b') { event.preventDefault(); setSidebar(value => value ? null : 'files'); }
      else if (!latest.current.settingsOpen && key === 'w' && latest.current.activeId) { event.preventDefault(); void closeSession(latest.current.activeId); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [bootstrap?.platform, create]);

  async function navigate(path: string) {
    if (!active?.ready || !active.alive) return false;
    if (path === active.cwd) { handles.current.get(active.id)?.focus(); return true; }
    try { await api!.changeDirectory(active.id, path); handles.current.get(active.id)?.focus(); return true; }
    catch (value) { reportError(value); return false; }
  }
  async function choose() {
    try {
      const path = await api!.chooseDirectory();
      if (!path) return;
      if (active?.ready && active.alive) {
        if (await navigate(path)) setExplorerRoots(value => ({ ...value, [active.id]: path }));
      } else await create(path, path);
    } catch (value) { reportError(value); }
  }
  function fill(command: string) { if (active?.ready && active.alive) handles.current.get(active.id)?.insert(command); }
  // Windows shells rarely have nano, so a double-clicked file there still opens
  // in the OS default app; elsewhere it opens in the active shell with nano.
  function editFile(path: string) {
    if (!active || !api) return;
    if (active.platform === 'win32') { api.openFile(path).catch(reportError); return; }
    // This is the app opening an editor on the user's behalf, not something they typed —
    // it must never be learned as a command the user "works with".
    const ran = active.ready && active.alive && (handles.current.get(active.id)?.run(nanoEditCommand(path, active.cwd), { record: false }) ?? false);
    if (!ran) reportError(new Error('Wait for the current command to finish'));
  }
  // Markdown opens in the rendered preview first; its Edit button falls through to editFile.
  function openFile(path: string) {
    if (!active || !api) return;
    if (isMarkdownPath(path)) setPreview({ path, sessionId: active.id });
    else editFile(path);
  }
  function closePreview() { setPreview(null); handles.current.get(activeId)?.focus(); }
  function copyPath() {
    if (!active) return;
    api!.copyText(active.cwd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(reportError);
  }
  async function updateSettings(value: Settings) {
    const previous = settings;
    const revision = ++settingsRevision.current;
    setSettings(value);
    try {
      const saved = await api!.saveSettings(value);
      if (settingsRevision.current === revision) setSettings(saved);
    } catch (error) {
      if (settingsRevision.current === revision) setSettings(previous);
      reportError(error);
    }
  }
  async function pin(entry: HistoryEntry) { try { setHistory(await api!.pinCommand(entry.command, !entry.pinned)); } catch (value) { reportError(value); } }
  // Removes one learned command (sidebar row, quick bar, and suggestions all read the same
  // `history` state, so they drop it together). Keeps the deleted entry around briefly so
  // the undo toast can restore it with its original count/lastUsed/cwd/pinned.
  async function deleteCommand(command: string) {
    const entry = history.find(item => item.command === command) ?? null;
    try { setHistory(await api!.deleteCommand(command)); } catch (value) { reportError(value); return; }
    if (!entry) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(entry);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  }
  async function undoDelete() {
    if (!undo) return;
    const entry = undo;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
    try { setHistory(await api!.restoreCommand(entry)); } catch (value) { reportError(value); }
  }
  useEffect(() => {
    if (!quickMenu) return;
    const onDown = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.quick-menu')) setQuickMenu(null); };
    const onKeyEsc = (event: KeyboardEvent) => { if (event.key === 'Escape') setQuickMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKeyEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKeyEsc); };
  }, [quickMenu]);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  const visibleHistory = (historySort === 'frequent' ? frequentCommands(history, 1000) : [...history].filter(entry => !isBasicCommand(entry.command)).sort((a, b) => b.lastUsed - a.lastUsed)).filter(entry => entry.command.toLowerCase().includes(historySearch.toLowerCase()));
  const frequent = frequentCommands(history);
  const quickCommands = frequent.map(entry => ({ command: entry.command, pinned: entry.pinned, hint: `${entry.count} ${entry.count === 1 ? 'use' : 'uses'}` }));

  return <div className={`app ${bootstrap?.platform === 'darwin' ? 'mac' : ''}`}>
    <header className="titlebar">
      <div className="brand"><span className="brand-mark"><Terminal size={16} strokeWidth={2.5} /></span><span>Mullion <b>Terminal</b></span></div>
      <div className="titlebar-actions" aria-label="Terminal controls">
        <button title={`Files · ${shortcutLabel(bootstrap?.platform, 'B')}`} aria-label="Toggle files sidebar" aria-pressed={sidebar === 'files'} className={`toolbar-button ${sidebar === 'files' ? 'active' : ''}`} onClick={() => setSidebar(value => value === 'files' ? null : 'files')}><FolderTree size={16} /></button>
        <button title="Most-used commands & history" aria-label="Command history" aria-pressed={sidebar === 'history'} className={`toolbar-button ${sidebar === 'history' ? 'active' : ''}`} onClick={() => setSidebar(value => value === 'history' ? null : 'history')}><History size={16} /></button>
        {active && api && <EditorLauncher key={active.id} session={active} onError={reportError} />}
        <span className="toolbar-divider" />
        {active && <>
          <button className={`current-path ${copied ? 'copied' : ''}`} aria-label="Copy current path" title={active.cwd} onClick={copyPath}><span>{compactPath(active.cwd, home, active.platform)}</span>{copied ? <Check size={12} /> : <Copy size={12} />}</button>
          <button className="toolbar-button open-current-folder" aria-label="Open current folder in file manager" title={bootstrap?.platform === 'darwin' ? 'Open in Finder' : bootstrap?.platform === 'win32' ? 'Open in File Explorer' : 'Open in file manager'} onClick={() => api!.openDirectory(active.cwd).catch(reportError)}><FolderOpen size={16} /></button>
        </>}
        <button className="toolbar-button" aria-label="Open folder" title="Open folder" disabled={!api} onClick={choose}><FolderPlus size={16} /></button>
        <button className="toolbar-button" aria-label="Settings" title={`Settings · ${settingsShortcutLabel(bootstrap?.platform)}`} onClick={() => setSettingsOpen(true)}><SettingsIcon size={16} /></button>
        <span className={`shell-state ${active?.ready ? 'ready' : ''}`} aria-label={active?.alive ? active.ready ? 'Shell ready' : 'Command running' : 'No active shell'} title={active?.alive ? active.ready ? 'Shell ready' : 'Command running' : 'No active shell'}><i /></span>
      </div>
      {bootstrap?.platform !== 'darwin' && api && <div className="window-controls"><button aria-label="Minimize window" onClick={() => api.windowAction('minimize')}><Minus size={13} /></button><button aria-label="Maximize window" onClick={() => api.windowAction('maximize')}><Square size={11} /></button><button aria-label="Close window" onClick={() => api.windowAction('close')}><X size={15} /></button></div>}
    </header>
    <div className="workspace">
      {sidebar && <aside className="sidebar">
        {sidebar === 'files' && active && api ? <DirectoryTree key={active.id} root={explorerRoots[active.id] ?? active.cwd} cwd={active.cwd} platform={active.platform} home={home} showHidden={settings.showHiddenFiles} navigate={navigate} openFile={openFile} choose={choose} onRootChange={path => setExplorerRoots(value => ({ ...value, [active.id]: path }))} onError={reportError} /> : sidebar === 'files' ? <><div className="sidebar-heading">EXPLORER</div><div className="sidebar-empty"><FolderOpen size={28} /><p>Open a tab to browse folders.</p></div></> : <>
          <div className="sidebar-heading"><span>YOUR COMMANDS</span><span className="count-badge">{history.length}</span></div>
          <div className="history-search"><Search size={14} /><input aria-label="Search command history" placeholder="Find a command…" value={historySearch} onChange={event => setHistorySearch(event.target.value)} /></div>
          <div className="history-tabs"><button className={historySort === 'frequent' ? 'selected' : ''} onClick={() => setHistorySort('frequent')}>Most used</button><button className={historySort === 'recent' ? 'selected' : ''} onClick={() => setHistorySort('recent')}>Recent</button></div>
          <div className="history-list">{visibleHistory.map(entry => <div className="history-entry" key={entry.command}><button className="history-command" title={entry.command} disabled={!active?.ready || !active.alive} onClick={() => fill(entry.command)} onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteCommand(entry.command); } }}><code><CommandText value={entry.command} /></code><span>{entry.count} {entry.count === 1 ? 'use' : 'uses'}<span>{new Date(entry.lastUsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></span></button><button className={`pin-button ${entry.pinned ? 'pinned' : ''}`} title={entry.pinned ? 'Unpin command' : 'Pin command'} aria-label={`${entry.pinned ? 'Unpin' : 'Pin'} ${entry.command}`} onClick={() => pin(entry)}><Star size={12} fill={entry.pinned ? 'currentColor' : 'none'} /></button><button className="history-delete" title="Remove from history" aria-label={`Delete ${entry.command}`} onClick={() => deleteCommand(entry.command)}><Trash2 size={12} /></button></div>)}{!visibleHistory.length && <div className="sidebar-empty"><History size={27} /><p>{history.length ? 'No matching commands.' : 'Your commands will appear here.'}</p><span>{history.length ? 'Try a different search.' : 'Saved locally as you use the terminal.'}</span></div>}</div>
        </>}
      </aside>}
      <main className="main-area" aria-label="Terminal workspace">
        <div className="tab-bar">
          <div className="terminal-tabs">{sessions.map((session, index) => <div role="tab" aria-selected={session.id === activeId} tabIndex={0} className={`terminal-tab ${session.id === activeId ? 'active' : ''} ${!session.alive ? 'dead' : ''}`} key={session.id} onClick={() => setActiveId(session.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setActiveId(session.id); }}><i /><span>{session.cwd === home ? '~' : basename(session.cwd)} <em>{index + 1}</em></span><button aria-label={`Close terminal ${index + 1}`} onClick={event => { event.stopPropagation(); void closeSession(session.id); }}><X size={11} /></button></div>)}</div>
          <button className="new-tab" aria-label="New terminal tab" title={`New tab at Home · ${shortcutLabel(bootstrap?.platform, 'T')}`} disabled={!api || !bootstrap || creating} onClick={() => create(home, home)}><Plus size={15} /></button>
          <div className="tab-bar-spacer" />
          {active && <span className="shell-chip">{active.shell.replace(/.*[\\/]/, '').replace(/\.exe$/i, '')}</span>}
        </div>
        <div className={`terminal-body ${active ? 'has-quick-commands' : ''}`}>
          {sessions.map(session => <ShellPane key={session.id} session={session} active={session.id === activeId} settings={settings} history={history} register={register} onHistory={setHistory} onError={reportError} />)}
          {active && <div className="quick-commands" role="toolbar" aria-label={quickCommands.length ? 'Most-used commands' : 'Quick commands'}>
            <History size={13} className="quick-commands-icon" aria-hidden="true" />
            <div className="quick-command-list">{quickCommands.length ? quickCommands.map(entry => <button key={entry.command} className="quick-command" aria-label={`Insert ${entry.command}`} title={`${entry.command} · ${entry.hint}`} disabled={!active.ready || !active.alive} onClick={() => fill(entry.command)} onContextMenu={event => { event.preventDefault(); setQuickMenu({ command: entry.command, x: event.clientX, y: event.clientY }); }}>{entry.pinned && <Star size={10} fill="currentColor" aria-hidden="true" />}<code><CommandText value={entry.command} /></code></button>)
              : <span style={{ color: 'var(--faint)', fontSize: 11 }}>Commands you run will show up here</span>}</div>
          </div>}
          {/* The quick-commands bar sits at the very bottom of the window, so the menu always
              opens upward from the click point rather than risking an offscreen drop-down. */}
          {quickMenu && <div className="quick-menu" role="menu" style={{ left: quickMenu.x, bottom: window.innerHeight - quickMenu.y }}>
            <button role="menuitem" onClick={() => { const entry = history.find(item => item.command === quickMenu.command); if (entry) pin(entry); setQuickMenu(null); }}><Star size={12} />{history.find(item => item.command === quickMenu.command)?.pinned ? 'Unpin' : 'Pin'}</button>
            <button role="menuitem" onClick={() => { deleteCommand(quickMenu.command); setQuickMenu(null); }}><Trash2 size={12} />Remove from history</button>
          </div>}
          {preview && active && preview.sessionId === active.id && <MarkdownPreview key={preview.path} path={preview.path} fragment={preview.fragment} close={closePreview} edit={path => { closePreview(); editFile(path); }} openExternally={path => api?.openFile(path).catch(reportError)} openMarkdown={(path, fragment) => setPreview({ path, fragment, sessionId: active.id })} onError={reportError} />}
          {!sessions.length && <div className="terminal-empty">{api ? <button className="empty-new-tab" aria-label="Open a terminal" title="Open a tab at Home" disabled={creating || !bootstrap} onClick={() => create(home, home)}><Plus size={24} /></button> : <code>npm run dev</code>}</div>}
        </div>
      </main>
    </div>
    {settingsOpen && <SettingsPanel settings={settings} update={updateSettings} close={() => { setSettingsOpen(false); handles.current.get(activeId)?.focus(); }} clearHistory={() => api?.clearHistory().then(setHistory).catch(reportError)} platform={bootstrap?.platform} />}
    {undo && <div className="undo-toast" role="status"><span>Removed <code>{undo.command}</code></span><button onClick={undoDelete}>Undo</button></div>}
    {error && <div className="toast" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
  </div>;
}
