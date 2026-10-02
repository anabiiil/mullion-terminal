import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Run after npm run build; MULLION_SMOKE_EXECUTABLE can target a release.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-tree-smoke-')));
const fixture = path.join(temporary, 'workspace');
const project = path.join(fixture, 'project');
const source = path.join(project, 'src');
const outside = path.join(temporary, 'outside');
const profile = path.join(temporary, 'profile');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

try {
  for (const directory of [source, path.join(fixture, 'assets'), path.join(fixture, 'notes'), outside, profile, results]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.writeFile(path.join(source, 'example.txt'), 'Tree selection fixture\n');
  // Isolate startup and history through ZDOTDIR while preserving the user's HOME.
  await fs.writeFile(path.join(profile, '.zshrc'), [
    "export PATH='/usr/bin:/bin'",
    "HISTFILE=''",
    'SAVEHIST=0',
    'HISTSIZE=0',
    "PROMPT='tree-test ❯ '",
    "RPROMPT=''",
    '',
  ].join('\n'));

  const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    args: [
      ...(executablePath ? [] : [root]),
      `--user-data-dir=${path.join(temporary, 'preferences')}`,
      `--cwd=${fixture}`,
    ],
    env: { ...process.env, ZDOTDIR: profile, SHELL: '/bin/zsh', TERMINAL_DEV_URL: '' },
    timeout: 30000,
  });
  // Keep the regression from receiving native keyboard input intended for the user.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.removeAllListeners('ready-to-show');
      window.hide();
    }
  });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    window.__treeSmokeStates = {};
    window.terminalAPI.onEvent(event => {
      if (event.type === 'state') window.__treeSmokeStates[event.session.id] = event.session;
    });
  });
  const bootstrap = await page.evaluate(() => window.terminalAPI.bootstrap());
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
  const term = page.locator('.shell-pane.active .xterm-helper-textarea');
  const treeRoot = page.locator('.explorer-root span[title]');
  // Match the full title instead of text, so similarly named branches cannot pass.
  const row = directory => page.locator('.tree-name').and(page.locator(`[title=${JSON.stringify(directory)}]`));
  const selected = directory => page.locator('.tree-row.current .tree-name').and(page.locator(`[title=${JSON.stringify(directory)}]`));

  async function ready(expectedDirectory) {
    await page.waitForFunction(directory => {
      const ready = document.querySelector('.shell-state.ready');
      const cwd = document.querySelector('.current-path')?.getAttribute('title');
      return Boolean(ready) && (directory === undefined || cwd === directory);
    }, expectedDirectory, { timeout: 15000 });
  }

  async function expectRoot(expectedDirectory) {
    await page.waitForFunction(directory => document.querySelector('.explorer-root span[title]')?.getAttribute('title') === directory,
      expectedDirectory, { timeout: 10000 });
    assert.equal(await treeRoot.getAttribute('title'), expectedDirectory,
      'Navigating should preserve the explorer root while the cwd remains inside it');
  }

  async function expectSelected(expectedDirectory) {
    if (await treeRoot.getAttribute('title') === expectedDirectory) {
      await page.locator('.explorer-root.current').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await page.locator('.tree-scroll .tree-row.current').count(), 0,
        'The root should be selected without selecting a child directory');
      return;
    }
    await selected(expectedDirectory).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('.tree-row.current .tree-name').count(), 1,
      'Exactly one directory row should represent the shell cwd');
    assert.equal(await selected(expectedDirectory).getAttribute('title'), expectedDirectory);
  }

  // A lighter check than expectSameShell for use after other tabs have come
  // and gone: it does not rely on window.__treeSmokeStates, which keeps every
  // session id it has ever seen even once a tab closes.
  async function expectNoNewSession() {
    assert.equal(await page.locator('[role=tab]').count(), 1, 'A tree click must not create a new terminal tab');
    assert.equal(await page.locator('.shell-pane').count(), 1, 'A tree click must not create a new terminal pane');
    assert.deepEqual(await history(), beforeNavigationHistory, 'Tree expansion must not pollute command history');
  }

  async function run(command, expectedDirectory) {
    await ready();
    const before = (await history()).find(entry => entry.command === command)?.count ?? 0;
    await term.focus();
    await page.keyboard.type(command, { delay: 15 });
    // Escape makes Enter execute this exact command rather than a suggestion.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await waitHistory(entries => entries.some(entry => entry.command === command && entry.count > before));
    await ready(expectedDirectory);
  }

  await ready(fixture);
  await term.focus();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(120);
  await ready(fixture);
  assert.equal(await page.locator('[role=tab]').count(), 1);
  assert.equal(await page.locator('.sidebar').count(), 0, 'The files sidebar should be closed on startup');
  await run("MULLION_TREE_TOKEN='same-shell'; printf 'tree-output-before-navigation\\n'", fixture);
  const pendingCommand = 'echo pending-tree-complete-$MULLION_TREE_TOKEN';
  await run(pendingCommand, fixture);
  await page.evaluate(() => { window.__treeSmokePane = document.querySelector('.shell-pane.active'); });
  let beforeNavigationHistory = await waitHistory(entries => entries.some(entry => entry.command === pendingCommand && entry.count === 1));
  async function expectSameShell() {
    assert.equal(await page.evaluate(() => document.querySelector('.shell-pane.active') === window.__treeSmokePane), true,
      'Folder navigation must retain the existing terminal pane');
    assert.equal(await page.locator('.shell-pane').count(), 1, 'Folder navigation must not create a terminal');
    assert.equal(await page.evaluate(() => Object.keys(window.__treeSmokeStates).length), 1,
      'Folder navigation must retain the original terminal session');
    const output = await page.locator('.shell-pane.active .xterm-rows').innerText();
    assert.ok(output.includes('tree-output-before-navigation'), 'Earlier terminal output must survive folder navigation');
    assert.ok(!output.includes(temporary), 'Folder navigation must not echo an injected command or full path');
    assert.doesNotMatch(output, /builtin\s+cd/, 'Internal navigation commands must stay out of visible terminal output');
    assert.deepEqual(await history(), beforeNavigationHistory, 'Sidebar navigation must not pollute command history');
  }
  await page.getByRole('button', { name: 'Toggle files sidebar', exact: true }).click();
  await expectRoot(fixture);
  await expectSelected(fixture);
  for (const directory of [project, path.join(fixture, 'assets'), path.join(fixture, 'notes')]) {
    await row(directory).waitFor({ state: 'visible', timeout: 10000 });
  }

  // A single click only toggles a folder open or closed; it must never cd.
  await page.getByRole('button', { name: 'Expand project', exact: true }).waitFor({ timeout: 10000 });
  await row(project).click();
  await page.getByRole('button', { name: 'Collapse project', exact: true }).waitFor({ timeout: 10000 });
  await row(source).waitFor({ state: 'visible', timeout: 10000 });
  await ready(fixture);
  await expectRoot(fixture);
  await expectSelected(fixture);
  await row(project).click();
  await page.getByRole('button', { name: 'Expand project', exact: true }).waitFor({ timeout: 10000 });
  await row(source).waitFor({ state: 'hidden', timeout: 10000 });
  await ready(fixture);
  await expectRoot(fixture);
  await expectSelected(fixture);

  // Double-clicking a child changes the real shell and selects it without replacing the tree.
  await term.focus();
  await page.keyboard.type('echo pend', { delay: 30 });
  await page.getByRole('listbox', { name: 'Command suggestions' }).waitFor({ state: 'visible', timeout: 10000 });
  await row(project).dblclick();
  await ready(project);
  await expectRoot(fixture);
  await expectSelected(project);
  await expectSameShell();
  for (const directory of [path.join(fixture, 'assets'), path.join(fixture, 'notes')]) {
    assert.ok(await row(directory).isVisible(), 'Sibling folders must remain visible after clicking a directory');
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
    .map(row => row.textContent.trim()).filter(Boolean).at(-1)?.endsWith('echo pend'), undefined, { timeout: 10000 });
  await term.focus();
  await page.keyboard.type('ing-tree-complete-$MULLION_TREE_TOKEN', { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await waitHistory(entries => entries.find(entry => entry.command === pendingCommand)?.count === 2);
  await ready(project);
  await page.waitForFunction(() => (document.querySelector('.shell-pane.active .xterm-rows')?.textContent
    ?.split('pending-tree-complete-same-shell').length ?? 0) - 1 === 2, undefined, { timeout: 10000 });
  const pendingOutput = await page.locator('.shell-pane.active .xterm-rows').innerText();
  assert.equal(pendingOutput.split('pending-tree-complete-same-shell').length - 1, 2,
    'The retained pending command must execute in full and keep its shell variable');
  assert.ok(!(await history()).some(entry => entry.command === 'ing-tree-complete-$MULLION_TREE_TOKEN'),
    'A navigation redraw must not cause completion tracking to record only the typed suffix');
  beforeNavigationHistory = await history();
  await page.screenshot({ path: path.join(results, 'tree-selected.png') });

  const expandProject = page.getByRole('button', { name: 'Expand project', exact: true });
  if (await expandProject.count()) await expandProject.click();
  await row(source).waitFor({ state: 'visible', timeout: 10000 });
  await row(source).dblclick();
  await ready(source);
  await expectRoot(fixture);
  await expectSelected(source);
  await expectSameShell();
  assert.ok(await row(project).isVisible(), 'An ancestor should remain in the tree when its child is selected');
  await page.screenshot({ path: path.join(results, 'tree-nested-selected.png') });
  await run('printf "tree-token=%s\\n" "$MULLION_TREE_TOKEN"', source);
  assert.ok((await page.locator('.shell-pane.active .xterm-rows').innerText()).includes('tree-token=same-shell'),
    'A shell variable must survive folder clicks in the same PTY');

  // A typed cd must update selection and reveal a collapsed ancestor automatically.
  await run('cd ..', project);
  await expectRoot(fixture);
  await expectSelected(project);
  const collapseProject = page.getByRole('button', { name: 'Collapse project', exact: true });
  if (await collapseProject.count()) await collapseProject.click();
  await run('cd src', source);
  await expectSelected(source);
  await expectRoot(fixture);

  // Both sidebar remount paths must reveal the selected nested directory.
  await page.getByRole('button', { name: 'Toggle files sidebar', exact: true }).click();
  await page.locator('.explorer-root').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Toggle files sidebar', exact: true }).click();
  await expectRoot(fixture);
  await expectSelected(source);
  await page.getByRole('button', { name: 'Command history', exact: true }).click();
  await page.locator('.history-list').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Toggle files sidebar', exact: true }).click();
  await expectRoot(fixture);
  await expectSelected(source);

  // Leaving a root broadens it only far enough to include the previous root and cwd.
  await run('cd ../../../outside', outside);
  await expectRoot(temporary);
  await expectSelected(outside);
  assert.ok(await row(fixture).isVisible(), 'The former root must remain visible after navigating outside it');
  await run('cd ../workspace/project/src', source);
  await expectRoot(temporary);
  await expectSelected(source);

  // Both plus and the keyboard shortcut start independent terminals at Home.
  await page.getByRole('button', { name: 'New terminal tab', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2, undefined, { timeout: 15000 });
  await ready(bootstrap.home);
  assert.equal(await page.locator('[role=tab]').count(), 2);
  await expectRoot(bootstrap.home);
  await expectSelected(bootstrap.home);
  await page.locator('[role=tab]').nth(0).click();
  await ready(source);
  await expectRoot(temporary);
  await expectSelected(source);
  await page.locator('[role=tab]').nth(1).click();
  await ready(bootstrap.home);
  await expectRoot(bootstrap.home);
  await expectSelected(bootstrap.home);
  await term.focus();
  await page.keyboard.press(bootstrap.platform === 'darwin' ? 'Meta+t' : 'Control+t');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 3, undefined, { timeout: 15000 });
  await ready(bootstrap.home);
  await expectRoot(bootstrap.home);
  await expectSelected(bootstrap.home);
  await page.getByRole('button', { name: 'Close terminal 3', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2, undefined, { timeout: 10000 });
  await page.locator('[role=tab]').nth(0).click();
  await ready(source);
  await expectRoot(temporary);
  await expectSelected(source);
  await page.getByRole('button', { name: 'Close terminal 2', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1, undefined, { timeout: 10000 });
  await ready(source);
  assert.equal(await page.locator('[role=tab]').count(), 1);
  await expectRoot(temporary);
  await expectSelected(source);

  // A single click on a sibling folder only expands it; the shell never moves.
  beforeNavigationHistory = await history();
  const assetsDirectory = path.join(fixture, 'assets');
  await row(assetsDirectory).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: 'Expand assets', exact: true }).waitFor({ timeout: 10000 });
  await row(assetsDirectory).click();
  await page.getByRole('button', { name: 'Collapse assets', exact: true }).waitFor({ timeout: 10000 });
  await ready(source);
  await expectRoot(temporary);
  await expectSelected(source);
  await expectNoNewSession();

  // Double-clicking a file edits it with nano in the active shell, using a path relative to cwd.
  const expandSource = page.getByRole('button', { name: 'Expand src', exact: true });
  await expandSource.waitFor({ timeout: 10000 });
  await expandSource.click();
  const exampleFile = path.join(source, 'example.txt');
  const beforeEditHistory = await history();
  await row(exampleFile).waitFor({ state: 'visible', timeout: 10000 });
  await row(exampleFile).dblclick();
  await page.locator('.editor-bar').waitFor({ timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
    .some(line => line.textContent.includes('Tree selection fixture')), undefined, { timeout: 10000 });
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  await page.locator('.editor-bar').waitFor({ state: 'detached', timeout: 5000 });
  await ready(source);
  await expectRoot(temporary);
  await expectSelected(source);
  assert.deepEqual(await history(), beforeEditHistory,
    'The app opening nano on the user\'s behalf from the tree must never be learned as command history');

  assert.deepEqual(errors, []);
  console.log('Tree smoke passed: click-to-expand without cd, double-click-to-cd and double-click-to-edit with nano (never recorded in history), silent same-PTY navigation, retained variables/output, clean history, stable selected roots, ancestors, sidebar remounts and Home tabs from plus/shortcut.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'tree-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
