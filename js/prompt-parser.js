/* ------------------------------------------------------------------
   prompt-parser.js - plain English -> {aggression, defense, speed}

   Pure: no DOM, no globals beyond CONFIG/utils. The UI calls this on every
   keystroke to live-preview the bars, and once more when the prompt locks in.
------------------------------------------------------------------- */

const LEXICON = [
  // ---- aggression ----
  { stat: 'aggression', w: +0.30, terms: ['aggressive', 'aggression', 'attack', 'attacking', 'offense', 'offensive', 'rush', 'rushing', 'rushdown', 'berserk', 'berserker', 'relentless', 'brutal', 'savage', 'destroy', 'smash', 'crush', 'pressure', 'blitz', 'charge', 'overwhelm', 'furious', 'rage', 'merciless', 'ruthless', 'combo', 'combos', 'aggro', 'fearless', 'reckless', 'violent', 'kill', 'slaughter', 'unload', 'onslaught', 'strike'] },
  { stat: 'aggression', w: -0.22, terms: ['passive', 'timid', 'hesitant', 'reluctant', 'peaceful', 'gentle'] },

  // ---- defense ----
  { stat: 'defense', w: +0.30, terms: ['defensive', 'defense', 'defend', 'block', 'blocking', 'guard', 'tank', 'tanky', 'turtle', 'counter', 'counterattack', 'punish', 'survive', 'endure', 'wall', 'safe', 'safely', 'absorb', 'shield', 'protect', 'careful', 'cautious', 'patient', 'patience', 'wait', 'waiting', 'disciplined', 'measured', 'conserve', 'armor', 'sturdy', 'resilient'] },
  { stat: 'defense', w: -0.22, terms: ['careless', 'wild', 'exposed', 'glass', 'sloppy', 'overextend'] },

  // ---- speed ----
  { stat: 'speed', w: +0.30, terms: ['fast', 'faster', 'quick', 'quickly', 'swift', 'speed', 'speedy', 'dodge', 'dodging', 'agile', 'nimble', 'evasive', 'evade', 'lightning', 'rapid', 'slippery', 'mobile', 'dash', 'dashing', 'dart', 'blink', 'flurry', 'jump', 'jumping', 'weave', 'juke', 'zip'] },
  { stat: 'speed', w: -0.22, terms: ['slow', 'slowly', 'heavy', 'sluggish', 'steady', 'grounded', 'lumbering', 'plodding', 'immobile'] }
]

/* Cowardice is its own shape: it drives three stats at once, so it gets
   handled as a compound rather than three separate lexicon hits. */
const COMPOUNDS = [
  { terms: ['coward', 'cowardly', 'chicken', 'flee', 'fleeing', 'retreat', 'retreating', 'run away', 'runaway', 'escape', 'avoid', 'avoidant', 'scared', 'afraid', 'hide', 'hiding', 'kite', 'kiting'],
    apply: { aggression: -0.28, defense: +0.26, speed: +0.26 }, label: 'coward' },
  { terms: ['hit and run', 'hit-and-run', 'in and out', 'poke', 'poking', 'harass'],
    apply: { aggression: +0.10, defense: +0.10, speed: +0.28 }, label: 'hit & run' },
  { terms: ['all out', 'all-out', 'no mercy', 'no defense', 'glass cannon', 'do or die', 'full send', 'go ham', 'never retreat', 'never back down'],
    apply: { aggression: +0.34, defense: -0.20, speed: +0.06 }, label: 'all out' },
  { terms: ['stand your ground', 'hold the line', 'immovable', 'unbreakable', 'brick wall', 'stone wall'],
    apply: { aggression: -0.06, defense: +0.34, speed: -0.16 }, label: 'immovable' }
]

const INTENSIFIERS = { very: 1.5, extremely: 1.7, super: 1.6, ultra: 1.7, insanely: 1.7, totally: 1.4, really: 1.35, always: 1.4, constantly: 1.4, max: 1.6, maximum: 1.6, pure: 1.5, hyper: 1.6 }
const DIMINISHERS = { slightly: 0.6, somewhat: 0.6, 'a bit': 0.6, kinda: 0.6, sometimes: 0.65, occasionally: 0.6, mostly: 0.85, fairly: 0.8 }
const NEGATORS = new Set(['never', 'not', 'dont', "don't", 'no', 'without', 'avoid', 'stop', 'cant', "can't"])

const ARCHETYPES = [
  { name: 'GLASS CANNON', tag: 'Hits like a truck. Folds like paper.', test: (s) => s.aggression >= 0.65 && s.defense <= 0.35 },
  { name: 'BERSERKER',    tag: 'Forward is the only direction.',       test: (s) => s.aggression >= 0.65 && s.speed >= 0.60 },
  { name: 'JUGGERNAUT',   tag: 'Slow, heavy, and very hard to move.',  test: (s) => s.defense >= 0.65 && s.speed <= 0.40 },
  { name: 'TURTLE',       tag: 'Waits. Blocks. Waits some more.',      test: (s) => s.defense >= 0.60 && s.aggression <= 0.40 },
  { name: 'ASSASSIN',     tag: 'In, out, gone before you swing.',      test: (s) => s.speed >= 0.65 },
  { name: 'BRAWLER',      tag: 'Happy to trade hits all day.',         test: (s) => s.aggression >= 0.60 },
  { name: 'TACTICIAN',    tag: 'Picks the moment, then commits.',      test: (s) => s.defense >= 0.50 && s.aggression >= 0.45 },
  { name: 'JOURNEYMAN',   tag: 'No weaknesses. No specialities.',      test: () => true }
]

function archetypeFor(stats) {
  return ARCHETYPES.find((a) => a.test(stats))
}

/* Budget normalisation, factored out so the Gemini path in gemini.js lands
   under the exact same ceiling as the lexicon path. Without it, a prompt
   that stacks every keyword - or a model in a generous mood - produces a
   1/1/1 fighter that is simply better, and then prompts stop mattering,
   which is the whole demo. Forcing a total budget makes every prompt a
   trade-off. Extremes stay reachable, just not for free.

   applyFloor is skipped for improvised fighters: those stats are random by
   design and a low roll is a legitimate (bad) fighter, not an error. */
function budgetStats(stats, applyFloor) {
  const s = {
    aggression: clamp01(stats.aggression),
    defense: clamp01(stats.defense),
    speed: clamp01(stats.speed)
  }
  const total = s.aggression + s.defense + s.speed
  if (total > 1.95) {
    const k = 1.95 / total
    for (const x in s) s[x] = clamp01(s[x] * k)
  } else if (total < 0.95 && total > 0 && applyFloor !== false) {
    const k = 0.95 / total
    for (const x in s) s[x] = clamp01(s[x] * k)
  }
  for (const x in s) s[x] = round2(s[x])
  return s
}

/* Words, not characters. Returns the list so callers can count and clamp. */
function promptWords(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean)
}

function clampToWordLimit(s) {
  const w = promptWords(s)
  if (w.length <= CONFIG.MAX_PROMPT_WORDS) return s
  return w.slice(0, CONFIG.MAX_PROMPT_WORDS).join(' ')
}

function parsePrompt(rawPrompt) {
  const raw = clampToWordLimit(rawPrompt || '').slice(0, CONFIG.MAX_PROMPT_CHARS)
  const text = ' ' + raw.toLowerCase().replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '
  const words = text.trim().split(' ').filter(Boolean)

  const stats = { aggression: 0.35, defense: 0.35, speed: 0.35 }
  const matched = []
  let hits = 0

  const bump = (stat, delta, label) => {
    stats[stat] += delta
    hits++
    matched.push({ label, stat, delta: round2(delta) })
  }

  // Multi-word compounds first, so "run away" isn't eaten by "run".
  for (const comp of COMPOUNDS) {
    for (const term of comp.terms) {
      if (text.includes(' ' + term + ' ')) {
        for (const stat in comp.apply) {
          stats[stat] += comp.apply[stat]
        }
        hits++
        matched.push({ label: term, stat: 'compound', delta: 0, compound: comp.label })
        break
      }
    }
  }

  // Single words, with the preceding 1-2 words acting as modifiers.
  words.forEach((word, i) => {
    const stripped = word.replace(/[^a-z0-9'-]/g, '')
    for (const entry of LEXICON) {
      if (!entry.terms.includes(stripped)) continue

      let mult = 1
      const prev = words[i - 1] || ''
      const prev2 = words[i - 2] || ''
      if (INTENSIFIERS[prev]) mult *= INTENSIFIERS[prev]
      if (DIMINISHERS[prev]) mult *= DIMINISHERS[prev]
      if (NEGATORS.has(prev) || NEGATORS.has(prev2)) mult *= -1

      bump(entry.stat, entry.w * mult, stripped)
      break
    }
  })

  // Nothing recognisable? Derive a fighter from the text itself so that
  // "banana pancakes" still produces a distinct, playable character
  // instead of a puddle of 0.35s.
  let improvised = false
  if (hits === 0) {
    improvised = true
    const r = mulberry32(hashString(raw.trim() || 'empty'))
    stats.aggression = 0.25 + r() * 0.60
    stats.defense = 0.25 + r() * 0.60
    stats.speed = 0.25 + r() * 0.60
  }

  const budgeted = budgetStats(stats, !improvised)
  for (const k in budgeted) stats[k] = budgeted[k]

  const arch = archetypeFor(stats)
  return {
    prompt: raw,
    stats,
    matched,
    improvised,
    archetype: arch.name,
    tagline: arch.tag,
    source: 'lexicon'
  }
}

/* Used by the reveal screen and (later) the NFT. ASCII only, single spaces,
   capped at the word limit. */
function sanitizePrompt(s) {
  const clean = (s || '')
    .replace(/[^A-Za-z0-9 .,!?'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clampToWordLimit(clean).slice(0, CONFIG.MAX_PROMPT_CHARS)
}

/* A 200-word strategy will not fit on a health bar. */
function shortPrompt(s, maxChars) {
  const t = sanitizePrompt(s)
  const n = maxChars || CONFIG.HUD_PROMPT_CHARS
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'
}
