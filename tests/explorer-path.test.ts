import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commonAncestor, containsPath, parentPath, samePath } from '../src/explorer-path';

test('tree containment checks whole directory names and supports filesystem roots', () => {
  assert.equal(containsPath('/work/app', '/work/app/src'), true);
  assert.equal(containsPath('/work/app/', '/work/app'), true);
  assert.equal(containsPath('/work/app', '/work/apple'), false);
  assert.equal(containsPath('/work/app', '/work'), false);
  assert.equal(containsPath('/', '/work/app'), true);
  assert.equal(samePath('/work/app', '/work/app/'), true);
  assert.equal(samePath('/work/App', '/work/app', 'linux'), false);
  assert.equal(containsPath('/work/a\\b', '/work/a/b', 'darwin'), false);
  assert.equal(commonAncestor('/work/a\\b', '/work/a/b', 'darwin'), '/work');
  assert.equal(parentPath('/work/a\\b', 'darwin'), '/work');
});

test('shell navigation expands the root to a shared ancestor without changing path spelling', () => {
  assert.equal(commonAncestor('/work/app', '/work/app/src'), '/work/app');
  assert.equal(commonAncestor('/work/app', '/work/assets'), '/work');
  assert.equal(commonAncestor('/work/app', '/other'), '/');
  assert.equal(commonAncestor('/work/app/src', '/work/app'), '/work/app');
  assert.equal(commonAncestor('/work/Project/', '/work/Project/src'), '/work/Project/');
});

test('Windows containment ignores case and separator style but preserves directory boundaries', () => {
  assert.equal(containsPath('C:\\Work\\App', 'c:/work/app/src'), true);
  assert.equal(containsPath('C:\\Work\\App', 'C:\\Work\\Apple'), false);
  assert.equal(containsPath('C:\\', 'c:\\Work'), true);
  assert.equal(containsPath('C:\\Work', 'D:\\Work'), false);
  assert.equal(samePath('C:\\Work\\App\\', 'c:/work/app', 'win32'), true);
  assert.equal(commonAncestor('C:\\Work\\App', 'c:/work/assets'), 'C:\\Work');
  assert.equal(commonAncestor('C:/Work/App', 'c:\\Other'), 'C:/');
  assert.equal(commonAncestor('C:\\Work', 'D:\\Projects'), 'D:\\Projects');
});

test('network shares remain separate roots and common paths retain the original share spelling', () => {
  assert.equal(containsPath('\\\\Server\\Share\\', '\\\\server\\share\\Work'), true);
  assert.equal(containsPath('\\\\Server\\Share', '\\\\Server\\ShareTwo\\Work'), false);
  assert.equal(commonAncestor('\\\\Server\\Share\\App', '\\\\server\\share\\Other'), '\\\\Server\\Share\\');
  assert.equal(commonAncestor('\\\\Server\\Share\\App', '\\\\Server\\Other\\Project'), '\\\\Server\\Other\\Project');
});

test('browsing upward stops at POSIX, drive and network roots', () => {
  assert.equal(parentPath('/work/app/'), '/work');
  assert.equal(parentPath('/work'), '/');
  assert.equal(parentPath('/'), '/');
  assert.equal(parentPath('C:\\Work\\App'), 'C:\\Work');
  assert.equal(parentPath('C:\\Work'), 'C:\\');
  assert.equal(parentPath('C:\\'), 'C:\\');
  assert.equal(parentPath('\\\\Server\\Share\\Work'), '\\\\Server\\Share\\');
  assert.equal(parentPath('\\\\Server\\Share\\'), '\\\\Server\\Share\\');
});
