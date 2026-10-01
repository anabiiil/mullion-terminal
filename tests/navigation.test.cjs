'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { PromptParser } = require('../electron/osc.cjs');
const { prepareShell, defaultEnvironment, navigationRequest, NAVIGATION_SEQUENCE } = require('../electron/shell.cjs');
const { directoryCommand } = require('../electron/completions.cjs');

test('navigation OSC acknowledgments are filtered across split chunks and verified by nonce', () => {
  const requestId = randomUUID();
  const cwd = "/project's path/ملف";
  const marker = `\x1b]777;Mullion;nav-secret;navigate;${requestId};1;${Buffer.from(cwd).toString('base64')}\x07`;
  for (let split = 1; split < marker.length; split++) {
    const events = [];
    const parser = new PromptParser('nav-secret', () => {}, () => {}, event => events.push(event));
    assert.equal(parser.feed(marker.slice(0, split)) + parser.feed(marker.slice(split)), '');
    assert.deepEqual(events, [{ requestId, success: true, cwd }]);
  }
  const unknown = marker.replace('nav-secret', 'different-nonce');
  const parser = new PromptParser('nav-secret', () => {}, () => {}, () => { throw new Error('Unknown nonce accepted'); });
  assert.equal(parser.feed(unknown), unknown);
});

test('navigation request treats shell metacharacters and newline as literal path data', () => {
  const requestId = randomUUID();
  const target = "path ' $(touch NEVER); newline\nملف";
  assert.deepEqual(navigationRequest(requestId, target).toString('utf8').split('\0'), [requestId, target, '']);
  assert.throws(() => navigationRequest('unknown', target), /Invalid/);
  assert.throws(() => navigationRequest(requestId, 'bad\0path'), /Invalid/);
});

for (const shellName of ['zsh', 'bash']) {
  test(`${shellName} private widget changes cwd in the same PTY, preserving pending input and history`, { skip: process.platform === 'win32' }, async t => {
    const shell = `/bin/${shellName}`;
    try { await fs.access(shell); await fs.access('/usr/bin/python3'); } catch { t.skip('Shell or Python PTY bridge unavailable'); return; }
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-navigation-test-'));
    const root = await fs.realpath(temporary);
    const home = path.join(root, 'start');
    const target = path.join(root, "destination ' $(touch NEVER); ملف");
    await fs.mkdir(home);
    await fs.mkdir(target);
    await fs.writeFile(path.join(home, shellName === 'zsh' ? '.zshrc' : '.bashrc'), "export MULLION_NAV_SENTINEL='kept'\n");
    const env = { ...defaultEnvironment(home), HISTFILE: path.join(root, 'isolated-history') };
    delete env.ZDOTDIR;
    const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'navigation-test', home, env, shell, platform: 'linux' });
    // The macOS script utility requires TTY stdin; Python bridges our pipe to a
    // genuine child PTY without depending on Electron's native node-pty ABI.
    const bridge = `import os, pty, sys, select, json, signal\nconfig = json.loads(sys.argv[1])\npid, fd = pty.fork()\nif pid == 0:\n    os.chdir(config['cwd'])\n    os.execv(config['shell'], [config['shell']] + config['args'])\nwhile True:\n    readable, _, _ = select.select([fd, sys.stdin.fileno()], [], [])\n    for source in readable:\n        try:\n            data = os.read(source, 65536)\n        except OSError:\n            sys.exit(0)\n        if not data:\n            try: os.kill(pid, signal.SIGKILL)\n            except ProcessLookupError: pass\n            sys.exit(0)\n        os.write(sys.stdout.fileno() if source == fd else fd, data)\n`;
    const child = spawn('/usr/bin/python3', ['-c', bridge, JSON.stringify({ cwd: home, shell: launch.shell, args: launch.args })], { cwd: home, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let nativePid;
    const cleanup = async () => {
      child.kill('SIGKILL');
      if (nativePid) { try { process.kill(nativePid, 'SIGKILL'); } catch {} }
      await fs.rm(temporary, { recursive: true, force: true });
    };
    t.after(cleanup);
    const requestId = randomUUID();
    const stateCommand = 'printf "NAV-STATE:%s:%s\\n" "$$" "$MULLION_NAV_SENTINEL"';
    const pendingCommand = 'printf "PENDING:%s:%s\\n" "$$" "$MULLION_NAV_SENTINEL"';
    const typedCd = directoryCommand(home, 'linux');
    let stage = 0;
    let visible = '';
    let navStart = 0;
    let navEnd = 0;
    const recorded = [];
    let finish;
    let fail;
    const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const parser = new PromptParser('navigation-test', prompt => {
      if (!prompt.ready) { assert.notEqual(stage, 2, 'Widget navigation must not mark the prompt busy'); return; }
      if (stage === 0) {
        assert.equal(prompt.navigation, true);
        stage = 1;
        child.stdin.write(`${stateCommand}\r`);
      } else if (stage === 1) {
        stage = 2;
        navStart = visible.length;
        child.stdin.write(pendingCommand);
        fs.writeFile(launch.navigationFile, navigationRequest(requestId, target), { mode: 0o600 }).then(() => child.stdin.write(NAVIGATION_SEQUENCE)).catch(fail);
      } else if (stage === 3 && recorded.length >= 2) {
        stage = 4;
        navEnd = visible.length;
        child.stdin.write(`${typedCd}\r`);
      } else if (stage === 4 && recorded.length >= 3) {
        stage = 5;
        finish();
      }
    }, value => recorded.push(value), navigation => {
      try {
        assert.equal(navigation.requestId, requestId);
        assert.equal(navigation.success, true);
        assert.equal(navigation.cwd, target);
        assert.equal(recorded.length, 1, 'Navigation must not enter learned command history');
        stage = 3;
        // The widget leaves the existing command buffer intact; Enter executes it.
        child.stdin.write('\r');
      } catch (error) { fail(error); }
    });
    const output = data => {
      try {
        visible += parser.feed(data.toString());
        const match = visible.match(/NAV-STATE:(\d+):kept/);
        if (match) nativePid = Number(match[1]);
      } catch (error) { fail(error); }
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.on('error', fail);
    let timer;
    try {
      await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Navigation failed at stage ${stage}: ${visible}`)), 5000); })]);
      assert.deepEqual(recorded, [stateCommand, pendingCommand, typedCd]);
      assert(nativePid, 'Initial shell PID was captured');
      assert(visible.includes(`PENDING:${nativePid}:kept`), 'Pending input, shell variables, and process identity were preserved');
      const navigationOutput = visible.slice(navStart, navEnd);
      assert(!navigationOutput.includes(target), 'Absolute internal cd must not be echoed');
      assert(!navigationOutput.includes('builtin cd'), 'No internal cd command is printed');
      if (shellName === 'zsh') assert(navigationOutput.includes(path.basename(target)), 'ZLE redraws the current prompt');
      else {
        assert(!visible.includes('start ❯ '), 'Bash must not display a stale directory name');
        assert(!visible.includes(`${path.basename(target)} ❯ `), 'Bash uses the live header as its path display');
      }
      assert(!/\x1b\[[23]J/.test(navigationOutput), 'Scrollback is not cleared');
      await assert.rejects(fs.stat(path.join(target, 'NEVER')), { code: 'ENOENT' });
    } finally { clearTimeout(timer); await cleanup(); }
  });
}

test('Bash keeps character echo after quiet navigation, Ctrl+C, and closing another PTY', { skip: process.platform === 'win32' }, async t => {
  try { await fs.access('/bin/bash'); await fs.access('/usr/bin/python3'); } catch { t.skip('Bash or Python PTY bridge unavailable'); return; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-bash-redisplay-'));
  const root = await fs.realpath(temporary);
  const home = path.join(root, 'start');
  const target = path.join(root, 'next directory');
  await fs.mkdir(home);
  await fs.mkdir(target);
  await fs.writeFile(path.join(home, '.bashrc'), 'export MULLION_REDISPLAY_SENTINEL=kept\n');
  const processes = [];
  t.after(async () => {
    for (const session of processes) {
      if (session.pid) { try { process.kill(session.pid, 'SIGKILL'); } catch {} }
      session.child.kill('SIGKILL');
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const waitFor = async (predicate, reason) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() >= deadline) assert.fail(reason);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const start = async label => {
    const launch = await prepareShell({ directory: path.join(root, label), nonce: label, home, env: { ...defaultEnvironment(home), HISTFILE: path.join(root, `${label}.history`) }, shell: '/bin/bash', platform: 'linux' });
    const bridge = `import os, pty, sys, select, json, signal\nconfig = json.loads(sys.argv[1])\npid, fd = pty.fork()\nif pid == 0:\n    os.chdir(config['cwd'])\n    os.execv(config['shell'], [config['shell']] + config['args'])\nprint('CHILD-PID:' + str(pid), file=sys.stderr, flush=True)\nwhile True:\n    readable, _, _ = select.select([fd, sys.stdin.fileno()], [], [])\n    for source in readable:\n        try: data = os.read(source, 65536)\n        except OSError: sys.exit(0)\n        if not data:\n            try: os.kill(pid, signal.SIGKILL)\n            except ProcessLookupError: pass\n            sys.exit(0)\n        os.write(sys.stdout.fileno() if source == fd else fd, data)\n`;
    const child = spawn('/usr/bin/python3', ['-c', bridge, JSON.stringify({ cwd: home, shell: launch.shell, args: launch.args })], { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = { child, launch, prompts: 0, visible: '', history: [], navigations: [], pid: 0, exited: false };
    processes.push(session);
    const parser = new PromptParser(label, prompt => { if (prompt.ready) session.prompts++; }, command => session.history.push(command), navigation => session.navigations.push(navigation));
    child.stdout.on('data', data => { session.visible += parser.feed(data.toString()); });
    child.stderr.on('data', data => { session.pid = Number(data.toString().match(/CHILD-PID:(\d+)/)?.[1]) || session.pid; });
    child.on('exit', () => { session.exited = true; });
    await waitFor(() => session.prompts > 0 && session.pid > 0, 'Bash did not start');
    return session;
  };
  const run = async (session, command) => {
    const before = session.prompts;
    session.child.stdin.write(`${command}\r`);
    await waitFor(() => session.prompts > before, 'Bash command did not return a prompt');
  };
  const first = await start('first');
  await run(first, 'printf "IDENTITY:%s:%s\\n" "$$" "$MULLION_REDISPLAY_SENTINEL"');
  const requestId = randomUUID();
  await fs.writeFile(first.launch.navigationFile, navigationRequest(requestId, target), { mode: 0o600 });
  first.child.stdin.write(NAVIGATION_SEQUENCE);
  await waitFor(() => first.navigations.length === 1, 'Quiet navigation did not complete');
  assert.equal(first.navigations[0].cwd, target);
  first.child.stdin.write('cat\r');
  await waitFor(() => first.visible.includes('cat\r\n'), 'Cat input was not echoed');
  first.child.stdin.write('INTERACTIVE-INPUT\r');
  const beforeInterrupt = first.prompts;
  first.child.stdin.write('\x03');
  await waitFor(() => first.prompts > beforeInterrupt, 'Ctrl+C did not restore the shell prompt');
  const beforeEcho = first.visible.length;
  first.child.stdin.write('echo');
  await waitFor(() => first.visible.slice(beforeEcho).includes('echo'), 'Readline stopped displaying typed characters after Ctrl+C');
  first.child.stdin.write('\x15');
  const second = await start('second');
  process.kill(second.pid, 'SIGHUP');
  await waitFor(() => second.exited, 'The second shell did not close');
  const retainedEcho = first.visible.length;
  first.child.stdin.write('printf');
  await waitFor(() => first.visible.slice(retainedEcho).includes('printf'), 'Closing another PTY disabled the retained shell input');
  first.child.stdin.write('\x15');
  await run(first, 'printf "RETAINED:%s:%s\\n" "$$" "$MULLION_REDISPLAY_SENTINEL"');
  assert(first.visible.includes(`RETAINED:${first.pid}:kept`), 'The retained shell PID and variables changed');
  assert(first.history.includes('cat'), 'Actual interactive commands remain learned');
  assert(!first.history.some(command => command.includes('__mullion') || command.includes(target)), 'Navigation must remain absent from command history');
  // Respect an explicit no-echo terminal chosen by the user at a native prompt.
  await run(first, 'stty -echo');
  const quietRequest = randomUUID();
  await fs.writeFile(first.launch.navigationFile, navigationRequest(quietRequest, home), { mode: 0o600 });
  first.child.stdin.write(NAVIGATION_SEQUENCE);
  await waitFor(() => first.navigations.length === 2, 'No-echo navigation did not complete');
  const quietEcho = first.visible.length;
  first.child.stdin.write('USER-NO-ECHO');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert(!first.visible.slice(quietEcho).includes('USER-NO-ECHO'), 'Navigation overrode the explicit no-echo setting');
});
