'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  installFinderQuickActions, removeFinderQuickActions, quickActionScript, templateDirectory, workflowPath, legacyWorkflowPath,
  QUICK_ACTIONS, LEGACY_WORKFLOW_NAME, MARKER_KEY,
} = require('../electron/finder-service.cjs');
const { parseOpenUrl } = require('../electron/open-url.cjs');

const darwin = process.platform === 'darwin';
const templateDirs = { tab: templateDirectory({ mode: 'tab' }), window: templateDirectory({ mode: 'window' }) };
const workflowNames = QUICK_ACTIONS.map(action => action.workflow).sort();

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

// A marked bundle like the single Quick Action earlier releases installed.
async function writeLegacyBundle(home, marked = true) {
  const contents = path.join(legacyWorkflowPath(home), 'Contents');
  await fs.mkdir(contents, { recursive: true });
  const marker = marked ? `<key>${MARKER_KEY}</key><true/>` : '';
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>Open in Mullion Terminal</string>${marker}</dict></plist>\n`);
}

for (const { mode, name } of QUICK_ACTIONS) {
  test(`the shipped "${name}" template sends mode=${mode} links for the selected files and folders`, { skip: !darwin }, () => {
    const info = readPlist(path.join(templateDirs[mode], 'Contents', 'Info.plist'));
    assert.equal(info[MARKER_KEY], true);
    assert.equal(info.CFBundleName, name);
    assert.equal(info.CFBundleIdentifier, `dev.mullion.terminal.quickaction.${mode}`);
    const [service] = info.NSServices;
    assert.equal(service.NSMenuItem.default, name);
    assert.equal(service.NSMessage, 'runWorkflowAsService');
    assert.equal(service.NSRequiredContext.NSApplicationIdentifier, 'com.apple.finder');
    assert.deepEqual(service.NSSendFileTypes, ['public.item', 'public.folder']);
    const document = readPlist(path.join(templateDirs[mode], 'Contents', 'document.wflow'));
    assert.equal(document.actions.length, 1);
    const { action } = document.actions[0];
    assert.equal(action.BundleIdentifier, 'com.apple.RunShellScript');
    assert.equal(action.ActionParameters.COMMAND_STRING, quickActionScript({ mode }));
    assert.equal(action.ActionParameters.shell, '/bin/zsh');
    assert.equal(action.ActionParameters.inputMethod, 1);
    const meta = document.workflowMetaData;
    assert.equal(meta.workflowTypeIdentifier, 'com.apple.Automator.servicesMenu');
    assert.equal(meta.serviceInputTypeIdentifier, 'com.apple.Automator.fileSystemObject');
    assert.equal(meta.serviceProcessesInput, true);
  });
}

test('the Quick Action script percent-encodes every path into links the app accepts, ten paths per link', { skip: !darwin }, async t => {
  const root = await fakeHome(t);
  const awkward = path.join(root, `a b+c&d=é'"$x%#?`);
  await fs.mkdir(awkward);
  const many = [];
  for (let index = 0; index < 11; index += 1) {
    many.push(path.join(root, `item ${index}`));
    await fs.writeFile(many.at(-1), '');
  }
  const appPath = path.join(root, "It's Mullion.app");
  // Stand-in for /usr/bin/open: prints its arguments, one per line.
  const script = `open() { print -rl -- "$@" "--" }\n${quickActionScript({ mode: 'window', appPath })}`;
  const output = execFileSync('/bin/zsh', ['-f', '-c', script, 'zsh', awkward, ...many], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
  const calls = output.trim().split('\n--').map(call => call.trim().split('\n')).filter(call => call[0]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.slice(0, 2), ['-a', appPath]);
  const first = parseOpenUrl(calls[0][2]);
  const second = parseOpenUrl(calls[1][2]);
  assert.equal(first.mode, 'window');
  assert.deepEqual(first.targets.map(target => target.path), [awkward, ...many.slice(0, 9)]);
  assert.deepEqual(second.targets.map(target => target.path), many.slice(9));
  // Without an app path the script targets the bundle id.
  assert.match(quickActionScript({ mode: 'tab' }), /open -b dev\.mullion\.terminal "\$url"/);
  assert.throws(() => quickActionScript({ mode: 'sideways' }));
});

test('install writes both well-formed bundles, and installing again leaves the same two bundles', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  const first = await installFinderQuickActions({ templateDirs, homeDir: home, refresh });
  assert.equal(first.installed, true);
  assert.deepEqual(first.actions.map(action => action.path), [workflowPath('tab', home), workflowPath('window', home)]);
  for (const { mode } of QUICK_ACTIONS) {
    for (const file of ['Info.plist', 'document.wflow']) {
      const installed = path.join(workflowPath(mode, home), 'Contents', file);
      readPlist(installed);
      assert.equal(await fs.readFile(installed, 'utf8'), await fs.readFile(path.join(templateDirs[mode], 'Contents', file), 'utf8'));
    }
  }
  // A stale extra file inside our own bundle is replaced, not merged.
  await fs.writeFile(path.join(workflowPath('tab', home), 'Contents', 'stale.txt'), 'old');
  const second = await installFinderQuickActions({ templateDirs, homeDir: home, refresh });
  assert.equal(second.installed, true);
  assert.deepEqual((await fs.readdir(path.join(home, 'Library', 'Services'))).sort(), workflowNames);
  assert.deepEqual((await fs.readdir(path.join(workflowPath('tab', home), 'Contents'))).sort(), ['Info.plist', 'document.wflow']);
  assert.equal(refresh.calls, 2);
});

test('install points both actions at the given copy of the app', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const appPath = "/Applications/Mullion's Terminal.app";
  await installFinderQuickActions({ templateDirs, appPath, homeDir: home, refresh: refreshCounter() });
  for (const { mode } of QUICK_ACTIONS) {
    const document = readPlist(path.join(workflowPath(mode, home), 'Contents', 'document.wflow'));
    assert.equal(document.actions[0].action.ActionParameters.COMMAND_STRING, quickActionScript({ mode, appPath }));
  }
});

test('install migrates the legacy "Open in Mullion Terminal" action away, but only when it is ours', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  await writeLegacyBundle(home);
  const result = await installFinderQuickActions({ templateDirs, homeDir: home, refresh });
  assert.equal(result.legacyRemoved, true);
  assert.deepEqual((await fs.readdir(path.join(home, 'Library', 'Services'))).sort(), workflowNames);

  const other = await fakeHome(t);
  await writeLegacyBundle(other, false);
  assert.equal((await installFinderQuickActions({ templateDirs, homeDir: other, refresh })).legacyRemoved, false);
  assert.deepEqual((await fs.readdir(path.join(other, 'Library', 'Services'))).sort(), [LEGACY_WORKFLOW_NAME, ...workflowNames].sort());
});

test('remove deletes only our bundles (legacy included) and is idempotent', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  const services = path.join(home, 'Library', 'Services');
  await fs.mkdir(path.join(services, 'Someone Else.workflow', 'Contents'), { recursive: true });
  await installFinderQuickActions({ templateDirs, homeDir: home, refresh });
  await writeLegacyBundle(home);
  const removed = await removeFinderQuickActions({ homeDir: home, refresh });
  assert.equal(removed.removed, true);
  assert.equal(removed.legacyRemoved, true);
  assert.deepEqual(removed.actions.map(action => action.removed), [true, true]);
  assert.deepEqual(await fs.readdir(services), ['Someone Else.workflow']);
  const again = await removeFinderQuickActions({ homeDir: home, refresh });
  assert.equal(again.removed, false);
  assert.deepEqual(again.actions.map(action => action.reason), ['not-installed', 'not-installed']);
  assert.equal(refresh.calls, 2);
});

test('a same-named bundle without the marker is never overwritten or deleted', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  const contents = path.join(workflowPath('window', home), 'Contents');
  await fs.mkdir(contents, { recursive: true });
  const foreign = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>Mine</string></dict></plist>\n';
  await fs.writeFile(path.join(contents, 'Info.plist'), foreign);
  const installed = await installFinderQuickActions({ templateDirs, homeDir: home, refresh });
  assert.equal(installed.installed, false);
  assert.deepEqual(installed.actions.map(action => action.reason ?? 'installed'), ['installed', 'foreign-bundle']);
  const removed = await removeFinderQuickActions({ homeDir: home, refresh });
  assert.deepEqual(removed.actions.map(action => action.reason ?? 'removed'), ['removed', 'foreign-bundle']);
  assert.equal(await fs.readFile(path.join(contents, 'Info.plist'), 'utf8'), foreign);
});

test('install refuses a template that is not our marked bundle', { skip: !darwin }, async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  const missing = path.join(home, 'missing.workflow');
  const result = await installFinderQuickActions({ templateDirs: { tab: missing, window: missing }, homeDir: home, refresh });
  assert.equal(result.installed, false);
  assert.deepEqual(result.actions.map(action => action.reason), ['missing-template', 'missing-template']);
  assert.equal((await installFinderQuickActions({ templateDirs: {}, homeDir: home, refresh })).actions[0].reason, 'missing-template');
  await assert.rejects(fs.access(path.join(home, 'Library')));
  assert.equal(refresh.calls, 0);
});

test('everything is a no-op off macOS', async t => {
  const home = await fakeHome(t);
  const refresh = refreshCounter();
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(await installFinderQuickActions({ templateDirs, homeDir: home, platform, refresh }), { installed: false, reason: 'unsupported-platform' });
    assert.deepEqual(await removeFinderQuickActions({ homeDir: home, platform, refresh }), { removed: false, reason: 'unsupported-platform' });
  }
  assert.deepEqual(await fs.readdir(home), []);
  assert.equal(refresh.calls, 0);
});

test('the template paths follow packaging', () => {
  for (const { mode, workflow } of QUICK_ACTIONS) {
    assert.equal(templateDirectory({ mode, isPackaged: false }), path.join(__dirname, '..', 'electron', 'resources', workflow));
    assert.equal(templateDirectory({ mode, isPackaged: true, resourcesPath: '/Applications/Mullion Terminal.app/Contents/Resources' }), path.join('/Applications/Mullion Terminal.app/Contents/Resources', workflow));
  }
  assert.throws(() => templateDirectory({ mode: 'other' }));
});
