import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// End-to-end: the prompt's own git segment (`git:(main → origin/main ↑1 ↓2)`, right after the
// path) reflects a real git repository and its upstream, disappears outside one, and the
// branch name there is clickable — opening a filterable dropdown of local/remote branches
// (current branch checked, most recently committed first) that can switch between them in the
// real shell without polluting command history. The tab bar's own status strip now holds only
// the changed-files chip (`N • +ins -del`) and disappears entirely outside a repo or with a
// clean working tree — the branch itself is no longer shown there.
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-git-smoke-')));
const fixture = path.join(temporary, 'workspace');
const project = path.join(fixture, 'project');
const outside = path.join(fixture, 'outside');
const bareOrigin = path.join(temporary, 'origin.git');
const profile = path.join(temporary, 'profile');
const results = path.join(root, 'test-results');
let app;
let page;
const errors = [];

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Mullion Smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

try {
  const gitCheck = spawnSync('git', ['--version']);
  if (gitCheck.error) { console.log('Git smoke skipped: git is not installed.'); process.exit(0); }

  for (const directory of [project, outside, profile, results]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(profile, '.zshrc'), [
    "export PATH='/usr/bin:/bin'", "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
    "PROMPT='git-test ❯ '", "RPROMPT=''", '',
  ].join('\n'));

  git(project, ['-c', 'init.defaultBranch=main', 'init']);
  await fs.writeFile(path.join(project, 'file.txt'), 'one\ntwo\n');
  git(project, ['add', 'file.txt']);
  git(project, ['commit', '-m', 'initial']);
  // feature-x branches off the same clean commit, so switching to it later never conflicts
  // with the uncommitted change made further down. It has no upstream of its own, so the
  // prompt there is the plain `git:(feature-x)` form once it's switched to.
  git(project, ['branch', 'feature-x']);
  // A real upstream, one commit ahead of it, so the prompt's segment exercises the
  // `→ origin/main ↑1` form, not just a bare branch name.
  spawnSync('git', ['init', '--bare', bareOrigin]);
  git(project, ['remote', 'add', 'origin', bareOrigin]);
  git(project, ['push', '-q', 'origin', 'main']);
  git(project, ['branch', '--set-upstream-to=origin/main', 'main']);
  git(project, ['commit', '--allow-empty', '-m', 'ahead by one']);

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
  const changesChip = page.locator('.status-chip.changes');
  const branchMenu = page.locator('.branch-menu');
  const history = () => page.evaluate(() => window.terminalAPI.bootstrap().then(value => value.history));
  // The prompt's own rendered rows (xterm's DOM renderer — see path-smoke.mjs's lastRow()):
  // reading plain text this way, rather than the terminal API, confirms what the user actually
  // sees on screen, including the colors landing in the right spans.
  const lastRow = () => page.evaluate(() => [...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
    .map(row => row.textContent).filter(Boolean).at(-1) ?? '');
  // The branch/sha span inside the prompt's `git:(...)` segment: ShellPane's link provider
  // marks exactly this text as a link (see PROMPT_GIT_LINE), and it renders in its own
  // `<span>` since it's the only part of the line colored magenta — see src/ShellPane.tsx.
  function branchLink(name) { return page.locator('.shell-pane.active .xterm-rows span', { hasText: new RegExp(`^${name}$`) }).last(); }

  async function ready() { await page.locator('.shell-state.ready').waitFor({ timeout: 15000 }); await page.waitForTimeout(80); }
  async function typeAndRun(command) {
    await ready();
    await term.focus();
    await page.keyboard.type(command, { delay: 12 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
  }
  // The titlebar's own path chip (unrelated to this feature) already reports the session's cwd
  // with its full path in `title` — reused here purely as a readiness signal for `cd`.
  async function waitCwd(expected) {
    await page.waitForFunction(value => document.querySelector('.current-path')?.getAttribute('title') === value,
      expected, { timeout: 15000 });
  }

  await ready();
  await waitCwd(fixture);
  assert.doesNotMatch(await lastRow(), /git:\(/, 'No git segment outside a git repository');
  assert.equal(await page.locator('.status-strip').count(), 0, 'The status strip must not exist outside a git repository');

  await typeAndRun('cd project');
  await waitCwd(project);
  await ready();
  await page.waitForFunction(() => /git:\(/.test([...document.querySelectorAll('.shell-pane.active .xterm-rows > div')]
    .map(row => row.textContent).filter(Boolean).at(-1) ?? ''), undefined, { timeout: 10000 });
  assert.match(await lastRow(), /git:\(main → origin\/main ↑1\) ❯/, 'The prompt must show the branch and its upstream, one commit ahead');
  assert.equal(await page.locator('.status-chip.branch').count(), 0, 'The old branch chip must never exist — the branch lives in the prompt now');
  assert.equal(await page.locator('.status-strip').count(), 0, 'A clean working tree must show no status strip at all');

  // Modify a tracked file, then run any command (its "ready" afterward is what triggers a refresh).
  await typeAndRun("printf 'three\\n' >> file.txt");
  await ready();
  await changesChip.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('.status-chip.changes')?.innerText.includes('+1'), undefined, { timeout: 10000 });
  const changesText = (await changesChip.innerText()).replace(/\s+/g, ' ').trim();
  assert.match(changesText, /^1 • \+1 -0$/, `Unexpected changes chip text: "${changesText}"`);
  assert.equal(await page.locator('.status-chip.branch').count(), 0);
  await page.screenshot({ path: path.join(results, 'git-prompt.png') });

  // Same state, light theme — for visual review of the prompt segment's and changes chip's
  // contrast/colors (the segment's colors are plain ANSI, remapped through the terminal's own
  // light/dark theme, same as the existing cyan path and yellow ❯).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(results, 'git-prompt-light.png') });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await ready();

  // Commit the change so the working tree is clean again before leaving/switching branches.
  await typeAndRun('git commit -am wip');
  await ready();
  await changesChip.waitFor({ state: 'hidden', timeout: 10000 });
  assert.equal(await page.locator('.status-strip').count(), 0, 'Clean again: the strip disappears entirely');

  // Leaving the repository hides the prompt's git segment entirely.
  await typeAndRun('cd ../outside');
  await waitCwd(outside);
  await ready();
  await page.waitForFunction(() => !/git:\(/.test([...document.querySelectorAll('.shell-pane.active .xterm-rows > div')].map(row => row.textContent).filter(Boolean).at(-1) ?? ''), undefined, { timeout: 10000 });
  assert.doesNotMatch(await lastRow(), /git:\(/, 'The git segment must disappear outside a git repository');

  await typeAndRun('cd ../project');
  await waitCwd(project);
  await ready();
  await page.waitForFunction(() => /git:\(main /.test([...document.querySelectorAll('.shell-pane.active .xterm-rows > div')].map(row => row.textContent).filter(Boolean).at(-1) ?? ''), undefined, { timeout: 10000 });

  // Click the branch name right in the terminal: opens the same dropdown the old chip used to,
  // now anchored at the click point — filter input, current branch checked, feature-x listed.
  const historyBeforeSwitch = await history();
  await branchLink('main').click({ force: true });
  await branchMenu.waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('menuitemradio', { name: /^main/ }).waitFor({ state: 'visible', timeout: 10000 });
  const mainItem = page.locator('.branch-menu-item', { hasText: 'main' });
  const featureItem = page.locator('.branch-menu-item', { hasText: 'feature-x' });
  await featureItem.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await mainItem.getAttribute('aria-checked'), 'true', 'The current branch must be checked');
  assert.equal(await featureItem.getAttribute('aria-checked'), 'false');
  await page.screenshot({ path: path.join(results, 'git-branch-menu.png') });

  // Pick feature-x: it runs `git switch` in the real shell and must not be recorded as history.
  // feature-x has no upstream of its own, so the prompt falls back to the plain `git:(branch)`
  // form once the switch completes.
  await featureItem.click();
  await branchMenu.waitFor({ state: 'hidden', timeout: 5000 });
  await ready();
  await page.waitForFunction(() => /git:\(feature-x\) ❯/.test([...document.querySelectorAll('.shell-pane.active .xterm-rows > div')].map(row => row.textContent).filter(Boolean).at(-1) ?? ''), undefined, { timeout: 10000 });
  const historyAfterSwitch = await history();
  assert.deepEqual(historyAfterSwitch, historyBeforeSwitch, 'Switching branches from the dropdown must not be learned as command history');
  assert.ok(!historyAfterSwitch.some(entry => entry.command.includes('git switch')), 'No "git switch" command should ever appear in history');

  // Clicking the branch again (now feature-x, no upstream) re-opens the menu from the new spot.
  await branchLink('feature-x').click({ force: true });
  await branchMenu.waitFor({ state: 'visible', timeout: 10000 });
  await page.keyboard.press('Escape');
  await branchMenu.waitFor({ state: 'hidden', timeout: 5000 });

  assert.deepEqual(errors, []);
  console.log('Git smoke passed: the prompt\'s git segment reflects a real repo and its upstream and disappears outside one, the branch name there opens the branch dropdown and switches branches without polluting history, and the status strip holds only the changes chip.');
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'git-failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
