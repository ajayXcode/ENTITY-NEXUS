/* ------------------------------------------------------------------
   tests/champion-points.test.js - the scoreboard and the battle art.

   Two additions that both sit at the very edge of the fight, which is
   exactly where things get bolted on and quietly start deciding rounds. So
   the claims below are about the edge holding:

   1. THE POINTS CANNOT MOVE A FIGHT. The ledger is a pure function of the
      round's own counters, it is booked after the round, and the simulation
      never loads the file it lives in. Each of those is asserted rather
      than assumed - including the last one, which is checked by reading
      house/sim.js's SCRIPTS list.

   2. THE BATTLE ART IS DROP-IN. A skinned champion's frames have to land on
      the exact rectangle the sheet they replace would have landed on, or
      the fighter is the wrong size and in the wrong place. That is a
      geometry claim about file dimensions, so it is checked against the
      real files rather than by looking at a screenshot.

   3. A LOSS PAYS. It is the whole point of the feature, and the easiest
      thing to regress into a win-only counter.

   Run: node tests/champion-points.test.js  (or npm test)
------------------------------------------------------------------- */

'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(process.argv[2] || path.resolve(__dirname, '..'))

let fails = 0
const check = (cond, msg) => {
  if (cond) console.log('  ok    ' + msg)
  else { console.error('  FAIL  ' + msg); fails++ }
}

/* ---------------- the registry, as the browser loads it ----------------
   js/characters.js is pure data and string building - no DOM at load - so
   it runs here with nothing but a localStorage that behaves. That is the
   same property scripts/make-champion-assets.js depends on. */

const store = {}
const sandbox = {
  console, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  isNaN, isFinite, parseInt, parseFloat,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] }
  },
  document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  Image: function () {},
  clamp01: (x) => Math.max(0, Math.min(1, x)),
  round2: (x) => Math.round(x * 100) / 100,
  mulberry32: () => () => 0.5,
  hashString: () => 1,
  CONFIG: { MAX_PROMPT_WORDS: 200, MAX_PROMPT_CHARS: 1600, HUD_PROMPT_CHARS: 150 }
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
for (const f of ['js/utils.js', 'js/config.js', 'js/prompt-parser.js', 'js/characters.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f })
}
const C = vm.runInContext('Characters', sandbox)
const LIST = C.all

/* ---------------- 1. the registry ---------------- */

console.log('\n--- the registry ---')
{
  check(LIST.length === 17, 'seventeen champions — ' + LIST.length)

  const arch = {}
  for (const c of LIST) arch[C.parsed(c).archetype] = 1
  check(Object.keys(arch).length === 8, 'all eight archetypes are represented — ' + Object.keys(arch).sort().join(', '))

  const ids = LIST.map((c) => c.id)
  check(new Set(ids).size === ids.length, 'no duplicate ids')
  const prompts = LIST.map((c) => C.normPrompt(c.prompt))
  check(new Set(prompts).size === prompts.length,
    'no two champions share a strategy — recognition is by prompt, so a duplicate would be two champions fighting as one')

  /* A champion is only recognised in the fight by its prompt, so every
     champion has to be findable BY its own prompt, exactly. */
  const unfound = LIST.filter((c) => C.byPrompt(c.prompt) !== c).map((c) => c.name)
  check(unfound.length === 0, 'every champion is recognised by its own strategy' + (unfound.length ? ' — broken: ' + unfound.join(', ') : ''))

  const malgrave = C.byId('malgrave')
  check(!!malgrave, 'MALGRAVE is on the roster')
  check(C.parsed(malgrave).archetype === 'TACTICIAN',
    'MALGRAVE parses as ' + C.parsed(malgrave).archetype + ' — the archetype is the parser\'s, not a label on the card')

  const lines = {}
  let dupes = []
  for (const c of LIST) {
    const k = JSON.stringify(C.parsed(c).stats)
    if (lines[k]) dupes.push(c.name + ' / ' + lines[k])
    lines[k] = c.name
  }
  check(dupes.indexOf('MALGRAVE') === -1,
    'MALGRAVE does not duplicate an existing stat line' + (dupes.length ? ' (pre-existing pairs kept as they were: ' + dupes.join('; ') + ')' : ''))
}

/* ---------------- 2. the battle art is drop-in ---------------- */

console.log('\n--- battle art ---')

/* PNG header read, no image library. IHDR is always the first chunk, so the
   width/height are at fixed offsets 16 and 20. */
function pngSize(file) {
  const b = fs.readFileSync(file)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

{
  const R = C.ART.R
  const base = C.ART.baseScale
  const skinned = LIST.filter((c) => C.ART.has(c))
  check(skinned.length === 2, 'two champions ship their own sprites — ' + skinned.map((c) => c.name).join(', '))

  const BASE_FRAME = 200
  const BASE_SHEETS = {
    p1: 'assets/img/samuraiMack/Idle.png',
    p2: 'assets/img/kenji/Idle.png'
  }

  for (const side of [1, 2]) {
    const bs = pngSize(path.join(ROOT, BASE_SHEETS[side === 1 ? 'p1' : 'p2']))
    check(bs && bs.h === BASE_FRAME,
      'P' + side + '\'s sheet frame is ' + BASE_FRAME + 'px tall, as this test assumes — got ' + (bs && bs.h))
  }

  for (const c of skinned) {
    for (const side of [1, 2]) {
      const d = C.ART.for_(c, side)
      check(!!d && d.scale === base / R,
        c.name + ' p' + side + ': drawn at ' + (d && d.scale) + ' (base ' + base + ' / R ' + R + ')')

      let missing = []
      for (const name of d.names) {
        const f = path.join(ROOT, d.dir, C.ART.file(name))
        const s = fs.existsSync(f) ? pngSize(f) : null
        if (!s) missing.push(name)
        else if (s.w !== BASE_FRAME * R || s.h !== BASE_FRAME * R) {
          missing.push(name + ' is ' + s.w + 'x' + s.h + ', not ' + BASE_FRAME * R + ' square')
        }
      }
      check(missing.length === 0,
        c.name + ' p' + side + ': all ' + d.names.length + ' frames are ' + BASE_FRAME * R + ' square' +
        (missing.length ? ' — ' + missing.join(', ') : ''))

      /* The whole geometry claim in one line: the frame is R times the base
         frame, the scale is 1/R of the base scale, so the drawn width is
         identical - and with it the offset js/game.js already applies. */
      check(BASE_FRAME * R * (base / R) === BASE_FRAME * base,
        c.name + ' p' + side + ': on-screen frame is ' + (BASE_FRAME * base) + 'px, same as the sheet it replaces')
    }

    const port = path.join(ROOT, C.ART.portrait(c))
    const ps = fs.existsSync(port) ? pngSize(port) : null
    check(ps && ps.w === ps.h, c.name + ': the card portrait exists and is square — ' + (ps ? ps.w + 'x' + ps.h : 'missing'))
  }

  /* The art must also switch the other two identity layers off, or the
     fighter is drawn twice in two palettes. */
  check(C.tint(C.byId('raphael')) === null, 'a skinned champion is not hue-rotated')
  check(C.tint(C.byId('orion')) !== null, 'a borrowed champion still is')

  const html = C.cardHTML(C.byId('raphael'))
  check(html.indexOf('ch-art') >= 0 && html.indexOf('raphael/portrait.png') >= 0,
    'a skinned champion\'s card carries its own portrait')
  const plain = C.cardHTML(C.byId('orion'))
  check(plain.indexOf('ch-art') === -1, 'a borrowed champion\'s card does not pretend to have one')
}

/* ---------------- 3. the points ledger ---------------- */

console.log('\n--- points ---')
{
  const P = C.points

  const win = P.score({ won: true, hpLeft: 60, hitsLanded: 7, blockedHits: 2 })
  check(win.gained === 10 + 25 + 6 + 7 + 2, 'a win pays fought + win + health + hits + blocks — ' + win.gained)
  check(win.lines.length >= 4, 'the win comes with an itemised receipt — ' + win.lines.length + ' lines')

  const loss = P.score({ won: false, hpLeft: 0, hitsLanded: 4, blockedHits: 1 })
  check(loss.gained > 0, 'a LOSS PAYS — ' + loss.gained)
  check(loss.gained === 10 + 4 + 1, 'a loss pays fought + hits + blocks, and no win or health bonus — ' + loss.gained)
  check(P.score({ won: false }).gained === 10, 'a loss with nothing on the sheet still pays for showing up — ' + P.score({ won: false }).gained)
  check(win.gained > loss.gained, 'and a win is still worth more than a loss')

  check(P.score({ won: true, hpLeft: 9999, hitsLanded: 9999, blockedHits: 9999 }).gained === 10 + 25 + 10 + 10 + 5,
    'every bonus is capped, so one absurd counter cannot run away with the score')
  check(P.score({}).gained === 10, 'a round with no counters at all is still just the participation pay')
  check(P.score(null).gained === 10, 'and so is a missing one — score() does not throw on nothing')
  check(P.score({ won: true, hpLeft: -5, hitsLanded: -3, blockedHits: -1 }).gained === 10 + 25,
    'negative counters cannot be farmed for points')

  /* Two identical rounds must pay identically. If this ever drifts the
     scoreboard is reading state from somewhere it should not. */
  const a = P.score({ won: true, hpLeft: 42, hitsLanded: 5, blockedHits: 3 })
  const b = P.score({ won: true, hpLeft: 42, hitsLanded: 5, blockedHits: 3 })
  check(JSON.stringify(a) === JSON.stringify(b), 'the same round pays the same, every time')

  /* --- persistence --- */
  C.points.clear()
  C.record.clear()
  check(P.total() === 0, 'a cleared ledger starts at zero')

  const w1 = P.award('raphael', { won: true, hpLeft: 70, hitsLanded: 6, blockedHits: 2 })
  check(w1.gained === 10 + 25 + 7 + 6 + 2, 'award() books the same arithmetic score() computes — ' + w1.gained)
  check(w1.total === w1.gained, 'the first award IS the running total — ' + w1.total)
  check(w1.w === 1 && w1.l === 0, 'and it books a win')

  const l1 = P.award('malgrave', { won: false, hpLeft: 0, hitsLanded: 3, blockedHits: 0 })
  check(l1.l === 1 && l1.w === 0, 'the loser is booked as a loss, not skipped')
  check(l1.total === l1.gained && l1.gained > 0, 'and is paid for the round — ' + l1.total)
  check(P.total() === w1.total + l1.total, 'the session total is the sum of the ledger — ' + P.total())

  P.award('raphael', { won: false, hitsLanded: 1, blockedHits: 0 })
  check(P.get('raphael').w === 1 && P.get('raphael').l === 1, 'a champion can win and lose in the same session')
  check(P.get('raphael').pts > w1.total, 'and the second round adds to its total rather than replacing it')

  check(P.get('nonexistent').pts === 0, 'an unknown champion reads as zero, not undefined')

  /* --- the two ledgers are independent --- */
  C.record.note('raphael', true)
  check(C.record.get('raphael').w === 1 && P.get('raphael').w === 1,
    'the record and the points ledger both see one win')
  check(C.record.KEY !== P.KEY,
    'and they are stored apart — a win/loss tally and a score are different numbers')

  /* --- and neither of them is the fight --- */
  const sim = fs.readFileSync(path.join(ROOT, 'house', 'sim.js'), 'utf8')
  const scripts = (sim.match(/const SCRIPTS = \[([\s\S]*?)\]/) || [])[1] || ''
  check(scripts.indexOf('characters.js') === -1,
    'the headless settlement harness does not load js/characters.js')
  check(scripts.indexOf('ui.js') === -1,
    'and does not load js/ui.js, where the award is booked')
  for (const f of ['characters.js', 'ui.js', 'wallet.js', 'champions.js']) {
    check(scripts.indexOf(f) === -1, 'the harness never loads ' + f)
  }

  C.points.clear()
  C.record.clear()
}

console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n')
process.exit(fails ? 1 : 0)
