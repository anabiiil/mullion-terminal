import assert from 'node:assert/strict';
import { test } from 'node:test';
import { switchBranchCommand } from '../src/git-command';

test('switchBranchCommand switches a local branch with `git switch --`', () => {
  assert.equal(switchBranchCommand('feature-x'), "git switch -- 'feature-x'");
});

test('switchBranchCommand tracks a remote-only branch by its full remote-qualified name', () => {
  assert.equal(switchBranchCommand('origin/feature-x', { remote: true }), "git switch --track 'origin/feature-x'");
});

test('switchBranchCommand quotes a branch name safely for POSIX shells, including embedded single quotes', () => {
  assert.equal(switchBranchCommand("weird'branch"), "git switch -- 'weird'\\''branch'");
});

test('switchBranchCommand quotes for PowerShell on win32 by doubling embedded single quotes', () => {
  assert.equal(switchBranchCommand("weird'branch", { platform: 'win32' }), "git switch -- 'weird''branch'");
});
