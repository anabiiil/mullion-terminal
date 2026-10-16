import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// End-to-end: multiple windows. A `mullion-terminal://open` link (what the
// Finder Quick Actions send) with mode=window opens a window whose only tab
// is the target; mode=tab adds a tab to the most recently focused window;
// invalid links are ignored; each window owns its shells (another window
// can't drive them, and closing a window ends only its own); New Window
// shortcuts (Cmd+N / Ctrl+Shift+N, plain Ctrl+N except inside full-screen
// programs); --open-mode=window on a second launch; the "Open with" setting;
// settings changes reaching every window; and Open folder adding a new tab.
// Run after `npm run build`; MULLION_SMOKE_EXECUTABLE can target a packaged
// release instead of the source tree.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-window-smoke-')));
const home = path.join(temporary, 'home');
const windowFolder = path.join(temporary, 'window folder');
const tabFolder = path.join(temporary, 'tab-folder');
const argvFolder = path.join(temporary, 'argv-folder');
const chosenFolder = path.join(temporary, 'chosen folder');
const settingFolder = path.join(temporary, 'setting-folder');
for (const directory of [home, windowFolder, tabFolder, argvFolder, chosenFolder, settingFolder]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(home, '.zshrc'), [
  "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
  'PROMPT="%F{cyan}%~%f %F{yellow}❯%f "', "RPROMPT=''", '',
].join('\n'));
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
const isPackaged = Boolean(executablePath);
const mac = process.platform === 'darwin';
const env = { ...process.env, ZDOTDIR: home, SHELL: process.env.MULLION_SMOKE_SHELL || '/bin/zsh', TERMINAL_DEV_URL: '' };
const app = await electron.launch({
  executablePath,
  args: [...(isPackaged ? [] : [root]), `--user-data-dir=${path.join(temporary, 'preferences')}`, `--cwd=${home}`],
  env, timeout: 30000,
});
// Keep every window (including ones opened later) off screen. A hidden
// window never gets native focus events, so focus() is simulated by
// emitting 'focus', which is what the app tracks for "most recent window".
await app.evaluate(({ app, BrowserWindow }) => {
  const quiet = window => {
    window.removeAllListeners('ready-to-show');
    window.hide();
    window.show = () => {};
    window.focus = () => window.emit('focus');
  };
  for (const window of BrowserWindow.getAllWindows()) quiet(window);
  app.on('browser-window-created', (_event, window) => quiet(window));
});
const errors = [];
const watch = page => page.on('pageerror', error => errors.push(error.message));
const first = await app.firstWindow();
watch(first);
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const tabCount = page => page.locator('[role=tab]').count();
const currentPath = page => page.evaluate(() => document.querySelector('.current-path')?.getAttribute('title'));
const ready = async page => { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(180); };
const link = (mode, target) => `mullion-terminal://open?mode=${mode}&path=${encodeURIComponent(target)}`;
const emitUrl = url => app.evaluate(({ app }, value) => app.emit('open-url', { preventDefault() {} }, value), url);
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.fail(message);
}
async function nextWindow(trigger) {
  const opened = app.waitForEvent('window', { timeout: 15000 });
  await trigger();
  const page = await opened;
  watch(page);
  await page.waitForLoadState('domcontentloaded');
  return page;
}
// Marks each window's page title with a smoke id so a page can be mapped back to its BrowserWindow.
async function windowId(page) {
  const mark = `smoke-${Math.random().toString(36).slice(2)}`;
  await page.evaluate(value => { document.title = value; }, mark);
  return mark;
}
const focusWindow = mark => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows().find(window => window.webContents.getTitle() === value)?.focus(), mark);
const closeWindow = mark => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows().find(window => window.webContents.getTitle() === value)?.close(), mark);
async function typeLine(page, line) {
  await page.locator('.shell-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.type(line, { delay: 12 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
}
const screenText = page => page.evaluate(() => document.querySelector('.shell-pane.active .xterm-rows')?.textContent ?? '');

let current = first;
try {
  await ready(first);
  assert.equal(await tabCount(first), 1);
  const firstMark = await windowId(first);

  // mode=window: a second window whose only tab is the target (no extra Home tab).
  const second = await nextWindow(() => emitUrl(link('window', windowFolder)));
  current = second;
  await ready(second);
  assert.equal(await windowCount(), 2);
  assert.equal(await tabCount(second), 1, 'A window opened for a link should hold only that tab');
  await until(async () => (await currentPath(second)) === windowFolder, 'The new window\'s tab should sit in the linked folder');
  const secondMark = await windowId(second);
  assert.equal(await tabCount(first), 1, 'The first window is untouched');

  // mode=tab goes to the most recently focused window.
  await focusWindow(firstMark);
  await emitUrl(link('tab', tabFolder));
  await until(async () => (await tabCount(first)) === 2, 'mode=tab should add a tab to the focused (first) window');
  await until(async () => (await currentPath(first)) === tabFolder, 'The new tab should sit in the linked folder');
  assert.equal(await tabCount(second), 1);
  assert.equal(await windowCount(), 2);
  current = first;

  // Invalid links are ignored: wrong host, unknown mode, relative path, missing path, extra parameter, other scheme.
  for (const bad of [
    `mullion-terminal://run?mode=tab&path=${encodeURIComponent(tabFolder)}`,
    `mullion-terminal://open?mode=split&path=${encodeURIComponent(tabFolder)}`,
    'mullion-terminal://open?mode=window&path=relative',
    `mullion-terminal://open?mode=window&path=${encodeURIComponent(path.join(temporary, 'missing'))}`,
    `mullion-terminal://open?mode=window&path=${encodeURIComponent(tabFolder)}&command=touch%20pwned`,
    `https://example.com/?mode=window&path=${encodeURIComponent(tabFolder)}`,
  ]) await emitUrl(bad);
  await first.waitForTimeout(800);
  assert.equal(await windowCount(), 2, 'Invalid links must not open windows');
  assert.equal(await tabCount(first), 2, 'Invalid links must not open tabs');
  assert.equal(await tabCount(second), 1);

  // Record window 2's shell pid, then close window 2: only its shells end.
  const pidFile = path.join(temporary, 'second.pid');
  await typeLine(second, `echo $$ > '${pidFile}'`);
  await until(async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim().length > 0, 'Window 2 should record its shell pid');
  const secondPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  const firstPidFile = path.join(temporary, 'first.pid');
  await ready(first);
  await typeLine(first, `echo $$ > '${firstPidFile}'`);
  await until(async () => (await fs.readFile(firstPidFile, 'utf8').catch(() => '')).trim().length > 0, 'Window 1 should record its shell pid');
  const firstPid = Number((await fs.readFile(firstPidFile, 'utf8')).trim());
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(secondPid), true);
  await closeWindow(secondMark);
  await until(async () => (await windowCount()) === 1, 'Window 2 should close');
  await until(async () => !alive(secondPid), "Closing window 2 should end its shell");
  assert.equal(alive(firstPid), true, "Closing window 2 must not end window 1's shells");
  await ready(first);
  await typeLine(first, 'echo still-$((20+22))');
  await until(async () => (await screenText(first)).includes('still-42'), 'Window 1 should still be interactive');

  // Session ownership: window 3 can't write to, query or close window 1's sessions.
  const third = await nextWindow(() => first.evaluate(() => window.terminalAPI.newWindow()));
  await ready(third);
  assert.equal(await tabCount(third), 1, 'A new window opens with one tab');
  await until(async () => (await currentPath(third)) === home, 'A new window starts at Home');
  // A session window 1 owns (created straight through its API, so no tab shows it).
  const firstSessionIds = await first.evaluate(() => window.terminalAPI.createSession().then(session => session.id));
  const foreign = await third.evaluate(async id => {
    const results = {};
    for (const [name, call] of Object.entries({
      gitStatus: () => window.terminalAPI.gitStatus(id),
      completions: () => window.terminalAPI.completions(id, 'ec'),
      changeDirectory: () => window.terminalAPI.changeDirectory(id, '/'),
    })) {
      try { await call(); results[name] = 'allowed'; } catch (error) { results[name] = /ended/.test(error.message) ? 'ended' : error.message; }
    }
    await window.terminalAPI.closeSession(id);
    window.terminalAPI.write(id, 'echo foreign-write\r');
    return results;
  }, firstSessionIds);
  assert.deepEqual(foreign, { gitStatus: 'ended', completions: 'ended', changeDirectory: 'ended' });
  await first.waitForTimeout(300);
  assert.notEqual(await first.evaluate(id => window.terminalAPI.gitStatus(id).then(() => 'alive', error => error.message), firstSessionIds), 'This terminal session has ended.', "Another window's close must not end this window's session");
  await first.evaluate(id => window.terminalAPI.closeSession(id), firstSessionIds);
  await closeWindow(await windowId(third));
  await until(async () => (await windowCount()) === 1, 'Window 3 should close');

  // New Window shortcuts.
  await ready(first);
  await first.locator('.shell-pane.active .xterm-helper-textarea').focus();
  const byChord = await nextWindow(() => first.keyboard.press(mac ? 'Meta+n' : 'Control+Shift+N'));
  await ready(byChord);
  assert.equal(await tabCount(byChord), 1);
  await closeWindow(await windowId(byChord));
  await until(async () => (await windowCount()) === 1, 'The shortcut window should close');
  await first.locator('.shell-pane.active .xterm-helper-textarea').focus();
  const byControl = await nextWindow(() => first.keyboard.press('Control+n'));
  await ready(byControl);
  await closeWindow(await windowId(byControl));
  await until(async () => (await windowCount()) === 1, 'The Ctrl+N window should close');
  // Inside a full-screen program, Ctrl+N belongs to the program.
  await ready(first);
  await typeLine(first, 'less /etc/hosts');
  await first.waitForFunction(() => document.querySelector('.shell-pane.active .xterm-screen') && !document.querySelector('.shell-state.ready'), null, { timeout: 15000 });
  await first.waitForTimeout(700);
  await first.locator('.shell-pane.active .xterm-helper-textarea').focus();
  await first.keyboard.press('Control+n');
  await first.waitForTimeout(800);
  assert.equal(await windowCount(), 1, 'Ctrl+N inside less must not open a window');
  await first.keyboard.press('q');
  await ready(first);

  // A second launch with --open-mode=window opens its paths in a new window.
  const byArgv = await nextWindow(() => app.evaluate(({ app }, [argv, cwd]) => app.emit('second-instance', {}, argv, cwd), [
    ['/path/to/mullion-terminal', '--open-mode=window', argvFolder], temporary,
  ]));
  await ready(byArgv);
  assert.equal(await tabCount(byArgv), 1);
  await until(async () => (await currentPath(byArgv)) === argvFolder, 'The --open-mode=window tab should sit in its folder');

  // Settings saved in one window reach the others; "Open with … opens in: New window" routes a plain open-file to a new window.
  const settings = await first.evaluate(() => window.terminalAPI.bootstrap().then(value => value.settings));
  await first.evaluate(value => window.terminalAPI.saveSettings(value), { ...settings, theme: 'light', openWithTarget: 'window' });
  await until(async () => (await byArgv.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'Other windows should follow a settings change');
  const bySetting = await nextWindow(() => app.evaluate(({ app }, folder) => app.emit('open-file', { preventDefault() {} }, folder), settingFolder));
  await ready(bySetting);
  assert.equal(await tabCount(bySetting), 1);
  await until(async () => (await currentPath(bySetting)) === settingFolder, 'The open-file tab should sit in its folder');
  assert.equal(await bySetting.evaluate(() => document.documentElement.dataset.theme), 'light', 'A new window starts with the saved settings');
  await closeWindow(await windowId(bySetting));
  await closeWindow(await windowId(byArgv));
  await until(async () => (await windowCount()) === 1, 'Only the first window should remain');

  // Open folder adds a new tab (tree rooted at the folder) and leaves the current tab where it was.
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, chosenFolder);
  await ready(first);
  const before = await tabCount(first);
  const previousPath = await currentPath(first);
  await first.getByRole('button', { name: 'Open folder in a new tab', exact: true }).click();
  await until(async () => (await tabCount(first)) === before + 1, 'Open folder should add a tab');
  await until(async () => (await currentPath(first)) === chosenFolder, 'The new tab should sit in the chosen folder');
  await first.locator('[role=tab]').nth(before - 1).click();
  await until(async () => (await currentPath(first)) === previousPath, 'The previous tab must stay where it was');

  assert.deepEqual(errors, []);
  console.log('Window smoke passed: link windows/tabs, invalid links, per-window sessions, New Window shortcuts, --open-mode, shared settings, and Open folder in a new tab.');
} catch (error) {
  await current.screenshot({ path: path.join(root, 'test-results', 'window-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
