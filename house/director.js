/* ------------------------------------------------------------------
   house/director.js - the house runs its own floor.

   WHAT THIS IS

   A few tables, each cycling through the pairs in house/fixtures.js
   forever, so that spectate.html is never an empty page: a judge who opens
   the link with nobody else on the server still finds fights to read,
   pools to join and a payout to claim.

   WHAT IT IS NOT

   It is not a second, easier path through the system. A house match uses
   the same stat engine, the same JEV advisor, the same relay, the same
   board, the same contract, the same market rules (house/market.js) and
   the same arbiter as a match between two humans. The only thing the house
   supplies is the two prompts and the patience to sit through the clock.

   THE ONE HONEST DIFFERENCE, STATED WHERE IT CANNOT BE MISSED

   A player match has two browsers that each run the fight and report it,
   and the arbiter refuses to sign if they disagree. A house match has no
   players, so there is one reporter: this process. Every house match is
   flagged `house: true` on the board and labelled on the page. What IS
   still true of them, precisely:

     - the fight is real. house/sim.js runs the actual engine, and every
       spectator's browser replays the same seed and the same frozen
       playbooks and reaches the same end. The server reads a winner; it
       does not choose one.
     - the seed is not the server's to pick. It is committed before betting
       opens and finalised by the CONTRACT out of the close blockhash and
       the final pools. The house cannot aim a fight at its own book.
     - the money is real and pull-based. Nothing here can touch a pool.

   A TABLE DOES NOT FIGHT FOR AN EMPTY ROOM

   Same rule as every match: no fight until both sides have a backer. A
   table that opens a market and gets nobody abandons it (refunding anyone
   who did come) and opens another - with a growing pause between tries,
   because a table nobody is watching that re-creates a match every ninety
   seconds is a gas bill, not a floor.

   WHY ONLY THE CHAIN TABLES RUN WHEN THE CHAIN IS UP

   An earlier version ran extra "paper" tables alongside the on-chain ones.
   With the both-sides-backed rule that stops making sense: a paper table
   cannot see a bet (paper bets live in each browser's localStorage), so it
   could never legitimately start. Paper tables now exist only when there is
   no chain at all - a laptop with no ARBITER_PRIVATE_KEY - where they run
   ungated, labelled, so the page can still be developed against something.

   THE ORDER OF OPERATIONS IS THE WHOLE DESIGN

   create -> lock (seed committed, no pool exists yet) -> open -> the crowd
   backs a side -> close, on the clock -> start: the CONTRACT makes the seed
   -> only now run the fight -> settle. Simulating before `start` would mean
   the house knew the outcome while the market was open.
------------------------------------------------------------------- */

const crypto = require('crypto')

const { PAIRS } = require('./fixtures.js')
const sim = require('./sim.js')
const { Market } = require('./market.js')

/* Wall-clock phases. The betting window itself is the contract's clock,
   set per market below. */
const PHASE = {
  lobby: 6000,
  writing: 10000,
  settling: 6000,
  done: 25000,
  /* Paper only - there is no contract clock to wait on. */
  paperBetting: 45000
}

/* How long a house market stays open on chain. Long enough for someone
   reading two strategies to decide and get a wallet popup through; short
   enough that a judge who backs a side is not waiting minutes for the
   bell. Above ~90s the wait reads as broken. */
const WINDOW_SECONDS = 75

/* After N empty windows in a row, the table waits this long before opening
   another. Capped: a table should come back within a few minutes of anyone
   arriving, and the board says when. */
const BACKOFF_MS = [0, 45000, 120000, 240000]

const STAGGER = 9000
const MODE = 'fighter'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function makeCode(taken) {
  for (let tries = 0; tries < 200; tries++) {
    let s = ''
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    if (!taken(s)) return s
  }
  return null
}

class Table {
  constructor(index, deps, useChain) {
    this.index = index
    this.deps = deps
    this.useChain = !!useChain
    this.code = null
    this.phase = 'idle'
    this.timer = null
    this.stopped = false
    this.cycle = 0
    this.emptyStreak = 0
    this.reset()
  }

  /* Tables walk the fixture list together but out of step, so every pair
     is seen over time and two tables are never fighting the same one. */
  get pair() {
    const n = this.deps.tableCount || 1
    return PAIRS[(this.index + this.cycle * n) % PAIRS.length]
  }

  reset() {
    this.agents = { p1: null, p2: null }
    this.playbooks = null
    this.market = null
    this.seed = 0
    this.result = null
    this.chain = { matchId: 0, arena: '', chainId: 0 }
    this.pools = null
    this.startedAt = 0
    this.fightStartedAt = 0
    this.reopenAt = 0
  }

  log(msg) {
    console.log('[house] ' + (this.code || '----') + ' ' + this.pair.key + ': ' + msg)
  }

  announce() {
    if (this.code) this.deps.putSnap(this.code, this.snapshot())
  }

  say(msg) {
    if (!this.code) return
    this.deps.fanout(this.code, -1, Object.assign({ v: 1, from: 0, house: true }, msg))
  }

  fightPayload() {
    if (this.phase !== 'live' || !this.result) return null
    return {
      seed: this.seed >>> 0,
      agents: this.agents,
      playbooks: this.playbooks || {},
      frames: this.result.frames,
      startedAt: this.fightStartedAt
    }
  }

  snapshot() {
    const revealed = ['betting', 'live', 'settling', 'done'].indexOf(this.phase) >= 0
    const side = (key, seat) => {
      const a = this.agents[key]
      if (!a || !revealed) {
        return {
          name: '', archetype: '', tagline: '', prompt: '', addr: '',
          stats: { aggression: 0, defense: 0, speed: 0 },
          locked: this.phase === 'writing' ? false : !!a, seated: true
        }
      }
      return {
        name: a.archetype || ('Fighter ' + seat), archetype: a.archetype,
        tagline: a.tagline || '', prompt: a.prompt,
        addr: this.deps.houseAddress() || '', stats: a.stats, locked: true, seated: true
      }
    }
    const status = {
      lobby: 'lobby', writing: 'writing', betting: 'ready',
      live: 'live', settling: 'live', done: 'done'
    }[this.phase] || 'lobby'

    /* What the row should say about the wait, in one line. */
    let note = this.pair.note || ''
    if (this.phase === 'betting' && this.pools) {
      const p = this.pools
      note = p.backed ? 'both sides backed - starts when the window closes'
        : p.poolA === 0n && p.poolB === 0n ? 'needs a backer on each side to start'
        : 'needs a backer on ' + (p.poolA === 0n ? 'player 1' : 'player 2') + ' to start'
    } else if (this.phase === 'lobby' && this.reopenAt > Date.now()) {
      note = 'nobody backed the last market - reopens in ' +
        Math.ceil((this.reopenAt - Date.now()) / 1000) + 's'
    }

    return {
      mode: MODE, status, round: 1, stake: '0',
      chain: this.chain,
      p1: side('p1', 1), p2: side('p2', 2),
      winner: this.result ? this.result.winner : null,
      how: this.result ? this.result.how : '',
      seed: this.seed >>> 0,
      startedAt: this.startedAt,
      house: true,
      houseNote: note,
      paper: !this.useChain
    }
  }

  /* ---------------- the cycle ---------------- */

  async run() {
    while (!this.stopped) {
      try {
        await this.oneMatch()
      } catch (err) {
        this.log('cycle failed: ' + (err && err.message ? err.message : err))
        await this.wait(15000)
      }
      this.cycle++
    }
  }

  wait(ms) {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms)
      if (this.timer.unref) this.timer.unref()
    })
  }

  async oneMatch() {
    this.reset()

    /* NOBODY IS WATCHING: DO NOT SPEND.

       Opening a market that nobody bets on still costs six transactions and
       about 0.1 MON once it is cancelled. A floor left running on a quiet
       server would drain the arbiter overnight and be broke by the time
       someone arrived. So an on-chain table waits here, costing nothing,
       and the board stays empty - which is the truth: there is no market.

       Checked once per cycle rather than continuously, so the first visitor
       waits at most one poll before a table starts seating. */
    if (this.useChain && this.deps.audience) {
      while (!this.stopped && !this.deps.audience()) {
        await this.wait(10000)
      }
      if (this.stopped) return
    }

    this.code = makeCode((c) => this.deps.codeTaken(c))
    if (!this.code) throw new Error('could not allocate a room code')

    /* ---- lobby, with the backoff shown rather than hidden ---- */
    this.phase = 'lobby'
    const backoff = BACKOFF_MS[Math.min(this.emptyStreak, BACKOFF_MS.length - 1)]
    this.reopenAt = Date.now() + backoff
    this.announce()
    this.say({ t: 'house-phase', phase: 'lobby' })
    await this.wait(PHASE.lobby + backoff)
    if (this.stopped) return
    this.reopenAt = 0

    /* ---- writing: the real stat engine on the real prompts ---- */
    this.phase = 'writing'
    this.announce()
    const [a1, a2] = await Promise.all([this.buildAgent(this.pair.p1), this.buildAgent(this.pair.p2)])
    this.agents = { p1: a1, p2: a2 }
    this.say({ t: 'commit', from: 1 })
    this.say({ t: 'commit', from: 2 })
    await this.wait(PHASE.writing)
    if (this.stopped) return

    /* ---- open the market, then wait for a backer on each side ---- */
    let backed = false
    if (this.useChain) {
      backed = await this.runChainMarket()
      if (this.stopped) return
      if (!backed) {
        /* Nobody came. The lobby of the next cycle carries the backoff. */
        this.emptyStreak++
        this.code = null
        return
      }
      this.emptyStreak = 0
    } else {
      await this.runPaperMarket()
      if (this.stopped) return
    }

    /* ---- the advisor, then the fight ---- */
    this.playbooks = await this.buildPlaybooks()
    const check = sim.verify(this.agents.p1, this.agents.p2, this.seed, this.playbooks)
    if (!check.ok) throw new Error('the headless engine disagreed with itself - refusing to settle')
    this.result = check.result

    /* ---- live ---- */
    this.phase = 'live'
    this.fightStartedAt = Date.now()
    this.announce()
    this.say({
      t: 'house-fight', seed: this.seed >>> 0,
      agents: this.agents, playbooks: this.playbooks || {}, frames: this.result.frames
    })
    this.log('fight running, seed ' + (this.seed >>> 0) + ', ' +
      (this.result.frames / 60).toFixed(1) + 's, ' + this.result.how)
    await this.wait(Math.round(this.result.frames / 60 * 1000) + 1200)
    if (this.stopped) return

    /* ---- settle ---- */
    this.phase = 'settling'
    this.announce()
    this.say({ t: 'result', from: 0, winner: this.result.winner, how: this.result.how })
    if (this.market) {
      try {
        const out = await this.market.settle(this.result)
        this.say({ t: 'chain-settled', matchId: this.chain.matchId, winner: this.result.winner, txHash: out.txHash })
      } catch (err) {
        this.log('SETTLEMENT FAILED (' + err.message + ') - bets stay claimable via the contract timeout')
      }
    }

    /* ---- done ---- */
    this.phase = 'done'
    this.announce()
    this.say({ t: 'house-phase', phase: 'done', winner: this.result.winner, how: this.result.how })
    this.log('done - ' + this.result.winner + ' by ' + this.result.how)
    await this.wait(PHASE.done)
    this.code = null
  }

  /* Open on chain, relay the pools while waiting, and either start or
     abandon. Returns true only when the fight may run. */
  async runChainMarket() {
    this.market = new Market(this.deps.chain, {
      log: (l) => this.log(l), windowSeconds: WINDOW_SECONDS
    })
    await this.market.open(this.agents.p1, this.agents.p2)
    this.chain = { matchId: this.market.matchId, arena: this.market.arena, chainId: this.market.chainId }

    this.phase = 'betting'
    this.startedAt = Date.now()
    this.announce()
    this.say({ t: 'fighter', from: 1, parsed: this.agents.p1 })
    this.say({ t: 'fighter', from: 2, parsed: this.agents.p2 })
    this.say({ t: 'chain', matchId: this.chain.matchId })
    this.log('market open  ' + this.agents.p1.archetype + ' vs ' + this.agents.p2.archetype)

    const outcome = await this.market.waitForBackers((p) => {
      this.pools = p
      this.announce()
      this.say({
        t: 'chain-status', matchId: this.chain.matchId,
        poolA: p.poolA.toString(), poolB: p.poolB.toString(),
        closesAt: p.closesAt, now: p.now, backed: p.backed
      })
    })
    if (this.stopped) return false

    if (!outcome.backed) {
      await this.market.abandon()
      this.say({ t: 'chain-abandoned', matchId: this.chain.matchId })
      this.log('window lapsed without a backer on each side - reopening later')
      this.market = null
      return false
    }

    const s = await this.market.start()
    this.seed = s.seed
    return true
  }

  /* No chain: no pools to read, so no gate to apply. Says so on the board. */
  async runPaperMarket() {
    this.phase = 'betting'
    this.startedAt = Date.now()
    this.announce()
    this.say({ t: 'fighter', from: 1, parsed: this.agents.p1 })
    this.say({ t: 'fighter', from: 2, parsed: this.agents.p2 })
    this.log('paper market open (no chain configured - not gated on backers)')
    await this.wait(PHASE.paperBetting)
    this.seed = crypto.randomInt(0xffffffff) >>> 0
  }

  /* ---------------- the stat engine ---------------- */

  async buildAgent(prompt) {
    let out = null
    try {
      out = await this.deps.analyze(prompt, MODE)
    } catch (err) {
      this.log('stat engine unavailable (' + err.message + '), using the lexicon')
    }
    if (!out) {
      const parsed = sim.parse(prompt)
      out = { stats: parsed.stats, archetype: parsed.archetype, tagline: parsed.tagline || '',
        traits: parsed.traits || [], improvised: false, source: 'lexicon' }
    }
    return {
      prompt, stats: out.stats, archetype: out.archetype, tagline: out.tagline || '',
      traits: out.traits || [], improvised: !!out.improvised,
      model: out.model || '', modelVersion: out.modelVersion || '', source: out.source || 'gemini'
    }
  }

  async buildPlaybooks() {
    if (!this.deps.jevDecide) return null
    const key = this.chain.matchId ? String(this.chain.matchId) : 'house-' + this.code + '-' + this.cycle
    const books = {}
    for (const [side, selfKey, oppKey] of [['A', 'p1', 'p2'], ['B', 'p2', 'p1']]) {
      try {
        const out = await this.deps.jevDecide({
          matchId: key, side, self: this.agents[selfKey], opponent: this.agents[oppKey],
          seed: String(this.seed >>> 0)
        })
        if (out && out.playbook) books[side] = out.playbook
      } catch (err) {
        this.log('JEV unavailable for side ' + side + ' - local planner')
      }
    }
    return Object.keys(books).length ? books : null
  }
}

const HouseDirector = {
  tables: [],
  deps: null,

  start(deps) {
    this.deps = deps
    const chainReady = !!(deps.chain && deps.chain.ready())
    const wanted = Math.max(0, parseInt(process.env.HOUSE_CHAIN_TABLES || '2', 10) || 0)

    /* Chain up: only chain tables, gated. Chain down: paper tables so the
       page has something to show, ungated and labelled. Never both. */
    const count = chainReady ? Math.min(wanted, PAIRS.length) : Math.min(3, PAIRS.length)
    deps.tableCount = count
    this.tables = []
    for (let i = 0; i < count; i++) this.tables.push(new Table(i, deps, chainReady))

    console.log('[house] starting ' + count + ' ' + (chainReady ? 'on-chain' : 'paper') +
      ' tables over ' + PAIRS.length + ' pairs (' + (PAIRS.length * 2) + ' strategies)' +
      (chainReady ? '  - a table fights only once both sides are backed' : ''))

    /* Paper is a fallback, not a mode anyone chooses. If the floor has
       landed there, say why on the line right after - a deployment whose
       markets are all imaginary should not have to be diagnosed by
       noticing that no transactions ever appear. */
    if (!chainReady && deps.chain && deps.chain.whyNotReady) {
      const why = deps.chain.whyNotReady()
      if (why) {
        console.warn('[house] PAPER MODE - nothing will be settled on chain.')
        console.warn('[house] reason: ' + why)
      }
    }

    this.tables.forEach((t, i) => {
      const at = setTimeout(() => t.run(), i * STAGGER)
      if (at.unref) at.unref()
    })
  },

  stop() {
    for (const t of this.tables) {
      t.stopped = true
      if (t.market) t.market.stop()
      if (t.timer) clearTimeout(t.timer)
    }
    this.tables = []
  },

  fightFor(code) {
    for (const t of this.tables) if (t.code === code) return t.fightPayload()
    return null
  },

  status() {
    return this.tables.map((t) => ({
      key: t.pair.key, code: t.code, phase: t.phase, chain: t.useChain,
      matchId: t.chain.matchId, cycle: t.cycle, emptyStreak: t.emptyStreak
    }))
  }
}

module.exports = { HouseDirector, PHASE, WINDOW_SECONDS }
