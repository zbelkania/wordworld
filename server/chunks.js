'use strict';

const { hashString, mixInts, makeRng } = require('./rng');
const dictionary = require('./dictionary');

const CHUNK_SIZE = 24; // cells per side
const WORDS_PER_CHUNK = 28; // raised by request; more planted words per chunk
const PLANT_ATTEMPTS = 500; // needs headroom to actually hit the higher target

// The world seed must stay secret. If a client knows it, it can regenerate
// every chunk locally and compute exactly where each planted word sits.
const WORLD_SEED = process.env.WORLD_SEED || 'change-me-before-you-launch';
const SEED_HASH = hashString(WORLD_SEED);

// Eight directions: E, SE, S, SW, W, NW, N, NE
const DIRECTIONS = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];

// Length weights: mid-length words are still favoured, since a chunk that's
// nothing but 4-letter words plants fast but reads as noise once you can see
// them. 4s are included but weighted lightly relative to the rest.
const LENGTH_WEIGHTS = [
  [4, 12], [5, 22], [6, 25], [7, 21], [8, 14], [9, 6],
];
const LENGTH_WEIGHT_TOTAL = LENGTH_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

// English-ish letter frequencies for filler. Using realistic frequencies means
// the filler itself throws up real words by accident, which is a nice bonus:
// the server validates against the full dictionary, so those count too.
const FILLER_WEIGHTS = [
  ['e', 111], ['a', 85], ['r', 76], ['i', 75], ['o', 72], ['t', 70], ['n', 67],
  ['s', 57], ['l', 55], ['c', 45], ['u', 36], ['d', 34], ['p', 32], ['m', 30],
  ['h', 30], ['g', 25], ['b', 21], ['f', 18], ['y', 18], ['w', 13], ['k', 11],
  ['v', 10], ['x', 3], ['z', 3], ['j', 2], ['q', 2],
];
const FILLER_TOTAL = FILLER_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

function pickWeighted(rng, table, total) {
  let roll = rng.next() * total;
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return table[table.length - 1][0];
}

// ---------------------------------------------------------------------------
// Coordinate helpers. These must handle negative coordinates correctly, since
// the world extends infinitely in all four directions.
// ---------------------------------------------------------------------------

function floorDiv(a, b) {
  return Math.floor(a / b);
}

function trueMod(a, b) {
  return ((a % b) + b) % b;
}

function chunkCoordsFor(worldX, worldY) {
  return {
    cx: floorDiv(worldX, CHUNK_SIZE),
    cy: floorDiv(worldY, CHUNK_SIZE),
    lx: trueMod(worldX, CHUNK_SIZE),
    ly: trueMod(worldY, CHUNK_SIZE),
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function generateChunk(cx, cy) {
  const rng = makeRng(mixInts(SEED_HASH, cx, cy));
  const grid = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(null);
  const planted = [];

  let attempts = 0;
  while (planted.length < WORDS_PER_CHUNK && attempts < PLANT_ATTEMPTS) {
    attempts++;

    const length = pickWeighted(rng, LENGTH_WEIGHTS, LENGTH_WEIGHT_TOTAL);
    const pool = dictionary.plantableWords(length);
    if (pool.length === 0) continue;

    const word = pool[rng.int(pool.length)];
    const [dx, dy] = DIRECTIONS[rng.int(DIRECTIONS.length)];

    // Choose a start cell such that the whole word stays inside this chunk.
    // Keeping words chunk-local means generation never needs to consult a
    // neighbour, so any chunk can be produced independently and in any order.
    const spanX = dx * (length - 1);
    const spanY = dy * (length - 1);
    const minX = Math.max(0, -spanX);
    const maxX = Math.min(CHUNK_SIZE - 1, CHUNK_SIZE - 1 - spanX);
    const minY = Math.max(0, -spanY);
    const maxY = Math.min(CHUNK_SIZE - 1, CHUNK_SIZE - 1 - spanY);
    if (minX > maxX || minY > maxY) continue;

    const startX = minX + rng.int(maxX - minX + 1);
    const startY = minY + rng.int(maxY - minY + 1);

    // Overlaps are allowed only where the existing letter already matches.
    let fits = true;
    for (let i = 0; i < length; i++) {
      const x = startX + dx * i;
      const y = startY + dy * i;
      const existing = grid[y * CHUNK_SIZE + x];
      if (existing !== null && existing !== word[i]) {
        fits = false;
        break;
      }
    }
    if (!fits) continue;

    const cells = [];
    for (let i = 0; i < length; i++) {
      const x = startX + dx * i;
      const y = startY + dy * i;
      grid[y * CHUNK_SIZE + x] = word[i];
      cells.push([x, y]);
    }
    planted.push({ word, cells });
  }

  // Fill everything still empty with weighted random letters.
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === null) grid[i] = pickWeighted(rng, FILLER_WEIGHTS, FILLER_TOTAL);
  }

  return {
    cx,
    cy,
    letters: grid.join(''), // row-major, CHUNK_SIZE * CHUNK_SIZE chars
    planted, // SERVER ONLY — never send this to a client
  };
}

// ---------------------------------------------------------------------------
// Cache. Generation is cheap but not free, and chunks are hit repeatedly by
// every player in the area, so keep a bounded LRU.
// ---------------------------------------------------------------------------

const CACHE_LIMIT = 4096;
const cache = new Map();

function getChunk(cx, cy) {
  const key = `${cx},${cy}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh recency
    cache.set(key, hit);
    return hit;
  }
  const chunk = generateChunk(cx, cy);
  cache.set(key, chunk);
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return chunk;
}

// Letter at any world coordinate. Used by claim validation, which needs to
// read arbitrary cells — including words that straddle a chunk boundary.
function letterAt(worldX, worldY) {
  const { cx, cy, lx, ly } = chunkCoordsFor(worldX, worldY);
  return getChunk(cx, cy).letters[ly * CHUNK_SIZE + lx];
}

function readWord(cells) {
  let out = '';
  for (const [x, y] of cells) out += letterAt(x, y);
  return out;
}

// A hint reveals one unclaimed planted word's location without naming it.
// This is what a rewarded ad pays out (see server/index.js).
function findHint(cx, cy, isClaimed) {
  const chunk = getChunk(cx, cy);
  for (const entry of chunk.planted) {
    const worldCells = entry.cells.map(([x, y]) => [
      cx * CHUNK_SIZE + x,
      cy * CHUNK_SIZE + y,
    ]);
    if (isClaimed(worldCells)) continue;
    return {
      length: entry.word.length,
      start: worldCells[0],
      direction: [
        worldCells[1][0] - worldCells[0][0],
        worldCells[1][1] - worldCells[0][1],
      ],
    };
  }
  return null;
}

module.exports = {
  CHUNK_SIZE,
  DIRECTIONS,
  chunkCoordsFor,
  getChunk,
  letterAt,
  readWord,
  findHint,
  floorDiv,
  trueMod,
};
