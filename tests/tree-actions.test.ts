import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nanoEditCommand, quotePosixPath, relativeToCwd } from '../src/tree-actions';

test('relativeToCwd shortens a path inside cwd and leaves others absolute', () => {
  assert.equal(relativeToCwd('/work/app/src/index.ts', '/work/app'), 'src/index.ts');
  assert.equal(relativeToCwd('/work/app/notes.txt', '/work/app/'), 'notes.txt');
  assert.equal(relativeToCwd('/etc/hosts', '/'), 'etc/hosts');
  assert.equal(relativeToCwd('/work/app', '/work/app'), '.');
  assert.equal(relativeToCwd('/work/other/file.txt', '/work/app'), '/work/other/file.txt');
  // A shared string prefix must not be mistaken for containment.
  assert.equal(relativeToCwd('/work/apple/file.txt', '/work/app'), '/work/apple/file.txt');
});

test('quotePosixPath escapes embedded single quotes safely', () => {
  assert.equal(quotePosixPath('notes.txt'), "'notes.txt'");
  assert.equal(quotePosixPath('a b/c.txt'), "'a b/c.txt'");
  assert.equal(quotePosixPath("it's a file.txt"), "'it'\\''s a file.txt'");
});

test('nanoEditCommand builds a quoted nano invocation relative to cwd', () => {
  assert.equal(nanoEditCommand('/work/app/src/index.ts', '/work/app'), "nano 'src/index.ts'");
  assert.equal(nanoEditCommand('/work/other/weird name.txt', '/work/app'), "nano '/work/other/weird name.txt'");
  assert.equal(nanoEditCommand("/work/app/it's.txt", '/work/app'), "nano 'it'\\''s.txt'");
});
