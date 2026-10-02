import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frequentCommands, inlineCompletion, isBasicCommand, isInjectedCommand, isTrivialCommand, rankSuggestions } from '../src/completion';
import type { CompletionCandidate, HistoryEntry } from '../src/types';

const recent = Date.now();
const historyEntry = (command: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  command, count: 1, lastUsed: recent, cwd: '/work', pinned: false, ...overrides,
});
const candidate = (value: string, kind: CompletionCandidate['kind'] = 'command'): CompletionCandidate => ({
  value, label: value, kind,
});

test('learned command prefixes rank above PATH hints and are deduplicated', () => {
  const result = rankSuggestions('git s', [historyEntry('git status', { count: 8 })], [
    candidate('git status'), candidate('git show'),
  ], '/work');
  assert.equal(result[0].value, 'git status');
  assert.equal(result[0].kind, 'history');
  assert.equal(result.filter(item => item.value === 'git status').length, 1);
});

test('pinned, frequency, recency and current directory each improve history ranking', () => {
  const cases: [HistoryEntry, HistoryEntry][] = [
    [historyEntry('git a', { count: 1, pinned: true }), historyEntry('git b', { count: 100 })],
    [historyEntry('git a', { count: 20 }), historyEntry('git b', { count: 1 })],
    [historyEntry('git a'), historyEntry('git b', { lastUsed: recent - 100 * 86_400_000 })],
    [historyEntry('git a'), historyEntry('git b', { cwd: '/elsewhere' })],
  ];
  for (const entries of cases) assert.equal(rankSuggestions('git ', entries, [], '/work')[0].value, 'git a');
});

test('matching excludes exact values, case mismatches and fuzzy matches', () => {
  const result = rankSuggestions('git st', [historyEntry('git status'), historyEntry('git stash')], [
    candidate('git st'), candidate('git switch'), candidate('Git status'),
  ], '/work');
  assert.deepEqual(result.map(item => item.value).sort(), ['git stash', 'git status']);
  assert.deepEqual(rankSuggestions('git status', [historyEntry('git status')], [candidate('git status ')], '/work'), []);
});

test('filesystem candidates preserve full backend replacements and support quoting', () => {
  const result = rankSuggestions('cd Doc', [], [
    candidate("cd 'Documents Work/'", 'directory'),
    candidate('cd Documents/', 'directory'),
    candidate('cd Downloads/', 'directory'),
    candidate("ls 'Documents Work/'", 'directory'),
  ], '/work');
  assert.deepEqual(result.map(item => item.value).sort(), ["cd 'Documents Work/'", 'cd Documents/']);
  assert.deepEqual(rankSuggestions('cd ', [], [candidate('cd Documents/', 'directory')], '/work'), []);
});

test('rankSuggestions never offers a learned cd/pushd/Set-Location history entry, but live directory completion for cd still works', () => {
  const history = [
    historyEntry('cd /Volumes/anabil/Work/Projects', { count: 50 }),
    historyEntry('pushd /tmp', { count: 50 }),
    historyEntry('Set-Location C:\\Projects', { count: 50 }),
    historyEntry('sl C:\\Projects', { count: 50 }),
    historyEntry('chdir ..', { count: 50 }),
    historyEntry('git status', { count: 1 }),
  ];
  assert.deepEqual(rankSuggestions('cd /Vol', history, [], '/work').map(item => item.kind), []);
  assert.deepEqual(rankSuggestions('pushd /t', history, [], '/work'), []);
  assert.deepEqual(rankSuggestions('Set-Location C:\\Pro', history, [], '/work', 8, 'win32').map(item => item.value), []);
  // A directory candidate from the live filesystem is a separate, still-supported feature.
  const folder = candidate("cd 'Volumes/anabil/Work/'", 'directory');
  assert.equal(rankSuggestions('cd Vol', history, [folder], '/work')[0].value, folder.value);
  // Unrelated learned commands are unaffected.
  assert.equal(rankSuggestions('git s', history, [], '/work')[0].value, 'git status');
});

test('escaped and partially quoted path tokens use prefix matching', () => {
  assert.equal(rankSuggestions('cat My\\ Fi', [], [candidate("cat 'My File.txt'", 'file')], '/work')[0].value, "cat 'My File.txt'");
  assert.equal(rankSuggestions("cd 'Doc", [], [candidate("cd 'Documents Work/'", 'directory')], '/work')[0].value, "cd 'Documents Work/'");
});

test('frequent commands combine real usage across directories, honor pins, and exclude basic/system and navigation commands', () => {
  const entries = [
    historyEntry('npm run build', { count: 5, cwd: '/one', lastUsed: recent - 1 }),
    historyEntry('npm run build', { count: 7, cwd: '/two' }),
    historyEntry('git push', { pinned: true }),
    historyEntry('git status', { count: 8 }),
    historyEntry('ls', { count: 50 }),
    historyEntry('pwd', { count: 50 }),
    historyEntry('cd src', { count: 50 }),
    historyEntry('rm test', { count: 50 }),
    historyEntry("nano 'CHANGELOG.md'", { count: 50 }),
    historyEntry('arch', { count: 50 }),
    historyEntry("builtin cd -- '/tmp'", { count: 50 }),
  ];
  const result = frequentCommands(entries, 3);
  assert.equal(result[0].command, 'git push');
  assert.deepEqual(result[1], historyEntry('npm run build', { count: 12, cwd: '/two' }));
  assert.equal(result[2].command, 'git status');
  assert(!result.some(entry => ['ls', 'pwd', 'cd src', 'rm test', "nano 'CHANGELOG.md'", 'arch', "builtin cd -- '/tmp'"].includes(entry.command)));
  assert.deepEqual(frequentCommands([]), []);
});

test('frequent commands and the history sidebar would show nothing but the hint for an all-basic/garbage history', () => {
  // The exact shape of a real user's history that is nothing but routine shell use and a typo.
  const entries = [
    historyEntry('clear', { count: 8 }),
    historyEntry('nano test', { count: 5 }),
    historyEntry("nano 'CHANGELOG.md'", { count: 3 }),
    historyEntry('rm test', { count: 2 }),
    historyEntry('cd Terminal/', { count: 2 }),
    historyEntry('cd /Volumes/anabil/Work', { count: 2 }),
    historyEntry('cd', { count: 2 }),
    historyEntry("nano 'Downloads/notes.docx'", { count: 1 }),
    historyEntry('arch', { count: 1 }),
    historyEntry('cd ../', { count: 1 }),
    historyEntry('ls', { count: 1 }),
    historyEntry('مس', { count: 1 }),
    historyEntry('cd ../Cleaner/', { count: 1 }),
  ];
  assert.deepEqual(frequentCommands(entries), []);
  assert(entries.every(entry => isBasicCommand(entry.command)));
});

test('isInjectedCommand recognizes app-typed navigation and internal hooks, never a real user command', () => {
  assert(isInjectedCommand("builtin cd -- '/Users/test/Projects'"));
  assert(isInjectedCommand("Set-Location -LiteralPath 'C:\\Projects'"));
  assert(isInjectedCommand('set-location -literalpath /tmp'));
  assert(isInjectedCommand('__mullion_apply_navigation'));
  assert(!isInjectedCommand('cd /Users/test/Projects'));
  assert(!isInjectedCommand('echo builtin is a bash keyword'));
});

test('isBasicCommand hides basic/system commands in every supported shell dialect regardless of arguments', () => {
  for (const command of [
    'cd', 'cd ..', 'cd Documents', 'pushd /tmp', 'popd',
    'ls', 'll', 'la', 'l', 'll -la', 'ls -la Documents', 'dir /Force',
    'pwd', 'clear', 'cls', 'reset', 'exit', 'logout', 'history', '..', '~',
    'rm test', 'rm -rf /tmp/x', 'rmdir old', 'mv a b', 'cp a b', 'mkdir new', 'touch file.txt',
    "cat 'CHANGELOG.md'", 'less file', 'more file', 'head -n 5 file', 'tail file',
    'open .', 'xdg-open .', 'start .', 'explorer .',
    "nano test", "nano 'CHANGELOG.md'", 'rnano file', 'pico file', 'vi file', 'vim file', 'nvim file', 'view file', 'emacs file',
    'echo hi', 'printf "%s" hi', 'arch', 'uname -a', 'whoami', 'hostname', 'date', 'cal',
    'which node', 'where node', 'type node', 'man ls', 'help cd',
    'chmod +x run.sh', 'chown me file', 'ln -s a b', 'file a', 'stat a', 'du -sh .', 'df -h', 'tree', 'sleep 1', 'true', 'false',
    'Set-Location C:\\Work', 'sl ..', 'chdir ..', 'Get-Location', 'gl', 'Get-ChildItem', 'gci', 'dir',
    'Remove-Item a', 'ri a', 'del a', 'erase a', 'Move-Item a b', 'mi a b', 'move a b',
    'Copy-Item a b', 'ci a b', 'copy a b', 'New-Item a', 'ni a', 'md a', 'Get-Content a', 'gc a',
    'Clear-Host', 'Write-Output hi', 'Write-Host hi',
    "builtin cd -- '/tmp'",
    // Leading env assignments and sudo/command/builtin wrappers don't change the verdict.
    'FOO=1 BAR=2 nano file', 'sudo rm -rf /tmp/x', 'command ls', 'sudo cat file',
    // A single mistyped, non-ASCII token (e.g. a "command not found" typo) is noise, not a command.
    'مس',
  ]) {
    assert(isBasicCommand(command), `${command} should be a basic command`);
  }
  for (const command of ['npm run build', 'git status', 'curl example.com', 'docker ps', 'make', 'python script.py', 'node index.js', 'brew install git', 'ssh host', 'pnpm install', 'yarn build', 'composer install', 'php artisan serve', 'مس test']) {
    assert(!isBasicCommand(command), `${command} should not be a basic command`);
  }
  // The old name is kept as an alias so existing call sites keep working.
  assert.equal(isTrivialCommand, isBasicCommand);
});

test('starter hints work before learning and never become frequent commands', () => {
  const result = rankSuggestions('mk', [], [], '/work');
  assert.equal(result[0].value, 'mkdir');
  assert.equal(result[0].kind, 'command');
  assert.ok(result[0].detail);
  assert.deepEqual(rankSuggestions('git mk', [], [], '/work'), []);
  assert.deepEqual(rankSuggestions('', [historyEntry('ls')], [], '/work'), []);
});

test('malformed and multiline values cannot become accepted command suggestions', () => {
  assert.deepEqual(rankSuggestions('git', [historyEntry('git status\nrm -rf /')], [candidate('git\rstatus')], '/work'), []);
  assert.deepEqual(rankSuggestions('git\n', [historyEntry('git status')], [], '/work'), []);
  assert.deepEqual(rankSuggestions('git', [historyEntry('git status')], [], '/work', 0), []);
});

test('Windows matches PowerShell command and learned prefixes without changing replacement spelling', () => {
  const result = rankSuggestions('get-ch', [historyEntry('Get-ChildItem -Hidden', {
    cwd: 'C:\\Work', count: 4,
  })], [candidate('Get-ChildItem')], 'c:\\work', 8, 'win32');
  assert.equal(result[0].value, 'Get-ChildItem -Hidden');
  assert.equal(result[0].kind, 'history');
  assert.ok(result[0].detail?.includes('here'));
  assert(!result[0].detail?.toLowerCase().includes('builtin'));
  assert.equal(result[1].value, 'Get-ChildItem');
  assert.deepEqual(rankSuggestions('GET-CHILDITEM', [], [candidate('Get-ChildItem')], 'C:\\Work', 8, 'win32'), []);
});

test('Windows paths retain backslashes and match quoted backend replacements', () => {
  const result = rankSuggestions('cd C:\\Pro', [], [
    candidate("cd 'C:\\Program Files\\'", 'directory'),
    candidate("cd 'C:\\Projects\\'", 'directory'),
    candidate("cd 'C:\\Pictures\\'", 'directory'),
  ], 'C:\\Work', 8, 'win32');
  assert.deepEqual(result.map(item => item.value).sort(), ["cd 'C:\\Program Files\\'", "cd 'C:\\Projects\\'"]);
});

test('Windows PowerShell backticks and doubled quotes decode only for matching', () => {
  assert.equal(rankSuggestions('cat C:\\My` Fi', [], [
    candidate("cat 'C:\\My File.txt'", 'file'),
  ], 'C:\\Work', 8, 'win32')[0].value, "cat 'C:\\My File.txt'");
  assert.equal(rankSuggestions("cat 'C:\\John''s Re", [], [
    candidate("cat 'C:\\John''s Report.txt'", 'file'),
  ], 'C:\\Work', 8, 'win32')[0].value, "cat 'C:\\John''s Report.txt'");
});

test('inline hints display only the missing command or safely quoted path suffix', () => {
  assert.equal(inlineCompletion('git st', candidate('git status', 'history')), 'atus');
  assert.equal(inlineCompletion('cd Doc', candidate("cd 'Documents Work/'", 'directory')), 'uments Work/');
  assert.equal(inlineCompletion("cd 'Doc", candidate("cd 'Documents Work/'", 'directory')), "uments Work/'");
  assert.equal(inlineCompletion('cat My\\ Fi', candidate("cat 'My File.txt'", 'file')), 'le.txt');
  assert.equal(inlineCompletion('cd ~/Doc', { value: 'cd /Users/test/Documents/', label: 'Documents/', kind: 'directory' }), 'uments/');
  assert.equal(inlineCompletion('get-ch', candidate('Get-ChildItem'), 'win32'), 'ildItem');
  assert.equal(inlineCompletion('cd C:\\Pro', candidate("cd 'C:\\Program Files\\'", 'directory'), 'win32'), 'gram Files\\');
  assert.equal(inlineCompletion('git st', candidate('git log')), '');
});

test('OFF offers empty-history filesystem hints after bare commands and empty arguments; ON does not', () => {
  for (const line of ['cd', 'cd ']) {
    const folder = candidate("cd 'first folder/'", 'directory');
    const off = rankSuggestions(line, [], [folder], '/work', 8, 'linux', false);
    assert.equal(off[0].value, "cd 'first folder/'");
    assert.equal(inlineCompletion(line, off[0]), line === 'cd' ? " 'first folder/'" : "'first folder/'");
    assert.deepEqual(rankSuggestions(line, [], [folder], '/work', 8, 'linux', true), []);
  }
  const file = candidate("rm 'a fixture file.txt'", 'file');
  assert.equal(rankSuggestions('rm ', [], [file], '/work', 8, 'linux', false)[0].value, file.value);
  assert.deepEqual(rankSuggestions('rm ', [], [file], '/work', 8, 'linux', true), []);
  assert.deepEqual(rankSuggestions('git ', [], [candidate('git README.md', 'file')], '/work', 8, 'linux', false), []);
});

test('OFF filesystem hints preserve PowerShell quoting and safe leading-dash replacements', () => {
  const folder = candidate("Set-Location 'C:\\Program Files\\'", 'directory');
  assert.equal(rankSuggestions('set-location', [], [folder], 'C:\\Work', 8, 'win32', false)[0].value, folder.value);
  assert.deepEqual(rankSuggestions('set-location', [], [folder], 'C:\\Work', 8, 'win32', true), []);
  const file = candidate('rm -- ./-notes.txt', 'file');
  assert.equal(rankSuggestions('rm -- -no', [], [file], '/work', 8, 'linux', false)[0].value, file.value);
});

test('OFF exact filesystem commands prioritize operands over coincidental command prefixes', () => {
  const folder = candidate("cd 'first folder/'", 'directory');
  assert.equal(rankSuggestions('cd', [], [candidate('cdist'), folder], '/work', 8, 'linux', false)[0].value, folder.value);
  const file = candidate("rm 'a fixture file.txt'", 'file');
  assert.equal(rankSuggestions('rm', [], [candidate('rmdir'), file], '/work', 8, 'linux', false)[0].value, file.value);
  assert.equal(rankSuggestions('rm', [historyEntry('rm old-file.txt')], [candidate('rmdir'), file], '/work', 8, 'linux', false)[0].kind, 'history');
});
