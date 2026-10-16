'use strict';

// Turns "open this path" requests (a launch argv, or a single macOS
// 'open-file' path) into absolute, existing file/folder targets the app can
// safely act on. Nothing here ever executes or reads the target's contents —
// only `fs.statSync` to tell a file from a folder and confirm it exists.

const fs = require('node:fs');
const path = require('node:path');

function isFlag(value) {
  return typeof value === 'string' && value.startsWith('-');
}

// `mullion-terminal://…` links reach a Windows/Linux launch as argv too; they
// are parsed (strictly) by open-url.cjs, never treated as relative paths.
function isUrlArgument(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

const OPEN_MODE_SWITCH = /^--open-mode=(tab|window)$/;

/**
 * Resolves a single candidate to an absolute, existing file or directory, or
 * returns null when it isn't one (a flag, a relative path that resolves
 * nowhere, something that no longer exists, or a non-regular file). Relative
 * paths are resolved against `cwd` — the directory the request came from —
 * never the directory of this module or the main process's own cwd.
 *
 * @param {unknown} value
 * @param {string} [cwd]
 * @returns {{ path: string, isDirectory: boolean } | null}
 */
function resolveOpenTarget(value, cwd = process.cwd()) {
  if (typeof value !== 'string' || !value || isFlag(value) || isUrlArgument(value)) return null;
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  let stats;
  try { stats = fs.statSync(absolute); } catch { return null; }
  if (stats.isDirectory()) return { path: absolute, isDirectory: true };
  if (stats.isFile()) return { path: absolute, isDirectory: false };
  return null;
}

/**
 * Extracts absolute, existing file/folder targets to open from a process
 * argv array — either the app's own `process.argv` at startup, or the argv
 * Electron hands the 'second-instance' event for a later launch. Electron
 * and Chromium's own switches (`--inspect`, `--user-data-dir=...`), the
 * app's `--cwd=...` switch, and (when running unpackaged, e.g. `electron .`)
 * the project directory argv carries as its own entry point are all skipped;
 * a path that doesn't resolve to an existing file or folder is ignored
 * rather than failing the whole launch.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, isPackaged?: boolean, limit?: number }} [options]
 * @returns {{ path: string, isDirectory: boolean }[]}
 */
function pathsFromArgv(argv, options = {}) {
  if (!Array.isArray(argv)) return [];
  const { cwd = process.cwd(), isPackaged = true, limit = 10 } = options;
  // argv[0] is always the Electron binary. Running from source adds the
  // project directory as its own argv[1] (e.g. `electron .`), which is never
  // a path the user asked to open, so an unpackaged run skips one more slot.
  const start = isPackaged ? 1 : 2;
  const results = [];
  for (let index = start; index < argv.length && results.length < limit; index += 1) {
    const resolved = resolveOpenTarget(argv[index], cwd);
    if (resolved) results.push(resolved);
  }
  return results;
}

/**
 * The `--open-mode=tab|window` switch the Windows Explorer verbs (and a CLI
 * user) pass to choose where argv paths open; null when absent or invalid,
 * so the "Open with Mullion Terminal opens in" setting decides. The last
 * valid occurrence wins.
 *
 * @param {string[]} argv
 * @returns {'tab' | 'window' | null}
 */
function openModeFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  let mode = null;
  for (const value of argv) {
    const match = typeof value === 'string' ? OPEN_MODE_SWITCH.exec(value) : null;
    if (match) mode = match[1];
  }
  return mode;
}

/**
 * `mullion-terminal://` URL arguments, in order, for open-url.cjs to validate.
 *
 * @param {string[]} argv
 * @param {{ isPackaged?: boolean, limit?: number }} [options]
 * @returns {string[]}
 */
function urlsFromArgv(argv, options = {}) {
  if (!Array.isArray(argv)) return [];
  const { isPackaged = true, limit = 10 } = options;
  return argv.slice(isPackaged ? 1 : 2).filter(value => typeof value === 'string' && /^mullion-terminal:\/\//i.test(value)).slice(0, limit);
}

module.exports = { pathsFromArgv, resolveOpenTarget, openModeFromArgv, urlsFromArgv };
