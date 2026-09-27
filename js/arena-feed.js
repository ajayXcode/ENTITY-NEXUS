/* ------------------------------------------------------------------
   arena-feed.js - puts a room on the public board so it can be watched.

   A room is found by reading four characters out loud. That works across a
   table and nowhere else, which is fine for the two people fighting and
   useless for everybody else in the building. This file is the other half:
   the host publishes what its room is doing to /api/match, spectate.html
   lists every room that published, and anyone can walk in.

   THE HOST IS THE ONLY WRITER
   One record, one author. The guest sees the same fight but half a second
   apart and through its own UI state, so letting both sides write would put
   two versions of who is winning on the same board entry. The one thing the
   guest owns - its own wallet address - reaches the host over the room relay
   (Net.publishWallet) and the host folds it in. server.js enforces this:
   /api/match/announce rejects any side but 1.

   WHOLE SNAPSHOTS, NOT EVENTS
   Every push is the complete state of the match. A spectator who opens the
   page in the last ten seconds of a fight gets one object and is correct
   immediately - no event log to replay, and no way for a dropped push to
   leave the board permanently wrong. A missed update is repaired by the next
   heartbeat rather than lost.

   WHAT THIS DOES NOT PUBLISH
   Money. Pools, odds and payouts live on ArenaBattle and are read from the
   chain by the spectator's own browser. This file publishes the chain
   matchId and the two fighter addresses - the coordinates of the bet - and
   stops there. If it published a pool it would be a number the chain could
   contradict.

   It also never publishes a prompt that has not been revealed. Commit-reveal
   is the whole reason the fight is fair, and a board that showed player 1's
   strategy while player 2 was still typing would be a way to read it.
------------------------------------------------------------------- */

const ArenaFeed = {
  ENDPOINT: '/api/match',

  /* Slow, because it is only a liveness heartbeat. Every state change pushes
     immediately; this is what stops the record expiring during the ninety
     seconds two players spend typing, and what keeps the crowd count fresh
     on the board for a match where nothing is happening. */
  BEAT_MS: 12000,

  on: false,
  _beat: null,
  _failed: 0,

  /* A relay that is not there is not an error worth showing anyone: the
     room still works over BroadcastChannel, the fight still happens, and the
     only thing lost is that strangers cannot watch. Give up after a few
     refusals rather than retrying into a dead endpoint all match. */
  MAX_FAIL: 4,

  start() {
    if (typeof Net === 'undefined' || Net.side !== 1) return
    this.on = true
    this._failed = 0
    this.phase = 'lobby'
    this._result = null
    this.push()
    if (this._beat) clearInterval(this._beat)
    this._beat = setInterval(() => this.push(), this.BEAT_MS)
  },

  stop(closeIt) {
    if (this._beat) clearInterval(this._beat)
    this._beat = null
    if (closeIt && this.on && Net.code) {
      fetch(this.ENDPOINT + '/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: Net.code, side: 1 }),
        keepalive: true
      }).catch(() => {})
    }
    this.on = false
  },

  /* ---------------- the snapshot ---------------- */

  /* Where the match is, in one word. Told to us at each transition rather
     than sniffed out of the game globals: `game` belongs to the fighting
     game and Pen Fight has its own, so anything that reads one of them is
     wrong for half the modes the board carries.

     The distinctions that matter to a spectator are exactly three - can I
     still bet (lobby / writing / ready), is something happening on screen
     right now (live), is it over (done). */
  phase: 'lobby',
  _result: null,

  setPhase(p) {
    if (p === this.phase) return
    this.phase = p
    if (p === 'live') this._startedAt = Date.now()
    if (p !== 'done') this._result = null
    this.push()
  },

  setResult(who, how) {
    this._result = { winner: (who === 'p1' || who === 'p2') ? who : null, how: how || '' }
    this.phase = 'done'
    this.push()
  },

  /* Revealed only. Before both sides have committed, a fighter is a name on
     an empty seat - which is exactly what a spectator should see, because it
     is what the opponent sees too. */
  _side(n) {
    const seated = n === 1 || Net.connected
    const f = Net.fighters[n]
    const revealed = !!(f && Net.bothCommitted())
    return {
      name: 'PLAYER ' + n,
      seated: seated,
      locked: !!Net.commits[n],
      addr: Net.wallets[n] || '',
      archetype: revealed ? (f.archetype || '') : '',
      tagline: revealed ? (f.tagline || '') : '',
      prompt: revealed ? sanitizePrompt(f.prompt || '') : '',
      stats: revealed && f.stats ? {
        aggression: f.stats.aggression,
        defense: f.stats.defense,
        speed: f.stats.speed
      } : { aggression: 0, defense: 0, speed: 0 }
    }
  },

  snapshot() {
    const chainOn = typeof MONAD !== 'undefined'
    return {
      code: Net.code,
      mode: (typeof UI !== 'undefined' && UI.mode) || 'fighter',
      status: this.phase,
      round: (typeof Rooms !== 'undefined' && Rooms.round) || 1,
      /* No player stake any more: the only money in a match is the betting
         pool, and that is read from the chain by whoever is looking. */
      chain: {
        matchId: Net.chainMatchId || 0,
        arena: chainOn ? MONAD.arenaAddress : '',
        chainId: chainOn ? MONAD.chainIdDec : 0
      },
      p1: this._side(1),
      p2: this._side(2),
      winner: this._result ? this._result.winner : null,
      how: this._result ? this._result.how : '',
      seed: (typeof UI !== 'undefined' && UI.lastSeed) || 0,
      startedAt: this._startedAt || 0
    }
  },

  push() {
    if (!this.on || typeof Net === 'undefined' || !Net.online || Net.side !== 1) return
    if (this._failed >= this.MAX_FAIL) return
    let body
    try {
      body = JSON.stringify({ code: Net.code, side: 1, snap: this.snapshot() })
    } catch (e) {
      return
    }
    fetch(this.ENDPOINT + '/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then((r) => {
      if (r.ok) this._failed = 0
      else this._failed++
    }).catch(() => { this._failed++ })
  }
}

/* The host closing its tab is the difference between a board of live fights
   and a board of ghosts. keepalive on the POST is what lets this go out
   while the tab is already being torn down. */
window.addEventListener('beforeunload', () => { if (ArenaFeed.on) ArenaFeed.stop(true) })
