'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { normalizeSettings, DEFAULT_SETTINGS, LocalStore } = require('../electron/store.cjs');
const { PRESETS, normalizeAppearance, nearest256, shellThemes, writeShellThemes, themeFiles } = require('../electron/appearance.cjs');
const { prepareShell, defaultEnvironment } = require('../electron/shell.cjs');

test('settings without appearance keep the exact Mullion look for their theme', () => {
  const dark = normalizeSettings({});
  assert.equal(dark.theme, 'dark');
  assert.equal(dark.appearance.preset, 'mullion-dark');
  assert.deepEqual(dark.appearance.ui, PRESETS['mullion-dark'].ui);
  assert.deepEqual(dark.appearance.terminal, PRESETS['mullion-dark'].terminal);
  assert.deepEqual(dark.appearance.fonts, { terminalFamily: '', lineHeight: 1.22, uiFamily: '' });
  // The UI stylesheet's own dark tokens and the old hard-coded xterm.js theme.
  assert.equal(dark.appearance.ui.background, '#0e121a');
  assert.equal(dark.appearance.terminal.background, '#161c28');
  assert.equal(dark.appearance.terminal.cyan, '#4fd1c5');
  assert.ok(Object.values(dark.appearance.prompt).every(value => value === ''), 'the prompt keeps its built-in ANSI colors');
  const light = normalizeSettings({ theme: 'light', fontSize: 15 });
  assert.equal(light.appearance.preset, 'mullion-light');
  assert.equal(light.appearance.ui.background, '#f3f4f7');
  assert.equal(light.appearance.terminal.background, '#ffffff');
  assert.equal(light.fontSize, 15);
  assert.deepEqual(DEFAULT_SETTINGS.appearance, dark.appearance);
});

test('the Mullion presets follow the Light/Dark switch; other presets set the base themselves', () => {
  const dark = normalizeSettings({});
  assert.equal(normalizeSettings({ ...dark, theme: 'light' }).appearance.preset, 'mullion-light');
  assert.equal(normalizeSettings({ ...dark, theme: 'light' }).appearance.ui.background, '#f3f4f7');
  const solarized = normalizeSettings({ theme: 'dark', appearance: { preset: 'solarized-light' } });
  assert.equal(solarized.theme, 'light');
  assert.deepEqual(solarized.appearance.terminal, PRESETS['solarized-light'].terminal);
  const dracula = normalizeSettings({ theme: 'light', appearance: { preset: 'dracula', ui: { background: '#123456' } } });
  assert.equal(dracula.theme, 'dark');
  assert.equal(dracula.appearance.ui.background, PRESETS.dracula.ui.background, 'a named preset always carries its own colors');
});

test('custom colors accept #rrggbb only and fall back per key', () => {
  const { appearance, theme } = normalizeAppearance({
    preset: 'custom',
    ui: { background: '#ABCDEF', panel: 'red', text: '#fff', muted: '#12345', accent: '#12345g', border: 42, flag: '#00ff00', extra: '#000000' },
    terminal: { background: '#010203', black: '#0a0b0c', brightWhite: 'url(x)', unknown: '#000000' },
    prompt: { path: '', branch: '#FF00AA', ahead: "#000000'; rm -rf ~; '", behind: null, injected: '#000000' },
    fonts: { terminalFamily: 'JetBrains Mono', lineHeight: 9, uiFamily: 'x"; background:url(evil)' },
    extra: { anything: true },
  }, 'dark');
  assert.equal(theme, 'dark');
  assert.equal(appearance.preset, 'custom');
  assert.equal(appearance.ui.background, '#abcdef', 'lower-cased');
  for (const key of ['panel', 'text', 'muted', 'accent', 'border']) assert.equal(appearance.ui[key], PRESETS['mullion-dark'].ui[key], key);
  assert.equal(appearance.ui.flag, '#00ff00');
  assert.deepEqual(Object.keys(appearance.ui), ['background', 'panel', 'text', 'muted', 'accent', 'border', 'flag'], 'unknown keys are dropped');
  assert.equal(appearance.terminal.background, '#010203');
  assert.equal(appearance.terminal.black, '#0a0b0c');
  assert.equal(appearance.terminal.brightWhite, PRESETS['mullion-dark'].terminal.brightWhite);
  assert.equal(appearance.terminal.unknown, undefined);
  assert.equal(appearance.prompt.path, '', 'empty keeps the built-in color');
  assert.equal(appearance.prompt.branch, '#ff00aa');
  assert.equal(appearance.prompt.ahead, '', 'anything but a hex color is dropped');
  assert.equal(appearance.prompt.behind, '');
  assert.equal(appearance.prompt.injected, undefined);
  assert.deepEqual(appearance.fonts, { terminalFamily: 'JetBrains Mono', lineHeight: 1.8, uiFamily: '' });
  assert.equal(appearance.extra, undefined);
  assert.equal(normalizeAppearance({ fonts: { lineHeight: 0.2 } }).appearance.fonts.lineHeight, 1);
  assert.equal(normalizeAppearance({ fonts: { lineHeight: 1.234 } }).appearance.fonts.lineHeight, 1.23);
  assert.equal(normalizeAppearance({ fonts: { lineHeight: Number.NaN } }).appearance.fonts.lineHeight, 1.22);
  assert.equal(normalizeAppearance({ fonts: { terminalFamily: 'a'.repeat(121) } }).appearance.fonts.terminalFamily, '');
  assert.equal(normalizeAppearance({ fonts: { terminalFamily: '  Fira   Code, monospace ' } }).appearance.fonts.terminalFamily, 'Fira Code, monospace');
  assert.equal(normalizeAppearance({ preset: 'nope' }, 'light').appearance.preset, 'mullion-light');
  assert.equal(normalizeAppearance('garbage').appearance.preset, 'mullion-dark');
  assert.equal(normalizeSettings({ fontSize: 99 }).fontSize, 24);
  assert.equal(normalizeSettings({ fontSize: 2 }).fontSize, 10);
});

test('appearance survives a save and reload', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-appearance-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new LocalStore(directory);
  const { settings } = await store.load();
  const custom = { ...settings, appearance: { ...settings.appearance, preset: 'custom', prompt: { ...settings.appearance.prompt, branch: '#ff0000' } } };
  await store.saveSettings(custom);
  const reloaded = await new LocalStore(directory).load();
  assert.equal(reloaded.settings.appearance.preset, 'custom');
  assert.equal(reloaded.settings.appearance.prompt.branch, '#ff0000');
  // A snapshot is a copy: mutating it never changes the store.
  reloaded.settings.appearance.ui.background = '#000000';
  assert.notEqual(store.snapshot().settings.appearance.ui.background, '#000000');
});

test('nearest256 maps to the fixed xterm palette for zsh older than 5.7', () => {
  assert.equal(nearest256('#2f81f7'), 33, 'the flag blue keeps its long-standing fallback');
  assert.equal(nearest256('#000000'), 16);
  assert.equal(nearest256('#ffffff'), 231);
  assert.equal(nearest256('#ff0000'), 196);
  assert.equal(nearest256('#808080'), 244, 'grays use the gray ramp');
  assert.equal(nearest256('#5f87af'), 67);
});

test('shell theme files keep the built-in colors by default and embed only sanitized hex', () => {
  const defaults = shellThemes(normalizeSettings({}).appearance);
  assert.match(defaults.zsh, /__mullion_c_path='%F\{cyan\}'/);
  assert.match(defaults.zsh, /__mullion_c_branch='%F\{magenta\}'/);
  assert.match(defaults.zsh, /__mullion_highlight_face='fg=#2f81f7'/);
  assert.match(defaults.zsh, /__mullion_highlight_face='fg=33'/);
  assert.match(defaults.bash, /__mullion_c_path='\\\[\\e\[36m\\\]'/);
  assert.match(defaults.bash, /__mullion_c_git='\\\[\\e\[90m\\\]'/);
  assert.equal(defaults.powershell, 'path=\ngit=90\nbranch=35\nahead=32\nbehind=31\narrow=\nflag=38;2;47;129;247\n');

  const custom = shellThemes({ prompt: { path: '#4FD1C5', branch: '#ff0000', flag: '#00ff00', ahead: "#000000'; touch /tmp/pwned; '", behind: '$(id)' } });
  assert.match(custom.zsh, /if \(\( __mullion_truecolor \)\); then\n  __mullion_c_path='%F\{#4fd1c5\}'/);
  assert.match(custom.zsh, /else\n  __mullion_c_path='%F\{80\}'/, 'older zsh gets the nearest 256-color index');
  assert.match(custom.zsh, /__mullion_c_branch='%F\{196\}'/);
  assert.match(custom.zsh, /__mullion_highlight_face='fg=#00ff00'/);
  assert.match(custom.zsh, /__mullion_highlight_face='fg=46'/);
  assert.match(custom.bash, /__mullion_c_branch='\\\[\\e\[38;2;255;0;0m\\\]'/);
  assert.match(custom.powershell, /^branch=38;2;255;0;0$/m);
  assert.match(custom.powershell, /^flag=38;2;0;255;0$/m);
  for (const script of Object.values(custom)) {
    assert.doesNotMatch(script, /pwned|\$\(id\)/, 'malformed values never reach shell code');
    for (const line of script.split('\n').filter(line => line.includes('='))) {
      assert.match(line, /^(\s*__mullion_\w+='[%{}#0-9a-zF\\[\];=]*'|[a-z]+=[0-9;]*)$/, `only plain assignments: ${line}`);
    }
  }
  execFileSync('/bin/zsh', ['-n', '-c', custom.zsh]);
  execFileSync('/bin/bash', ['-n', '-c', custom.bash]);
});

test('theme files are written atomically into the theme directory', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-appearance-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeShellThemes(directory, { prompt: { branch: '#ff0000' } });
  const files = themeFiles(directory);
  assert.deepEqual(Object.keys(files), ['zsh', 'bash', 'powershell']);
  assert.match(await fs.readFile(files.bash, 'utf8'), /38;2;255;0;0/);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['theme-powershell.txt', 'theme.bash', 'theme.zsh'], 'no temporary files are left behind');
});

// The same python PTY bridge as shell-env.test.cjs: a real interactive shell, so precmd /
// PROMPT_COMMAND fire, without depending on node-pty's Electron ABI.
const PTY_BRIDGE = `import os, pty, sys, select, json, signal
config = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(config['cwd'])
    os.execv(config['shell'], [config['shell']] + config['args'])
while True:
    readable, _, _ = select.select([fd, sys.stdin.fileno()], [], [])
    for source in readable:
        try:
            data = os.read(source, 65536)
        except OSError:
            sys.exit(0)
        if not data:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            sys.exit(0)
        os.write(sys.stdout.fileno() if source == fd else fd, data)
`;

async function waitFor(predicate, reason, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(reason);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const shell of ['zsh', 'bash']) {
  const binary = `/bin/${shell}`;
  test(`an open ${shell} picks up new prompt colors at its next prompt`, { skip: process.platform === 'win32' || !fsSync.existsSync(binary) || !fsSync.existsSync('/usr/bin/python3') || !fsSync.existsSync('/usr/bin/git') }, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mullion-appearance-${shell}-`)));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    const themes = path.join(root, 'themes');
    for (const directory of [home, repo, themes]) await fs.mkdir(directory);
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: repo });
    await writeShellThemes(themes, normalizeSettings({}).appearance);
    const env = { ...defaultEnvironment(home), HISTFILE: path.join(root, 'history'), MULLION_GIT_PROMPT: '1' };
    delete env.ZDOTDIR;
    const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: `theme-${shell}`, home, env, shell: binary, platform: 'linux', themeDirectory: themes });
    const child = spawn('/usr/bin/python3', ['-c', PTY_BRIDGE, JSON.stringify({ cwd: repo, shell: launch.shell, args: launch.args })], { cwd: repo, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    const prompts = () => output.split(`theme-${shell};ready;`).length - 1;
    await waitFor(() => prompts() >= 1 && /git:\(/.test(output), `${shell} did not show its first prompt`);
    const magenta = shell === 'zsh' ? /\x1b\[35mmain/ : /\x1b\[35m(\x01|\x02)*main/;
    // zsh writes %F{magenta} as ESC[35m; bash writes the PS1 escape as-is.
    assert.match(output, magenta, 'the default branch color is plain ANSI magenta');

    await writeShellThemes(themes, { prompt: { branch: '#ff0000', path: '#00ff00' } });
    output = '';
    child.stdin.write('true\r');
    await waitFor(() => prompts() >= 1 && /main/.test(output.slice(output.lastIndexOf('git:('))), 'the next prompt did not appear');
    await waitFor(() => /38;2;255;0;0m(\x01|\x02)*main/.test(output), `the next ${shell} prompt uses the new branch color`);
    assert.match(output, /38;2;0;255;0m/, 'and the new path color');
  });
}
