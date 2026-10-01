'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({ autoComplete: true, showSuggestions: true, fontSize: 13, theme: 'dark', showHiddenFiles: false });
const HISTORY_LIMIT = 1000;

function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  return {
    autoComplete: typeof value.autoComplete === 'boolean' ? value.autoComplete : DEFAULT_SETTINGS.autoComplete,
    showSuggestions: typeof value.showSuggestions === 'boolean' ? value.showSuggestions : DEFAULT_SETTINGS.showSuggestions,
    fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) ? Math.min(24, Math.max(10, Math.round(value.fontSize))) : DEFAULT_SETTINGS.fontSize,
    theme: value.theme === 'light' ? 'light' : 'dark',
    showHiddenFiles: typeof value.showHiddenFiles === 'boolean' ? value.showHiddenFiles : DEFAULT_SETTINGS.showHiddenFiles,
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const entries = new Map();
  for (const entry of history) {
    if (!entry || typeof entry.command !== 'string' || !entry.command.trim() || entry.command.length > 8192 || /[\0\r\n\x1b]/.test(entry.command)) continue;
    const command = entry.command.trim();
    entries.set(command, {
      command,
      count: Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number.isSafeInteger(entry.count) ? entry.count : 1)),
      lastUsed: Number.isFinite(entry.lastUsed) && entry.lastUsed > 0 ? entry.lastUsed : 1,
      cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, 32768) : '',
      pinned: entry.pinned === true,
    });
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
    if (!command) return this.snapshot().history;
    return (await this.update(state => {
      const previous = state.history.find(entry => entry.command === command);
      const entry = { command, cwd, count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1), lastUsed: this.now(), pinned: previous?.pinned ?? false };
      return { ...state, history: capHistory([entry, ...state.history.filter(item => item.command !== command)]) };
    })).history;
  }

  async pin(command, pinned) {
    return (await this.update(state => ({ ...state, history: capHistory(state.history.map(entry => entry.command === command ? { ...entry, pinned } : entry)) }))).history;
  }

  async clear() {
    return (await this.update(state => ({ ...state, history: [] }))).history;
  }
}

module.exports = { DEFAULT_SETTINGS, HISTORY_LIMIT, normalizeSettings, normalizeHistory, LocalStore };
