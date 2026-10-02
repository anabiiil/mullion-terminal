import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// End-to-end: "Open with Mullion Terminal" — a folder/file argument at launch,
// a later launch reported through Electron's 'second-instance' event, and
// macOS's 'open-file' event, each turn into a new tab (folder -> that cwd;
// file -> a tab in its parent folder with the file opened the same way the
// tree's double-click does). Run after `npm run build`; MULLION_SMOKE_EXECUTABLE
// can target a packaged release instead of the source tree.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-open-path-smoke-')));
const home = path.join(temporary, 'home');
const workspace = path.join(temporary, 'workspace');
const secondInstanceDirectory = path.join(temporary, 'second-instance-folder');
const project = path.join(temporary, 'project');
const outside = path.join(temporary, 'outside');
const secondInstanceFile = path.join(secondInstanceDirectory, 'second-instance.txt');
const openFileTarget = path.join(outside, 'opened-via-finder.txt');
const projectFile = path.join(project, 'readme.txt');
const ghost = path.join(temporary, 'does-not-exist.txt');
for (const directory of [home, workspace, secondInstanceDirectory, project, outside]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(secondInstanceFile, 'from a second launch\n');
await fs.writeFile(openFileTarget, 'from Finder Open With\n');
await fs.writeFile(projectFile, 'from a multi-path launch\n');
const notesFile = path.join(outside, 'notes.md');
await fs.writeFile(notesFile, '# Earlier notes\n');
await fs.writeFile(path.join(home, '.zshrc'), [
  "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
  'PROMPT="%F{cyan}%~%f %F{yellow}❯%f "', "RPROMPT=''", '',
].join('\n'));
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
const isPackaged = Boolean(executablePath);
const env = { ...process.env, ZDOTDIR: home, SHELL: process.env.MULLION_SMOKE_SHELL || '/bin/zsh', TERMINAL_DEV_URL: '' };
// Launching with a folder argv target: it should become the only tab, in
// place of the usual blank one at Home — no `--cwd=` is passed, so the only
// way the shell can land in `workspace` is through the open-path argv.
const app = await electron.launch({
  executablePath,
  args: [...(isPackaged ? [] : [root]), `--user-data-dir=${path.join(temporary, 'preferences')}`, workspace],
  env, timeout: 30000,
});
await app.evaluate(({ BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows()) { window.removeAllListeners('ready-to-show'); window.hide(); }
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ready = async () => { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(180); };
const tabCount = () => page.locator('[role=tab]').count();
const currentPath = () => page.evaluate(() => document.querySelector('.current-path')?.getAttribute('title'));
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.waitForTimeout(60);
  }
  assert.fail(message);
}

try {
  await ready();
  assert.equal(await tabCount(), 1, 'A folder argument at launch should open exactly one tab, not an extra blank one');
  await until(async () => (await currentPath()) === workspace, `Expected the launch tab's cwd to be ${workspace}`);

  // Electron's 'second-instance' event (another `mullion-terminal <path>`
  // launch, or the Windows/Linux "Open with Mullion Terminal" registry entry)
  // carries the new process's argv and its working directory. Resolve a
  // relative path against that cwd, like a real second launch would need to.
  await app.evaluate(({ app }, [argv, cwd]) => app.emit('second-instance', {}, argv, cwd), [
    ['/path/to/mullion-terminal', '--not-a-path', path.basename(secondInstanceFile)], path.dirname(secondInstanceFile),
  ]);
  await until(async () => (await tabCount()) === 2, 'The second-instance file target should open a second tab');
  await until(async () => (await currentPath()) === path.dirname(secondInstanceFile), "The file's tab should sit in its parent folder");
  // Once that new tab's shell reports ready, the file opens with nano, shown
  // by the floating editor bar — the same thing the tree's double-click does.
  await page.locator('.editor-bar').waitFor({ timeout: 15000 });

  // macOS hands Finder's "Open With" and a Dock drop through 'open-file'
  // instead of argv, and it can fire before the window exists — simulate it
  // the same way on every platform by emitting the event on the live app.
  await app.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), openFileTarget);
  await until(async () => (await tabCount()) === 3, "An 'open-file' target should open a third tab");
  await until(async () => (await currentPath()) === path.dirname(openFileTarget), "The open-file tab should sit in the target's parent folder");
  await page.locator('.editor-bar').waitFor({ timeout: 15000 });

  // A bogus flag and a path that no longer exists are ignored rather than
  // failing the whole batch; the one real target still opens its own tab.
  await app.evaluate(({ app }, [argv, cwd]) => app.emit('second-instance', {}, argv, cwd), [
    ['/path/to/mullion-terminal', '--some-flag', ghost, projectFile], temporary,
  ]);
  await until(async () => (await tabCount()) === 4, 'Only the one existing path should open a new tab; the flag and the missing path are ignored');

  // A Markdown file opened from Finder shows its preview in its own tab; after
  // that tab is closed, opening a folder must not bring the old preview back.
  await app.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), notesFile);
  await until(async () => (await tabCount()) === 5, 'The Markdown target should open a fifth tab');
  await page.locator('.markdown-preview').first().waitFor({ timeout: 15000 });
  await page.locator('[role=tab][aria-selected=true] button[aria-label^="Close terminal"]').click();
  await until(async () => (await tabCount()) === 4, 'Closing the Markdown tab should leave four tabs');
  await app.evaluate(({ app }, folder) => app.emit('open-file', { preventDefault() {} }, folder), project);
  await until(async () => (await tabCount()) === 5, 'The folder target should open a new tab');
  await until(async () => (await currentPath()) === project, 'The folder tab should sit in that folder');
  await ready();
  assert.equal(await page.locator('.markdown-preview').count(), 0, 'A closed tab\'s Markdown preview must not reappear in a new tab');

  assert.deepEqual(errors, []);
  console.log('Open-path smoke passed: launch argv, second-instance, open-file, invalid targets, and previews stay with their tab.');
} catch (error) {
  await page.screenshot({ path: path.join(root, 'test-results', 'open-path-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
