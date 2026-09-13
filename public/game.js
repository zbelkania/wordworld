'use strict';

// ---------------------------------------------------------------------------
// Visible error reporting. A silent failure here looks identical to a dead
// button, so anything that goes wrong gets shown on the page rather than
// hidden in the console.
// ---------------------------------------------------------------------------

function showFatal(message) {
  let banner = document.getElementById('fatal-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-banner';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99;padding:12px 16px;' +
      'background:#5c1f1a;color:#ffd9d3;font:14px/1.5 system-ui,sans-serif;' +
      'border-bottom:1px solid #8a3229;white-space:pre-wrap';
    document.body.prepend(banner);
  }
  banner.textContent = `Problem: ${message}`;
}

window.addEventListener('error', (event) => {
  showFatal(
    `${event.message}\nat ${event.filename || 'script'}:${event.lineno || '?'}`
  );
});

window.addEventListener('unhandledrejection', (event) => {
  showFatal(`Unhandled: ${event.reason && event.reason.message ? event.reason.message : event.reason}`);
});

if (location.protocol === 'file:') {
  showFatal(
    'This page was opened directly as a file. It must be served by the game ' +
      'server instead — start it with "npm start" and open http://localhost:3000'
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const CELL_BASE = 34; // pixels per grid cell at 100% zoom
const ZOOM_MIN = 0.65; // below this, letters get too small to read comfortably
const ZOOM_MAX = 2.4;
const ZOOM_STEP = 1.22; // per click of the +/- buttons or keyboard shortcut
const MAX_SELECT = 12; // must match dictionary.MAX_WORD_LEN
const SUB_MARGIN = 1; // extra ring of chunks to prefetch around the viewport
const FLASH_MS = 4500; // how long a new claim shows its finder's name

const state = {
  token: localStorage.getItem('ww.token') || null,
  user: null,
  chunkSize: 24,
  minWordLength: 5,
  letterValues: {},

  // Camera position in *cell units* (fractional), not pixels. Cell units are
  // independent of zoom, so panning and zooming can both just adjust this
  // pair of numbers without needing to know about each other.
  camCellX: 0,
  camCellY: 0,
  zoom: 1,

  chunks: new Map(), // "cx,cy" -> { letters }
  claimsByCell: new Map(), // "x,y" -> array of claims covering that cell (overlapping words share cells)
  claims: new Map(), // claimKey -> claim (for drawing capsules)
  pending: new Set(), // chunk keys already requested
  subscribed: new Set(),

  selection: null, // { cells, anchor }
  hover: null,
  panMode: false,
  spaceHeld: false,
  keys: new Set(),
  hintMark: null, // { start, direction, length, until }
  pinch: null, // { startDist, startZoom, worldX, worldY } while two touches are down

  socket: null,
  needsDraw: true,
  scope: 'global',
};

const canvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');

const el = (id) => document.getElementById(id);

// Current on-screen pixels per cell. Everything that used to reference the
// fixed CELL constant now calls this instead.
function cellPx() {
  return CELL_BASE * state.zoom;
}

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function updateZoomLabel() {
  el('zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
}

// Change zoom while keeping the given screen point fixed over the same world
// location — the standard "zoom towards the cursor" feel, and what makes
// pinch-to-zoom and ctrl+scroll feel natural instead of jumpy.
function zoomAt(clientX, clientY, factor) {
  const rect = canvas.getBoundingClientRect();
  const oldPx = cellPx();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const worldX = state.camCellX + px / oldPx;
  const worldY = state.camCellY + py / oldPx;

  state.zoom = clampZoom(state.zoom * factor);
  const newPx = cellPx();
  state.camCellX = worldX - px / newPx;
  state.camCellY = worldY - py / newPx;

  updateZoomLabel();
  onCameraMoved();
}

// Remembers where the player was looking so a page reload lands back in the
// same neighbourhood instead of a fresh random spot — the claimed words
// there are still real, just easy to mistake for "gone" if you're teleported
// away from them on every refresh.
function saveView() {
  try {
    localStorage.setItem(
      'ww.view',
      JSON.stringify({ x: state.camCellX, y: state.camCellY, zoom: state.zoom })
    );
  } catch {
    // Private browsing can block storage. Not fatal — the view just won't
    // survive a reload this session.
  }
}

function loadSavedView() {
  try {
    const raw = localStorage.getItem('ww.view');
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (
      Number.isFinite(saved.x) &&
      Number.isFinite(saved.y) &&
      Number.isFinite(saved.zoom)
    ) {
      return saved;
    }
  } catch {
    // Malformed or missing — fall through to a fresh spawn.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coordinate helpers. These mirror server/chunks.js and must handle negative
// coordinates the same way, or the world tears at the origin.
// ---------------------------------------------------------------------------

const floorDiv = (a, b) => Math.floor(a / b);
const trueMod = (a, b) => ((a % b) + b) % b;

function chunkKeyFor(worldX, worldY) {
  return `${floorDiv(worldX, state.chunkSize)},${floorDiv(worldY, state.chunkSize)}`;
}

function letterAt(worldX, worldY) {
  const cx = floorDiv(worldX, state.chunkSize);
  const cy = floorDiv(worldY, state.chunkSize);
  const chunk = state.chunks.get(`${cx},${cy}`);
  if (!chunk) return null;
  const lx = trueMod(worldX, state.chunkSize);
  const ly = trueMod(worldY, state.chunkSize);
  return chunk.letters[ly * state.chunkSize + lx];
}

function cellAtScreen(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const cs = cellPx();
  return [
    Math.floor(state.camCellX + px / cs),
    Math.floor(state.camCellY + py / cs),
  ];
}

function claimKey(cells) {
  const fwd = cells.map(([x, y]) => `${x}:${y}`).join('|');
  const rev = cells.slice().reverse().map(([x, y]) => `${x}:${y}`).join('|');
  return fwd < rev ? fwd : rev;
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (options.body) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function socketSend(payload) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  state.socket = socket;
  setConnectionStatus('connecting');

  socket.addEventListener('open', () => {
    socketSend({ t: 'auth', token: state.token });
  });

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'welcome') setConnectionStatus('connected');
    handleMessage(msg);
  });

  socket.addEventListener('error', () => {
    setConnectionStatus('error');
  });

  socket.addEventListener('close', () => {
    setConnectionStatus('disconnected');
    // Reconnect and re-request whatever is on screen.
    state.subscribed.clear();
    state.pending.clear();
    setTimeout(connectSocket, 1500);
  });
}

let connectionBanner = null;
function setConnectionStatus(status) {
  if (status === 'connected') {
    if (connectionBanner) {
      connectionBanner.remove();
      connectionBanner = null;
    }
    return;
  }
  if (!connectionBanner) {
    connectionBanner = document.createElement('div');
    connectionBanner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:98;padding:8px 16px;' +
      'text-align:center;font:13px system-ui,sans-serif;color:#20140a;' +
      'background:#dcac4c';
    document.body.prepend(connectionBanner);
  }
  const messages = {
    connecting: 'Connecting to the game server…',
    disconnected: 'Lost connection. The letters may look frozen until this reconnects — retrying…',
    error: 'Could not open a live connection to the server. The grid will not load letters until this works.',
  };
  connectionBanner.textContent = messages[status] || status;
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      state.user = msg.user;
      state.chunkSize = msg.chunkSize;
      state.minWordLength = msg.minWordLength;
      state.letterValues = msg.letterValues || {};
      renderStats();
      syncSubscriptions(true);
      break;

    case 'chunk': {
      const key = `${msg.cx},${msg.cy}`;
      state.chunks.set(key, { letters: msg.letters });
      state.pending.delete(key);
      for (const claim of msg.claims) ingestClaim(claim, false);
      state.needsDraw = true;
      break;
    }

    case 'claim_accepted':
      ingestClaim(msg, true);
      addRecent(msg);
      state.user.totalScore = msg.totalScore;
      state.user.wordsFound = (state.user.wordsFound || 0) + 1;
      renderStats();
      showToast(
        `<strong>${msg.word.toUpperCase()}</strong> +${msg.score}` +
          (msg.multiplier < 0.99
            ? ` <span style="opacity:.7">(found often, ×${msg.multiplier.toFixed(2)})</span>`
            : ''),
        'is-win'
      );
      scheduleBoardRefresh();
      break;

    case 'claim_rejected':
      showToast(msg.error, 'is-bad');
      break;

    case 'claimed': // someone else found a word
      ingestClaim(msg, true);
      addRecent(msg);
      scheduleBoardRefresh();
      break;

    case 'error':
      showToast(msg.error, 'is-bad');
      break;
  }
}

function ingestClaim(claim, flash) {
  const key = claimKey(claim.cells);
  if (state.claims.has(key)) return;
  const record = {
    word: claim.word,
    cells: claim.cells,
    chunkKey: chunkKeyFor(claim.cells[0][0], claim.cells[0][1]),
    by: claim.by,
    color: claim.color,
    score: claim.score,
    flashUntil: flash ? Date.now() + FLASH_MS : 0,
  };
  state.claims.set(key, record);
  for (const [x, y] of claim.cells) {
    const cellKey = `${x},${y}`;
    let list = state.claimsByCell.get(cellKey);
    if (!list) {
      list = [];
      state.claimsByCell.set(cellKey, list);
    }
    list.push(record);
  }
  state.needsDraw = true;
}

// Tell the server which chunks are on screen. Chunks act as rooms: we only
// receive claims for what we can actually see.
function syncSubscriptions(force = false) {
  const rect = canvas.getBoundingClientRect();
  const cs = cellPx();
  const minCx = floorDiv(Math.floor(state.camCellX), state.chunkSize) - SUB_MARGIN;
  const minCy = floorDiv(Math.floor(state.camCellY), state.chunkSize) - SUB_MARGIN;
  const maxCx =
    floorDiv(Math.floor(state.camCellX + rect.width / cs), state.chunkSize) + SUB_MARGIN;
  const maxCy =
    floorDiv(Math.floor(state.camCellY + rect.height / cs), state.chunkSize) + SUB_MARGIN;

  const wanted = [];
  const wantedKeys = new Set();
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      wanted.push([cx, cy]);
      wantedKeys.add(`${cx},${cy}`);
    }
  }

  if (!force && wantedKeys.size === state.subscribed.size) {
    let identical = true;
    for (const key of wantedKeys) {
      if (!state.subscribed.has(key)) {
        identical = false;
        break;
      }
    }
    if (identical) return;
  }

  state.subscribed = wantedKeys;
  for (const key of wantedKeys) {
    if (!state.chunks.has(key)) state.pending.add(key);
  }
  socketSend({ t: 'sub', chunks: wanted });

  // Drop faraway chunks so memory doesn't grow without bound on long sessions.
  // Claims go with them; re-subscribing replays whatever is still there.
  if (state.chunks.size > 400) {
    const evicted = new Set();
    for (const key of state.chunks.keys()) {
      if (wantedKeys.has(key)) continue;
      state.chunks.delete(key);
      evicted.add(key);
      if (state.chunks.size <= 250) break;
    }
    if (evicted.size > 0) {
      for (const [key, claim] of state.claims) {
        if (!evicted.has(claim.chunkKey)) continue;
        state.claims.delete(key);
        for (const [x, y] of claim.cells) {
          const cellKey = `${x},${y}`;
          const list = state.claimsByCell.get(cellKey);
          if (!list) continue;
          const idx = list.indexOf(claim);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) state.claimsByCell.delete(cellKey);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.needsDraw = true;
  syncSubscriptions();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const now = Date.now();
  const cs = cellPx();

  ctx.fillStyle = '#132f38';
  ctx.fillRect(0, 0, w, h);

  const firstX = Math.floor(state.camCellX);
  const firstY = Math.floor(state.camCellY);
  const colsVisible = Math.ceil(w / cs) + 1;
  const rowsVisible = Math.ceil(h / cs) + 1;

  const screenX = (wx) => (wx - state.camCellX) * cs;
  const screenY = (wy) => (wy - state.camCellY) * cs;

  // Cell separators. Fainter when zoomed out, where a full lattice of lines
  // turns into visual static rather than helping — the letters carry enough
  // structure on their own at that distance.
  const lineAlpha = Math.min(1, Math.max(0.3, state.zoom));
  ctx.strokeStyle = '#204a58';
  ctx.globalAlpha = lineAlpha;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= colsVisible; i++) {
    const x = Math.round(screenX(firstX + i)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let j = 0; j <= rowsVisible; j++) {
    const y = Math.round(screenY(firstY + j)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Chunk boundaries, subtly, so the world has landmarks to navigate by.
  ctx.strokeStyle = '#2b5c6d';
  ctx.beginPath();
  const chunkN = state.chunkSize;
  for (let cx = floorDiv(firstX, chunkN); cx <= floorDiv(firstX + colsVisible, chunkN) + 1; cx++) {
    const x = Math.round(screenX(cx * chunkN)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let cy = floorDiv(firstY, chunkN); cy <= floorDiv(firstY + rowsVisible, chunkN) + 1; cy++) {
    const y = Math.round(screenY(cy * chunkN)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  // --- claimed words: coloured capsules underneath the letters -------------
  let flashing = false;
  ctx.lineCap = 'round';
  for (const claim of state.claims.values()) {
    const [ax, ay] = claim.cells[0];
    const [bx, by] = claim.cells[claim.cells.length - 1];
    // Skip anything entirely off screen.
    if (
      Math.max(ax, bx) < firstX - 1 ||
      Math.min(ax, bx) > firstX + colsVisible ||
      Math.max(ay, by) < firstY - 1 ||
      Math.min(ay, by) > firstY + rowsVisible
    ) {
      continue;
    }

    const isFlashing = claim.flashUntil > now;
    if (isFlashing) flashing = true;

    ctx.strokeStyle = claim.color;
    ctx.globalAlpha = isFlashing ? 0.5 : 0.26;
    ctx.lineWidth = cs * 0.76;
    ctx.beginPath();
    ctx.moveTo(screenX(ax) + cs / 2, screenY(ay) + cs / 2);
    ctx.lineTo(screenX(bx) + cs / 2, screenY(by) + cs / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (isFlashing) {
      // Name tag, shown briefly on a fresh find. Persistent tags on every
      // claimed word would bury the grid once a region fills up; colour plus
      // the hover tooltip carries ownership the rest of the time.
      const label = `${claim.by} +${claim.score}`;
      ctx.font = '500 12px "Space Grotesk", sans-serif';
      const tw = ctx.measureText(label).width;
      const tx = screenX(Math.min(ax, bx)) + cs / 2;
      const ty = screenY(Math.min(ay, by)) - 6;
      ctx.fillStyle = 'rgba(8,25,32,0.9)';
      ctx.fillRect(tx - 5, ty - 13, tw + 10, 18);
      ctx.fillStyle = claim.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(label, tx, ty);
    }
  }

  // --- hint marker ---------------------------------------------------------
  if (state.hintMark && state.hintMark.until > now) {
    const { start, direction, length } = state.hintMark;
    const ex = start[0] + direction[0] * (length - 1);
    const ey = start[1] + direction[1] * (length - 1);
    ctx.strokeStyle = '#dcac4c';
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = cs * 0.8;
    ctx.beginPath();
    ctx.moveTo(screenX(start[0]) + cs / 2, screenY(start[1]) + cs / 2);
    ctx.lineTo(screenX(ex) + cs / 2, screenY(ey) + cs / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    flashing = true;
  }

  // --- current selection ---------------------------------------------------
  if (state.selection && state.selection.cells.length > 0) {
    const cells = state.selection.cells;
    const [ax, ay] = cells[0];
    const [bx, by] = cells[cells.length - 1];
    ctx.strokeStyle = '#dcac4c';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = cs * 0.8;
    ctx.beginPath();
    ctx.moveTo(screenX(ax) + cs / 2, screenY(ay) + cs / 2);
    ctx.lineTo(screenX(bx) + cs / 2, screenY(by) + cs / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- letters -------------------------------------------------------------
  // Font size tracks zoom, floored so text never drops below comfortable
  // reading size even at ZOOM_MIN.
  const fontSize = Math.max(11, Math.round(cs * 0.5));
  ctx.font = `700 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const selected = new Set();
  if (state.selection) {
    for (const [x, y] of state.selection.cells) selected.add(`${x},${y}`);
  }

  const dotSize = Math.max(3, cs * 0.09);
  for (let j = 0; j < rowsVisible; j++) {
    for (let i = 0; i < colsVisible; i++) {
      const wx = firstX + i;
      const wy = firstY + j;
      const letter = letterAt(wx, wy);
      const px = screenX(wx) + cs / 2;
      const py = screenY(wy) + cs / 2;

      if (letter === null) {
        // Chunk hasn't arrived yet.
        ctx.fillStyle = '#204a58';
        ctx.fillRect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize);
        continue;
      }

      const key = `${wx},${wy}`;
      if (selected.has(key)) {
        ctx.fillStyle = '#20140a';
      } else if (state.claimsByCell.has(key)) {
        ctx.fillStyle = '#ece4d2'; // softened from near-white to cut glare
      } else {
        ctx.fillStyle = '#d9d2c2'; // slightly dimmer resting letter colour
      }
      ctx.fillText(letter.toUpperCase(), px, py);
    }
  }

  // Keep animating while something is time-based.
  if (flashing) state.needsDraw = true;
}

function frame() {
  const panning = state.keys.size > 0;
  if (panning) applyKeyPan();
  if (state.needsDraw || panning) {
    state.needsDraw = false;
    draw();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function snapSelection(anchorX, anchorY, toX, toY) {
  const dx = toX - anchorX;
  const dy = toY - anchorY;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  let stepX = 0;
  let stepY = 0;
  let length = 1;

  if (adx !== 0 || ady !== 0) {
    if (adx > ady * 2) {
      stepX = Math.sign(dx);
      length = adx + 1;
    } else if (ady > adx * 2) {
      stepY = Math.sign(dy);
      length = ady + 1;
    } else {
      stepX = Math.sign(dx);
      stepY = Math.sign(dy);
      length = Math.max(adx, ady) + 1;
    }
  }

  length = Math.min(length, MAX_SELECT);
  const cells = [];
  for (let i = 0; i < length; i++) {
    cells.push([anchorX + stepX * i, anchorY + stepY * i]);
  }
  return cells;
}

function updateSelectionReadout() {
  const readout = el('selection-readout');
  if (!state.selection || state.selection.cells.length < 2) {
    readout.hidden = true;
    return;
  }
  let word = '';
  for (const [x, y] of state.selection.cells) {
    const letter = letterAt(x, y);
    word += letter ? letter.toUpperCase() : '·';
  }
  el('selection-word').textContent = word;
  const n = state.selection.cells.length;
  el('selection-len').textContent =
    n < state.minWordLength ? `${state.minWordLength - n} more needed` : `${n} letters`;
  readout.hidden = false;
}

function finishSelection() {
  const selection = state.selection;
  state.selection = null;
  updateSelectionReadout();
  state.needsDraw = true;
  if (!selection) return;
  if (selection.cells.length < state.minWordLength) {
    if (selection.cells.length > 1) {
      showToast(`Words must be at least ${state.minWordLength} letters.`, 'is-bad');
    }
    return;
  }
  socketSend({ t: 'claim', cells: selection.cells });
  dismissHelp();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const pointers = new Map();
let panning = null;
let suppressSelectUntilRelease = false;

function wantsPan(event) {
  return state.panMode || state.spaceHeld || event.button === 1 || event.button === 2;
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size >= 2) {
    // Second finger down: this is a pinch/pan gesture, so abandon any
    // selection and start tracking pinch-zoom.
    state.selection = null;
    updateSelectionReadout();
    suppressSelectUntilRelease = true;
    panning = null;

    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const rect = canvas.getBoundingClientRect();
    const centroidX = (p1.x + p2.x) / 2;
    const centroidY = (p1.y + p2.y) / 2;
    const cs = cellPx();
    state.pinch = {
      startDist: Math.max(dist, 1),
      startZoom: state.zoom,
      worldX: state.camCellX + (centroidX - rect.left) / cs,
      worldY: state.camCellY + (centroidY - rect.top) / cs,
    };
    state.needsDraw = true;
    return;
  }

  if (wantsPan(event)) {
    panning = { x: event.clientX, y: event.clientY };
    canvas.classList.add('is-panning');
    return;
  }

  const [cx, cy] = cellAtScreen(event.clientX, event.clientY);
  state.selection = { anchor: [cx, cy], cells: [[cx, cy]] };
  updateSelectionReadout();
  state.needsDraw = true;
});

canvas.addEventListener('pointermove', (event) => {
  if (pointers.has(event.pointerId)) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  if (state.pinch && pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const rect = canvas.getBoundingClientRect();
    const centroidX = (p1.x + p2.x) / 2;
    const centroidY = (p1.y + p2.y) / 2;

    state.zoom = clampZoom(state.pinch.startZoom * (dist / state.pinch.startDist));
    const cs = cellPx();
    state.camCellX = state.pinch.worldX - (centroidX - rect.left) / cs;
    state.camCellY = state.pinch.worldY - (centroidY - rect.top) / cs;
    updateZoomLabel();
    onCameraMoved();
    return;
  }

  if (panning) {
    const point = { x: event.clientX, y: event.clientY };
    const cs = cellPx();
    state.camCellX -= (point.x - panning.x) / cs;
    state.camCellY -= (point.y - panning.y) / cs;
    panning = point;
    onCameraMoved();
    return;
  }

  if (state.selection) {
    const [cx, cy] = cellAtScreen(event.clientX, event.clientY);
    const anchor = state.selection.anchor;
    state.selection.cells = snapSelection(anchor[0], anchor[1], cx, cy);
    updateSelectionReadout();
    state.needsDraw = true;
    return;
  }

  // Hover tooltip over claimed letters. A cell can belong to more than one
  // claimed word — a prefix and a longer word sharing letters, for instance —
  // so this lists every claim that covers the hovered cell, not just one.
  const [hx, hy] = cellAtScreen(event.clientX, event.clientY);
  const claimsHere = state.claimsByCell.get(`${hx},${hy}`);
  const tooltip = el('tooltip');
  if (claimsHere && claimsHere.length > 0) {
    tooltip.innerHTML = claimsHere
      .map(
        (c) =>
          `<span class="tt-word" style="color:${c.color}">${c.word.toUpperCase()}</span>` +
          `<br><span class="tt-meta">found by ${escapeHtml(c.by)} · ${c.score} pts</span>`
      )
      .join('<hr class="tt-divider">');
    const rect = canvas.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    tooltip.style.top = `${event.clientY - rect.top + 14}px`;
    tooltip.hidden = false;
  } else {
    tooltip.hidden = true;
  }
});

function releasePointer(event) {
  pointers.delete(event.pointerId);

  if (pointers.size === 0) {
    state.pinch = null;
    if (panning) {
      panning = null;
      if (!state.panMode && !state.spaceHeld) canvas.classList.remove('is-panning');
    } else if (!suppressSelectUntilRelease) {
      finishSelection();
    } else {
      state.selection = null;
      updateSelectionReadout();
    }
    suppressSelectUntilRelease = false;
  } else if (pointers.size === 1) {
    // Down to one finger: drop pinch tracking and resume plain panning from
    // wherever that finger is now, so the view doesn't jump.
    state.pinch = null;
    const [remaining] = pointers.values();
    panning = { x: remaining.x, y: remaining.y };
  }
}

canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointerleave', () => {
  el('tooltip').hidden = true;
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();

    // A trackpad pinch is delivered as a wheel event with ctrlKey set, on
    // every major browser — this is the standard way to detect it, since
    // there's no dedicated "pinch" DOM event for trackpads.
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.012);
      zoomAt(event.clientX, event.clientY, factor);
      return;
    }

    const cs = cellPx();
    if (event.shiftKey) {
      state.camCellX += (event.deltaY + event.deltaX) / cs;
    } else {
      state.camCellX += event.deltaX / cs;
      state.camCellY += event.deltaY / cs;
    }
    onCameraMoved();
  },
  { passive: false }
);

const KEY_PAN = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
};

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.code === 'Space') {
    state.spaceHeld = true;
    canvas.classList.add('is-panning');
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape') {
    state.selection = null;
    updateSelectionReadout();
    state.needsDraw = true;
    return;
  }
  if (event.key === '=' || event.key === '+') {
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, ZOOM_STEP);
    event.preventDefault();
    return;
  }
  if (event.key === '-' || event.key === '_') {
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / ZOOM_STEP);
    event.preventDefault();
    return;
  }
  if (event.key === '0') {
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / state.zoom);
    event.preventDefault();
    return;
  }
  if (KEY_PAN[event.key]) {
    state.keys.add(event.key);
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    state.spaceHeld = false;
    if (!state.panMode) canvas.classList.remove('is-panning');
  }
  state.keys.delete(event.key);
});

window.addEventListener('blur', () => {
  state.keys.clear();
  state.spaceHeld = false;
});

function applyKeyPan() {
  let dx = 0;
  let dy = 0;
  for (const key of state.keys) {
    const dir = KEY_PAN[key];
    if (dir) {
      dx += dir[0];
      dy += dir[1];
    }
  }
  if (dx === 0 && dy === 0) return;
  // Cells-per-second stays constant across zoom levels, since panning speed
  // is easiest to judge by "how many letters go by", not screen pixels.
  const cellsPerFrame = 0.42;
  state.camCellX += dx * cellsPerFrame;
  state.camCellY += dy * cellsPerFrame;
  onCameraMoved();
}

let subTimer = null;
function onCameraMoved() {
  state.needsDraw = true;
  renderCoords();
  if (subTimer) return;
  subTimer = setTimeout(() => {
    subTimer = null;
    syncSubscriptions();
    saveView();
  }, 90);
}

// ---------------------------------------------------------------------------
// UI panels
// ---------------------------------------------------------------------------

function renderStats() {
  if (!state.user) return;
  el('score').textContent = (state.user.totalScore || 0).toLocaleString();
  el('words-found').textContent = (state.user.wordsFound || 0).toLocaleString();
}

function renderCoords() {
  const rect = canvas.getBoundingClientRect();
  const cs = cellPx();
  const cx = Math.floor(state.camCellX + rect.width / cs / 2);
  const cy = Math.floor(state.camCellY + rect.height / cs / 2);
  el('coords').textContent = `${cx}, ${cy}`;
}

async function loadLeaderboard() {
  try {
    const data = await api(`/api/leaderboard?scope=${state.scope}`);
    const list = el('leaderboard');
    if (data.rows.length === 0) {
      list.innerHTML = '<p class="empty">No scores yet. Go find something.</p>';
      return;
    }
    list.innerHTML = data.rows
      .map(
        (row) => `
        <li class="${row.isYou ? 'is-you' : ''}">
          <span class="rank">${row.rank}</span>
          <span class="swatch" style="background:${row.color}"></span>
          <span class="who">${escapeHtml(row.username)}</span>
          <span class="pts">${row.score.toLocaleString()}</span>
        </li>`
      )
      .join('');
  } catch (err) {
    el('leaderboard').innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function addRecent(claim) {
  const list = el('recent');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.innerHTML =
    `<span class="r-word" style="color:${claim.color}">${claim.word.toUpperCase()}</span>` +
    `<span class="r-by">${escapeHtml(claim.by)}</span>` +
    `<span class="r-pts">+${claim.score}</span>`;
  list.prepend(li);
  while (list.children.length > 12) list.lastElementChild.remove();
}

async function loadRecent() {
  try {
    const data = await api('/api/recent');
    const list = el('recent');
    if (data.claims.length === 0) {
      list.innerHTML = '<p class="empty">Nothing found yet.</p>';
      return;
    }
    list.innerHTML = data.claims
      .map(
        (c) =>
          `<li><span class="r-word" style="color:${c.color}">${c.word.toUpperCase()}</span>` +
          `<span class="r-by">${escapeHtml(c.username)}</span>` +
          `<span class="r-pts">+${c.score}</span></li>`
      )
      .join('');
  } catch {
    /* non-critical */
  }
}

async function loadFriends() {
  try {
    const data = await api('/api/friends');
    const list = el('friend-list');
    list.innerHTML =
      data.friends.length === 0
        ? '<p class="empty">No friends added yet.</p>'
        : data.friends
            .map(
              (f) =>
                `<li><span class="swatch" style="background:${f.color}"></span>` +
                `<span>${escapeHtml(f.username)}</span>` +
                `<span class="pts">${f.total_score.toLocaleString()}</span></li>`
            )
            .join('');

    el('friend-requests').innerHTML = data.requests
      .map(
        (r) =>
          `<li><span>${escapeHtml(r.username)} wants to be friends</span>` +
          `<button type="button" data-accept="${r.id}">Accept</button></li>`
      )
      .join('');
  } catch {
    /* non-critical */
  }
}

let boardTimer = null;
function scheduleBoardRefresh() {
  if (boardTimer) return;
  boardTimer = setTimeout(() => {
    boardTimer = null;
    loadLeaderboard();
  }, 1800);
}

function showToast(html, variant) {
  const toast = document.createElement('div');
  toast.className = `toast ${variant || ''}`;
  toast.innerHTML = html;
  el('toast-stack').append(toast);
  setTimeout(() => toast.remove(), 2600);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function dismissHelp() {
  el('help-hint').classList.add('is-gone');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el('signin-go').addEventListener('click', doSignin);
el('username').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') doSignin();
});

async function doSignin() {
  const button = el('signin-go');
  const username = el('username').value.trim();
  const error = el('signin-error');
  error.hidden = true;

  if (username === '') {
    error.textContent = 'Type a name first.';
    error.hidden = false;
    return;
  }

  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const data = await api('/api/signin', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
    state.token = data.token;
    state.user = data.user;
    try {
      localStorage.setItem('ww.token', data.token);
    } catch {
      // Private browsing can block storage. Playing still works, the session
      // just won't survive a reload.
    }
    enterGame();
  } catch (err) {
    // A failed fetch (server not running, wrong port) throws a bare TypeError,
    // which is useless on its own, so say something actionable instead.
    const message =
      err instanceof TypeError
        ? 'Could not reach the game server. Is it still running in Terminal?'
        : err.message;
    error.textContent = message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Start playing';
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('is-active', other === tab);
      other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
    }
    state.scope = tab.dataset.scope;
    loadLeaderboard();
  });
}

el('pan-toggle').addEventListener('click', () => {
  state.panMode = !state.panMode;
  el('pan-toggle').setAttribute('aria-pressed', String(state.panMode));
  canvas.classList.toggle('is-panning', state.panMode);
});

el('rail-toggle').addEventListener('click', () => {
  const rail = el('rail');
  const open = rail.classList.toggle('is-open');
  el('rail-toggle').setAttribute('aria-expanded', String(open));
});

el('zoom-in').addEventListener('click', () => {
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, ZOOM_STEP);
});

el('zoom-out').addEventListener('click', () => {
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / ZOOM_STEP);
});

el('friend-add-btn').addEventListener('click', addFriend);
el('friend-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addFriend();
});

async function addFriend() {
  const input = el('friend-name');
  const msg = el('friend-msg');
  msg.hidden = true;
  try {
    const result = await api('/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ username: input.value.trim() }),
    });
    input.value = '';
    showToast(result.accepted ? 'Friend added.' : 'Request sent.');
    loadFriends();
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  }
}

el('friend-requests').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-accept]');
  if (!button) return;
  try {
    await api('/api/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ userId: Number(button.dataset.accept) }),
    });
    loadFriends();
    loadLeaderboard();
  } catch (err) {
    showToast(err.message, 'is-bad');
  }
});

// Hint. In production this must be gated behind a verified rewarded-ad
// completion — see the TODO in server/index.js.
el('hint-btn').addEventListener('click', async () => {
  const button = el('hint-btn');
  button.disabled = true;
  try {
    const rect = canvas.getBoundingClientRect();
    const cs = cellPx();
    const centreX = Math.floor(state.camCellX + rect.width / cs / 2);
    const centreY = Math.floor(state.camCellY + rect.height / cs / 2);
    const data = await api('/api/hint', {
      method: 'POST',
      body: JSON.stringify({
        cx: floorDiv(centreX, state.chunkSize),
        cy: floorDiv(centreY, state.chunkSize),
      }),
    });
    if (!data.hint) {
      showToast('Every planted word here is already claimed.', 'is-bad');
    } else {
      state.hintMark = { ...data.hint, until: Date.now() + 6000 };
      showToast(`A ${data.hint.length}-letter word starts here.`);
      state.needsDraw = true;
    }
  } catch (err) {
    showToast(err.message, 'is-bad');
  } finally {
    setTimeout(() => {
      button.disabled = false;
    }, 1200);
  }
});

window.addEventListener('resize', resizeCanvas);

function enterGame() {
  el('signin').hidden = true;
  el('topbar').hidden = false;
  el('stage').hidden = false;

  // Return to wherever the player was looking last time. Only brand-new
  // players (or a cleared localStorage) get a fresh random spawn, so the
  // world doesn't funnel everyone onto the same few chunks at the origin.
  const saved = loadSavedView();
  if (saved) {
    state.camCellX = saved.x;
    state.camCellY = saved.y;
    state.zoom = clampZoom(saved.zoom);
  } else {
    state.camCellX = Math.floor(Math.random() * 20000) - 10000;
    state.camCellY = Math.floor(Math.random() * 20000) - 10000;
    state.zoom = 1;
  }
  updateZoomLabel();

  resizeCanvas();
  saveView();
  renderStats();
  renderCoords();
  connectSocket();
  loadLeaderboard();
  loadRecent();
  loadFriends();
  setInterval(loadLeaderboard, 20000);
  setTimeout(dismissHelp, 12000);
  requestAnimationFrame(frame);
}

async function boot() {
  if (!state.token) return;
  try {
    const data = await api('/api/me');
    state.user = data.user;
    enterGame();
  } catch {
    localStorage.removeItem('ww.token');
    state.token = null;
  }
}

boot();
