/* ------------------------------------------------------------------
   house/market.js - one on-chain match, from open to settled.

   WHAT THIS IS

   The lifecycle of a single ArenaBattle match, written once and used by
   both things that run matches on this server: a house table
   (house/director.js) and a player room (house/rooms-chain.js). They
   differ in where the two agents come from and in who gets told what;
   they do not differ in how a market opens, what it waits for, or how it
   settles - and having two copies of that is how two kinds of match end
   up with two sets of rules.

   THE RULE THIS FILE EXISTS TO ENFORCE

   A fight does not start until BOTH sides have a backer. Not "two bets",
   not "two wallets" - a non-zero pool on A and a non-zero pool on B. That
   is the only version of the rule under which a winner can actually profit:
   with everyone on one side, a pari-mutuel simply hands stakes back.

   Enforced here, on the server, by reading the pools off the contract. Not
   in the contract itself - that would be a redeploy - and not in the
   browser, which cannot be trusted to hold a fight it wants to start. The
   arbiter simply does not call startMatch until pools() says both sides
   are in, and startMatch is onlyArbiter, so nothing else can.

   WHAT HAPPENS WHEN NOBODY COMES

   The contract's betting window is a hard clock (closeBetting is gated on
   block.timestamp and the arbiter may not rush it). When it lapses with a
   side still empty, the market is dead: placeBet requires the deadline not
   to have passed. So the match is abandoned - cancelled on chain if anyone
   put MON in, so they can claim a refund, or simply left if the pools are
   zero and there is nothing to refund - and the caller opens a fresh one.
   That reopen is the "extend the window" the product asks for, done the
   only way this contract allows.

   Nothing in here decides a winner. run() hands back a seed; the caller
   runs the fight (house/sim.js) and hands back a result; settle() signs
   and sends exactly that.
------------------------------------------------------------------- */

const { foldSeed } = require('./seed.js')

const POLL_MS = 4000

class Market {
  /* chain: the object makeHouseChain() returns. log: fn(line). */
  constructor(chain, opts) {
    this.chain = chain
    this.log = (opts && opts.log) || (() => {})
    this.windowSeconds = (opts && opts.windowSeconds) || 90
    this.matchId = 0
    this.arena = ''
    this.chainId = 0
    this.seed = 0            // uint32, folded from the contract's uint256
    this.seedFull = ''       // the contract's own seed, decimal string
    this.pools = null        // last pools() read
    this.stopped = false
  }

  stop() { this.stopped = true }

  wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      if (t.unref) t.unref()
    })
  }

  /* ---- open ---- */

  async open(agentA, agentB) {
    const out = await this.chain.openHouseMatch(agentA, agentB, this.windowSeconds)
    this.matchId = out.matchId
    this.arena = out.arena
    this.chainId = out.chainId
    this.log('match #' + this.matchId + ' open on chain, ' + this.windowSeconds + 's window')
    return out
  }

  /* ---- wait for a backer on each side ----

     Resolves when the window has passed. `backed` says whether both pools
     were non-zero by then. onTick gets every read, so a caller can relay
     the pools to the people watching - the browsers must never be the
     source of these numbers, but they are welcome to display them. */
  async waitForBackers(onTick) {
    let last = null

    /* A HARD WALL-CLOCK CEILING, independent of anything the chain says.

       Every exit below depends on a number read over RPC - the state, or
       the chain's own clock against bettingClosesAt. In testing this loop
       twice sat spinning past the point where those should have released
       it, and the cause was never pinned down: a stale `latest` block, a
       provider that had stopped advancing, an endpoint quietly failing in a
       way that did not throw. Any of those turns a market into a table that
       never fights again, which is worse than any of the causes.

       So the loop cannot outlive the window by more than a margin, whatever
       the chain reports. Falling out here is treated exactly like a lapse:
       the caller abandons the market, refunds whoever bet, and opens a
       fresh one. Nothing is stranded and nothing is assumed. */
    const ceiling = Date.now() + (this.windowSeconds + 90) * 1000

    while (!this.stopped) {
      if (Date.now() > ceiling) {
        this.log('the market clock stopped advancing - abandoning this window rather than hanging')
        return { backed: false, pools: this.pools, lapsed: true, stalled: true }
      }
      let p
      try {
        p = await this.chain.pools(this.matchId)
      } catch (err) {
        this.log('pools read failed (' + err.message + ') - retrying')
        await this.wait(POLL_MS)
        continue
      }
      this.pools = p
      if (onTick) {
        try { onTick(p) } catch (e) { /* a listener must not stop the market */ }
      }

      /* Somebody else (closeBetting is permissionless) may already have
         shut the window. Past BettingOpen there is nothing to wait for. */
      if (p.state !== 3) return { backed: p.backed, pools: p, lapsed: true }

      if (p.now >= p.closesAt) return { backed: p.backed, pools: p, lapsed: true }

      /* Log only when something changed, or the log is a metronome. */
      const key = p.poolA.toString() + '/' + p.poolB.toString()
      if (key !== last) {
        this.log('pools A ' + fmt(p.poolA) + '  B ' + fmt(p.poolB) +
          (p.backed ? '  - both sides backed' : '  - waiting for ' +
            (p.poolA === 0n && p.poolB === 0n ? 'both sides' : p.poolA === 0n ? 'side A' : 'side B')))
        last = key
      }

      const left = p.closesAt - p.now
      await this.wait(Math.min(POLL_MS, Math.max(500, left * 1000)))
    }
    return { backed: false, pools: this.pools, lapsed: false, stopped: true }
  }

  /* ---- nobody came ----

     Cancel if there is anything to refund; otherwise leave it. A Cancelled
     match with zero pools is a transaction that refunds nobody. */
  async abandon() {
    const p = this.pools
    const anyMoney = p && (p.poolA > 0n || p.poolB > 0n)
    if (!anyMoney) {
      this.log('match #' + this.matchId + ' lapsed with empty pools - left as is, nothing to refund')
      return { cancelled: false }
    }
    try {
      const out = await this.chain.cancel(this.matchId)
      this.log('match #' + this.matchId + ' cancelled - ' +
        fmt(p.poolA + p.poolB) + ' MON refundable via claim()')
      return { cancelled: true, txHash: out.txHash }
    } catch (err) {
      /* The contract also lets anyone cancel after BETTING_GRACE, so a
         failure here delays the refund; it never loses it. */
      this.log('cancel failed (' + err.message + ') - refund stays available through the contract timeout')
      return { cancelled: false, error: err.message }
    }
  }

  /* ---- start ----

     Only ever called after waitForBackers said backed. The contract makes
     the seed here, out of the close blockhash and the final pools. */
  async start() {
    const out = await this.chain.closeAndStart(this.matchId)
    this.seedFull = String(out.seed)
    this.seed = foldSeed(out.seed)
    this.log('started, contract seed ' + this.seedFull.slice(0, 14) + '... -> ' + this.seed)
    return { seed: this.seed, seedFull: this.seedFull }
  }

  /* ---- settle ---- */

  async settle(result) {
    const out = await this.chain.settleHouseMatch(this.matchId, result)
    this.log('settled, tx ' + String(out.txHash).slice(0, 12) + '...')
    return out
  }
}

function fmt(wei) {
  const s = wei.toString().padStart(19, '0')
  const whole = s.slice(0, -18)
  const frac = s.slice(-18, -14)
  return whole + '.' + frac
}

module.exports = { Market, POLL_MS }
