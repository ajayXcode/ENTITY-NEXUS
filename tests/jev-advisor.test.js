/* ------------------------------------------------------------------
   JEV as the tactical advisor.

   Three claims are worth proving, and they are the three the settlement
   signature ends up resting on:

     1. A playbook actually STEERS the fight. If JEV's advice did not change
        what the fighters do, the whole advisor layer would be decoration.

     2. Two browsers handed the SAME playbook still simulate the same fight.
        This is why the server caches by (matchId, side) rather than calling
        the model twice - the moment two screens get different advice they
        crown different winners, and one of them is settling real money.

     3. The decision log records EVERY tier-1 decision, including the ones
        the fallback planner made, and folds into a stable hash. A hash that
        went quiet whenever the model was unavailable would be an audit trail
        that vanished exactly when it mattered.
------------------------------------------------------------------- */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const ROOT = process.argv[2] || process.cwd()
const FILES = ['js/utils.js', 'js/config.js', 'js/classes.js', 'js/prompt-parser.js',
  'js/jev.js', 'js/ai-controller.js', 'js/game.js']

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
    /* No fetch in here on purpose: JEV must never reach the network from
       inside a fight, and a missing fetch is the bluntest way to prove it. */
    FX: stub(), UI: stub(), Scene3D: stub(), Render3D: stub(),
    Chain: stub(), AI: stub()
  }
  ctx.window.document = ctx.document
  vm.createContext(ctx)
  const src = ['var SimExport;']
    .concat(FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')))
    .concat(['SimExport = { parsePrompt, startFight, stepFight, game, player, enemy, JEV };'])
    .join('\n')
  vm.runInContext(src, ctx, { filename: tag })
  return ctx.SimExport
}

function runFight(S, p1Text, p2Text, seed) {
  const a = S.parsePrompt(p1Text)
  const b = S.parsePrompt(p2Text)
  S.startFight(a, b, seed)
  S.game.bench = true
  let guard = 0
  const trace = []
  while (!S.game.over && guard++ < S.game.totalFrames + 10) {
    S.stepFight()
    if (S.game.frame % 30 === 0) {
      trace.push(S.game.frame + ':' + Math.round(S.player.health) + ',' + Math.round(S.enemy.health))
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

const P1 = 'patient counter puncher, wait for an opening'
const P2 = 'relentless berserker, attack without mercy'
const SEED = 20260919

let fails = 0
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '   ' + name + (detail ? '   ' + detail : ''))
  if (!cond) fails++
}

/* ---------------- 1. the advisor changes the fight ---------------- */

console.log('\n--- a playbook steers the fight ---\n')

const plain = makeSim('no-advisor')
const noAdvice = runFight(plain, P1, P2, SEED)
ok('a fight with no playbook runs on the local planner',
  plain.JEV.log.length > 0 &&
  plain.JEV.log.every((d) => d.source === 'local'),
  plain.JEV.log.length + ' decisions, all local')

const advised = makeSim('advised')
/* An all-TURTLE playbook for side A is a deliberately extreme instruction.
   If the advisor is wired in at all, the fight has to come out differently
   from the same seed. */
advised.JEV.playbooks = {
  A: { opening: 'TURTLE', mid: 'TURTLE', late: 'TURTLE', suddenDeath: 'TURTLE',
       behind: 'TURTLE', ahead: 'TURTLE', readBeaten: 'TURTLE', readWinning: 'TURTLE' },
  B: { opening: 'RUSH', mid: 'RUSH', late: 'RUSH', suddenDeath: 'RUSH',
       behind: 'RUSH', ahead: 'RUSH', readBeaten: 'RUSH', readWinning: 'RUSH' }
}
const withAdvice = runFight(advised, P1, P2, SEED)

ok('same seed, different playbook -> a different fight',
  withAdvice.trace !== noAdvice.trace,
  withAdvice.hp1 + '/' + withAdvice.hp2 + ' vs ' + noAdvice.hp1 + '/' + noAdvice.hp2)

ok('every decision came from the advisor',
  advised.JEV.log.length > 0 && advised.JEV.log.every((d) => d.source === 'jev'),
  advised.JEV.log.length + ' decisions')

ok('the advisor only ever chose what it was told to',
  advised.JEV.log.filter((d) => d.side === 'A').every((d) => d.decision === 'TURTLE') &&
  advised.JEV.log.filter((d) => d.side === 'B').every((d) => d.decision === 'RUSH'))

ok('both sides were advised independently',
  advised.JEV.log.some((d) => d.side === 'A') && advised.JEV.log.some((d) => d.side === 'B'))

/* ---------------- 2. same playbook -> same fight ---------------- */

console.log('\n--- two browsers, one cached playbook ---\n')

const book = {
  A: { opening: 'ZONE', mid: 'BAIT', late: 'HUNT', suddenDeath: 'RUSH',
       behind: 'RUSH', ahead: 'ZONE', readBeaten: 'BAIT', readWinning: 'HUNT' },
  B: { opening: 'RUSH', mid: 'RUSH', late: 'RUSH', suddenDeath: 'RUSH',
       behind: 'TURTLE', ahead: 'ZONE', readBeaten: 'BAIT', readWinning: 'RUSH' }
}

const browserA = makeSim('browser-A')
const browserB = makeSim('browser-B')
browserA.JEV.playbooks = JSON.parse(JSON.stringify(book))
browserB.JEV.playbooks = JSON.parse(JSON.stringify(book))

const rA = runFight(browserA, P1, P2, SEED)
const rB = runFight(browserB, P1, P2, SEED)

ok('same winner', rA.winner === rB.winner, String(rA.winner))
ok('same frame count', rA.frame === rB.frame, String(rA.frame))
ok('identical frame-by-frame trace', rA.trace === rB.trace)
ok('identical decision hash',
  browserA.JEV.decisionHash() === browserB.JEV.decisionHash(),
  browserA.JEV.decisionHash().slice(0, 18) + '...')

/* ---------------- 3. the audit trail ---------------- */

console.log('\n--- the decision log ---\n')

const log = browserA.JEV.log
ok('every decision is recorded in order',
  log.length > 0 && log.every((d, i) => d.seq === i),
  log.length + ' decisions')

ok('each record names the state it was decided against',
  log.every((d) => typeof d.stateHash === 'string' && d.stateHash.length === 8))

ok('each record names which playbook branch fired',
  log.every((d) => typeof d.rule === 'string' && d.rule.length > 0),
  Array.from(new Set(log.map((d) => d.rule))).join(', '))

ok('the hash is a bytes32 the contract can hold',
  /^0x[0-9a-f]{64}$/.test(browserA.JEV.decisionHash()))

/* Tamper with one decision and the hash has to move, or the log proves
   nothing about the fight it claims to describe. */
const before = browserA.JEV.decisionHash()
const victim = browserA.JEV.log[Math.floor(log.length / 2)]
/* Flip to something it demonstrably is not - picking a fixed value risks
   "tampering" a decision into the value it already held, which proves
   nothing about the hash and everything about the test. */
victim.decision = victim.decision === 'RUSH' ? 'TURTLE' : 'RUSH'
ok('altering one decision changes the hash', browserA.JEV.decisionHash() !== before)

const beforeFrame = browserA.JEV.decisionHash()
victim.frame += 1
ok('altering when a decision happened changes the hash',
  browserA.JEV.decisionHash() !== beforeFrame)

const empty = makeSim('empty')
ok('an empty log hashes to zero rather than throwing',
  empty.JEV.decisionHash() === '0x' + '00'.repeat(32))

/* ---------------- 4. the fallback is recorded, not hidden ---------------- */

console.log('\n--- a half-advised fight ---\n')

const half = makeSim('half')
half.JEV.playbooks = { A: book.A }      // B has no playbook: local planner
runFight(half, P1, P2, SEED)

ok('side A was advised', half.JEV.log.filter((d) => d.side === 'A').every((d) => d.source === 'jev'))
ok('side B fell back to the local planner',
  half.JEV.log.filter((d) => d.side === 'B').every((d) => d.source === 'local'))
ok('the log records both sources rather than going quiet',
  half.JEV.log.some((d) => d.source === 'jev') && half.JEV.log.some((d) => d.source === 'local'))

const man = half.JEV.manifest()
ok('the manifest counts advised decisions honestly',
  man.advised === half.JEV.log.filter((d) => d.source === 'jev').length &&
  man.decisions === half.JEV.log.length,
  man.advised + ' of ' + man.decisions + ' advised')

/* ---------------- config identity ---------------- */

console.log('\n--- snapshot identity ---\n')

const c1 = makeSim('cfg1')
const c2 = makeSim('cfg2')
ok('the same JEV config hashes the same', c1.JEV.configHash() === c2.JEV.configHash())
c2.JEV.CONFIG.cadenceFrames = [30, 60]
ok('a changed cadence changes the config hash - it is a different fighter',
  c1.JEV.configHash() !== c2.JEV.configHash())

console.log('')
if (fails) {
  console.log(fails + ' failed\n')
  process.exit(1)
}
console.log('all passed\n')
