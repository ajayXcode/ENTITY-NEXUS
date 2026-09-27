/* ------------------------------------------------------------------
   arena.js - the match lifecycle, and the only thing that talks to it.

   This is the spine of the product: two agents become an on-chain match,
   their strategies go public, a market opens and closes, the fight runs, and
   Monad settles it. Everything the user sees about money comes from here,
   and everything here comes from the contract.

   THE THREE TRUTHS, KEPT APART

     the board    server.js knows which rooms exist and who is in them. A
                  noticeboard. It never sees a MON.
     the relay    the SSE stream that makes the page live rather than polled.
     the chain    ArenaBattle holds every pool, every bet, every payout, and
                  now the agent snapshots too.

   Anything with a number of MON in it is read from the chain and nowhere
   else, so the page cannot disagree with what a claim will actually pay.
   Since the strategies moved on chain, the same is true of them: the prompt
   a bettor reads is the prompt the contract is holding, not one the relay
   reported.

   DEMO MODE IS LABELLED, NOT HIDDEN

   With no deployed contract there is no market and no settlement, and this
   file says so in those words. It does not invent a transaction hash, a
   token id, or a pool. A demo that lies about being on chain is worse than
   one that admits what it is.
------------------------------------------------------------------- */

const Arena = {
  matchId: null,
  side: null,          // 'A' or 'B' - which agent this browser owns
  snap: null,          // last readMatch()
  poll: null,
  countdown: null,
  settling: false,

  /* ---------------- boot ---------------- */

  init() {
    this.bind()
    this.renderChainBanner()
  },

  bind() {
    const on = (sel, ev, fn) => {
      const el = document.querySelector(sel)
      if (el) el.addEventListener(ev, fn)
    }

    on('#btn-arena-connect', 'click', () => this.connect())
    on('#btn-arena-create', 'click', () => this.createAndLock())
    on('#btn-bet-a', 'click', () => this.setSide(MONAD.SIDE_A))
    on('#btn-bet-b', 'click', () => this.setSide(MONAD.SIDE_B))
    on('#btn-bet-place', 'click', () => this.placeBet())
    on('#bet-amount', 'input', () => this.renderQuote())
    on('#btn-bet-close', 'click', () => this.closeBetting())
    on('#btn-arena-claim', 'click', () => this.claim())
  },

  /* A single honest line about what this session can and cannot do. */
  renderChainBanner() {
    const el = document.querySelector('#arena-chain-state')
    if (!el) return
    const why = Chain.whyNotLive()
    if (!why) {
      el.textContent = 'Monad Testnet - live'
      el.className = 'chain-state live'
    } else {
      el.textContent = 'DEMO MODE - ' + why + '. No transaction will be sent.'
      el.className = 'chain-state demo'
    }
  },

  live() {
    return Chain.live()
  },

  /* ---------------- wallet ---------------- */

  async connect() {
    try {
      const addr = await Chain.connectWallet((l) => this.say(l))
      this.say('> connected: ' + short(addr))
      const el = document.querySelector('#arena-wallet')
      if (el) el.textContent = short(addr)
      this.refresh()
    } catch (e) {
      this.say('! ' + e.message)
    }
  },

  /* ==================================================================
     Setup: create -> submit both agents -> lock -> open betting

     Everything here happens BEFORE a single bet can be placed. That
     ordering is the product: by the time the market opens, both strategies
     are public, both snapshots are hashed, the fee is snapshotted and the
     seed is committed. Nothing a player controls can move afterwards.
  ================================================================== */

  async createAndLock() {
    if (!this.live()) {
      this.say('! ' + Chain.whyNotLive())
      this.say('  the fight will still run - it just will not be settled on Monad')
      return
    }

    const a = UI.parsed[1]
    const b = UI.parsed[2]
    if (!a || !b) { this.say('! both fighters must be locked in first'); return }

    try {
      this.say('> opening a match on Monad...')
      const matchId = await Chain.createMatch((l) => this.say(l))
      this.matchId = matchId

      /* Both agents are submitted from this browser when one wallet owns
         both - the normal solo demo. In a two-wallet room each side submits
         its own, because the contract requires msg.sender to be the owner. */
      await Chain.submitAgent(matchId, MONAD.SIDE_A, this.agentFrom(a, 1), (l) => this.say(l))
      await Chain.submitAgent(matchId, MONAD.SIDE_B, this.agentFrom(b, 2), (l) => this.say(l))

      this.say('> strategies are public and frozen')
      await this.lockAndOpen(matchId)
      this.startPolling()
    } catch (e) {
      this.say('! ' + this.reason(e))
    }
  },

  /* lockAgents and openBetting are arbiter-only, so the browser asks rather
     than calls. The arbiter commits to the seed in the same step - before any
     pool exists to grind it against, which is the whole anti-grinding
     argument and only holds because it happens HERE and not later. */
  async lockAndOpen(matchId) {
    this.say('> arbiter: committing a seed and locking the agents...')
    const res = await fetch('/api/arena/lock-open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        matchId: String(matchId),
        arena: MONAD.arenaAddress,
        window: MONAD.BETTING_WINDOW
      })
    })
    if (!res.ok) {
      const b = await res.json().catch(() => ({}))
      throw new Error(b.error || 'arbiter could not lock the match')
    }
    const out = await res.json()
    this.say('  seed commitment ' + String(out.commit).slice(0, 14) + '...')
    this.say('  lockAgents  tx ' + String(out.lockTx).slice(0, 14) + '...')
    this.say('  openBetting tx ' + String(out.openTx).slice(0, 14) + '...')
    this.say('> BETTING IS OPEN for ' + MONAD.BETTING_WINDOW + 's')
  },

  /* Close the market, then have the arbiter reveal the seed and start the
     fight. Closing is permissionless and gated purely on the clock, so this
     browser calling it grants it nothing. */
  async startFight() {
    if (!this.live() || !this.matchId) return null
    try {
      const m = await Chain.readMatch(this.matchId)
      if (m.state === 'betting_open') {
        this.say('> closing the market...')
        await Chain.closeBetting(this.matchId, (l) => this.say(l))
      }

      this.say('> arbiter: revealing the seed...')
      const res = await fetch('/api/arena/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId: String(this.matchId), arena: MONAD.arenaAddress })
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error || 'arbiter could not start the match')
      }
      const out = await res.json()
      this.say('  seed ' + String(out.seed).slice(0, 18) + '...')
      await this.refresh()
      return out.seed
    } catch (e) {
      this.say('! ' + this.reason(e))
      return null
    }
  },

  agentFrom(parsed, seat) {
    return {
      name: parsed.archetype || ('Fighter ' + seat),
      prompt: sanitizePrompt(parsed.prompt || ''),
      archetype: parsed.archetype,
      stats: parsed.stats,
      model: typeof JEV !== 'undefined' ? JEV.modelId() : 'local',
      modelVersion: typeof JEV !== 'undefined' ? JEV.modelVersion : 'builtin'
    }
  },

  /* ==================================================================
     Reading the match
  ================================================================== */

  startPolling() {
    this.stopPolling()
    this.refresh()
    this.poll = setInterval(() => this.refresh(), 5000)
  },

  stopPolling() {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  },

  async refresh() {
    if (!this.matchId || !Chain.configured()) return
    try {
      this.snap = await Chain.readMatch(this.matchId)
      this.render()
    } catch (e) { /* a poll that fails is stale data, not a broken page */ }
  },

  /* ==================================================================
     Rendering

     The economics are never hidden. Total pool, the 5% fee, the 95% that is
     actually distributable and both side pools are on screen at all times,
     and the wording changes the moment betting closes so nobody reads a live
     estimate as a promise.
  ================================================================== */

  render() {
    const m = this.snap
    if (!m) return

    this.renderAgents(m)
    this.renderPools(m)
    this.renderState(m)
    this.renderQuote()
    this.renderMine(m)
  },

  renderAgents(m) {
    for (const side of ['A', 'B']) {
      const a = m.agents[side]
      const host = document.querySelector('#agent-' + side)
      if (!host || !a) continue
      host.innerHTML = ''

      const h = (cls, text) => {
        const d = document.createElement('div')
        d.className = cls
        d.textContent = text
        host.appendChild(d)
        return d
      }

      h('ag-name', a.name)
      h('ag-owner', short(a.owner))
      h('ag-prompt', '"' + a.prompt + '"')
      h('ag-arch', a.archetype)
      h('ag-model', a.model + (a.modelVersion ? ' @ ' + a.modelVersion : ''))
      h('ag-stats',
        'ATK ' + Math.round(a.stats.aggression * 100) +
        '   DEF ' + Math.round(a.stats.defense * 100) +
        '   SPD ' + Math.round(a.stats.speed * 100))
      /* The snapshot hash is the thing a bettor is actually backing. Showing
         it turns "trust the page" into "check the chain". */
      h('ag-hash', 'snapshot ' + String(a.jevConfigHash).slice(0, 10) + '...')
    }
  },

  renderPools(m) {
    const e = Bets.economics(m.poolA, m.poolB)
    const set = (sel, v) => {
      const el = document.querySelector(sel)
      if (el) el.textContent = v
    }

    set('#pool-total', fmtMon(e.total, 3) + ' MON')
    set('#pool-a', fmtMon(e.poolA, 3) + ' MON')
    set('#pool-b', fmtMon(e.poolB, 3) + ' MON')
    set('#pool-fee', (m.feeBps / 100).toFixed(1) + '%  (' + fmtMon(e.fee, 3) + ' MON)')
    set('#pool-dist', fmtMon(e.distributable, 3) + ' MON')

    /* The wording is load-bearing. While the market is open these numbers
       move with every bet, and calling them anything other than an estimate
       would be a promise the contract has not made. */
    const note = document.querySelector('#pool-note')
    if (note) {
      note.textContent = m.state === 'betting_open'
        ? 'Estimates. These move with every bet until the market closes.'
        : m.state === 'settled'
          ? 'Final. Settled on Monad.'
          : 'Pool locked. These ratios are now fixed.'
    }
  },

  renderState(m) {
    const el = document.querySelector('#arena-state')
    if (el) {
      el.textContent = {
        created: 'WAITING FOR AGENTS',
        agents_locked: 'STRATEGIES LOCKED',
        betting_open: 'BETTING OPEN',
        betting_closed: 'POOL LOCKED',
        live: 'FIGHT LIVE',
        settled: 'SETTLED ON MONAD',
        cancelled: 'CANCELLED - REFUNDS OPEN',
        voided: 'VOIDED - REFUNDS OPEN'
      }[m.state] || m.state.toUpperCase()
      el.className = 'arena-state st-' + m.state
    }

    const open = m.state === 'betting_open'
    const form = document.querySelector('#bet-form')
    if (form) form.classList.toggle('locked', !open)
    const place = document.querySelector('#btn-bet-place')
    if (place) place.disabled = !open

    this.renderCountdown(m)
  },

  renderCountdown(m) {
    const el = document.querySelector('#bet-countdown')
    if (!el) return
    if (m.state !== 'betting_open') {
      el.textContent = m.state === 'betting_closed' ? 'BETTING CLOSED' : ''
      return
    }
    const left = Math.max(0, m.closesAt - Math.floor(Date.now() / 1000))
    const mm = Math.floor(left / 60)
    const ss = left % 60
    el.textContent = 'closes in ' + mm + ':' + String(ss).padStart(2, '0')
  },

  setSide(side) {
    this.side = side
    document.querySelector('#btn-bet-a').classList.toggle('on', side === MONAD.SIDE_A)
    document.querySelector('#btn-bet-b').classList.toggle('on', side === MONAD.SIDE_B)
    this.renderQuote()
  },

  /* The odds preview, computed with the contract's own integer arithmetic.
     Floating point here would drift from solidity in the last decimal and
     turn a demo into an argument. */
  renderQuote() {
    const el = document.querySelector('#bet-quote')
    if (!el || !this.snap) return

    const input = document.querySelector('#bet-amount')
    const raw = input ? input.value : ''
    if (!raw || Number(raw) <= 0 || !this.side) { el.textContent = ''; return }

    let amount
    try { amount = ethers.parseEther(String(raw)) } catch (e) { el.textContent = ''; return }

    const mine = this.side === MONAD.SIDE_A ? this.snap.poolA : this.snap.poolB
    const theirs = this.side === MONAD.SIDE_A ? this.snap.poolB : this.snap.poolA
    const q = Bets.quote(amount, mine, theirs)
    if (!q) { el.textContent = ''; return }

    /* A pari-mutuel can return less than the stake. Saying so plainly beats
       letting someone discover it at claim time. */
    const sign = q.profit >= 0n ? '+' : ''
    el.textContent =
      'pays ' + fmtMon(q.payout, 4) + ' MON  (' + sign + fmtMon(q.profit, 4) +
      ', ' + q.multiple.toFixed(3) + 'x) if this side wins'
    el.className = 'bet-quote ' + (q.profit >= 0n ? 'up' : 'down')
  },

  async renderMine(m) {
    if (!Chain.userAddress) return
    const el = document.querySelector('#bet-mine')
    if (!el) return
    try {
      const mine = await Chain.myBets(this.matchId, Chain.userAddress)
      const parts = []
      if (mine.A > 0n) parts.push(fmtMon(mine.A, 3) + ' on A')
      if (mine.B > 0n) parts.push(fmtMon(mine.B, 3) + ' on B')
      el.textContent = parts.length ? 'your bets: ' + parts.join(', ') : ''

      const claim = document.querySelector('#btn-arena-claim')
      if (claim) {
        const owed = mine.claimable
        const can = owed > 0n && !mine.claimed
        claim.classList.toggle('hidden', !can)
        if (can) {
          claim.textContent = (m.state === 'settled' ? 'CLAIM ' : 'REFUND ') + fmtMon(owed, 4) + ' MON'
        }
      }
    } catch (e) { /* not fatal; the claim button simply stays hidden */ }
  },

  /* ==================================================================
     Actions
  ================================================================== */

  async placeBet() {
    if (!this.live()) { this.say('! ' + Chain.whyNotLive()); return }
    if (!this.side) { this.say('! pick a side first'); return }

    const input = document.querySelector('#bet-amount')
    const amount = input ? input.value : ''
    if (!amount || Number(amount) <= 0) { this.say('! enter an amount'); return }

    try {
      await Chain.placeBet(this.matchId, this.side, amount, (l) => this.say(l))
      await this.refresh()
    } catch (e) {
      this.say('! ' + this.reason(e))
    }
  },

  async closeBetting() {
    try {
      await Chain.closeBetting(this.matchId, (l) => this.say(l))
      await this.refresh()
    } catch (e) {
      this.say('! ' + this.reason(e))
    }
  },

  async claim() {
    try {
      const out = await Chain.claim(this.matchId, (l) => this.say(l))
      this.say('> ' + fmtMon(out.amount, 4) + ' MON paid. ' + out.explorer)
      await this.refresh()
    } catch (e) {
      this.say('! ' + this.reason(e))
    }
  },

  /* ==================================================================
     Settlement

     Called by the UI when a fight ends. The browser reports what it saw; the
     arbiter decides whether that is enough to sign; the contract decides
     whether the signature is good. This function's own opinion of who won
     carries no weight anywhere, which is exactly the point.
  ================================================================== */

  async settle(result) {
    if (this.settling) return null
    if (!this.matchId || !this.live()) {
      this.say('! no on-chain match to settle - this was a local fight')
      return null
    }

    this.settling = true
    try {
      const out = await Chain.settle(this.matchId, result, (l) => this.say(l))
      await this.refresh()
      return out
    } catch (e) {
      this.say('! settlement failed: ' + this.reason(e))
      return null
    } finally {
      this.settling = false
    }
  },

  /* Build the settlement payload out of what the simulation actually
     produced. resultDigest commits to the outcome, decisionHash to the whole
     JEV decision sequence; the contract checks both against the agents and
     the seed it is already holding. */
  resultFrom(who, how, info) {
    const i = info || {}
    const winner = who === 'p1' ? MONAD.SIDE_A : who === 'p2' ? MONAD.SIDE_B : 0
    const finishType = winner === 0
      ? MONAD.FINISH.DRAW
      : (how === 'KO' ? MONAD.FINISH.KO : MONAD.FINISH.TIMEOUT)

    return {
      winner,
      finishType,
      resultDigest: this.digest(winner, finishType, i),
      decisionHash: typeof JEV !== 'undefined' ? JEV.decisionHash() : ('0x' + '00'.repeat(32)),
      seed: i.seed !== undefined ? i.seed : UI.lastSeed
    }
  },

  digest(winner, finishType, i) {
    const body = [
      this.matchId,
      winner,
      finishType,
      Math.round(i.hp1 !== undefined ? i.hp1 : 0),
      Math.round(i.hp2 !== undefined ? i.hp2 : 0),
      i.frame !== undefined ? i.frame : 0,
      i.seed !== undefined ? i.seed : UI.lastSeed,
      MONAD.SIM_VERSION
    ].join(':')
    return typeof JEV !== 'undefined' ? JEV._expand(JEV._h(body)) : ('0x' + '00'.repeat(32))
  },

  /* ==================================================================
     Plumbing
  ================================================================== */

  /* A revert reason a user can act on, dug out of ethers' wrapping. */
  reason(e) {
    if (!e) return 'unknown error'
    if (e.reason) return e.reason
    if (e.shortMessage) return e.shortMessage
    if (e.info && e.info.error && e.info.error.message) return e.info.error.message
    return e.message || String(e)
  },

  say(line) {
    const log = document.querySelector('#arena-log')
    if (!log) { console.log('[arena] ' + line); return }
    const d = document.createElement('div')
    d.textContent = line
    log.appendChild(d)
    while (log.children.length > 40) log.removeChild(log.firstChild)
    log.scrollTop = log.scrollHeight
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Arena.init())
  } else {
    Arena.init()
  }
}
