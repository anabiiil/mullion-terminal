'use strict';

const { isInjectedCommand } = require('./completions.cjs');

function validCommand(value) {
  return typeof value === 'string' && value.length <= 8192 && !/[\0\r\n\x1b]/.test(value) && value.trim() ? value.trim() : null;
}

// Shell hooks get first choice, so expansion and native history edits remain
// authoritative. Known renderer input is a fallback for shell history filters.
// Recording itself is deferred to finish() (the next prompt, or session end):
// that is the earliest point a POSIX shell's exit status for the command is
// known, and it is also where a caller's `record: false` request is honored,
// regardless of whether the shell hook or the renderer fallback supplied the text.
class SubmissionTracker {
  constructor(record) {
    this.record = record;
    this.pending = null;
    this.pendingRecord = true;
    this.hooked = null;
    this.resolved = false;
  }

  // `options.record === false` marks a command the app is running on the user's
  // behalf (e.g. a tree double-click opening nano): it must never be learned,
  // no matter what the shell hook later reports for the same input line.
  submit(command, { record = true } = {}) {
    this.pending = validCommand(command);
    this.pendingRecord = record;
    this.hooked = null;
    this.resolved = false;
  }

  hook(command) {
    command = validCommand(command);
    if (!command || this.resolved) return;
    this.hooked = command;
  }

  // `status` is the POSIX exit code of the command that just finished, when the
  // shell integration could report one. 127 is the shell's own "command not
  // found" — never worth learning.
  finish(status) {
    if (this.resolved) return;
    const command = this.hooked ?? this.pending;
    const record = this.pendingRecord;
    this.resolved = true;
    if (!command || !record) return;
    // A shell hook can report an app-injected command (e.g. sidebar navigation's
    // `builtin cd -- …`) just like any other executed line. It must never be learned.
    if (isInjectedCommand(command)) return;
    if (status === 127) return;
    this.record(command);
  }
}

module.exports = { SubmissionTracker, validCommand };
