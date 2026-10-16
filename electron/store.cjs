'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { isInjectedCommand } = require('./completions.cjs');
const { defaultAppearance, normalizeAppearance } = require('./appearance.cjs');

const DEFAULT_SETTINGS = Object.freeze({ autoComplete: true, showSuggestions: true, fontSize: 13, theme: 'dark', showHiddenFiles: false, finderQuickAction: true, openWithTarget: 'tab', appearance: Object.freeze(defaultAppearance('dark')) });
const HISTORY_LIMIT = 1000;
const DIRECTORIES_LIMIT = 500;

function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  // Missing appearance means the Mullion preset for the chosen theme: the exact look of
  // releases without appearance settings. A named preset may set the light/dark base itself.
  const { appearance, theme } = normalizeAppearance(value.appearance, value.theme === 'light' ? 'light' : 'dark');
  return {
    autoComplete: typeof value.autoComplete === 'boolean' ? value.autoComplete : DEFAULT_SETTINGS.autoComplete,
    showSuggestions: typeof value.showSuggestions === 'boolean' ? value.showSuggestions : DEFAULT_SETTINGS.showSuggestions,
    fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) ? Math.min(24, Math.max(10, Math.round(value.fontSize))) : DEFAULT_SETTINGS.fontSize,
    theme,
    showHiddenFiles: typeof value.showHiddenFiles === 'boolean' ? value.showHiddenFiles : DEFAULT_SETTINGS.showHiddenFiles,
    finderQuickAction: typeof value.finderQuickAction === 'boolean' ? value.finderQuickAction : DEFAULT_SETTINGS.finderQuickAction,
    // Where a plain "Open with Mullion Terminal" (Finder Open With, a Dock drop, a path argument) opens.
    openWithTarget: value.openWithTarget === 'window' ? 'window' : DEFAULT_SETTINGS.openWithTarget,
    appearance,
  };
}

// Shared by normalizeHistory (bulk, loaded from disk) and restoreCommand (a single
// entry handed back by an undo). Returns null for anything that isn't a well-formed,
// user-typed command.
function normalizeEntry(entry, fallbackLastUsed = 1) {
  if (!entry || typeof entry.command !== 'string' || !entry.command.trim() || entry.command.length > 8192 || /[\0\r\n\x1b]/.test(entry.command)) return null;
  // Older releases could record app-injected navigation (e.g. `builtin cd -- …`).
  // Purge it from already-persisted preferences so it never resurfaces.
  if (isInjectedCommand(entry.command)) return null;
  const command = entry.command.trim();
  return {
    command,
    count: Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number.isSafeInteger(entry.count) ? entry.count : 1)),
    lastUsed: Number.isFinite(entry.lastUsed) && entry.lastUsed > 0 ? entry.lastUsed : fallbackLastUsed,
    cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, 32768) : '',
    pinned: entry.pinned === true,
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const entries = new Map();
  for (const entry of history) {
    const normalized = normalizeEntry(entry);
    if (normalized) entries.set(normalized.command, normalized);
  }
  return capHistory([...entries.values()]);
}

function capHistory(entries) {
  return entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastUsed - a.lastUsed).slice(0, HISTORY_LIMIT);
}

// Case-insensitive comparison on platforms whose filesystem normally is (macOS, Windows);
// case-sensitive everywhere else. Mirrors the convention used throughout src/completion.ts.
function comparableDirectory(value, platform) {
  return platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value;
}

function stripTrailingSeparators(value) {
  return value.replace(/[\\/]+$/, '');
}

function normalizeDirectoryPath(directory, platform) {
  if (typeof directory !== 'string' || !directory) return '';
  const value = platform === 'win32' ? directory.replace(/\//g, '\\') : directory;
  const stripped = stripTrailingSeparators(value);
  return stripped || value;
}

function isRootDirectory(directory, platform) {
  return platform === 'win32' ? /^[A-Za-z]:\\?$/.test(directory) : directory === '/';
}

function isHomeDirectory(directory, home, platform) {
  if (!home) return false;
  return comparableDirectory(directory, platform) === comparableDirectory(stripTrailingSeparators(home) || home, platform);
}

// Scratch/temp directories the shell or app itself navigates through (e.g. this app's own
// per-session integration directory lives under the OS temp root) are never worth "visiting".
const TEMP_DIR_PATTERNS = [/^\/private\/var\/folders(\/|$)/i, /^\/var\/folders(\/|$)/i, /^\/private\/tmp(\/|$)/i, /^\/tmp(\/|$)/i];

function isTempDirectory(directory, platform) {
  if (platform === 'win32') {
    const temp = process.env.TEMP || process.env.TMP;
    if (!temp) return false;
    return comparableDirectory(directory, platform).startsWith(comparableDirectory(stripTrailingSeparators(temp) || temp, platform));
  }
  return TEMP_DIR_PATTERNS.some(pattern => pattern.test(directory));
}

function directoryScore(entry, now) {
  const ageInDays = Math.max(0, now - entry.lastUsed) / 86_400_000;
  const recency = 30 / (1 + ageInDays / 7);
  return Math.log2(1 + entry.count) * 35 + recency;
}

function capDirectories(entries, now = Date.now()) {
  return entries.sort((a, b) => directoryScore(b, now) - directoryScore(a, now)).slice(0, DIRECTORIES_LIMIT);
}

function normalizeDirectoryEntry(entry, fallbackLastUsed = 1) {
  if (!entry || typeof entry.path !== 'string' || !entry.path.trim() || entry.path.length > 32768 || /[\0\r\n\x1b]/.test(entry.path)) return null;
  return {
    path: entry.path.trim(),
    count: Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number.isSafeInteger(entry.count) ? entry.count : 1)),
    lastUsed: Number.isFinite(entry.lastUsed) && entry.lastUsed > 0 ? entry.lastUsed : fallbackLastUsed,
  };
}

function normalizeDirectories(list, platform = process.platform, home = '') {
  if (!Array.isArray(list)) return [];
  const entries = new Map();
  for (const raw of list) {
    const normalized = normalizeDirectoryEntry(raw);
    if (!normalized) continue;
    const directoryPath = normalizeDirectoryPath(normalized.path, platform);
    if (!directoryPath || isRootDirectory(directoryPath, platform) || isHomeDirectory(directoryPath, home, platform) || isTempDirectory(directoryPath, platform)) continue;
    const key = comparableDirectory(directoryPath, platform);
    const existing = entries.get(key);
    if (!existing || existing.lastUsed < normalized.lastUsed) entries.set(key, { ...normalized, path: directoryPath });
  }
  return capDirectories([...entries.values()]);
}

class LocalStore {
  constructor(directory, now = Date.now, { platform = process.platform, home = os.homedir() } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'preferences.json');
    this.now = now;
    this.platform = platform;
    this.home = home;
    this.state = { settings: normalizeSettings(), history: [], directories: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.state = {
          settings: normalizeSettings(value.settings),
          history: normalizeHistory(value.history),
          directories: normalizeDirectories(value.directories, this.platform, this.home),
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return this.snapshot();
  }

  snapshot() {
    return { settings: structuredClone(this.state.settings), history: this.state.history.map(entry => ({ ...entry })), directories: this.state.directories.map(entry => ({ ...entry })) };
  }

  update(transform) {
    const operation = this.queue.then(async () => {
      const next = transform(this.snapshot());
      const temporary = path.join(this.directory, `.preferences-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, this.file);
        this.state = next;
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return this.snapshot();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async saveSettings(settings) {
    return (await this.update(state => ({ ...state, settings: normalizeSettings(settings) }))).settings;
  }

  // `onlyIfExists` is set by the caller for a command that ran but failed on its own terms
  // (a non-zero status that isn't "command not found"/"not executable"): it must never create
  // a brand-new history entry (a command that has never once succeeded isn't "learned"), but a
  // command that has succeeded before still gets its count/lastUsed bumped.
  async record(command, cwd, { onlyIfExists = false } = {}) {
    if (typeof command !== 'string' || command.length > 8192 || /[\0\r\n\x1b]/.test(command)) throw new Error('Invalid command.');
    command = command.trim();
    // App-injected commands (sidebar folder navigation, internal hooks) are never
    // something the user typed, regardless of which caller reported them.
    if (!command || isInjectedCommand(command)) return this.snapshot().history;
    return (await this.update(state => {
      const previous = state.history.find(entry => entry.command === command);
      if (onlyIfExists && !previous) return state;
      const entry = { command, cwd, count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1), lastUsed: this.now(), pinned: previous?.pinned ?? false };
      return { ...state, history: capHistory([entry, ...state.history.filter(item => item.command !== command)]) };
    })).history;
  }

  async pin(command, pinned) {
    return (await this.update(state => ({ ...state, history: capHistory(state.history.map(entry => entry.command === command ? { ...entry, pinned } : entry)) }))).history;
  }

  /** Removes one history entry (exact command match). A no-op if it's already gone. */
  async deleteCommand(command) {
    return (await this.update(state => ({ ...state, history: state.history.filter(entry => entry.command !== command) }))).history;
  }

  /** Re-inserts a previously deleted entry (undo), keeping its original count/lastUsed/cwd/pinned
   * when they're well-formed. Leaves history untouched if the command is already present. */
  async restoreCommand(entry) {
    const normalized = normalizeEntry(entry, this.now());
    if (!normalized) throw new Error('Invalid history entry.');
    return (await this.update(state => {
      if (state.history.some(item => item.command === normalized.command)) return state;
      return { ...state, history: capHistory([normalized, ...state.history]) };
    })).history;
  }

  async clear() {
    return (await this.update(state => ({ ...state, history: [] }))).history;
  }

  /** Remembers an absolute directory the user actually navigated to (a session cwd change),
   * so a full previously visited path can be suggested later, not just its next segment.
   * Silently ignores the home directory, the filesystem root, scratch/temp directories, and
   * anything malformed — none of those are worth remembering. */
  async recordDirectory(directory) {
    if (typeof directory !== 'string' || !directory || directory.length > 32768 || /[\0\r\n\x1b]/.test(directory)) return this.snapshot().directories;
    const normalized = normalizeDirectoryPath(directory, this.platform);
    if (!normalized || isRootDirectory(normalized, this.platform) || isHomeDirectory(normalized, this.home, this.platform) || isTempDirectory(normalized, this.platform)) {
      return this.snapshot().directories;
    }
    return (await this.update(state => {
      const key = comparableDirectory(normalized, this.platform);
      const previous = state.directories.find(entry => comparableDirectory(entry.path, this.platform) === key);
      const entry = { path: normalized, count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1), lastUsed: this.now() };
      return { ...state, directories: capDirectories([entry, ...state.directories.filter(item => comparableDirectory(item.path, this.platform) !== key)], this.now()) };
    })).directories;
  }
}

module.exports = { DEFAULT_SETTINGS, HISTORY_LIMIT, DIRECTORIES_LIMIT, normalizeSettings, normalizeHistory, normalizeDirectories, LocalStore };
