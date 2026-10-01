import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Exercise real detection after npm run build, but intercept editor launching.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-editor-smoke-')));
const fixture = path.join(temporary, 'workspace');
const coding = path.join(fixture, 'coding');
const python = path.join(fixture, 'python');
const php = path.join(fixture, 'php');
const notes = path.join(fixture, 'notes');
const profile = path.join(temporary, 'profile');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

try {
  for (const directory of [coding, python, php, notes, profile, results]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(coding, 'index.html'), '<!doctype html><title>Editor fixture</title>\n');
  await fs.writeFile(path.join(coding, 'index.php'), '<?php echo "editor fixture";\n');
  await fs.writeFile(path.join(coding, 'main.py'), 'print("editor fixture")\n');
  await fs.writeFile(path.join(python, 'main.py'), 'print("python fixture")\n');
  await fs.writeFile(path.join(php, 'index.php'), '<?php echo "php fixture";\n');
  await fs.writeFile(path.join(notes, 'notes.txt'), 'A folder without programming files.\n');
  await fs.writeFile(path.join(profile, '.zshrc'), [
    "export PATH='/usr/bin:/bin'",
    "HISTFILE=''",
    'SAVEHIST=0',
    'HISTSIZE=0',
    "PROMPT='editor-test ❯ '",
    "RPROMPT=''",
    '',
  ].join('\n'));

  const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
  app = await electron.launch({
    executablePath,
    args: [
      ...(executablePath ? [] : [root]),
      `--user-data-dir=${path.join(temporary, 'preferences')}`,
      `--cwd=${coding}`,
    ],
    env: { ...process.env, ZDOTDIR: profile, SHELL: '/bin/zsh', TERMINAL_DEV_URL: '' },
    timeout: 30000,
  });
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.removeAllListeners('ready-to-show');
      window.hide();
    }
    globalThis.__editorSmokeOpens = [];
    // Retain real filesystem/app detection. Only suppress opening native editors.
    ipcMain.removeHandler('terminal:open-editor');
    ipcMain.handle('terminal:open-editor', (_event, sessionId, editorId) => {
      globalThis.__editorSmokeOpens.push({ sessionId, editorId });
    });
  });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    window.__editorSmokeStates = {};
    window.terminalAPI.onEvent(event => {
      if (event.type === 'state') window.__editorSmokeStates[event.session.id] = event.session;
    });
  });
  const term = page.locator('.shell-pane.active .xterm-helper-textarea');
  const bar = page.locator('.editor-launcher[aria-label="Project editors"]');
  const bootstrap = await page.evaluate(() => window.terminalAPI.bootstrap());

  async function ready(expectedDirectory) {
    await page.waitForFunction(directory => Boolean(document.querySelector('.shell-state.ready'))
      && document.querySelector('.current-path')?.getAttribute('title') === directory,
    expectedDirectory, { timeout: 15000 });
  }

  async function run(command, expectedDirectory) {
    await term.focus();
    await page.keyboard.type(command, { delay: 15 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await ready(expectedDirectory);
  }

  async function detect(sessionId) {
    return page.evaluate(id => window.terminalAPI.projectEditors(id, true), sessionId);
  }

  async function expectButtons(detected, expectedDirectory) {
    await page.waitForFunction(() => document.querySelector('.editor-launcher')?.getAttribute('aria-busy') === 'false',
      undefined, { timeout: 15000 });
    await page.waitForFunction(expected => {
      const names = [...document.querySelectorAll('.editor-launcher .editor-button')].map(button => button.getAttribute('aria-label'));
      return names.length === expected.length && names.every((name, index) => name === expected[index]);
    }, detected.editors.map(editor => `Open current folder in ${editor.name}`), { timeout: 10000 });
    assert.equal(await bar.locator('.project-languages, .editor-project, .editor-empty').count(), 0,
      'Editor actions should not add language tags or descriptive text to the topbar');
    assert.equal(await page.locator('.titlebar .editor-launcher').count(), 1, 'Editor icons should be in the fixed topbar');
    const nativeHashes = [];
    for (const editor of detected.editors) {
      const button = bar.getByRole('button', { name: `Open current folder in ${editor.name}`, exact: true });
      assert.equal(await button.getAttribute('title'), `Open ${expectedDirectory} in ${editor.name}`,
        'Every editor button should target the active terminal directory');
      assert.equal((await button.innerText()).trim(), '', 'Editor buttons should show icons without text labels');
      assert.equal(await button.locator('img.editor-app-icon').count(), 1, 'Each editor should use its app icon');
      await button.locator('img.editor-app-icon').evaluate(image => image.decode());
      assert.equal(await button.locator('img.editor-app-icon').evaluate(image => image.complete && image.naturalWidth > 0), true,
        'Every editor app icon should load successfully');
      assert.match(await button.locator('img.editor-app-icon').getAttribute('src'), /^data:image\/(png|svg\+xml)/,
        'Editor icons should use the native app image or branded fallback');
      if (bootstrap.platform === 'darwin' && /^(PhpStorm|Visual Studio Code|Antigravity)$/.test(editor.name)) {
        const pixels = await button.locator('img.editor-app-icon').evaluate(image => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 32;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0, 32, 32);
          return [...context.getImageData(0, 0, 32, 32).data];
        });
        nativeHashes.push(createHash('sha256').update(Buffer.from(pixels)).digest('hex'));
      }
    }
    assert.equal(new Set(nativeHashes).size, nativeHashes.length,
      'Installed PhpStorm, VS Code and Antigravity must display distinct app logos, not identical generic Mac icons');
    assert.equal(await bar.getByRole('button', { name: 'Refresh installed editors', exact: true }).count(), detected.editors.length ? 1 : 0,
      'The editor action group should be empty if no compatible editor is installed');
  }

  async function expectNoEditors(sessionId) {
    assert.deepEqual((await detect(sessionId)).languages, [], 'This folder should not be classified as a programming project');
    await expectButtons({ editors: [], languages: [] }, await page.locator('.current-path').getAttribute('title'));
  }

  async function expectOpen(sessionId, editor) {
    const before = await app.evaluate(() => globalThis.__editorSmokeOpens.length);
    await bar.getByRole('button', { name: `Open current folder in ${editor.name}`, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.editor-launcher .editor-button[disabled]'), undefined, { timeout: 10000 });
    const opens = await app.evaluate(() => globalThis.__editorSmokeOpens);
    assert.equal(opens.length, before + 1, 'Clicking an editor should issue exactly one launch request');
    assert.deepEqual(opens.at(-1), { sessionId, editorId: editor.id },
      'An editor request must identify the currently selected terminal and installed editor');
  }

  await ready(coding);
  await term.focus();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(120);
  await ready(coding);
  await page.waitForFunction(() => Object.values(window.__editorSmokeStates).some(session => session.ready), undefined, { timeout: 10000 });
  const firstId = await page.evaluate(() => Object.values(window.__editorSmokeStates).find(session => session.ready).id);
  assert.equal(await page.locator('.sidebar').count(), 0, 'The sidebar must be closed on fresh-profile startup');
  const firstDetected = await detect(firstId);
  const languages = firstDetected.languages.map(language => language.toLowerCase());
  for (const language of ['html', 'php', 'python']) assert.ok(languages.includes(language), `${language} should be detected from programming files`);
  await expectButtons(firstDetected, coding);
  for (const editor of firstDetected.editors) await expectOpen(firstId, editor);
  await page.screenshot({ path: path.join(results, 'project-editors.png') });

  if (firstDetected.editors.length) {
    await bar.getByRole('button', { name: 'Refresh installed editors', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.editor-launcher button[aria-label="Refresh installed editors"][disabled]'), undefined, { timeout: 10000 });
    await expectButtons(await detect(firstId), coding);
  }

  await run('cd ../notes', notes);
  await expectNoEditors(firstId);
  await run('cd ..', fixture);
  await expectNoEditors(firstId);
  await run('cd python', python);
  const pythonDetected = await detect(firstId);
  assert.ok(pythonDetected.languages.map(language => language.toLowerCase()).includes('python'));
  assert.ok(!pythonDetected.editors.some(editor => /phpstorm/i.test(editor.name)), 'A Python project must exclude PhpStorm');
  await expectButtons(pythonDetected, python);
  await run('cd ../php', php);
  const phpDetected = await detect(firstId);
  assert.ok(phpDetected.languages.map(language => language.toLowerCase()).includes('php'));
  if (firstDetected.editors.some(editor => /phpstorm/i.test(editor.name))) {
    assert.ok(phpDetected.editors.some(editor => /phpstorm/i.test(editor.name)), 'Installed PhpStorm must be offered for a PHP project');
  }
  await expectButtons(phpDetected, php);
  await run('cd ../coding', coding);
  const updated = await detect(firstId);
  await expectButtons(updated, coding);

  await page.getByRole('button', { name: 'New terminal tab', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2, undefined, { timeout: 15000 });
  await ready(bootstrap.home);
  await page.waitForFunction(first => Object.values(window.__editorSmokeStates).some(session => session.id !== first && session.ready), firstId, { timeout: 10000 });
  const secondId = await page.evaluate(first => Object.values(window.__editorSmokeStates).find(session => session.id !== first && session.ready).id, firstId);
  await run(`cd '${coding.replaceAll("'", "'\\''")}'`, coding);
  const secondDetected = await detect(secondId);
  await expectButtons(secondDetected, coding);
  if (secondDetected.editors.length) await expectOpen(secondId, secondDetected.editors[0]);
  await run('cd ../notes', notes);
  await expectNoEditors(secondId);
  await page.locator('[role=tab]').nth(0).click();
  await ready(coding);
  await expectButtons(updated, coding);
  if (updated.editors.length) await expectOpen(firstId, updated.editors[0]);

  assert.deepEqual(errors, []);
  assert.equal(await page.getByRole('alert').count(), 0, 'Editor detection and requests should not show errors');
  console.log(`Editor smoke passed: icon-only topbar, loaded app icons, PHP/Python IDE filtering, ordinary parents/notes hidden, ${firstDetected.editors.map(editor => editor.name).join(', ') || 'no installed editors'}, refresh and active directory/session requests.`);
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'editor-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
