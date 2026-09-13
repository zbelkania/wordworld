'use strict';

// Pulls the real functions out of public/game.js and checks them against the
// server's world generation. A mismatch here means a player drags across a
// word and the server rejects it, which would be maddening to debug in a
// browser, so it is worth testing directly.

const fs = require('node:fs');
const path = require('node:path');
const chunks = require('../server/chunks');
const dictionary = require('../server/dictionary');
const { checkGeometry } = require('../server/validate');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'game.js'),
  'utf8'
);

function extract(name) {
  // Grab `function name(...) { ... }` by brace matching.
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name} in game.js`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

// Pull constants from the real source too, so the test can't drift from the
// shipped values.
function extractConst(name) {
  const match = source.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`could not find const ${name} in game.js`);
  return match[1].trim();
}

const MAX_SELECT_SRC = extractConst('MAX_SELECT');

const sandbox = {};
// eslint-disable-next-line no-new-func
new Function(
  'exports',
  `
  const MAX_SELECT = ${MAX_SELECT_SRC};
  exports.MAX_SELECT = MAX_SELECT;
  ${extract('snapSelection')}
  const floorDiv = (a, b) => Math.floor(a / b);
  const trueMod = (a, b) => ((a % b) + b) % b;
  ${extract('claimKey')}
  exports.snapSelection = snapSelection;
  exports.claimKey = claimKey;
  exports.floorDiv = floorDiv;
  exports.trueMod = trueMod;
`
)(sandbox);

const { snapSelection, claimKey } = sandbox;

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

const N = chunks.CHUNK_SIZE;

console.log('\nselection snapping in all eight directions');
// Build a synthetic case per direction and confirm the snap reproduces it.
for (const [dx, dy] of chunks.DIRECTIONS) {
  const len = 6;
  const start = [10, 10];
  const end = [start[0] + dx * (len - 1), start[1] + dy * (len - 1)];
  const cells = snapSelection(start[0], start[1], end[0], end[1]);
  const expected = [];
  for (let i = 0; i < len; i++) expected.push([start[0] + dx * i, start[1] + dy * i]);
  check(
    `direction (${dx},${dy}) reproduces the exact run`,
    JSON.stringify(cells) === JSON.stringify(expected),
    `got ${JSON.stringify(cells)}`
  );
}

console.log('\nsnapping tolerates imprecise drags');
// A drag that ends slightly off the true line should still snap to it.
const offAxis = snapSelection(0, 0, 6, 1); // nearly horizontal
check('a nearly-horizontal drag snaps to horizontal',
  offAxis.every(([, y]) => y === 0) && offAxis.length === 7,
  JSON.stringify(offAxis));

const offDiag = snapSelection(0, 0, 5, 4); // nearly diagonal
check('a nearly-diagonal drag snaps to the diagonal',
  offDiag.every(([x, y], i) => x === i && y === i) && offDiag.length === 6,
  JSON.stringify(offDiag));

const vertical = snapSelection(3, 3, 4, 9);
check('a nearly-vertical drag snaps to vertical',
  vertical.every(([x]) => x === 3) && vertical.length === 7,
  JSON.stringify(vertical));

console.log('\nselection limits');
check('a single tap yields one cell', snapSelection(2, 2, 2, 2).length === 1);
check('selection is capped at the max word length',
  snapSelection(0, 0, 500, 0).length === dictionary.MAX_WORD_LEN,
  `got ${snapSelection(0, 0, 500, 0).length}`);

console.log('\nnegative coordinates');
check('snapping works across the origin',
  JSON.stringify(snapSelection(-2, -2, -6, -6)) ===
    JSON.stringify([[-2, -2], [-3, -3], [-4, -4], [-5, -5], [-6, -6]]));
check('client floorDiv matches server floorDiv',
  sandbox.floorDiv(-1, 24) === chunks.floorDiv(-1, 24) &&
  sandbox.floorDiv(-25, 24) === chunks.floorDiv(-25, 24));
check('client trueMod matches server trueMod',
  sandbox.trueMod(-1, 24) === chunks.trueMod(-1, 24) &&
  sandbox.trueMod(-25, 24) === chunks.trueMod(-25, 24));

console.log('\nclaim key canonicalisation');
const forward = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]];
const backward = forward.slice().reverse();
check('a run and its reverse share one key',
  claimKey(forward) === claimKey(backward));
check('client claim key matches the server key',
  claimKey(forward) === require('../server/db').cellsKey(forward));

console.log('\ndragging real planted words end to end');
// The important one: for every planted word in a sample of chunks, simulate
// a player dragging from its first letter to its last, then run the result
// through the server's own geometry check and word lookup.
let tested = 0;
let mismatches = 0;
let rejected = 0;
for (let cx = 700; cx < 740; cx++) {
  const chunk = chunks.getChunk(cx, 700);
  for (const entry of chunk.planted) {
    const worldCells = entry.cells.map(([x, y]) => [cx * N + x, 700 * N + y]);
    const first = worldCells[0];
    const last = worldCells[worldCells.length - 1];

    const dragged = snapSelection(first[0], first[1], last[0], last[1]);
    tested++;

    if (JSON.stringify(dragged) !== JSON.stringify(worldCells)) {
      mismatches++;
      if (mismatches < 4) {
        console.log(`        drag mismatch for "${entry.word}"`);
      }
      continue;
    }
    if (checkGeometry(dragged) !== null) {
      rejected++;
      continue;
    }
    if (chunks.readWord(dragged) !== entry.word) {
      rejected++;
    }
  }
}
check(`all ${tested} planted words reproduce exactly when dragged`, mismatches === 0,
  `${mismatches} mismatched`);
check('all dragged words pass server geometry and read back correctly', rejected === 0,
  `${rejected} rejected`);

console.log('\nreverse drags');
// Players will often drag right-to-left. Same word, opposite direction.
let reverseOk = 0;
let reverseBad = 0;
const sampleChunk = chunks.getChunk(701, 700);
for (const entry of sampleChunk.planted) {
  const worldCells = entry.cells.map(([x, y]) => [701 * N + x, 700 * N + y]);
  const reversedTarget = worldCells.slice().reverse();
  const dragged = snapSelection(
    reversedTarget[0][0], reversedTarget[0][1],
    reversedTarget[reversedTarget.length - 1][0],
    reversedTarget[reversedTarget.length - 1][1]
  );
  const word = chunks.readWord(dragged);
  const reversedWord = entry.word.split('').reverse().join('');
  if (word === reversedWord && checkGeometry(dragged) === null) reverseOk++;
  else reverseBad++;
}
check('dragging backwards reads the word in reverse', reverseBad === 0,
  `${reverseBad} bad of ${reverseOk + reverseBad}`);
check('backwards drags share the forwards claim key',
  claimKey(sampleChunk.planted[0].cells) ===
    claimKey(sampleChunk.planted[0].cells.slice().reverse()));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
