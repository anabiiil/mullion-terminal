import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Run after npm run build. An optional packaged executable can exercise a release.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-popup-smoke-'));
const fixture = path.join(temporary, 'workspace');
const bin = path.join(temporary, 'bin');
const emptyTokenRoot = path.join(fixture, 'empty tokens');
const emptyTokenFolder = path.join(emptyTokenRoot, 'first folder');
const emptyTokenFile = path.join(emptyTokenFolder, 'a fixture file.txt');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

try {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(path.join(fixture, 'projects'), { recursive: true });
  await fs.mkdir(emptyTokenFolder, { recursive: true });
  await fs.writeFile(emptyTokenFile, 'Disposable completion fixture\n');
  await fs.writeFile(path.join(fixture, 'notes.txt'), 'popup fixture\n');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(results, { recursive: true });
  // ZDOTDIR isolates shell startup/history without changing the user's HOME.
  await fs.writeFile(path.join(fixture, '.zshrc'), [
    `export PATH='${bin}:/usr/bin:/bin'`,
    "HISTFILE=''",
    'SAVEHIST=0',
    'HISTSIZE=0',
    "PROMPT='popup-test ❯ '",
    "RPROMPT=''",
    '',
  ].join('\n'));
  for (let index = 0; index < 10; index++) {
    await fs.writeFile(path.join(bin, `p_fixture_${index}`), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }

  const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    args: [
      ...(executablePath ? [] : [root]),
      `--user-data-dir=${path.join(temporary, 'preferences')}`,
      `--cwd=${fixture}`,
    ],
    env: { ...process.env, ZDOTDIR: fixture, SHELL: '/bin/zsh', TERMINAL_DEV_URL: '' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  // Keep real user keystrokes away from this isolated test shell.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.removeAllListeners('ready-to-show');
    window.hide();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    window.__popupSmokeSessions = {};
    window.terminalAPI.onEvent(event => {
      if (event.type === 'state') window.__popupSmokeSessions[event.session.id] = event.session;
    });
  });
  const term = page.locator('.shell-pane.active .xterm-helper-textarea');
  const popup = page.getByRole('listbox', { name: 'Command suggestions' });
  const ghost = page.locator('.shell-pane.active .inline-suggestion');
  const history = () => page.evaluate(async () => (await window.terminalAPI.bootstrap()).history);
  async function waitHistory(predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const entries = await history();
      if (predicate(entries)) return entries;
      await page.waitForTimeout(50);
    }
    assert.fail('Command history did not reach the expected state within 15 seconds');
  }

  async function ready() {
    await page.locator('.shell-state.ready').waitFor({ state: 'attached', timeout: 15000 });
    await term.focus();
    await page.waitForTimeout(180);
  }

  async function show(prefix) {
    await term.focus();
    await page.keyboard.type(prefix, { delay: 30 });
    await popup.waitFor({ state: 'visible', timeout: 10000 });
    // Wait for the popup animation and renderer cursor update to finish.
    await page.waitForTimeout(160);
  }

  async function showGhost(prefix, suffix) {
    await term.focus();
    await page.keyboard.type(prefix, { delay: 30 });
    await ghost.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(120);
    assert.equal(await popup.count(), 0, 'Auto-complete off must not show a suggestion popup');
    assert.equal(await ghost.textContent(), suffix, 'The inline suggestion must show only the missing suffix');
    const style = await ghost.evaluate(element => ({
      opacity: Number(getComputedStyle(element).opacity),
      pointerEvents: getComputedStyle(element).pointerEvents,
    }));
    assert.ok(style.opacity > 0 && style.opacity < 1, 'The inline completion must be faint and visible');
    assert.equal(style.pointerEvents, 'none', 'Inline completion must not intercept terminal input');
  }

  async function run(command) {
    await ready();
    const before = (await history()).find(entry => entry.command === command)?.count ?? 0;
    await page.keyboard.type(command, { delay: 5 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await waitHistory(entries => entries.some(entry => entry.command === command && entry.count > before));
    await ready();
  }

  async function geometry() {
    return page.evaluate(() => {
      const pane = document.querySelector('.shell-pane.active');
      // The bottom command row reserves space outside the active shell pane.
      const body = pane;
      const popup = pane?.querySelector('.suggestions');
      const cursor = pane?.querySelector('.xterm-rows .xterm-cursor')
        ?? pane?.querySelector('.xterm-helper-textarea');
      const list = popup?.querySelector('.suggestion-items');
      const selected = list?.querySelector('[aria-selected=true]');
      if (!body || !popup || !cursor || !list || !selected) throw new Error('Popup or cursor geometry is unavailable.');
      const rect = element => {
        const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
        return { left, top, right, bottom, width, height };
      };
      return {
        body: rect(body), popup: rect(popup), cursor: rect(cursor),
        list: rect(list), selected: rect(selected),
        scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
        optionCount: list.querySelectorAll('[role=option]').length,
      };
    });
  }

  function insideBody(value, label) {
    const { body, popup } = value;
    const tolerance = 0.75;
    assert.ok(popup.width > 0 && popup.height > 0, `${label}: popup must have a visible area`);
    assert.ok(popup.left >= body.left - tolerance, `${label}: popup must stay inside the left edge`);
    assert.ok(popup.right <= body.right + tolerance, `${label}: popup must stay inside the right edge`);
    assert.ok(popup.top >= body.top - tolerance, `${label}: popup must not be clipped above the terminal`);
    assert.ok(popup.bottom <= body.bottom + tolerance, `${label}: popup must not be clipped below the terminal`);
  }

  function selectedVisible(value, label) {
    assert.ok(value.selected.top >= value.list.top - 0.75, `${label}: selected command must stay above the list's top edge`);
    assert.ok(value.selected.bottom <= value.list.bottom + 0.75, `${label}: selected command must stay above the list's bottom edge`);
  }

  await ready();
  // A native keystroke could arrive during the short launch-to-hide interval.
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(async () => (await window.terminalAPI.bootstrap()).history.length), 0,
    'The regression must start with an empty isolated command history');
  // Auto-complete ON keeps the empty-argument popup guard.
  for (const prefix of ['cd ', 'rm ']) {
    await page.keyboard.type(prefix, { delay: 30 });
    await page.waitForTimeout(220);
    assert.equal(await popup.count(), 0, 'Auto-complete on must not show a popup for an empty file argument');
    assert.equal(await ghost.count(), 0, 'Auto-complete on must not show inline ghost text');
    await page.keyboard.press('Control+u');
    await page.waitForTimeout(80);
  }
  await show('pw');
  assert.ok(await popup.locator('.suggestion-label').filter({ hasText: /^pwd$/ }).count(), 'The real shell must suggest pwd');
  const top = await geometry();
  insideBody(top, 'First prompt');
  assert.ok(top.cursor.top - top.body.top < top.cursor.height * 2,
    'The first prompt must be near the top of the terminal');
  assert.ok(top.popup.top >= top.cursor.bottom - 0.75,
    'The first prompt popup must open below the cursor row');
  await page.screenshot({ path: path.join(results, 'popup-top.png') });

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  await ready();
  await page.keyboard.type("for i in {1..80}; do printf 'popup-row-%s\\n' \"$i\"; done", { delay: 3 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.shell-pane.active .xterm-rows')?.textContent?.includes('popup-row-80'));
  await ready();
  await show('pw');
  const bottom = await geometry();
  insideBody(bottom, 'Bottom prompt');
  assert.ok(bottom.body.bottom - bottom.cursor.bottom < bottom.cursor.height * 2,
    'The scrolling fixture must leave the prompt at the bottom');
  assert.ok(bottom.popup.bottom <= bottom.cursor.top + 0.75,
    'With no room below, the popup must open above the cursor row');
  await page.screenshot({ path: path.join(results, 'popup-bottom.png') });

  // Resize the native window while a suggestion is already open.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(500, 360);
    window.setSize(600, 440);
  });
  await page.waitForFunction(() => window.innerWidth <= 610 && window.innerHeight <= 450);
  await popup.waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  insideBody(await geometry(), 'Resized popup');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(120);
  await show('p');
  const small = await geometry();
  insideBody(small, 'Small window');
  assert.ok(small.optionCount >= 8, 'The fixture must provide enough commands to scroll');
  assert.ok(small.scrollHeight > small.clientHeight + 1, 'A constrained suggestion list must scroll');
  selectedVisible(small, 'Initial selection');
  for (let index = 1; index < small.optionCount; index++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(60);
    const current = await geometry();
    insideBody(current, `Selection ${index}`);
    selectedVisible(current, `Selection ${index}`);
  }
  await page.screenshot({ path: path.join(results, 'popup-small.png') });

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  await ready();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
  await page.waitForFunction(() => window.innerWidth >= 1300);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-complete', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await ready();

  // Off mode offers faint inline completion; Tab fills without running it.
  await showGhost('pw', 'd');
  assert.ok(!(await history()).some(entry => entry.command === 'pwd'));
  await page.screenshot({ path: path.join(results, 'suggestion-inline-command.png') });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert.equal(await ghost.count(), 0, 'Accepting the inline suffix must hide it');
  assert.ok(!(await history()).some(entry => entry.command === 'pwd'), 'Tab must not execute a command');
  await page.keyboard.press('Enter');
  await waitHistory(entries => entries.some(entry => entry.command === 'pwd'));
  await ready();

  await showGhost('cd pro', 'jects/');
  await page.screenshot({ path: path.join(results, 'suggestion-inline-path.png') });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert.ok((await page.locator('.current-path').getAttribute('title')).endsWith('/workspace'),
    'Tab must not change the shell directory');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.current-path')?.getAttribute('title')?.endsWith('/projects'));
  await ready();
  await run('cd ..');

  // A learned command appears inline, and Enter preserves exactly typed input.
  await run('echo ghost-smoke-learned');
  await showGhost('echo ghost-s', 'moke-learned');
  await page.screenshot({ path: path.join(results, 'suggestion-inline-history.png') });
  await page.keyboard.press('Enter');
  await waitHistory(entries => entries.some(entry => entry.command === 'echo ghost-s'));
  await ready();
  assert.equal((await history()).find(entry => entry.command === 'echo ghost-smoke-learned').count, 1,
    'Enter with auto-complete off must not execute the suggested learned command');
  await showGhost('echo ghost-s', 'moke-learned');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  assert.equal((await history()).find(entry => entry.command === 'echo ghost-smoke-learned').count, 1);
  await page.keyboard.press('Enter');
  await waitHistory(entries => entries.find(entry => entry.command === 'echo ghost-smoke-learned')?.count === 2);
  await ready();

  // OFF mode completes empty file arguments using this folder, without history.
  const sessionId = await page.evaluate(() => Object.values(window.__popupSmokeSessions).find(session => session.ready).id);
  async function clearHistory() {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Clear history', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm clear', exact: true }).click();
    await waitHistory(entries => entries.length === 0);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.quick-commands')?.getAttribute('aria-label') === 'Quick commands',
      undefined, { timeout: 10000 });
    await ready();
  }
  async function navigate(directory) {
    await page.evaluate(({ sessionId, directory }) => window.terminalAPI.changeDirectory(sessionId, directory), { sessionId, directory });
    await page.waitForFunction(expected => document.querySelector('.current-path')?.getAttribute('title') === expected,
      directory, { timeout: 15000 });
    await ready();
    await clearHistory();
    assert.deepEqual(await history(), [], 'Empty argument completion must start without saved command history');
  }
  await navigate(emptyTokenRoot);
  await showGhost('cd', " 'first folder/'");
  await page.keyboard.press('Enter');
  const home = await page.evaluate(() => window.terminalAPI.bootstrap().then(value => value.home));
  await page.waitForFunction(expected => document.querySelector('.current-path')?.getAttribute('title') === expected,
    home, { timeout: 15000 });
  await waitHistory(entries => entries.some(entry => entry.command === 'cd'));
  assert.ok(!(await history()).some(entry => entry.command.includes('first folder')),
    'Enter with plain cd must run the typed command rather than choosing an arbitrary folder');

  await navigate(emptyTokenRoot);
  await showGhost('cd ', "'first folder/'");
  await page.screenshot({ path: path.join(results, 'suggestion-inline-empty-cd.png') });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.current-path').getAttribute('title'), emptyTokenRoot, 'Tab must not execute empty-token cd');
  assert.deepEqual(await history(), [], 'Tab must fill without recording or running the command');
  await page.keyboard.press('Enter');
  await page.waitForFunction(expected => document.querySelector('.current-path')?.getAttribute('title') === expected,
    emptyTokenFolder, { timeout: 15000 });
  await waitHistory(entries => entries.some(entry => entry.command === "cd 'first folder/'"));
  await ready();
  await clearHistory();
  await showGhost('rm ', "'a fixture file.txt'");
  await page.screenshot({ path: path.join(results, 'suggestion-inline-empty-rm.png') });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
    .map(row => row.textContent.trim()).filter(Boolean).at(-1)?.endsWith("rm 'a fixture file.txt'"), undefined, { timeout: 10000 });
  assert.deepEqual(await history(), [], 'Tab must not execute or record the suggested rm command');
  assert.equal(await fs.readFile(emptyTokenFile, 'utf8'), 'Disposable completion fixture\n',
    'The disposable file must remain intact after rm completion');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  await ready();

  assert.deepEqual(errors, []);
  console.log('Suggestion smoke passed: popup bounds, resize/scrolling, inline command/path/history, fresh-history cd/rm empty-token completion, Tab fills and Enter preserves typed commands.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'popup-failure.png') }).catch(() => {});
  if (page) console.error('Isolated terminal diagnostics:', await page.evaluate(() => ({
    ready: Boolean(document.querySelector('.shell-state.ready')),
    popupCount: document.querySelectorAll('.suggestions').length,
    inlineCount: document.querySelectorAll('.inline-suggestion').length,
  })).catch(() => null));
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
