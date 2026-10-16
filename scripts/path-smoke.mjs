import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// End-to-end: a previously visited directory is remembered across the whole session (not just
// its immediate parent), and is suggested as a full path — not merely its next path segment —
// the next time its name is typed again, in both auto-complete modes. Also confirms it never
// leaks into the history sidebar or the "Most used" bar, which only ever list commands.
//
// The fixture "home" is deliberately created under the project's own test-results directory,
// not under the OS temp root: recordDirectory() intentionally never remembers a directory under
// a scratch/temp root (electron/store.cjs's isTempDirectory — e.g. this app's own per-session
// integration directory lives there), and on macOS the OS temp root IS os.tmpdir()/`/var/folders`,
// which every other smoke fixture happens to use for throwaway files. Placing this one fixture
// there too would make its own nested directories indistinguishable from scratch space.
const root = path.resolve(import.meta.dirname, '..');
const results = path.join(root, 'test-results');
const temporary = path.join(results, 'path-smoke-fixture');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-path-smoke-profile-'));
const home = path.join(temporary, 'home');
const alpha = path.join(home, 'Work', 'Projects', 'Alpha');
let app;
let page;
const errors = [];

try {
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(alpha, { recursive: true });
  await fs.mkdir(results, { recursive: true });
  // ZDOTDIR == HOME here: the app's own `~`-handling (os.homedir()) must agree with the shell's.
  await fs.writeFile(path.join(home, '.zshrc'), [
    "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
    "PROMPT='path-test ❯ '", "RPROMPT=''", '',
  ].join('\n'));

  const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(profile, 'preferences')}`, `--cwd=${home}`],
    // This fixture's "home" lives under the project's own test-results directory (see the
    // comment above), so it's inside this project's own git work tree — the prompt's git
    // segment would otherwise show this repo's own live branch/ahead/behind state, which has
    // nothing to do with what this smoke tests and would make lastRow()'s exact-text
    // assertions depend on that state. MULLION_GIT_PROMPT=0 keeps this fixture deterministic.
    env: { ...process.env, HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', TERMINAL_DEV_URL: '', MULLION_GIT_PROMPT: '0' },
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
  const popup = page.getByRole('listbox', { name: 'Command suggestions' });
  const ghost = page.locator('.shell-pane.active .inline-suggestion');
  const currentPath = () => page.locator('.current-path').getAttribute('title');
  const lastRow = () => page.evaluate(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
    .map(row => row.textContent.trim()).filter(Boolean).at(-1) ?? '');
  const ready = async () => { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await term.focus(); await page.waitForTimeout(180); };
  async function waitPath(expected, message) {
    await page.waitForFunction(value => document.querySelector('.current-path')?.getAttribute('title') === value,
      expected, { timeout: 15000 }).catch(() => assert.fail(message ?? `Shell did not reach ${expected}`));
  }
  async function typeAndRun(command) {
    await ready();
    await page.keyboard.type(command, { delay: 15 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
  }
  async function clearLine() {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+u');
    await page.waitForTimeout(80);
  }

  await ready();
  assert.equal(await currentPath(), home, 'The session must start at the fixture home');

  // Visit the deep directory once (a real, typed cd — not an app-injected navigation), then
  // return home. The main process should remember Alpha's full path from this one visit.
  await typeAndRun('cd Work/Projects/Alpha');
  await waitPath(alpha, 'Typed cd did not reach the nested fixture directory');
  await ready();
  await typeAndRun('cd');
  await waitPath(home, 'Bare cd did not return home');
  await ready();

  // Auto-complete ON: the popup must offer the full previously visited path, not just the
  // immediate `Work/` child, for a `~`-abbreviated prefix.
  await page.keyboard.type('cd ~/Wo', { delay: 30 });
  await popup.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(160);
  const deepLabel = popup.locator('.suggestion-label', { hasText: '~/Work/Projects/Alpha' });
  await deepLabel.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await deepLabel.count(), 1, 'The popup must offer the full visited path exactly once');
  await page.screenshot({ path: path.join(results, 'path-popup-tilde.png') });
  await clearLine();
  await ready();

  // Auto-complete OFF: the inline ghost must show the remainder of the full path.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-complete', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await ready();
  await page.keyboard.type('cd ~/Wo', { delay: 30 });
  await ghost.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(120);
  assert.equal(await popup.count(), 0, 'Auto-complete off must not also show a popup');
  assert.equal(await ghost.textContent(), 'rk/Projects/Alpha', 'The ghost must show the remainder of the full visited path');
  await page.screenshot({ path: path.join(results, 'path-ghost-tilde.png') });

  // Tab accepts the full path into the line without running it; Enter then navigates there.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert.equal(await ghost.count(), 0, 'Accepting the ghost must hide it');
  assert.equal(await currentPath(), home, 'Tab must not change the shell directory');
  await page.keyboard.press('Enter');
  await waitPath(alpha, 'Enter after accepting the ghost did not navigate to the visited directory');
  await ready();
  await typeAndRun('cd');
  await waitPath(home, 'Bare cd did not return home');
  await ready();

  // Regression: a bare (slash-free) typed token must never prefer a visited directory's
  // absolute path over a live, same-named child of the current directory — even once that
  // exact child has also been visited and remembered by its absolute path. cwd here
  // ("Work") has a real child "Projects/"; the visited list now also holds its absolute path.
  const work = path.join(home, 'Work');
  const projects = path.join(work, 'Projects');
  await typeAndRun('cd Work');
  await waitPath(work, 'Typed cd did not reach the Work fixture directory');
  await ready();
  await typeAndRun('cd Projects');
  await waitPath(projects, 'Typed cd did not reach the Projects fixture directory');
  await ready();
  await typeAndRun('cd ..');
  await waitPath(work, 'Typed cd .. did not return to Work');
  await ready();
  await page.keyboard.type('cd Projec', { delay: 30 });
  await ghost.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(120);
  assert.equal(await popup.count(), 0, 'Auto-complete off must not also show a popup');
  assert.equal(await ghost.textContent(), 'ts/',
    'The ghost must show the relative remainder "ts/" (completing to "Projects/"), never jump to the absolute visited path');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert.equal(await ghost.count(), 0, 'Accepting the ghost must hide it');
  assert.equal(await currentPath(), work, 'Tab must not change the shell directory');
  assert.ok((await lastRow()).endsWith('cd Projects/'),
    `Tab must insert the relative "cd Projects/", never the absolute visited path (got: ${await lastRow()})`);
  await page.keyboard.press('Enter');
  await waitPath(projects, 'Enter after accepting the ghost did not navigate to Projects');
  await ready();
  await typeAndRun('cd');
  await waitPath(home, 'Bare cd did not return home');
  await ready();

  // Re-enable auto-complete and confirm the same deep directory is also offered for a bare
  // directory name (no slash at all), matched by basename, lower priority than real children.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-complete', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await ready();
  await page.keyboard.type('cd Al', { delay: 30 });
  await popup.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(160);
  await popup.locator('.suggestion-label', { hasText: '~/Work/Projects/Alpha' }).waitFor({ state: 'visible', timeout: 5000 });
  await clearLine();
  await ready();

  // The visited directory is never a command: it must not appear in the history sidebar (either
  // tab) or the bottom "Most used" bar, and the `cd` commands themselves stay excluded too.
  await page.getByRole('button', { name: 'Command history', exact: true }).click();
  const sidebar = page.locator('.sidebar');
  await sidebar.waitFor({ state: 'visible' });
  for (const text of ['Work/Projects/Alpha', 'Visited']) {
    assert.equal(await sidebar.getByText(text, { exact: false }).count(), 0, `History sidebar must not mention "${text}"`);
  }
  assert.equal(await sidebar.locator('.history-entry').filter({ hasText: /^cd\b|^cd$/ }).count(), 0,
    'The history sidebar must not list bare cd commands');
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  for (const text of ['Work/Projects/Alpha', 'Visited']) {
    assert.equal(await sidebar.getByText(text, { exact: false }).count(), 0, `History sidebar (Recent) must not mention "${text}"`);
  }
  await page.getByRole('button', { name: 'Command history', exact: true }).click();
  await ready();
  const quick = page.locator('.quick-commands');
  for (const text of ['Work/Projects/Alpha', 'Visited', 'cd']) {
    assert.equal(await quick.getByText(text, { exact: false }).count(), 0, `The "Most used" bar must not mention "${text}"`);
  }

  assert.deepEqual(errors, []);
  console.log('Path smoke passed: a visited directory suggests its full path (popup and inline ghost, `~` and bare-name typing), Tab/Enter navigate there, and it never surfaces in the history sidebar or Most used bar.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'path-failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(profile, { recursive: true, force: true });
}
