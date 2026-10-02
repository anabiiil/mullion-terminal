'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isInjectedCommand } = require('./completions.cjs');

const DEFAULT_SETTINGS = Object.freeze({ autoComplete: true, showSuggestions: true, fontSize: 13, theme: 'dark', showHiddenFiles: false, finderQuickAction: true });
const HISTORY_LIMIT = 1000;

function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  return {
    autoComplete: typeof value.autoComplete === 'boolean' ? value.autoComplete : DEFAULT_SETTINGS.autoComplete,
    showSuggestions: typeof value.showSuggestions === 'boolean' ? value.showSuggestions : DEFAULT_SETTINGS.showSuggestions,
    fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) ? Math.min(24, Math.max(10, Math.round(value.fontSize))) : DEFAULT_SETTINGS.fontSize,
    theme: value.theme === 'light' ? 'light' : 'dark',
    showHiddenFiles: typeof value.showHiddenFiles === 'boolean' ? value.showHiddenFiles : DEFAULT_SETTINGS.showHiddenFiles,
    finderQuickAction: typeof value.finderQuickAction === 'boolean' ? value.finderQuickAction : DEFAULT_SETTINGS.finderQuickAction,
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

class LocalStore {
  constructor(directory, now = Date.now) {
    this.directory = directory;
    this.file = path.join(directory, 'preferences.json');
    this.now = now;
    this.state = { settings: { ...DEFAULT_SETTINGS }, history: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) this.state = { settings: normalizeSettings(value.settings), history: normalizeHistory(value.history) };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return this.snapshot();
  }

  snapshot() {
    return { settings: { ...this.state.settings }, history: this.state.history.map(entry => ({ ...entry })) };
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

  async record(command, cwd) {
    if (typeof command !== 'string' || command.length > 8192 || /[\0\r\n\x1b]/.test(command)) throw new Error('Invalid command.');
    command = command.trim();
    // App-injected commands (sidebar folder navigation, internal hooks) are never
    // something the user typed, regardless of which caller reported them.
    if (!command || isInjectedCommand(command)) return this.snapshot().history;
    return (await this.update(state => {
      const previous = state.history.find(entry => entry.command === command);
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
}

module.exports = { DEFAULT_SETTINGS, HISTORY_LIMIT, normalizeSettings, normalizeHistory, LocalStore };
