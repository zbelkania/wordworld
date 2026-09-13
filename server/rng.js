'use strict';

// Deterministic hashing + PRNG. Same inputs always produce the same chunk,
// which is what lets us have an "infinite" world without storing any of it.

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Mix an arbitrary number of 32-bit integers into one.
function mixInts(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    const x = n | 0;
    for (let b = 0; b < 4; b++) {
      h ^= (x >>> (b * 8)) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  // Final avalanche so neighbouring chunk coords look unrelated.
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// mulberry32: small, fast, good enough for content generation.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convenience wrapper with integer + pick helpers.
function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive);
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
  };
}

module.exports = { hashString, mixInts, mulberry32, makeRng };
