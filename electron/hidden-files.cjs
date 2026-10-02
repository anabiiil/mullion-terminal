'use strict';

const { execFile } = require('node:child_process');

// Windows marks files hidden with an attribute rather than a leading dot, and
// Node has no API for file attributes. Without this, the home folder lists
// NTUSER.DAT, ntuser.ini and legacy junctions ("Application Data", "Cookies",
// …) that File Explorer hides and that deny access when opened.
const CACHE_MS = 3000;
const EMPTY = new Set();
const cache = new Map();

// `dir` runs with the folder as its working directory, so no path is ever
// parsed by cmd.exe (no quoting, no %VAR% expansion). /U writes UTF-16 to the
// pipe, which keeps non-ASCII names intact regardless of the console code page.
function listHidden(directory) {
  return new Promise(resolve => {
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/u', '/c', 'dir /a:h /b'], { cwd: directory, encoding: 'buffer', windowsHide: true, timeout: 2000 }, (error, stdout) => {
      // `dir` exits non-zero when nothing is hidden.
      if (error && !stdout?.length) return resolve(EMPTY);
      resolve(new Set(stdout.toString('utf16le').split(/\r?\n/).filter(Boolean)));
    });
  });
}

/** Names inside `directory` that carry the Windows Hidden attribute (empty elsewhere). */
async function hiddenNames(directory, platform = process.platform) {
  // cmd.exe cannot use a UNC path as its working directory and would silently
  // list C:\Windows instead.
  if (platform !== 'win32' || process.platform !== 'win32' || /^[\\/]{2}/.test(directory)) return EMPTY;
  const key = directory.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.names;
  const names = await listHidden(directory);
  if (cache.size > 200) cache.clear();
  cache.set(key, { names, time: Date.now() });
  return names;
}

module.exports = { hiddenNames };
