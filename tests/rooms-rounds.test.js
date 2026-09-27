/* Round lifecycle: host-owned nonce, rematches, and coming back after a
   refresh. Regression cover for the two bugs found during the build:
     - _sentFighter left set across rounds, so round 2 never published
     - a host that re-opened its own code never noticed the guest already in */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const ROOT = process.argv[2] || process.cwd()
const utils = fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8')
const net = fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8')

function makeClient(tag) {
  const ctx = {
    BroadcastChannel, setInterval, clearInterval, setTimeout, clearTimeout,
    console, Math, Date, JSON, Promise, Error, String, Number, Object, Array,
    window: { addEventListener() {} }
  }
  vm.createContext(ctx)
  vm.runInContext(['var NetExport;', utils, net, 'NetExport = Net;'].join('\n'), ctx, { filename: tag })
  return ctx.NetExport
}

let fails = 0
const check = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''))
  if (!cond) fails++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fighter = (side, prompt) => ({
  prompt, stats: { aggression: 0.5, defense: 0.4, speed: 0.5 },
  matched: [], improvised: false, archetype: 'T' + side, tagline: 't', source: 'lexicon'
})

/* What rooms.js does for one round: host opens it, both commit, both
   publish, both derive. Returns the two seeds, which must be equal. */
async function playRound(H, G, n, p1, p2) {
  H.resetRound()
  H.sendNewRound(n, (Math.random() * 0xffffffff) >>> 0)
  await wait(80)

  H.publishFighter(fighter(1, p1)); H.commit(p1)
  G.publishFighter(fighter(2, p2)); G.commit(p2)
  await wait(180)
  return {
    hostReady: H.bothReady(),
    guestReady: G.bothReady(),
    seedH: H.deriveSeed(),
    seedG: G.deriveSeed(),
    nonceH: H.roundNonce,
    nonceG: G.roundNonce
  }
}

;(async () => {
  const H = makeClient('host')
  const G = makeClient('guest')

  const code = await H.host()
  await G.join(code)
  await wait(120)

  console.log('\n--- round 1 ---')
  const r1 = await playRound(H, G, 1, 'berserker, all out attack', 'turtle, block everything')
  check('both sides hold both fighters', r1.hostReady && r1.guestReady)
  check('nonce agreed', r1.nonceH === r1.nonceG, String(r1.nonceH))
  check('seeds agree', r1.seedH === r1.seedG, r1.seedH + ' / ' + r1.seedG)

  console.log('\n--- round 2 (regression: fighters must still publish) ---')
  const r2 = await playRound(H, G, 2, 'assassin, hit and run', 'juggernaut, absorb it all')
  check('both sides hold both fighters', r2.hostReady && r2.guestReady,
    'host=' + r2.hostReady + ' guest=' + r2.guestReady)
  check('seeds agree', r2.seedH === r2.seedG, r2.seedH + ' / ' + r2.seedG)
  check('round 2 is a different fight', r2.seedH !== r1.seedH)

  console.log('\n--- round 3 with the SAME prompts as round 1 ---')
  const r3 = await playRound(H, G, 3, 'berserker, all out attack', 'turtle, block everything')
  check('both sides hold both fighters', r3.hostReady && r3.guestReady)
  check('seeds agree', r3.seedH === r3.seedG)
  check('same prompts still get a new fight', r3.seedH !== r1.seedH,
    'nonce is what stops a rematch replaying')

  console.log('\n--- the guest cannot open a round of its own ---')
  let asked = false
  H.onRoundRequest = () => { asked = true }
  G.requestNewRound()
  await wait(120)
  check('guest request reaches the host', asked)
  const beforeNonce = G.roundNonce
  G.sendNewRound(99, 4242)      // guest tries anyway
  await wait(120)
  check('host ignores a guest-authored round', H.roundNonce !== 4242,
    'host nonce ' + H.roundNonce)

  console.log('\n--- rematch carries one seed to both sides ---')
  let got = null
  G.onRematch = (s) => { got = s }
  H.sendRematch(777777)
  await wait(120)
  check('guest follows the host rematch seed', got === 777777, String(got))

  console.log('\n--- host refreshes and re-opens its own code ---')
  const H2 = makeClient('host-after-refresh')
  H.leave()                     // the old tab goes away
  await wait(80)
  let helloSeen = false
  H2.onPeerHello = () => { helloSeen = true }
  await H2.resume(code, 1)
  check('host is waiting again', H2.status === 'waiting', H2.status)
  // The guest never left, so it has no reason to say hello - only its
  // heartbeat arrives. That has to be enough.
  await wait(1600)
  check('host notices the guest who never left', H2.status === 'connected', H2.status)

  console.log('\n--- guest refreshes and rejoins ---')
  const G2 = makeClient('guest-after-refresh')
  G.leave()
  await wait(80)
  let rejoined = false
  H2.onPeerHello = () => { rejoined = true }
  await G2.resume(code, 2)
  await wait(150)
  check('guest is back in', G2.status === 'connected', G2.status)
  check('host was told', rejoined)

  console.log('\n--- a round after both refreshed ---')
  const r4 = await playRound(H2, G2, 4, 'fresh start, press forward', 'hold the centre')
  check('both sides hold both fighters', r4.hostReady && r4.guestReady)
  check('seeds agree', r4.seedH === r4.seedG, r4.seedH + ' / ' + r4.seedG)

  ;[H, G, H2, G2].forEach((c) => { try { c.leave() } catch (e) {} })
  console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n')
  process.exit(fails ? 1 : 0)
})()
