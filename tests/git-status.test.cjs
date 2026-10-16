'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parsePorcelainCount, parseNumstat, parseForEachRef, createGitStatusService } = require('../electron/git-status.cjs');

function gitAvailable() {
  const result = spawnSync('git', ['--version']);
  return !result.error && result.status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Mullion Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-git-status-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// --- Pure parsers (no git required) ---------------------------------------------------------

test('parsePorcelainCount counts ordinary entries and skips the paired original-path field of a rename', () => {
  const output = ['M  a.txt', '?? b.txt', 'R  new.txt'].join('\0') + '\0old.txt\0';
  assert.equal(parsePorcelainCount(output), 3);
  assert.equal(parsePorcelainCount(''), 0);
});

test('parseNumstat sums added/deleted lines and ignores binary files marked "-"', () => {
  assert.deepEqual(parseNumstat('5\t2\ta.txt\n10\t0\tb.txt\n-\t-\timage.png\n'), { insertions: 15, deletions: 2 });
  assert.deepEqual(parseNumstat(''), { insertions: 0, deletions: 0 });
});

test('parseForEachRef excludes a remote symbolic HEAD and buckets local vs remote, dropping a remote branch that already has a same-named local one', () => {
  const output = [
    ['refs/heads/main', 'main', 'origin/main', '2 days ago'].join('\t'),
    ['refs/heads/feature-b', 'feature-b', '', '1 hour ago'].join('\t'),
    ['refs/remotes/origin/HEAD', 'origin/HEAD', '', ''].join('\t'),
    ['refs/remotes/origin/main', 'origin/main', '', '2 days ago'].join('\t'),
    ['refs/remotes/origin/feature-a', 'origin/feature-a', '', '3 days ago'].join('\t'),
  ].join('\n');
  const { local, remote } = parseForEachRef(output);
  assert.deepEqual(local, [
    { name: 'main', upstream: 'origin/main', lastCommitRelative: '2 days ago' },
    { name: 'feature-b', upstream: undefined, lastCommitRelative: '1 hour ago' },
  ]);
  assert.deepEqual(remote, [{ name: 'origin/feature-a' }]);
});

// --- Real temp git repositories ---------------------------------------------------------------

test('gitStatus() reports the branch, a modified+untracked file count, and line stats for a real repo', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const cwd = await temporary(t);
  git(cwd, ['-c', 'init.defaultBranch=main', 'init']);
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'one\ntwo\nthree\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '-m', 'initial']);
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'one\ntwo\nthree\nfour\n');
  await fs.writeFile(path.join(cwd, 'untracked.txt'), 'new file\n');

  const service = createGitStatusService();
  const status = await service.status(cwd, process.env.PATH);
  assert.equal(status.branch, 'main');
  assert.equal(status.detached, false);
  assert.equal(status.changedFiles, 2, 'One modified tracked file plus one untracked file');
  assert.equal(status.insertions, 1);
  assert.equal(status.deletions, 0);
  assert.equal(status.ahead, undefined);
  assert.equal(status.behind, undefined);
});

test('gitStatus() reports a detached HEAD as "detached @<sha>"', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const cwd = await temporary(t);
  git(cwd, ['-c', 'init.defaultBranch=main', 'init']);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'content\n');
  git(cwd, ['add', 'a.txt']);
  git(cwd, ['commit', '-m', 'initial']);
  const sha = git(cwd, ['rev-parse', '--short', 'HEAD']).trim();
  git(cwd, ['checkout', sha]);

  const service = createGitStatusService();
  const status = await service.status(cwd, process.env.PATH);
  assert.equal(status.detached, true);
  assert.equal(status.branch, `detached @${sha}`);
});

test('gitStatus() on a repository with no commits yet still resolves the branch and diffs staged content against the empty tree', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const cwd = await temporary(t);
  git(cwd, ['-c', 'init.defaultBranch=main', 'init']);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'one\ntwo\n');
  git(cwd, ['add', 'a.txt']);

  const service = createGitStatusService();
  const status = await service.status(cwd, process.env.PATH);
  assert.equal(status.branch, 'main');
  assert.equal(status.changedFiles, 1);
  assert.equal(status.insertions, 2, 'Staged content on an unborn branch diffs against the empty tree');
  assert.equal(status.deletions, 0);
});

test('gitStatus() returns null for a directory that is not a git repository', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const cwd = await temporary(t);
  const service = createGitStatusService();
  assert.equal(await service.status(cwd, process.env.PATH), null);
});

test('gitStatus() returns null rather than throw when git itself is unavailable', async () => {
  const execFileImpl = (_command, _args, _options, callback) => callback(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
  const service = createGitStatusService({ execFileImpl });
  assert.equal(await service.status('/anything', ''), null);
});

test('gitStatus() reports ahead/behind counts against an upstream', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const remote = await temporary(t);
  git(remote, ['init', '--bare', '-b', 'main']);
  const cwd = await temporary(t);
  git(cwd, ['-c', 'init.defaultBranch=main', 'init']);
  git(cwd, ['remote', 'add', 'origin', remote]);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'one\n');
  git(cwd, ['add', 'a.txt']);
  git(cwd, ['commit', '-m', 'first']);
  git(cwd, ['push', '-u', 'origin', 'main']);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'one\ntwo\n');
  git(cwd, ['commit', '-am', 'second']); // One local commit ahead of origin/main.

  const service = createGitStatusService();
  const status = await service.status(cwd, process.env.PATH);
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
});

test('gitBranches() groups local branches (with upstream) first, then remote-only branches, most-recent first', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const remote = await temporary(t);
  git(remote, ['init', '--bare', '-b', 'main']);
  const cwd = await temporary(t);
  git(cwd, ['-c', 'init.defaultBranch=main', 'init']);
  git(cwd, ['remote', 'add', 'origin', remote]);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'one\n');
  git(cwd, ['add', 'a.txt']);
  git(cwd, ['commit', '-m', 'first']);
  git(cwd, ['push', '-u', 'origin', 'main']);

  // feature-a: pushed, then its local branch is deleted — remote-only afterward.
  git(cwd, ['switch', '-c', 'feature-a']);
  await fs.writeFile(path.join(cwd, 'b.txt'), 'two\n');
  git(cwd, ['add', 'b.txt']);
  git(cwd, ['commit', '-m', 'feature-a']);
  git(cwd, ['push', 'origin', 'feature-a']);
  git(cwd, ['switch', 'main']);
  git(cwd, ['branch', '-D', 'feature-a']);

  // feature-b: local only, tracking origin/main.
  git(cwd, ['branch', 'feature-b']);
  git(cwd, ['branch', '--set-upstream-to=origin/main', 'feature-b']);
  git(cwd, ['fetch', 'origin']);

  const service = createGitStatusService();
  const branches = await service.branches(cwd, process.env.PATH);
  assert.equal(branches.current, 'main');
  const localNames = branches.local.map(branch => branch.name).sort();
  assert.deepEqual(localNames, ['feature-b', 'main']);
  assert.equal(branches.local.find(branch => branch.name === 'feature-b').upstream, 'origin/main');
  assert.deepEqual(branches.remote, [{ name: 'origin/feature-a' }], 'origin/main must not be listed again: main already exists locally');
});

test('gitBranches() returns null for a directory that is not a git repository', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const cwd = await temporary(t);
  const service = createGitStatusService();
  assert.equal(await service.branches(cwd, process.env.PATH), null);
});

test('status()/branches() coalesce concurrent calls for the same directory into a single underlying computation', async t => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const cwd = await temporary(t);
  git(cwd, ['-c', 'init.defaultBranch=main', 'init']);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'one\n');
  git(cwd, ['add', 'a.txt']);
  git(cwd, ['commit', '-m', 'first']);

  let calls = 0;
  const { execFile: realExecFile } = require('node:child_process');
  const execFileImpl = (command, args, options, callback) => { if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) calls++; realExecFile(command, args, options, callback); };
  const service = createGitStatusService({ execFileImpl, ttl: 5000 });
  const [first, second] = await Promise.all([service.status(cwd, process.env.PATH), service.status(cwd, process.env.PATH)]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1, 'A second concurrent call for the same directory must reuse the first in-flight computation');
  const third = await service.status(cwd, process.env.PATH);
  assert.equal(calls, 1, 'A call within the TTL must be served from cache, not recomputed');
});
