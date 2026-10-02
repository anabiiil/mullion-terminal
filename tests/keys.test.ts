import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortcutAction, type KeyInput } from '../src/keys';

const shell = { hasSelection: false, alternateScreen: false, editor: null as 'nano' | 'vim' | null };
const fullScreen = { ...shell, alternateScreen: true };
function key(value: string, mods: Partial<Omit<KeyInput, 'key'>> = {}): KeyInput {
  return { key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

test('Cmd and Ctrl copy only when text is selected', () => {
  for (const mods of [{ metaKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }]) {
    assert.equal(shortcutAction(key('c', mods), { ...shell, hasSelection: true }), 'copy');
    assert.equal(shortcutAction(key('C', mods), { ...fullScreen, hasSelection: true }), 'copy');
  }
  // Without a selection Ctrl+C stays an interrupt for the shell or program.
  assert.equal(shortcutAction(key('c', { ctrlKey: true }), shell), null);
  assert.equal(shortcutAction(key('c', { ctrlKey: true }), fullScreen), null);
  assert.equal(shortcutAction(key('c', { metaKey: true }), shell), null);
  assert.equal(shortcutAction(key('C', { ctrlKey: true, shiftKey: true }), shell), 'swallow');
});

test('Cmd+V always pastes; Ctrl+V pastes at the shell but passes through full-screen programs', () => {
  assert.equal(shortcutAction(key('v', { metaKey: true }), shell), 'paste');
  assert.equal(shortcutAction(key('v', { metaKey: true }), fullScreen), 'paste');
  assert.equal(shortcutAction(key('v', { ctrlKey: true }), shell), 'paste');
  assert.equal(shortcutAction(key('v', { ctrlKey: true }), fullScreen), null);
  assert.equal(shortcutAction(key('V', { ctrlKey: true, shiftKey: true }), fullScreen), 'paste');
});

test('readline and editor control keys are left alone', () => {
  for (const value of ['a', 'e', 'u', 'w', 'r', 'x', 'o', 'z']) {
    assert.equal(shortcutAction(key(value, { ctrlKey: true }), shell), null, `Ctrl+${value}`);
    assert.equal(shortcutAction(key(value, { ctrlKey: true }), { ...fullScreen, editor: 'nano' }), null, `Ctrl+${value} in nano`);
  }
  assert.equal(shortcutAction(key('v', { altKey: true, metaKey: true }), shell), null);
  assert.equal(shortcutAction(key('v', { ctrlKey: true, metaKey: true }), shell), null);
  assert.equal(shortcutAction(key('v'), shell), null);
});

test('Cmd/Ctrl+S saves only inside nano or vim', () => {
  assert.equal(shortcutAction(key('s', { metaKey: true }), { ...fullScreen, editor: 'nano' }), 'save');
  assert.equal(shortcutAction(key('s', { ctrlKey: true }), { ...fullScreen, editor: 'nano' }), 'save');
  assert.equal(shortcutAction(key('s', { metaKey: true }), { ...fullScreen, editor: 'vim' }), 'save');
  assert.equal(shortcutAction(key('s', { ctrlKey: true }), { ...fullScreen, editor: 'vim' }), 'save');
  assert.equal(shortcutAction(key('s', { ctrlKey: true }), fullScreen), null);
  assert.equal(shortcutAction(key('s', { ctrlKey: true }), shell), null);
});

test('clear shortcuts', () => {
  assert.equal(shortcutAction(key('k', { metaKey: true }), shell), 'clear');
  assert.equal(shortcutAction(key('K', { ctrlKey: true, shiftKey: true }), shell), 'clear');
  // Ctrl+K is kill-line in readline and cut in nano.
  assert.equal(shortcutAction(key('k', { ctrlKey: true }), shell), null);
});
