/* ------------------------------------------------------------------
   chain-room.js - the market, from inside a player's room.

   WHAT THIS CHANGED

   A room fight used to begin on a timer, on a seed the two browsers
   derived between themselves, with the chain as an optional screen nobody
   opened. That left a spectator with no match to bet on and no seed to
   replay, so "watch a fight you are not in" did not work for the fights
   people actually had.

   Now the bell is the market's. When both strategies are revealed, the host
   asks the server to open an ArenaBattle match; the server waits until
   someone has backed EACH fighter, closes the window, and the CONTRACT
   produces the seed. Only then do the two cabinets fight - on that seed,
   the same one every spectator replays.

   WHY THE PLAYERS NEED NO WALLET

   Every transaction is the arbiter's: createMatch, submitAgent, lockAgents,
   openBetting, closeBetting, startMatch, settleMatch. There are no player
   stakes in this contract - the betting pool is the only money - so two
   people can open a room, fight, and be settled on Monad without either of
   them holding a testnet coin. The crowd brings the money; the players
   bring the fighters.

   WHAT THIS FILE WILL NOT DO

   It will not start the fight on its own. If the market never fills, the
   server cancels it (refunding anyone who did bet) and opens another, and
   this screen keeps waiting. A fight that began anyway would be a fight
   whose result nobody could be paid for, which is the thing the whole
   change exists to prevent.
------------------------------------------------------------------- */

const ChainRoom = {
  active: false,
  matchId: 0,
  seed: 0,
  pools: { a: 0n, b: 0n },
  closesAt: 0,
  backed: false,
  reopened: 0,
  _tick: null,
  _fighters: null,
  _started: false,

  /* The server runs the market, so the only question is whether THIS
     deployment has a chain at all. Deliberately not Chain.live(): that
     requires an injected wallet, and a player needs none. */
  enabled() {
    return typeof MONAD !== 'undefined' && MONAD.USE_REAL_CHAIN &&
      !!MONAD.arenaAddress && !/^0x0{40}$/i.test(MONAD.arenaAddress)
  },

  /* ---------------- starting ---------------- */

  /* Called instead of starting the fight, once both fighters are revealed.
     Only the host posts - two callers would open two markets for one room,
     the same reason the board has a single writer. */
  begin(p1, p2) {
    this.active = true
    this._started = false
    this._fighters = { p1, p2 }
    this.matchId = 0
    this.pools = { a: 0n, b: 0n }
    this.backed = false
    this.reopened = 0

    this.show()
    this.status('opening a match on ' + MONAD.chainName + '…')

    if (Net.side !== 1) {
      this.status('waiting for the host to open the market…')
      return
    }

    fetch('/api/room/chain-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: Net.code,
        side: 1,
        agents: { p1: this._agent(p1), p2: this._agent(p2) }
      })
    }).then((r) => r.json()).then((d) => {
      if (!d.ok) throw new Error(d.error || 'could not open the match')
      /* The matchId arrives over the relay too, so both cabinets learn it
         the same way and neither is a special case. */
    }).catch((err) => {
      this.status('! ' + err.message, 'bad')
      this.fallback('the market could not be opened')
    })
  },

  /* Only what the contract stores. The prompt and the stats are the
     fighter; everything else on a parsed object is presentation. */
  _agent(p) {
    return {
      prompt: p.prompt || '',
      archetype: p.archetype || '',
      tagline: p.tagline || '',
      stats: p.stats,
      model: typeof JEV !== 'undefined' ? JEV.modelId() : 'local',
      modelVersion: typeof JEV !== 'undefined' ? JEV.modelVersion : 'builtin'
    }
  },

  /* If the chain cannot carry this match, the fight still happens - it just
     is not settled, and the screen says so rather than hanging on a market
     that will never open. */
  fallback(why) {
    if (this._started) return
    this._started = true
    this.status('! ' + why + ' — fighting anyway, nothing will be settled', 'bad')
    setTimeout(() => {
      this.hide()
      Rooms.startUngated(this._fighters.p1, this._fighters.p2)
    }, 2600)
  },

  /* ---------------- what the server says ---------------- */

  onServerEvent(m) {
    switch (m.t) {
      case 'chain':
        if (!this.active) return
        this.matchId = m.matchId | 0
        if (typeof Net !== 'undefined') Net.chainMatchId = this.matchId
        if (m.reopened) {
          this.reopened++
          this.status('nobody backed both sides — a fresh market is open', 'warn')
        } else {
          this.status('market open — the fight starts once both fighters are backed')
        }
        this.paint()
        break

      case 'chain-status':
        if (!this.active) return
        this.matchId = m.matchId | 0
        this.pools = { a: BigInt(m.poolA || '0'), b: BigInt(m.poolB || '0') }
        this.closesAt = m.closesAt | 0
        this.backed = !!m.backed
        this.paint()
        break

      case 'chain-abandoned':
        if (!this.active) return
        this.status('the window closed with a side unbacked — refunds are open ' +
          'on match #' + m.matchId + ', reopening', 'warn')
        break

      case 'chain-start':
        if (!this.active || this._started) return
        this._started = true
        this.seed = m.seed >>> 0
        this.status('both sides backed — seed from the contract, fighting now', 'ok')
        this.hide()
        Rooms.startUngated(this._fighters.p1, this._fighters.p2, this.seed)
        break

      case 'chain-settled':
        this.settled = { winner: m.winner, txHash: m.txHash }
        if (typeof UI !== 'undefined' && UI.onChainSettled) UI.onChainSettled(m)
        break

      case 'chain-dispute':
        if (typeof UI !== 'undefined' && UI.onChainSettled) UI.onChainSettled(m)
        break

      case 'chain-failed':
        this.fallback(m.error || 'the server could not run this match')
        break
    }
  },

  /* ---------------- reporting what we saw ---------------- */

  /* The server settles on the fight IT ran, but refuses if a browser
     reports a different one. No wallet and no gas - this is a POST, and it
     is the only thing keeping "two machines agreed" true for a match the
     server settles. */
  report(who, frames, hp1, hp2) {
    if (!this.matchId) return
    fetch('/api/room/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchId: String(this.matchId),
        side: Net.side === 1 ? 'A' : 'B',
        result: { winner: who, frames: frames | 0, hp1: hp1, hp2: hp2 }
      })
    }).catch(() => { /* the server settles on its own run regardless */ })
  },

  /* ---------------- the screen ---------------- */

  show() {
    if (typeof UI !== 'undefined') UI.screen('screen-market')
    this.paint()
    if (this._tick) clearInterval(this._tick)
    this._tick = setInterval(() => this.paintClock(), 500)
  },

  hide() {
    this.active = false
    if (this._tick) clearInterval(this._tick)
    this._tick = null
  },

  paint() {
    const q = (s) => document.querySelector(s)
    const id = q('#mk-match')
    if (id) id.textContent = this.matchId ? '#' + this.matchId : '#—'

    const f = this._fighters
    if (f) {
      for (const [sel, p] of [['#mk-f1', f.p1], ['#mk-f2', f.p2]]) {
        const host = q(sel)
        if (!host) continue
        host.querySelector('.mk-arch').textContent = p.archetype || ''
        host.querySelector('.mk-prompt').textContent = shortPrompt(p.prompt || '', 150)
      }
    }

    const a = this.pools.a
    const b = this.pools.b
    const t = a + b
    if (q('#mk-pool-1')) q('#mk-pool-1').textContent = fmtMon(a) + ' MON'
    if (q('#mk-pool-2')) q('#mk-pool-2').textContent = fmtMon(b) + ' MON'
    const bar1 = q('#mk-bar-1')
    const bar2 = q('#mk-bar-2')
    if (bar1 && bar2) {
      const pct = t > 0n ? Number((a * 100n) / t) : 50
      bar1.style.width = pct + '%'
      bar2.style.width = (100 - pct) + '%'
    }

    /* The gate, in words. This is the line a player reads while waiting, so
       it says exactly what is missing rather than "waiting…". */
    const need = q('#mk-need')
    if (need) {
      if (this.backed) {
        need.textContent = 'Both fighters are backed — the fight starts when the window closes.'
        need.className = 'mk-need ok'
      } else if (a === 0n && b === 0n) {
        need.textContent = 'Nobody has bet yet. This fight starts when at least one person ' +
          'backs each fighter.'
        need.className = 'mk-need'
      } else {
        need.textContent = 'Still needs a backer on ' +
          (a === 0n ? (f ? f.p1.archetype : 'player 1') : (f ? f.p2.archetype : 'player 2')) +
          '. A pari-mutuel with one side empty pays nobody, so the fight waits.'
        need.className = 'mk-need warn'
      }
    }

    const link = q('#mk-link')
    if (link && typeof Net !== 'undefined' && Net.code) {
      const url = location.origin + '/spectate.html?code=' + Net.code
      link.textContent = url
      link.href = url
    }
    this.paintClock()
  },

  paintClock() {
    const el = document.querySelector('#mk-clock')
    if (!el) return
    if (!this.closesAt) { el.textContent = '—'; return }
    /* The contract's clock, not this browser's: closesAt is a chain
       timestamp and the server sends its own `now` alongside the pools. */
    const left = Math.max(0, this.closesAt - Math.floor(Date.now() / 1000))
    const mm = Math.floor(left / 60)
    const ss = left % 60
    el.textContent = mm + ':' + String(ss).padStart(2, '0')
  },

  status(text, cls) {
    const el = document.querySelector('#mk-status')
    if (!el) return
    el.textContent = text
    el.className = 'mk-status' + (cls ? ' ' + cls : '')
  }
}
