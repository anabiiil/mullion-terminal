'use strict';

const { execFile } = require('node:child_process');

// A well-known, version-independent empty tree object id (SHA-1). Used as the diff base for a
// repository that has no commits yet (an "unborn" branch), where `HEAD` does not resolve.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function gitBinary(platform = process.platform) {
  return platform === 'win32' ? 'git.exe' : 'git';
}

/** Runs one git subcommand with a bounded timeout and output size, resolving to its stdout. */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'diff.external=', '-c', 'core.pager=cat'];

function run(execFileImpl, platform, args, { cwd, env, timeoutMs = 1500, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    // A repo's own config must never make a status read run its commands.
    execFileImpl(gitBinary(platform), [...SAFE_CONFIG, ...args], { cwd, env, timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(String(stdout));
    });
  });
}

/**
 * Counts changed paths from `git status --porcelain=v1 -z --untracked-files=normal` output,
 * including untracked files. A rename or copy record is followed by a second, unprefixed
 * NUL-terminated field holding the original path — that field is skipped, not counted again.
 */
function parsePorcelainCount(output) {
  if (!output) return 0;
  const tokens = output.split('\0').filter(Boolean);
  let count = 0;
  for (let index = 0; index < tokens.length; index++) {
    count++;
    const status = tokens[index].slice(0, 2);
    if (status.includes('R') || status.includes('C')) index++; // Skip the paired original-path field.
  }
  return count;
}

/** Sums added/deleted line counts from `git diff --numstat` output, ignoring binary files ("-"). */
function parseNumstat(output) {
  let insertions = 0;
  let deletions = 0;
  if (!output) return { insertions, deletions };
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted] = line.split('\t');
    const addedNumber = Number(added);
    const deletedNumber = Number(deleted);
    if (added !== '-' && Number.isFinite(addedNumber)) insertions += addedNumber;
    if (deleted !== '-' && Number.isFinite(deletedNumber)) deletions += deletedNumber;
  }
  return { insertions, deletions };
}

/**
 * Groups `git for-each-ref --format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(committerdate:relative)`
 * output (over `refs/heads refs/remotes`, sorted `-committerdate`) into local and remote
 * branches, dropping a remote's symbolic `HEAD` pointer and any remote branch that already has
 * a same-named local branch (that pairing is exposed through the local entry's `upstream` field
 * instead). Order within each group is preserved from the input (most recently committed first).
 */
function parseForEachRef(output) {
  const local = [];
  const remote = [];
  if (!output) return { local, remote };
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    const [refname, shortname, upstream, relative] = line.split('\t');
    if (!refname || !shortname || refname.endsWith('/HEAD')) continue;
    if (refname.startsWith('refs/heads/')) {
      local.push({ name: shortname, upstream: upstream || undefined, lastCommitRelative: relative || undefined });
    } else if (refname.startsWith('refs/remotes/')) {
      remote.push({ name: shortname });
    }
  }
  const localNames = new Set(local.map(branch => branch.name));
  const remoteOnly = remote.filter(branch => {
    const slash = branch.name.indexOf('/');
    const branchName = slash >= 0 ? branch.name.slice(slash + 1) : branch.name;
    return !localNames.has(branchName);
  });
  return { local, remote: remoteOnly };
}

/**
 * Resolves the repository's current branch (or a `detached @<sha>` label), or `null` when `cwd`
 * is not inside a git work tree, git is not installed, or the check otherwise fails.
 */
async function detectCurrent(execFileImpl, platform, cwd, env, timeoutMs) {
  try {
    const inside = await run(execFileImpl, platform, ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { cwd, env, timeoutMs });
    if (inside.trim() !== 'true') return null;
  } catch { return null; }
  let branch = '';
  // `symbolic-ref` resolves HEAD's symbolic target even on an unborn branch (no commits yet,
  // where `rev-parse --abbrev-ref HEAD` fails outright); it only fails for a genuinely detached HEAD.
  try { branch = (await run(execFileImpl, platform, ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'], { cwd, env, timeoutMs })).trim(); } catch { /* Detached HEAD. */ }
  if (branch) return { branch, detached: false };
  let sha = '';
  try { sha = (await run(execFileImpl, platform, ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { cwd, env, timeoutMs })).trim(); } catch { /* No commits yet. */ }
  return sha ? { branch: `detached @${sha}`, detached: true } : { branch: null, detached: true };
}

async function countChangedFiles(execFileImpl, platform, cwd, env, timeoutMs) {
  const output = await run(execFileImpl, platform, ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd, env, timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return parsePorcelainCount(output);
}

async function diffNumstat(execFileImpl, platform, cwd, env, timeoutMs) {
  let output;
  try { output = await run(execFileImpl, platform, ['-C', cwd, 'diff', '--numstat', 'HEAD'], { cwd, env, timeoutMs, maxBuffer: 4 * 1024 * 1024 }); }
  catch { output = await run(execFileImpl, platform, ['-C', cwd, 'diff', '--numstat', EMPTY_TREE_SHA], { cwd, env, timeoutMs, maxBuffer: 4 * 1024 * 1024 }).catch(() => ''); }
  return parseNumstat(output);
}

async function aheadBehindCounts(execFileImpl, platform, cwd, env, timeoutMs) {
  const output = await run(execFileImpl, platform, ['-C', cwd, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd, env, timeoutMs });
  const [behind, ahead] = output.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { ahead, behind };
}

function buildEnv(environmentPath) {
  // GIT_OPTIONAL_LOCKS=0 keeps a status/diff read from fighting the index lock with a
  // command the user is running at the same time in the same working tree.
  return { ...process.env, PATH: environmentPath || process.env.PATH || '', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * Caches `gitStatus`/`gitBranches` results per working directory for a short TTL and coalesces
 * concurrent requests for the same directory into a single git invocation, so rapid "ready"
 * events (one per finished command) never pile up redundant git processes.
 */
// Short enough that a status/branches call made right after the next "ready" event (at least
// one full command's round trip later) never serves a stale result from before that command ran,
// but still coalesces truly-simultaneous callers (e.g. a refresh racing a window focus event).
function createGitStatusService({ platform = process.platform, execFileImpl = execFile, now = Date.now, ttl = 300, timeoutMs = 1500 } = {}) {
  const statusCache = new Map();
  const branchesCache = new Map();
  const statusInflight = new Map();
  const branchesInflight = new Map();

  async function computeStatus(cwd, environmentPath) {
    const env = buildEnv(environmentPath);
    const current = await detectCurrent(execFileImpl, platform, cwd, env, timeoutMs);
    if (!current) return null;
    const [changedFiles, numstat, aheadBehind] = await Promise.all([
      countChangedFiles(execFileImpl, platform, cwd, env, timeoutMs).catch(() => 0),
      diffNumstat(execFileImpl, platform, cwd, env, timeoutMs).catch(() => ({ insertions: 0, deletions: 0 })),
      aheadBehindCounts(execFileImpl, platform, cwd, env, timeoutMs).catch(() => null),
    ]);
    return {
      branch: current.branch, detached: current.detached,
      ahead: aheadBehind?.ahead, behind: aheadBehind?.behind,
      changedFiles, insertions: numstat.insertions, deletions: numstat.deletions,
    };
  }

  async function computeBranches(cwd, environmentPath) {
    const env = buildEnv(environmentPath);
    const current = await detectCurrent(execFileImpl, platform, cwd, env, timeoutMs);
    if (!current) return null;
    let output = '';
    try {
      output = await run(execFileImpl, platform, ['-C', cwd, 'for-each-ref', '--sort=-committerdate', 'refs/heads', 'refs/remotes',
        '--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(committerdate:relative)'], { cwd, env, timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    } catch { /* Report what we resolved for HEAD even if the ref listing itself failed. */ }
    const { local, remote } = parseForEachRef(output);
    return { current: current.detached ? null : current.branch, local, remote };
  }

  function cached(cache, inflight, compute, cwd, environmentPath, refresh) {
    const key = `${cwd}\0${environmentPath || ''}`;
    if (!refresh) {
      const previous = cache.get(key);
      if (previous && now() - previous.time < ttl) return Promise.resolve(previous.value);
      const pending = inflight.get(key);
      if (pending) return pending;
    }
    const promise = compute(cwd, environmentPath).then(value => {
      cache.set(key, { time: now(), value });
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      inflight.delete(key);
      return value;
    }, error => { inflight.delete(key); throw error; });
    inflight.set(key, promise);
    return promise;
  }

  return {
    status(cwd, environmentPath, refresh = false) { return cached(statusCache, statusInflight, computeStatus, cwd, environmentPath, refresh); },
    branches(cwd, environmentPath, refresh = false) { return cached(branchesCache, branchesInflight, computeBranches, cwd, environmentPath, refresh); },
  };
}

module.exports = { parsePorcelainCount, parseNumstat, parseForEachRef, detectCurrent, createGitStatusService, EMPTY_TREE_SHA };
