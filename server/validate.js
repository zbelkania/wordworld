'use strict';

const dictionary = require('./dictionary');
const chunks = require('./chunks');
const db = require('./db');

// Nothing a client sends is trusted. Every claim is re-derived from the world
// seed and re-scored here. The client's own score display is cosmetic; this
// module produces the number that actually gets stored.

const MAX_WORLD_COORD = 1e9; // keeps coordinates in exact-integer float range

// ---------------------------------------------------------------------------
// Rate limiting. Humans do not submit dozens of words per second; solver bots
// do. This is a token bucket per user, held in memory.
// ---------------------------------------------------------------------------

const RATE_CAPACITY = 10; // burst allowance
const RATE_REFILL_PER_SEC = 0.9; // sustained claims per second
const buckets = new Map();

function consumeToken(userId) {
  const now = Date.now();
  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = { tokens: RATE_CAPACITY, last: now };
    buckets.set(userId, bucket);
  }
  const elapsedSec = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(
    RATE_CAPACITY,
    bucket.tokens + elapsedSec * RATE_REFILL_PER_SEC
  );
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Drop idle buckets so memory doesn't grow with total user count.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [userId, bucket] of buckets) {
    if (bucket.last < cutoff) buckets.delete(userId);
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function checkGeometry(cells) {
  if (!Array.isArray(cells)) return 'Malformed selection.';
  if (cells.length < dictionary.MIN_WORD_LEN) {
    return `Words must be at least ${dictionary.MIN_WORD_LEN} letters.`;
  }
  if (cells.length > dictionary.MAX_WORD_LEN) {
    return `Words can be at most ${dictionary.MAX_WORD_LEN} letters.`;
  }

  for (const cell of cells) {
    if (!Array.isArray(cell) || cell.length !== 2) return 'Malformed selection.';
    const [x, y] = cell;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return 'Malformed selection.';
    if (Math.abs(x) > MAX_WORLD_COORD || Math.abs(y) > MAX_WORLD_COORD) {
      return 'Selection is outside the world.';
    }
  }

  // Must be a straight run in one of the eight directions, one cell per step.
  const [x0, y0] = cells[0];
  const [x1, y1] = cells[1];
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) {
    return 'Letters must be adjacent.';
  }
  for (let i = 1; i < cells.length; i++) {
    if (cells[i][0] !== x0 + dx * i || cells[i][1] !== y0 + dy * i) {
      return 'Letters must form a straight line.';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diminishing returns. Without this, the optimal strategy is to hunt the same
// handful of easy planted words across thousands of chunks forever.
// ---------------------------------------------------------------------------

const REPEAT_DECAY = 0.08;
const REPEAT_FLOOR = 0.25;

function repeatMultiplier(claimCount) {
  return Math.max(REPEAT_FLOOR, 1 / (1 + REPEAT_DECAY * claimCount));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function validateClaim(user, cells) {
  const geometryError = checkGeometry(cells);
  if (geometryError) return { ok: false, error: geometryError };

  if (!consumeToken(user.id)) {
    db.bumpSuspicion(user.id, 1);
    return { ok: false, error: 'Slow down a moment.', rateLimited: true };
  }

  // Re-read the letters from the generated world rather than trusting the
  // client's idea of what the word was.
  const forward = chunks.readWord(cells);
  if (!/^[a-z]+$/.test(forward)) return { ok: false, error: 'Malformed selection.' };

  // Players drag in whichever direction is comfortable, so a run counts if it
  // reads as a word either way. The stored cell key is direction-agnostic, so
  // a run whose reverse is also a word (straw / warts) is one claim, not two.
  const backward = forward.split('').reverse().join('');
  let word = null;
  if (dictionary.isValidWord(forward)) word = forward;
  else if (dictionary.isValidWord(backward)) word = backward;

  if (!word) {
    return { ok: false, error: `"${forward.toUpperCase()}" is not in the dictionary.` };
  }

  if (db.isClaimed(cells)) {
    return { ok: false, error: 'Someone already claimed that one.' };
  }

  const base = dictionary.scoreWord(word);
  const multiplier = repeatMultiplier(db.wordClaimCount(word));
  const score = Math.max(1, Math.round(base * multiplier));

  // The chunk of the first cell owns the claim for storage and broadcast.
  const { cx, cy } = chunks.chunkCoordsFor(cells[0][0], cells[0][1]);

  const stored = db.recordClaim(cx, cy, word, cells, user.id, score);
  if (!stored) {
    return { ok: false, error: 'Someone already claimed that one.' };
  }

  // Chunks the word touches, so we broadcast to everyone who can see it.
  const touched = new Set();
  for (const [x, y] of cells) {
    const c = chunks.chunkCoordsFor(x, y);
    touched.add(`${c.cx},${c.cy}`);
  }

  return {
    ok: true,
    word,
    score,
    base,
    multiplier,
    cx,
    cy,
    cells,
    touchedChunks: [...touched],
  };
}

module.exports = { validateClaim, checkGeometry, repeatMultiplier };
