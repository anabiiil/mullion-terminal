import type { IBufferLine, IMarker, Terminal } from '@xterm/xterm';

interface Anchor { column: number; row: number; cols: number; marker?: IMarker }

/**
 * Tracks an echoed shell input line; it never scrapes a prompt from program output.
 * Call beforeInput BEFORE writing data to the PTY, then readLine from
 * onWriteParsed. Only use it while the backend says the shell is at its prompt,
 * and reset it whenever that prompt state ends. Hidden password input therefore
 * has no verified echo and cannot produce suggestions.
 *
 * Unhandled editing/history/native completion disables tracking until a fresh
 * input line (Enter, Ctrl+C, Ctrl+U, or explicit reset). The revision increments
 * on every input/reset so consumers can discard stale async completions.
 */
export class ShellInputTracker {
  private anchor: Anchor | null = null;
  private expected = '';
  private blocked = false;
  private version = 0;
  private awaitingReplacementEcho = false;

  get revision(): number { return this.version; }

  /** A shell widget can redraw the prompt while retaining the editable input. */
  reanchor(): void {
    if (this.blocked || (!this.anchor && !this.awaitingReplacementEcho)) return;
    this.anchor?.marker?.dispose();
    this.anchor = null;
    this.awaitingReplacementEcho = true;
    this.version++;
  }

  reset(): void {
    this.anchor?.marker?.dispose();
    this.anchor = null;
    this.expected = '';
    this.blocked = false;
    this.awaitingReplacementEcho = false;
    this.version++;
  }

  /**
   * Call before writing Ctrl+E, Ctrl+U, and a complete replacement to the PTY.
   * The old cursor may be anywhere (native shell history/editing is supported).
   * Only an exact echoed replacement establishes the new command start.
   */
  beforeReplacement(command: string, terminal: Terminal): void {
    this.reset();
    if (terminal.buffer.active.type !== 'normal' || /[\x00-\x1f\x7f-\x9f]/.test(command)) {
      this.blocked = true;
      return;
    }
    this.expected = command;
    this.awaitingReplacementEcho = true;
  }

  private invalidate(): void {
    this.reset();
    this.blocked = true;
  }

  beforeInput(data: string, terminal: Terminal): void {
    this.version++;
    if (terminal.buffer.active.type !== 'normal') { this.invalidate(); return; }
    if (data === '\x15' && this.anchor && !this.blocked && this.isAtLineEnd(terminal)) {
      // Keep the verified start coordinate when clearing an editable line.
      // The following printable input may arrive before Ctrl+U is echoed.
      this.expected = '';
      return;
    }
    if (data === '\r' || data === '\n' || data === '\x03' || data === '\x15') {
      this.reset();
      return;
    }
    if (this.blocked) return;
    if (data === '\x7f' || data === '\b') {
      if (!this.anchor && !this.awaitingReplacementEcho) { this.invalidate(); return; }
      this.expected = [...this.expected].slice(0, -1).join('');
      return;
    }

    // xterm may send bracketed paste as one onData event. Single-line paste is
    // safe to track; multiline paste can run commands before a new prompt.
    const printable = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
    if (!printable || /[\x00-\x1f\x7f-\x9f]/.test(printable)) {
      this.invalidate();
      return;
    }
    if (!this.anchor && !this.awaitingReplacementEcho) {
      const buffer = terminal.buffer.active;
      this.anchor = {
        column: buffer.cursorX,
        row: buffer.baseY + buffer.cursorY,
        cols: terminal.cols,
        marker: terminal.registerMarker(0),
      };
    }
    this.expected += printable;
  }

  /** Null means unverified echo, unsupported editing, or a non-shell buffer. */
  readLine(terminal: Terminal): string | null {
    const buffer = terminal.buffer.active;
    if (this.blocked || buffer.type !== 'normal') return null;
    if (this.anchor && (this.anchor.cols !== terminal.cols || this.anchor.marker?.isDisposed)) {
      // Resize/reflow and clear-scrollback preserve the command's text but may
      // move its start. Re-establish it from exact echo instead of tracking a
      // newly typed suffix as if it were the whole command.
      this.anchor.marker?.dispose();
      this.anchor = null;
      this.awaitingReplacementEcho = true;
      this.version++;
    }
    if (!this.anchor && this.awaitingReplacementEcho) this.findReplacementAnchor(terminal);
    const anchor = this.anchor;
    if (!anchor) return null;
    const row = anchor.marker?.line ?? anchor.row;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (cursorRow < row || (cursorRow === row && buffer.cursorX < anchor.column)
      || cursorRow - row > 64) return null;
    let value = '';
    for (let index = row; index <= cursorRow; index++) {
      const line = buffer.getLine(index);
      // A continuation prompt is a new logical shell line, not a terminal wrap.
      if (!line || (index > row && !line.isWrapped)) return null;
      value += line.translateToString(false, index === row ? anchor.column : 0,
        index === cursorRow ? buffer.cursorX : this.wrappedRowEnd(terminal, line));
    }
    // Returning predicted input here would suggest over passwords and would let
    // a delayed echo keep an obsolete completion list alive.
    return value === this.expected ? value : null;
  }

  private findReplacementAnchor(terminal: Terminal): void {
    if (!this.expected) return;
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    let suffix = '';
    for (let row = cursorRow; row >= 0 && cursorRow - row <= 64; row--) {
      const line = buffer.getLine(row);
      if (!line || (row < cursorRow && !buffer.getLine(row + 1)?.isWrapped)) return;
      const end = row === cursorRow ? buffer.cursorX : this.wrappedRowEnd(terminal, line);
      // Iterate display columns, not JS string offsets: wide glyphs and emoji
      // consume a different number of cells than their string length.
      for (let column = 0; column <= end; column++) {
        if (line.translateToString(false, column, end) + suffix !== this.expected) continue;
        this.anchor = {
          column, row, cols: terminal.cols,
          marker: terminal.registerMarker(row - cursorRow),
        };
        this.awaitingReplacementEcho = false;
        return;
      }
      suffix = line.translateToString(false, 0, end) + suffix;
      if (suffix.length > this.expected.length) return;
    }
  }

  private wrappedRowEnd(terminal: Terminal, line: IBufferLine): number {
    let end = terminal.cols;
    if (!line.getCell) return end;
    // A resize may pad an existing wrapped row instead of reflowing the active
    // input line. A wide glyph can also leave an unused final cell when it wraps.
    // Strip empty padding cells, retaining explicit spaces and wide-cell tails.
    while (end > 0) {
      const cell = line.getCell(end - 1);
      if (!cell || cell.getChars() || cell.getWidth() === 0) break;
      end--;
    }
    return end;
  }

  isAtLineEnd(terminal: Terminal): boolean {
    const buffer = terminal.buffer.active;
    if (buffer.type !== 'normal') return false;
    const row = buffer.baseY + buffer.cursorY;
    const line = buffer.getLine(row);
    // Shell redraws often erase deleted characters by writing literal spaces;
    // xterm's trimRight removes empty cells, but preserves those written spaces.
    if (!line || line.translateToString(true, buffer.cursorX).trimEnd().length) return false;
    return !buffer.getLine(row + 1)?.isWrapped;
  }
}
