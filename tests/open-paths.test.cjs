'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathsFromArgv, resolveOpenTarget } = require('../electron/open-paths.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-open-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'notes.txt');
  const folder = path.join(root, 'Project');
  await fs.writeFile(file, 'hello\n');
  await fs.mkdir(folder);
  return { root, file, folder };
}

test('resolveOpenTarget tells an existing file from an existing folder', async t => {
  const { file, folder } = await fixture(t);
  assert.deepEqual(resolveOpenTarget(file), { path: file, isDirectory: false });
  assert.deepEqual(resolveOpenTarget(folder), { path: folder, isDirectory: true });
});

test('resolveOpenTarget ignores flags, non-strings and paths that do not exist', async t => {
  const { root } = await fixture(t);
  assert.equal(resolveOpenTarget('--cwd=/tmp'), null);
  assert.equal(resolveOpenTarget('-psn_0_123'), null);
  assert.equal(resolveOpenTarget(''), null);
  assert.equal(resolveOpenTarget(undefined), null);
  assert.equal(resolveOpenTarget(42), null);
  assert.equal(resolveOpenTarget(path.join(root, 'missing.txt')), null);
});

test('resolveOpenTarget resolves a relative path against the given cwd', async t => {
  const { root, file } = await fixture(t);
  assert.deepEqual(resolveOpenTarget('notes.txt', root), { path: file, isDirectory: false });
  assert.equal(resolveOpenTarget('missing.txt', root), null);
});

test('pathsFromArgv skips the Electron binary and, when unpackaged, the project directory argv carries as its own entry', async t => {
  const { root, file, folder } = await fixture(t);
  const packaged = pathsFromArgv(['/Applications/Mullion Terminal.app/Contents/MacOS/Mullion Terminal', file, folder], { isPackaged: true });
  assert.deepEqual(packaged, [{ path: file, isDirectory: false }, { path: folder, isDirectory: true }]);

  // Unpackaged (dev) launches add the project directory as their own argv[1]
  // (as `electron .` does), which must never be treated as an open target.
  const unpackaged = pathsFromArgv(['/usr/local/bin/electron', root, file], { isPackaged: false });
  assert.deepEqual(unpackaged, [{ path: file, isDirectory: false }]);
});

test('pathsFromArgv filters Electron/Chromium switches and the --cwd= / --user-data-dir= switches the app itself uses', async t => {
  const { file } = await fixture(t);
  const argv = ['/path/to/electron', '--inspect=9229', '--user-data-dir=/tmp/profile', '--cwd=/tmp/home', '--no-sandbox', file];
  assert.deepEqual(pathsFromArgv(argv, { isPackaged: true }), [{ path: file, isDirectory: false }]);
});

test('pathsFromArgv resolves a relative argv entry against the provided cwd, as a second-instance launch would need', async t => {
  const { root, file } = await fixture(t);
  const argv = ['/path/to/electron', 'notes.txt'];
  assert.deepEqual(pathsFromArgv(argv, { isPackaged: true, cwd: root }), [{ path: file, isDirectory: false }]);
});

test('pathsFromArgv drops paths that no longer exist instead of failing the whole batch', async t => {
  const { root, file } = await fixture(t);
  const argv = ['/path/to/electron', path.join(root, 'ghost.txt'), file];
  assert.deepEqual(pathsFromArgv(argv, { isPackaged: true }), [{ path: file, isDirectory: false }]);
});

test('pathsFromArgv caps results at the given limit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-open-paths-cap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [];
  for (let index = 0; index < 15; index += 1) {
    const file = path.join(root, `file-${index}.txt`);
    await fs.writeFile(file, '');
    files.push(file);
  }
  const argv = ['/path/to/electron', ...files];
  assert.equal(pathsFromArgv(argv, { isPackaged: true }).length, 10);
  assert.equal(pathsFromArgv(argv, { isPackaged: true, limit: 3 }).length, 3);
});

test('pathsFromArgv returns an empty array for non-array input', () => {
  assert.deepEqual(pathsFromArgv(undefined), []);
  assert.deepEqual(pathsFromArgv(null), []);
});

test('openModeFromArgv reads --open-mode=tab|window and ignores anything else', () => {
  const { openModeFromArgv } = require('../electron/open-paths.cjs');
  assert.equal(openModeFromArgv(['app', '--open-mode=window', 'C:\\Users\\me']), 'window');
  assert.equal(openModeFromArgv(['app', '--open-mode=tab', '/tmp']), 'tab');
  assert.equal(openModeFromArgv(['app', '--open-mode=tab', '--open-mode=window']), 'window');
  assert.equal(openModeFromArgv(['app', '--open-mode=split', '/tmp']), null);
  assert.equal(openModeFromArgv(['app', '--open-mode', 'window']), null);
  assert.equal(openModeFromArgv(['app', '/tmp']), null);
  assert.equal(openModeFromArgv(undefined), null);
});

test('urlsFromArgv picks out mullion-terminal links, and pathsFromArgv never treats a link as a path', async t => {
  const { urlsFromArgv } = require('../electron/open-paths.cjs');
  const { root, folder } = await fixture(t);
  const url = `mullion-terminal://open?mode=window&path=${encodeURIComponent(folder)}`;
  // A relative "path" that happens to exist under cwd must still not match a link.
  // Windows can't create a name with ':' at all, so there's nothing to collide with.
  if (process.platform !== 'win32') await fs.mkdir(path.join(root, 'mullion-terminal:'), { recursive: true });
  const argv = ['/opt/app', '--open-mode=window', url, 'https://example.com', folder];
  assert.deepEqual(urlsFromArgv(argv), [url]);
  assert.deepEqual(urlsFromArgv(['/usr/bin/electron', url, url], { isPackaged: false }), [url]);
  assert.deepEqual(pathsFromArgv(argv, { cwd: root }), [{ path: folder, isDirectory: true }]);
});
