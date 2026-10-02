import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorKind, ESC_DELAY_MS, looksLikeGitEditorBuffer, VIM_KEYS } from '../src/editor-process';

test('vim, vi, nvim and view are recognised from node-pty process names', () => {
  for (const name of ['vim', 'vi', 'nvim', 'view', '/usr/bin/vim', '/opt/homebrew/bin/nvim', 'VIM.EXE', ' vi\n']) {
    assert.equal(editorKind(name), 'vim', name);
  }
});

test('editorKind still separates vim from nano and unrelated programs', () => {
  for (const name of ['', null, undefined, 'zsh', 'bash', 'nano', 'pico', 'rnano', 'vimdiff', 'viewer', 'pwsh.exe']) {
    assert.notEqual(editorKind(name), 'vim', String(name));
  }
  assert.equal(editorKind('nano'), 'nano');
  assert.equal(editorKind('zsh'), null);
});

test('vim command-line sequences', () => {
  // Each is sent after a separately-written Escape (see ESC_DELAY_MS), so
  // they work whether vim was left in Insert or Normal mode.
  assert.equal(VIM_KEYS.save, ':w\r');
  assert.equal(VIM_KEYS.saveAndExit, ':wq\r');
  // Exactly what a user types by hand to force-quit a git commit/rebase editor.
  assert.equal(VIM_KEYS.exit, ':qa!\r');
  assert.equal(typeof ESC_DELAY_MS, 'number');
  assert.ok(ESC_DELAY_MS > 0);
});

// git runs the editor as a plain child process (same process group), so the
// foreground name reported by node-pty stays "git" for as long as the
// editor is open. looksLikeGitEditorBuffer is the fallback that recognises
// git's own commit/rebase/merge templates on screen instead.
test('looksLikeGitEditorBuffer recognises git commit, rebase and merge templates', () => {
  const commit = [
    '', '', '',
    '# Please enter the commit message for your changes. Lines starting',
    "# with '#' will be ignored, and an empty message aborts the commit.",
    '#', '# On branch master', '~', '~',
  ];
  assert.equal(looksLikeGitEditorBuffer(commit), true);

  const rebaseTodo = [
    'pick a1b2c3d Add feature flag', 'squash e4f5a6b Fix typo', '',
    '# Rebase 1234567..89abcde onto 89abcde (2 commands)', '#', '~',
  ];
  assert.equal(looksLikeGitEditorBuffer(rebaseTodo), true);

  const merge = [
    "Merge branch 'feature'", '',
    '# Please enter a commit message to explain why this merge is necessary,', '# Conflicts:', '#\tsrc/app.ts', '~',
  ];
  assert.equal(looksLikeGitEditorBuffer(merge), true);
});

test('looksLikeGitEditorBuffer ignores ordinary buffers, including a plain vim session', () => {
  const plainVim = ['hello', 'world', '~', '~', '~', '"notes.txt" 2L, 12B'];
  assert.equal(looksLikeGitEditorBuffer(plainVim), false);
  assert.equal(looksLikeGitEditorBuffer(['~', '~', '~']), false);
  assert.equal(looksLikeGitEditorBuffer([]), false);
  assert.equal(looksLikeGitEditorBuffer(['commit abc1234 (HEAD -> master)', 'Author: a <a@b.c>', '', '    initial commit']), false);
});
