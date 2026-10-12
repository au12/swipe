// How the hand is laid out: one row up to fourteen cards, whatever the width.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ONE_ROW, handFit } from '../public/js/view.js';

const SCREENS = [
  [44, 280], // a small phone
  [59, 352],
  [65, 392],
  [63, 614], // desktop, cards scaled down to a short window
  [94, 614],
  [94, 820],
];

test('a hand of fourteen or fewer is always one row', () => {
  assert.equal(ONE_ROW, 14);
  for (const [cw, width] of SCREENS) {
    for (let n = 1; n <= ONE_ROW; n++) {
      for (const opts of [{}, { comfy: 0.3, tight: 0.2, maxRows: 2 }]) {
        const fit = handFit(n, width, cw, opts);
        assert.equal(fit.rows, 1, `${n} cards of ${cw}px in ${width}px`);
        assert.equal(fit.per, n);
        // The row it plans is no wider than the box it was given.
        assert.ok(cw + (fit.per - 1) * fit.step <= width + 0.001, `${n} cards of ${cw}px overflow ${width}px`);
      }
    }
  }
});

test('cards that have room stand apart by a small gap, and no further', () => {
  const fit = handFit(8, 820, 94);
  assert.equal(fit.rows, 1);
  assert.equal(fit.step, 100);
  // Just short of room for the full gap: still one row, with a smaller gap.
  const snug = handFit(8, 780, 94);
  assert.equal(snug.rows, 1);
  assert.ok(snug.step > 94 && snug.step < 100);
  assert.ok(94 + 7 * snug.step <= 780);
});

test('past fourteen a hand may take a second row, and every row still fits', () => {
  for (const [cw, width] of SCREENS) {
    for (const n of [15, 18, 24, 30, 52]) {
      const fit = handFit(n, width, cw);
      assert.ok(fit.rows >= 1 && fit.per * fit.rows >= n);
      assert.ok(cw + (fit.per - 1) * fit.step <= width + 0.001 || fit.step === 8, `${n} cards of ${cw}px in ${width}px`);
    }
  }
  assert.equal(handFit(15, 352, 59).rows, 2); // a phone
});
