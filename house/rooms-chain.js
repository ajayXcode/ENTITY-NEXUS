/* ------------------------------------------------------------------
   house/rooms-chain.js - a player room's match, run by the server.

   WHAT CHANGED, AND WHY THE SERVER RUNS IT

   Until now a room fight began on a timer in both browsers, on a seed the
   two of them derived between themselves, and putting it on chain was a
   separate button on a separate screen that nobody pressed. The spectator
   page therefore had no matchId to bet against, no seed to replay, and a
   winner nobody could settle. The fight and the market were two products
   pretending to be one.

   Now the host hands the server both fighters the moment both are
   revealed, and from there the SERVER owns the match:

     open       createMatch, submitAgent x2, lockAgents (seed committed),
                openBetting. Both browsers and the board get the matchId.
     wait       until a backer is on EACH side - pools read off the
                contract, relayed to the room so both players watch the
                market fill. The fight does not start before this.
     lapse      if the window closes with a side empty: refund anyone who
                did bet, and reopen a fresh match. The room stays in the
                same holding screen with a new matchId.
     start      closeBetting, startMatch. The CONTRACT makes the seed.
                Both browsers are told that seed and start the fight on
                it - the same fight the server now runs headlessly and the
                same fight every spectator replays.
     report     each browser posts what it saw when its fight ends. No
                wallet, no gas - it is a POST.
     settle     the server settles with the arbiter's key ONLY if nothing
                it heard disagrees with what it computed. A disagreement
                is logged as a dispute and the match is left to the
                contract's own void-and-refund timeout.

   WHY THE AGENTS ARE SUBMITTED BY THE ARBITER, NOT THE PLAYERS

   submitAgent requires msg.sender to be the snapshot's owner. Having each
   player sign their own submission would mean two wallets, two popups and
   two gas payments before a market could open - for a match the players
   put no money into (there are no player stakes; the pool is the only
   money). So the arbiter submits both, as it does for the house, and the
   contract explicitly allows one owner for both sides. The player's
   prompt, stats and archetype are what go on chain; the owner field is
   plumbing.

   WHO REPORTS, AND WHAT THE SERVER DOES ABOUT IT

   Three fights are run for every room match: one in each browser and one
   here. The server settles on its own result, but it REFUSES to if either
   browser reported a different winner or a different frame count. That
   keeps the property the arbiter was built around - two machines that
   watched different fights do not settle - while not depending on a
   browser that may have been closed to make the payout happen at all.
------------------------------------------------------------------- */

const sim = require('./sim.js')
const { Market } = require('./market.js')

/* The on-chain window for a player room. Two people who just spent a
   minute writing strategies will wait this long for a crowd; the board
   shows the countdown. */
const WINDOW_SECONDS = 120

/* Give up on a room whose players have both gone. */
const ORPHAN_MS = 3 * 60 * 1000

/* How long after the fight should have ended to wait for the browsers'
   reports before settling on the server's own result. */
const REPORT_GRACE_MS = 20000

class RoomMatch {
  constructor(code, agents, deps) {
    this.code = code
    this.agents = agents
    this.deps = deps
    this.phase = 'opening'
    this.market = null
    this.matchId = 0
    this.seed = 0
    this.result = null
    this.reports = {}          // side -> what a browser saw
    this.fightStartedAt = 0
    this.stopped = false
    this.pools = null
    this.reopens = 0
  }

  log(msg) { console.log('[room-chain] ' + this.code + ': ' + msg) }

  say(msg) {
    this.deps.fanout(this.code, -1, Object.assign({ v: 1, from: 0 }, msg))
  }

  stop() {
    this.stopped = true
    if (this.market) this.market.stop()
  }

  fightPayload() {
    if (this.phase !== 'live' || !this.result) return null
    return {
      seed: this.seed >>> 0, agents: this.agents, playbooks: {},
      frames: this.result.frames, startedAt: this.fightStartedAt
    }
  }

  /* A browser's account of the fight. Stored, compared at settle time. */
  report(side, r) {
    this.reports[side] = r
    this.log('side ' + side + ' reports ' + r.winner + ' in ' + r.frames + 'f')
  }

  async run() {
    try {
      await this.lifecycle()
    } catch (err) {
      this.log('failed: ' + (err && err.message ? err.message : err))
      this.say({ t: 'chain-failed', error: String(err && err.message || err) })
      this.phase = 'failed'
    }
  }

  async lifecycle() {
    /* ---- open, and keep opening until someone backs each side ---- */
    while (!this.stopped) {
      this.market = new Market(this.deps.chain, { log: (l) => this.log(l), windowSeconds: WINDOW_SECONDS })
      await this.market.open(this.agents.p1, this.agents.p2)
      this.matchId = this.market.matchId
      this.phase = 'betting'
      this.say({ t: 'chain', matchId: this.matchId, pending: false, reopened: this.reopens > 0 })

      const outcome = await this.market.waitForBackers((p) => {
        this.pools = p
        this.say({
          t: 'chain-status', matchId: this.matchId,
          poolA: p.poolA.toString(), poolB: p.poolB.toString(),
          closesAt: p.closesAt, now: p.now, backed: p.backed
        })
      })
      if (this.stopped) return
      if (outcome.backed) break

      await this.market.abandon()
      this.say({ t: 'chain-abandoned', matchId: this.matchId })
      this.reopens++

      /* A room both players left is not worth another match. */
      if (this.deps.playersPresent && !this.deps.playersPresent(this.code)) {
        this.log('both players gone - not reopening')
        this.phase = 'orphaned'
        return
      }
      this.log('reopening (' + this.reopens + ')')
    }
    if (this.stopped) return

    /* ---- start: the contract makes the seed ---- */
    const s = await this.market.start()
    this.seed = s.seed

    /* The server's own run, BEFORE telling the browsers - so the frame
       count is known and the fight can be timed. Nothing about the result
       is sent; the browsers compute their own. */
    const check = sim.verify(this.agents.p1, this.agents.p2, this.seed, null)
    if (!check.ok) throw new Error('headless engine disagreed with itself - refusing to run')
    this.result = check.result

    this.phase = 'live'
    this.fightStartedAt = Date.now()
    this.say({ t: 'chain-start', matchId: this.matchId, seed: this.seed >>> 0, frames: this.result.frames })
    this.log('fight on, seed ' + this.seed + ', ' + (this.result.frames / 60).toFixed(1) + 's')

    await this.wait(Math.round(this.result.frames / 60 * 1000) + REPORT_GRACE_MS)
    if (this.stopped) return

    /* ---- settle, unless a browser saw a different fight ---- */
    this.phase = 'settling'
    const dispute = this.disagreement()
    if (dispute) {
      this.log('DISPUTE - ' + dispute + ' - not settling; voidMatch refunds after the timeout')
      this.say({ t: 'chain-dispute', matchId: this.matchId, why: dispute })
      this.phase = 'disputed'
      return
    }
    const heard = Object.keys(this.reports).length
    this.log('settling on ' + this.result.winner + ' by ' + this.result.how +
      ' (' + heard + ' browser report' + (heard === 1 ? '' : 's') + ' agreed)')
    const out = await this.market.settle(this.result)
    this.phase = 'settled'
    this.say({ t: 'chain-settled', matchId: this.matchId, winner: this.result.winner, txHash: out.txHash })
  }

  disagreement() {
    for (const side of Object.keys(this.reports)) {
      const r = this.reports[side]
      if (r.winner !== this.result.winner) {
        return 'side ' + side + ' saw ' + r.winner + ' win, the server saw ' + this.result.winner
      }
      if (Number(r.frames) !== this.result.frames) {
        return 'side ' + side + ' ended at frame ' + r.frames + ', the server at ' + this.result.frames
      }
    }
    return null
  }

  wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      if (t.unref) t.unref()
    })
  }
}

const RoomMatches = {
  byCode: new Map(),
  byMatchId: new Map(),
  deps: null,

  init(deps) { this.deps = deps },

  ready() { return !!(this.deps && this.deps.chain && this.deps.chain.ready()) },

  /* Host says: both fighters are revealed, put this room on chain. */
  open(code, agents) {
    if (!this.ready()) throw new Error('chain is not configured on this server')
    const old = this.byCode.get(code)
    if (old && ['betting', 'opening', 'live'].indexOf(old.phase) >= 0) {
      return old
    }
    const rm = new RoomMatch(code, agents, this.deps)
    this.byCode.set(code, rm)
    rm.run().then(() => {
      if (rm.matchId) this.byMatchId.set(rm.matchId, rm)
    })
    /* Index by matchId as soon as one exists, for reports. */
    const tick = setInterval(() => {
      if (rm.matchId) { this.byMatchId.set(rm.matchId, rm); clearInterval(tick) }
      if (rm.stopped || rm.phase === 'failed') clearInterval(tick)
    }, 500)
    if (tick.unref) tick.unref()
    return rm
  },

  report(matchId, side, result) {
    const rm = this.byMatchId.get(Number(matchId))
    if (!rm) return { ok: false, error: 'no server-run match with that id' }
    if (side !== 'A' && side !== 'B') return { ok: false, error: 'side must be A or B' }
    rm.report(side, {
      winner: result.winner === 'p1' || result.winner === 'p2' ? result.winner : null,
      frames: Number(result.frames) | 0,
      hp1: Number(result.hp1) || 0,
      hp2: Number(result.hp2) || 0
    })
    return { ok: true, phase: rm.phase }
  },

  fightFor(code) {
    const rm = this.byCode.get(code)
    return rm ? rm.fightPayload() : null
  },

  close(code) {
    const rm = this.byCode.get(code)
    if (rm) rm.stop()
  },

  status() {
    const out = []
    for (const rm of this.byCode.values()) {
      out.push({ code: rm.code, phase: rm.phase, matchId: rm.matchId, reopens: rm.reopens })
    }
    return out
  }
}

/* Forget finished rooms after a while so the maps do not grow forever. */
setInterval(() => {
  for (const [code, rm] of RoomMatches.byCode) {
    const done = ['settled', 'disputed', 'failed', 'orphaned'].indexOf(rm.phase) >= 0
    if (done && Date.now() - (rm.fightStartedAt || 0) > 30 * 60 * 1000) {
      RoomMatches.byCode.delete(code)
      if (rm.matchId) RoomMatches.byMatchId.delete(rm.matchId)
    }
  }
}, 60000).unref()

module.exports = { RoomMatches, WINDOW_SECONDS, ORPHAN_MS }
