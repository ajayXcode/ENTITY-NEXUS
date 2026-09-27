<<<<<<< HEAD
# ENTITY NEXUS

**Cast a line of film dialogue. Watch it fight. Bet on someone else's.**

Pick a line out of the Dialogue Vault — twenty-five of them, from Hindi,
English, Tamil, Telugu and Korean cinema — and the game's own parser turns that
line into three numbers. Those numbers drive a deterministic 60 FPS fight, and
the crowd backs a side with real MON on Monad. No controllers: nobody touches a
key once the bell rings.

There is no typing and no prompt-writing. There is a vault, five cinemas, eight
archetypes, and one 25-second round that ends the same way on every machine,
forever.

Live on **Monad Testnet** (chain `10143`):

|  |  |
| --- | --- |
| `ArenaBattle` | [`0x0329D1A516e9F5f8a89B48C4AD0515884f0652a5`](https://testnet.monadexplorer.com/address/0x0329D1A516e9F5f8a89B48C4AD0515884f0652a5) |
| `FighterNFT` | [`0xD12205ea18E336F2a4995Cc0Ef6226efaC48639F`](https://testnet.monadexplorer.com/address/0xD12205ea18E336F2a4995Cc0Ef6226efaC48639F) |
| Arbiter | `0x1F9326384C92d29915fd4EDD22797C3E664Dc651` |
| Protocol fee | 5% of the total pool |

---

## Run it

```bash
npm install          # one dependency: ethers
npm start            # http://localhost:8080
npm test             # 10 suites, no dependencies
```

That is the whole setup. **No build step, no bundler, no framework** — the front
end is six HTML files and plain scripts, and one Node process serves them
alongside every API. Nothing has to compile before the site works, which is why
serving and playing cannot break.

| Page | What it is |
| --- | --- |
| `/` | The landing page. The hero, the roster, and five ways in. |
| `/dialogues.html` | **The Dialogue Vault.** 25 lines, 5 cinemas, with the archetype and stats each one actually builds. |
| `/champions.html` | The champion index. All seventeen, with the stats the game builds. |
| `/matchup.html` | The Matchup Lab. Any two fighters, a fixed series of seeded fights. |
| `/play.html` | The cabinet. Cast a line or field a champion, then watch them fight. |
| `/spectate.html` | The floor. Every live match, the pools, and the bet. |
| `/api/health` | Is this deployment actually wired up. Answers without touching the network. |
| `/api/matchup` | Head-to-head over the real engine. Settles nothing, opens no match. |

---

## Tech stack

Deliberately small. Every choice here is a choice not to add a moving part
between the player and the fight.

| Layer | What it is | Why |
| --- | --- | --- |
| Server | **Node >= 18**, zero web framework — `node:http`, `node:fs`, `node:vm` | The whole site plus the API is one process with one dependency. `server.js` is ~1,800 lines and there is nothing to boot. |
| Dependencies | **`ethers ^6.17`**, and nothing else | Only the chain paths need a library. Everything else is the platform. |
| Front end | **Plain HTML + CSS + ES5-era classic scripts** | No React, no Tailwind at runtime, no bundler. A page cannot fail to hydrate, because it never hydrates. |
| Simulation | **Custom 2D engine**, canvas 2D at a fixed 60 FPS | Written and tuned in this repo (`js/game.js`, `js/classes.js`, `js/ai-controller.js`). |
| Determinism | **`mulberry32`**, a 32-bit seeded PRNG | Every roll in a fight is seeded, so the fight is reproducible from public inputs. |
| Headless engine | **`node:vm`** | `house/sim.js` runs the browser engine *unmodified* on the server with the DOM stubbed out — not a reimplementation of it. |
| 3D view | **three.js** (vendored) + GLTF + UnrealBloom | An optional renderer for the same simulation. Toggling it cannot change a frame of the result. |
| Animation | **GSAP** (vendored) | HUD drains and screen transitions only. |
| Styling | **Hand-written CSS**, one file per surface | No utility-class runtime, no PostCSS, no build. |
| Contracts | **Solidity 0.8.24**, Hardhat, EVM target `cancun` | `ArenaBattle` + `FighterNFT`, deployed to Monad Testnet. |
| Settlement | **EIP-712 typed signatures** | The arbiter signs; anyone can relay. Settlement never needs the server to hold funds. |
| The NFT | **Fully on-chain SVG + base64 JSON** | The token renders its own card — no IPFS, no pinning service, no external URL that can rot. |
| Hosting | **Render** (single instance, `render.yaml` blueprint) | The rooms relay keeps state in one process's memory; two instances silently break it. |
| Tests | **Zero-dependency `node` scripts** (`tests/run.js`) | 10 suites, no jest/vitest/mocha install. |

**Two assets are generated, not hand-drawn**, by scripts that read the registry:

```bash
node scripts/make-champion-assets.js    # 34 SVGs: a crest + a weapon per champion
python scripts/make-battle-sprites.py   # the two champions that ship real sprites
```

---

## What makes it unusual

**1. The fight is a pure function.**
`(statsA, statsB, seed, playbooks)` → the same knockout on every machine,
forever. Every roll comes from a seeded `mulberry32`; `Math.random()` appears in
the engine exactly once, in the title-screen flourish. This is what makes betting
on it honest, and it is asserted rather than assumed —
`tests/fight-determinism.test.js` runs the engine in two independent JS contexts
and compares them frame by frame.

**2. Pressing a button *is* the input format.**
Casting a dialogue writes a string into a textarea and fires an `input` event —
the same event a typed prompt used to produce. Everything downstream (the
commit, the reveal, the room protocol, the market, the settlement, the mint) has
no idea a vault exists. `js/dialogues.js` and `js/dialogue-picker.js` can both be
deleted and the cabinet is exactly the game it was.

**3. The server runs the browser's engine.**
For a match it settles, the server must know the winner it signs — so
`house/sim.js` loads `js/classes.js`, `js/ai-controller.js` and `js/game.js`
**unmodified** in a `vm` with the browser stubbed out. Not a reimplementation:
two implementations would agree on ninety-nine fights and settle the hundredth
against what the spectator watched with their own money on it.

**4. Spectators re-derive the fight.**
The payload deliberately carries **no winner**. Every spectator's browser runs
the engine and reaches its own verdict, so a desync becomes visible instead of
being papered over.

**5. Every dialogue line was scored before it was accepted.**
The parser has a genuinely tricky rule: a negator two words back flips the next
term, so `"never careless"` scores as *careful* and a line that reads like a
threat can quietly parse as a coward. All 25 lines were tuned against the real
`parsePrompt()`, the set covers all eight archetypes, and no two lines produce
the same stat line.

**6. Nothing lies about the chain.**
`js/blockchain.js` is the single source of wallet state and `js/betting.js` reads
pools back from `ArenaBattle`. There is no simulated mint, no fabricated
transaction hash and no invented token id anywhere in the codebase. Without keys
it runs in clearly-labelled paper mode rather than pretending.

---

## The Dialogue Vault

`js/dialogues.js` is the vault: **25 lines, 5 cinemas, 8 archetypes.**

| Cinema | Lines | |
| --- | --- | --- |
| Hindi | 5 | Action, Drama, Thriller |
| English | 5 | Action, Thriller, Heist, Drama, Spy |
| Tamil | 5 | Action, Drama, Comedy |
| Telugu | 5 | Action, Drama, Thriller, Comedy |
| Korean | 5 | Action, Thriller, Crime, Drama, Comedy |

A line is a **string and nothing else** — exactly the string the textarea used to
hold — so nothing new crosses the wire and the engine never loads the file.

```js
{ id: 'tam-odi', language: 'tamil', genre: 'Comedy', film: 'Odipolama',
  speaker: 'Kumar', role: 'Runs first, thinks later', hue: 275,
  accent: '#a855f7',
  line: 'Run away, hide, dodge everything and avoid all damage' }
```

The lines are **original writing in the idiom of each cinema, not quotations** —
famous dialogue belongs to the people who wrote it, and a vault of it is a
liability rather than a feature. The languages, genres and scene shapes are the
real thing; the words are ours.

**Every line is a fighter.** `hue` and `accent` are render-only: they give each
line a distinct body colour and aura through exactly the same path a champion
uses (`Characters.tint()` / `Characters.aura()`, read in one place —
`Fighter.render()`). A dialogue carries no crest and no weapon glyph, because it
is a line rather than a designed fighter, and `js/ui.js` skips the asset lookup
so nothing requests a file that was never printed.

**Recognition is by text.** `Dialogues.byPrompt()` matches a line the same way
`Characters.byPrompt()` matches a champion — on the string that already travels —
so a dialogue's identity survives a local match, an online room, a rematch and a
spectator's replay without a single field being added to the protocol.

**Where you meet it**

- the **vault button** and a **language tab strip + 4-line shortlist** under each
  fighter's box in the cabinet,
- the **full-screen overlay** (`js/dialogue-picker.js`) with all 25 cards,
- the **vault page** (`/dialogues.html`), filterable by cinema and genre, with
  every card showing the archetype and stat bars you will actually get,
- and **`ANY LINE`**, which rolls over the real vault so it can never land on a
  line the cabinet does not have.

If the 60-second clock runs out with nothing cast, `draftDialogue()` picks a real
line rather than fighting an empty box.

---

### Champions

`js/characters.js` is the registry — seventeen champions, each with species,
style, weapons, role, traits and a colour palette. A champion is the second way
in: a fixed combat identity the cabinet will build for you.

**The asset pack.** `scripts/make-champion-assets.js` prints a crest and a weapon
glyph per champion out of the one reference sheet — 34 SVGs into
`assets/champions/` — reading the registry itself, so an asset can never describe
a champion the game does not have. Regenerate with
`node scripts/make-champion-assets.js`; a weapon with no glyph is a build error,
not a silent fallback.

A champion does **not** carry hardcoded stats either. It carries a `prompt` and
its archetype and ATK/DEF/SPD are produced by the game's own `parsePrompt()`. The
card on the landing page, the card on the index and the card in the picker
therefore cannot disagree with the fight they start.

The picker (`js/champions.js`) only writes text into the existing box and fires
`input`, exactly like a dialogue does.

**Battle art.** Most champions borrow one of the engine's two sheets, so they
carry a `hue` and an `accent`, and `js/ui.js` sets `tint` and `crest` on the
fighter. Two do not borrow anything:

```text
Character 1/frames          the sai turtle, red bandana   RAPHAEL, side 1
Character 1/frames_clone    the same turtle, blue          RAPHAEL, side 2
Character 2/frames_rival    the violet glaive knight       MALGRAVE, both sides
```

`scripts/make-battle-sprites.py` (Python + Pillow — an asset tool, not part of
serving the site) re-lays those eight poses each onto the **engine's own frame
geometry**: a 200×200 frame, feet on the same line, body centre on the same
column, emitted at 2× resolution. The result is drop-in: the `offset` a Fighter
already had still applies and only the draw scale changes. That is asserted
against the real files in `tests/champion-points.test.js` rather than looked at.

If the art has not decoded when the bell goes, the draw falls back to the sheet
it replaces: a fighter is never invisible because an image is in flight.

### Points

Every decided round pays **both** fighters, from the round's own counters — the
same hits, blocks and health the post-fight summary prints. A loss is a result,
and a scoreboard that only moves when you win is a scoreboard for whoever is
ahead.

```text
fought to the bell   10   both fighters, every decided round
won the round        25   winner
health remaining   0–10   winner
hits landed        0–10   both
hits blocked        0–5   both
```

`Characters.points` books it and remembers the running total per fighter
(a champion by id, a dialogue by `dlg-<id>`); `UI.pointsHTML()` prints the
receipt on the winner screen with the itemised breakdown on each row's tooltip.

It is **local to the browser and read by nothing else**. The simulation does not
load the file it lives in (`house/sim.js`'s script list stops at `game.js`), the
pool and the settlement take their numbers from `Arena.resultFrom()`, and the
award is booked after the round is already over. `tests/champion-points.test.js`
asserts each of those.

The record and the points are two ledgers under two keys — a fighter can be
3W–1L and still be behind on points.

### The wallet

`js/wallet.js` is one control, used by the landing page, the vault, the champion
index, the Matchup Lab and the cabinet's title screen. Closed, it is a status dot
and either `Connect wallet` or the shortened address; open, it shows the full
address, the network and the MON balance, and offers copy, refresh, a switch to
Monad Testnet when the wallet is elsewhere, and disconnect. Every read is
read-only and none of it signs anything.

It is also **not a precondition for anything**. Connecting changes no fight, no
analysis and no settlement, and with no `window.ethereum` at all the pages render
and play exactly as before — the chip says `No wallet found` instead of
pretending.

Without a `.env` it still runs: the stat engine falls back to the local lexicon
and the markets run on paper, clearly labelled.

### The Matchup Lab

`/matchup.html` answers "if these two met, who wins?" with the engine rather than
with an opinion. Pick two fighters, choose 11 / 41 / 101 fights, and
`/api/matchup` runs `house/sim.js` — the same headless harness the settlement
path trusts — returning a win split, KO and decision counts, average length,
average health left, the per-seed log and a determinism verdict.

It settles nothing, opens no match, touches no market and asks for no wallet.
Seeds come from one published constant (`2654435761`), so a series can be re-run
rather than taken on faith, and **a draw is counted as a draw**.

### Environment

```bash
GEMINI_API_KEY_1=...        # the stat engine. _2.._8 optional, for headroom
ARBITER_PRIVATE_KEY=0x...   # 64 hex chars. Signs settlements, sends the
                            # arbiter-only calls. NOT the owner key.
MONAD_RPC=https://testnet-rpc.monad.xyz   # optional, this is the default
HOUSE_CHAIN_TABLES=2        # house tables that settle on chain (0 = spend nothing)
HOUSE_FLOOR=on              # the house floor itself
```

The arbiter address must equal what `ArenaBattle` holds as `arbiter`, or every
settlement is rejected. Check with `node scripts/set-arbiter.js`.

---

## Deploy

### Render

`render.yaml` is a blueprint: **New → Blueprint → point at this repo** and there
is nothing to fill in but the keys.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/shivamprajapati17/ENTITY-NEXUS)

```text
runtime         node          one long-lived process, not functions
plan            free
buildCommand    npm install
startCommand    node server.js
healthCheckPath /api/health
```

**Exactly one instance, and that is the one rule that matters.** The rooms relay
keeps its state in the process's memory — a `Map` of room code to subscribers.
Two instances means player 1 lands on instance A, player 2 on B, and they never
see each other: no error, no crash, just a host sitting in a lobby and a guest
being told `NO SUCH ROOM`. Serverless hosts (Vercel, Netlify Functions,
Cloudflare Workers) cannot work for the same reason — each request gets its own
memory and the relay cannot exist.

### GitHub

```bash
git clone https://github.com/shivamprajapati17/ENTITY-NEXUS.git
cd ENTITY-NEXUS
npm install && npm start
```

---

## How a match works

```text
line ──▶ stats ──▶ agent snapshot on chain ──▶ market ──▶ seed ──▶ fight ──▶ settle ──▶ claim
```

1. **Line → stats.** Gemini reads intent, not keywords: *"I'd rather run than
   trade hits"* is low aggression and high speed without the word "fast". The
   three stats share a **budget** (1.30–1.95 total), so every line gives
   something up. The lexicon in `js/prompt-parser.js` is the offline fallback,
   and it is the path every vault line is built through.
2. **Both lines go on chain**, hashed, before any money moves. You are betting on
   a specific line, model, model version, advisor config and simulation version —
   change any one and it is a different fighter.
3. **The market opens.** The arbiter commits to a seed *here*, while no pool
   exists to grind it against.
4. **The crowd backs a side.** The fight does not start until **someone has
   backed each fighter** — a pari-mutuel with one side empty pays nobody.
5. **The contract makes the seed** from the committed preimage, the close
   blockhash and the final pools. Nobody controls all three.
6. **The fight runs** — deterministically, from that seed. Every screen computes
   the same result independently.
7. **Settle and claim.** Payouts are pull-based: `claim()` covers winnings,
   refunds and voided markets in one call.

### The money

```text
total         = poolA + poolB
fee           = total × 5%
distributable = total − fee
payout(i)     = distributable × stake(i) / winningPool
```

A straight pari-mutuel: there are no player stakes, so the betting pool is the
only money in a match.

**The fee comes off the total, which includes your own stake — so backing the
winner does not guarantee your stake back.** When the losing pool is smaller than
about 5.26% of the winning pool, there is less to share than the winners put in:

| your stake | winning pool | losing pool | payout |
|  ---  |  ---  |  ---  |  ---  |
| 50 | 50 | 0 | 48 |
| 50 | 50 | 2 | 50 |
| 50 | 50 | 50 | 95 |
| 10 | 10 | 90 | 95 |

Two cases pay nothing and charge nothing — a draw, or nobody backing the winner
— and both void the market and refund everyone in full.

---

## API

All 19 routes, served by the same process as the static files.

| Route | Method | What it does |
| --- | --- | --- |
| `/api/health` | GET | Relay up, keys found, house floor state. No network. |
| `/api/ready` | GET | A named check per dependency, for a deploy gate. |
| `/api/analyze` | POST | Line → stats, via Gemini. Falls back to the lexicon. |
| `/api/jev/decide` | POST | The tactical advisor's playbook for one side. |
| `/api/matchup` | GET | A head-to-head series over the real engine. |
| `/api/match/list` | GET | The public board: every live room and house table. |
| `/api/match/get` | GET | One match by room code. |
| `/api/match/announce` · `/api/match/close` | POST | A room telling the board it is open / done. |
| `/api/arena/seed-commit` · `/lock-open` · `/start` · `/seed-reveal` · `/settle` | POST | The arbiter's half of a match lifecycle. |
| `/api/house/fight` | GET | The engine's own result for a house table. |
| `/api/room/chain-open` · `/report` · `/sub` · `/send` | POST | The rooms relay: subscribe, relay, report, open a market. |

---

## Tests

```bash
npm test             # 10 suites, no dependencies
```

The ones worth knowing about:

- **fight-determinism** — two contexts, same seed, identical frame by frame. If
  this fails, betting is broken however well the networking works.
- **house-market** — no fight starts without a backer on each side; a market that
  lapses refunds whoever did bet. Run against a fake chain, because every branch
  costs gas on the real one.
- **house-balance** — no house pair is a foregone conclusion. The first draft had
  one at 93/7; all seven now sit inside 47–58%.
- **matchup-lab** — the Lab runs the real harness rather than a second copy of it
  (its first logged fight is compared against a direct `sim.run()`), gives the
  same series twice, and opens no match while doing it.
- **champion-points** — the scoreboard pays the loser as well as the winner, and
  the two champions that ship their own battle art land on the exact rectangle
  the sheet they replace would have landed on.
- **spectate-page** — the page's real script list, executed in order. Catches the
  global collisions that take a whole page down at parse time.
- **rooms-protocol / rooms-rounds / rooms-relay** — host/join, commit-reveal
  ordering, tampering, presence, rematches, and the same protocol across a real
  `server.js` process with no `BroadcastChannel` available, so the relay is the
  only transport under test.

---

## Layout

```text
server.js            one process: static files, stat engine, JEV cache,
                     rooms relay, match board, arbiter API
arbiter.js           EIP-712 settlement signer + the seed commitment
house/               matches this server runs
  market.js            one match, open → backers → seed → settle
  sim.js               the browser engine, headless
  director.js          the house floor
  rooms-chain.js       markets for rooms two humans opened
  fixtures.js          16 prompts, balance-tuned
  matchup.js           head-to-head series, over house/sim.js
js/                  the front end (no build step)
  dialogues.js         the vault: 25 lines, the card renderer, byPrompt()
  dialogue-picker.js   the cabinet's vault overlay
  prompt-parser.js     a line → stats, offline
  game.js classes.js ai-controller.js   the deterministic engine
  jev.js               the tactical advisor
  characters.js        the champion registry (17), the card renderer, the
                       local scoreboard and the points ledger
  champions.js         the cabinet's optional champion picker
  wallet.js            the wallet chip, every page
  spectate.js spectate-fight.js  the floor, and the fight on it
  matchup.js           the Matchup Lab page
contracts/           ArenaBattle + FighterNFT (Hardhat, Solidity 0.8.24)
assets/champions/    34 generated SVGs — a crest and a weapon per champion
assets/img/champ/    the two champions that ship real battle sprites: eight
                     frames per side, plus a card portrait, per champion
entity-nexus.css dialogues.css wallet.css champions.css matchup.css
                     the theme. Plain CSS, no Tailwind runtime, no bundler.
```

---

## What this does not claim

- **The arbiter can stall a match, not steal from one.** It has no withdrawal
  path and cannot change an agent or a result the contract will accept. If it
  goes silent, `voidMatch()` is permissionless after a timeout and everyone is
  refunded. A malicious arbiter costs you time, never your money.
- **The arbiter picks the seed preimage.** It commits before any pool exists, and
  the contract mixes in a blockhash that did not exist at commit time. To bias a
  match it would have to predict a future block.
- **A house match has one reporter.** A human match settles only when both
  browsers independently agree. The house has no players, so the server reports —
  which is why every house match says so on the board.
- **The fight is not verified on chain.** A 60 FPS simulation is not going to be.
  It is deterministic, reproducible from public inputs, and hashed into the
  settlement — which is the honest version of the trade.
- **The dialogue lines are not quotations.** They are original writing in the
  idiom of each cinema. The one upstream name that remains in the repo is the
  Mixamo model credit in `assets/models/CREDITS.md`, which is a licence, and is
  left alone on purpose.

Built for Monad Testnet.
=======
# ENTITY-NEXUS
>>>>>>> ab83ee4da908dd7c44797e7c5bf8b810a8e6d3df
