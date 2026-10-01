export interface Settings { autoComplete: boolean; showSuggestions: boolean; fontSize: number; theme: 'dark' | 'light'; showHiddenFiles: boolean; }
export interface HistoryEntry { command: string; count: number; lastUsed: number; cwd: string; pinned: boolean; }
export interface SessionInfo { id: string; cwd: string; shell: string; platform: string; ready: boolean; alive: boolean; }
export interface DirectoryEntry { name: string; path: string; isDirectory: boolean; isSymbolicLink: boolean; }
export interface EditorInfo { id: string; name: string; icon?: string; }
export interface ProjectEditors { languages: string[]; editors: EditorInfo[]; }
export interface CompletionCandidate { value: string; label: string; kind: 'command' | 'directory' | 'file' | 'history'; detail?: string; }
export interface Suggestion extends CompletionCandidate { score: number; }
export type TerminalEvent = { type: 'data'; id: string; data: string } | { type: 'state'; session: SessionInfo } | { type: 'exit'; id: string; exitCode: number } | { type: 'history'; history: HistoryEntry[] };
export interface Bootstrap { home: string; platform: string; settings: Settings; history: HistoryEntry[]; }
export interface TerminalAPI {
  bootstrap(): Promise<Bootstrap>;
  createSession(cwd?: string): Promise<SessionInfo>;
  closeSession(id: string): Promise<void>;
  write(id: string, data: string, submittedCommand?: string): void;
  resize(id: string, cols: number, rows: number): void;
  changeDirectory(id: string, path: string): Promise<void>;
  listDirectory(path: string, showHidden?: boolean): Promise<DirectoryEntry[]>;
  completions(id: string, line: string): Promise<CompletionCandidate[]>;
  recordCommand(command: string, cwd: string): Promise<HistoryEntry[]>;
  pinCommand(command: string, pinned: boolean): Promise<HistoryEntry[]>;
  clearHistory(): Promise<HistoryEntry[]>;
  saveSettings(settings: Settings): Promise<Settings>;
  chooseDirectory(): Promise<string | null>;
  openFile(path: string): Promise<void>;
  openDirectory(path: string): Promise<void>;
  projectEditors(id: string, refresh?: boolean): Promise<ProjectEditors>;
  openEditor(id: string, editorId: string): Promise<void>;
  copyText(text: string): Promise<void>;
  readText(): Promise<string>;
  onEvent(callback: (event: TerminalEvent) => void): () => void;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
}
declare global { interface Window { terminalAPI?: TerminalAPI; } }
