import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Folder, File, History, Terminal as TerminalIcon } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import type { HistoryEntry, SessionInfo, Settings, Suggestion } from './types';
import { inlineCompletion, rankSuggestions } from './completion';
import { ShellInputTracker } from './input-tracker';
import { attachOutput } from './events';
import { suggestionPosition } from './suggestion-position';
import { shortcutAction } from './keys';
import { editorKind, ESC_DELAY_MS, looksLikeGitEditorBuffer, NANO_KEYS, VIM_KEYS, type EditorKind } from './editor-process';
import { accumulateWheelLines, arrowKeysForLines } from './wheel-scroll';
import EditorBar from './EditorBar';
import CommandText from './CommandText';

export interface ShellHandle {
  focus(): void; insert(command: string): void;
  // `options.record: false` marks a command the app is running on the user's behalf (e.g. a
  // tree double-click opening nano) so it's never learned as something the user "works with".
  run(command: string, options?: { record?: boolean }): boolean;
  clear(): void;
}
interface SuggestionPopup { items: Suggestion[]; selected: number; line: string; trackerRevision: number }
interface Props {
  session: SessionInfo; active: boolean; settings: Settings; history: HistoryEntry[];
  register(id: string, handle: ShellHandle | null): void;
  onHistory(history: HistoryEntry[]): void;
  onError(error: unknown): void;
}
const themes = {
  dark: { background: '#161c28', foreground: '#e8ebf2', cursor: '#ff7a5c', cursorAccent: '#161c28', selectionBackground: '#ff7a5c40', black: '#232a38', red: '#f26d6d', green: '#3ecf7a', yellow: '#e5b85c', blue: '#6ea8fe', magenta: '#d68cf0', cyan: '#4fd1c5', white: '#c9cfdb', brightBlack: '#5e6678', brightRed: '#ff8e74', brightGreen: '#6be39b', brightYellow: '#f2cf85', brightBlue: '#93bfff', brightMagenta: '#e5adf7', brightCyan: '#7ee3da', brightWhite: '#ffffff' },
  light: { background: '#ffffff', foreground: '#1a1f2b', cursor: '#ff6b4a', cursorAccent: '#ffffff', selectionBackground: '#ff6b4a30', black: '#1a1f2b', red: '#d93a3a', green: '#1a9553', yellow: '#a8680f', blue: '#3563d6', magenta: '#a347bf', cyan: '#12808f', white: '#8c94a6', brightBlack: '#6b7385' },
};
export default function ShellPane(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const previousCwd = useRef(props.session.cwd);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const popupElement = useRef<HTMLDivElement>(null);
  const tracker = useRef(new ShellInputTracker());
  const popup = useRef<SuggestionPopup | null>(null);
  const [suggestions, setSuggestions] = useState<typeof popup.current>(null);
  const [position, setPosition] = useState({ left: 16, top: 16, maxHeight: 280, placement: 'below' as 'below' | 'above' });
  const suppressed = useRef(false);
  const revision = useRef(0);
  const chooseSuggestion = useRef<(expected: SuggestionPopup, index: number) => void>(() => {});
  const requestSuggestions = useRef<() => void>(() => {});
  const [foregroundEditor, setForegroundEditor] = useState<EditorKind>(null);
  const foregroundEditorRef = useRef<EditorKind>(null);
  const checkForeground = useRef<() => void>(() => {});

  // nano/pico take a single, complete key sequence.
  function editorKeys(data: string) {
    if (!foregroundEditorRef.current || !props.session.alive) return;
    window.terminalAPI!.write(props.session.id, data);
    termRef.current?.focus();
  }
  // vim needs Escape written separately (see ESC_DELAY_MS) before a
  // command-line command, so it works from Insert mode too.
  function vimCommand(command: string) {
    if (foregroundEditorRef.current !== 'vim' || !props.session.alive) return;
    const api = window.terminalAPI!;
    const id = props.session.id;
    api.write(id, '\x1b');
    setTimeout(() => {
      if (foregroundEditorRef.current === 'vim' && props.session.alive) api.write(id, command);
    }, ESC_DELAY_MS);
    termRef.current?.focus();
  }
  function hide() { if (popup.current) { popup.current = null; setSuggestions(null); } }

  useLayoutEffect(() => {
    const term = termRef.current;
    const host = container.current;
    const panel = popupElement.current;
    const pane = host?.parentElement;
    const screen = host?.querySelector('.xterm-screen');
    const items = panel?.querySelector('.suggestion-items');
    if (!suggestions || !term || !pane || !screen || !panel) return;
    const paneRect = pane.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const buffer = term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const rowHeight = screenRect.height / term.rows;
    const cursorTop = screenRect.top - paneRect.top + row * rowHeight;
    const cursorLeft = screenRect.left - paneRect.left + buffer.cursorX * screenRect.width / term.cols;
    if (!props.settings.autoComplete) {
      if (cursorTop < 0 || cursorTop + rowHeight > paneRect.height) { hide(); return; }
      setPosition(previous => previous.left === cursorLeft && previous.top === cursorTop && previous.maxHeight === rowHeight
        ? previous : { left: cursorLeft, top: cursorTop, maxHeight: rowHeight, placement: 'below' });
      return;
    }
    if (!items) return;
    const hintHeight = panel.querySelector('.suggestion-hint')?.getBoundingClientRect().height ?? 0;
    const chromeHeight = Math.max(panelRect.height - items.getBoundingClientRect().height, hintHeight + 10);
    const next = suggestionPosition({
      width: paneRect.width, height: paneRect.height,
      cursorLeft,
      cursorTop, cursorBottom: cursorTop + rowHeight,
      popupWidth: panelRect.width,
      popupHeight: Math.min(227, items.scrollHeight) + chromeHeight,
    });
    if (!next) { hide(); return; }
    setPosition(previous => previous.left === next.left && previous.top === next.top
      && previous.maxHeight === next.maxHeight && previous.placement === next.placement ? previous : next);
    panel.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [suggestions, props.settings.fontSize, props.settings.autoComplete, props.active]);

  useEffect(() => {
    const element = container.current!;
    const api = window.terminalAPI!;
    const id = props.session.id;
    const term = new Terminal({
      fontFamily: '"SF Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: current.current.settings.fontSize, lineHeight: 1.22,
      cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2,
      scrollback: 10000, theme: themes[current.current.settings.theme],
      // Option+drag still selects text while nano/vim capture the mouse.
      macOptionIsMeta: true, macOptionClickForcesSelection: true, drawBoldTextInBrightColors: false,
      smoothScrollDuration: 100, allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    termRef.current = term;
    fitRef.current = fit;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    let wheelAccumulated = 0;

    async function suggest() {
      const p = current.current;
      if (disposed || !p.active || !p.session.ready || !p.session.alive || !p.settings.showSuggestions || suppressed.current || term.buffer.active.type === 'alternate') return hide();
      const line = tracker.current.readLine(term);
      if (!line?.trim() || !tracker.current.isAtLineEnd(term)) return hide();
      const request = ++revision.current;
      const inputRevision = tracker.current.revision;
      try {
        const candidates = await api.completions(id, line);
        const latest = current.current;
        if (disposed || request !== revision.current || tracker.current.readLine(term) !== line
          || inputRevision !== tracker.current.revision || !latest.active || !latest.session.ready
          || !latest.session.alive || !latest.settings.showSuggestions || suppressed.current
          || latest.settings.autoComplete !== p.settings.autoComplete
          || !tracker.current.isAtLineEnd(term)) return;
        const items = rankSuggestions(line, current.current.history, candidates, current.current.session.cwd, 8, current.current.session.platform, current.current.settings.autoComplete);
        if (!items.length) return hide();
        const value = { items, selected: 0, line, trackerRevision: inputRevision };
        popup.current = value;
        setSuggestions(value);
      } catch { if (!disposed && request === revision.current) hide(); }
    }

    function schedule() { clearTimeout(timer); timer = setTimeout(suggest, 65); }
    function send(data: string, acceptedCommand?: string, record?: boolean) {
      // Capture before beforeInput resets the line on Enter. The accepted
      // replacement is already verified against the popup's source line, but
      // its final echo may still be pending when autocomplete submits it.
      const submittedCommand = current.current.session.ready && data === '\r'
        ? acceptedCommand ?? tracker.current.readLine(term) ?? undefined : undefined;
      revision.current++;
      if (current.current.session.ready) tracker.current.beforeInput(data, term);
      else tracker.current.reset();
      api.write(id, data, submittedCommand, record);
    }
    function validPopup(value: SuggestionPopup): boolean {
      const p = current.current;
      return p.active && p.session.ready && p.session.alive && p.settings.showSuggestions
        && !suppressed.current && tracker.current.readLine(term) === value.line
        && tracker.current.revision === value.trackerRevision && tracker.current.isAtLineEnd(term);
    }
    function accept(run = false, selected?: number) {
      const value = popup.current;
      if (!value || !validPopup(value)) return false;
      const line = value.line;
      const command = value.items[selected ?? (current.current.settings.autoComplete ? value.selected : 0)]?.value;
      if (!command || command === line) return false;
      hide();
      suppressed.current = true;
      if (command.startsWith(line)) send(command.slice(line.length));
      else {
        tracker.current.beforeReplacement(command, term);
        revision.current++;
        api.write(id, '\x05\x15' + command);
      }
      if (run) send('\r', command);
      term.focus();
      return true;
    }
    chooseSuggestion.current = (expected, index) => {
      // A mouse event can outlive the rendered list it came from.
      if (expected !== popup.current || !accept(false, index)) hide();
    };
    requestSuggestions.current = schedule;

    function paste() {
      api.readText().then(text => { if (text && !disposed) term.paste(text); }).catch(current.current.onError);
    }
    // Git launches the editor as a plain child, not its own process group,
    // so the foreground name stays "git" the whole time vim is open — see
    // the comment above looksLikeGitEditorBuffer for why we fall back to
    // reading the screen itself in that case.
    function visibleLines(): string[] {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < term.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
      return lines;
    }
    checkForeground.current = () => {
      const p = current.current;
      if (disposed || !p.session.alive || p.session.ready) { foregroundEditorRef.current = null; setForegroundEditor(null); return; }
      api.foregroundProcess(id).then(name => {
        const latest = current.current;
        if (disposed || !latest.session.alive || latest.session.ready) return;
        const value = editorKind(name) ?? (term.buffer.active.type === 'alternate' && looksLikeGitEditorBuffer(visibleLines()) ? 'vim' : null);
        foregroundEditorRef.current = value; setForegroundEditor(value);
      }).catch(() => {});
    };

    // Cmd/Ctrl+S inside vim: Escape (if still in Insert mode) then :w.
    function sendVimSave() {
      api.write(id, '\x1b');
      setTimeout(() => {
        if (!disposed && foregroundEditorRef.current === 'vim' && current.current.session.alive) api.write(id, VIM_KEYS.save);
      }, ESC_DELAY_MS);
    }

    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if (event.defaultPrevented) return false;
      const action = event.isComposing ? null : shortcutAction(event, {
        hasSelection: term.hasSelection(), alternateScreen: term.buffer.active.type === 'alternate', editor: foregroundEditorRef.current,
      });
      if (action) {
        event.preventDefault();
        if (action === 'copy') api.copyText(term.getSelection()).catch(current.current.onError);
        else if (action === 'paste') paste();
        else if (action === 'clear') term.clear();
        else if (action === 'save') { if (foregroundEditorRef.current === 'vim') sendVimSave(); else api.write(id, NANO_KEYS.save); }
        return false;
      }
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return !event.metaKey;
      // At the shell prompt Escape dismisses hints even before a popup arrives.
      // Sending a bare ESC would leave readline waiting for a Meta-key sequence.
      if (event.key === 'Escape' && !event.shiftKey && current.current.session.ready
        && term.buffer.active.type === 'normal') {
        suppressed.current = true; revision.current++; hide();
        event.preventDefault(); return false;
      }
      const value = popup.current;
      if (value && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'ArrowRight', 'Enter'].includes(event.key)) {
        if (!validPopup(value)) { hide(); return true; }
        if (!current.current.settings.autoComplete && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) return true;
        if (event.key === 'Enter' && !current.current.settings.autoComplete) { hide(); return true; }
        if (event.shiftKey || (event.key === 'ArrowRight' && !tracker.current.isAtLineEnd(term))) return true;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const next = { ...value, selected: (value.selected + (event.key === 'ArrowDown' ? 1 : -1) + value.items.length) % value.items.length };
          popup.current = next; setSuggestions(next);
        } else if (event.key === 'Escape') { suppressed.current = true; hide(); }
        else if (!accept(event.key === 'Enter')) { hide(); return true; }
        event.preventDefault(); return false;
      }
      return true;
    });

    // nano/pico always turn on xterm mouse tracking (see electron/shell.cjs's
    // editorWrappers), so by default a wheel notch is reported as a mouse
    // button 4/5 press — which UW pico (macOS's nano) ignores outright. Vim
    // with no mouse mode of its own (the common case; we don't force one)
    // has no tracking either, so a wheel event there currently just does
    // nothing. In both cases translate the wheel into arrow-key presses,
    // which every full-screen editor already knows how to handle, instead of
    // letting xterm.js report (or silently drop) the raw event. A vim that
    // *has* enabled its own mouse support (the user's vimrc sets `mouse=a`)
    // is left alone so its native mouse scrolling keeps working.
    term.attachCustomWheelEventHandler(event => {
      const editor = foregroundEditorRef.current;
      const alternateScreen = term.buffer.active.type === 'alternate';
      const intercept = current.current.session.alive && alternateScreen
        && (editor === 'nano' || (editor === 'vim' && term.modes.mouseTrackingMode === 'none'));
      if (!intercept) { wheelAccumulated = 0; return true; }
      const screenHeight = element.querySelector('.xterm-screen')?.getBoundingClientRect().height;
      const cellHeight = screenHeight ? screenHeight / term.rows : 17;
      const { lines, accumulated } = accumulateWheelLines(wheelAccumulated, { deltaY: event.deltaY, deltaMode: event.deltaMode, cellHeight });
      wheelAccumulated = accumulated;
      if (lines !== 0) api.write(id, arrowKeysForLines(lines, term.modes.applicationCursorKeysMode));
      return false;
    });

    const input = term.onData(data => {
      const p = current.current;
      if (!p.session.alive) return;
      const plain = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
      if (/[\r\n]/.test(plain) || data === '\x1b') suppressed.current = true;
      else if (/^[^\x00-\x1f\x7f-\x9f]+$/.test(plain) || data === '\x7f' || data === '\b') suppressed.current = false;
      hide();
      send(data);
      if (p.session.ready) schedule();
    });
    // Mouse reports in the default X10 encoding (nano/pico -m) arrive here.
    const binary = term.onBinary(data => { if (current.current.session.alive) api.writeBinary(id, data); });
    const parsed = term.onWriteParsed(() => { if (current.current.active) schedule(); });
    const resized = term.onResize(({ cols, rows }) => {
      api.resize(id, cols, rows); revision.current++; hide(); schedule();
    });
    const alternate = term.buffer.onBufferChange(() => { revision.current++; tracker.current.reset(); hide(); wheelAccumulated = 0; checkForeground.current(); });
    const scrolled = term.onScroll(() => { revision.current++; hide(); schedule(); });
    const detach = attachOutput(id, data => term.write(data));
    const observer = new ResizeObserver(() => { if (current.current.active && element.clientWidth) fit.fit(); });
    observer.observe(element);
    current.current.register(id, {
      focus: () => term.focus(),
      clear: () => term.clear(),
      insert: command => {
        if (!current.current.session.ready || !current.current.session.alive
          || !current.current.active || /[\x00-\x1f\x7f-\x9f]/.test(command)) return;
        hide(); suppressed.current = true;
        tracker.current.beforeReplacement(command, term);
        revision.current++;
        api.write(id, '\x05\x15' + command); term.focus();
      },
      // Replaces the current input line and submits it, like accepting a
      // suggestion with Enter, so history and the input tracker stay consistent.
      run: (command, options) => {
        if (!current.current.session.ready || !current.current.session.alive
          || !current.current.active || /[\x00-\x1f\x7f-\x9f]/.test(command)) return false;
        hide(); suppressed.current = true;
        tracker.current.beforeReplacement(command, term);
        revision.current++;
        api.write(id, '\x05\x15' + command);
        send('\r', command, options?.record);
        term.focus();
        return true;
      },
    });
    requestAnimationFrame(() => { if (!disposed && current.current.active) { fit.fit(); term.focus(); } });
    return () => {
      disposed = true; clearTimeout(timer); revision.current++;
      chooseSuggestion.current = () => {}; requestSuggestions.current = () => {}; checkForeground.current = () => {};
      detach(); observer.disconnect(); input.dispose(); binary.dispose(); parsed.dispose(); resized.dispose(); alternate.dispose(); scrolled.dispose();
      current.current.register(id, null); term.dispose(); termRef.current = null;
    };
  }, [props.session.id]);

  useEffect(() => {
    const term = termRef.current;
    if (term) { term.options.theme = themes[props.settings.theme]; term.options.fontSize = props.settings.fontSize; }
    if (props.active) requestAnimationFrame(() => { fitRef.current?.fit(); term?.focus(); });
  }, [props.active, props.settings.theme, props.settings.fontSize]);
  useEffect(() => {
    if (!props.session.ready || !props.session.alive) tracker.current.reset();
    if (!props.session.ready || !props.session.alive || !props.settings.showSuggestions || !props.active) {
      revision.current++; hide();
    } else requestSuggestions.current();
  }, [props.session.ready, props.session.alive, props.active, props.settings.showSuggestions]);
  useEffect(() => {
    // Only a running command can be an editor; poll cheaply while one runs.
    checkForeground.current();
    if (props.session.ready || !props.session.alive || !props.active) return;
    const poll = setInterval(() => checkForeground.current(), 700);
    return () => clearInterval(poll);
  }, [props.session.ready, props.session.alive, props.active]);
  useEffect(() => {
    if (previousCwd.current !== props.session.cwd) {
      previousCwd.current = props.session.cwd;
      tracker.current.reanchor(); revision.current++; hide();
      requestSuggestions.current();
    }
  }, [props.session.cwd]);
  useEffect(() => {
    revision.current++; hide();
    requestSuggestions.current();
  }, [props.settings.autoComplete]);

  return <div className={`shell-pane ${props.active ? 'active' : ''}`}>
    <div className="xterm-host" ref={container} />
    {suggestions && !props.settings.autoComplete && <div ref={popupElement} className="inline-suggestion" aria-hidden="true" data-value={suggestions.items[0].value} style={{ left: position.left, top: position.top, fontSize: props.settings.fontSize, fontFamily: termRef.current?.options.fontFamily, lineHeight: `${position.maxHeight}px`, height: position.maxHeight, maxWidth: `calc(100% - ${position.left + 8}px)` }}>{inlineCompletion(suggestions.line, suggestions.items[0], props.session.platform)}</div>}
    {suggestions && props.settings.autoComplete && <div ref={popupElement} className="suggestions" style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }} data-placement={position.placement} role="listbox" aria-label="Command suggestions">
      <div className="suggestion-items">{suggestions.items.map((item, index) => {
        const Icon = item.kind === 'history' ? History : item.kind === 'directory' ? Folder : item.kind === 'file' ? File : TerminalIcon;
        return <button key={item.value} role="option" aria-selected={index === suggestions.selected} className={index === suggestions.selected ? 'selected' : ''} onMouseDown={event => {
          event.preventDefault();
          // Clicking fills the line; Enter remains the explicit execution step.
          chooseSuggestion.current(suggestions, index);
        }}><Icon size={14} /><span className="suggestion-label">{item.kind === 'command' || item.kind === 'history' ? <CommandText value={item.label} /> : item.label}</span><span className="suggestion-detail">{item.detail ?? item.kind}</span></button>;
      })}</div>
      <div className="suggestion-hint"><span><kbd>Tab</kbd> accept</span><span><kbd>↑</kbd><kbd>↓</kbd> choose</span>{props.settings.autoComplete && <span><kbd>↵</kbd> accept & run</span>}<span><kbd>Esc</kbd> dismiss</span></div>
    </div>}
    {foregroundEditor && props.active && props.session.alive && <EditorBar kind={foregroundEditor} platform={props.session.platform}
      // Float just above nano's two shortcut rows, or vim's one command line.
      bottom={Math.round(props.settings.fontSize * 1.22 * (foregroundEditor === 'vim' ? 1 : 2)) + 18}
      onSave={() => editorKeys(NANO_KEYS.save)}
      onSaveAndExit={() => foregroundEditor === 'vim' ? vimCommand(VIM_KEYS.saveAndExit) : editorKeys(NANO_KEYS.saveAndExit)}
      onExit={() => foregroundEditor === 'vim' ? vimCommand(VIM_KEYS.exit) : editorKeys(NANO_KEYS.exit)} />}
    {!props.session.alive && <div className="session-ended">Session ended. Open a new tab to continue.</div>}
  </div>;
}
