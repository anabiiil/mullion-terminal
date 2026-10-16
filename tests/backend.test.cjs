'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { PromptParser } = require('../electron/osc.cjs');
const { LocalStore, normalizeHistory, normalizeDirectories, HISTORY_LIMIT, DIRECTORIES_LIMIT } = require('../electron/store.cjs');
const { quoteToken, directoryCommand, tokenize, complete, isInjectedCommand, abbreviateHome, visitedDirectoryCandidates } = require('../electron/completions.cjs');
const { prepareShell, defaultEnvironment } = require('../electron/shell.cjs');
const { SubmissionTracker } = require('../electron/submissions.cjs');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('private prompt parser handles every chunk boundary without consuming unrelated OSC', () => {
  const cwd = '/tmp/أعمال; with spaces';
  const marker = `\x1b]777;Mullion;secret;ready;${Buffer.from(cwd).toString('base64')};${Buffer.from('/bin:/usr/bin').toString('base64')}\x07`;
  const unrelated = '\x1b]0;terminal title\x07';
  for (let split = 1; split < marker.length; split++) {
    const events = [];
    const parser = new PromptParser('secret', value => events.push(value));
    const data = `before${unrelated}${marker}after`;
    const splitAt = 6 + unrelated.length + split;
    const visible = parser.feed(data.slice(0, splitAt)) + parser.feed(data.slice(splitAt)) + parser.flush();
    assert.equal(visible, `before${unrelated}after`);
    assert.deepEqual(events, [{ ready: true, cwd, path: '/bin:/usr/bin' }]);
  }
});

test('prompt parser accepts ST termination, busy, and rejects malformed cwd', () => {
  const events = [];
  const parser = new PromptParser('nonce', value => events.push(value));
  let output = '';
  const stream = '\x1b]777;Mullion;nonce;busy\x1b\\hello\x1b]777;Mullion;nonce;ready;not-base64;\x07\x1b]777;Mullion;other;busy\x07';
  for (const character of stream) output += parser.feed(character);
  output += parser.flush();
  assert.equal(output, 'hello\x1b]777;Mullion;other;busy\x07');
  assert.deepEqual(events, [{ ready: false }]);
});

test('command markers learn only shell commands and filter control characters', () => {
  const recorded = [];
  const parser = new PromptParser('nonce', () => {}, command => recorded.push(command));
  const command = 'git commit -m "أعمال"';
  const marker = value => `\x1b]777;Mullion;nonce;command;${Buffer.from(value).toString('base64')}\x07`;
  assert.equal(parser.feed(marker(command) + marker('secret\nsecond line') + marker('')), '');
  assert.deepEqual(recorded, [command]);
});

test('ready marker reports an exit status only when the shell sent a small, well-formed integer', () => {
  const events = [];
  const parser = new PromptParser('nonce', value => events.push(value));
  const marker = (navigation, status) => `\x1b]777;Mullion;nonce;ready;${Buffer.from('/tmp').toString('base64')};${Buffer.from('/bin').toString('base64')};${navigation};${status}\x07`;
  parser.feed(marker('1', '127'));
  parser.feed(marker('0', '0'));
  parser.feed(marker('1', 'not-a-number'));
  assert.deepEqual(events, [
    { ready: true, cwd: '/tmp', path: '/bin', navigation: true, status: 127 },
    { ready: true, cwd: '/tmp', path: '/bin', navigation: false, status: 0 },
    { ready: true, cwd: '/tmp', path: '/bin', navigation: true },
  ]);
});

test('submission metadata is a prompt fallback and shell hooks deduplicate actual commands', () => {
  const records = [];
  const tracker = new SubmissionTracker(command => records.push(command));
  tracker.submit('!!');
  tracker.hook('git status'); // Real shell expansion wins.
  tracker.finish();
  tracker.hook('git status'); // A late hook for the same line is ignored.
  tracker.submit('git status');
  tracker.finish(); // Bash ignoredups omitted this line from its history hook.
  tracker.submit(undefined);
  tracker.hook('native arrow-up edited command');
  tracker.finish();
  tracker.submit('invalid\nmetadata');
  tracker.finish();
  assert.deepEqual(records, ['git status', 'git status', 'native arrow-up edited command']);
});

test('SubmissionTracker never forwards app-injected navigation to the record callback', () => {
  const records = [];
  const tracker = new SubmissionTracker(command => records.push(command));
  tracker.hook("builtin cd -- '/Users/test/Projects'");
  tracker.submit("builtin cd -- '/Users/test/Projects'");
  tracker.finish();
  const windows = new SubmissionTracker(command => records.push(command));
  windows.hook("Set-Location -LiteralPath 'C:\\Projects'");
  windows.submit("Set-Location -LiteralPath 'C:\\Projects'");
  windows.finish();
  assert.deepEqual(records, []);
});

test('SubmissionTracker never learns a command submitted with record: false, even when the shell hook echoes it back', () => {
  const records = [];
  const tracker = new SubmissionTracker(command => records.push(command));
  // The app running something on the user's behalf (e.g. a tree double-click opening nano):
  // the shell hook reports the exact text that was typed into the PTY, but it must be dropped.
  tracker.submit("nano 'notes.txt'", { record: false });
  tracker.hook("nano 'notes.txt'");
  tracker.finish();
  // A normal, user-driven submission right after must still be learned.
  tracker.submit('git status');
  tracker.hook('git status');
  tracker.finish();
  // record: false with no corresponding hook (renderer fallback only) must also be dropped.
  tracker.submit('echo renderer-only', { record: false });
  tracker.finish();
  assert.deepEqual(records, ['git status']);
});

test('SubmissionTracker skips a command that failed with "command not found" (POSIX status 127)', () => {
  const records = [];
  const tracker = new SubmissionTracker(command => records.push(command));
  tracker.submit('مس');
  tracker.hook('مس');
  tracker.finish(127);
  tracker.submit('git status');
  tracker.hook('git status');
  tracker.finish(0);
  tracker.submit('still learned without a status');
  tracker.hook('still learned without a status');
  tracker.finish(); // No status reported (e.g. PowerShell): never skipped on that basis alone.
  assert.deepEqual(records, ['git status', 'still learned without a status']);
});

test('SubmissionTracker skips a command that failed because it was "not executable" (POSIX status 126), same as 127', () => {
  const records = [];
  const tracker = new SubmissionTracker(command => records.push(command));
  tracker.submit('./not-executable.sh');
  tracker.hook('./not-executable.sh');
  tracker.finish(126);
  assert.deepEqual(records, []);
});

test('SubmissionTracker never creates a new history entry for a command that failed on its own terms, but still bumps one that has succeeded before', () => {
  const calls = [];
  const tracker = new SubmissionTracker((command, options) => calls.push({ command, options }));
  // A typo-like failure (e.g. `git psuh` exiting 1, a real shell error, not "command not found"):
  // it must be reported with onlyIfExists so the store never learns it as a brand-new command.
  tracker.submit('git psuh');
  tracker.hook('git psuh');
  tracker.finish(1);
  // A command that previously succeeded and now fails must still have its count/lastUsed
  // bumped — the "onlyIfExists" gate only blocks *creating* an entry, not updating one.
  tracker.submit('npm test');
  tracker.hook('npm test');
  tracker.finish(3);
  assert.deepEqual(calls, [
    { command: 'git psuh', options: { onlyIfExists: true } },
    { command: 'npm test', options: { onlyIfExists: true } },
  ]);
});

test('SubmissionTracker treats success, Ctrl+C (130), SIGTERM (143), and an unreported status as success-equivalent, always recording', () => {
  const calls = [];
  const tracker = new SubmissionTracker((command, options) => calls.push({ command, options }));
  for (const status of [0, 130, 143, undefined]) {
    tracker.submit(`command-${status}`);
    tracker.hook(`command-${status}`);
    tracker.finish(status);
  }
  assert.deepEqual(calls, [0, 130, 143, undefined].map(status => ({ command: `command-${status}`, options: {} })));
});

test('store.record() with onlyIfExists never creates a new entry, but still bumps an existing one', async t => {
  const root = await temporary(t);
  let now = 100;
  const store = new LocalStore(root, () => ++now);
  await store.load();
  // A command that has never succeeded must never appear in history at all.
  await store.record('git psuh', '/work', { onlyIfExists: true });
  assert.deepEqual((await store.load()).history, []);
  // Once it has succeeded (a normal record), a later failure still updates it in place.
  await store.record('npm test', '/work');
  const afterFirstSuccess = (await store.load()).history.find(entry => entry.command === 'npm test');
  assert.equal(afterFirstSuccess.count, 1);
  await store.record('npm test', '/work', { onlyIfExists: true });
  const afterLaterFailure = (await store.load()).history.find(entry => entry.command === 'npm test');
  assert.equal(afterLaterFailure.count, 2);
  assert(afterLaterFailure.lastUsed >= afterFirstSuccess.lastUsed);
  // The typo is still nowhere in history.
  assert.equal((await store.load()).history.some(entry => entry.command === 'git psuh'), false);
});

test('isInjectedCommand flags app-typed navigation and internal hooks only', () => {
  assert(isInjectedCommand("builtin cd -- '/tmp'"));
  assert(isInjectedCommand("Set-Location -LiteralPath 'C:\\tmp'"));
  assert(isInjectedCommand('__mullion_apply_navigation'));
  assert(!isInjectedCommand('cd /tmp'));
  assert(!isInjectedCommand('git status'));
});

test('directory quoting is safe for spaces, quotes, shell metacharacters and Unicode', async t => {
  const root = await temporary(t);
  const directory = path.join(root, process.platform === 'win32' ? "hello ' $(touch INJECTED); أعمال" : "hello ' $(touch INJECTED); أعمال\\world");
  await fs.mkdir(directory);
  if (process.platform !== 'win32') {
    const result = spawnSync('/bin/bash', ['-c', `${directoryCommand(directory, 'linux')}; printf '%s' "$PWD"`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, directory);
    await assert.rejects(fs.stat(path.join(root, 'INJECTED')), { code: 'ENOENT' });
  }
  assert.equal(directoryCommand("C:\\user's files", 'win32'), "Set-Location -LiteralPath 'C:\\user''s files'");
  assert.throws(() => directoryCommand('/tmp/line\nbreak'), /cannot be inserted/);
  assert.equal(quoteToken('back\\slash', 'linux'), "'back\\slash'");
  assert.equal(quoteToken('$secret; command', 'win32'), "'$secret; command'");
});

test('shell tokenization understands escaped spaces and incomplete quotes', () => {
  assert.deepEqual(tokenize('cat "My Documents/re', 'linux'), [
    { start: 0, end: 3, decoded: 'cat' }, { start: 4, end: 20, decoded: 'My Documents/re' },
  ]);
  assert.equal(tokenize('cat My\\ Documents/report', 'linux')[1].decoded, 'My Documents/report');
  assert.equal(tokenize("Get-Content 'user''s file'", 'win32')[1].decoded, "user's file");
  assert.equal(tokenize('cd ', 'linux')[1].start, 3);
});

test('completion replaces the whole last token, handles symlinks and filters cd files', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'New folder'));
  await fs.mkdir(path.join(root, 'documents'));
  await fs.writeFile(path.join(root, 'documents', 'report final.txt'), '');
  await fs.writeFile(path.join(root, 'notes.txt'), '');
  await fs.writeFile(path.join(root, '.hidden'), '');
  if (process.platform !== 'win32') await fs.writeFile(path.join(root, 'bad\nname'), '');
  if (process.platform !== 'win32') await fs.symlink(path.join(root, 'documents'), path.join(root, 'docs-link'));
  const options = { cwd: root, platform: process.platform, environmentPath: '', home: root };
  const dirs = await complete({ ...options, line: 'cd ' });
  assert(dirs.every(candidate => candidate.kind === 'directory'));
  assert(dirs.every(candidate => candidate.detail === 'Folder'));
  assert(dirs.some(candidate => candidate.value === (process.platform === 'win32' ? "cd 'New folder\\'" : "cd 'New folder/'")));
  const files = await complete({ ...options, line: 'cat documents/re' });
  assert.equal(files.length, 1);
  assert.equal(files[0].value, "cat 'documents/report final.txt'");
  assert.equal(files[0].detail, 'File');
  const unclosed = await complete({ ...options, line: 'cat "documents/re' });
  assert.equal(unclosed[0].value, files[0].value);
  const hidden = await complete({ ...options, line: 'cat ' });
  assert(!hidden.some(candidate => candidate.label === '.hidden'));
  assert(!hidden.some(candidate => candidate.label.includes('\n')));
  assert((await complete({ ...options, showHidden: true, line: 'cat ' })).some(candidate => candidate.label === '.hidden'));
  const homeDirectory = await complete({ ...options, line: 'cd ~/N' });
  assert(homeDirectory[0].value.includes(root));
  assert(!homeDirectory[0].value.includes('//'));
});

test('command completion sees actual executables from the shell PATH', async t => {
  if (process.platform === 'win32') return;
  const root = await temporary(t);
  await fs.writeFile(path.join(root, 'test-command'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'test-data'), '', { mode: 0o644 });
  const candidates = await complete({ line: 'test-', cwd: root, environmentPath: root, platform: 'linux' });
  assert.deepEqual(candidates.map(candidate => candidate.label), ['test-command']);
  assert.equal(candidates[0].detail, 'Command');
});

test('empty-prefix filesystem suggestions work after bare commands and respect operand types', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'first folder'));
  await fs.writeFile(path.join(root, 'a fixture file.txt'), '');
  const options = { cwd: root, platform: process.platform, environmentPath: '' };
  const separator = process.platform === 'win32' ? '\\' : '/';
  for (const line of ['cd', 'cd ']) {
    assert.deepEqual((await complete({ ...options, line })).map(value => [value.value, value.kind]), [[`cd 'first folder${separator}'`, 'directory']]);
  }
  for (const line of ['cat', 'cat ', 'head ', 'tail ', 'source ']) {
    const values = await complete({ ...options, line });
    assert.equal(values.length, 1);
    assert.equal(values[0].kind, 'file');
    assert.equal(values[0].label, 'a fixture file.txt');
  }
  const files = await complete({ ...options, line: 'rm ' });
  assert(files.some(value => value.value === "rm 'a fixture file.txt'"));
  if (process.platform !== 'win32') assert(files.every(value => value.kind === 'file'));
  for (const flags of ['-r', '-R', '-rf', '--recursive', '-d']) {
    assert((await complete({ ...options, line: `rm ${flags} ` })).some(value => value.kind === 'directory'));
  }
  assert.deepEqual(await complete({ ...options, line: 'git ' }), []);
  assert.deepEqual(await complete({ ...options, line: 'mkdir ' }), []);
  assert.deepEqual(await complete({ ...options, line: 'head -n ' }), []);
});

test('leading-dash filenames are safe operands and rm symlink directories remain links', async t => {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, '-rf file.txt'), '');
  await fs.mkdir(path.join(root, 'target'));
  if (process.platform !== 'win32') await fs.symlink(path.join(root, 'target'), path.join(root, 'link'));
  const options = { cwd: root, platform: process.platform, environmentPath: '' };
  const value = (await complete({ ...options, line: 'rm ' })).find(value => value.label === '-rf file.txt');
  assert.equal(value.value, process.platform === 'win32' ? "rm '.\\-rf file.txt'" : "rm './-rf file.txt'");
  if (process.platform !== 'win32') {
    const link = (await complete({ ...options, line: 'rm ' })).find(value => value.label === 'link');
    assert.equal(link.kind, 'file');
    assert.equal(link.value, 'rm link');
  }
});

test('filesystem suggestions do not infer paths after shell operators or substitutions', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'folder'));
  for (const line of ['cd ; rm ', 'cd && rm ', 'cd $(pwd)/', 'cd "$HOME/"', 'ls | cat ']) {
    assert.deepEqual(await complete({ line, cwd: root, platform: process.platform, environmentPath: '' }), []);
  }
});

test('PowerShell startup keeps profiles and uses inline encoding without policy changes', async t => {
  const root = await temporary(t);
  const launch = await prepareShell({ directory: root, nonce: 'windows-test', home: root, shell: path.join(root, 'pwsh.exe'), env: { PATH: root }, platform: 'win32' });
  assert(launch.args.includes('-NoExit'));
  assert(launch.args.includes('-EncodedCommand'));
  assert(!launch.args.includes('-NoProfile'));
  assert(!launch.args.includes('-ExecutionPolicy'));
  const script = Buffer.from(launch.args[launch.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.equal(script, await fs.readFile(path.join(root, 'prompt.ps1'), 'utf8'));
  assert(script.includes('windows-test;ready;'));
  assert(script.includes('__mullion_firstPrompt'));
  assert(script.includes('Import-Module PSReadLine -ErrorAction Stop'));
  assert(script.includes("Set-PSReadLineKeyHandler -Chord 'Ctrl+e' -Function EndOfLine"));
  assert(script.includes("Set-PSReadLineKeyHandler -Chord 'Ctrl+u' -Function BackwardDeleteInput"));
  // Windows PowerShell 5.1 ships PSReadLine 2.0, which only has BackwardDeleteLine.
  assert(script.includes("Set-PSReadLineKeyHandler -Chord 'Ctrl+u' -Function BackwardDeleteLine"));
  assert(script.includes('Set-PSReadLineOption -PredictionSource None'));
  assert(script.includes('$global:__mullion_navigation_available;$mullionStatus'));
  assert(script.includes('} catch {'));
  assert(script.includes("$mullionParts[-3..-1] -join '\\'"), 'PowerShell shows the last three path parts in the prompt');
  assert(script.includes('"$mullionName $mullionArrow "'), 'the path, then ❯ (each colored only when a color is chosen)');
  assert(!script.includes('__mullion_previousPrompt'));
  // Function-key chords: a Ctrl+letter chord breaks once ConPTY and PowerShell disagree on the keyboard layout.
  assert(script.includes("Set-PSReadLineKeyHandler -Chord 'Ctrl+Alt+Shift+F12' -ScriptBlock { __mullion_navigate }"));
  assert(script.includes("Set-PSReadLineKeyHandler -Chord 'Ctrl+Alt+Shift+F11' -Function RevertLine"));
  assert(!script.includes('Ctrl+x,Ctrl+g'), 'Ctrl+X stays bound to Cut');
  assert.equal(launch.navigationSequence, '\x1b[24;8~');
  assert.equal(launch.lineReset, '\x1b[23;8~');
  assert(script.includes('Microsoft.PowerShell.Management\\Set-Location -LiteralPath $mullionFields[1]'));
  assert(script.includes('[Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt()'));
  assert(script.includes('.Split([char]0)'));
});

test('local history serializes concurrent updates, persists preferences and pin state', async t => {
  const root = await temporary(t);
  let now = 100;
  const store = new LocalStore(root, () => ++now);
  const first = await store.load();
  assert.deepEqual(first.history, []);
  assert.equal(first.settings.autoComplete, true);
  await Promise.all(Array.from({ length: 20 }, () => store.record('git status', '/work')));
  await store.record('npm run build', '/work');
  await store.pin('git status', true);
  await store.saveSettings({ ...first.settings, autoComplete: false, theme: 'light', fontSize: 16 });
  const restored = new LocalStore(root);
  const snapshot = await restored.load();
  assert.equal(snapshot.history[0].command, 'git status');
  assert.equal(snapshot.history[0].count, 20);
  assert.equal(snapshot.history[0].pinned, true);
  assert.equal(snapshot.settings.autoComplete, false);
  assert.equal(snapshot.settings.theme, 'light');
  assert.equal(snapshot.settings.fontSize, 16);
  assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
  snapshot.history[0].count = 1000;
  assert.equal(restored.snapshot().history[0].count, 20);
  await restored.clear();
  assert.deepEqual((await new LocalStore(root).load()).history, []);
});

test('store.deleteCommand() removes an entry, persists it, and is a no-op for an unknown command', async t => {
  const root = await temporary(t);
  const store = new LocalStore(root);
  await store.load();
  await store.record('git status', '/work');
  await store.record('npm run build', '/work');
  const afterDelete = await store.deleteCommand('git status');
  assert.deepEqual(afterDelete.map(entry => entry.command), ['npm run build']);
  const restored = await new LocalStore(root).load();
  assert.deepEqual(restored.history.map(entry => entry.command), ['npm run build']);
  // Deleting a command that was never learned, or already removed, changes nothing.
  const unchanged = await store.deleteCommand('does not exist');
  assert.deepEqual(unchanged.map(entry => entry.command), ['npm run build']);
});

test('store.restoreCommand() re-inserts a deleted entry with its original fields, and is a no-op if it is already present', async t => {
  const root = await temporary(t);
  let now = 100;
  const store = new LocalStore(root, () => ++now);
  await store.load();
  await store.record('git status', '/work');
  await store.pin('git status', true);
  const deleted = (await store.load()).history.find(entry => entry.command === 'git status');
  await store.deleteCommand('git status');
  assert.deepEqual((await store.load()).history, []);
  const restored = await store.restoreCommand(deleted);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].command, 'git status');
  assert.equal(restored[0].count, deleted.count);
  assert.equal(restored[0].lastUsed, deleted.lastUsed);
  assert.equal(restored[0].cwd, deleted.cwd);
  assert.equal(restored[0].pinned, true);
  // Restoring again (e.g. a stale undo toast) is a no-op rather than duplicating the entry.
  const again = await store.restoreCommand({ ...deleted, count: 999 });
  assert.equal(again.length, 1);
  assert.equal(again[0].count, deleted.count);
  await assert.rejects(() => store.restoreCommand({ command: '' }));
  await assert.rejects(() => store.restoreCommand({ command: "builtin cd -- '/tmp'" }));
});

test('store.record() refuses to persist app-injected navigation and internal hooks', async t => {
  const root = await temporary(t);
  const store = new LocalStore(root);
  await store.load();
  await store.record("builtin cd -- '/Users/test/Projects'", '/Users/test');
  await store.record("Set-Location -LiteralPath 'C:\\Projects'", 'C:\\');
  await store.record('__mullion_apply_navigation', '/tmp');
  const afterInjected = await store.record('git status', '/work'); // A real command still records normally.
  assert.deepEqual(afterInjected.map(entry => entry.command), ['git status']);
});

test('store.load() purges already-persisted app-injected navigation from an older release', async t => {
  const root = await temporary(t);
  await fs.mkdir(root, { recursive: true });
  const polluted = {
    version: 1,
    settings: {},
    history: [
      { command: 'git status', count: 3, lastUsed: 10, cwd: '/work', pinned: false },
      { command: "builtin cd -- '/Users/test/Projects'", count: 9, lastUsed: 20, cwd: '/Users/test', pinned: false },
      { command: "Set-Location -LiteralPath 'C:\\Projects'", count: 4, lastUsed: 15, cwd: 'C:\\', pinned: false },
    ],
  };
  await fs.writeFile(path.join(root, 'preferences.json'), JSON.stringify(polluted));
  const snapshot = await new LocalStore(root).load();
  assert.deepEqual(snapshot.history.map(entry => entry.command), ['git status']);
});

test('history limits favor pinned entries and discard malformed persisted commands', () => {
  const records = Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => ({ command: `command ${index}`, lastUsed: index + 1, count: 1, cwd: '/tmp', pinned: index === 0 }));
  records.push({ command: 'bad\ncommand', count: 1, lastUsed: 99999 });
  records.push({ command: "builtin cd -- '/tmp'", count: 1, lastUsed: 99998 });
  const history = normalizeHistory(records);
  assert.equal(history.length, HISTORY_LIMIT);
  assert(!history.some(entry => entry.command.startsWith('builtin')));
  assert.equal(history[0].command, 'command 0');
  assert(!history.some(entry => entry.command.includes('\n')));
});

test('zsh integration preserves user configuration and reports cwd after typed cd', { skip: process.platform === 'win32' }, async t => {
  try { await fs.access('/bin/zsh'); } catch { t.skip('zsh is not installed'); return; }
  const root = await temporary(t);
  const home = path.join(await fs.realpath(root), 'home');
  const destination = path.join(await fs.realpath(root), "folder with ' quote");
  await fs.mkdir(home);
  await fs.mkdir(destination);
  const nativeRc = 'export MULLION_TEST_CONFIG=preserved\n';
  await fs.writeFile(path.join(home, '.zshrc'), nativeRc);
  const env = { ...defaultEnvironment(home) };
  delete env.ZDOTDIR;
  const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'integration-test', home, shell: '/bin/zsh', env });
  const child = spawn(launch.shell, launch.args, { cwd: home, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const parser = new PromptParser('integration-test', prompt => {
    if (prompt.ready && prompt.cwd === home && !submitted) {
      submitted = true;
      child.stdin.write(`${directoryCommand(destination)}; printf 'CONFIG:%s\\n' "$MULLION_TEST_CONFIG"\n`);
    }
    if (prompt.ready && prompt.cwd === destination) completePrompt();
  });
  let submitted = false;
  let visible = '';
  const recorded = [];
  parser.onCommand = command => recorded.push(command);
  let completePrompt;
  const completion = new Promise(resolve => { completePrompt = resolve; });
  child.stdout.on('data', data => { visible += parser.feed(data.toString()); });
  child.stderr.on('data', data => { visible += parser.feed(data.toString()); });
  let timeout;
  try {
    await Promise.race([completion, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Shell prompt did not report cwd: ${visible}`)), 5000); })]);
  } finally { clearTimeout(timeout); child.kill('SIGKILL'); }
  assert(visible.includes('CONFIG:preserved'), visible);
  const plain = visible.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert(plain.includes('home ❯ '), plain);
  assert.equal(recorded.length, 1);
  assert(recorded[0].startsWith('builtin cd -- '));
  assert.equal(await fs.readFile(path.join(home, '.zshrc'), 'utf8'), nativeRc);
});

test('bash integration preserves rc/prompt command and learns the executed native history entry', { skip: process.platform === 'win32' }, async t => {
  try { await fs.access('/bin/bash'); } catch { t.skip('bash is not installed'); return; }
  const root = await temporary(t);
  const home = await fs.realpath(root);
  const rc = 'export MULLION_TEST_CONFIG=bash-preserved\nHISTCONTROL=ignoreboth\nPROMPT_COMMAND=\'printf "OLD-PROMPT\\n"\'\n';
  await fs.writeFile(path.join(home, '.bashrc'), rc);
  const env = { ...defaultEnvironment(home), HISTFILE: path.join(home, 'empty-history') };
  const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'bash-test', home, shell: '/bin/bash', env, platform: 'linux' });
  const child = spawn(launch.shell, launch.args, { cwd: home, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let visible = '';
  let prompts = 0;
  let finish;
  const commands = [];
  const records = [];
  const submission = new SubmissionTracker(command => records.push(command));
  const submitted = 'printf "CONFIG:%s\\n" "$MULLION_TEST_CONFIG"';
  const completion = new Promise(resolve => { finish = resolve; });
  const parser = new PromptParser('bash-test', prompt => {
    if (!prompt.ready) return;
    submission.finish();
    prompts++;
    if (prompts === 1 || prompts === 2) { submission.submit(submitted); child.stdin.write(`${submitted}\n`); }
    if (prompts === 3) finish();
  }, command => { commands.push(command); submission.hook(command); });
  child.stdout.on('data', data => { visible += parser.feed(data.toString()); });
  child.stderr.on('data', data => { visible += parser.feed(data.toString()); });
  let timer;
  try {
    await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No bash prompt: ${visible}`)), 5000); })]);
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
  assert(visible.includes('CONFIG:bash-preserved'), visible);
  assert(visible.includes('OLD-PROMPT'), visible);
  const plain = visible.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert(plain.includes('❯ '), plain);
  assert(/\S+ ❯ /.test(plain), 'Bash shows the working directory (last three parts at most) before the prompt arrow');
  assert.deepEqual(commands, ['printf "CONFIG:%s\\n" "$MULLION_TEST_CONFIG"']);
  assert.deepEqual(records, [submitted, submitted]);
  assert.equal(await fs.readFile(path.join(home, '.bashrc'), 'utf8'), rc);
});

test('store.recordDirectory() records a visited directory, bumps its count on revisits, and normalizes trailing slashes', async t => {
  const root = await temporary(t);
  let now = 100;
  const store = new LocalStore(root, () => ++now, { platform: 'linux', home: '/home/user' });
  await store.load();
  await store.recordDirectory('/home/user/Work/Projects');
  await store.recordDirectory('/home/user/Work/Projects/'); // Trailing slash: the same directory.
  const directories = (await store.load()).directories;
  assert.equal(directories.length, 1);
  assert.equal(directories[0].path, '/home/user/Work/Projects');
  assert.equal(directories[0].count, 2);
});

test('store.recordDirectory() ignores the home directory, the filesystem root, and scratch/temp directories', async t => {
  const root = await temporary(t);
  const store = new LocalStore(root, Date.now, { platform: 'linux', home: '/home/user' });
  await store.load();
  await store.recordDirectory('/home/user');
  await store.recordDirectory('/home/user/');
  await store.recordDirectory('/');
  await store.recordDirectory('/tmp/mullion-terminal-abc123');
  await store.recordDirectory('/private/var/folders/xy/abc/T');
  assert.deepEqual((await store.load()).directories, []);
  // A real visit still records normally.
  await store.recordDirectory('/home/user/Work');
  assert.equal((await store.load()).directories.length, 1);
});

test('store.recordDirectory() compares case-insensitively on darwin and win32, case-sensitively elsewhere', async t => {
  const darwinRoot = await temporary(t);
  const darwinStore = new LocalStore(darwinRoot, Date.now, { platform: 'darwin', home: '/Users/test' });
  await darwinStore.load();
  await darwinStore.recordDirectory('/Users/test/Work');
  await darwinStore.recordDirectory('/users/test/WORK');
  assert.equal((await darwinStore.load()).directories.length, 1);
  assert.equal((await darwinStore.load()).directories[0].count, 2);

  const windowsRoot = await temporary(t);
  const windowsStore = new LocalStore(windowsRoot, Date.now, { platform: 'win32', home: 'C:\\Users\\test' });
  await windowsStore.load();
  await windowsStore.recordDirectory('C:\\Projects\\App');
  await windowsStore.recordDirectory('c:\\projects\\app\\');
  assert.equal((await windowsStore.load()).directories.length, 1);

  const linuxRoot = await temporary(t);
  const linuxStore = new LocalStore(linuxRoot, Date.now, { platform: 'linux', home: '/home/test' });
  await linuxStore.load();
  await linuxStore.recordDirectory('/home/test/Work');
  await linuxStore.recordDirectory('/home/test/WORK');
  assert.equal((await linuxStore.load()).directories.length, 2);
});

test('store.recordDirectory() persists across reload alongside history', async t => {
  const root = await temporary(t);
  const store = new LocalStore(root, Date.now, { platform: 'linux', home: '/home/test' });
  await store.load();
  await store.recordDirectory('/home/test/Work/Projects');
  await store.record('git status', '/home/test/Work/Projects');
  const restored = new LocalStore(root, Date.now, { platform: 'linux', home: '/home/test' });
  const snapshot = await restored.load();
  assert.deepEqual(snapshot.directories.map(entry => entry.path), ['/home/test/Work/Projects']);
  assert.deepEqual(snapshot.history.map(entry => entry.command), ['git status']);
  assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
});

test('normalizeDirectories ignores malformed entries, filters the home directory and root, and enforces the cap', () => {
  const malformed = [
    { path: '' }, { path: 123 }, { path: 'bad\npath' }, null, undefined, 'not-an-object',
    { path: '/home/test' }, { path: '/home/test/' }, { path: '/' },
  ];
  assert.deepEqual(normalizeDirectories(malformed, 'linux', '/home/test'), []);
  const many = Array.from({ length: DIRECTORIES_LIMIT + 5 }, (_, index) => ({ path: `/data/dir-${index}`, count: 1, lastUsed: index + 1 }));
  assert.equal(normalizeDirectories(many, 'linux', '/home/test').length, DIRECTORIES_LIMIT);
  // The most recently used entries survive the cap.
  const survivors = normalizeDirectories(many, 'linux', '/home/test').map(entry => entry.path);
  assert(survivors.includes(`/data/dir-${DIRECTORIES_LIMIT + 4}`));
  assert(!survivors.includes('/data/dir-0'));
});

test('abbreviateHome shortens a path under home to `~`, case-insensitively on darwin/win32', () => {
  assert.equal(abbreviateHome('/Users/test', '/Users/test', 'darwin'), '~');
  assert.equal(abbreviateHome('/Users/test/Work/Projects', '/Users/test', 'darwin'), '~/Work/Projects');
  assert.equal(abbreviateHome('/USERS/TEST/work', '/Users/test', 'darwin'), '~/work');
  assert.equal(abbreviateHome('/Volumes/other', '/Users/test', 'darwin'), '/Volumes/other');
  assert.equal(abbreviateHome('C:\\Users\\test\\Work', 'C:\\Users\\test', 'win32'), '~\\Work');
  assert.equal(abbreviateHome('/home/test/Work', '/home/test', 'linux'), '~/Work');
  assert.equal(abbreviateHome('/HOME/TEST/Work', '/home/test', 'linux'), '/HOME/TEST/Work');
});

test('visitedDirectoryCandidates matches absolute and `~`-prefixed path prefixes, excludes cwd, and ranks by frequency/recency', () => {
  const now = Date.now();
  const visitedDirectories = [
    { path: '/Volumes/anabil/Work/Projects', count: 10, lastUsed: now },
    { path: '/Volumes/anabil/Work/Old', count: 1, lastUsed: now - 100 * 86_400_000 },
    { path: '/Volumes/anabil', count: 5, lastUsed: now },
  ];
  const absolute = visitedDirectoryCandidates({ raw: '/Vol', commandName: 'cd', cwd: '/elsewhere', home: '/Users/test', platform: 'darwin', visitedDirectories });
  assert.deepEqual(absolute.map(c => c.insert), ['/Volumes/anabil/Work/Projects/', '/Volumes/anabil/', '/Volumes/anabil/Work/Old/']);

  const tilde = visitedDirectoryCandidates({ raw: '~/Wo', commandName: 'cd', cwd: '/elsewhere', home: '/Volumes/anabil', platform: 'darwin', visitedDirectories });
  assert.deepEqual(tilde.map(c => c.label), ['~/Work/Projects', '~/Work/Old']);

  // Never suggest the directory the session is already in.
  const excludesCwd = visitedDirectoryCandidates({ raw: '/Vol', commandName: 'cd', cwd: '/Volumes/anabil/Work/Projects', home: '/Users/test', platform: 'darwin', visitedDirectories });
  assert(!excludesCwd.some(c => c.insert.startsWith('/Volumes/anabil/Work/Projects/')));

  // Case-insensitive on darwin.
  const caseInsensitive = visitedDirectoryCandidates({ raw: '/VOL', commandName: 'cd', cwd: '/elsewhere', home: '/Users/test', platform: 'darwin', visitedDirectories });
  assert.equal(caseInsensitive.length, 3);
});

test('visitedDirectoryCandidates offers a bare directory name (no slash) by basename, for cd-like commands only, and respects a files-only policy', () => {
  const visitedDirectories = [{ path: '/Volumes/anabil/Work/Projects/Alpha', count: 2, lastUsed: Date.now() }];
  const cd = visitedDirectoryCandidates({ raw: 'Al', commandName: 'cd', cwd: '/elsewhere', home: '/Users/test', platform: 'darwin', visitedDirectories });
  assert.equal(cd.length, 1);
  assert.equal(cd[0].label, '/Volumes/anabil/Work/Projects/Alpha');
  // Not offered for a command that isn't a directory-changing one.
  const cat = visitedDirectoryCandidates({ raw: 'Al', commandName: 'cat', cwd: '/elsewhere', home: '/Users/test', platform: 'darwin', visitedDirectories });
  assert.deepEqual(cat, []);
  // Or for a command whose policy only wants files.
  const withFilesPolicy = visitedDirectoryCandidates({ raw: 'Al', commandName: 'cd', cwd: '/elsewhere', home: '/Users/test', platform: 'darwin', visitedDirectories, policy: { directories: false, files: true } });
  assert.deepEqual(withFilesPolicy, []);
});

test('visitedDirectoryCandidates suppresses every bare-name basename match once a live sibling of cwd matches the same token (regression: `cd Projec` + Tab must never jump to an absolute visited path)', () => {
  const now = Date.now();
  const cwd = '/Volumes/anabil/Work';
  const visitedDirectories = [
    { path: '/Volumes/anabil/Work/Projects', count: 10, lastUsed: now },
    { path: '/Volumes/elsewhere/Projections', count: 3, lastUsed: now },
  ];
  // A live child of cwd ("Projects") matches the bare token: every basename-matched visited
  // candidate is suppressed outright, including the one that happens to be that very child —
  // the relative candidate from the live filesystem is what must be offered instead.
  const withLiveMatch = visitedDirectoryCandidates({
    raw: 'Projec', commandName: 'cd', cwd, home: '/Users/test', platform: 'darwin', visitedDirectories, hasLiveDirectoryMatch: true,
  });
  assert.deepEqual(withLiveMatch, []);
  // Without a live sibling match (e.g. the token's only match is several levels deep, as in
  // the "offers a bare directory name" test above), basename matches still surface normally —
  // including one that happens to live under cwd — since there's no live relative candidate to
  // be shadowed by it.
  const withoutLiveMatch = visitedDirectoryCandidates({
    raw: 'Projec', commandName: 'cd', cwd, home: '/Users/test', platform: 'darwin', visitedDirectories, hasLiveDirectoryMatch: false,
  });
  assert.deepEqual(withoutLiveMatch.map(c => c.label).sort(), ['/Volumes/anabil/Work/Projects', '/Volumes/elsewhere/Projections'].sort());
});

test('complete() never offers a visited directory for a bare cd token when cwd already has a matching real child (regression: `cd Projec` + Tab must yield the relative "Projects/", not an absolute visited path)', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'Projects'));
  const decoyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-decoy-'));
  t.after(() => fs.rm(decoyRoot, { recursive: true, force: true }));
  const visitedDirectories = [
    { path: path.join(root, 'Projects'), count: 10, lastUsed: Date.now() },
    { path: path.join(decoyRoot, 'Projections'), count: 3, lastUsed: Date.now() },
  ];
  const candidates = await complete({ line: 'cd Projec', cwd: root, platform: process.platform, environmentPath: '', home: root, visitedDirectories });
  assert(!candidates.some(c => c.detail?.startsWith('Visited')), JSON.stringify(candidates));
  assert.deepEqual(candidates.map(c => c.value), [`cd ${quoteToken(`Projects${path.sep}`, process.platform)}`]);
});

test('complete() merges matching visited directories, quoting paths with spaces exactly like live filesystem candidates', async t => {
  const root = await temporary(t);
  const elsewhereRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-visited-'));
  t.after(() => fs.rm(elsewhereRoot, { recursive: true, force: true }));
  const visited = path.join(elsewhereRoot, 'Old Projects');
  const visitedDirectories = [{ path: visited, count: 7, lastUsed: Date.now() }];
  const candidates = await complete({ line: `cd ${elsewhereRoot}${path.sep}Old`, cwd: root, platform: process.platform, environmentPath: '', home: root, visitedDirectories });
  const match = candidates.find(candidate => candidate.detail === 'Visited 7×');
  assert(match, JSON.stringify(candidates));
  assert.equal(match.kind, 'directory');
  assert.equal(match.value, `cd ${quoteToken(`${visited}${path.sep}`, process.platform)}`);
});

test('openWithTarget defaults to a new tab and only ever holds tab or window', () => {
  const { normalizeSettings, DEFAULT_SETTINGS } = require('../electron/store.cjs');
  assert.equal(DEFAULT_SETTINGS.openWithTarget, 'tab');
  assert.equal(normalizeSettings({}).openWithTarget, 'tab');
  assert.equal(normalizeSettings({ openWithTarget: 'window' }).openWithTarget, 'window');
  assert.equal(normalizeSettings({ openWithTarget: 'split' }).openWithTarget, 'tab');
  assert.equal(normalizeSettings({ openWithTarget: 1 }).openWithTarget, 'tab');
});
