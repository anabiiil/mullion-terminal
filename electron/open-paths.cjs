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
  if (typeof value !== 'string' || !value || isFlag(value)) return null;
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

module.exports = { pathsFromArgv, resolveOpenTarget };
