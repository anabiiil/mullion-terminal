import test from 'node:test';
import assert from 'node:assert/strict';
import { accumulateWheelLines, arrowKeysForLines, WHEEL_MAX_LINES_PER_EVENT } from '../src/wheel-scroll';

test('a single line-mode notch moves three lines with nothing left over', () => {
  const result = accumulateWheelLines(0, { deltaY: 1, deltaMode: 1, cellHeight: 17 });
  assert.equal(result.lines, 3);
  assert.equal(result.accumulated, 0);
});

test('an upward notch moves a negative line count', () => {
  const result = accumulateWheelLines(0, { deltaY: -1, deltaMode: 1, cellHeight: 17 });
  assert.equal(result.lines, -3);
});

test('a page-mode click moves a full page, capped like any other large delta', () => {
  const result = accumulateWheelLines(0, { deltaY: 1, deltaMode: 2, cellHeight: 17 });
  assert.equal(result.lines, WHEEL_MAX_LINES_PER_EVENT);
  assert.ok(result.accumulated > 0, 'the rest of the page carries into the next event');
});

test('small pixel deltas (trackpad) accumulate instead of rounding away to zero', () => {
  let accumulated = 0;
  let lines = 0;
  // Five 5px ticks over a 17px cell shouldn't move anything until they add up.
  for (let i = 0; i < 3; i++) ({ lines, accumulated } = accumulateWheelLines(accumulated, { deltaY: 5, deltaMode: 0, cellHeight: 17 }));
  assert.equal(lines, 0);
  assert.ok(accumulated > 0);
  ({ lines, accumulated } = accumulateWheelLines(accumulated, { deltaY: 5, deltaMode: 0, cellHeight: 17 }));
  assert.equal(lines, 1);
});

test('a fast fling is capped per event and the remainder carries to the next one', () => {
  const first = accumulateWheelLines(0, { deltaY: 1, deltaMode: 1, cellHeight: 17, });
  // deltaY of 100 notches is an extreme fling; the per-event cap still holds.
  const flung = accumulateWheelLines(0, { deltaY: 100, deltaMode: 1, cellHeight: 17 });
  assert.equal(flung.lines, WHEEL_MAX_LINES_PER_EVENT);
  assert.ok(flung.accumulated > 0, 'overflow beyond the cap is carried forward, not dropped');
  const next = accumulateWheelLines(flung.accumulated, { deltaY: 0, deltaMode: 1, cellHeight: 17 });
  assert.equal(next.lines, WHEEL_MAX_LINES_PER_EVENT);
  assert.ok(first.lines > 0);
});

test('negative flings are capped symmetrically', () => {
  const flung = accumulateWheelLines(0, { deltaY: -100, deltaMode: 1, cellHeight: 17 });
  assert.equal(flung.lines, -WHEEL_MAX_LINES_PER_EVENT);
  assert.ok(flung.accumulated < 0);
});

test('arrowKeysForLines sends plain cursor sequences by default', () => {
  assert.equal(arrowKeysForLines(2, false), '\x1b[B\x1b[B');
  assert.equal(arrowKeysForLines(-1, false), '\x1b[A');
  assert.equal(arrowKeysForLines(0, false), '');
});

test('arrowKeysForLines uses Application Cursor Keys sequences when active', () => {
  assert.equal(arrowKeysForLines(2, true), '\x1bOB\x1bOB');
  assert.equal(arrowKeysForLines(-3, true), '\x1bOA\x1bOA\x1bOA');
});
