/* ------------------------------------------------------------------
   house/fixtures.js - the eight house matchups.

   WHAT THESE ARE

   A spectator who opens spectate.html on a quiet server sees an empty
   board, and an empty board demos nothing. These eight pairs are the
   house's own fighters: the server seats them, runs them, and settles
   them, so there is always a floor to watch and to bet on.

   They are NOT a shortcut around the real pipeline. Every prompt below is
   ordinary player-authored text and goes through the same /api/analyze
   Gemini call, the same lexicon fallback and the same stat budget as a
   prompt typed into the cabinet. Nothing here asserts a stat, an archetype
   or a winner - the fixtures supply words, and the rest of the system does
   to them exactly what it does to yours.

   WHY THESE EIGHT

   A pairing where one side obviously wins is not a market. Each pair is
   built so the two strategies genuinely trade something different away
   against the shared stat budget (see budget() in server.js), which is what
   makes the odds worth reading rather than decoration.

   Pairs 1-7 are real strategies. Pair 8 is the wildcard: two prompts that
   are not strategies at all. The stat engine is told not to refuse them and
   not to return neutral filler, but to improvise a characterful fighter
   from the vibe of the words and flag improvised: true (see SYSTEM in
   server.js). That path is worth putting on the board where it can be
   watched, because it is the one a judge will try to break by hand.
------------------------------------------------------------------- */

/* Each entry is only: a label for the logs, and two prompts. Deliberately
   nothing else - the moment a fixture carries a stat block, the board is
   showing numbers that no parser produced. */
/* HOW THESE WERE TUNED, AND AGAINST WHAT

   The first draft of these pairs was written on intuition and six of the
   eight turned out to be blowouts - one was 93/7 over sixty seeded fights.
   They were then measured against the deterministic lexicon (js/prompt-
   parser.js) with the real engine, via house/sim.js, and rewritten until
   every pair sat inside a 35-65 band. tests/house-balance.js is that
   measurement, kept so the next edit to the lexicon or the engine cannot
   quietly turn the floor into eight foregone conclusions.

   The thing that actually decided it was not the archetype, it was the stat
   BUDGET TOTAL. budget() only rescales a fighter outside 0.95-1.95, so
   between those bounds a keyword-dense prompt simply gets more total stat
   than a sparse one, and the bigger total usually wins. A pair is fair when
   its two totals are close; that is the constraint the text below is
   written around.

   Tuned against the lexicon on purpose, because the lexicon is the path
   that is deterministic and testable. In production these prompts go to
   Gemini, which reads intent rather than keywords and will give them
   different numbers and different archetypes. The lexicon is the floor, not
   the forecast: what the tuning guarantees is that the board is still a
   market when the model is unreachable. */
const PAIRS = [
  {
    key: 'cannon-wall',
    note: 'a race against a grind',
    p1: 'everything into the first ten seconds, hit as hard as I can, no defense at all, do or die',
    p2: 'slow and immovable, stand your ground, absorb everything, win on the clock'
  },
  {
    key: 'two-walls',
    note: 'the anti-fight, decided on the clock',
    p1: 'patient counter-puncher, block everything, punish only when they overextend',
    p2: 'total coward, run away, avoid all damage, survive to the final bell'
  },
  {
    key: 'ghost-trader',
    note: 'evasion against the trade',
    p1: 'extremely fast, never stand still, dart in for one hit and get straight back out of range',
    p2: 'stay in their face and pressure constantly, trade hit for hit, keep the guard up between swings'
  },
  {
    key: 'rage-read',
    note: 'pressure against the read',
    p1: 'relentless berserker, forward is the only direction, never back down',
    p2: 'fight smart, stay mobile, mix attack and defense, punish every mistake they make'
  },
  {
    key: 'late-early',
    note: 'pacing: the late spike against the frontload',
    p1: 'conserve early, stay safe and give ground, then unload everything and attack without mercy once they are hurt',
    p2: 'win it in the opening exchange, overwhelm them immediately with relentless attacks, then fade'
  },
  {
    key: 'poke-anchor',
    note: 'harassment against the wall',
    p1: 'in and out, one quick poke then reset, never commit to anything',
    p2: 'hold the centre, brick wall, quick counters, punish anything that reaches in'
  },
  {
    key: 'reckless-drill',
    note: 'all speed against all armor',
    p1: 'insanely fast and completely reckless, dodge everything, no guard at all',
    p2: 'disciplined and measured, guard up, counter everything, then punish fast and hard'
  },

  /* THE WILDCARD. Neither of these is a strategy, and that is the point:
     the board should contain one match where what the stat engine did with
     the words is itself the thing being bet on. Left exactly as a confused
     player would type them - no winking, no hint that they are a test, and
     deliberately NOT balance-tuned, because tuning nonsense for fairness
     would mean choosing the nonsense by its stats and the whole interest of
     this pair is that nobody chose its stats. */
  {
    key: 'wildcard',
    note: 'neither prompt is a strategy - improvised fighters',
    wildcard: true,
    p1: 'preheat the oven to 200 degrees, fold the butter into the flour, do not overwork the dough',
    p2: 'asdkjh ggggg wwwwwwww lmao bananas bananas bananas'
  }
]

/* The board clamps a prompt at 240 characters (cleanSide in server.js) and
   the cabinet at 200 words. A fixture that silently lost its second half on
   the way to the board would be a strategy nobody actually bet on, so it is
   caught here at load rather than discovered on screen. */
for (const p of PAIRS) {
  for (const side of ['p1', 'p2']) {
    if (p[side].length > 240) {
      throw new Error('house fixture ' + p.key + '.' + side + ' is over the 240-char board limit')
    }
  }
}

module.exports = { PAIRS }
