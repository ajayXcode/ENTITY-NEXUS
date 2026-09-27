/* The claim rooms.js rests on: two browsers handed the same two fighters and
   the same seed draw the same fight. Two independent vm contexts stand in for
   the two browsers - separate globals, separate module state, no shared
   objects at all - and the fights are compared frame for frame. */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const ROOT = process.argv[2] || process.cwd()
const FILES = ['js/utils.js', 'js/config.js', 'js/classes.js', 'js/prompt-parser.js',
  'js/ai-controller.js', 'js/game.js']

/* Everything the simulation touches that a terminal does not have. The sim
   itself is pure arithmetic - this is all drawing, audio and DOM. */
function noop() { return noop }
function stub() {
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === 'width' || k === 'height') return 1024
      if (k === Symbol.toPrimitive) return () => 0
      return stub()
    },
    set() { return true },
    apply() { return stub() }
  })
}

function makeSim(tag) {
  const canvas = { width: 1024, height: 576, getContext: () => stub() }
  const ctx = {
    console, Math, Date, JSON, Promise, Error, String, Number, Object, Array,
    parseInt, parseFloat, isFinite, Set, Map, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    Image: function () { this.src = ''; this.width = 0; this.height = 0 },
    document: {
      querySelector: () => canvas,
      querySelectorAll: () => [],
      createElement: () => stub(),
      body: { classList: { add: noop, remove: noop, toggle: noop } },
      addEventListener: noop
    },
    location: { search: '' },
    window: { addEventListener: noop, gsap: undefined, requestAnimationFrame: () => 0 },
    URLSearchParams: URLSearchParams,
    FX: stub(),
    UI: stub(),
    Scene3D: stub(),
    Render3D: stub(),
    PenFight: stub(),
    Chain: stub(),
    AI: stub()
  }
  ctx.window.document = ctx.document
  vm.createContext(ctx)
  const src = ['var SimExport;']
    .concat(FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')))
    .concat(['SimExport = { parsePrompt, startFight, stepFight, game, player, enemy, hashString };'])
    .join('\n')
  vm.runInContext(src, ctx, { filename: tag })
  return ctx.SimExport
}

/* One fight, run to its end, reduced to the numbers both browsers would
   have to agree on for the room to be honest. */
function runFight(S, p1Text, p2Text, seed) {
  const a = S.parsePrompt(p1Text)
  const b = S.parsePrompt(p2Text)
  S.startFight(a, b, seed)
  S.game.bench = true
  let guard = 0
  const trace = []
  while (!S.game.over && guard++ < S.game.totalFrames + 10) {
    S.stepFight()
    // A running digest, so a divergence is caught at the frame it happens
    // rather than only if it changes the final winner.
    if (S.game.frame % 30 === 0) {
      trace.push(S.game.frame + ':' + Math.round(S.player.health) + ',' + Math.round(S.enemy.health) +
        ',' + Math.round(S.player.position.x) + ',' + Math.round(S.enemy.position.x))
    }
  }
  return {
    winner: S.game.winner,
    frame: S.game.frame,
    hp1: Math.round(S.player.health),
    hp2: Math.round(S.enemy.health),
    trace: trace.join('|')
  }
}

const A = makeSim('browser-A')
const B = makeSim('browser-B')

const CASES = [
  ['relentless berserker, attack without mercy, never back down',
   'patient and careful, block everything, wait for an opening'],
  ['extremely fast, dodge everything, hit and run',
   'slow and immovable, stand your ground, absorb everything'],
  ['all out attack, no defense at all, do or die',
   'be a total coward, run away and avoid all damage'],
  ['fight smart, mix attack and defense',
   'fight smart, mix attack and defense']
]

let fails = 0
let fights = 0
console.log('\ntwo independent contexts, same inputs:\n')

for (const [p1, p2] of CASES) {
  for (let k = 0; k < 12; k++) {
    const seed = A.hashString('room-QQ34|' + k) >>> 0
    const ra = runFight(A, p1, p2, seed)
    const rb = runFight(B, p1, p2, seed)
    fights++
    const same = ra.winner === rb.winner && ra.frame === rb.frame &&
      ra.hp1 === rb.hp1 && ra.hp2 === rb.hp2 && ra.trace === rb.trace
    if (!same) {
      fails++
      console.log('  FAIL seed ' + seed)
      console.log('    A: ' + ra.winner + ' @' + ra.frame + ' hp ' + ra.hp1 + '/' + ra.hp2)
      console.log('    B: ' + rb.winner + ' @' + rb.frame + ' hp ' + rb.hp1 + '/' + rb.hp2)
      if (ra.trace !== rb.trace) {
        const ta = ra.trace.split('|')
        const tb = rb.trace.split('|')
        for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
          if (ta[i] !== tb[i]) { console.log('    first divergence: ' + ta[i] + '  vs  ' + tb[i]); break }
        }
      }
    }
  }
  const s = A.hashString('room-QQ34|0') >>> 0
  const r = runFight(A, p1, p2, s)
  console.log('  ok   ' + p1.slice(0, 26) + '...  vs  ' + p2.slice(0, 26) + '...' +
    '   -> ' + (r.winner || 'draw') + ' @ ' + (r.frame / 60).toFixed(1) + 's')
}

/* And the converse: a different seed had better produce a different fight,
   or the seed is not doing anything. */
const d1 = runFight(A, CASES[0][0], CASES[0][1], 12345)
const d2 = runFight(A, CASES[0][0], CASES[0][1], 99999)
const differs = d1.trace !== d2.trace
console.log('\n  ' + (differs ? 'ok  ' : 'FAIL') + ' different seed -> different fight')
if (!differs) fails++

console.log('\n' + fights + ' fights cross-checked, ' + (fails ? fails + ' MISMATCHED' : 'all identical') + '\n')
process.exit(fails ? 1 : 0)
