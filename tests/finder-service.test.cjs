'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { installFinderQuickAction, removeFinderQuickAction, templateDirectory, workflowPath, WORKFLOW_NAME, MARKER_KEY } = require('../electron/finder-service.cjs');

const darwin = process.platform === 'darwin';
const templateDir = templateDirectory({ isPackaged: false });

function readPlist(file) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { encoding: 'utf8' }));
}

// Never runs the real `pbs -update` from tests; counts refresh requests instead.
function refreshCounter() {
  const refresh = async () => { refresh.calls += 1; return { refreshed: true }; };
  refresh.calls = 0;
  return refresh;
}

async function fakeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-finder-service-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('the shipped template runs `open -b dev.mullion.terminal` on the selected files and folders', { skip: !darwin }, () => {
  const info = readPlist(path.join(templateDir, 'Contents', 'Info.plist'));
  assert.equal(info[MARKER_KEY], true);
  const [service] = info.NSServices;
  assert.equal(service.NSMenuItem.default, 'Open in Mullion Terminal');
  assert.equal(service.NSMessage, 'runWorkflowAsService');
  assert.equal(service.NSRequiredContext.NSApplicationIdentifier, 'com.apple.finder');
  assert.deepEqual(service.NSSendFileTypes, ['public.item', 'public.folder']);
  const document = readPlist(path.join(templateDir, 'Contents', 'document.wflow'));
  assert.equal(document.actions.length, 1);
  const { action } = document.actions[0];
  assert.equal(action.BundleIdentifier, 'com.apple.RunShellScript');
  assert.equal(action.ActionParameters.COMMAND_STRING, 'open -b dev.mullion.terminal "$@"');
  assert.equal(action.ActionParameters.inputMethod, 1);
  const meta = document.workflowMetaData;
  assert.equal(meta.workflowTypeIdentifier, 'com.apple.Automator.servicesMenu');
  assert.equal(meta.serviceInputTypeIdentifier, 'com.apple.Automator.fileSystemObject');
  assert.equal(meta.serviceProcessesInput, true);
});

test('install writes a well-formed bundle, and installing again leaves the same single bundle', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  const first = await installFinderQuickAction({ templateDir, homeDir: home, refresh });
  assert.equal(first.installed, true);
  assert.equal(first.path, workflowPath(home));
  const bundle = path.join(home, 'Library', 'Services', WORKFLOW_NAME);
  for (const file of ['Info.plist', 'document.wflow']) {
    const installed = path.join(bundle, 'Contents', file);
    readPlist(installed);
    assert.equal(await fs.readFile(installed, 'utf8'), await fs.readFile(path.join(templateDir, 'Contents', file), 'utf8'));
  }
  // A stale extra file inside our own bundle is replaced, not merged.
  await fs.writeFile(path.join(bundle, 'Contents', 'stale.txt'), 'old');
  const second = await installFinderQuickAction({ templateDir, homeDir: home, refresh });
  assert.equal(second.installed, true);
  assert.deepEqual(await fs.readdir(path.join(home, 'Library', 'Services')), [WORKFLOW_NAME]);
  assert.deepEqual((await fs.readdir(path.join(bundle, 'Contents'))).sort(), ['Info.plist', 'document.wflow']);
  assert.equal(refresh.calls, 2);
});

test('remove deletes only our bundle and is idempotent', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  const services = path.join(home, 'Library', 'Services');
  await fs.mkdir(path.join(services, 'Someone Else.workflow', 'Contents'), { recursive: true });
  await installFinderQuickAction({ templateDir, homeDir: home, refresh });
  assert.equal((await removeFinderQuickAction({ homeDir: home, refresh })).removed, true);
  assert.deepEqual(await fs.readdir(services), ['Someone Else.workflow']);
  assert.deepEqual(await removeFinderQuickAction({ homeDir: home, refresh }), { removed: false, reason: 'not-installed', path: workflowPath(home) });
  assert.equal(refresh.calls, 2);
});

test('a same-named bundle without the marker is never overwritten or deleted', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  const contents = path.join(home, 'Library', 'Services', WORKFLOW_NAME, 'Contents');
  await fs.mkdir(contents, { recursive: true });
  const foreign = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>Mine</string></dict></plist>\n';
  await fs.writeFile(path.join(contents, 'Info.plist'), foreign);
  assert.equal((await installFinderQuickAction({ templateDir, homeDir: home, refresh })).reason, 'foreign-bundle');
  assert.equal((await removeFinderQuickAction({ homeDir: home, refresh })).reason, 'foreign-bundle');
  assert.equal(await fs.readFile(path.join(contents, 'Info.plist'), 'utf8'), foreign);
  assert.equal(refresh.calls, 0);
});

test('install refuses a template that is not our marked bundle', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  assert.equal((await installFinderQuickAction({ templateDir: path.join(home, 'missing.workflow'), homeDir: home, refresh })).reason, 'missing-template');
  assert.equal((await installFinderQuickAction({ homeDir: home, refresh })).reason, 'missing-template');
  await assert.rejects(fs.access(path.join(home, 'Library')));
});

test('everything is a no-op off macOS', async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(await installFinderQuickAction({ templateDir, homeDir: home, platform, refresh }), { installed: false, reason: 'unsupported-platform' });
    assert.deepEqual(await removeFinderQuickAction({ homeDir: home, platform, refresh }), { removed: false, reason: 'unsupported-platform' });
  }
  assert.deepEqual(await fs.readdir(home), []);
  assert.equal(refresh.calls, 0);
});

test('the template path follows packaging', () => {
  assert.equal(templateDirectory({ isPackaged: false }), path.join(__dirname, '..', 'electron', 'resources', WORKFLOW_NAME));
  assert.equal(templateDirectory({ isPackaged: true, resourcesPath: '/Applications/Mullion Terminal.app/Contents/Resources' }), path.join('/Applications/Mullion Terminal.app/Contents/Resources', WORKFLOW_NAME));
});
