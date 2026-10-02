import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorKind, isNanoProcess, NANO_KEYS } from '../src/editor-process';

test('nano and pico are recognised from node-pty process names', () => {
  for (const name of ['nano', 'pico', 'rnano', '/usr/bin/nano', '/opt/homebrew/bin/nano', 'NANO.EXE', ' pico\n']) assert.equal(isNanoProcess(name), true, name);
  for (const name of ['', null, undefined, 'zsh', 'bash', 'vim', 'nvim', 'nanoc', 'picocom', 'pwsh.exe']) assert.equal(isNanoProcess(name), false, String(name));
});

test('editorKind recognises nano/pico', () => {
  for (const name of ['nano', 'pico', 'rnano', '/usr/bin/nano', '/opt/homebrew/bin/nano', 'NANO.EXE', ' pico\n']) assert.equal(editorKind(name), 'nano', name);
});

test('editor bar key sequences', () => {
  assert.equal(NANO_KEYS.save, '\x0f\r');
  assert.equal(NANO_KEYS.saveAndExit, '\x0f\r\x18');
  assert.equal(NANO_KEYS.exit, '\x18');
});
