'use strict';

const allEnglishWords = require('an-array-of-english-words');
const wordlistEnglish = require('wordlist-english');

// Lowered to 4 by request. Worth knowing: at this threshold, a large majority
// of findable words in any chunk are incidental (four random letters lining
// up), not planted — see README "Balance" for the measured density at 4 vs 5
// vs 6, if this ever needs retuning.
const MIN_WORD_LEN = 4;
const MAX_WORD_LEN = 12;

// Planted words stay short enough to fit comfortably inside a chunk.
const PLANT_MIN_LEN = 4; // must be >= MIN_WORD_LEN or planted words are unclaimable
const PLANT_MAX_LEN = 9;

// ---------------------------------------------------------------------------
// Validation set: the full dictionary. Anything a player finds is checked
// against this, including words that appear by accident in the filler letters.
// ---------------------------------------------------------------------------

const validWords = new Set();
for (const word of allEnglishWords) {
  if (word.length < MIN_WORD_LEN || word.length > MAX_WORD_LEN) continue;
  if (!/^[a-z]+$/.test(word)) continue;
  validWords.add(word);
}

// ---------------------------------------------------------------------------
// Planting pool: only *recognisable* words. wordlist-english is tiered by how
// common each word is, so tiers 10/20/35 give us words players will actually
// spot, rather than obscurities like "albugineous".
// ---------------------------------------------------------------------------

const commonTiers = [
  ...wordlistEnglish['english/10'],
  ...wordlistEnglish['english/20'],
  ...wordlistEnglish['english/35'],
];

const plantPoolByLength = new Map();
for (let len = PLANT_MIN_LEN; len <= PLANT_MAX_LEN; len++) {
  plantPoolByLength.set(len, []);
}

const seenPlantable = new Set();
for (const raw of commonTiers) {
  const word = raw.toLowerCase();
  if (seenPlantable.has(word)) continue;
  if (!/^[a-z]+$/.test(word)) continue;
  if (word.length < PLANT_MIN_LEN || word.length > PLANT_MAX_LEN) continue;
  // Must be claimable, so it has to exist in the validation set too.
  if (!validWords.has(word)) continue;
  seenPlantable.add(word);
  plantPoolByLength.get(word.length).push(word);
}

// Sort each bucket so the pool order is stable across process restarts.
// Chunk generation indexes into these arrays, so a different order would
// change world content — which would break already-claimed words.
for (const bucket of plantPoolByLength.values()) bucket.sort();

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const LETTER_VALUES = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3,
  n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10,
};

const LENGTH_BONUS_PER_LETTER = 0.15;
const LENGTH_BONUS_BASELINE = 4; // a 4-letter word gets a 1.0x multiplier, no bonus or penalty

function scoreWord(word) {
  let base = 0;
  for (const ch of word) base += LETTER_VALUES[ch] || 0;
  const multiplier = 1 + LENGTH_BONUS_PER_LETTER * (word.length - LENGTH_BONUS_BASELINE);
  return Math.round(base * multiplier);
}

function isValidWord(word) {
  return validWords.has(word);
}

function plantableWords(length) {
  return plantPoolByLength.get(length) || [];
}

function stats() {
  const plantable = {};
  for (const [len, bucket] of plantPoolByLength) plantable[len] = bucket.length;
  return { validWords: validWords.size, plantable };
}

module.exports = {
  MIN_WORD_LEN,
  MAX_WORD_LEN,
  PLANT_MIN_LEN,
  PLANT_MAX_LEN,
  LETTER_VALUES,
  isValidWord,
  scoreWord,
  plantableWords,
  stats,
};
