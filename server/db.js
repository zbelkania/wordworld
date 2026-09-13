'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

// SQLite keeps local development to zero setup. The schema is deliberately
// written in plain SQL that ports to Postgres with only small changes —
// see README "Moving to Postgres".
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'wordworld.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT    NOT NULL UNIQUE,
    token        TEXT    NOT NULL UNIQUE,
    color        TEXT    NOT NULL,
    total_score  INTEGER NOT NULL DEFAULT 0,
    words_found  INTEGER NOT NULL DEFAULT 0,
    suspicion    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS friendships (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    friend_id  INTEGER NOT NULL REFERENCES users(id),
    status     TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS found_words (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_x  INTEGER NOT NULL,
    chunk_y  INTEGER NOT NULL,
    word     TEXT    NOT NULL,
    cells    TEXT    NOT NULL,
    user_id  INTEGER NOT NULL REFERENCES users(id),
    score    INTEGER NOT NULL,
    found_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (cells)
  );

  CREATE INDEX IF NOT EXISTS idx_found_chunk ON found_words (chunk_x, chunk_y);
  CREATE INDEX IF NOT EXISTS idx_found_user  ON found_words (user_id);
  CREATE INDEX IF NOT EXISTS idx_users_score ON users (total_score DESC);
`);

// Distinct, readable hues for claimed-word highlights.
const PLAYER_COLORS = [
  '#e0564f', '#e59a2b', '#c9b02e', '#6fa839', '#35a37d',
  '#3b93c4', '#5d6fd0', '#8f5bc4', '#c4519a', '#b06a3d',
];

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const stmtUserByToken = db.prepare('SELECT * FROM users WHERE token = ?');
const stmtUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtInsertUser = db.prepare(
  'INSERT INTO users (username, token, color) VALUES (?, ?, ?)'
);

function createUser(username) {
  const token = crypto.randomBytes(24).toString('hex');
  const color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
  const info = stmtInsertUser.run(username, token, color);
  return stmtUserById.get(info.lastInsertRowid);
}

function userByToken(token) {
  if (!token) return null;
  return stmtUserByToken.get(token) || null;
}

function userByName(username) {
  return stmtUserByName.get(username) || null;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const stmtClaimsInChunk = db.prepare(`
  SELECT f.word, f.cells, f.score, f.found_at, u.username, u.color
  FROM found_words f JOIN users u ON u.id = f.user_id
  WHERE f.chunk_x = ? AND f.chunk_y = ?
`);

const stmtClaimByCells = db.prepare('SELECT 1 FROM found_words WHERE cells = ?');

const stmtInsertClaim = db.prepare(`
  INSERT INTO found_words (chunk_x, chunk_y, word, cells, user_id, score)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtBumpUser = db.prepare(`
  UPDATE users SET total_score = total_score + ?, words_found = words_found + 1
  WHERE id = ?
`);

// How many times this exact word has already been claimed anywhere in the
// world. Used to apply diminishing returns so players can't farm the same
// easy word across thousands of chunks.
const stmtWordClaimCount = db.prepare(
  'SELECT COUNT(*) AS n FROM found_words WHERE word = ?'
);

function claimsInChunk(cx, cy) {
  return stmtClaimsInChunk.all(cx, cy).map((row) => ({
    word: row.word,
    cells: JSON.parse(row.cells),
    score: row.score,
    by: row.username,
    color: row.color,
  }));
}

function cellsKey(cells) {
  // Canonical form so the same placement can't be claimed twice by walking it
  // backwards. The UNIQUE constraint on `cells` then enforces uniqueness.
  const forward = cells.map(([x, y]) => `${x}:${y}`).join('|');
  const backward = cells
    .slice()
    .reverse()
    .map(([x, y]) => `${x}:${y}`)
    .join('|');
  return forward < backward ? forward : backward;
}

function isClaimed(cells) {
  return !!stmtClaimByCells.get(cellsKey(cells));
}

function wordClaimCount(word) {
  return stmtWordClaimCount.get(word).n;
}

// Insert claim and bump the user's score atomically.
const recordClaim = (cx, cy, word, cells, userId, score) => {
  db.exec('BEGIN');
  try {
    stmtInsertClaim.run(cx, cy, word, cellsKey(cells), userId, score);
    stmtBumpUser.run(score, userId);
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    if (String(err.message).includes('UNIQUE')) return false; // raced
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

const stmtGlobalBoard = db.prepare(`
  SELECT id, username, color, total_score, words_found
  FROM users ORDER BY total_score DESC, words_found ASC LIMIT ?
`);

const stmtRecentClaims = db.prepare(`
  SELECT f.word, f.score, u.username, u.color
  FROM found_words f JOIN users u ON u.id = f.user_id
  ORDER BY f.id DESC LIMIT ?
`);

function globalLeaderboard(limit = 50) {
  return stmtGlobalBoard.all(limit);
}

function friendsLeaderboard(userId, limit = 50) {
  // Mirrors the Redis approach from the plan: resolve the friend id set, then
  // read scores for just those ids. In Postgres/Redis this becomes a ZMSCORE.
  const ids = acceptedFriendIds(userId);
  ids.push(userId); // include yourself
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, username, color, total_score, words_found FROM users
       WHERE id IN (${placeholders})
       ORDER BY total_score DESC, words_found ASC LIMIT ?`
    )
    .all(...ids, limit);
}

function recentClaims(limit = 12) {
  return stmtRecentClaims.all(limit);
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

const stmtUpsertFriendship = db.prepare(`
  INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, ?)
  ON CONFLICT (user_id, friend_id) DO UPDATE SET status = excluded.status
`);

const stmtFriendship = db.prepare(
  'SELECT status FROM friendships WHERE user_id = ? AND friend_id = ?'
);

const stmtAcceptedIds = db.prepare(
  "SELECT friend_id FROM friendships WHERE user_id = ? AND status = 'accepted'"
);

const stmtIncomingRequests = db.prepare(`
  SELECT u.id, u.username, u.color FROM friendships f
  JOIN users u ON u.id = f.user_id
  WHERE f.friend_id = ? AND f.status = 'pending'
`);

function acceptedFriendIds(userId) {
  return stmtAcceptedIds.all(userId).map((r) => r.friend_id);
}

function requestFriend(userId, friendId) {
  if (userId === friendId) return { ok: false, error: 'You are already yourself.' };
  const existing = stmtFriendship.get(userId, friendId);
  if (existing && existing.status === 'accepted') {
    return { ok: false, error: 'Already friends.' };
  }
  // If they already asked you, accept instead of creating a duplicate request.
  const inbound = stmtFriendship.get(friendId, userId);
  if (inbound && inbound.status === 'pending') {
    acceptFriend(userId, friendId);
    return { ok: true, accepted: true };
  }
  stmtUpsertFriendship.run(userId, friendId, 'pending');
  return { ok: true, accepted: false };
}

function acceptFriend(userId, requesterId) {
  // Friendship is stored as two accepted rows so lookups stay one-directional.
  stmtUpsertFriendship.run(requesterId, userId, 'accepted');
  stmtUpsertFriendship.run(userId, requesterId, 'accepted');
  return { ok: true };
}

function friendList(userId) {
  const ids = acceptedFriendIds(userId);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, username, color, total_score FROM users WHERE id IN (${placeholders})
       ORDER BY total_score DESC`
    )
    .all(...ids);
}

function incomingRequests(userId) {
  return stmtIncomingRequests.all(userId);
}

// ---------------------------------------------------------------------------
// Anti-cheat bookkeeping
// ---------------------------------------------------------------------------

const stmtBumpSuspicion = db.prepare(
  'UPDATE users SET suspicion = suspicion + ? WHERE id = ?'
);

function bumpSuspicion(userId, amount = 1) {
  stmtBumpSuspicion.run(amount, userId);
}

module.exports = {
  db,
  PLAYER_COLORS,
  createUser,
  userByToken,
  userByName,
  claimsInChunk,
  isClaimed,
  cellsKey,
  wordClaimCount,
  recordClaim,
  globalLeaderboard,
  friendsLeaderboard,
  recentClaims,
  requestFriend,
  acceptFriend,
  friendList,
  incomingRequests,
  acceptedFriendIds,
  bumpSuspicion,
};
