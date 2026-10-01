import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Terminal } from '@xterm/xterm';
import { ShellInputTracker } from '../src/input-tracker';

interface FakeLine { text: string; isWrapped: boolean }
function fakeTerminal(cols = 80) {
  const lines: FakeLine[] = [{ text: '$ ', isWrapped: false }];
  const active = {
    type: 'normal', baseY: 0, cursorY: 0, cursorX: 2,
    getLine(row: number) {
      const line = lines[row];
      if (!line) return undefined;
      return {
        isWrapped: line.isWrapped,
        translateToString(trim: boolean, start = 0, end = cols) {
          // Tests below use BMP narrow text for fake display-cell boundaries;
          // real xterm is separately responsible for Unicode column widths.
          const value = line.text.slice(start, end);
          return trim ? value.trimEnd() : value;
        },
      };
    },
  };
  const markers: { line: number; isDisposed: boolean; dispose(): void }[] = [];
  const terminal = {
    cols, buffer: { active },
    registerMarker(offset = 0) {
      const marker = { line: active.baseY + active.cursorY + offset, isDisposed: false, dispose() { this.isDisposed = true; } };
      markers.push(marker);
      return marker;
    },
  };
  function echo(value: string) {
    const text = '$ ' + value;
    lines.splice(0, lines.length);
    for (let index = 0; index < text.length || index === 0; index += cols) {
      lines.push({ text: text.slice(index, index + cols), isWrapped: index > 0 });
    }
    active.cursorY = lines.length - 1;
    active.cursorX = lines.at(-1)!.text.length;
  }
  return {
    terminal: terminal as unknown as Terminal, active, lines, markers, echo,
    resize: (width: number) => { terminal.cols = width; },
  };
}

test('input is unavailable until actual echo confirms it, and resets before submission', () => {
  const { terminal, echo } = fakeTerminal();
  const tracker = new ShellInputTracker();
  tracker.beforeInput('git', terminal);
  assert.equal(tracker.readLine(terminal), null);
  echo('git');
  assert.equal(tracker.readLine(terminal), 'git');
  const revision = tracker.revision;
  tracker.beforeInput(' s', terminal);
  assert.ok(tracker.revision > revision);
  assert.equal(tracker.readLine(terminal), null);
  echo('git s');
  assert.equal(tracker.readLine(terminal), 'git s');
  tracker.beforeInput('\r', terminal);
  assert.equal(tracker.readLine(terminal), null);
});

test('backspace and Unicode input require matching display echo', () => {
  const { terminal, echo } = fakeTerminal();
  const tracker = new ShellInputTracker();
  tracker.beforeInput('cd مشروعات', terminal);
  echo('cd مشروعات');
  assert.equal(tracker.readLine(terminal), 'cd مشروعات');
  tracker.beforeInput('\x7f', terminal);
  assert.equal(tracker.readLine(terminal), null);
  echo('cd مشروعا');
  assert.equal(tracker.readLine(terminal), 'cd مشروعا');
});

test('wrapped terminal rows belong to one input line; continuation prompts do not', () => {
  const { terminal, echo, lines } = fakeTerminal(10);
  const tracker = new ShellInputTracker();
  tracker.beforeInput('git status --short', terminal);
  echo('git status --short');
  assert.equal(tracker.readLine(terminal), 'git status --short');
  lines[1].isWrapped = false;
  assert.equal(tracker.readLine(terminal), null);
});

test('native tab and unknown cursor/history movement block partial-line tracking', () => {
  for (const control of ['\t', '\x1b[A', '\x1b[D', '\x01']) {
    const { terminal, echo } = fakeTerminal();
    const tracker = new ShellInputTracker();
    tracker.beforeInput('git', terminal);
    echo('git');
    tracker.beforeInput(control, terminal);
    tracker.beforeInput(' status', terminal);
    echo('git status');
    assert.equal(tracker.readLine(terminal), null);
    tracker.beforeInput('\x15', terminal);
    echo('');
    tracker.beforeInput('pwd', terminal);
    echo('pwd');
    assert.equal(tracker.readLine(terminal), 'pwd');
  }
});

test('password input, alternate screens and program output cannot become input', () => {
  const { terminal, echo, active } = fakeTerminal();
  const tracker = new ShellInputTracker();
  tracker.beforeInput('secret', terminal);
  assert.equal(tracker.readLine(terminal), null);
  echo('unrelated program output');
  assert.equal(tracker.readLine(terminal), null);
  tracker.reset();
  active.type = 'alternate';
  tracker.beforeInput('git', terminal);
  echo('git');
  assert.equal(tracker.readLine(terminal), null);
});

test('single-line bracketed paste can complete; multiline paste cannot', () => {
  const { terminal, echo } = fakeTerminal();
  const tracker = new ShellInputTracker();
  tracker.beforeInput('\x1b[200~git status\x1b[201~', terminal);
  echo('git status');
  assert.equal(tracker.readLine(terminal), 'git status');
  tracker.beforeInput('\x1b[200~pwd\nls\x1b[201~', terminal);
  echo('ls');
  assert.equal(tracker.readLine(terminal), null);
});

test('reset disposes anchors and resizing finds the complete echoed line again', () => {
  const { terminal, echo, markers, resize } = fakeTerminal();
  const tracker = new ShellInputTracker();
  tracker.beforeInput('git', terminal);
  echo('git');
  tracker.reset();
  assert.equal(markers[0].isDisposed, true);
  echo('');
  tracker.beforeInput('pwd', terminal);
  echo('pwd');
  resize(100);
  assert.equal(tracker.readLine(terminal), 'pwd');
  assert.equal(markers[1].isDisposed, true);
});

test('full replacement recovers tracking after native history and middle-of-line editing', () => {
  const { terminal, echo, active } = fakeTerminal();
  const tracker = new ShellInputTracker();
  tracker.beforeInput('\x1b[A', terminal);
  echo('git log --oneline');
  active.cursorX = 7;
  assert.equal(tracker.readLine(terminal), null);
  tracker.beforeReplacement('git status', terminal);
  assert.equal(tracker.readLine(terminal), null);
  echo('git status');
  assert.equal(tracker.readLine(terminal), 'git status');
  tracker.beforeInput(' --short', terminal);
  echo('git status --short');
  assert.equal(tracker.readLine(terminal), 'git status --short');
});

test('replacement echo can anchor at an earlier wrapped row', () => {
  const { terminal, echo } = fakeTerminal(10);
  const tracker = new ShellInputTracker();
  tracker.beforeReplacement('git status --short', terminal);
  echo('git status --short');
  assert.equal(tracker.readLine(terminal), 'git status --short');
  tracker.beforeInput('x', terminal);
  echo('git status --shortx');
  assert.equal(tracker.readLine(terminal), 'git status --shortx');
});

test('Ctrl+U followed by replacement before echo preserves the line start', () => {
  const { terminal, echo } = fakeTerminal();
  const tracker = new ShellInputTracker();
  tracker.beforeInput('git s', terminal);
  echo('git s');
  assert.equal(tracker.readLine(terminal), 'git s');
  tracker.beforeInput('\x15', terminal);
  tracker.beforeInput('git status', terminal);
  assert.equal(tracker.readLine(terminal), null);
  echo('git status');
  assert.equal(tracker.readLine(terminal), 'git status');
});

test('line-end detection rejects cursor edits and additional wrapped content', () => {
  const { terminal, echo, active, lines } = fakeTerminal();
  const tracker = new ShellInputTracker();
  echo('git status');
  assert.equal(tracker.isAtLineEnd(terminal), true);
  active.cursorX = 5;
  assert.equal(tracker.isAtLineEnd(terminal), false);
  echo('git status');
  lines.push({ text: ' more', isWrapped: true });
  assert.equal(tracker.isAtLineEnd(terminal), false);
});

test('real xterm verifies Unicode display cells, wrapping and resize reflow', async () => {
  const Xterm = createRequire(`${process.cwd()}/package.json`)('@xterm/xterm').Terminal as typeof import('@xterm/xterm').Terminal;
  const terminal = new Xterm({ cols: 10, rows: 6 });
  const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
  try {
    const tracker = new ShellInputTracker();
    await write('$ ');
    const command = 'cd 界🌍/مشروعات';
    tracker.beforeInput(command, terminal);
    await write(command);
    assert.equal(tracker.readLine(terminal), command);
    terminal.resize(13, 6);
    assert.equal(tracker.readLine(terminal), command);
    tracker.beforeInput('x', terminal);
    await write('x');
    assert.equal(tracker.readLine(terminal), command + 'x');
  } finally { terminal.dispose(); }
});

test('real xterm anchors a full Unicode replacement after unsupported native input', async () => {
  const Xterm = createRequire(`${process.cwd()}/package.json`)('@xterm/xterm').Terminal as typeof import('@xterm/xterm').Terminal;
  const terminal = new Xterm({ cols: 10, rows: 6 });
  const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
  try {
    const tracker = new ShellInputTracker();
    await write('$ old');
    tracker.beforeInput('\x1b[D', terminal);
    const command = 'cat 🌍界/file';
    tracker.beforeReplacement(command, terminal);
    await write('\r\x1b[2K$ ' + command);
    assert.equal(tracker.readLine(terminal), command);
  } finally { terminal.dispose(); }
});

test('a quiet directory change relocates verified input when the prompt width changes', async () => {
  const Xterm = createRequire(`${process.cwd()}/package.json`)('@xterm/xterm').Terminal as typeof import('@xterm/xterm').Terminal;
  const terminal = new Xterm({ cols: 80, rows: 6 });
  const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
  try {
    const tracker = new ShellInputTracker();
    await write('workspace ❯ ');
    tracker.beforeInput('git st', terminal);
    await write('git st');
    assert.equal(tracker.readLine(terminal), 'git st');
    tracker.reanchor();
    await write('\r\x1b[2Ksrc ❯ git st');
    assert.equal(tracker.readLine(terminal), 'git st');
    tracker.beforeInput('atus', terminal);
    await write('atus');
    assert.equal(tracker.readLine(terminal), 'git status');
    tracker.beforeInput('\x1b[A', terminal);
    tracker.reanchor();
    assert.equal(tracker.readLine(terminal), null, 'Prompt changes must not guess unsupported native history edits');
  } finally { terminal.dispose(); }
});

test('real xterm treats literal spaces left by shell deletion as the editable line end', async () => {
  const Xterm = createRequire(`${process.cwd()}/package.json`)('@xterm/xterm').Terminal as typeof import('@xterm/xterm').Terminal;
  const terminal = new Xterm({ cols: 80, rows: 6 });
  const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
  try {
    const tracker = new ShellInputTracker();
    await write('$ ');
    tracker.beforeInput('pw', terminal);
    await write('pw');
    terminal.resize(38, 5);
    assert.equal(tracker.readLine(terminal), 'pw');

    tracker.beforeInput('\x15', terminal);
    // zsh clears the old input by overwriting it with spaces, then moving back.
    await write('\b\b  \b\b');
    const buffer = terminal.buffer.active;
    assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true, buffer.cursorX), '  ');
    assert.equal(tracker.readLine(terminal), '');
    assert.equal(tracker.isAtLineEnd(terminal), true);

    tracker.beforeInput('p', terminal);
    await write('p');
    assert.equal(tracker.readLine(terminal), 'p');
    assert.equal(tracker.isAtLineEnd(terminal), true);
    tracker.beforeInput('\x7f', terminal);
    await write('\b \b');
    assert.equal(tracker.readLine(terminal), '');
    assert.equal(tracker.isAtLineEnd(terminal), true);

    tracker.beforeInput('pw', terminal);
    await write('pw');
    tracker.beforeInput('\x1b[D', terminal);
    await write('\x1b[D');
    assert.equal(tracker.readLine(terminal), null);
    assert.equal(tracker.isAtLineEnd(terminal), false);
  } finally { terminal.dispose(); }
});
