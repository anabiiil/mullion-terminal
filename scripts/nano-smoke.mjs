import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// End-to-end: nano/pico mouse + editor bar + Cmd/Ctrl+S, and Ctrl+C/Ctrl+V clipboard keys.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-nano-smoke-')));
const home = path.join(temporary, 'home');
const file = path.join(home, 'notes.txt');
await fs.mkdir(home, { recursive: true });
await fs.writeFile(file, 'alpha\nbravo\ncharlie\n');
await fs.writeFile(path.join(home, '.zshrc'), [
  "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
  'PROMPT="%F{cyan}%~%f %F{yellow}❯%f "', "RPROMPT=''", '',
].join('\n'));
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
const env = { ...process.env, ZDOTDIR: home, SHELL: process.env.MULLION_SMOKE_SHELL || '/bin/zsh', TERMINAL_DEV_URL: '' };
delete env.DISPLAY;
const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(temporary, 'preferences')}`, `--cwd=${home}`], env, timeout: 30000 });
await app.evaluate(({ BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows()) { window.removeAllListeners('ready-to-show'); window.hide(); }
});
// Keep the test away from the real system clipboard.
await app.evaluate(({ clipboard }) => {
  globalThis.__mullionClipboard = { readText: clipboard.readText, writeText: clipboard.writeText, value: '' };
  clipboard.readText = async () => globalThis.__mullionClipboard.value;
  clipboard.writeText = async value => { globalThis.__mullionClipboard.value = value; };
});
const setClipboard = value => app.evaluate((_electron, text) => { globalThis.__mullionClipboard.value = text; }, value);
const getClipboard = () => app.evaluate(() => globalThis.__mullionClipboard.value);
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const term = page.locator('.shell-pane.active .xterm-helper-textarea');
const ready = async () => { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(180); };
const rows = () => page.evaluate(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')].map(row => row.textContent));
async function until(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.waitForTimeout(60);
  }
  assert.fail(message);
}
const fileIs = (expected, target = file) => until(async () => (await fs.readFile(target, 'utf8')) === expected, `Expected ${target} content ${JSON.stringify(expected)}`);
let grid;
async function clickCell(row, col) {
  const box = await page.locator('.shell-pane.active .xterm-screen').boundingBox();
  await page.mouse.click(box.x + (col + 0.5) * box.width / grid.cols, box.y + (row + 0.5) * box.height / grid.rows);
}

try {
  await ready();
  await term.focus();

  // Ctrl+V pastes at the shell prompt, like Cmd+V.
  await setClipboard('echo pasted-by-control-v');
  await page.keyboard.press('Control+v');
  await until(async () => (await rows()).some(row => row.includes('echo pasted-by-control-v')), 'Ctrl+V did not paste at the prompt');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await until(async () => (await rows()).some(row => row.trim() === 'pasted-by-control-v'), 'Pasted command did not run');
  await ready();
  await setClipboard('echo pasted-by-command-v');
  await page.keyboard.press('Meta+v');
  await until(async () => (await rows()).some(row => row.includes('echo pasted-by-command-v')), 'Cmd+V did not paste');
  await page.keyboard.press('Control+u');
  await ready();

  // Ctrl+C copies a selection; without one it still interrupts.
  const outputRow = (await rows()).findIndex(row => row.trim() === 'pasted-by-control-v');
  await setClipboard('');
  const box = await page.locator('.shell-pane.active .xterm-screen').boundingBox();
  const rowHeight = box.height / (await rows()).length;
  await page.mouse.dblclick(box.x + 20, box.y + (outputRow + 0.5) * rowHeight);
  await page.keyboard.press('Control+c');
  await until(async () => (await getClipboard()) === 'pasted-by-control-v', 'Ctrl+C did not copy the selection');
  await page.mouse.click(box.x + 5, box.y + box.height - 5);
  await term.focus();
  await page.keyboard.type('sleep 30', { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shell-state:not(.ready)');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+c');
  await ready();

  // nano (pico on macOS) shows the editor bar and accepts mouse clicks.
  await term.focus();
  await page.keyboard.type('stty size', { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await ready();
  const size = (await rows()).map(row => row.trim()).filter(row => /^\d+ \d+$/.test(row)).pop();
  assert.ok(size, 'stty size did not report the grid');
  grid = { rows: Number(size.split(' ')[0]), cols: Number(size.split(' ')[1]) };
  await page.keyboard.type('nano notes.txt', { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.locator('.editor-bar').waitFor({ timeout: 8000 });
  await until(async () => (await rows()).some(row => row.startsWith('charlie')), 'nano did not show the file');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(root, 'test-results', 'nano-editor-bar.png') });
  const charlie = (await rows()).findIndex(row => row.startsWith('charlie'));
  await clickCell(charlie, 3); // between "cha" and "rlie"
  await page.waitForTimeout(150);
  await page.keyboard.type('X');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await fileIs('alpha\nbravo\nchaXrlie\n');

  // Clicking another line moves the cursor there; Cmd+S and Ctrl+S save.
  const alpha = (await rows()).findIndex(row => row.startsWith('alpha'));
  await clickCell(alpha, 0);
  await page.waitForTimeout(150);
  await page.keyboard.type('Y');
  await page.keyboard.press('Meta+s');
  await fileIs('Yalpha\nbravo\nchaXrlie\n');
  await page.keyboard.type('Z');
  await page.keyboard.press('Control+s');
  await fileIs('YZalpha\nbravo\nchaXrlie\n');

  // Ctrl+V belongs to the editor (next page), not the clipboard.
  await setClipboard('SHOULD-NOT-PASTE');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(200);
  assert.ok(!(await rows()).some(row => row.includes('SHOULD-NOT-PASTE')), 'Ctrl+V pasted inside nano');

  // Save & Exit writes and leaves the editor; the bar disappears.
  await page.keyboard.type('W');
  await page.getByRole('button', { name: 'Save & Exit' }).click();
  await ready();
  await page.locator('.editor-bar').waitFor({ state: 'detached', timeout: 5000 });
  assert.match(await fs.readFile(file, 'utf8'), /W/);

  // Mouse-wheel scrolling: nano/pico enable xterm mouse tracking, so a raw
  // wheel notch arrives as a mouse report that UW pico ignores. The app
  // translates wheel events into arrow keys instead, so the viewport should
  // actually move on a file long enough to scroll.
  const longFile = path.join(home, 'long.txt');
  const longLines = Array.from({ length: 400 }, (_, i) => `line ${String(i + 1).padStart(4, '0')}`);
  await fs.writeFile(longFile, longLines.join('\n') + '\n');
  async function cellPoint(row, col) {
    const box = await page.locator('.shell-pane.active .xterm-screen').boundingBox();
    return { x: box.x + (col + 0.5) * box.width / grid.cols, y: box.y + (row + 0.5) * box.height / grid.rows };
  }
  const topLine = async () => {
    const match = (await rows()).map(row => row.trim()).find(row => /^line \d{4}$/.test(row));
    return match ? Number(match.slice(5)) : null;
  };
  await term.focus();
  await page.keyboard.type('nano long.txt', { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.locator('.editor-bar').waitFor({ timeout: 8000 });
  await until(async () => (await topLine()) === 1, 'long file did not open at line 1');
  await page.waitForTimeout(200);

  const longBox = await page.locator('.shell-pane.active .xterm-screen').boundingBox();
  await page.mouse.move(longBox.x + longBox.width / 2, longBox.y + longBox.height / 2);
  let line = 1;
  for (let i = 0; i < 25 && line < 190; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(60);
    line = (await topLine()) ?? line;
  }
  assert.ok(line > 1, 'wheel down did not scroll the viewport');
  assert.ok(line >= 150, `wheel down should reach roughly line 200, stopped at line ${line}`);
  const scrolledTo = line;

  // Wheel up scrolls back toward the top.
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  const afterUp = await topLine();
  assert.ok(afterUp !== null && afterUp < scrolledTo, 'wheel up did not scroll back toward the top');

  // Scroll back to around line 200, then click a specific line/column and
  // verify the edit lands at the right place in the file once saved — this
  // is the whole point of mouse scrolling: being able to edit anywhere.
  line = afterUp;
  for (let i = 0; i < 25 && line < 190; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(60);
    line = (await topLine()) ?? line;
  }
  const visibleAfterScroll = await rows();
  const targetRow = visibleAfterScroll.findIndex(row => row.trim() === 'line 0200');
  assert.ok(targetRow >= 0, 'line 0200 is not visible after scrolling with the wheel');
  await clickCell(targetRow, 5); // between "line " and "0200"
  await page.waitForTimeout(150);
  await page.keyboard.type('X');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await fileIs(longLines.map((text, index) => index === 199 ? 'line X0200' : text).join('\n') + '\n', longFile);

  // Option/Alt+drag still selects text for copying while nano owns the mouse.
  await setClipboard('');
  const dragStart = await cellPoint(targetRow, 0);
  const dragEnd = await cellPoint(targetRow, 9);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.press('Control+c');
  await until(async () => (await getClipboard()).length > 0, 'Option/Alt+drag did not select text inside nano');

  // The buffer was already saved above, so Exit leaves immediately.
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  await ready();
  await page.locator('.editor-bar').waitFor({ state: 'detached', timeout: 5000 });

  // Exit without changes leaves immediately.
  await term.focus();
  await page.keyboard.type('nano notes.txt', { delay: 15 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.locator('.editor-bar').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  await ready();
  await page.locator('.editor-bar').waitFor({ state: 'detached', timeout: 5000 });
  assert.deepEqual(errors, []);
  console.log('Nano smoke passed: Ctrl/Cmd+V paste, Ctrl+C copy/interrupt, editor bar, mouse cursor placement, Cmd/Ctrl+S, wheel scrolling, click-after-scroll editing, Option/Alt+drag selection.');
} catch (error) {
  await page.screenshot({ path: path.join(root, 'test-results', 'nano-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  console.error('Rows:', (await rows().catch(() => [])).filter(row => row.trim()));
  console.error('File:', JSON.stringify(await fs.readFile(file, 'utf8').catch(() => null)));
  console.error('Long file:', JSON.stringify(await fs.readFile(path.join(home, 'long.txt'), 'utf8').catch(() => null))?.slice(0, 400));
  throw error;
} finally {
  await app.evaluate(({ clipboard }) => {
    if (globalThis.__mullionClipboard) Object.assign(clipboard, { readText: globalThis.__mullionClipboard.readText, writeText: globalThis.__mullionClipboard.writeText });
    delete globalThis.__mullionClipboard;
  }).catch(() => {});
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
