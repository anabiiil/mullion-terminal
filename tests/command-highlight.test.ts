import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tokenizeCommand } from '../src/command-highlight';

const reconstruct = (value: string) => tokenizeCommand(value).map(s => s.text).join('');

test('git commit --amend -m "msg" tags command, flags and a quoted string', () => {
  const result = tokenizeCommand('git commit --amend -m "msg"');
  assert.equal(result[0].text, 'git');
  assert.equal(result[0].kind, 'command');
  assert.deepEqual(result.filter(s => s.kind === 'flag').map(s => s.text), ['--amend', '-m']);
  assert.deepEqual(result.filter(s => s.kind === 'string').map(s => s.text), ['"msg"']);
  assert.equal(reconstruct('git commit --amend -m "msg"'), 'git commit --amend -m "msg"');
});

test('ls -la tags the command and a short combined flag', () => {
  const result = tokenizeCommand('ls -la');
  assert.equal(result[0].kind, 'command');
  assert.equal(result[0].text, 'ls');
  const flag = result.find(s => s.kind === 'flag');
  assert.equal(flag?.text, '-la');
});

test('a bare -- token is tagged flag', () => {
  const result = tokenizeCommand('npm run -- build');
  assert.equal(result.find(s => s.text === '--')?.kind, 'flag');
});

test('--format=json stays one flag segment, not split on =', () => {
  const result = tokenizeCommand('docker ps --format=json');
  const flag = result.find(s => s.text === '--format=json');
  assert.equal(flag?.kind, 'flag');
});

test('a quoted token starting with - is a string, not a flag', () => {
  const result = tokenizeCommand('echo "--not-a-flag"');
  const quoted = result.find(s => s.text === '"--not-a-flag"');
  assert.equal(quoted?.kind, 'string');
  assert(!result.some(s => s.kind === 'flag'));
});

test('empty string and command-only input do not throw and produce sane output', () => {
  assert.deepEqual(tokenizeCommand(''), []);
  const result = tokenizeCommand('pwd');
  assert.deepEqual(result, [{ text: 'pwd', kind: 'command' }]);
});

test('reconstruction: joining all segment text reproduces the original string exactly', () => {
  for (const value of [
    '', 'pwd', 'ls -la', 'git commit --amend -m "msg"', 'npm run build --watch',
    "docker run --rm -it ubuntu bash", 'echo "hello world" --flag', "echo 'single quoted' -x",
    '  leading and trailing spaces  ', 'git   status', '--format=json',
  ]) {
    assert.equal(reconstruct(value), value);
  }
});
