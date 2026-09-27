/* ------------------------------------------------------------------
   house/matchup.js - head-to-head series, over the real engine.

   WHAT THIS ANSWERS

   "If these two champions met, who actually wins?" - and it answers with
   the engine rather than with a guess. It is a research tool: nothing here
   is settled, nothing here is bet on, and no value produced by it reaches
   the chain or a match.

   WHY IT REUSES sim.run() RATHER THAN BATCHING

   house/sim.js loads a FRESH vm context for every fight, deliberately: the
   comment there says it "removes every possible carry-over between two
   matches that are supposed to be independent". Reusing one warm context
   across a series would make this the fastest file in the repo and would
   also make it the only place that runs a subtly different engine from the
   cabinet. So each fight here calls the same run() the settlement path
   calls, and pays for it. A fight is ~38ms; the default series of 41 is
   about a second and a half, which is the price of the answer being true.

   THE SEEDS ARE NOT HIDDEN

   They are generated from a fixed constant here, returned in the response,
   and shown on the page, so a series can be repeated exactly. A win rate
   whose sample nobody can inspect is a number, not evidence.

   DEAD HEAT IS NOT A TIE BREAKER

   A draw is counted as a draw. The engine can end a round with both
   fighters standing, and folding that into either column would be the same
   class of lie as inventing a transaction - see the header of
   js/blockchain.js for how this project feels about that.

   Load order: after house/sim.js. Requires nothing from the browser.
------------------------------------------------------------------- */

'use strict'

const sim = require('./sim.js')

/* The same common-random-numbers constant house-balance uses, so a matchup
   judged here and a fixture judged by the test suite are judged on the same
   sample of fights. */
const SEED_STRIDE = 2654435761

const MAX_SEEDS = 101
const DEFAULT_SEEDS = 41
const MAX_PROMPT = 280

const seedFor = (k) => (k * SEED_STRIDE) >>> 0

/* Frames to seconds. The simulation is a fixed-step 60Hz loop, so this is a
   conversion rather than an estimate. */
const FPS = 60

function norm(prompt) {
  return String(prompt == null ? '' : prompt).replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT)
}

function parseSeeds(raw) {
  const n = parseInt(raw, 10)
  if (!isFinite(n) || n <= 0) return DEFAULT_SEEDS
  return Math.min(MAX_SEEDS, Math.max(3, n))
}

/**
 * Run a series between two prompts.
 *
 * @param a  prompt for side A
 * @param b  prompt for side B
 * @param n  how many fights (3..101, default 41)
 * @returns a plain object, safe to JSON straight into a response
 */
function series(a, b, n) {
  const pa = norm(a)
  const pb = norm(b)
  if (!pa || !pb) return { ok: false, error: 'need both prompts' }

  const seeds = parseSeeds(n)
  const agentA = sim.parse(pa)
  const agentB = sim.parse(pb)

  /* Determinism first, and in public. If the harness ever stops agreeing
     with itself, every number below is meaningless - so it is checked
     before any of them are computed, and the answer says so. */
  const check = sim.verify(agentA, agentB, seedFor(0), null)

  const wins = { a: 0, b: 0, draws: 0 }
  const finishes = { KO: 0, DECISION: 0 }
  let framesTotal = 0
  let hpA = 0
  let hpB = 0
  const log = []

  for (let i = 0; i < seeds; i++) {
    const seed = seedFor(i)
    const r = sim.run(agentA, agentB, seed, null)
    if (r.winner === 'p1') wins.a++
    else if (r.winner === 'p2') wins.b++
    else wins.draws++
    finishes[r.how === 'KO' ? 'KO' : 'DECISION']++
    framesTotal += r.frames
    hpA += r.hpA
    hpB += r.hpB
    if (log.length < 12) {
      log.push({ seed, winner: r.winner, frames: r.frames, hpA: r.hpA, hpB: r.hpB, how: r.how })
    }
  }

  const avgFrames = framesTotal / seeds
  const round = (x, d) => Number(x.toFixed(d == null ? 2 : d))

  return {
    ok: true,
    seeds,
    /* Shown on the page so the sample can be repeated rather than trusted. */
    seedStride: SEED_STRIDE,
    determinism: { ok: !!check.ok, winner: check.result.winner, frames: check.result.frames },
    a: { prompt: pa, archetype: agentA.archetype, tagline: agentA.tagline, stats: agentA.stats },
    b: { prompt: pb, archetype: agentB.archetype, tagline: agentB.tagline, stats: agentB.stats },
    wins,
    /* The share of the series each side took, ignoring draws - 0 when the
       series was nothing but draws, which is the honest reading of it. */
    winRate: {
      a: round(wins.a / seeds, 4),
      b: round(wins.b / seeds, 4),
      draw: round(wins.draws / seeds, 4)
    },
    finishes,
    avgFrames: round(avgFrames, 1),
    avgSeconds: round(avgFrames / FPS, 2),
    avgHpLeft: { a: round(hpA / seeds, 1), b: round(hpB / seeds, 1) },
    log
  }
}

module.exports = { series, seedFor, DEFAULT_SEEDS, MAX_SEEDS }
