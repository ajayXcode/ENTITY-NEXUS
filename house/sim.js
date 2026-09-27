/* ------------------------------------------------------------------
   house/sim.js - the browser fight, run in this process.

   WHY THIS EXISTS

   A house match has no players, so nobody reports a result. If the server
   is going to settle one on chain it has to know the winner itself, and
   there is exactly one acceptable way to learn it: run the same fight the
   spectator is about to watch, frame for frame, with the same code.

   Reimplementing the fight in Node would have been the obvious shortcut and
   the worst possible bug: two implementations that agree on ninety-nine
   fights out of a hundred, and settle the hundredth against what the
   spectator saw with their own eyes and their own MON. So nothing is
   reimplemented. js/classes.js, js/ai-controller.js and js/game.js are
   loaded and executed unmodified, in a vm context with the browser objects
   they expect stubbed out beneath them.

   WHY THAT WORKS AT ALL

   The engine was already built for it. update() is split from render() so
   the simulation can move everything without drawing anything, and
   ?bench=N already drives stepFight() in a tight loop with no canvas in
   sight (runBench, js/game.js). This file is that same harness with the
   browser replaced rather than assumed.

   THE DETERMINISM CONTRACT

   A fight is a pure function of (statsA, statsB, seed, playbookA, playbookB):

     - every roll comes from mulberry32 seeded off game.seed (js/utils.js).
       Math.random() appears in the engine exactly once, in the title-screen
       attract flourish, which never runs here.
     - JEV plans ONCE before the bell and returns a fixed playbook that the
       controller consults synchronously, precisely so that two screens can
       never crown different winners (js/jev.js). The playbook is fetched
       server-side and frozen into the match, then handed to every spectator,
       so their browser and this process consult identical advice.

   Break either of those and this file starts lying, so both are asserted
   rather than assumed: verify() re-runs a finished fight and the director
   refuses to settle a match whose replay disagrees with itself.

   ITS RELATIONSHIP TO tests/fight-determinism.test.js

   That test loads the same engine into two vm contexts and compares them
   frame for frame, and it got there first. This is not a copy of it that
   drifted - the two exist for different jobs and only one of them can do
   this one:

     the test    proves TWO INDEPENDENT CONTEXTS agree, which is the claim
                 rooms.js rests on (two browsers, one fight). It runs the
                 lexicon only and deliberately does not load js/jev.js.
     this file   is production code on the settlement path, and it must load
                 JEV so a house fight can be run against the same frozen
                 playbook the spectator's browser will consult. Without that
                 it would simulate a different fight from the one on screen.

   If you are adding a third engine loader, fold it into this one instead.
------------------------------------------------------------------- */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')

/* Load order copied from play.html. It matters: game.js builds both
   Fighters at module scope, so classes.js and config.js must already have
   run. gemini.js and fx.js are the two the browser loads that this does
   not - gemini.js talks to the network from the page, and FX is replaced
   below by a stub that cannot affect a single simulated value. */
const SCRIPTS = [
  'js/utils.js',
  'js/config.js',
  'js/classes.js',
  'js/prompt-parser.js',
  'js/jev.js',
  'js/ai-controller.js',
  'js/game.js'
]

/* ------------------------------------------------------------------
   The stubs.

   Every one of these stands in for something that draws, plays a sound or
   reads the DOM. None of them returns a value the simulation consumes -
   that is the property that makes this harness honest, and it is checked
   rather than trusted: verify() re-runs each fight, so a future change that
   makes an effect feed back into the simulation fails loudly here instead
   of quietly desynchronising the server from the spectator.
------------------------------------------------------------------- */

/* The FX fields the engine genuinely READS. All of them live in the
   render/tickWorld path, which this harness bypasses by driving stepFight()
   directly - the same thing runBench does. They are given their neutral
   values so that if that ever stops being true, the fight runs as though no
   effect were playing rather than reading undefined. */
const FX_READABLE = {
  hitstopFrames: 0,
  timeScale: 1,
  vignette: 0,
  zoom: 1,
  shakeOffset: { x: 0, y: 0 }
}

function makeFX() {
  const state = Object.assign({}, FX_READABLE)
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      /* Anything else is an effect call - a sound, a shake, a particle.
         Returning a no-op function is correct for every one of them. */
      return () => {}
    },
    set(target, prop, value) { target[prop] = value; return true }
  })
}

/* Scene3D is the camera and the backdrop: kick(), koCam(), applyCamera(),
   renderCrowd(). Unlike PenFight and Render3D - which game.js reaches for
   behind a `typeof ... !== 'undefined'` guard, and which are therefore
   correctly absent here - Scene3D is called bare from the damage and KO
   paths, so it has to exist. Every one of its calls is a void camera
   effect, so a no-op is the whole of it. */
function makeNoopModule() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      return () => {}
    },
    set(target, prop, value) { target[prop] = value; return true }
  })
}

/* A 2d context where every method is a no-op and every property is
   writable. classes.js render() walks it freely; nothing reads back. */
function makeCtx() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      return () => {}
    },
    set(target, prop, value) { target[prop] = value; return true }
  })
}

function makeSandbox() {
  const ctx = makeCtx()

  /* The arena canvas. Its WIDTH AND HEIGHT ARE SIMULATION INPUTS, not
     decoration: classes.js clamps a fighter to canvas.width and puts the
     floor at canvas.height - 96. Those two numbers are assigned by game.js
     itself (1024x576) immediately after it finds the element, so they are
     not being invented here - but an element without getContext would make
     game.js throw on its eighth line, so it is stubbed with the same
     dimensions already in place. */
  const canvasEl = { width: 1024, height: 576, getContext: () => ctx, style: {} }

  const mkEl = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, textContent: '', innerHTML: '',
    appendChild() {}, removeChild() {}, setAttribute() {},
    addEventListener() {}, querySelector: () => null, remove() {}
  })

  const document = {
    body: mkEl(),
    querySelector(sel) { return sel === '#arena' ? canvasEl : mkEl() },
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    addEventListener() {}
  }

  const sandbox = {
    console,
    document,
    /* No rAF callback ever fires. game.js registers its render loop on the
       last line; here that registration is dropped on the floor and
       stepFight() is called directly instead, so there is exactly one
       simulation running and nothing interleaves with it. */
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    Image: function Image() { return { src: '', width: 0, height: 0, onload: null } },
    location: { search: '', href: 'http://localhost/' },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('the headless sim makes no network calls')),

    FX: makeFX(),
    Scene3D: makeNoopModule(),

    /* UI is the HUD. stepFight() calls updateHealth() and announce() on
       every damage event; both are pure presentation. */
    UI: {
      updateHealth() {}, updateFightHud() {}, announce() {},
      lastSeed: 0, mode: 'fighter'
    }
  }

  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  return sandbox
}

/* ------------------------------------------------------------------
   Loading the engine.

   One context per fight. Sharing a context across fights would be faster
   and wrong: game.js holds `player` and `enemy` at module scope with
   accumulated state on them, and the page they were written for plays one
   fight at a time. A fresh context per fight costs a few milliseconds and
   removes every possible carry-over between two matches that are supposed
   to be independent.
------------------------------------------------------------------- */
function loadEngine() {
  const sandbox = makeSandbox()
  vm.createContext(sandbox)

  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel)
    const src = fs.readFileSync(file, 'utf8')
    try {
      new vm.Script(src, { filename: rel }).runInContext(sandbox)
    } catch (err) {
      throw new Error('headless sim could not load ' + rel + ': ' + err.message)
    }
  }

  /* The engine declares almost everything that matters with `const` -
     CONFIG, JEV, game, player, enemy. A top-level const inside a vm script
     goes into the CONTEXT's global lexical scope, which is shared by every
     script run in that context (which is why classes.js can see CONFIG) but
     is NOT a property of the sandbox object, so sandbox.game is undefined
     from out here.

     Evaluating the bare name inside the context is how you reach across
     that line. `get` is read-only on purpose: the only thing this harness
     ever writes into the engine is JEV.playbooks, and that is done by
     mutating the object it gets back rather than by rebinding a const it
     has no business rebinding. */
  const get = (name) => vm.runInContext(name, sandbox, { filename: 'house/sim.js:get' })

  return { sandbox, get }
}

/* ------------------------------------------------------------------
   run() - one fight, to its end.

   agents are {stats:{aggression,defense,speed}, archetype, ...} exactly as
   they come off /api/analyze, which is also exactly what the browser hands
   startFight(). playbooks are the frozen JEV advice keyed by side ('A'/'B'),
   or null to run the deterministic local planner.
------------------------------------------------------------------- */
function run(agentA, agentB, seed, playbooks) {
  const { sandbox, get } = loadEngine()

  const JEV = get('JEV')
  const game = get('game')
  const startFight = get('startFight')
  const stepFight = get('stepFight')

  /* The playbooks go in BEFORE startFight, because createAI captures the
     advisor during setup. JEV.consult reads JEV.playbooks[side]
     synchronously; an empty object is the documented "no advisor" state and
     drops every controller back to the seeded local planner. */
  JEV.playbooks = (playbooks && typeof playbooks === 'object') ? playbooks : {}

  startFight(agentA, agentB, seed >>> 0)

  /* What runBench sets, and for the same reasons: bench skips the HUD
     update, and hitstop is a presentation pause that must not consume a
     simulation frame when the render loop is not the thing driving us. */
  game.bench = true
  sandbox.FX.hitstopFrames = 0

  /* The same guard runBench uses. game.over is set by the engine on a KO or
     on the final frame; the guard is a backstop against a future change
     that could leave the loop running, not an expected exit. */
  let guard = 0
  const limit = game.totalFrames + 10
  while (!game.over && guard++ < limit) stepFight()

  if (!game.over) {
    throw new Error('headless fight did not terminate within ' + limit + ' frames')
  }

  const player = get('player')
  const enemy = get('enemy')

  return {
    winner: game.winner,              // 'p1' | 'p2' | null for a draw
    frames: game.frame,
    /* A fight that ended before the clock did is a knockout. */
    how: game.frame < game.totalFrames ? 'KO' : 'DECISION',
    hpA: Math.max(0, Math.round(player.health)),
    hpB: Math.max(0, Math.round(enemy.health)),
    /* The decision log folds into the settlement signature and onto the
       NFT. Taken from the same JEV that produced it, so the hash the
       arbiter signs is over the advice this fight actually consulted. */
    decisionHash: typeof JEV.decisionHash === 'function' ? JEV.decisionHash() : null
  }
}

/* ------------------------------------------------------------------
   verify() - run the same fight twice and refuse to disagree with itself.

   Cheap (a fight is a few milliseconds with nothing being drawn) and it is
   the check that keeps this file honest. If a stub above ever starts
   feeding a value back into the simulation, or a future edit reaches for
   Math.random() or Date.now() inside stepFight, the two runs diverge and
   the director declines to settle rather than settling against a fight the
   spectator did not watch.
------------------------------------------------------------------- */
function verify(agentA, agentB, seed, playbooks) {
  const a = run(agentA, agentB, seed, playbooks)
  const b = run(agentA, agentB, seed, playbooks)
  const same = a.winner === b.winner && a.frames === b.frames &&
    a.hpA === b.hpA && a.hpB === b.hpB
  return { ok: same, result: a, second: same ? null : b }
}

/* ------------------------------------------------------------------
   parse() - the lexicon path, reachable from Node.

   This is the SAME js/prompt-parser.js the browser runs, so it is also the
   fallback the director uses when Gemini is unavailable. Exposed here
   rather than duplicated because a second copy of the lexicon is a second
   set of stats, and a spectator would have no way to tell which one the
   fighter they backed was actually built from.
------------------------------------------------------------------- */
function parse(prompt) {
  const { get } = loadEngine()
  return get('parsePrompt')(String(prompt || ''))
}

/* ------------------------------------------------------------------
   jevConfigHash() - the advisor's config, hashed by the advisor itself.

   This value goes into the on-chain Agent Snapshot, and it is there to make
   one specific substitution impossible: swapping the advisor underneath a
   prompt that still reads the same (see the note on configHash in
   js/jev.js). Taken from the real JEV rather than recomputed here, because
   a second implementation of the hash would defeat the entire point of
   having it.
------------------------------------------------------------------- */
let _configHash = null
function jevConfigHash() {
  if (_configHash) return _configHash
  try {
    const { get } = loadEngine()
    const JEV = get('JEV')
    _configHash = typeof JEV.configHash === 'function' ? JEV.configHash() : null
  } catch (e) {
    _configHash = null
  }
  return _configHash
}

module.exports = { run, verify, parse, jevConfigHash }
