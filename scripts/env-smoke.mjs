import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Login-shell parity: an app opened from Finder/Dock gets launchd's minimal
// environment, not a terminal's. Rebuild that environment here, then start the
// real shell through prepareShell + node-pty exactly as the main process does.
if (process.platform === 'win32') {
  console.log('env smoke skipped: macOS/Linux only');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const home = os.homedir();
const inherited = { ...process.env };
const launchd = {
  HOME: home,
  USER: inherited.USER || os.userInfo().username,
  LOGNAME: inherited.LOGNAME || os.userInfo().username,
  SHELL: inherited.SHELL || '/bin/zsh',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  TMPDIR: inherited.TMPDIR || os.tmpdir(),
  ...(inherited.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: inherited.SSH_AUTH_SOCK } : {}),
  ...(inherited.__CF_USER_TEXT_ENCODING ? { __CF_USER_TEXT_ENCODING: inherited.__CF_USER_TEXT_ENCODING } : {}),
  // App-internal variables a packaged Electron app receives or a dev launch leaks.
  __CFBundleIdentifier: 'dev.mullion.terminal',
  XPC_SERVICE_NAME: 'application.dev.mullion.terminal.1.2',
  XPC_FLAGS: '1',
  MallocNanoZone: '0',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_ENABLE_LOGGING: '1',
  TERM_PROGRAM_VERSION: '9.9',
  SHLVL: '3',
};
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, launchd);
const { defaultEnvironment, prepareShell } = require('../electron/shell.cjs');

const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(file => existsSync(file));
const shells = [...new Set([launchd.SHELL, process.platform === 'darwin' ? '/bin/zsh' : null, '/bin/bash'])].filter(shell => shell && existsSync(shell) && ['zsh', 'bash'].includes(path.basename(shell)));
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-env-smoke-')));
const strip = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

async function run(shell) {
  const nonce = `env${Math.random().toString(16).slice(2)}`;
  const launch = await prepareShell({ directory: path.join(temporary, path.basename(shell)), nonce, home, env: defaultEnvironment(home), shell });
  const terminal = pty.spawn(launch.shell, launch.args, { name: 'xterm-256color', cols: 200, rows: 40, cwd: home, env: launch.env });
  let output = '';
  let readies = 0;
  terminal.onData(data => {
    output += data;
    readies += data.split(`]777;Mullion;${nonce};ready;`).length - 1;
  });
  const until = async (predicate, message, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`${path.basename(shell)}: ${message}\n${strip(output).slice(-3000)}`);
  };
  try {
    await until(() => readies > 0, 'shell never reported a ready prompt');
    const probe = [
      'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'SHLVL', 'XPC_SERVICE_NAME', 'MallocNanoZone',
    ].map(name => `printf '@@${name}=%s\\n' "\${${name}-}"`);
    terminal.write(`${probe.join('; ')}; printf '@@ELECTRON=%s\\n' "$(env | command grep -c '^ELECTRON_')"; printf '@@TTY=%s\\n' "$(tty)"; printf '@@BREW=%s\\n' "$(command -v brew)"; printf '@@BREWV=%s\\n' "$(brew --version 2>&1 | head -1)"; printf '@@CHARMAP=%s\\n' "$(locale charmap 2>/dev/null)"; printf '@@SSH=%s\\n' "\${SSH_AUTH_SOCK-}"; printf '@@END\\n'\r`);
    await until(() => /@@END\n/.test(strip(output)), 'probe did not finish');
    const values = Object.fromEntries([...strip(output).matchAll(/^@@([A-Za-z_]+)=(.*)$/gm)].map(match => [match[1], match[2]]));
    const name = path.basename(shell);
    console.log(`${name}:`, JSON.stringify(values, null, 1));
    const entries = values.PATH.split(':');
    if (brew) {
      const directory = path.dirname(brew);
      assert.ok(entries.includes(directory), `${name}: PATH lacks ${directory}: ${values.PATH}`);
      assert.equal(values.BREW, brew, `${name}: brew resolves to ${values.BREW}`);
      assert.match(values.BREWV, /^Homebrew \d/, `${name}: brew --version failed: ${values.BREWV}`);
    }
    for (const directory of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) assert.ok(entries.includes(directory), `${name}: PATH lacks ${directory}`);
    assert.match(values.LC_ALL || values.LC_CTYPE || values.LANG, /UTF-?8/i, `${name}: locale is not UTF-8`);
    assert.equal(values.CHARMAP, 'UTF-8', `${name}: locale charmap`);
    assert.equal(values.TERM, 'xterm-256color');
    assert.equal(values.TERM_PROGRAM, 'Mullion-Terminal');
    assert.equal(values.TERM_PROGRAM_VERSION, require('../package.json').version, `${name}: another terminal's version leaked`);
    assert.equal(values.ELECTRON, '0', `${name}: Electron variables leaked into the shell`);
    assert.equal(values.XPC_SERVICE_NAME, '', `${name}: the app's XPC service name leaked`);
    assert.equal(values.MallocNanoZone, '', `${name}: Electron's malloc setting leaked`);
    assert.equal(values.SHLVL, '1', `${name}: SHLVL should start at 1 like a fresh terminal`);
    assert.equal(values.SSH, launchd.SSH_AUTH_SOCK || '', `${name}: SSH agent socket must be kept`);
    assert.match(values.TTY, /^\/dev\/(ttys|pts\/)\d+$/, `${name}: not a real tty: ${values.TTY}`);
    // sudo must prompt on the PTY like any terminal. The password is never typed;
    // Ctrl+C cancels the prompt and the shell must return to a ready prompt.
    if (existsSync('/usr/bin/sudo')) {
      const before = readies;
      const mark = output.length;
      terminal.write('sudo -k; sudo -v\r');
      await until(() => /password/i.test(strip(output.slice(mark))), 'sudo did not show a password prompt', 10000);
      terminal.write('\x03');
      await until(() => readies > before, 'shell did not return to a prompt after cancelling sudo', 10000);
      console.log(`${name}: sudo prompted for a password and cancelled cleanly`);
    }
  } finally {
    terminal.kill();
  }
}

try {
  for (const shell of shells) await run(shell);
  console.log(`env smoke passed (${shells.map(shell => path.basename(shell)).join(', ')})`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
