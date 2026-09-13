'use strict';

// Regression test for: two words sharing letters (e.g. a prefix/suffix
// overlap) used to lose the first claim on any shared cell, because
// claimsByCell stored one record per cell instead of a list.

const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'game.js'),
  'utf8'
);

function extractFn(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  pass  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

const sandboxState = {
  claims: new Map(),
  claimsByCell: new Map(),
  needsDraw: false,
};

const sandbox = {};
new Function(
  'exports',
  'state',
  `
  const floorDiv = (a, b) => Math.floor(a / b);
  const trueMod = (a, b) => ((a % b) + b) % b;
  state.chunkSize = 24;
  ${extractFn('chunkKeyFor')}
  ${extractFn('claimKey')}
  ${extractFn('ingestClaim')}
  exports.ingestClaim = ingestClaim;
  `
)(sandbox, sandboxState);

console.log('\noverlapping words on shared cells');

// "CARS" at (0,0)-(3,0), and "CAR" at (0,0)-(2,0): a prefix overlap sharing
// three cells.
sandbox.ingestClaim(
  { word: 'car', cells: [[0, 0], [1, 0], [2, 0]], by: 'alice', color: '#111', score: 5 },
  false
);
sandbox.ingestClaim(
  { word: 'cars', cells: [[0, 0], [1, 0], [2, 0], [3, 0]], by: 'bob', color: '#222', score: 8 },
  false
);

const sharedCell = sandboxState.claimsByCell.get('0,0');
check('a shared cell keeps a list, not a single record',
  Array.isArray(sharedCell), typeof sharedCell);
check('the shared cell remembers both claims',
  sharedCell && sharedCell.length === 2,
  `got ${sharedCell ? sharedCell.length : 'undefined'}`);

const words = (sharedCell || []).map((c) => c.word).sort();
check('both words are present at the shared cell',
  JSON.stringify(words) === JSON.stringify(['car', 'cars']),
  JSON.stringify(words));

const finders = (sharedCell || []).map((c) => c.by).sort();
check('both finders are attributed correctly',
  JSON.stringify(finders) === JSON.stringify(['alice', 'bob']),
  JSON.stringify(finders));

// The cell unique to "cars" (x=3) should show only bob's claim.
const uniqueCell = sandboxState.claimsByCell.get('3,0');
check('a non-overlapping cell has exactly one claim',
  uniqueCell && uniqueCell.length === 1 && uniqueCell[0].word === 'cars',
  JSON.stringify(uniqueCell));

// A third, unrelated word claimed elsewhere must not appear at (0,0).
sandbox.ingestClaim(
  { word: 'dog', cells: [[9, 9], [10, 9], [11, 9]], by: 'carol', color: '#333', score: 4 },
  false
);
const stillSharedCell = sandboxState.claimsByCell.get('0,0');
check('an unrelated claim elsewhere does not leak into the shared cell',
  stillSharedCell.length === 2);

// Claiming the exact same cells twice (shouldn't happen given server-side
// dedup, but the client-side dedup by claimKey should still hold) must not
// double-list the same claim at a cell.
sandbox.ingestClaim(
  { word: 'car', cells: [[0, 0], [1, 0], [2, 0]], by: 'alice', color: '#111', score: 5 },
  false
);
const afterDupe = sandboxState.claimsByCell.get('0,0');
check('re-ingesting the identical claim does not duplicate it',
  afterDupe.length === 2, `got ${afterDupe.length}`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
