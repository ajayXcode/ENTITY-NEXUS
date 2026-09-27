/* ------------------------------------------------------------------
   tests/house-market.test.js - no fight without a backer on each side.

   This is the rule the whole market rests on, so it is tested against a
   fake chain rather than the real one: every branch here costs gas on
   Monad, and two of them (the empty window, the one-sided window) are
   exactly the ones nobody would remember to reproduce by hand.

   What is being pinned down:

     - both sides backed        -> the match starts
     - nobody bet               -> lapses, is NOT started, and is NOT
                                   cancelled either, because cancelling an
                                   empty market is a transaction that
                                   refunds nobody
     - one side backed          -> lapses, is NOT started, and IS
                                   cancelled, so the person who did bet can
                                   claim their MON back
     - closed by someone else   -> noticed rather than fought over;
                                   closeBetting is permissionless
     - the seed                 -> folded from the contract's uint256 with
                                   every bit kept, never truncated

   The fake chain implements the same four methods house/market.js calls,
   and counts what was sent. If Market ever starts a match it should not
   have, `started` is non-zero and this fails.
------------------------------------------------------------------- */

const { Market } = require('../house/market.js')
const { foldSeed } = require('../house/seed.js')

let failures = 0
const fail = (m) => { console.error('  FAIL  ' + m); failures++ }
const ok = (m) => console.log('  ok    ' + m)
const is = (got, want, what) => {
  if (got === want) ok(what + '   ' + got)
  else fail(what + ' - got ' + got + ', wanted ' + want)
}

/* A contract that moves through time as fast as it is asked to. `script`
   is what the pools look like on each successive read. */
function fakeChain(script, opts) {
  const o = opts || {}
  let i = 0
  const calls = { opened: 0, started: 0, cancelled: 0, settled: 0, window: 0 }
  return {
    calls,
    ready: () => true,
    async openHouseMatch(a, b, windowSeconds) {
      calls.opened++
      calls.window = windowSeconds
      return { matchId: 77, arena: '0xarena', chainId: 10143 }
    },
    async pools() {
      const step = script[Math.min(i, script.length - 1)]
      i++
      return {
        state: step.state === undefined ? 3 : step.state,
        poolA: BigInt(step.a),
        poolB: BigInt(step.b),
        closesAt: 1000,
        now: step.now,
        backed: BigInt(step.a) > 0n && BigInt(step.b) > 0n
      }
    },
    async closeAndStart() {
      calls.started++
      return { seed: o.seed || '12345', txHash: '0xstart' }
    },
    async cancel() {
      calls.cancelled++
      return { txHash: '0xcancel' }
    },
    async settleHouseMatch() {
      calls.settled++
      return { txHash: '0xsettle' }
    }
  }
}

/* A market whose waits do not actually wait. */
function market(chain) {
  const m = new Market(chain, { log: () => {}, windowSeconds: 60 })
  m.wait = () => Promise.resolve()
  return m
}

;(async () => {
  console.log('\n--- both sides backed ---')
  {
    const chain = fakeChain([
      { a: '0', b: '0', now: 900 },
      { a: '1000', b: '0', now: 950 },
      { a: '1000', b: '500', now: 1000 }
    ])
    const m = market(chain)
    await m.open({}, {})
    const out = await m.waitForBackers()
    is(out.backed, true, 'both pools non-zero at the close')
    await m.start()
    is(chain.calls.started, 1, 'the match was started')
    is(chain.calls.cancelled, 0, 'nothing was cancelled')
  }

  console.log('\n--- nobody bet ---')
  {
    const chain = fakeChain([
      { a: '0', b: '0', now: 900 },
      { a: '0', b: '0', now: 1000 }
    ])
    const m = market(chain)
    await m.open({}, {})
    const out = await m.waitForBackers()
    is(out.backed, false, 'the window lapsed unbacked')
    const ab = await m.abandon()
    is(chain.calls.started, 0, 'the fight did NOT start')
    is(ab.cancelled, false, 'an empty market was not cancelled')
    is(chain.calls.cancelled, 0, 'no pointless refund transaction was sent')
  }

  console.log('\n--- one side backed, the other empty ---')
  {
    const chain = fakeChain([
      { a: '5000', b: '0', now: 900 },
      { a: '5000', b: '0', now: 1000 }
    ])
    const m = market(chain)
    await m.open({}, {})
    const out = await m.waitForBackers()
    is(out.backed, false, 'one-sided does not count as backed')
    const ab = await m.abandon()
    is(chain.calls.started, 0, 'the fight did NOT start')
    is(ab.cancelled, true, 'the market was cancelled so the bettor can claim')
    is(chain.calls.cancelled, 1, 'exactly one cancel was sent')
  }

  console.log('\n--- somebody else closed the window ---')
  {
    /* state 4 = BettingClosed. closeBetting is permissionless, so this is a
       legitimate thing to walk into, not an error. */
    const chain = fakeChain([{ a: '10', b: '10', now: 950, state: 4 }])
    const m = market(chain)
    await m.open({}, {})
    const out = await m.waitForBackers()
    is(out.lapsed, true, 'noticed that the market had already closed')
    is(out.backed, true, 'and it was backed, so it may still start')
  }

  console.log('\n--- the window the caller asked for ---')
  {
    const chain = fakeChain([{ a: '1', b: '1', now: 1000 }])
    const m = market(chain)
    await m.open({}, {})
    is(chain.calls.window, 60, 'the market opened with the caller\'s window')
  }

  console.log('\n--- the seed ---')
  {
    is(foldSeed('0'), 0, 'zero folds to zero')
    is(foldSeed('4294967295'), 4294967295, 'a full uint32 survives intact')
    /* 2^32 + 7 folds to 1 ^ 7 = 6: the high word is XORed in, not dropped.
       Truncating would give 7 and quietly throw away the top bits. */
    is(foldSeed('4294967303'), 6, 'the high word is XORed in, not truncated')
    const big = (2n ** 255n + 12345n).toString()
    const folded = foldSeed(big)
    is(typeof folded === 'number' && folded >= 0 && folded <= 0xffffffff, true,
      'a full uint256 folds into uint32 range')
    is(foldSeed('not a number'), 0, 'garbage folds to zero rather than throwing')
  }

  console.log('')
  if (failures) {
    console.error(failures + ' failure(s)')
    process.exit(1)
  }
  console.log('market rules ok')
})().catch((e) => {
  console.error('threw: ' + e.message)
  process.exit(1)
})
