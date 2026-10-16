import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// End-to-end: Settings › Appearance. A preset recolors the UI (CSS tokens) and every terminal
// (xterm.js theme) live; a prompt color reaches the already-open shell at its next prompt; font
// size and line height reach xterm.js; "Restore default appearance" (with its inline confirm and
// Undo) and the per-section resets bring back the Mullion look; and everything persists across a
// relaunch with the same --user-data-dir.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-appearance-smoke-')));
const fixture = path.join(temporary, 'workspace');
const project = path.join(fixture, 'project');
const bareOrigin = path.join(temporary, 'origin.git');
const profile = path.join(temporary, 'profile');
const preferences = path.join(temporary, 'preferences');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Mullion Smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function launch() {
  const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : [root]), `--user-data-dir=${preferences}`, `--cwd=${project}`],
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
  await page.setViewportSize({ width: 1180, height: 860 }).catch(() => {});
}

const cssVar = name => page.evaluate(value => getComputedStyle(document.documentElement).getPropertyValue(value).trim(), name);
// xterm.js's DOM renderer: the rows' computed font size, and the theme as xterm.js writes it
// into its own stylesheet — the rows' text color, and the block cursor's text color, which is
// `cursorAccent` (always the terminal background, see src/appearance.ts's xtermTheme).
const xtermFontSize = () => page.evaluate(() => getComputedStyle(document.querySelector('.shell-pane.active .xterm-rows')).fontSize);
const xtermColors = () => page.evaluate(() => {
  const owner = [...document.querySelector('.shell-pane.active .xterm').classList].find(name => name.startsWith('xterm-dom-renderer-owner-'));
  const sheet = [...document.querySelectorAll('style')].map(style => style.textContent).find(text => text.includes(`.${owner} .xterm-rows {`)) ?? '';
  return {
    foreground: /\.xterm-rows \{[^}]*?[^-]color: (#[0-9a-f]{6})/.exec(sheet)?.[1],
    background: /\.xterm-cursor\.xterm-cursor-block \{ background-color: #[0-9a-f]{6}; color: (#[0-9a-f]{6});/.exec(sheet)?.[1],
  };
});
const xtermBackground = async () => (await xtermColors()).background;
// The branch name inside the prompt's `git:(…)` on the last prompt line, and its rendered color.
const branchColor = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')].filter(row => /git:\(/.test(row.textContent));
  const span = [...(rows.at(-1)?.querySelectorAll('span') ?? [])].find(item => item.textContent === 'main');
  return span ? getComputedStyle(span).color : null;
});
const savedSettings = () => page.evaluate(() => window.terminalAPI.bootstrap().then(value => value.settings));

async function ready() { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(80); }
async function run(command) {
  await ready();
  await page.locator('.shell-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.type(command, { delay: 10 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await ready();
}
async function openAppearance() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.locator('.appearance-tab').waitFor();
}
async function closeSettings() { await page.getByRole('button', { name: 'Close settings' }).click(); }
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(message);
    await page.waitForTimeout(60);
  }
}

try {
  if (spawnSync('git', ['--version']).error) { console.log('Appearance smoke skipped: git is not installed.'); process.exit(0); }
  for (const directory of [project, profile, results]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(profile, '.zshrc'), ["export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0', ''].join('\n'));
  git(project, ['-c', 'init.defaultBranch=main', 'init']);
  await fs.writeFile(path.join(project, 'file.txt'), 'one\n');
  git(project, ['add', 'file.txt']);
  git(project, ['commit', '-m', 'initial']);
  spawnSync('git', ['init', '--bare', bareOrigin]);
  git(project, ['remote', 'add', 'origin', bareOrigin]);
  git(project, ['push', '-q', 'origin', 'main']);
  git(project, ['branch', '--set-upstream-to=origin/main', 'main']);
  git(project, ['commit', '--allow-empty', '-m', 'ahead by one']);

  await launch();
  await ready();
  await until(async () => (await branchColor()) !== null, 'The prompt never showed the git segment');

  // Defaults: exactly the stylesheet's dark tokens and the built-in terminal palette.
  assert.equal(await cssVar('--bg'), '#0e121a');
  assert.equal(await cssVar('--terminal-bg'), '#161c28');
  assert.equal(await branchColor(), 'rgb(214, 140, 240)', 'The default branch color is the palette magenta');
  assert.equal(await xtermFontSize(), '13px');
  const defaultXtermBackground = await xtermBackground();
  assert.equal(defaultXtermBackground, '#161c28', 'The default xterm.js background');
  const logo = await page.locator('.brand-mark').evaluate(element => getComputedStyle(element).backgroundColor);

  await openAppearance();
  await page.locator('.settings-modal').evaluate(element => { element.scrollTop = 0; });
  assert.equal(await page.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected'), 'true');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(results, 'appearance-settings.png') });
  assert.equal(await page.getByRole('button', { name: 'Restore default appearance' }).isDisabled(), true, 'Nothing to restore yet');

  // A preset recolors the UI and the terminal live.
  await page.getByLabel('Color preset').selectOption('dracula');
  await until(async () => (await cssVar('--bg')) === '#21222c', 'The UI background did not follow the preset');
  assert.equal(await cssVar('--terminal-bg'), '#282a36');
  await until(async () => (await xtermBackground()) === '#282a36', 'The xterm.js theme did not follow the preset');
  assert.equal((await xtermColors()).foreground, '#f8f8f2');
  assert.equal(await page.locator('.brand-mark').evaluate(element => getComputedStyle(element).backgroundColor), logo, 'The logo keeps its own colors');

  // A prompt color: typed as hex. The open shell picks it up at its next prompt.
  const branchHex = page.getByLabel('Branch hex value');
  await branchHex.fill('#ff0000');
  await branchHex.press('Enter');
  assert.equal(await page.getByLabel('Color preset').inputValue(), 'custom', 'Editing a color switches the preset to Custom');
  await until(async () => (await savedSettings()).appearance.prompt.branch === '#ff0000', 'The branch color was not saved');
  // Invalid hex is flagged and never applied.
  const pathHex = page.getByLabel('Path hex value');
  await pathHex.fill('#12zz');
  assert.equal(await pathHex.getAttribute('aria-invalid'), 'true');
  await pathHex.press('Enter');

  // Fonts: size and line height reach xterm.js.
  await page.getByLabel('Terminal font size').fill('16');
  await page.getByLabel('Line height').fill('1.4');
  await until(async () => (await xtermFontSize()) === '16px', 'xterm.js did not get the new font size');
  await page.getByLabel('Terminal font', { exact: true }).fill('Menlo');
  await page.waitForTimeout(300);
  await page.locator('.ansi-details summary').click();
  await page.locator('.color-row[data-color="prompt.branch"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(results, 'appearance-custom.png') });
  await closeSettings();

  await run('true');
  await until(async () => (await branchColor()) === 'rgb(255, 0, 0)', 'The next prompt did not use the new branch color');
  const fontFamily = await page.evaluate(() => getComputedStyle(document.querySelector('.shell-pane.active .xterm-rows')).fontFamily);
  assert.match(fontFamily, /^"?Menlo"?,/, 'The terminal font family reached xterm.js');

  // Persisted across a relaunch.
  await until(async () => { const value = await savedSettings(); return value.fontSize === 16 && value.appearance.fonts.lineHeight === 1.4 && value.appearance.fonts.terminalFamily === 'Menlo'; }, 'The fonts were not saved');
  await app.close();
  await launch();
  await ready();
  assert.equal(await cssVar('--bg'), '#21222c', 'The custom palette persists across a relaunch');
  assert.equal(await xtermFontSize(), '16px');
  await until(async () => (await branchColor()) === 'rgb(255, 0, 0)', 'A new shell starts with the saved prompt colors');

  // A section reset: only the prompt colors go back.
  await openAppearance();
  await page.getByRole('button', { name: 'Reset prompt colors' }).click();
  await until(async () => (await savedSettings()).appearance.prompt.branch === '', 'Reset prompt colors did not apply');
  assert.equal(await cssVar('--bg'), '#21222c', 'Other sections are untouched');

  // Restore default appearance: inline confirm, then Undo, then restore for good.
  const restore = page.getByRole('button', { name: 'Restore default appearance' });
  await restore.click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await cssVar('--bg'), '#21222c', 'Cancel keeps everything');
  await restore.click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await until(async () => (await cssVar('--bg')) === '#0e121a', 'Restore did not bring back the default background');
  assert.equal(await page.getByLabel('Color preset').inputValue(), 'mullion-dark');
  await until(async () => (await xtermFontSize()) === '13px', 'Restore did not bring back the default font size');
  await page.getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await cssVar('--bg')) === '#21222c', 'Undo did not bring the custom palette back');
  assert.equal(await page.getByLabel('Terminal font size').inputValue(), '16');
  await restore.click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await until(async () => { const value = await savedSettings(); return value.appearance.preset === 'mullion-dark' && value.fontSize === 13 && value.appearance.fonts.terminalFamily === '' && value.appearance.fonts.lineHeight === 1.22; }, 'Restore was not saved');
  assert.equal(await restore.isDisabled(), true);
  await closeSettings();
  await run('true');
  await until(async () => (await branchColor()) === 'rgb(214, 140, 240)', 'The prompt went back to the default branch color');
  assert.equal(await xtermBackground(), defaultXtermBackground);

  assert.deepEqual(errors, []);
  console.log('Appearance smoke passed: presets recolor the UI and terminals live, prompt colors reach open shells at the next prompt, fonts reach xterm.js, settings persist across relaunch, and section resets plus Restore default appearance (confirm + Undo) bring back the Mullion look.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'appearance-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
