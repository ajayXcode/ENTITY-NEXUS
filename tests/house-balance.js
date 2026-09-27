/* ------------------------------------------------------------------
   tests/house-balance.js - the house floor is still a market.

   Two things are asserted here, and both of them are about honesty rather
   than about the fixtures being nice.

   1. THE ENGINE IS DETERMINISTIC IN THIS PROCESS.

      The whole settlement story for a house match rests on it: the server
      runs the fight headlessly, signs the winner, and the spectator's
      browser runs the same fight and must reach the same end. If a stub in
      house/sim.js ever starts feeding a value back into the simulation, or
      something inside stepFight() reaches for Math.random() or Date.now(),
      the server would be settling a result nobody watched. Running each
      fight twice and demanding an identical frame count and identical
      health catches exactly that.

   2. NO PAIR IS A FOREGONE CONCLUSION.

      A match whose winner is known before betting opens is not a market,
      it is a tax on whoever reads slowest. The first draft of these pairs
      had one sitting at 93/7. The band below is deliberately wide - a
      35-65 split still has a favourite, which is what odds are for - but
      it fails loudly on a blowout.

      This runs against the deterministic lexicon, not Gemini: the lexicon
      is the fallback that must hold up with no network and no key, and it
      is the only one of the two that can be asserted at all.

   Run: node tests/house-balance.js  (or npm test, which includes it)
------------------------------------------------------------------- */

const sim = require('../house/sim.js')
const { PAIRS } = require('../house/fixtures.js')

/* Enough seeds to separate a blowout from a coin flip, few enough to stay a
   test rather than an errand. At ~16ms a fight this is a few seconds. */
const SEEDS = 60
const LOW = 35
const HIGH = 65

/* Well-distributed but identical across pairs, so every matchup is judged
   on the same sample of fights - the common-random-numbers trick runBench
   already uses in js/game.js. */
const seedFor = (k) => (k * 2654435761) >>> 0

let failures = 0
const fail = (msg) => { console.error('  FAIL  ' + msg); failures++ }

console.log('house floor: ' + PAIRS.length + ' pairs, ' +
  (PAIRS.length * 2) + ' strategies, ' + SEEDS + ' seeded fights each\n')

/* Determinism is checked once on a single pair rather than on all sixteen
   fights of all eight: it is a property of the harness, not of the prompts,
   so one violation would show up anywhere and paying for it eight times
   over buys nothing. */
{
  const p = PAIRS[0]
  const a = sim.parse(p.p1)
  const b = sim.parse(p.p2)
  const v = sim.verify(a, b, seedFor(1), null)
  if (!v.ok) {
    fail('the headless engine disagreed with itself on ' + p.key + ' - ' +
      'the server would settle a fight the spectator did not watch.\n' +
      '        first:  ' + JSON.stringify(v.result) + '\n' +
      '        second: ' + JSON.stringify(v.second))
  } else {
    console.log('  ok    engine is deterministic (' + p.key + ' ran twice, identical)')
  }
}

console.log('')

for (const pair of PAIRS) {
  const a = sim.parse(pair.p1)
  const b = sim.parse(pair.p2)

  let w1 = 0, w2 = 0, draws = 0, ko = 0
  for (let k = 0; k < SEEDS; k++) {
    const r = sim.run(a, b, seedFor(k), null)
    if (r.winner === 'p1') w1++
    else if (r.winner === 'p2') w2++
    else draws++
    if (r.how === 'KO') ko++
  }

  const pct = Math.round(100 * w1 / SEEDS)
  const line = '  ' + pair.key.padEnd(16) +
    (a.archetype + ' vs ' + b.archetype).padEnd(30) +
    String(pct).padStart(3) + '% / ' + String(100 - pct - Math.round(100 * draws / SEEDS)).padStart(3) + '%' +
    '   ko ' + Math.round(100 * ko / SEEDS) + '%'

  /* The wildcard is not a strategy pair and is not tuned for balance - see
     the note on it in house/fixtures.js. It is still RUN, because it has to
     terminate and it has to parse, but its split is reported rather than
     judged. */
  if (pair.wildcard) {
    console.log(line + '   (wildcard, not balance-tuned)')
    continue
  }

  if (pct < LOW || pct > HIGH) {
    console.log(line)
    fail(pair.key + ' is ' + pct + '/' + (100 - pct) + ', outside the ' +
      LOW + '-' + HIGH + ' band. A match with a known winner is not a market. ' +
      'Check the stat budget totals: ' +
      (a.stats.aggression + a.stats.defense + a.stats.speed).toFixed(2) + ' vs ' +
      (b.stats.aggression + b.stats.defense + b.stats.speed).toFixed(2) + '.')
  } else {
    console.log(line)
  }
}

console.log('')
if (failures) {
  console.error(failures + ' failure(s)')
  process.exit(1)
}
console.log('house floor ok')
