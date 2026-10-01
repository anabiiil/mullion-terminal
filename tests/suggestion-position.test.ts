import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestionPosition } from '../src/suggestion-position';

const normal = { width: 700, height: 500, cursorLeft: 80, cursorTop: 13, cursorBottom: 29, popupWidth: 430, popupHeight: 260 };

test('first prompt opens below the input and stays within the terminal', () => {
  const position = suggestionPosition(normal)!;
  assert.equal(position.placement, 'below');
  assert.ok(position.top > normal.cursorBottom);
  assert.ok(position.top + position.maxHeight <= normal.height - 8);
});

test('bottom prompt flips above and constrains the popup at the right edge', () => {
  const position = suggestionPosition({ ...normal, cursorLeft: 680, cursorTop: 460, cursorBottom: 476 })!;
  assert.equal(position.placement, 'above');
  assert.ok(position.top >= 8);
  assert.ok(position.top + position.maxHeight < 460);
  assert.ok(position.left + normal.popupWidth <= normal.width - 8);
});

test('short terminals limit the list to the available space instead of clipping it', () => {
  for (const cursorTop of [13, 90, 150]) {
    const geometry = { ...normal, height: 180, cursorTop, cursorBottom: cursorTop + 16 };
    const position = suggestionPosition(geometry)!;
    assert.ok(position.top >= 8);
    assert.ok(position.top + position.maxHeight <= geometry.height - 8);
    assert.ok(position.maxHeight < normal.popupHeight);
  }
});

test('a cursor scrolled outside the visible terminal does not produce a popup', () => {
  assert.equal(suggestionPosition({ ...normal, cursorTop: -20, cursorBottom: -4 }), null);
  assert.equal(suggestionPosition({ ...normal, cursorTop: 510, cursorBottom: 526 }), null);
});
