'use strict';

// End-to-end check against a running server. Exercises the real socket
// protocol, not internal functions, so it catches wiring mistakes.

const WebSocket = require('ws');
const chunks = require('../server/chunks');

const BASE = process.env.BASE || 'http://localhost:3000';
const WS_URL = BASE.replace('http', 'ws') + '/ws';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  pass  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

async function signin(username) {
  const res = await fetch(`${BASE}/api/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  return res.json();
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const inbox = [];
    const waiters = [];

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const idx = waiters.findIndex((w) => w.type === msg.t);
      if (idx >= 0) {
        const [waiter] = waiters.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        inbox.push(msg);
      }
    });

    socket.on('error', reject);

    const client = {
      socket,
      send: (obj) => socket.send(JSON.stringify(obj)),
      wait(type, ms = 3000) {
        const idx = inbox.findIndex((m) => m.t === type);
        if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error(`timeout waiting for "${type}"`)),
            ms
          );
          waiters.push({ type, resolve: res, timer });
        });
      },
      close: () => socket.close(),
    };

    socket.on('open', () => resolve(client));
  });
}

// Pick a planted word from a chunk nobody has touched yet, and return its
// absolute world cells.
function plantedWordIn(cx, cy, index = 0) {
  const chunk = chunks.getChunk(cx, cy);
  const entry = chunk.planted[index];
  const N = chunks.CHUNK_SIZE;
  return {
    word: entry.word,
    cells: entry.cells.map(([x, y]) => [cx * N + x, cy * N + y]),
  };
}

async function main() {
  // Use a far-off region so repeated test runs don't collide with each other.
  const region = Math.floor(Math.random() * 1e6) + 5000;

  console.log('\nauth');
  const alice = await signin('alice_test');
  const bob = await signin('bob_test');
  check('alice signs in and gets a token', typeof alice.token === 'string');
  check('bob signs in and gets a token', typeof bob.token === 'string');

  const again = await signin('alice_test');
  check('signing in twice reuses the same account', again.user.id === alice.user.id);

  const badName = await fetch(`${BASE}/api/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'no spaces!' }),
  });
  check('invalid usernames are rejected', badName.status === 400);

  const noAuth = await fetch(`${BASE}/api/leaderboard`);
  check('endpoints require a token', noAuth.status === 401);

  console.log('\nsockets and chunk delivery');
  const ac = await connect(alice.token);
  const bc = await connect(bob.token);
  ac.send({ t: 'auth', token: alice.token });
  bc.send({ t: 'auth', token: bob.token });
  const welcome = await ac.wait('welcome');
  await bc.wait('welcome');
  check('welcome carries chunk size', welcome.chunkSize === chunks.CHUNK_SIZE);
  check('welcome carries min word length', welcome.minWordLength === require('../server/dictionary').MIN_WORD_LEN);

  ac.send({ t: 'sub', chunks: [[region, 0]] });
  bc.send({ t: 'sub', chunks: [[region, 0]] });
  const chunkMsg = await ac.wait('chunk');
  await bc.wait('chunk');
  check(
    'chunk has the right number of letters',
    chunkMsg.letters.length === chunks.CHUNK_SIZE ** 2,
    `got ${chunkMsg.letters.length}`
  );
  check(
    'chunk does NOT leak planted word locations',
    chunkMsg.planted === undefined && !('planted' in chunkMsg)
  );
  check(
    'chunk letters match server generation',
    chunkMsg.letters === chunks.getChunk(region, 0).letters
  );

  console.log('\nclaiming a word');
  const target = plantedWordIn(region, 0, 0);
  ac.send({ t: 'claim', cells: target.cells });
  const accepted = await ac.wait('claim_accepted');
  check('claim is accepted', accepted.word === target.word, `got ${accepted.word}`);
  check('claim awards a positive score', accepted.score > 0);
  check('running total is returned', accepted.totalScore >= accepted.score);

  console.log('\nreal-time broadcast');
  const broadcast = await bc.wait('claimed');
  check('bob is told about alice\'s find', broadcast.word === target.word);
  check('broadcast attributes the finder', broadcast.by === 'alice_test');
  check('broadcast includes a colour for highlighting', typeof broadcast.color === 'string');

  console.log('\nreverse drags are accepted');
  // A player who drags right-to-left must still get credit.
  const reverseTarget = plantedWordIn(region, 0, 1);
  const reversedCells = reverseTarget.cells.slice().reverse();
  ac.send({ t: 'claim', cells: reversedCells });
  const reverseAccepted = await ac.wait('claim_accepted');
  check('a backwards drag scores the word',
    reverseAccepted.word === reverseTarget.word,
    `got ${reverseAccepted.word}, wanted ${reverseTarget.word}`);
  await bc.wait('claimed');

  console.log('\nanti-cheat');
  bc.send({ t: 'claim', cells: target.cells });
  const dupe = await bc.wait('claim_rejected');
  check('the same placement cannot be claimed twice', /already/i.test(dupe.error));

  // Non-contiguous cells
  bc.send({ t: 'claim', cells: [[region * 24, 0], [region * 24 + 5, 0], [region * 24 + 9, 0]] });
  const gappy = await bc.wait('claim_rejected');
  check('non-adjacent cells are rejected', /adjacent|straight|least/i.test(gappy.error));

  // Bent line
  bc.send({
    t: 'claim',
    cells: [[region * 24, 5], [region * 24 + 1, 5], [region * 24 + 2, 5], [region * 24 + 2, 6], [region * 24 + 2, 7]],
  });
  const bent = await bc.wait('claim_rejected');
  check('bent lines are rejected', /straight/i.test(bent.error));

  // Too short
  bc.send({ t: 'claim', cells: [[region * 24, 8], [region * 24 + 1, 8], [region * 24 + 2, 8]] });
  const short = await bc.wait('claim_rejected');
  check('words under the minimum length are rejected', /least/i.test(short.error));

  // Non-integer coords
  bc.send({ t: 'claim', cells: [[0.5, 1], [1.5, 1], [2.5, 1], [3.5, 1], [4.5, 1]] });
  const frac = await bc.wait('claim_rejected');
  check('fractional coordinates are rejected', /malformed/i.test(frac.error));

  // A straight run of real letters that isn't a word.
  // Walk the grid until we find a 5-cell run that is not in the dictionary.
  const dictionary = require('../server/dictionary');
  let gibberish = null;
  for (let y = 0; y < 24 && !gibberish; y++) {
    for (let x = 0; x < 20; x++) {
      const cells = [0, 1, 2, 3, 4].map((i) => [region * 24 + x + i, y]);
      if (!dictionary.isValidWord(chunks.readWord(cells))) {
        gibberish = cells;
        break;
      }
    }
  }
  bc.send({ t: 'claim', cells: gibberish });
  const notWord = await bc.wait('claim_rejected');
  check('non-dictionary letter runs are rejected', /dictionary/i.test(notWord.error));

  console.log('\nrate limiting');
  // Fire a burst of distinct invalid-but-well-formed claims.
  for (let i = 0; i < 25; i++) {
    bc.send({ t: 'claim', cells: [0, 1, 2, 3, 4].map((k) => [region * 24 + k, 12 + i]) });
  }
  let sawRateLimit = false;
  for (let i = 0; i < 25; i++) {
    const msg = await bc.wait('claim_rejected');
    if (/slow down/i.test(msg.error)) {
      sawRateLimit = true;
      break;
    }
  }
  check('a burst of claims trips the rate limiter', sawRateLimit);

  console.log('\ndiminishing returns');
  const { repeatMultiplier } = require('../server/validate');
  check('first claim of a word is full value', repeatMultiplier(0) === 1);
  check('repeat claims are worth less', repeatMultiplier(20) < 0.6);
  check('repeat value has a floor', repeatMultiplier(100000) >= 0.25);

  console.log('\nleaderboards');
  const board = await fetch(`${BASE}/api/leaderboard`, {
    headers: { authorization: `Bearer ${alice.token}` },
  }).then((r) => r.json());
  check('global leaderboard returns ranked rows', board.rows[0].rank === 1);
  check('leaderboard marks you', board.rows.some((r) => r.isYou));

  console.log('\nfriends');
  await fetch(`${BASE}/api/friends/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ username: 'bob_test' }),
  });
  const bobFriends = await fetch(`${BASE}/api/friends`, {
    headers: { authorization: `Bearer ${bob.token}` },
  }).then((r) => r.json());
  const hasRequest = bobFriends.requests.some((r) => r.username === 'alice_test');
  check('friend request shows up for the recipient', hasRequest);

  if (hasRequest) {
    const requester = bobFriends.requests.find((r) => r.username === 'alice_test');
    await fetch(`${BASE}/api/friends/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ userId: requester.id }),
    });
    const aliceFriends = await fetch(`${BASE}/api/friends`, {
      headers: { authorization: `Bearer ${alice.token}` },
    }).then((r) => r.json());
    check('friendship is mutual after accept', aliceFriends.friends.some((f) => f.username === 'bob_test'));

    const friendBoard = await fetch(`${BASE}/api/leaderboard?scope=friends`, {
      headers: { authorization: `Bearer ${alice.token}` },
    }).then((r) => r.json());
    const names = friendBoard.rows.map((r) => r.username);
    check('friends board contains you and your friend',
      names.includes('alice_test') && names.includes('bob_test'));
  }

  const noSuch = await fetch(`${BASE}/api/friends/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ username: 'ghost_who_does_not_exist' }),
  });
  check('befriending a missing player 404s', noSuch.status === 404);

  console.log('\nhints');
  const hint = await fetch(`${BASE}/api/hint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ cx: region, cy: 1 }),
  }).then((r) => r.json());
  check('hint returns a location', Array.isArray(hint.hint?.start));
  check('hint gives length and direction but not the word',
    typeof hint.hint?.length === 'number' && hint.hint?.word === undefined);

  console.log('\ncross-chunk words');
  // A word straddling a boundary must still validate, since letterAt() reads
  // any world coordinate.
  const boundaryX = region * 24 + 22;
  const cells = [0, 1, 2, 3, 4].map((i) => [boundaryX + i, 3]);
  const spans = new Set(cells.map(([x]) => chunks.chunkCoordsFor(x, 3).cx));
  check('test selection really does span two chunks', spans.size === 2);
  check('letters read consistently across the boundary',
    chunks.readWord(cells).length === 5 && /^[a-z]{5}$/.test(chunks.readWord(cells)));

  ac.close();
  bc.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\ntest harness error:', err.message);
  process.exit(1);
});
