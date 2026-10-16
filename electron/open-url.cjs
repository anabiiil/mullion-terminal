'use strict';

// Parses `mullion-terminal://open?mode=tab|window&path=<absolute path>[&path=…]`
// — what the macOS Finder Quick Actions send (and what Windows/Linux hand a
// later launch as plain argv once the scheme is registered). A web page can
// trigger these URLs too, so they are validated strictly and can only ever
// ask for a tab or a window at an existing file or folder: nothing in a URL
// is executed, typed into a shell, or used for anything but `fs.statSync`.

const path = require('node:path');
const { resolveOpenTarget } = require('./open-paths.cjs');

const PROTOCOL = 'mullion-terminal';
const OPEN_MODES = new Set(['tab', 'window']);
const MAX_URL_LENGTH = 32768;
const MAX_URL_PATHS = 10;

function isOpenUrl(value) {
  return typeof value === 'string' && value.slice(0, PROTOCOL.length + 3).toLowerCase() === `${PROTOCOL}://`;
}

/**
 * Returns `{ mode, targets }` for a well-formed open URL whose paths are all
 * absolute (each must still exist to be kept), or null for anything else: a
 * different scheme or host, credentials, a port, a path or fragment, an
 * unknown or repeated `mode`, an unknown parameter, a relative path, or no
 * existing target at all.
 *
 * @param {unknown} value
 * @returns {{ mode: 'tab' | 'window', targets: { path: string, isDirectory: boolean }[] } | null}
 */
function parseOpenUrl(value) {
  if (!isOpenUrl(value) || value.length > MAX_URL_LENGTH || /[\0\r\n]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== 'open' || url.username || url.password || url.port || url.hash) return null;
  if (url.pathname && url.pathname !== '/') return null;
  const modes = url.searchParams.getAll('mode');
  const paths = url.searchParams.getAll('path');
  if (modes.length !== 1 || !OPEN_MODES.has(modes[0])) return null;
  if (!paths.length || paths.length > MAX_URL_PATHS) return null;
  for (const key of url.searchParams.keys()) if (key !== 'mode' && key !== 'path') return null;
  const targets = [];
  for (const candidate of paths) {
    if (!candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) return null;
    const target = resolveOpenTarget(path.normalize(candidate));
    if (target && !targets.some(existing => existing.path === target.path)) targets.push(target);
  }
  return targets.length ? { mode: modes[0], targets } : null;
}

/**
 * A sliding-window limiter: allows at most `limit` calls per `interval` ms.
 * Keeps a burst of URLs (from a misbehaving page, say) from opening an
 * unbounded number of tabs or windows.
 */
function createRateLimiter({ limit = 8, interval = 10000, now = Date.now } = {}) {
  const times = [];
  return () => {
    const current = now();
    while (times.length && current - times[0] >= interval) times.shift();
    if (times.length >= limit) return false;
    times.push(current);
    return true;
  };
}

module.exports = { PROTOCOL, MAX_URL_PATHS, isOpenUrl, parseOpenUrl, createRateLimiter };
