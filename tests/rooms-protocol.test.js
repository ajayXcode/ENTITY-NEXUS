/* Two real Net clients in two vm contexts, talking over Node's own
   BroadcastChannel. Exercises the whole room protocol without a browser. */
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
  // var (not const) so the binding lands on the context's global object.
  const src = ['var NetExport;', utils, net, 'NetExport = Net;'].join('\n')
  vm.runInContext(src, ctx, { filename: tag })
  return ctx.NetExport
}

let fails = 0
const check = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''))
  if (!cond) fails++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const fighter = (side, prompt, atk) => ({
  prompt,
  stats: { aggression: atk, defense: 0.4, speed: 0.5 },
  matched: [], improvised: false,
  archetype: 'TEST' + side, tagline: 't', source: 'lexicon'
})

const A = makeClient('A')
const B = makeClient('B')

;(async () => {
  console.log('\n--- joining a room that does not exist ---')
  try {
    await B.join('QQQQ')
    check('unknown code rejected', false)
  } catch (e) {
    check('unknown code rejected', /NO SUCH ROOM/.test(e.message), e.message)
  }

  console.log('\n--- host + join ---')
  const code = await A.host()
  check('code is 4 chars', code.length === 4, code)
  check('host is waiting, not connected', A.status === 'waiting', A.status)
  await B.join(code)
  check('guest connected', B.status === 'connected', B.status)
  check('guest took side 2', B.side === 2)
  await wait(150)
  check('host saw the join', A.status === 'connected', A.status)

  console.log('\n--- commit gates the reveal ---')
  const p1 = 'relentless berserker, attack without mercy'
  const p2 = 'patient counter puncher, punish mistakes'
  A.publishFighter(fighter(1, p1, 0.8))
  A.commit(p1)
  await wait(100)
  check('nothing revealed while only one side has committed', !B.fighters[1])

  B.publishFighter(fighter(2, p2, 0.3))
  B.commit(p2)
  await wait(200)
  check('host received guest fighter', !!A.fighters[2], A.fighters[2] && A.fighters[2].archetype)
  check('guest received host fighter', !!B.fighters[1], B.fighters[1] && B.fighters[1].archetype)
  check('both sides hold both fighters', A.bothReady() && B.bothReady())

  console.log('\n--- the seed both sides must agree on ---')
  const sA = A.deriveSeed(0)
  const sB = B.deriveSeed(0)
  check('seeds identical without being sent', sA === sB, sA + ' / ' + sB)
  // The round nonce is what makes a rematch on the same two prompts a new
  // fight; round-to-round variation is covered properly in roundtest.js.
  A.roundNonce = (A.roundNonce + 1) >>> 0
  check('seed moves with the round nonce', A.deriveSeed() !== sA)

  console.log('\n--- result agreement ---')
  const h1 = A.resultHash('p1', 900, 100, 0)
  const h2 = B.resultHash('p1', 900, 100, 0)
  check('same fight -> same digest', h1 === h2)
  check('different fight -> different digest', h1 !== B.resultHash('p2', 900, 0, 100))

  console.log('\n--- a tampered reveal is caught ---')
  const C = makeClient('C')
  const D = makeClient('D')
  let dropped = null
  const code2 = await C.host()
  await D.join(code2)
  await wait(120)
  C.onPeerLeave = (why) => { dropped = why }
  D.commit('honest prompt')
  C.commit('whatever')
  await wait(100)
  // D hands over a fighter whose prompt is not the one it committed to.
  D._send({ t: 'fighter', parsed: fighter(2, 'a completely different prompt', 0.95) })
  await wait(150)
  check('commit mismatch detected', dropped === 'COMMIT MISMATCH', String(dropped))
  check('tampered fighter not accepted', !C.fighters[2])

  console.log('\n--- code folding ---')
  check('lowercase and spaces', A.normalizeCode(' a3 c7 ') === 'A3C7', A.normalizeCode(' a3 c7 '))
  check('O and 0 fold to Q', A.normalizeCode('oq34') === 'QQ34', A.normalizeCode('oq34'))
  check('I 1 L fold to J', A.normalizeCode('i1lj') === 'JJJJ', A.normalizeCode('i1lj'))
  check('short code stays short', A.normalizeCode('a3').length !== 4)

  console.log('\n--- leaving ---')
  let left = null
  B.onPeerLeave = (why) => { left = why }
  A.leave()
  await wait(150)
  check('bye reaches the peer', left === 'OPPONENT LEFT', String(left))

  console.log('\n--- heartbeat notices a peer that vanishes ---')
  const E = makeClient('E')
  const F = makeClient('F')
  E.PEER_TIMEOUT_MS = 600
  let lostWhy = null
  const code3 = await E.host()
  await F.join(code3)
  await wait(120)
  E.onPeerLeave = (why) => { lostWhy = why }
  F._stopHeartbeat()          // F goes silent without saying goodbye
  await wait(1700)
  check('silent peer times out', lostWhy === 'OPPONENT LOST', String(lostWhy))

  ;[A, B, C, D, E, F].forEach((c) => { try { c.leave() } catch (e) {} })
  console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n')
  process.exit(fails ? 1 : 0)
})()
