'use strict';

// Regression tests for two reported bugs:
//   1. A player's own newly-found word didn't show in the "Just found" list
//      until a refresh (addRecent was only called for other players' finds).
//   2. Refreshing the page looked like it "cleared" found words, because the
//      camera was re-randomized on every load, teleporting the player away
//      from the area they'd been playing in.

const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'game.js'),
  'utf8'
);

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

function extractBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find "${endMarker}" after start marker`);
  return source.slice(start, end);
}

console.log('\nbug 1: own finds must reach the recent-finds list');
const acceptedBlock = extractBlock("case 'claim_accepted':", 'break;');
check(
  'the claim_accepted handler calls addRecent',
  /addRecent\(msg\)/.test(acceptedBlock),
  '(this is the exact regression: it was missing)'
);

const claimedBlock = extractBlock("case 'claimed':", 'break;');
check(
  'the claimed (other player) handler still calls addRecent',
  /addRecent\(msg\)/.test(claimedBlock)
);

console.log('\nbug 2: camera position must persist across a reload');
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

// Run saveView/loadSavedView against a fake localStorage, exactly as the
// browser would, to check the round trip actually works.
function makeFakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

const fakeStorage = makeFakeStorage();
const sandboxState = { camCellX: 0, camCellY: 0, zoom: 1 };
const sandbox = {};
new Function(
  'exports',
  'state',
  'localStorage',
  `
  ${extractFn('saveView')}
  ${extractFn('loadSavedView')}
  exports.saveView = saveView;
  exports.loadSavedView = loadSavedView;
  `
)(sandbox, sandboxState, fakeStorage);

check('with nothing saved yet, loadSavedView returns null',
  sandbox.loadSavedView() === null);

sandboxState.camCellX = 812.5;
sandboxState.camCellY = -390.25;
sandboxState.zoom = 1.7;
sandbox.saveView();

check('saveView actually writes to storage',
  fakeStorage.getItem('ww.view') !== null);

const restored = sandbox.loadSavedView();
check('loadSavedView round-trips the exact position',
  restored && restored.x === 812.5 && restored.y === -390.25,
  JSON.stringify(restored));
check('loadSavedView round-trips zoom',
  restored && restored.zoom === 1.7);

// Malformed / corrupted storage must not crash the game — it should just
// fall back to treating the player as new.
fakeStorage.setItem('ww.view', 'not json at all {{{');
check('corrupted storage does not throw and returns null',
  (() => {
    try {
      return sandbox.loadSavedView() === null;
    } catch {
      return false;
    }
  })()
);

fakeStorage.setItem('ww.view', JSON.stringify({ x: 'nope', y: 1, zoom: 1 }));
check('non-numeric saved fields are rejected rather than trusted',
  sandbox.loadSavedView() === null);

console.log('\nbug 2: enterGame must actually use the saved view, not always randomise');
const enterGameSrc = extractFn('enterGame');
check('enterGame calls loadSavedView', /loadSavedView\(\)/.test(enterGameSrc));
check('enterGame has a branch that uses the saved position',
  /saved\.x/.test(enterGameSrc) && /saved\.y/.test(enterGameSrc));
check('enterGame still has a fresh-spawn fallback for new players',
  /Math\.random\(\)/.test(enterGameSrc));
check('enterGame saves the view immediately (covers refreshing before ever panning)',
  /saveView\(\)/.test(enterGameSrc));

console.log('\nbug 2: camera movement must trigger a save, not just the initial spawn');
const onCameraMovedSrc = extractFn('onCameraMoved');
check('onCameraMoved schedules a saveView call',
  /saveView\(\)/.test(onCameraMovedSrc));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
