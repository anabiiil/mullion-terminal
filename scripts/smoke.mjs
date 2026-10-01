import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-smoke-')));
const home = path.join(temporary, 'home');
const folder = path.join(home, 'Workspace with spaces');
await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
await fs.writeFile(path.join(folder, 'notes.txt'), 'hello terminal\n');
await fs.writeFile(path.join(home, '.zshrc'), [
  "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
  'PROMPT="%F{cyan}%~%f %F{yellow}❯%f "', "RPROMPT=''", '',
].join('\n'));
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(temporary, 'preferences')}`, `--cwd=${home}`], env: { ...process.env, ZDOTDIR: home, SHELL: process.env.MULLION_SMOKE_SHELL || '/bin/zsh', HISTCONTROL: 'ignoredups', TERMINAL_DEV_URL: '' }, timeout: 30000 });
await app.evaluate(({ BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows()) { window.removeAllListeners('ready-to-show'); window.hide(); }
});
const page = await app.firstWindow();
await page.evaluate(() => {
  window.__mullionSmokeSessionEvents = [];
  window.terminalAPI.onEvent(event => {
    if (event.type === 'state' || event.type === 'exit') {
      window.__mullionSmokeSessionEvents.push(event);
      window.__mullionSmokeSessionEvents = window.__mullionSmokeSessionEvents.slice(-12);
    }
  });
});
await app.evaluate(({ clipboard }) => {
  globalThis.__mullionOriginalWriteText = clipboard.writeText;
  clipboard.writeText = value => { globalThis.__mullionCopiedText = value; };
});
const bootstrap = await page.evaluate(() => window.terminalAPI.bootstrap());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const term = page.locator('.shell-pane.active .xterm-helper-textarea');
const ready = async () => { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(180); };
const history = () => page.evaluate(() => window.terminalAPI.bootstrap().then(value => value.history));
async function waitHistory(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const entries = await history();
    if (predicate(entries)) return entries;
    await page.waitForTimeout(50);
  }
  assert.fail('Command history did not reach the expected state within 15 seconds');
}
async function run(command) {
  await ready();
  const previousCount = (await history()).find(value => value.command === command)?.count ?? 0;
  await term.focus();
  await page.keyboard.type(command, { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await waitHistory(entries => entries.some(value => value.command === command && value.count > previousCount));
  await ready();
}

try {
  await ready();
  await term.focus();
  await page.keyboard.press('Control+c');
  await ready();
  assert.equal(await page.locator('[role=tab]').count(), 1);
  assert.equal(await page.locator('.sidebar').count(), 0);
  await page.getByRole('button', { name: 'Toggle files sidebar', exact: true }).click();
  await run("printf 'hello-terminal\\n'");
  await waitHistory(entries => entries.some(value => value.command === "printf 'hello-terminal\\n'"));
  await run("printf 'hello-terminal\\n'");
  assert.equal((await history()).find(value => value.command === "printf 'hello-terminal\\n'").count, 2);

  // Folder navigation changes the real shell, including paths containing spaces.
  await page.locator('.tree-name').filter({ hasText: 'Workspace with spaces' }).click();
  await ready();
  await page.waitForFunction(() => document.querySelector('.current-path')?.getAttribute('title')?.endsWith('Workspace with spaces'));
  await run('cd nested');
  await page.waitForFunction(() => document.querySelector('.current-path')?.getAttribute('title')?.endsWith('/nested'));
  await run('cd ..');

  // A quoted path replacement handles folder names containing spaces.
  await run('cd ..');
  await term.focus();
  await page.keyboard.type('cd Work', { delay: 30 });
  await page.getByRole('listbox').waitFor();
  assert.match(await page.locator('.suggestions [aria-selected=true]').innerText(), /Workspace with spaces/);
  await page.keyboard.press('Enter');
  await ready();
  await page.waitForFunction(() => document.querySelector('.current-path')?.getAttribute('title')?.endsWith('Workspace with spaces'));

  // Learn a command; Auto-complete on accepts and executes the whole command.
  await run('echo learned-terminal');
  await term.focus();
  await page.keyboard.type('echo learn', { delay: 35 });
  await page.getByRole('listbox', { name: 'Command suggestions' }).waitFor();
  assert.match(await page.locator('.suggestions [aria-selected=true]').innerText(), /echo learned-terminal/);
  await page.keyboard.press('Enter');
  await ready();
  assert.equal((await history()).find(value => value.command === 'echo learned-terminal').count, 2);

  // Auto-complete off: Enter preserves typed input, Tab fills without executing.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-complete', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await term.focus();
  await page.keyboard.type('echo learn', { delay: 30 });
  await page.locator('.inline-suggestion').waitFor();
  assert.equal(await page.getByRole('listbox').count(), 0);
  await page.keyboard.press('Enter');
  await ready();
  assert.ok((await history()).some(value => value.command === 'echo learn'));
  await term.focus();
  await page.keyboard.type('echo learned-', { delay: 30 });
  await page.locator('.inline-suggestion').waitFor();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  assert.equal((await history()).find(value => value.command === 'echo learned-terminal').count, 2);
  await page.keyboard.press('Enter');
  await ready();
  assert.equal((await history()).find(value => value.command === 'echo learned-terminal').count, 3);

  // Interactive process gets raw input, no popup; Ctrl+C restores the prompt.
  await run("printf 'before-interactive\\n'");
  await term.focus();
  await page.keyboard.type('cat', { delay: 25 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.locator('.shell-state.ready').waitFor({ state: 'hidden' });
  await page.keyboard.type('interactive-input', { delay: 10 });
  assert.equal(await page.getByRole('listbox').count(), 0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+c');
  await ready();

  // Each tab has an independent PTY and directory, close restores the previous.
  await page.getByRole('button', { name: 'New terminal tab', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2, undefined, { timeout: 15000 });
  await page.waitForFunction(directory => document.querySelector('.current-path')?.getAttribute('title') === directory,
    bootstrap.home, { timeout: 15000 });
  await ready();
  assert.equal(await page.locator('[role=tab]').count(), 2);
  await page.getByRole('button', { name: 'Close terminal 2', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1, undefined, { timeout: 10000 });
  await ready();
  assert.equal(await page.locator('[role=tab]').count(), 1);
  await page.getByRole('button', { name: 'Command history', exact: true }).click();
  await page.getByRole('button', { name: 'Pin echo learned-terminal', exact: true }).click();
  assert.equal((await history()).find(value => value.command === 'echo learned-terminal').pinned, true);
  await page.getByRole('button', { name: 'Toggle files sidebar' }).click();
  await ready();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(root, 'test-results', 'terminal-dark.png') });
  await app.evaluate(({ ipcMain }) => {
    globalThis.__mullionSmokeFinalWrites = [];
    ipcMain.on('terminal:write', (_event, id, data) => { globalThis.__mullionSmokeFinalWrites.push({ id, data }); });
  });
  await term.focus();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.shell-pane.active .xterm-helper-textarea'),
    undefined, { timeout: 5000 });
  await page.keyboard.type('echo learned-', { delay: 30 });
  await page.locator('.inline-suggestion').waitFor();
  await page.screenshot({ path: path.join(root, 'test-results', 'suggestions.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  await ready();
  await page.getByRole('button', { name: 'Copy current path' }).click();
  await page.waitForTimeout(120);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await app.evaluate(() => globalThis.__mullionCopiedText?.endsWith('Workspace with spaces')), true,
    'Copy path should pass the current directory to the native clipboard API');
  // Verify the file-manager action reaches the native API with the real cwd.
  await app.evaluate(({ shell }) => {
    globalThis.__mullionOriginalOpenPath = shell.openPath;
    shell.openPath = async value => { globalThis.__mullionOpenedDirectory = value; return ''; };
  });
  await page.getByRole('button', { name: 'Open current folder in file manager' }).click();
  await page.waitForTimeout(120);
  assert.equal(await app.evaluate(() => globalThis.__mullionOpenedDirectory?.endsWith('Workspace with spaces')), true, 'File manager should open the current folder');
  await app.evaluate(({ shell }) => { shell.openPath = globalThis.__mullionOriginalOpenPath; delete globalThis.__mullionOriginalOpenPath; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForTimeout(160);
  await page.screenshot({ path: path.join(root, 'test-results', 'settings.png') });
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.waitForTimeout(160);
  await page.screenshot({ path: path.join(root, 'test-results', 'terminal-light.png') });
  assert.deepEqual(errors, []);
  console.log('Desktop smoke passed: real shell, cd/tree, learning, Enter/Tab modes, interactive input, tabs, pins, themes.');
} catch (error) {
  await page.screenshot({ path: path.join(root, 'test-results', 'failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  console.error('Final input diagnostics:', {
    ui: await page.evaluate(() => ({
      focusedClass: document.activeElement?.className,
      ready: Boolean(document.querySelector('.shell-state.ready')),
      activePaneCount: document.querySelectorAll('.shell-pane.active').length,
      finalRows: [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')].map(row => row.textContent.trim()).filter(Boolean).slice(-3),
      sessions: window.__mullionSmokeSessionEvents,
    })).catch(() => null),
    writes: await app.evaluate(() => globalThis.__mullionSmokeFinalWrites).catch(() => null),
  });
  throw error;
} finally {
  await app.evaluate(({ clipboard }) => {
    if (globalThis.__mullionOriginalWriteText) clipboard.writeText = globalThis.__mullionOriginalWriteText;
    delete globalThis.__mullionOriginalWriteText;
    delete globalThis.__mullionCopiedText;
  }).catch(() => {});
  await app.evaluate(({ shell }) => { if (globalThis.__mullionOriginalOpenPath) shell.openPath = globalThis.__mullionOriginalOpenPath; }).catch(() => {});
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
