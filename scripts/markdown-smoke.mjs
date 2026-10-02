import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Run after npm run build; MULLION_SMOKE_EXECUTABLE can target a release.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-markdown-smoke-')));
const fixture = path.join(temporary, 'workspace');
const profile = path.join(temporary, 'profile');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

try {
  for (const directory of [path.join(fixture, 'docs', 'screenshots'), path.join(fixture, 'guides'), profile, results]) {
    await fs.mkdir(directory, { recursive: true });
  }
  // The real README (and the screenshots it references) exercises realistic content and local images.
  await fs.copyFile(path.join(root, 'README.md'), path.join(fixture, 'README.md'));
  for (const name of await fs.readdir(path.join(root, 'docs', 'screenshots')).catch(() => [])) {
    await fs.copyFile(path.join(root, 'docs', 'screenshots', name), path.join(fixture, 'docs', 'screenshots', name));
  }
  await fs.writeFile(path.join(fixture, 'unsafe.md'), [
    '# Sanitizer fixture',
    '',
    '<script>window.__markdownScriptRan = true; document.title = "pwned";</script>',
    '',
    '<img src="missing.png" onerror="window.__markdownHandlerRan = true">',
    '',
    '<a href="javascript:window.__markdownJavascriptRan = true">javascript link</a>',
    '',
    '<div style="position:fixed;inset:0" class="modal-overlay" id="root">styled</div>',
    '',
    '<iframe src="file:///etc/passwd"></iframe>',
    '',
    '[external link](https://example.com/mullion-preview) · [mail](mailto:someone@example.com) · [file link](file:///etc/passwd)',
    '',
    '[next guide](guides/next.md#second-section)',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(fixture, 'guides', 'next.md'), '# Next guide\n\nFirst.\n\n## Second section\n\n[Back](../unsafe.md)\n');
  await fs.writeFile(path.join(fixture, 'huge.md'), '#'.repeat(2 * 1024 * 1024 + 1));
  await fs.writeFile(path.join(profile, '.zshrc'), [
    "export PATH='/usr/bin:/bin'",
    "HISTFILE=''",
    'SAVEHIST=0',
    'HISTSIZE=0',
    "PROMPT='markdown-test ❯ '",
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
  // Keep the regression from receiving native keyboard input intended for the user,
  // and record external links instead of opening a real browser.
  await app.evaluate(({ BrowserWindow, shell }) => {
    globalThis.__openedExternally = [];
    shell.openExternal = async url => { globalThis.__openedExternally.push(url); };
    for (const window of BrowserWindow.getAllWindows()) {
      window.removeAllListeners('ready-to-show');
      window.hide();
    }
  });
  const openedExternally = () => app.evaluate(() => globalThis.__openedExternally);
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const appUrl = page.url();
  const term = page.locator('.shell-pane.active .xterm-helper-textarea');
  const preview = page.locator('.markdown-preview');
  const body = preview.locator('.markdown-body');
  const row = file => page.locator('.tree-name').and(page.locator(`[title=${JSON.stringify(file)}]`));
  async function ready() {
    await page.waitForFunction(directory => Boolean(document.querySelector('.shell-state.ready'))
      && document.querySelector('.current-path')?.getAttribute('title') === directory, fixture, { timeout: 15000 });
  }
  async function expectTerminalFocused() {
    await page.waitForFunction(() => document.activeElement === document.querySelector('.shell-pane.active .xterm-helper-textarea'),
      undefined, { timeout: 5000 });
  }

  await ready();
  await page.getByRole('button', { name: 'Toggle files sidebar', exact: true }).click();
  const readme = path.join(fixture, 'README.md');
  await row(readme).waitFor({ state: 'visible', timeout: 10000 });

  // Double-clicking README.md renders it instead of starting nano.
  await row(readme).dblclick();
  await preview.waitFor({ state: 'visible', timeout: 10000 });
  await body.locator('h1').first().waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await preview.locator('.markdown-preview-title').innerText(), 'README.md');
  assert.ok((await body.locator('h1').first().innerText()).includes('Mullion Terminal'), 'README heading should render as <h1>');
  assert.ok(await body.locator('h2').count() > 2, 'README sections should render as <h2>');
  assert.equal(await page.locator('.editor-bar').count(), 0, 'Opening a Markdown file must not start nano');
  for (const name of ['Edit', 'Open externally', 'Close preview']) {
    assert.ok(await preview.getByRole('button', { name, exact: true }).isVisible(), `${name} should be visible`);
  }
  // Local images load as data: URLs through IPC, never as file:// URLs.
  const images = await body.locator('img').evaluateAll(list => list.map(image => image.getAttribute('src') ?? ''));
  assert.ok(images.every(src => !src.startsWith('file:')), 'Local images must never load by file:// URL');
  if (images.length) {
    await page.waitForFunction(() => [...document.querySelectorAll('.markdown-body img')].some(image => image.src.startsWith('data:image/') && image.complete && image.naturalWidth > 0),
      undefined, { timeout: 10000 });
  }
  await page.screenshot({ path: path.join(results, 'markdown-preview.png') });
  // Tables, code and lists in the light theme.
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.querySelector('.markdown-body table')?.scrollIntoView({ block: 'center' }); });
  await page.screenshot({ path: path.join(results, 'markdown-preview-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await preview.locator('.markdown-preview-scroll').focus();

  // Escape closes the preview and gives focus back to the terminal.
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached', timeout: 5000 });
  await expectTerminalFocused();

  // Unsafe markup is removed before it reaches the DOM and never runs.
  const unsafe = path.join(fixture, 'unsafe.md');
  await row(unsafe).dblclick();
  await body.locator('h1', { hasText: 'Sanitizer fixture' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  const unsafeState = await page.evaluate(() => {
    const content = document.querySelector('.markdown-body');
    return {
      scripts: content.querySelectorAll('script').length,
      iframes: content.querySelectorAll('iframe').length,
      handlers: [...content.querySelectorAll('*')].filter(element => [...element.attributes].some(attribute => /^on/i.test(attribute.name))).length,
      styled: content.querySelectorAll('[style],[class]:not(.markdown-image-placeholder),[id]').length,
      javascriptLinks: [...content.querySelectorAll('a')].filter(link => /^\s*javascript:/i.test(link.getAttribute('href') ?? '')).length,
      ran: Boolean(window.__markdownScriptRan || window.__markdownHandlerRan || window.__markdownJavascriptRan),
      title: document.title,
      html: content.innerHTML,
    };
  });
  assert.equal(unsafeState.scripts, 0, 'A <script> tag must not survive sanitization');
  assert.ok(!/<script/i.test(unsafeState.html), 'No script markup may remain in the rendered HTML');
  assert.equal(unsafeState.iframes, 0, 'Iframes must be removed');
  assert.equal(unsafeState.handlers, 0, 'Inline event handlers must be removed');
  assert.equal(unsafeState.styled, 0, 'style/class/id attributes must be removed');
  assert.equal(unsafeState.javascriptLinks, 0, 'javascript: links must be removed');
  assert.equal(unsafeState.ran, false, 'No script from the Markdown source may execute');
  assert.equal(unsafeState.title, 'Mullion Terminal');

  // Links never navigate the app window: web links go to the OS through IPC, others are refused.
  await body.getByRole('link', { name: 'external link', exact: true }).click();
  await body.getByRole('link', { name: 'mail', exact: true }).click();
  await body.getByText('javascript link').click();
  await body.getByText('file link').click();
  await page.waitForTimeout(300);
  assert.equal(page.url(), appUrl, 'Clicking a link must not navigate the app window');
  assert.deepEqual(await openedExternally(), ['https://example.com/mullion-preview', 'mailto:someone@example.com']);
  assert.equal(await page.evaluate(() => Boolean(window.__markdownJavascriptRan)), false);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/x']) {
    await assert.rejects(page.evaluate(value => window.terminalAPI.openExternalLink(value), url), /can't be opened|Invalid link/, url);
  }
  assert.equal((await openedExternally()).length, 2, 'Disallowed protocols must never reach shell.openExternal');
  await page.locator('.toast button').click().catch(() => {});

  // Relative Markdown links swap the previewed file in place.
  await body.getByRole('link', { name: 'next guide', exact: true }).click();
  await body.locator('h1', { hasText: 'Next guide' }).waitFor({ timeout: 10000 });
  assert.equal(await preview.locator('.markdown-preview-title').innerText(), 'next.md');
  assert.equal(await page.locator('.markdown-preview').count(), 1);
  await body.getByRole('link', { name: 'Back', exact: true }).click();
  await body.locator('h1', { hasText: 'Sanitizer fixture' }).waitFor({ timeout: 10000 });

  // The Close button removes the preview and refocuses the terminal.
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  await preview.waitFor({ state: 'detached', timeout: 5000 });
  await expectTerminalFocused();

  // Oversized files are refused with a clear error rather than truncated.
  await assert.rejects(page.evaluate(file => window.terminalAPI.readTextFile(file), path.join(fixture, 'huge.md')), /larger than 2 MiB/);
  await assert.rejects(page.evaluate(file => window.terminalAPI.readImage(file), path.join(fixture, 'README.md')), /Only image files/);
  await row(path.join(fixture, 'huge.md')).dblclick();
  await preview.locator('.markdown-preview-status.error').waitFor({ timeout: 10000 });
  assert.match(await preview.locator('.markdown-preview-status.error').innerText(), /larger than 2 MiB/);
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  await preview.waitFor({ state: 'detached', timeout: 5000 });

  // Edit closes the preview and falls through to the existing edit path.
  await ready();
  await row(readme).dblclick();
  await body.locator('h1').first().waitFor({ timeout: 10000 });
  await preview.getByRole('button', { name: 'Edit', exact: true }).click();
  await preview.waitFor({ state: 'detached', timeout: 5000 });
  const bootstrap = await page.evaluate(() => window.terminalAPI.bootstrap());
  if (bootstrap.platform !== 'win32') {
    await page.waitForFunction(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
      .some(line => line.textContent.includes('README.md')), undefined, { timeout: 10000 });
    await page.waitForFunction(() => /nano|pico/i.test(document.querySelector('.shell-pane.active .xterm-rows')?.textContent ?? ''), undefined, { timeout: 10000 });
    await term.focus();
    await page.keyboard.press('Control+x');
    await ready();
  }

  assert.deepEqual(errors, []);
  console.log('Markdown smoke passed: tree double-click opens a rendered preview with local images, Escape/Close restore terminal focus, scripts and unsafe markup are stripped, web links open externally through IPC without navigating, relative .md links swap the preview, oversized files are refused and Edit opens nano.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'markdown-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
