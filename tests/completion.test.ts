import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frequentCommands, inlineCompletion, rankSuggestions } from '../src/completion';
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

test('escaped and partially quoted path tokens use prefix matching', () => {
  assert.equal(rankSuggestions('cat My\\ Fi', [], [candidate("cat 'My File.txt'", 'file')], '/work')[0].value, "cat 'My File.txt'");
  assert.equal(rankSuggestions("cd 'Doc", [], [candidate("cd 'Documents Work/'", 'directory')], '/work')[0].value, "cd 'Documents Work/'");
});

test('frequent commands combine real usage across directories and honor pins', () => {
  const entries = [
    historyEntry('ls', { count: 5, cwd: '/one', lastUsed: recent - 1 }),
    historyEntry('ls', { count: 7, cwd: '/two' }),
    historyEntry('pwd', { pinned: true }),
    historyEntry('git status', { count: 8 }),
  ];
  const result = frequentCommands(entries, 2);
  assert.equal(result[0].command, 'pwd');
  assert.deepEqual(result[1], historyEntry('ls', { count: 12, cwd: '/two' }));
  assert.deepEqual(frequentCommands([]), []);
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
  assert.ok(result[0].detail?.includes('This directory'));
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
