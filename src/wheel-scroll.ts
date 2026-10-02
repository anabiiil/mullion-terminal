// Mouse-wheel scrolling for full-screen programs that can't make sense of a
// wheel event themselves: nano/pico always turn on xterm mouse tracking (see
// electron/shell.cjs's editorWrappers), so a wheel notch arrives as a mouse
// button 4/5 report — which UW pico (macOS's nano) simply ignores. Vim with
// no `:set mouse=a` in the user's own vimrc has no mouse tracking at all, so
// a wheel event there currently does nothing either way. In both cases we
// translate the wheel into the arrow-key presses the program already knows
// how to handle, instead of letting xterm.js report (or drop) the raw event.

/** How many lines one notch of a clicky (line-mode) wheel moves. */
export const WHEEL_LINES_PER_NOTCH = 3;
/** How many lines one page-mode wheel "click" moves. */
export const WHEEL_LINES_PER_PAGE = 24;
/** Upper bound on lines sent for a single wheel event, so a fast fling (or a
 *  flood of trackpad events) can't dump hundreds of arrow keys on the pty at
 *  once; any extra distance is carried over to the next event instead. */
export const WHEEL_MAX_LINES_PER_EVENT = 15;

export interface WheelDeltaInput {
  /** WheelEvent.deltaY. */
  deltaY: number;
  /** WheelEvent.deltaMode: 0 = pixel, 1 = line, 2 = page. */
  deltaMode: number;
  /** Pixel height of one terminal row, used only for pixel-mode deltas (trackpads). */
  cellHeight: number;
}

export interface WheelLinesResult {
  /** Whole lines to move this event (positive = down, negative = up), capped. */
  lines: number;
  /** Fractional/overflow remainder to carry into the next call's `accumulated`. */
  accumulated: number;
}

/**
 * Converts a wheel event's deltaY into a whole number of lines to scroll,
 * carrying any leftover fraction (and anything beyond the per-event cap) in
 * `accumulated` so a run of small trackpad events still adds up smoothly
 * instead of being individually rounded away.
 */
export function accumulateWheelLines(accumulated: number, input: WheelDeltaInput): WheelLinesResult {
  const deltaLines = input.deltaMode === 1 ? input.deltaY * WHEEL_LINES_PER_NOTCH
    : input.deltaMode === 2 ? input.deltaY * WHEEL_LINES_PER_PAGE
    : input.deltaY / Math.max(1, input.cellHeight);
  const total = accumulated + deltaLines;
  const whole = Math.trunc(total);
  const lines = Math.max(-WHEEL_MAX_LINES_PER_EVENT, Math.min(WHEEL_MAX_LINES_PER_EVENT, whole));
  return { lines, accumulated: total - lines };
}

/** Arrow-key escape sequence for one line, honoring Application Cursor Keys (DECCKM). */
function arrowKey(down: boolean, applicationCursorKeys: boolean): string {
  return applicationCursorKeys ? (down ? '\x1bOB' : '\x1bOA') : (down ? '\x1b[B' : '\x1b[A');
}

/** The key sequence to send for `lines` lines of movement (empty string if none). */
export function arrowKeysForLines(lines: number, applicationCursorKeys: boolean): string {
  if (lines === 0) return '';
  return arrowKey(lines > 0, applicationCursorKeys).repeat(Math.abs(lines));
}
