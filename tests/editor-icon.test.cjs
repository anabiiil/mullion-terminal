'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { loadMacApplicationIcon } = require('../electron/editor-icon.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1UAAAAASUVORK5CYII=', 'base64');

async function fixture(t, iconName = 'Code.icns') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-native-icon-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'My Editor $(literal).app');
  await fs.mkdir(path.join(target, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(target, 'Contents', 'Info.plist'), '<plist/>');
  await fs.writeFile(path.join(target, 'Contents', 'Resources', iconName), 'icns');
  const temporaryRoot = path.join(root, 'converted');
  await fs.mkdir(temporaryRoot);
  return { root, target, temporaryRoot };
}

test('declared native icon uses literal system-tool arguments and cleans owned PNG output', async t => {
  const name = 'App Icon $(literal).icns';
  const { target, temporaryRoot } = await fixture(t, name);
  const calls = [];
  const runFile = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/plutil') return { stdout: name + '\n' };
    assert.equal(command, '/usr/bin/sips');
    await fs.writeFile(args[args.indexOf('--out') + 1], PNG);
    return { stdout: '' };
  };
  const icon = await loadMacApplicationIcon(target, { temporaryRoot, runFile });
  assert.equal(icon, `data:image/png;base64,${PNG.toString('base64')}`);
  const bundle = await fs.realpath(target);
  assert.deepEqual(calls[0].args, ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')]);
  assert.equal(calls[1].args[3], path.join(bundle, 'Contents', 'Resources', name));
  assert(calls.every(call => call.options.shell === false && call.options.timeout > 0));
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});

test('an extensionless CFBundleIconFile resolves to its installed ICNS resource', async t => {
  const { target, temporaryRoot } = await fixture(t);
  let converted;
  const runFile = async (command, args) => {
    if (command.endsWith('plutil')) return { stdout: 'Code' };
    converted = args[3];
    await fs.writeFile(args[args.indexOf('--out') + 1], PNG);
    return { stdout: '' };
  };
  assert(await loadMacApplicationIcon(target, { temporaryRoot, runFile }));
  assert.equal(path.basename(converted), 'Code.icns');
});

test('declared icon traversal and external resource symlinks never invoke conversion', async t => {
  const { root, target, temporaryRoot } = await fixture(t);
  let converted = false;
  const runFile = async command => {
    if (command.endsWith('plutil')) return { stdout: '../outside.icns' };
    converted = true;
    return { stdout: '' };
  };
  assert.equal(await loadMacApplicationIcon(target, { temporaryRoot, runFile }), undefined);
  if (process.platform !== 'win32') {
    // Symlink creation needs elevated privilege on some Windows hosts; the
    // traversal case above already covers the guard on every platform.
    const external = path.join(root, 'outside.icns');
    await fs.writeFile(external, 'icns');
    await fs.symlink(external, path.join(target, 'Contents', 'Resources', 'external.icns'));
    const symlinkRunner = async command => {
      if (command.endsWith('plutil')) return { stdout: 'external.icns' };
      converted = true;
      return { stdout: '' };
    };
    assert.equal(await loadMacApplicationIcon(target, { temporaryRoot, runFile: symlinkRunner }), undefined);
    assert.equal(converted, false);
  }
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});

test('conversion failures clean only owned output and return a branded-fallback signal', async t => {
  const { target, temporaryRoot } = await fixture(t);
  await fs.writeFile(path.join(temporaryRoot, 'keep.txt'), 'unrelated');
  const runFile = async command => {
    if (command.endsWith('plutil')) return { stdout: 'Code.icns' };
    throw new Error('Cannot decode ICNS');
  };
  assert.equal(await loadMacApplicationIcon(target, { temporaryRoot, runFile }), undefined);
  assert.deepEqual(await fs.readdir(temporaryRoot), ['keep.txt']);
  assert.equal(await loadMacApplicationIcon('/usr/bin/code', { temporaryRoot, runFile }), undefined);
});
