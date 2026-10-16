'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseOpenUrl, isOpenUrl, createRateLimiter, MAX_URL_PATHS } = require('../electron/open-url.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-open-url-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'a folder & more');
  const file = path.join(folder, 'notes+1.md');
  await fs.mkdir(folder);
  await fs.writeFile(file, '# notes\n');
  return { root, folder, file };
}

const link = (mode, ...paths) => `mullion-terminal://open?mode=${mode}${paths.map(item => `&path=${encodeURIComponent(item)}`).join('')}`;

test('a well-formed link yields its mode and existing targets', async t => {
  const { folder, file } = await fixture(t);
  assert.deepEqual(parseOpenUrl(link('tab', folder)), { mode: 'tab', targets: [{ path: folder, isDirectory: true }] });
  assert.deepEqual(parseOpenUrl(link('window', folder, file)), {
    mode: 'window', targets: [{ path: folder, isDirectory: true }, { path: file, isDirectory: false }],
  });
  // The scheme is case-insensitive, a trailing slash after the host is fine, and duplicates collapse.
  assert.equal(parseOpenUrl(link('tab', folder, folder).replace('mullion-terminal://open', 'Mullion-Terminal://open/')).targets.length, 1);
});

test('paths that no longer exist are dropped; a link with none left is ignored', async t => {
  const { root, folder } = await fixture(t);
  const ghost = path.join(root, 'ghost');
  assert.deepEqual(parseOpenUrl(link('tab', ghost, folder)).targets, [{ path: folder, isDirectory: true }]);
  assert.equal(parseOpenUrl(link('tab', ghost)), null);
});

test('anything but the exact open link shape is rejected', async t => {
  const { folder } = await fixture(t);
  const encoded = encodeURIComponent(folder);
  for (const value of [
    undefined, 42, '', folder,
    `https://open?mode=tab&path=${encoded}`,
    `mullion-terminal://run?mode=tab&path=${encoded}`,
    `mullion-terminal://open.evil?mode=tab&path=${encoded}`,
    `mullion-terminal://user:pw@open?mode=tab&path=${encoded}`,
    `mullion-terminal://open:22?mode=tab&path=${encoded}`,
    `mullion-terminal://open/extra?mode=tab&path=${encoded}`,
    `mullion-terminal://open?mode=tab&path=${encoded}#frag`,
    `mullion-terminal://open?path=${encoded}`,
    `mullion-terminal://open?mode=split&path=${encoded}`,
    `mullion-terminal://open?mode=tab&mode=window&path=${encoded}`,
    `mullion-terminal://open?mode=tab&path=${encoded}&command=rm`,
    'mullion-terminal://open?mode=tab',
    'mullion-terminal://open?mode=tab&path=',
    'mullion-terminal://open?mode=tab&path=relative%2Fpath',
    'mullion-terminal://open?mode=tab&path=..%2F..',
    `mullion-terminal://open?mode=tab&path=${encoded}%00`,
    `mullion-terminal://open?mode=tab&path=${encoded}\n`,
    `mullion-terminal://open?mode=tab&path=${'a'.repeat(40000)}`,
  ]) assert.equal(parseOpenUrl(value), null, String(value).slice(0, 120));
});

test('a link may carry at most ten paths', async t => {
  const { folder } = await fixture(t);
  assert.equal(parseOpenUrl(link('tab', ...Array(MAX_URL_PATHS).fill(folder))).targets.length, 1);
  assert.equal(parseOpenUrl(link('tab', ...Array(MAX_URL_PATHS + 1).fill(folder))), null);
});

test('isOpenUrl recognizes the scheme only', () => {
  assert.equal(isOpenUrl('mullion-terminal://open?mode=tab'), true);
  assert.equal(isOpenUrl('MULLION-TERMINAL://open'), true);
  assert.equal(isOpenUrl('mullion-terminal:open'), false);
  assert.equal(isOpenUrl('/Users/me'), false);
  assert.equal(isOpenUrl(null), false);
});

test('the rate limiter allows a burst up to its limit per interval', () => {
  let now = 0;
  const allow = createRateLimiter({ limit: 3, interval: 1000, now: () => now });
  assert.deepEqual([allow(), allow(), allow(), allow()], [true, true, true, false]);
  now = 999;
  assert.equal(allow(), false);
  now = 1000;
  assert.equal(allow(), true);
});
