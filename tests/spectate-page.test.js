/* ------------------------------------------------------------------
   tests/spectate-page.test.js - spectate.html still loads.

   WHY THIS EXISTS

   spectate.html now loads the fight engine alongside the betting code, and
   these are classic scripts sharing one global scope. That arrangement has
   a specific and nasty failure mode: two files declaring the same top-level
   `const` is a SyntaxError that takes down the ENTIRE page, not just the
   feature - and it happens at parse time, so no amount of defensive code
   inside either file helps.

   The live example is `$`. js/ui.js declares `const $`, js/spectate.js
   declares `function $`, and loading both would blank the page. ui.js is
   therefore deliberately NOT in spectate.html's script list, and `UI` is
   shimmed in js/spectate-fight.js instead. That is an easy thing for a
   future edit to undo by "helpfully" adding ui.js back, and the symptom
   would be a completely dead spectate page.

   So: this reads the actual <script src> list out of spectate.html, in
   order, and runs it. It is not a substitute for opening the page, and it
   does not check that anything is drawn - it checks the one class of
   failure that is invisible until a browser refuses the whole document.

   Run: node tests/spectate-page.test.js
------------------------------------------------------------------- */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = process.argv[2] || path.join(__dirname, '..')

let failures = 0
const fail = (m) => { console.error('  FAIL  ' + m); failures++ }
const ok = (m) => console.log('  ok    ' + m)

/* ---- the script list, read from the page rather than duplicated ---- */

function scriptsOf(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8')
  const out = []
  const re = /<script\s+src="([^"]+)"/g
  let mm
  while ((mm = re.exec(html))) out.push(mm[1].split('?')[0])
  return out
}

const srcs = scriptsOf('spectate.html')

if (!srcs.length) fail('no <script src> tags found in spectate.html')
else ok(srcs.length + ' scripts listed in spectate.html')

/* ui.js is the trap this test is mostly here for. */
if (srcs.some((s) => /\/ui\.js$/.test(s))) {
  fail('spectate.html loads js/ui.js, which declares `const $` and collides ' +
    'with the `$` js/spectate.js defines - this is a page-killing SyntaxError. ' +
    'The three UI methods the engine needs are shimmed in js/spectate-fight.js.')
}

/* ---- a browser, roughly ---- */

function stub() {
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0
      if (k === 'length') return 0
      return stub()
    },
    set() { return true },
    apply() { return stub() },
    has() { return true }
  })
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {},
    textContent: '', innerHTML: '', value: '', className: '',
    width: 1024, height: 576,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    getContext: () => stub(),
    appendChild() {}, removeChild() {}, insertBefore() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    focus() {}, blur() {}, scrollTo() {}
  }
  return el
}

const document = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  head: makeEl('head'),
  querySelector: () => makeEl('div'),
  querySelectorAll: () => [],
  getElementById: () => makeEl('div'),
  createElement: (t) => makeEl(t),
  addEventListener() {},
  readyState: 'complete'
}

const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {}, table() {} },
  document,
  navigator: { userAgent: 'node', language: 'en' },
  location: { search: '', href: 'http://localhost/spectate.html', hostname: 'localhost' },
  history: { replaceState() {} },
  URLSearchParams,
  performance: { now: () => 0 },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  /* No network from a smoke test. A pending promise is closer to the truth
     than a rejection: the page fires these and does not await them. */
  fetch: () => new Promise(() => {}),
  EventSource: function () { return { close() {}, onmessage: null, onerror: null } },
  Image: function () { return { src: '', onload: null } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  AudioContext: function () { return stub() },
  ethers: stub(),
  Math, Date, JSON, Promise, Object, Array, String, Number, Boolean,
  Set, Map, RegExp, Error, BigInt, Proxy, Symbol, isNaN, isFinite,
  parseInt, parseFloat, encodeURIComponent, decodeURIComponent
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.self = sandbox

vm.createContext(sandbox)

/* ---- run them, in the page's own order ---- */

let loaded = 0
for (const src of srcs) {
  const file = path.join(ROOT, src)
  if (!fs.existsSync(file)) {
    fail('spectate.html references ' + src + ', which does not exist')
    continue
  }
  /* The vendored ethers bundle is stubbed above rather than executed: it is
     a large UMD build that expects a real browser, and what is under test
     here is this project's own script order, not ethers. */
  if (/\/vendor\//.test(src)) continue

  const code = fs.readFileSync(file, 'utf8')
  try {
    new vm.Script(code, { filename: src }).runInContext(sandbox)
    loaded++
  } catch (err) {
    fail(src + ' threw while loading: ' + err.message)
  }
}

if (loaded) ok(loaded + ' project scripts executed in page order with no collision')

/* ---- the things the page needs to actually exist afterwards ---- */

const expect = (name, why) => {
  let v
  try { v = vm.runInContext('typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined', sandbox) }
  catch (e) { v = undefined }
  if (v === undefined || v === null) fail(name + ' is not defined after load - ' + why)
  else ok(name + ' is available')
}

expect('Spectate', 'the page has no controller')
expect('SpectateFight', 'nothing can run a house fight on this page')
expect('UI', 'js/game.js calls UI.updateHealth() from inside the damage path')
expect('startFight', 'the engine did not load; no fight can be rendered')
expect('stepFight', 'the engine did not load; no fight can be rendered')
expect('JEV', 'the frozen playbook cannot be applied, so this screen would ' +
  'run a different fight from the one the server settled')

/* SpectateFight must not hand the engine a result it was given. The whole
   argument for rendering the fight here rather than streaming it is that
   this screen reaches its own verdict. */
/* ------------------------------------------------------------------
   The fight is actually shown.

   This failed in the real page and produced no error of any kind: nothing
   called SpectateFight.mount(), so #fight-wrap was never cached, and every
   show/hide is written as `if (this.wrap) ...`. The engine ran the whole
   fight, the room feed narrated FIRST BLOOD and K.O., the winner was
   computed correctly - behind a div that was still display:none.

   A silent failure needs a loud test, so three things are pinned:
   the markup exists, something mounts it, and the mount is reached from
   the page's own init path.
------------------------------------------------------------------- */
{
  const specHtml = fs.readFileSync(path.join(ROOT, 'spectate.html'), 'utf8')
  if (!/id="fight-wrap"/.test(specHtml)) {
    fail('spectate.html has no #fight-wrap - there is nowhere to show a fight')
  } else if (!/id="arena"/.test(specHtml)) {
    fail('spectate.html has no <canvas id="arena"> - js/game.js looks for it at load ' +
      'and builds both fighters against it')
  } else {
    ok('spectate.html has the fight canvas and its wrapper')
  }

  const spSrc = fs.readFileSync(path.join(ROOT, 'js', 'spectate.js'), 'utf8')
  if (!/SpectateFight\.mount\(\)/.test(spSrc)) {
    fail('nothing calls SpectateFight.mount() - #fight-wrap is never cached, so the ' +
      'fight runs but stays hidden and NOTHING reports an error')
  } else {
    ok('spectate.js mounts the fight view')
  }

  /* Reached from init(), not merely present somewhere in the file. */
  const init = spSrc.slice(spSrc.indexOf('\n  init() {'))
  const initBody = init.slice(0, init.indexOf('\n  },'))
  if (!/SpectateFight\.mount\(\)/.test(initBody)) {
    fail('SpectateFight.mount() is not called from Spectate.init() - it may never run')
  } else {
    ok('the mount happens during init')
  }
}

/* ------------------------------------------------------------------
   A winner can actually be paid.

   Payouts are pull-based by design - the contract cannot push MON to every
   bettor at settlement without unbounded gas - so a button is the only way
   anyone gets their money. That makes the button load-bearing, and it was
   broken in the quietest possible way: paintMine() tested
   `onchain.status === 3`, but readMatch() returns `state` / `stateName` and
   never `status`. The comparison was `undefined === 3`, permanently false,
   so CLAIM never appeared on an on-chain match. Nothing errored; the money
   simply sat there.
------------------------------------------------------------------- */
{
  /* Comments stripped first. This file quotes the old broken expression in
     a comment explaining why it was wrong, and a checker that reads
     comments would flag the explanation as the defect. */
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  const spSrc = decomment(fs.readFileSync(path.join(ROOT, 'js', 'spectate.js'), 'utf8'))
  const betSrc = decomment(fs.readFileSync(path.join(ROOT, 'js', 'betting.js'), 'utf8'))

  /* Whatever fields spectate.js reads off an on-chain match must be fields
     readMatch() actually returns. */
  const returned = new Set()
  const block = betSrc.slice(betSrc.indexOf('return {', betSrc.indexOf('async readMatch')))
  for (const m of block.slice(0, 1400).matchAll(/(\w+)\s*:/g)) returned.add(m[1])

  const used = new Set()
  for (const m of spSrc.matchAll(/this\.onchain\.(\w+)/g)) used.add(m[1])

  const bogus = [...used].filter((f) => !returned.has(f) &&
    ['mine', 'owed', 'claimed'].indexOf(f) < 0)   // attached by pollChain
  if (bogus.length) {
    fail('js/spectate.js reads this.onchain.' + bogus.join(', this.onchain.') +
      ' - readMatch() never returns ' + (bogus.length > 1 ? 'those' : 'that') +
      ', so the test is always undefined and fails silently')
  } else {
    ok('every on-chain field spectate.js reads is one readMatch returns')
  }

  if (/onchain\.status\s*===/.test(spSrc)) {
    fail('paintMine still tests onchain.status - readMatch returns stateName, ' +
      'so CLAIM will never show')
  } else if (!/stateName === 'settled'/.test(spSrc)) {
    fail('paintMine does not check for a settled match - CLAIM will never show')
  } else {
    ok('CLAIM appears on a settled match')
  }

  if (!/refundable/.test(spSrc)) {
    fail('a cancelled or voided market leaves money claimable, and nothing checks for it')
  } else {
    ok('CLAIM also appears on a refundable (cancelled/voided) market')
  }
}

const sfSrc = fs.readFileSync(path.join(ROOT, 'js', 'spectate-fight.js'), 'utf8')
if (/payload\.winner|\.winner\s*=/.test(sfSrc)) {
  fail('js/spectate-fight.js reads a winner from its payload - this screen ' +
    'must reach the result by running the fight, or a desync becomes invisible')
} else {
  ok('the fight payload carries no winner; the screen computes its own')
}

/* ------------------------------------------------------------------
   play.html.

   The cabinet gained js/chain-room.js, which holds the bell until the
   market has a backer on each side. It has to load, it has to load BEFORE
   rooms.js (which calls into it from the beginFight gate), and it must not
   collide with anything - the same class of page-killing SyntaxError this
   file exists for.
------------------------------------------------------------------- */
console.log('')
{
  const play = scriptsOf('play.html')
  const iChain = play.indexOf('js/chain-room.js')
  const iRooms = play.indexOf('js/rooms.js')
  const iNet = play.indexOf('js/net.js')

  if (iChain < 0) fail('play.html does not load js/chain-room.js - the room market cannot open')
  else if (iRooms >= 0 && iChain > iRooms) {
    fail('js/chain-room.js loads after js/rooms.js; rooms.js calls ChainRoom from ' +
      'its beginFight gate, so the fight would start ungated')
  } else if (iNet >= 0 && iChain < iNet) {
    fail('js/chain-room.js loads before js/net.js, which it reads Net.side/Net.code from')
  } else {
    ok('play.html loads chain-room.js after net.js and before rooms.js')
  }

  /* rooms.js must route the bell through the gate rather than calling the
     original beginFight directly - that was the bug this replaced. */
  const roomsSrc = fs.readFileSync(path.join(ROOT, 'js', 'rooms.js'), 'utf8')
  if (!/ChainRoom\.begin\(/.test(roomsSrc)) {
    fail('js/rooms.js never calls ChainRoom.begin() - an online room would still ' +
      'start its fight on a timer with no market behind it')
  } else {
    ok('rooms.js hands the bell to the market')
  }
  if (!/startUngated/.test(roomsSrc)) {
    fail('js/rooms.js has no startUngated() - nothing can start the fight once ' +
      'the market IS satisfied')
  } else {
    ok('rooms.js has a single ungated door for the market to open')
  }

  /* The server must never be able to tell a lonely host that their guest
     arrived. See the from:0 guard in js/net.js. */
  const netSrc = fs.readFileSync(path.join(ROOT, 'js', 'net.js'), 'utf8')
  if (!/m\.from === 0/.test(netSrc)) {
    fail('js/net.js does not short-circuit server frames (from: 0) before its ' +
      'presence logic - market updates would read as the opponent arriving')
  } else {
    ok('net.js keeps server frames out of the presence logic')
  }
}

console.log('')
if (failures) {
  console.error(failures + ' failure(s)')
  process.exit(1)
}
console.log('spectate page ok')
