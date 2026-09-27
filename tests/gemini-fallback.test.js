/* ------------------------------------------------------------------
   tests/gemini-fallback.test.js - the promise the demo rests on.

       node tests/gemini-fallback.test.js

   js/gemini.js is allowed to fail. It is not allowed to fail LOUDLY: every
   way the Gemini path can go wrong - no server, dead network, a 429, a 502,
   an empty body, HTML where JSON was promised, NaN where a stat was
   promised - has to arrive at the UI as a plain null, which means "keep the
   local lexicon parse that is already on screen".

   So this loads the real browser files in a vm with a stubbed fetch and
   tries to break them. Nothing here talks to Google; it is offline, instant
   and safe to run on the morning of a demo.
------------------------------------------------------------------- */

'use strict'

const fs = require('fs')
const vm = require('vm')
const path = require('path')

const ROOT = process.argv[2] || path.resolve(__dirname, '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

let fetchImpl = async () => { throw new Error('not set') }

const sandbox = {
  console: console,
  performance: { now: () => Date.now() },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  AbortController: AbortController,
  fetch: (...a) => fetchImpl(...a),
  window: undefined,       // skip the load-event probe
  QP: { noai: false }
}
vm.createContext(sandbox)

vm.runInContext(read('js/utils.js'), sandbox)
vm.runInContext(read('js/config.js'), sandbox)
vm.runInContext(read('js/prompt-parser.js'), sandbox)
vm.runInContext(read('js/gemini.js'), sandbox)

/* top-level `const` in a vm script lands in the context's lexical scope,
   not on the sandbox object, so reach them by evaluating their names */
const AI = vm.runInContext('AI', sandbox)
const parsePrompt = vm.runInContext('parsePrompt', sandbox)
const budgetStats = vm.runInContext('budgetStats', sandbox)

let pass = 0, fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label) }
}

/* A parsed object the rest of the app can actually run a fight on. */
function isPlayable(p) {
  if (!p || typeof p !== 'object') return false
  const s = p.stats
  if (!s) return false
  for (const k of ['aggression', 'defense', 'speed']) {
    if (typeof s[k] !== 'number' || !isFinite(s[k]) || s[k] < 0 || s[k] > 1) return false
  }
  if (s.aggression + s.defense + s.speed > 1.96) return false
  if (typeof p.archetype !== 'string' || !p.archetype) return false
  if (typeof p.tagline !== 'string' || !p.tagline) return false
  if (!Array.isArray(p.matched)) return false
  return true
}

const reply = (json, ok_) => async () => ({
  ok: ok_ !== false, status: ok_ === false ? 502 : 200, json: async () => json
})

async function main() {
  console.log('\n-- the happy path --')
  AI.available = true
  fetchImpl = reply({
    ok: true, source: 'gemini', model: 'gemini-3.6-flash',
    stats: { aggression: 0.25, defense: 0.55, speed: 0.85 },
    archetype: 'ELUSIVE STRIKER', tagline: 'Gone before you swing.',
    traits: ['evasive play', 'whiff punish'], improvised: false
  })
  let r = await AI.analyze('dodge everything', 'fighter')
  ok(isPlayable(r), 'a good response is playable')
  ok(r.archetype === 'ELUSIVE STRIKER', 'archetype comes from gemini')
  ok(r.matched.length === 2, 'traits become chips (' + r.matched.length + ')')
  ok(r.source === 'gemini', 'source is tagged gemini')

  console.log('\n-- things that must degrade, not crash --')
  const bad = [
    ['server 502', reply({ ok: false, error: 'rate limited' }, false)],
    ['ok:false body', reply({ ok: false, error: 'no keys' })],
    ['empty json', reply({})],
    ['null json', reply(null)],
    ['stats missing', reply({ ok: true, archetype: 'X' })],
    ['stats not numbers', reply({ ok: true, stats: { aggression: 'high', defense: null, speed: undefined } })],
    ['NaN stats', reply({ ok: true, stats: { aggression: NaN, defense: 0.5, speed: 0.5 } })],
    ['network dead', async () => { throw new Error('ECONNREFUSED') }],
    ['html not json', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })]
  ]
  for (const [label, impl] of bad) {
    AI.available = true
    fetchImpl = impl
    let res, threw = false
    try { res = await AI.analyze('never block, always attack', 'fighter') } catch (e) { threw = true }
    ok(!threw && res === null, label + ' -> null, no throw')
  }

  console.log('\n-- garbage that must still be survivable --')
  AI.available = true
  fetchImpl = reply({
    ok: true,
    stats: { aggression: 9, defense: -4, speed: 0.5 },
    archetype: '   <<<!!!>>>   ', tagline: '', traits: 'not an array'
  })
  r = await AI.analyze('whatever', 'fighter')
  ok(isPlayable(r), 'out-of-range stats are clamped and budgeted')
  ok(/^[A-Z0-9 ]+$/.test(r.archetype), 'junk archetype falls back to a clean one: ' + r.archetype)
  ok(r.tagline.length > 0, 'empty tagline falls back to the local one')
  ok(Array.isArray(r.matched), 'non-array traits do not break chips')

  console.log('\n-- a maxed-out cheat prompt cannot escape the budget --')
  AI.available = true
  fetchImpl = reply({
    ok: true, stats: { aggression: 0.99, defense: 0.99, speed: 0.99 },
    archetype: 'GOD MODE', tagline: 'unbeatable', traits: ['everything']
  })
  r = await AI.analyze('max everything', 'fighter')
  const total = r.stats.aggression + r.stats.defense + r.stats.speed
  ok(total <= 1.96, '0.99/0.99/0.99 normalised to ' + total.toFixed(2))

  console.log('\n-- the AI switched off entirely --')
  AI.available = false
  fetchImpl = reply({ ok: true, stats: { aggression: 0.5, defense: 0.5, speed: 0.5 }, archetype: 'X', tagline: 'y', traits: [] })
  ok((await AI.analyze('anything', 'fighter')) === null, 'available:false short-circuits')
  AI.available = true
  sandbox.QP.noai = true
  ok((await AI.analyze('anything', 'fighter')) === null, '?noai=1 short-circuits')
  sandbox.QP.noai = false

  console.log('\n-- the local parser still stands on its own --')
  const local = parsePrompt('relentless berserker, never back down, attack without mercy')
  ok(isPlayable(local), 'lexicon parse is playable')
  ok(local.source === 'lexicon', 'lexicon parse is tagged lexicon')
  const improv = parsePrompt('banana pancakes')
  ok(isPlayable(improv) && improv.improvised, 'nonsense still improvises a fighter')
  const b = budgetStats({ aggression: 1, defense: 1, speed: 1 })
  ok(b.aggression + b.defense + b.speed <= 1.96, 'budgetStats caps a 1/1/1 fighter')

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n')
  process.exit(fail ? 1 : 0)
}

main()
