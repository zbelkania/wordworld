# WordWorld

An endless, shared word search. Players scroll a grid that extends infinitely
in every direction, claim words by dragging across letters, and compete on a
global or friends-only leaderboard. Finds appear in real time in the finder's
colour.

## Running it

Requires Node 22.5 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
WORLD_SEED=any-long-random-string npm start
```

Open http://localhost:3000, pick a name, and drag across letters.

```bash
npm test          # both suites; server must be running for the e2e one
npm run test:geometry   # pure logic, no server needed
```

## How the infinite grid works

Nothing about the grid is stored. The world is divided into 24×24 chunks, and
each chunk's letters are generated from a hash of `(WORLD_SEED, chunkX, chunkY)`
fed through a seeded PRNG. Same inputs, same chunk, forever — so a chunk can
be regenerated on demand instead of persisted, and the world costs nothing to
"own". Only claimed words go in the database.

Two details matter more than they look:

**Words have to be planted.** Purely random letters almost never contain real
words. Each chunk deliberately places 16 recognisable words at pseudorandom
positions and orientations, overlapping only where letters already agree, then
fills the remainder with English-frequency-weighted letters. Filler words that
appear by accident still count, since validation runs against the full
dictionary.

**The seed is secret.** Generation happens server-side only. If the client
could derive chunk contents from a known seed, it could compute exactly where
every planted word sits. Clients receive letters and nothing else — the
`planted` array never leaves the server, and there's a test asserting that.

Words are planted entirely inside a single chunk so that any chunk can be
generated independently, in any order, without consulting its neighbours.
Players can still claim words that straddle a boundary: `letterAt(x, y)` reads
any world coordinate, so accidental cross-chunk words validate normally.

## Balance

These numbers came from actually running a solver over generated chunks.
Current settings: minimum word length 4, 28 planted words per chunk.

| Minimum word length | Findable words per 24×24 chunk (at 28 planted) |
| --- | --- |
| 4 | ~286 |
| 5 | ~75 |
| 6 | ~27 |

At a 4-letter minimum, the large majority of findable words in any chunk are
incidental — four random letters lining up — rather than deliberately planted.
That's a deliberate trade for this build: lower minimum and higher planted
density both push toward "words are easy to find", at the cost of a lot of the
finds being short and low-scoring. If it starts feeling too easy or too noisy,
two independent dials are available in `server/`:

- `MIN_WORD_LEN` in `dictionary.js` — raising it to 5 or 6 cuts out the
  short-word noise (see the table above).
- `WORDS_PER_CHUNK` in `chunks.js` — currently 28; lower it for sparser,
  harder-won planted words.

The whole table above is reproducible by running the solver pattern in
`test/` against new settings — grep for `solveByLen` in the test history, or
ask for it to be regenerated.

Scoring is Scrabble letter values times a length bonus:

```
score = sum(letterValues) × (1 + 0.15 × (length − 4))
```

So `TREES` scores 6 and `QUARTZ` scores 31. Two guards keep it honest:

- **One claim per placement.** The cell list is stored in a canonical form, so
  the same run can't be claimed twice — including by dragging it backwards.
- **Diminishing returns per word.** Each subsequent claim of the same word
  anywhere in the world is worth less, down to a floor of 25%. Without this,
  the optimal strategy is to hunt the same handful of easy words across
  thousands of chunks forever.

A run that reads as a word in either direction is a single claim, not two, so
`STRAW`/`WARTS` on the same cells can only be taken once. That avoids two
highlight capsules stacked on the same letters.

**Overlapping words on different cell sets are independent claims.** A prefix
or suffix relationship — `CAR` and `CARS`, `COME` and `COMET` — occupies two
different (though overlapping) cell lists, so both can be claimed separately,
by the same or different players. On the client, `state.claimsByCell` maps
each cell to an array of every claim covering it (not a single record), so
hovering a shared letter shows every word and finder for that cell rather than
only the most recently claimed one.

## Architecture

```
Browser (canvas)  ──  WebSocket  ──  Node server  ──  SQLite
     │                                    │
  chunk cache                      chunk generator
  selection                        claim validation
```

`server/`

| File | Job |
| --- | --- |
| `rng.js` | Deterministic hashing and PRNG |
| `dictionary.js` | Word lists, planting pool, scoring |
| `chunks.js` | Chunk generation, planting, `letterAt`, hints |
| `validate.js` | Claim validation, rate limiting, repeat decay |
| `db.js` | Users, friends, claims, leaderboards |
| `index.js` | REST endpoints and the WebSocket layer |

**Chunks are rooms.** A player subscribes to the chunks in their viewport and
receives claims only for those. Since players naturally spread across the
world, broadcast fan-out stays small no matter how many are online.

## Anti-cheat

A public leaderboard plus money is a magnet for cheaters, and this genre is
unusually exposed: the client necessarily receives the letters, so anyone can
run a solver over them. What's implemented:

- **Nothing from the client is trusted.** Every claim is re-derived from the
  world seed. The server re-reads the letters, re-checks the dictionary, and
  re-computes the score. The client's score display is cosmetic.
- **Geometry is verified** — contiguous, straight, one of eight directions,
  integer coordinates, within length bounds.
- **Rate limiting** via a token bucket (10 burst, ~0.9/sec sustained). Humans
  don't submit dozens of words per second; solvers do.
- **A suspicion counter** on `users`, incremented on rate-limit trips, ready
  for you to act on.

What's left for you: watch score velocity and bucket suspected bots onto a
separate leaderboard. You will not eliminate solver bots entirely — that's an
accepted reality here. Aim for a credible main leaderboard, not a perfect one.

## Wiring up ads

The hint feature is the rewarded-ad hook, because "watch an ad to reveal where
a word starts" is a natural fit and rewarded video earns far more per view
than banners.

Right now `POST /api/hint` grants a hint to anyone who asks. **Before you
monetise, gate it on a verified ad completion**, or players will just call the
endpoint directly and skip the ad. The exact spot is marked `TODO(ads)` in
`server/index.js`:

```js
const ok = await verifyRewardedAd(req.body.adToken, req.user.id);
if (!ok) return res.status(402).json({ error: 'Ad not completed.' });
```

Every major network (AdSense/AdMob, Unity Ads, ironSource) gives you a
server-side callback or signed completion token for exactly this. Verify it
server-side — never trust a client-side "the ad finished" flag.

The banner slot is `#ad-slot` in `public/index.html`, deliberately in the side
rail rather than over the grid. Ads that cover gameplay wreck retention, and
retention is what actually earns.

On expectations: display ads run roughly $0.50–3 RPM, rewarded video roughly
$5–20 per thousand completed views. A few thousand daily players watching one
rewarded ad each lands in the low hundreds of dollars a month — comfortably
above hosting, well short of a living. Distribution matters more than any
monetisation tweak: getting onto CrazyGames, Poki, or itch.io will move revenue
far more than tuning ad placement.

Keep IAP cosmetic. Anything that lets money buy leaderboard position destroys
the competitive integrity that makes the leaderboard worth caring about.

## Moving to Postgres

SQLite is here for zero-setup local development, and the schema was written to
port cleanly. When write contention becomes the bottleneck:

1. `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`.
2. `datetime('now')` → `now()`; `TEXT` timestamps → `TIMESTAMPTZ`.
3. `cells TEXT` holding JSON → `JSONB`, or keep the canonical string key.
4. Replace the `db.prepare(...)` calls in `server/db.js` with `pg` queries.
   Everything is already funnelled through that one module, so no other file
   changes.
5. Replace `recordClaim`'s `BEGIN`/`COMMIT` with a transaction from the pool.

For leaderboards, move to Redis sorted sets: `ZINCRBY` on each claim,
`ZREVRANGE` for the global board, and `ZMSCORE` over a friend's id list for the
friends board. `friendsLeaderboard` in `db.js` already resolves the friend id
set first, exactly so this swap is mechanical.

For multiple server processes, publish the `broadcastClaim` payload to Redis
pub/sub and have each instance relay to its own local subscribers. That
function is isolated for this reason.

## Before you launch

- [ ] Set a real `WORLD_SEED` and never change it. Changing it regenerates the
      world and orphans every claimed word.
- [ ] Replace the username-only sign-in with real auth. It currently issues a
      token to anyone who claims a name, so names can be taken by anybody.
      Nothing outside `POST /api/signin` depends on how tokens are issued.
- [ ] Gate `/api/hint` behind verified ad completion.
- [ ] Set an AWS billing alarm.
- [ ] Add HTTPS (`deploy/README.md` covers certbot).
- [ ] Decide your stance on solver bots before the leaderboard has real stakes.

## Known limitations

- **Sign-in is not real authentication.** Prototype only. See above.
- **The rate limiter is per-process and in-memory**, so it resets on restart
  and doesn't coordinate across instances. Move it to Redis when you scale out.
- **Claimed words show ownership by colour, not a permanent name tag.** A name
  flashes for a few seconds on a fresh find, and hovering shows word, finder,
  and score. Persistent tags on every word bury the grid once a region fills
  up — there are hundreds of claimable words per chunk at the current settings.
- **No zoom.** Fixed 34px cells. Adding zoom means rescaling the cell size and
  re-deriving the visible range; the renderer is structured for it but it isn't
  built.
- **Chunk letters are sent in the clear**, which is unavoidable — the player
  has to see them — and is why solver resistance relies on behaviour rather
  than secrecy.
# wordworld
