'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { defaultEnvironment, utf8Locale, prepareShell } = require('../electron/shell.cjs');
const { PromptParser } = require('../electron/osc.cjs');
const { version } = require('../package.json');

// Bridges a PTY to a child shell over plain pipes, the same way navigation.test.cjs does, so
// these tests don't depend on Electron's native node-pty ABI. Used by the exit-status tests
// below, which need a real interactive shell (precmd/PROMPT_COMMAND only fire with one).
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

async function waitFor(predicate, reason, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(reason);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// What a Finder/Dock launch hands the Electron main process on macOS.
const launchd = {
  HOME: '/Users/person', USER: 'person', LOGNAME: 'person', SHELL: '/bin/zsh',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/var/folders/xy/T/',
  SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.abc/Listeners', __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
  __CFBundleIdentifier: 'dev.mullion.terminal', COMMAND_MODE: 'unix2003',
  XPC_SERVICE_NAME: 'application.dev.mullion.terminal.1.2', XPC_FLAGS: '1', MallocNanoZone: '0',
};

test('app-internal variables never reach the shell; session variables do', () => {
  const env = defaultEnvironment('/Users/person', {
    ...launchd, LANG: 'en_GB.UTF-8',
    ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', TERMINAL_DEV_URL: 'http://localhost:5173',
    VSCODE_PID: '1', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5', TERM_SESSION_ID: 'w0t0p0', ITERM_SESSION_ID: 'x', LC_TERMINAL: 'iTerm2',
    SHLVL: '2', PWD: '/elsewhere', OLDPWD: '/before', _: '/usr/bin/open', NODE_OPTIONS: '--max-old-space-size=4096', GPG_TTY: '/dev/ttys001',
  }, 'darwin');
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_NO_ATTACH_CONSOLE', 'TERMINAL_DEV_URL', 'VSCODE_PID', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'LC_TERMINAL', 'XPC_SERVICE_NAME', 'XPC_FLAGS', 'MallocNanoZone', 'SHLVL', 'PWD', 'OLDPWD', '_']) {
    assert.equal(env[name], undefined, name);
  }
  for (const name of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING', '__CFBundleIdentifier', 'COMMAND_MODE', 'NODE_OPTIONS', 'GPG_TTY']) {
    assert.ok(env[name], name);
  }
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.TERM_PROGRAM, 'Mullion-Terminal');
  assert.equal(env.TERM_PROGRAM_VERSION, version);
  assert.equal(env.LANG, 'en_GB.UTF-8', 'an existing locale is kept');
});

test('launchd PATH order is kept and common directories are only appended', () => {
  const env = defaultEnvironment('/Users/person', launchd, 'darwin');
  const entries = env.PATH.split(':');
  assert.deepEqual(entries.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  assert.equal(new Set(entries).size, entries.length, 'no duplicates');
});

test('Windows keeps its environment, matching names case-insensitively', () => {
  const env = defaultEnvironment('C:\\Users\\person', {
    Path: 'C:\\Windows\\system32;C:\\Users\\person\\scoop\\shims', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\person',
    Electron_Run_As_Node: '1', WT_SESSION: 'abc', WT_PROFILE_ID: '{x}', PSModulePath: 'C:\\mods', ChocolateyInstall: 'C:\\ProgramData\\chocolatey',
  }, 'win32');
  assert.equal(env.Path, 'C:\\Windows\\system32;C:\\Users\\person\\scoop\\shims');
  assert.equal(env.PATH, undefined, 'PATH is not rewritten on Windows');
  assert.equal(env.Electron_Run_As_Node, undefined);
  assert.equal(env.WT_SESSION, undefined);
  assert.equal(env.WT_PROFILE_ID, undefined);
  assert.equal(env.PSModulePath, 'C:\\mods');
  assert.equal(env.ChocolateyInstall, 'C:\\ProgramData\\chocolatey');
  assert.equal(env.LANG, undefined, 'Windows uses code pages, not LANG');
});

test('Linux restores the desktop name Electron overrides', () => {
  const env = defaultEnvironment('/home/person', { PATH: '/usr/bin:/bin', LANG: 'de_DE.UTF-8', XDG_CURRENT_DESKTOP: 'Unity', ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME', CHROME_DESKTOP: 'mullion.desktop', APPIMAGE: '/x.AppImage', APPDIR: '/tmp/.mount', OWD: '/', ARGV0: 'x' }, 'linux');
  assert.equal(env.XDG_CURRENT_DESKTOP, 'GNOME');
  for (const name of ['ORIGINAL_XDG_CURRENT_DESKTOP', 'CHROME_DESKTOP', 'APPIMAGE', 'APPDIR', 'OWD', 'ARGV0']) assert.equal(env[name], undefined, name);
  assert.equal(env.LANG, 'de_DE.UTF-8');
});

test('a missing locale becomes UTF-8 from the system region, like Terminal.app', () => {
  const available = new Set(['en_US.UTF-8', 'ar_EG.UTF-8', 'fr_FR.UTF-8', 'zh_CN.UTF-8', 'de_DE.UTF-8']);
  const exists = name => available.has(name);
  const mac = locale => utf8Locale({}, { platform: 'darwin', locale, exists });
  assert.equal(mac('ar_EG'), 'ar_EG.UTF-8');
  assert.equal(mac('fr_BE'), 'fr_FR.UTF-8', 'falls back to the language’s main region');
  assert.equal(mac('en_EG'), 'en_US.UTF-8', 'falls back to en_US.UTF-8');
  assert.equal(mac('zh-Hans_CN'), 'zh_CN.UTF-8');
  assert.equal(mac('de_DE@rg=chzzzz'), 'de_DE.UTF-8');
  assert.equal(mac(''), 'en_US.UTF-8');
  assert.equal(utf8Locale({ LC_ALL: 'C' }, { platform: 'darwin', locale: 'en_US', exists }), null, 'LC_ALL is respected');
  assert.equal(utf8Locale({ LC_CTYPE: 'UTF-8' }, { platform: 'darwin', locale: 'en_US', exists }), null, 'LC_CTYPE is respected');
  assert.equal(utf8Locale({}, { platform: 'linux', locale: 'en-US', exists }), 'C.UTF-8');
  assert.equal(utf8Locale({}, { platform: 'win32', locale: 'en-US', exists }), null);
  const env = defaultEnvironment('/Users/person', launchd, 'darwin');
  assert.match(env.LANG, /^[a-z]{2,3}_[A-Z]{2}\.UTF-8$/, 'a Finder launch gets a UTF-8 LANG');
});

test('bash on macOS reads login files like Terminal.app (bash -l)', { skip: process.platform !== 'darwin' || !require('node:fs').existsSync('/bin/bash') }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-shell-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, '.bash_profile'), 'export MULLION_LOGIN=profile\nexport PATH="/opt/example/bin:$PATH"\n');
  await fs.writeFile(path.join(home, '.profile'), 'export MULLION_LOGIN=fallback\n');
  const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'n', home, shell: '/bin/bash', platform: 'darwin', env: defaultEnvironment(home, { ...launchd, HOME: home }, 'darwin') });
  const output = execFileSync(launch.shell, ['-c', `source "$1"; printf '%s|%s|%s' "$MULLION_LOGIN" "$PATH" "$LANG"`, 'bash', launch.args[1]], { env: { ...launch.env, HISTFILE: '/dev/null' }, encoding: 'utf8', cwd: home });
  const [login, pathValue, lang] = output.split('|');
  assert.equal(login, 'profile', 'only the first of .bash_profile/.bash_login/.profile runs');
  assert.equal(pathValue.split(':')[0], '/opt/example/bin', 'user PATH changes come after /etc/profile path_helper');
  assert.match(lang, /UTF-8$/);
});

test('zsh colors flags while typing, deferring to installed highlighters', () => {
  const { unixHooks, flagHighlighter } = require('../electron/shell.cjs');
  const script = unixHooks('n', 'zsh', '/tmp/navigation.request');
  assert.ok(script.endsWith(flagHighlighter()), 'runs after the user rc, hooks, and editor wrappers');
  assert.match(script, /"\$\{MULLION_HIGHLIGHT:-1\}" == 0/, 'MULLION_HIGHLIGHT=0 opts out');
  for (const name of ['ZSH_HIGHLIGHT_VERSION', 'FAST_HIGHLIGHT', 'functions[_zsh_highlight]', 'functions[fast-highlight-process]']) assert.ok(script.includes(`\${+${name}}`), name);
  assert.match(script, /autoload -Uz \+X add-zle-hook-widget/);
  assert.match(script, /add-zle-hook-widget line-pre-redraw __mullion_highlight\b/);
  assert.match(script, /add-zle-hook-widget -d line-pre-redraw __mullion_highlight\b/, 'sourcing twice (.zshrc, .zlogin) does not stack hooks');
  assert.ok(script.includes("'fg=#2f81f7'") && script.includes("'fg=33'"), 'truecolor with a 256-color fallback');
  assert.ok(script.includes('memo=mullion'));
  assert.doesNotMatch(flagHighlighter(), /^(?!__mullion_)[A-Za-z_][\w-]*\(\) \{/m, 'every function uses the __mullion_ prefix');
  assert.equal(unixHooks('n', 'bash', '/tmp/navigation.request').includes('__mullion_highlight'), false, 'bash readline cannot do this');
});

test('the zsh flag tokenizer replaces only its own region_highlight entries', { skip: !require('node:fs').existsSync('/bin/zsh') }, () => {
  const { flagHighlighter } = require('../electron/shell.cjs');
  // Outside ZLE, BUFFER and region_highlight are plain variables, so the widget
  // body can be exercised directly in both memo (5.9+) and legacy modes.
  const driver = `${flagHighlighter()}
__mullion_highlight_face='fg=#2f81f7'
for __mullion_highlight_memo in 1 ''; do
  region_highlight=('0 2 bold') __mullion_highlight_entries=()
  for BUFFER in 'git commit -m "a -b" -- x' 'ls -la --color=auto' "echo foo-bar|grep -v 'x' \\\\-y" 'echo'; do
    __mullion_highlight
    print -r -- "\${(j:,:)region_highlight}"
  done
done`;
  const lines = execFileSync('/bin/zsh', ['-f', '-c', driver], { encoding: 'utf8' }).trim().split('\n');
  const memo = ['0 2 bold,11 13 fg=#2f81f7 memo=mullion,21 23 fg=#2f81f7 memo=mullion', '0 2 bold,3 6 fg=#2f81f7 memo=mullion,7 19 fg=#2f81f7 memo=mullion', '0 2 bold,18 20 fg=#2f81f7 memo=mullion', '0 2 bold'];
  assert.deepEqual(lines, [...memo, ...memo.map(line => line.replaceAll(' memo=mullion', ''))]);
});

test('zsh highlights a typed flag in a real interactive shell', { skip: process.platform !== 'darwin' || !require('node:fs').existsSync('/bin/zsh') }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-shell-highlight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'n', home, shell: '/bin/zsh', platform: 'darwin', env: defaultEnvironment(home, { ...launchd, HOME: home }, 'darwin') });
  for (const file of ['.zshrc', '.zlogin']) execFileSync('/bin/zsh', ['-n', path.join(launch.env.ZDOTDIR, file)]);
  // zsh/zpty gives the shell a real terminal so ZLE runs its redraw hooks.
  const driver = `zmodload zsh/zpty || exit 2
zpty -b mullion env -i HOME="$H" ZDOTDIR="$Z" TERM=xterm-256color PATH=/usr/bin:/bin /bin/zsh -l -i
local chunk out phase=0
integer deadline=$(( SECONDS + 15 ))
while (( SECONDS < deadline )); do
  while zpty -r -t mullion chunk; do out+=$chunk; done
  if (( phase == 0 )) && [[ $out == *$'\\e[?2004h'* ]]; then zpty -w -n mullion 'ls --all'; phase=1; out=''; fi
  if (( phase == 1 )) && [[ $out == *'38;2;47;129;247m'* ]]; then print -n colored; break; fi
  sleep 0.1
done
zpty -d mullion`;
  const result = execFileSync('/bin/zsh', ['-f', '-c', driver], { env: { ...process.env, H: home, Z: launch.env.ZDOTDIR }, encoding: 'utf8', timeout: 30000 });
  assert.equal(result, 'colored');
});

test('PowerShell colors parameters blue only when the user kept the default color', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-shell-pwsh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'n', home: root, shell: '/usr/local/bin/pwsh', platform: 'darwin', env: { PATH: '/usr/bin:/bin' } });
  const script = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, await fs.readFile(path.join(root, 'integration', 'prompt.ps1'), 'utf8'));
  const block = script.slice(script.indexOf('ParameterColor') - 200);
  assert.match(block, /\n# Match the zsh flag color[^\n]*\n(#[^\n]*\n)*try \{\n  if \(\(Get-PSReadLineOption\)\.ParameterColor -eq "\$\(\[char\]0x1b\)\[90m"\) \{\n    Set-PSReadLineOption -Colors @\{ Parameter = "\$\(\[char\]0x1b\)\[38;2;47;129;247m" \} -ErrorAction Stop\n  \}\n\} catch \{ \}\n/);
  assert.ok(script.indexOf('$global:__mullion_navigation_available = 1\n} catch {') < script.indexOf('ParameterColor'), 'key handlers keep their own try/catch');
});

// A real prompt theme (pure, starship, powerlevel10k, …) registers its own precmd hook (zsh)
// or its own PROMPT_COMMAND entry (bash) in the user's rc file, and — like add-zsh-hook —
// that registration runs before ours, since our hooks are appended after the user's rc has
// already loaded. If our "ready" hook read $? directly, it would see whatever that hook last
// left behind (its own exit status, often forced to 0), not the status of the command the
// user actually ran: every command, typos included, would look like a success and get
// learned. The real exit status is only captured by a dedicated hook kept at the very front
// (zsh: index 1 of precmd_functions; bash: the first entry of PROMPT_COMMAND).
test("zsh reports the real exit status even when a prompt theme's own precmd hook runs first", { skip: process.platform === 'win32' || !require('node:fs').existsSync('/bin/zsh') || !require('node:fs').existsSync('/usr/bin/python3') }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-status-zsh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, '.zshrc'), "autoload -Uz add-zsh-hook\n__user_theme_precmd() { return 0; }\nadd-zsh-hook precmd __user_theme_precmd\n");
  const env = { ...defaultEnvironment(home), HISTFILE: path.join(root, 'isolated-history') };
  delete env.ZDOTDIR;
  const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'status-zsh', home, env, shell: '/bin/zsh', platform: 'linux' });
  const child = spawn('/usr/bin/python3', ['-c', PTY_BRIDGE, JSON.stringify({ cwd: home, shell: launch.shell, args: launch.args })], { cwd: home, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const statuses = [];
  const parser = new PromptParser('status-zsh', prompt => { if (prompt.ready && typeof prompt.status === 'number') statuses.push(prompt.status); });
  child.stdout.on('data', data => parser.feed(data.toString()));
  child.on('error', error => assert.fail(error));
  await waitFor(() => statuses.length >= 1, 'zsh did not start');
  child.stdin.write('definitely-not-a-command-xyz\r');
  await waitFor(() => statuses.length >= 2, 'The typo command did not complete');
  child.stdin.write('true\r');
  await waitFor(() => statuses.length >= 3, '"true" did not complete');
  assert.equal(statuses[1], 127, "the real \"command not found\" status, not the theme's precmd return value");
  assert.equal(statuses[2], 0);
});

test("bash reports the real exit status even when a prompt theme's own PROMPT_COMMAND runs first", { skip: process.platform === 'win32' || !require('node:fs').existsSync('/bin/bash') || !require('node:fs').existsSync('/usr/bin/python3') }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-status-bash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, '.bashrc'), '__user_theme_prompt_command() { return 0; }\nPROMPT_COMMAND="__user_theme_prompt_command"\n');
  const env = { ...defaultEnvironment(home), HISTFILE: path.join(root, 'isolated-history') };
  const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'status-bash', home, env, shell: '/bin/bash', platform: 'linux' });
  const child = spawn('/usr/bin/python3', ['-c', PTY_BRIDGE, JSON.stringify({ cwd: home, shell: launch.shell, args: launch.args })], { cwd: home, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const statuses = [];
  const parser = new PromptParser('status-bash', prompt => { if (prompt.ready && typeof prompt.status === 'number') statuses.push(prompt.status); });
  child.stdout.on('data', data => parser.feed(data.toString()));
  child.on('error', error => assert.fail(error));
  await waitFor(() => statuses.length >= 1, 'bash did not start');
  child.stdin.write('definitely-not-a-command-xyz\r');
  await waitFor(() => statuses.length >= 2, 'The typo command did not complete');
  child.stdin.write('true\r');
  await waitFor(() => statuses.length >= 3, '"true" did not complete');
  assert.equal(statuses[1], 127, "the real \"command not found\" status, not the theme's PROMPT_COMMAND return value");
  assert.equal(statuses[2], 0);
});
