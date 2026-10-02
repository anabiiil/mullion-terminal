import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-history-smoke-')));
const fixture = path.join(temporary, 'workspace');
const profile = path.join(temporary, 'profile');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

try {
  for (const directory of [fixture, profile, results]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(profile, '.zshrc'), [
    "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
    "PROMPT='history-test ❯ '", "RPROMPT=''", '',
  ].join('\n'));
  const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(temporary, 'preferences')}`, `--cwd=${fixture}`],
    env: { ...process.env, ZDOTDIR: profile, SHELL: '/bin/zsh', TERMINAL_DEV_URL: '' },
    timeout: 30000,
  });
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.removeAllListeners('ready-to-show');
      window.hide();
    }
  });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const term = page.locator('.shell-pane.active .xterm-helper-textarea');
  const quick = page.locator('.quick-commands');
  const sidebar = page.locator('.sidebar');
  const ready = async () => { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(150); };
  const history = () => page.evaluate(() => window.terminalAPI.bootstrap().then(value => value.history));
  async function waitHistory(predicate, message) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const entries = await history();
      if (predicate(entries)) return entries;
      await page.waitForTimeout(50);
    }
    assert.fail(message ?? 'Command history did not reach the expected state within 15 seconds');
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

  await ready();
  await term.focus();
  await page.keyboard.press('Control+c');
  await ready();

  // `test 1 -eq 1` is a real, meaningful command (not one of the basic/system commands
  // isBasicCommand hides from the sidebar, quick bar and "most used" ranking).
  const learned = 'test 1 -eq 1';
  await run(learned);
  await waitHistory(entries => entries.some(entry => entry.command === learned),
    'Learned command should appear in history');

  // The quick-commands bar surfaces it immediately (it reads the same history state).
  await quick.getByRole('button', { name: `Insert ${learned}`, exact: true }).waitFor({ state: 'visible', timeout: 10000 });

  // Open the history sidebar and confirm the row is there.
  await page.getByRole('button', { name: 'Command history', exact: true }).click();
  await sidebar.waitFor({ state: 'visible' });
  const row = sidebar.locator('.history-entry').filter({ hasText: learned });
  await row.waitFor({ state: 'visible', timeout: 10000 });

  // Delete it: no confirmation dialog, removed immediately everywhere.
  const deleteButton = row.getByRole('button', { name: `Delete ${learned}`, exact: true });
  await deleteButton.click();
  await sidebar.locator('.history-entry').filter({ hasText: learned }).waitFor({ state: 'detached', timeout: 10000 });
  await waitHistory(entries => !entries.some(entry => entry.command === learned),
    'Deleted command should be gone from the store');
  await page.waitForFunction(command => ![...document.querySelectorAll('.quick-command')]
    .some(button => button.getAttribute('aria-label') === `Insert ${command}`), learned, { timeout: 10000 });

  // The undo toast appears and restores the entry with its original stats.
  const toast = page.locator('.undo-toast');
  await toast.waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await toast.innerText(), new RegExp(learned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await waitHistory(entries => entries.some(entry => entry.command === learned && entry.count === 1),
    'Undo should restore the deleted command with its original count');
  await sidebar.locator('.history-entry').filter({ hasText: learned }).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: `Insert ${learned}`, exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await toast.waitFor({ state: 'hidden', timeout: 10000 });

  // Keyboard: focusing the command button and pressing Delete removes the row too.
  await sidebar.locator('.history-entry').filter({ hasText: learned }).locator('.history-command').focus();
  await page.keyboard.press('Delete');
  await sidebar.locator('.history-entry').filter({ hasText: learned }).waitFor({ state: 'detached', timeout: 10000 });
  await waitHistory(entries => !entries.some(entry => entry.command === learned),
    'Delete key on a focused history row should remove it from the store');
  await page.waitForTimeout(5200); // Let the undo window from the keyboard delete expire before re-learning.
  await toast.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});

  // Relearn it, then remove it from the quick-commands bar via its context menu.
  await run(learned);
  const quickButton = quick.getByRole('button', { name: `Insert ${learned}`, exact: true });
  await quickButton.waitFor({ state: 'visible', timeout: 10000 });
  await quickButton.click({ button: 'right' });
  const menu = page.locator('.quick-menu');
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  await menu.getByRole('menuitem', { name: 'Remove from history', exact: true }).click();
  await menu.waitFor({ state: 'hidden', timeout: 5000 });
  await waitHistory(entries => !entries.some(entry => entry.command === learned),
    'Quick bar "Remove from history" should delete the command');
  await page.waitForFunction(command => ![...document.querySelectorAll('.quick-command')]
    .some(button => button.getAttribute('aria-label') === `Insert ${command}`), learned, { timeout: 10000 });

  assert.deepEqual(errors, []);
  console.log('History smoke passed: delete from sidebar, quick bar and keyboard, undo toast restores stats, quick-bar context menu removal.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'history-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
