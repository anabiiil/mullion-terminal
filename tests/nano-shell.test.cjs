'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { prepareShell, editorWrappers } = require('../electron/shell.cjs');

test('zsh and bash integration enable nano/pico mouse support without touching user files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-nano-'));
  try {
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const target = path.join(directory, path.basename(shell));
      const launch = await prepareShell({ directory: target, nonce: 'n', home: directory, env: { PATH: '/usr/bin:/bin', HOME: directory }, shell, platform: 'darwin' });
      const rc = await fs.readFile(path.join(target, shell.endsWith('zsh') ? '.zshrc' : 'bashrc'), 'utf8');
      assert.match(rc, /function nano \{ __mullion_editor_mouse nano "\$@"; \}/);
      assert.match(rc, /function pico \{ __mullion_editor_mouse pico "\$@"; \}/);
      assert.match(rc, /DISPLAY="\$\{DISPLAY:-:0\}" command "\$__mullion_editor" -m "\$@"/);
      assert.ok(launch.shell === shell);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

for (const shell of ['zsh', 'bash']) {
  test(`${shell} wrappers pass -m, respect user definitions and the opt-out`, { skip: !require('node:fs').existsSync(`/bin/${shell}`) }, () => {
    const stub = 'command() { case "$1" in nano|pico) echo "RUN DISPLAY=$DISPLAY $*";; *) builtin command "$@";; esac; }';
    const run = (prefix, body) => execFileSync(`/bin/${shell}`, [shell === 'zsh' ? '-fc' : '-c', `${prefix}\n${editorWrappers(shell)}\n${stub}\n${body}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim().split('\n');
    const [pico] = run('', 'pico notes.txt');
    assert.equal(pico, 'RUN DISPLAY=:0 pico -m notes.txt');
    assert.match(run('', 'DISPLAY=:7 nano a b')[0], /^RUN DISPLAY=:7 nano -m a b$/);
    assert.equal(run('', 'MULLION_EDITOR_MOUSE=0 nano a')[0], 'RUN DISPLAY= nano a');
    const user = shell === 'zsh' ? 'nano() { echo user-function; }' : 'shopt -s expand_aliases\nnano() { echo user-function; }';
    assert.equal(run(user, 'nano a')[0], 'user-function');
  });
}
