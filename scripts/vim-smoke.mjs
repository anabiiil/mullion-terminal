import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// End-to-end: the editor bar's vim buttons, used from a git commit/rebase
// editor and from a plain `vim <file>` edit.
try {
  execFileSync('vim', ['--version'], { stdio: 'ignore' });
} catch {
  console.log('Vim smoke skipped: vim is not installed.');
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-vim-smoke-')));
const home = path.join(temporary, 'home');
const repo = path.join(home, 'repo');
await fs.mkdir(repo, { recursive: true });
// An empty .vimrc keeps the user's own vim config from affecting the test.
await fs.writeFile(path.join(home, '.vimrc'), '');
await fs.writeFile(path.join(home, '.zshrc'), [
  "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
  'PROMPT="%F{cyan}%~%f %F{yellow}❯%f "', "RPROMPT=''", '',
].join('\n'));
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv });
execFileSync('git', ['config', 'user.email', 'vim-smoke@example.com'], { cwd: repo, env: gitEnv });
execFileSync('git', ['config', 'user.name', 'Vim Smoke'], { cwd: repo, env: gitEnv });
execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'initial commit'], { cwd: repo, env: gitEnv });
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const file = path.join(repo, 'notes.txt');
const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
const env = { ...process.env, HOME: home, ZDOTDIR: home, SHELL: process.env.MULLION_SMOKE_SHELL || '/bin/zsh', GIT_CONFIG_NOSYSTEM: '1', TERMINAL_DEV_URL: '' };
delete env.DISPLAY;
delete env.EDITOR;
delete env.VISUAL;
delete env.GIT_EDITOR;
const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(temporary, 'preferences')}`, `--cwd=${repo}`], env, timeout: 30000 });
await app.evaluate(({ BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows()) { window.removeAllListeners('ready-to-show'); window.hide(); }
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const term = page.locator('.shell-pane.active .xterm-helper-textarea');
const ready = async () => { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(180); };
const rows = () => page.evaluate(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')].map(row => row.textContent));
async function runCommand(command) {
  await term.focus();
  await page.keyboard.type(command, { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
}

try {
  await ready();

  // `git commit` with no message opens the configured editor (vim here).
  // The bar should show the vim buttons, not nano's.
  await runCommand('GIT_EDITOR=vim git commit --allow-empty');
  await page.locator('.editor-bar').waitFor({ timeout: 8000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(root, 'test-results', 'vim-editor-bar.png') });
  await page.getByRole('button', { name: 'Save & Close' }).waitFor({ timeout: 2000 });
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0, 'nano-only Save button leaked into the vim bar');

  // Close (:qa!) exits vim without saving the commit message; git aborts
  // the commit because the message is still empty, which is expected.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await ready();
  await page.locator('.editor-bar').waitFor({ state: 'detached', timeout: 5000 });
  const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, env: gitEnv }).toString().trim().split('\n');
  assert.equal(log.length, 1, 'the empty commit should have been aborted, not recorded');

  // Plain `vim notes.txt`: insert text from Insert mode, then Save & Close.
  await runCommand('vim notes.txt');
  await page.locator('.editor-bar').waitFor({ timeout: 8000 });
  await term.focus();
  await page.keyboard.type('itext', { delay: 30 }); // "i" enters Insert mode, then types "text"
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Save & Close' }).click();
  await ready();
  await page.locator('.editor-bar').waitFor({ state: 'detached', timeout: 5000 });
  await (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const content = await fs.readFile(file, 'utf8').catch(() => '');
      if (/text/.test(content)) return;
      await page.waitForTimeout(60);
    }
    assert.fail('notes.txt was not saved by Save & Close');
  })();

  assert.deepEqual(errors, []);
  console.log('Vim smoke passed: git commit/rebase editor bar, Close (:qa!), Save & Close (:wq).');
} catch (error) {
  await page.screenshot({ path: path.join(root, 'test-results', 'vim-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  console.error('Rows:', (await rows().catch(() => [])).filter(row => row.trim()));
  console.error('File:', JSON.stringify(await fs.readFile(file, 'utf8').catch(() => null)));
  throw error;
} finally {
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
