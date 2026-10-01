'use strict';

function validCommand(value) {
  return typeof value === 'string' && value.length <= 8192 && !/[\0\r\n\x1b]/.test(value) && value.trim() ? value.trim() : null;
}

// Shell hooks get first choice, so expansion and native history edits remain
// authoritative. Known renderer input is a fallback for shell history filters.
class SubmissionTracker {
  constructor(record) {
    this.record = record;
    this.pending = null;
    this.recorded = false;
  }

  submit(command) {
    this.pending = validCommand(command);
    this.recorded = false;
  }

  hook(command) {
    command = validCommand(command);
    if (!command || this.recorded) return;
    this.recorded = true;
    this.record(command);
  }

  finish() {
    if (this.recorded || !this.pending) return;
    this.recorded = true;
    this.record(this.pending);
    // Keep deduplication active until the next submitted shell line.
  }
}

module.exports = { SubmissionTracker, validCommand };
