/* ------------------------------------------------------------------
   mybets.js - every bet this wallet has, and the ones it can claim.

   WHY THIS EXISTS SEPARATELY FROM THE MATCH PANEL

   The claim button used to live only on the selected match. That is fine
   for the ten seconds after a fight ends and useless afterwards: a house
   table recycles its room in twenty-five seconds and the board drops a
   finished record after six minutes, so a payout you did not claim
   immediately became a payout with no button attached to it. The MON was
   never lost - claim() has no deadline - but nothing in the product would
   show you it was there.

   So this asks the chain directly: what has this address bet on, and what
   does it owe me right now.

   HOW IT FINDS THEM

   BetPlaced has `bettor` indexed, so one getLogs call with a topic filter
   returns every bet this wallet has ever placed without scanning anything.
   That is the whole reason this is cheap enough to run on page load.

   Public RPCs cap how many blocks one getLogs may span, and they disagree
   about the cap. So the range is walked in chunks from newest to oldest
   and the walk stops early once it has looked back far enough - a bettor
   wants their recent positions, not an archive. A chunk that fails is
   skipped rather than fatal: a partial list, clearly labelled, beats an
   empty page.

   WHAT IT DELIBERATELY DOES NOT DO

   It does not compute a payout. `claimable(matchId, who)` is the
   contract's own answer and covers winnings, the losing-side refund and a
   cancelled or voided market in one number. Recomputing that here would be
   a second implementation of the thing the user is about to be paid by.
------------------------------------------------------------------- */

const MyBets = {
  /* HOW HARD THIS IS ALLOWED TO HIT THE RPC.

     The first version of this walked 400,000 blocks in 9,000-block chunks:
     forty-five eth_getLogs calls, back to back, on every wallet connect and
     again on every settlement event. A public endpoint rate-limits that
     immediately, and the damage is not confined to this panel - once the
     RPC starts returning 429s, every OTHER read on the page fails too.
     readMatch() returns null, the ledger falls back to paper, and the
     spectate page announces that a perfectly real match "has not staked on
     chain yet". The console fills with MetaMask RPC errors that point
     nowhere near this file.

     So: one wide query first, because `bettor` is an indexed topic and most
     endpoints will serve the whole range in a single call. Chunking is the
     fallback, not the plan, and it is capped hard. A short list that loads
     is worth more than a complete one that takes the page down with it. */
  LOOKBACK: 400000,
  CHUNK: 45000,
  MAX_CHUNKS: 8,
  CHUNK_GAP_MS: 120,

  rows: [],
  loading: false,
  error: null,
  partial: false,

  /* ---------------- reading ---------------- */

  async load() {
    if (this.loading) return this.rows
    if (!Bets.configured() || !Chain.userAddress || typeof ethers === 'undefined') {
      this.rows = []
      return this.rows
    }
    this.loading = true
    this.error = null
    this.partial = false

    try {
      const ids = await this.matchIds()
      const rows = []
      for (const id of ids) {
        const row = await this.row(id)
        if (row) rows.push(row)
      }
      /* Claimable first - that is why anyone opens this - then newest. */
      rows.sort((a, b) => {
        const ca = a.owed > 0n && !a.claimed ? 0 : 1
        const cb = b.owed > 0n && !b.claimed ? 0 : 1
        return ca - cb || b.matchId - a.matchId
      })
      this.rows = rows
    } catch (err) {
      this.error = (err && (err.shortMessage || err.message)) || 'could not read the chain'
      this.rows = []
    }
    this.loading = false
    return this.rows
  },

  /* Every matchId this address has a BetPlaced log for. */
  async matchIds() {
    const c = Bets.readContract()
    if (!c) throw new Error('no RPC')
    const provider = c.runner.provider || c.runner
    const head = await provider.getBlockNumber()
    const floor = Math.max(0, head - this.LOOKBACK)

    const filter = c.filters.BetPlaced(null, Chain.userAddress)
    const seen = new Set()
    const take = (logs) => {
      for (const l of logs) {
        try { seen.add(Number(l.args.matchId)) } catch (e) { /* not ours */ }
      }
    }

    /* One call for the whole range. `bettor` is indexed, so this is a cheap
       filtered query and most endpoints answer it happily. When it works -
       the common case - this panel costs the RPC a single request. */
    try {
      take(await c.queryFilter(filter, floor, head))
      return Array.from(seen).sort((a, b) => b - a)
    } catch (e) {
      /* Refused: usually a block-range cap. Fall through and chunk. */
    }

    /* The fallback, deliberately bounded. Newest first, because a bettor
       cares about what they just did, and capped so that a stingy endpoint
       costs us eight requests rather than fifty. Anything older than that
       is reported as missing rather than hunted for. */
    let calls = 0
    for (let to = head; to > floor && calls < this.MAX_CHUNKS; to -= this.CHUNK) {
      const from = Math.max(floor, to - this.CHUNK + 1)
      calls++
      try {
        take(await c.queryFilter(filter, from, to))
      } catch (e) {
        this.partial = true
      }
      /* A breath between calls. Back-to-back requests are what trips a
         rate limiter, and this panel is never urgent. */
      if (to - this.CHUNK > floor && calls < this.MAX_CHUNKS) {
        await new Promise((r) => setTimeout(r, this.CHUNK_GAP_MS))
      }
    }
    if (calls >= this.MAX_CHUNKS) this.partial = true

    return Array.from(seen).sort((a, b) => b - a)
  },

  async row(matchId) {
    const c = Bets.readContract()
    if (!c) return null
    try {
      const m = await Bets.readMatch(matchId)
      if (!m) return null
      const a = await Bets.myBet(matchId, MONAD.SIDE_A)
      const b = await Bets.myBet(matchId, MONAD.SIDE_B)
      if (a === 0n && b === 0n) return null
      return {
        matchId: matchId,
        state: m.stateName,
        winner: m.winner,
        mineA: a,
        mineB: b,
        stake: a + b,
        nameA: (m.agents.A && m.agents.A.archetype) || 'SIDE A',
        nameB: (m.agents.B && m.agents.B.archetype) || 'SIDE B',
        refundable: m.refundable,
        settled: m.stateName === 'settled',
        owed: await Bets.expectedPayout(matchId),
        claimed: await Bets.hasClaimed(matchId)
      }
    } catch (e) {
      return null
    }
  },

  /* ---------------- painting ---------------- */

  paint() {
    const host = document.querySelector('#mb-list')
    const panel = document.querySelector('#my-bets')
    if (!host || !panel) return

    panel.classList.toggle('hidden', !Bets.configured())

    const note = document.querySelector('#mb-note')
    const btn = document.querySelector('#mb-refresh')
    if (btn) btn.disabled = this.loading

    if (!Chain.userAddress) {
      host.innerHTML = ''
      if (note) note.textContent = 'Connect a wallet to see the bets it has placed.'
      return
    }
    if (this.loading) {
      if (note) note.textContent = 'reading ' + MONAD.chainName + '…'
      return
    }
    if (this.error) {
      host.innerHTML = ''
      if (note) note.textContent = 'Could not read your bets: ' + this.error
      return
    }

    host.innerHTML = ''
    if (!this.rows.length) {
      if (note) {
        note.textContent = 'No bets from ' + short(Chain.userAddress) + ' yet.' +
          (this.partial ? ' (Some block ranges could not be read, so this may be incomplete.)' : '')
      }
      return
    }

    let claimable = 0n
    for (const r of this.rows) if (r.owed > 0n && !r.claimed) claimable += r.owed

    if (note) {
      note.textContent = this.rows.length + ' match' + (this.rows.length === 1 ? '' : 'es') +
        (claimable > 0n ? ' · ' + fmtMon(claimable) + ' MON ready to claim' : '') +
        (this.partial ? ' · some block ranges could not be read, so this may be incomplete' : '')
    }

    for (const r of this.rows) host.appendChild(this.rowEl(r))
  },

  rowEl(r) {
    const el = document.createElement('div')
    el.className = 'mb-row'

    const backed = []
    if (r.mineA > 0n) backed.push(fmtMon(r.mineA) + ' on ' + r.nameA)
    if (r.mineB > 0n) backed.push(fmtMon(r.mineB) + ' on ' + r.nameB)

    el.innerHTML =
      '<div class="mb-main">' +
        '<b class="mb-id"></b>' +
        '<span class="mb-backed"></span>' +
      '</div>' +
      '<div class="mb-right">' +
        '<span class="mb-state"></span>' +
        '<span class="mb-owed"></span>' +
      '</div>'

    el.querySelector('.mb-id').textContent = '#' + r.matchId
    /* textContent: an archetype came out of a player's prompt box. */
    el.querySelector('.mb-backed').textContent = backed.join('  ·  ')

    const state = el.querySelector('.mb-state')
    const owed = el.querySelector('.mb-owed')

    if (r.claimed) {
      state.textContent = 'claimed'
      state.className = 'mb-state done'
      owed.textContent = ''
    } else if (r.owed > 0n) {
      state.textContent = r.refundable ? 'refund' : 'won'
      state.className = 'mb-state win'
      owed.textContent = fmtMon(r.owed) + ' MON'
      const b = document.createElement('button')
      b.className = 'btn btn-sm btn-gold mb-claim'
      b.textContent = 'CLAIM'
      b.addEventListener('click', () => this.claim(r, b))
      el.querySelector('.mb-right').appendChild(b)
    } else if (r.settled) {
      state.textContent = 'lost'
      state.className = 'mb-state lost'
      owed.textContent = fmtMon(r.stake) + ' staked'
    } else {
      state.textContent = r.state.replace(/_/g, ' ')
      state.className = 'mb-state open'
      owed.textContent = fmtMon(r.stake) + ' staked'
    }
    return el
  },

  async claim(row, btn) {
    btn.disabled = true
    btn.textContent = 'CLAIMING…'
    try {
      await Bets.claim(row.matchId, () => {})
      row.claimed = true
      btn.remove()
      await this.load()
      this.paint()
      if (typeof Spectate !== 'undefined') {
        Spectate.log('claimed ' + fmtMon(row.owed) + ' MON on match #' + row.matchId, 'ok')
      }
    } catch (err) {
      btn.disabled = false
      btn.textContent = 'CLAIM'
      const msg = (err && (err.shortMessage || err.message)) || 'claim failed'
      if (typeof Spectate !== 'undefined') Spectate.note(msg)
    }
  },

  /* Debounced, and not merely for tidiness.

     refresh() is called from the relay: every settlement and every
     abandoned market on the room being watched. On a floor with several
     tables cycling that is a burst, and each call used to start another
     scan - so the panel could have three or four overlapping walks in
     flight, all hitting the same endpoint, all racing to paint the same
     list. That is how a page rate-limits itself out of working.

     One scan at a time, and at most one per window. A bet that lands
     during the quiet period shows up on the next event or on REFRESH. */
  MIN_GAP_MS: 8000,
  _last: 0,
  _timer: null,

  async refresh(force) {
    if (this.loading) return
    const since = Date.now() - this._last
    if (!force && since < this.MIN_GAP_MS) {
      /* Not dropped - deferred, so the last event in a burst still gets a
         refresh once the window closes. */
      if (this._timer) return
      this._timer = setTimeout(() => {
        this._timer = null
        this.refresh(true)
      }, this.MIN_GAP_MS - since)
      return
    }
    this._last = Date.now()
    this.paint()          // show the loading note
    await this.load()
    this._last = Date.now()
    this.paint()
  },

  init() {
    /* The button bypasses the debounce - a person pressing REFRESH has
       asked for it and should not be told to wait. */
    const btn = document.querySelector('#mb-refresh')
    if (btn) btn.addEventListener('click', () => this.refresh(true))
    this.paint()
  }
}
