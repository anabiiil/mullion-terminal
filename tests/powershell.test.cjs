'use strict';

// Drives the real PowerShell integration through ConPTY, the same way the app
// does. Windows-only: these are the shells the app actually starts there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { PromptParser } = require('../electron/osc.cjs');
const { prepareShell, defaultEnvironment, findExecutable, navigationRequest } = require('../electron/shell.cjs');

const windows = process.platform === 'win32';
const shells = windows ? [
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  findExecutable('pwsh.exe'),
].filter(Boolean) : [];

for (const shell of windows ? shells : ['powershell.exe']) {
  test(`${path.basename(shell)} integration: line editing, exit status and folder navigation`, { skip: !windows, timeout: 60000 }, async t => {
    const pty = require('node-pty');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-powershell-test-')));
    const home = path.join(root, 'start');
    const target = path.join(root, "destination ' $(New-Item NEVER); ملف");
    await fs.mkdir(home);
    await fs.mkdir(target);
    const launch = await prepareShell({ directory: path.join(root, 'integration'), nonce: 'pwsh-test', home, env: defaultEnvironment(home), shell, platform: 'win32' });
    // Switching input language (e.g. Arabic and English) while a tab is open
    // leaves PowerShell's keyboard layout different from ConPTY's, and then a
    // Ctrl+letter chord decodes as letters of the other layout ("ءل"). Start
    // the shell in that state; the app's own key sequences must still work.
    const encoded = launch.args.indexOf('-EncodedCommand') + 1;
    const mismatch = `Add-Type -Name KL -Namespace MullionTest -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string id, uint f); [DllImport("user32.dll")] public static extern IntPtr ActivateKeyboardLayout(IntPtr h, uint f); [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint t);'
$mullionTestLayout = if (([MullionTest.KL]::GetKeyboardLayout(0).ToInt64() -band 0xFFFF) -eq 0x0409) { '00000401' } else { '00000409' }
[void][MullionTest.KL]::ActivateKeyboardLayout([MullionTest.KL]::LoadKeyboardLayout($mullionTestLayout, 0), 0)
`;
    const args = [...launch.args];
    args[encoded] = Buffer.from(mismatch + Buffer.from(args[encoded], 'base64').toString('utf16le'), 'utf16le').toString('base64');
    const terminal = pty.spawn(launch.shell, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: home, env: launch.env, useConpty: true });
    t.after(async () => {
      try { terminal.kill(); } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    });

    let visible = '';
    const prompts = [];
    const commands = [];
    const navigations = [];
    let wake = () => {};
    const parser = new PromptParser('pwsh-test', prompt => { if (prompt.ready) prompts.push(prompt); wake(); },
      command => { commands.push(command); wake(); }, navigation => { navigations.push(navigation); wake(); });
    terminal.onData(data => { visible += parser.feed(data); wake(); });
    async function until(predicate, what) {
      const deadline = Date.now() + 20000;
      while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}. Output:\n${visible}`);
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, 100); });
      }
    }
    async function run(command) {
      const count = prompts.length;
      terminal.write(`${command}\r`);
      await until(() => prompts.length > count, `the prompt after ${command}`);
      return prompts.at(-1);
    }

    await until(() => prompts.length, 'the first prompt');
    assert.equal(prompts[0].navigation, true, 'PSReadLine bindings, including folder navigation, are installed');
    assert.equal(prompts[0].cwd, home);

    // The app replaces the input line with its line-reset sequence. With the
    // binding missing PSReadLine inserts the keyboard layout's letter instead.
    terminal.write('stale input');
    terminal.write(launch.lineReset);
    assert.equal((await run('Write-Output "replaced-$PID"')).status, 0);
    assert.equal(commands.at(-1), 'Write-Output "replaced-$PID"');
    // ConPTY renders output in frames, so it can trail the prompt's OSC.
    await until(() => /replaced-\d+/.test(visible), 'the replaced command output');

    // PSReadLine's own inline prediction (PowerShell 7) would sit after the
    // cursor and suppress the app's suggestions.
    await run('Write-Output "PREDICTION=[$((Get-PSReadLineOption).PredictionSource)]"');
    await until(() => /PREDICTION=\[(None)?\]/.test(visible) || /PREDICTION=\[\w+\]/.test(visible), 'the prediction source');
    assert.match(visible, /PREDICTION=\[(None)?\]/);

    assert.equal((await run('mullion-not-a-command-42')).status, 127, '"not recognized" reports 127 so it is never learned');
    assert.equal((await run('cmd.exe /d /c exit 3')).status, 1);
    assert.equal((await run('Get-Item -LiteralPath mullion-missing-file')).status, 1);
    assert.equal((await run('Write-Output fine')).status, 0);

    // Folder navigation keeps the pending input and never runs a visible command.
    terminal.write('Write-Output pending-input');
    await until(() => visible.includes('pending-input'), 'the pending input echo');
    const requestId = randomUUID();
    const before = visible.length;
    const commandCount = commands.length;
    await fs.writeFile(launch.navigationFile, navigationRequest(requestId, target));
    terminal.write(launch.navigationSequence);
    await until(() => navigations.length, 'the navigation acknowledgment');
    assert.deepEqual(navigations[0], { requestId, success: true, cwd: target });
    await until(() => visible.slice(before).includes('❯'), 'the redrawn prompt');
    assert(!visible.slice(before).includes('ملف ?'), 'The redrawn prompt keeps its ❯ glyph');
    const afterNavigation = await run('');
    assert.equal(commands.length, commandCount + 1, 'Only the pending command entered history');
    assert.equal(commands.at(-1), 'Write-Output pending-input');
    assert.equal(afterNavigation.cwd, target);
    await assert.rejects(fs.stat(path.join(target, 'NEVER')), { code: 'ENOENT' });
  });
}
