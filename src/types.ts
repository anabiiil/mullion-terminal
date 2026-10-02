export interface Settings { autoComplete: boolean; showSuggestions: boolean; fontSize: number; theme: 'dark' | 'light'; showHiddenFiles: boolean; finderQuickAction: boolean; }
export interface HistoryEntry { command: string; count: number; lastUsed: number; cwd: string; pinned: boolean; }
export interface SessionInfo { id: string; cwd: string; shell: string; platform: string; ready: boolean; alive: boolean; }
export interface DirectoryEntry { name: string; path: string; isDirectory: boolean; isSymbolicLink: boolean; }
export interface EditorInfo { id: string; name: string; icon?: string; }
export interface ProjectEditors { languages: string[]; editors: EditorInfo[]; }
export interface CompletionCandidate { value: string; label: string; kind: 'command' | 'directory' | 'file' | 'history'; detail?: string; }
export interface Suggestion extends CompletionCandidate { score: number; }
/** A folder, or a file (opened in its parent folder, `filePath` holding the file itself), requested from outside the app — an OS "Open with Mullion Terminal", a Dock drop, or a CLI launch with a path argument. */
export type TerminalEvent = { type: 'data'; id: string; data: string } | { type: 'state'; session: SessionInfo } | { type: 'exit'; id: string; exitCode: number } | { type: 'history'; history: HistoryEntry[] } | { type: 'open-path'; path: string; isDirectory: boolean; filePath?: string };
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
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
}
declare global { interface Window { terminalAPI?: TerminalAPI; } }
