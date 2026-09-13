'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');

const chunks = require('./chunks');
const dictionary = require('./dictionary');
const db = require('./db');
const { validateClaim } = require('./validate');

const PORT = process.env.PORT || 3000;
const MAX_SUBSCRIPTIONS = 64; // a viewport needs far fewer than this

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Auth. Deliberately minimal: a username claims a persistent token stored in
// the browser. Swap for real OAuth before launch — see README "Before you
// launch". Nothing else in the codebase depends on how a token is issued.
// ---------------------------------------------------------------------------

function authed(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = db.userByToken(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    color: user.color,
    totalScore: user.total_score,
    wordsFound: user.words_found,
  };
}

app.post('/api/signin', (req, res) => {
  const raw = String(req.body?.username ?? '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(raw)) {
    return res.status(400).json({
      error: 'Use 3 to 16 letters, numbers, or underscores.',
    });
  }
  const existing = db.userByName(raw);
  const user = existing || db.createUser(raw);
  res.json({ token: user.token, user: publicUser(user) });
});

app.get('/api/me', authed, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/leaderboard', authed, (req, res) => {
  const scope = req.query.scope === 'friends' ? 'friends' : 'global';
  const rows =
    scope === 'friends'
      ? db.friendsLeaderboard(req.user.id)
      : db.globalLeaderboard();
  res.json({
    scope,
    rows: rows.map((row, i) => ({
      rank: i + 1,
      id: row.id,
      username: row.username,
      color: row.color,
      score: row.total_score,
      wordsFound: row.words_found,
      isYou: row.id === req.user.id,
    })),
  });
});

app.get('/api/recent', authed, (_req, res) => {
  res.json({ claims: db.recentClaims(12) });
});

// --- Friends ---------------------------------------------------------------

app.get('/api/friends', authed, (req, res) => {
  res.json({
    friends: db.friendList(req.user.id),
    requests: db.incomingRequests(req.user.id),
  });
});

app.post('/api/friends/request', authed, (req, res) => {
  const name = String(req.body?.username ?? '').trim();
  const target = db.userByName(name);
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  const result = db.requestFriend(req.user.id, target.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, accepted: result.accepted });
});

app.post('/api/friends/accept', authed, (req, res) => {
  const requesterId = Number(req.body?.userId);
  if (!Number.isInteger(requesterId)) {
    return res.status(400).json({ error: 'Malformed request.' });
  }
  const pending = db
    .incomingRequests(req.user.id)
    .some((r) => r.id === requesterId);
  if (!pending) return res.status(404).json({ error: 'No such request.' });
  db.acceptFriend(req.user.id, requesterId);
  res.json({ ok: true });
});

// --- Hints (this is the rewarded-ad payout) --------------------------------
//
// In production, the client watches a rewarded video and the ad SDK returns a
// signed completion callback. Verify that server-side here before granting the
// hint, otherwise players just call this endpoint directly and skip the ad.
// See README "Wiring up ads" for the exact integration point.

app.post('/api/hint', authed, (req, res) => {
  const cx = Number(req.body?.cx);
  const cy = Number(req.body?.cy);
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
    return res.status(400).json({ error: 'Malformed request.' });
  }

  // TODO(ads): verify a rewarded-ad completion token here before granting.
  // const ok = await verifyRewardedAd(req.body.adToken, req.user.id);
  // if (!ok) return res.status(402).json({ error: 'Ad not completed.' });

  const hint = chunks.findHint(cx, cy, (cells) => db.isClaimed(cells));
  if (!hint) return res.json({ hint: null });
  res.json({ hint });
});

// ---------------------------------------------------------------------------
// WebSocket layer
//
// Chunks act as rooms. A player subscribes to the chunks in their viewport and
// receives claims only for those. Because players spread out across the world,
// this keeps broadcast fan-out small no matter how many are online.
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// chunkKey -> Set<socket>
const chunkSubscribers = new Map();

function subscribe(socket, keys) {
  const next = new Set(keys);

  for (const key of socket.chunkKeys) {
    if (next.has(key)) continue;
    const set = chunkSubscribers.get(key);
    if (set) {
      set.delete(socket);
      if (set.size === 0) chunkSubscribers.delete(key);
    }
  }

  for (const key of next) {
    if (socket.chunkKeys.has(key)) continue;
    let set = chunkSubscribers.get(key);
    if (!set) {
      set = new Set();
      chunkSubscribers.set(key, set);
    }
    set.add(socket);
  }

  socket.chunkKeys = next;
}

function unsubscribeAll(socket) {
  for (const key of socket.chunkKeys) {
    const set = chunkSubscribers.get(key);
    if (set) {
      set.delete(socket);
      if (set.size === 0) chunkSubscribers.delete(key);
    }
  }
  socket.chunkKeys = new Set();
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

// Broadcast to everyone watching any chunk the word touches. Skip the claimer,
// who already got a direct confirmation.
//
// To scale past one server process, publish this payload to Redis instead and
// have every instance relay it to its own local subscribers. Nothing else here
// needs to change. See README "Moving to Postgres".
function broadcastClaim(result, user, exclude) {
  const payload = {
    t: 'claimed',
    word: result.word,
    cells: result.cells,
    score: result.score,
    by: user.username,
    color: user.color,
  };
  const seen = new Set();
  for (const key of result.touchedChunks) {
    const set = chunkSubscribers.get(key);
    if (!set) continue;
    for (const socket of set) {
      if (socket === exclude || seen.has(socket)) continue;
      seen.add(socket);
      send(socket, payload);
    }
  }
}

wss.on('connection', (socket) => {
  socket.user = null;
  socket.chunkKeys = new Set();
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(socket, { t: 'error', error: 'Malformed message.' });
    }

    if (msg.t === 'auth') {
      const user = db.userByToken(msg.token);
      if (!user) return send(socket, { t: 'error', error: 'Not signed in.' });
      socket.user = user;
      return send(socket, {
        t: 'welcome',
        user: publicUser(user),
        chunkSize: chunks.CHUNK_SIZE,
        minWordLength: dictionary.MIN_WORD_LEN,
        letterValues: dictionary.LETTER_VALUES,
      });
    }

    if (!socket.user) {
      return send(socket, { t: 'error', error: 'Not signed in.' });
    }

    if (msg.t === 'sub') {
      if (!Array.isArray(msg.chunks)) return;
      const wanted = msg.chunks
        .slice(0, MAX_SUBSCRIPTIONS)
        .filter(
          (c) =>
            Array.isArray(c) && Number.isInteger(c[0]) && Number.isInteger(c[1])
        );

      const fresh = wanted
        .map(([cx, cy]) => `${cx},${cy}`)
        .filter((key) => !socket.chunkKeys.has(key));

      subscribe(socket, wanted.map(([cx, cy]) => `${cx},${cy}`));

      // Send letters + existing claims for chunks the client didn't have.
      for (const key of fresh) {
        const [cx, cy] = key.split(',').map(Number);
        const chunk = chunks.getChunk(cx, cy);
        send(socket, {
          t: 'chunk',
          cx,
          cy,
          letters: chunk.letters, // planted list is intentionally omitted
          claims: db.claimsInChunk(cx, cy),
        });
      }
      return;
    }

    if (msg.t === 'claim') {
      const result = validateClaim(socket.user, msg.cells);
      if (!result.ok) {
        return send(socket, { t: 'claim_rejected', error: result.error });
      }

      // Re-read so the running total reflects the transaction we just made.
      const fresh = db.userByToken(socket.user.token);
      socket.user = fresh;

      send(socket, {
        t: 'claim_accepted',
        word: result.word,
        cells: result.cells,
        score: result.score,
        multiplier: result.multiplier,
        totalScore: fresh.total_score,
        by: fresh.username,
        color: fresh.color,
      });

      broadcastClaim(result, fresh, socket);
      return;
    }
  });

  socket.on('close', () => unsubscribeAll(socket));
  socket.on('error', () => unsubscribeAll(socket));
});

// Drop dead connections so subscription sets don't leak.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      unsubscribeAll(socket);
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);
heartbeat.unref();

server.listen(PORT, () => {
  const stats = dictionary.stats();
  console.log(`WordWorld listening on http://localhost:${PORT}`);
  console.log(
    `  dictionary: ${stats.validWords} claimable words, ${dictionary.MIN_WORD_LEN}+ letters`
  );
  console.log(`  chunk size: ${chunks.CHUNK_SIZE}x${chunks.CHUNK_SIZE}`);
  if (!process.env.WORLD_SEED) {
    console.log('  warning: WORLD_SEED is unset, using the default seed');
  }
});

module.exports = { app, server };
