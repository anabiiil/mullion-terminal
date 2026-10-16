export type PresetId = 'mullion-dark' | 'mullion-light' | 'dracula' | 'one-dark' | 'solarized-light';
export interface UiColors { background: string; panel: string; text: string; muted: string; accent: string; border: string; flag: string; }
export interface AnsiColors { black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string; brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string; }
export interface TerminalColors extends AnsiColors { background: string; foreground: string; cursor: string; selection: string; }
/** Each is `#rrggbb`, or `''` for the built-in color (the terminal palette's ANSI color). */
export interface PromptColors { path: string; gitLabel: string; branch: string; ahead: string; behind: string; arrow: string; flag: string; }
/** Font families are comma-separated names (`''` = the built-in stack); `lineHeight` is 1.0–1.8. The terminal font size stays `Settings.fontSize`. */
export interface Fonts { terminalFamily: string; lineHeight: number; uiFamily: string; }
/** Colors are `#rrggbb`. A named preset always carries its own colors; `custom` holds edited ones. */
export interface Appearance { preset: PresetId | 'custom'; ui: UiColors; terminal: TerminalColors; prompt: PromptColors; fonts: Fonts; }
export interface Settings { autoComplete: boolean; showSuggestions: boolean; fontSize: number; theme: 'dark' | 'light'; showHiddenFiles: boolean; finderQuickAction: boolean; openWithTarget: 'tab' | 'window'; appearance: Appearance; }
export interface HistoryEntry { command: string; count: number; lastUsed: number; cwd: string; pinned: boolean; }
// lineReset: the bytes that clear the shell's whole input line before a replacement (see electron/shell.cjs).
export interface SessionInfo { id: string; cwd: string; shell: string; platform: string; ready: boolean; alive: boolean; lineReset?: string; }
export interface DirectoryEntry { name: string; path: string; isDirectory: boolean; isSymbolicLink: boolean; }
export interface EditorInfo { id: string; name: string; icon?: string; }
export interface ProjectEditors { languages: string[]; editors: EditorInfo[]; }
export interface CompletionCandidate { value: string; label: string; kind: 'command' | 'directory' | 'file' | 'history'; detail?: string; }
export interface Suggestion extends CompletionCandidate { score: number; }
/** `branch` is `null` only for a detached HEAD with no resolvable commit (an empty, headless repo). */
export interface GitStatus { branch: string | null; detached: boolean; ahead?: number; behind?: number; changedFiles: number; insertions: number; deletions: number; }
export interface GitBranchEntry { name: string; upstream?: string; lastCommitRelative?: string; }
export interface GitRemoteBranch { name: string; }
/** `current` is `null` for a detached HEAD, in which case no entry in `local` is "checked out". */
export interface GitBranches { current: string | null; local: GitBranchEntry[]; remote: GitRemoteBranch[]; }
/** `open-path` is a folder, or a file (opened in its parent folder, `filePath` holding the file itself), requested from outside the app — an OS "Open with Mullion Terminal", a Finder Quick Action, a Dock drop, or a CLI launch with a path argument. `history` and `settings` carry changes made in another window. */
export type TerminalEvent = { type: 'data'; id: string; data: string } | { type: 'state'; session: SessionInfo } | { type: 'exit'; id: string; exitCode: number } | { type: 'history'; history: HistoryEntry[] } | { type: 'settings'; settings: Settings } | { type: 'open-path'; path: string; isDirectory: boolean; filePath?: string };
export interface Bootstrap { home: string; platform: string; settings: Settings; history: HistoryEntry[]; /** Number of `open-path` events the main process already queued for delivery right after this bootstrap call; when non-zero the renderer should skip opening its usual default tab. */ openPathCount: number; }
export interface TerminalAPI {
  bootstrap(): Promise<Bootstrap>;
  createSession(cwd?: string): Promise<SessionInfo>;
  closeSession(id: string): Promise<void>;
  write(id: string, data: string, submittedCommand?: string, record?: boolean): void;
  writeBinary(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  changeDirectory(id: string, path: string): Promise<void>;
  listDirectory(path: string, showHidden?: boolean): Promise<DirectoryEntry[]>;
  completions(id: string, line: string): Promise<CompletionCandidate[]>;
  foregroundProcess(id: string): Promise<string>;
  /** `null` when the session's cwd is not inside a git repository (or git is unavailable). */
  gitStatus(id: string): Promise<GitStatus | null>;
  gitBranches(id: string, refresh?: boolean): Promise<GitBranches | null>;
  recordCommand(command: string, cwd: string): Promise<HistoryEntry[]>;
  pinCommand(command: string, pinned: boolean): Promise<HistoryEntry[]>;
  deleteCommand(command: string): Promise<HistoryEntry[]>;
  /** Re-inserts a deleted entry (undo). A no-op if the command is already present. */
  restoreCommand(entry: HistoryEntry): Promise<HistoryEntry[]>;
  clearHistory(): Promise<HistoryEntry[]>;
  saveSettings(settings: Settings): Promise<Settings>;
  chooseDirectory(): Promise<string | null>;
  openFile(path: string): Promise<void>;
  openDirectory(path: string): Promise<void>;
  /** UTF-8 contents of a regular file up to 2 MiB. */
  readTextFile(path: string): Promise<string>;
  /** A local image (by extension, up to 8 MiB) as a data: URL. */
  readImage(path: string): Promise<string>;
  /** Opens an http:, https: or mailto: URL in the system's default app. */
  openExternalLink(url: string): Promise<void>;
  projectEditors(id: string, refresh?: boolean): Promise<ProjectEditors>;
  openEditor(id: string, editorId: string): Promise<void>;
  copyText(text: string): Promise<void>;
  readText(): Promise<string>;
  onEvent(callback: (event: TerminalEvent) => void): () => void;
  /** Opens another window with its own tabs (the first one at Home). */
  newWindow(): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
}
declare global { interface Window { terminalAPI?: TerminalAPI; } }
