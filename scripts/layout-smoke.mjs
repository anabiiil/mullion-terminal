import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-layout-smoke-')));
const fixture = path.join(temporary, 'workspace');
const profile = path.join(temporary, 'profile');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

try {
  for (const directory of [fixture, profile, results]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(fixture, 'index.html'), '<!doctype html><title>Layout fixture</title>\n');
  await fs.writeFile(path.join(profile, '.zshrc'), [
    "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
    "PROMPT='layout-test ❯ '", "RPROMPT=''", '',
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
    const before = (await history()).find(entry => entry.command === command)?.count ?? 0;
    await term.focus();
    await page.keyboard.type(command, { delay: 10 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await waitHistory(entries => entries.some(entry => entry.command === command && entry.count > before));
    await page.locator('.shell-state.ready').waitFor({ state: 'attached', timeout: 15000 });
  }
  await page.locator('.shell-state.ready').waitFor({ state: 'attached', timeout: 15000 });
  await term.focus();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(120);
  await page.locator('.shell-state.ready').waitFor({ state: 'attached', timeout: 15000 });
  assert.equal(await page.locator('.sidebar').count(), 0, 'The sidebar should start closed');
  assert.equal(await quick.count(), 1, 'The quick command row should be available before learning commands');
  assert.equal(await quick.getAttribute('aria-label'), 'Quick commands');
  assert.equal(await quick.locator('.quick-command').count(), 0, 'No placeholder commands before anything is learned');
  assert.match(await quick.innerText(), /Commands you run will show up here/);
  assert.equal(await page.locator('.page-heading, .page-actions, .terminal-footer, .frequent-bar, .activity-bar').count(), 0,
    'The terminal should not reserve screen space for dashboard panels');
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 0, 'The terminal should not have a page heading');
  assert.equal(await page.getByRole('button', { name: 'New terminal', exact: true }).count(), 0,
    'The tab plus should provide terminal creation');
  assert.equal(await page.getByRole('button', { name: 'New terminal tab', exact: true }).count(), 1);
  for (const label of ['Toggle files sidebar', 'Command history', 'Settings', 'Copy current path', 'Open current folder in file manager']) {
    const button = page.getByRole('button', { name: label, exact: true });
    assert.equal(await button.evaluate(element => Boolean(element.closest('.titlebar'))), true,
      `${label} should be in the compact topbar`);
    if (label !== 'Copy current path') assert.equal((await button.innerText()).trim(), '', `${label} should use an icon`);
  }
  assert.equal(await page.locator('.current-path').getAttribute('title'), fixture);
  assert.ok(!(await page.locator('.current-path').innerText()).includes(temporary),
    'The visible path should be shortened while its tooltip retains the full directory');
  assert.equal(await page.locator('.titlebar .editor-launcher').count(), 1, 'Project editor icons belong in the topbar');

  async function geometry() {
    return page.evaluate(() => {
      const bounds = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing layout element: ${selector}`);
        const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
        return { top, bottom, left, right, width, height };
      };
      return {
        workspace: bounds('.workspace'), main: bounds('.main-area'),
        terminal: bounds('.terminal-body'), titlebar: bounds('.titlebar'), tabs: bounds('.tab-bar'),
        pane: bounds('.shell-pane.active'), host: bounds('.shell-pane.active .xterm-host'), quick: bounds('.quick-commands'),
        viewport: { width: innerWidth, height: innerHeight },
        pageScroll: { x: scrollX, y: scrollY },
        pageOverflow: getComputedStyle(document.body).overflowY,
        controls: [...document.querySelectorAll('.titlebar .current-path, .titlebar .open-current-folder, .titlebar .editor-button')]
          .map(element => ({ title: element.getAttribute('aria-label'), ...boundsFor(element) })),
      };
      function boundsFor(element) {
        const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
        return { top, bottom, left, right, width, height };
      }
    });
  }

  function checkLayout(value, label, minimumUsable = 0.85) {
    const { workspace, main, terminal, titlebar, tabs, viewport } = value;
    const tolerance = 1;
    assert.ok(terminal.width * terminal.height / (workspace.width * workspace.height) >= 0.85,
      `${label}: the terminal should occupy at least 85% of the available workspace`);
    assert.ok(value.host.width * value.host.height / (workspace.width * workspace.height) >= minimumUsable,
      `${label}: the shell should retain enough usable screen space with the quick command row`);
    assert.ok(value.quick.height > 0 && value.quick.height < 38, `${label}: the bottom command row should stay slim`);
    assert.ok(Math.abs(value.quick.bottom - terminal.bottom) <= tolerance, `${label}: commands belong at the terminal's bottom edge`);
    assert.ok(value.pane.bottom <= value.quick.top + tolerance, `${label}: the command row must not cover shell output`);
    assert.ok(terminal.width >= workspace.width * 0.98, `${label}: the closed-sidebar terminal should use the full width`);
    assert.ok(titlebar.height >= 36 && titlebar.height <= 56, `${label}: topbar should be compact`);
    assert.ok(tabs.height >= 28 && tabs.height <= 42, `${label}: tabbar should be compact`);
    assert.ok(Math.abs(terminal.left - main.left) <= tolerance && Math.abs(terminal.right - main.right) <= tolerance,
      `${label}: the terminal should not have side margins`);
    assert.ok(Math.abs(terminal.bottom - workspace.bottom) <= tolerance, `${label}: the terminal should reach the workspace bottom`);
    assert.ok(Math.abs(workspace.bottom - viewport.height) <= tolerance, `${label}: the workspace should reach the window bottom`);
    assert.equal(value.pageScroll.y, 0, `${label}: the app should not scroll as a web page`);
    assert.equal(value.pageOverflow, 'hidden', `${label}: the app should keep page scrolling disabled`);
    for (const control of value.controls) {
      assert.ok(control.width > 0 && control.height > 0, `${label}: ${control.title} should have a visible clickable area`);
      assert.ok(control.left >= titlebar.left - tolerance && control.right <= titlebar.right + tolerance,
        `${label}: ${control.title} must stay inside the topbar`);
      assert.ok(control.top >= titlebar.top - tolerance && control.bottom <= titlebar.bottom + tolerance,
        `${label}: ${control.title} must stay within the topbar height`);
    }
  }

  await page.waitForTimeout(200);
  const initial = await geometry();
  checkLayout(initial, 'Default window');
  await page.screenshot({ path: path.join(results, 'terminal-full-layout.png') });
  // `test` (not `echo`) is used here because it is a real, meaningful command rather than
  // one of the basic/system commands the quick bar and history sidebar now hide.
  const learned = 'test layout-quick-learned';
  const other = 'test layout-quick-other';
  await run(learned);
  await quick.getByRole('button', { name: `Insert ${learned}`, exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await quick.getAttribute('aria-label'), 'Most-used commands');
  const beforeInsert = await history();
  await quick.getByRole('button', { name: `Insert ${learned}`, exact: true }).click();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.shell-pane.active .xterm-helper-textarea'),
    undefined, { timeout: 5000 });
  await page.waitForFunction(command => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
    .map(row => row.textContent.trim()).filter(Boolean).at(-1)?.endsWith(command), learned, { timeout: 10000 });
  assert.deepEqual(await history(), beforeInsert, 'Clicking a bottom command should fill it without executing it');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await waitHistory(entries => entries.find(entry => entry.command === learned)?.count === 2);
  await run(other);
  assert.equal(await quick.locator('.quick-command').first().getAttribute('aria-label'), `Insert ${learned}`,
    'The most-used command should rank first before pinning');
  await page.getByRole('button', { name: 'Command history', exact: true }).click();
  await page.getByRole('button', { name: `Pin ${other}`, exact: true }).click();
  await waitHistory(entries => entries.find(entry => entry.command === other)?.pinned === true);
  await page.getByRole('button', { name: 'Command history', exact: true }).click();
  await page.locator('.sidebar').waitFor({ state: 'hidden', timeout: 5000 });
  await page.waitForFunction(command => document.querySelector('.quick-command')?.getAttribute('aria-label') === `Insert ${command}`,
    other, { timeout: 10000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Suggestions while typing', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  assert.ok(await quick.isVisible(), 'Most-used commands should remain available when typing suggestions are off');
  await page.waitForTimeout(180);
  checkLayout(await geometry(), 'Learned bottom commands');
  await page.screenshot({ path: path.join(results, 'terminal-quick-commands.png') });
  await term.focus();
  const command = "for i in {1..90}; do printf 'layout-row-%s\\n' \"$i\"; done";
  await page.keyboard.type(command, { delay: 3 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.shell-pane.active .xterm-rows')?.textContent?.includes('layout-row-90'),
    undefined, { timeout: 15000 });
  await page.locator('.shell-state.ready').waitFor({ state: 'attached', timeout: 15000 });
  const scrolled = await geometry();
  checkLayout(scrolled, 'After terminal scroll');
  assert.deepEqual(scrolled.titlebar, initial.titlebar, 'Scrolling shell output should leave the topbar fixed');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(500, 360);
    window.setSize(860, 580);
  });
  await page.waitForFunction(() => innerWidth <= 870 && innerHeight <= 590, undefined, { timeout: 10000 });
  await page.waitForTimeout(200);
  checkLayout(await geometry(), 'Compact window', 0.80);
  await page.screenshot({ path: path.join(results, 'terminal-full-layout-small.png') });
  assert.deepEqual(errors, []);
  console.log('Layout smoke passed: full terminal, fixed compact controls, slim bottom commands, learned/pinned ordering, click fills without execution, typing-suggestion independence and responsive sizing.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'layout-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
