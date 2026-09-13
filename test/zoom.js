'use strict';

// Extracts the zoom functions from game.js and checks the property that
// actually matters for feel: zooming towards a point keeps that point fixed
// on screen. If this drifts, every zoom click visibly yanks the view sideways.

const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'game.js'),
  'utf8'
);

function extractConst(name) {
  const match = source.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`could not find const ${name} in game.js`);
  return match[1].trim();
}

function extractFn(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name} in game.js`);
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

const CELL_BASE = Number(extractConst('CELL_BASE'));
const ZOOM_MIN = Number(extractConst('ZOOM_MIN'));
const ZOOM_MAX = Number(extractConst('ZOOM_MAX'));

// Minimal stand-in for the canvas + state that zoomAt/cellPx/clampZoom need.
const rectStub = { left: 0, top: 0, width: 900, height: 600 };
const sandboxState = { camCellX: 100.25, camCellY: -40.5, zoom: 1 };

const sandbox = {};
new Function(
  'exports',
  'state',
  'canvas',
  'onCameraMoved',
  'updateZoomLabel',
  `
  const CELL_BASE = ${CELL_BASE};
  const ZOOM_MIN = ${ZOOM_MIN};
  const ZOOM_MAX = ${ZOOM_MAX};
  ${extractFn('cellPx')}
  ${extractFn('clampZoom')}
  ${extractFn('zoomAt')}
  exports.cellPx = cellPx;
  exports.clampZoom = clampZoom;
  exports.zoomAt = zoomAt;
  `
)(
  sandbox,
  sandboxState,
  { getBoundingClientRect: () => rectStub },
  () => {},
  () => {}
);

const { zoomAt, clampZoom, cellPx } = sandbox;

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

console.log('\nclamping');
check('zoom is clamped at the floor', clampZoom(0.01) === ZOOM_MIN);
check('zoom is clamped at the ceiling', clampZoom(999) === ZOOM_MAX);
check('zoom within range passes through', clampZoom(1.3) === 1.3);

console.log('\ncellPx tracks zoom');
sandboxState.zoom = 1;
check('cellPx at 100% is CELL_BASE', cellPx() === CELL_BASE);
sandboxState.zoom = 2;
check('cellPx at 200% doubles', cellPx() === CELL_BASE * 2);
sandboxState.zoom = 1;

console.log('\nzoom keeps the cursor point fixed on screen');
// This is the property that makes zoom feel right: whatever world point was
// under the cursor before zooming should render at the same screen position
// after zooming, for any zoom factor and any cursor position.
function worldPointUnder(clientX, clientY) {
  const cs = cellPx();
  return [
    sandboxState.camCellX + (clientX - rectStub.left) / cs,
    sandboxState.camCellY + (clientY - rectStub.top) / cs,
  ];
}
function screenPosOf(worldX, worldY) {
  const cs = cellPx();
  return [
    (worldX - sandboxState.camCellX) * cs + rectStub.left,
    (worldY - sandboxState.camCellY) * cs + rectStub.top,
  ];
}

for (const [cx, cy, factor] of [
  [450, 300, 1.22], // centre, zoom in
  [450, 300, 1 / 1.22], // centre, zoom out
  [50, 50, 1.5], // near a corner
  [880, 590, 0.8], // opposite corner
  [200, 400, 2.0], // big jump
]) {
  sandboxState.camCellX = 100.25;
  sandboxState.camCellY = -40.5;
  sandboxState.zoom = 1;

  const [wx, wy] = worldPointUnder(cx, cy);
  zoomAt(cx, cy, factor);
  const [sx, sy] = screenPosOf(wx, wy);

  const drift = Math.hypot(sx - cx, sy - cy);
  check(
    `cursor at (${cx},${cy}) factor ${factor}: world point stays under cursor`,
    drift < 0.01,
    `drift ${drift.toFixed(4)}px`
  );
}

console.log('\nzoom stays clamped even with an extreme factor');
sandboxState.camCellX = 0;
sandboxState.camCellY = 0;
sandboxState.zoom = 1;
zoomAt(450, 300, 1000);
check('an extreme zoom-in factor is still clamped', sandboxState.zoom === ZOOM_MAX);
zoomAt(450, 300, 0.0001);
check('an extreme zoom-out factor is still clamped', sandboxState.zoom === ZOOM_MIN);

console.log('\nrepeated small zooms compose correctly');
sandboxState.camCellX = 0;
sandboxState.camCellY = 0;
sandboxState.zoom = 1;
const STEP = 1.22;
// Stay within [ZOOM_MIN, ZOOM_MAX] so clamping doesn't make the round trip
// asymmetric — 4 steps of 1.22x tops out around 2.2x, safely under 2.4x.
const N = 4;
for (let i = 0; i < N; i++) zoomAt(450, 300, STEP);
const afterUp = sandboxState.zoom;
check('none of the forward steps got clamped', afterUp < ZOOM_MAX - 0.01, `reached ${afterUp}`);
for (let i = 0; i < N; i++) zoomAt(450, 300, 1 / STEP);
check(
  'zooming in N times then out N times returns to ~1.0',
  Math.abs(sandboxState.zoom - 1) < 0.01,
  `ended at ${sandboxState.zoom.toFixed(4)}`
);
check('zooming in steps actually increased zoom', afterUp > 1);

console.log('\nclamped round trips pin at the floor, by design');
// Documents the earlier failure mode: overshooting the ceiling on the way up
// means the way down can't retrace the same path, so it pins at ZOOM_MIN
// instead of returning to 1.0. That's correct, not a bug.
sandboxState.camCellX = 0;
sandboxState.camCellY = 0;
sandboxState.zoom = 1;
for (let i = 0; i < 10; i++) zoomAt(450, 300, STEP);
check('10 steps of 1.22x pins at the ceiling', sandboxState.zoom === ZOOM_MAX);
for (let i = 0; i < 10; i++) zoomAt(450, 300, 1 / STEP);
check('zooming back out from a pinned ceiling pins at the floor',
  sandboxState.zoom === ZOOM_MIN);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
