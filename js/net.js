/* ------------------------------------------------------------------
   net.js - rooms. One player per browser, joined by a short code.

   The reason this file is small: a fight in this cabinet is a pure function
   of (p1 fighter, p2 fighter, seed). startFight() seeds every AI stream off
   mulberry32, so two browsers handed the same three values draw the same
   fight, frame for frame, with nothing crossing the wire after the bell.

   That makes this a lobby problem, not a netcode problem. No rollback, no
   input frames, no tick sync - about 1KB of JSON per match, then silence.

   WHAT TRAVELS, AND WHY IT IS NOT THE PROMPT TEXT
   Early on this sent the raw prompt and let each browser parse it. That was
   correct right up until the Gemini stat engine landed: /api/analyze runs at
   temperature 0.5, so two browsers reading the SAME sentence can come back
   with different stats, and two different fighters means two different
   fights and two different winners. So the analysing side publishes the
   parsed fighter - stats, archetype, the lot - and the other side simulates
   exactly that. Half the Gemini calls, and no way to drift.

   Commit-reveal is here because the round has money on it: hashes go out
   first, the fighter only once both sides are committed, so the second
   player cannot read your strategy and write a counter to it.

   Below the protocol is a driver, and drivers are tried in order so a dead
   transport degrades to the next one instead of to a dead room:

     local   BroadcastChannel, same machine, two tabs. No network at all,
             so it cannot fail - and it is the likeliest demo setup.
     relay   (P3) server.js already serves this page; rooms over SSE + POST
             there are ~80 lines and no new dependency.
     chain   (P3) matchId on ArenaBattle, for when the relay is down.
------------------------------------------------------------------- */

/* Unambiguous read aloud across a table: no O/0, no I/1/L, no S/5.
   4 chars is ~390k rooms, which is 389,999 more than a hackathon needs. */
const ROOM_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'
const ROOM_LEN = 4

const PROTO_VERSION = 1

/* Commit hash. Not crypto - crypto.subtle needs a secure context and this
   has to work off a LAN IP at a judging table. Two FNV-1a passes with
   different offsets give 16 hex chars, far past what anyone is brute-forcing
   inside a 60 second prompt clock. */
function promptCommit(text) {
  const s = String(text == null ? '' : text)
  let a = 2166136261 >>> 0
  let b = (0x811c9dc5 ^ 0x9e3779b9) >>> 0
  for (let i = 0; i < s.length; i++) {
    a ^= s.charCodeAt(i); a = Math.imul(a, 16777619)
    b ^= s.charCodeAt(i) + i; b = Math.imul(b, 16777619)
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(a) + hex(b)
}

/* ---------------- driver: local (BroadcastChannel) ----------------
   Same origin, same machine, any number of tabs. There is no server to
   register a room with, so a room "exists" if someone answers: the host
   parks on the channel and replies to any hello, and a join that hears
   nothing back inside JOIN_TIMEOUT reports NO SUCH ROOM rather than sitting
   in a lobby forever waiting for a tab nobody opened. */
const LocalDriver = {
  name: 'local',
  label: 'LOCAL',
  JOIN_TIMEOUT: 1800,

  _ch: null,
  _side: 0,
  _ackWaiter: null,
  onMessage: null,

  available() { return typeof BroadcastChannel === 'function' },

  _open(code) {
    this._ch = new BroadcastChannel('aifighter-room-' + code)
    this._ch.onmessage = (e) => {
      const m = e.data
      /* Our own posts never come back to us, but a third tab on the same
         code would, and a message from our own side is not ours to read. */
      if (!m || m.v !== PROTO_VERSION || m.from === this._side) return
      if (m.t === 'welcome' && this._ackWaiter) this._ackWaiter()
      if (this.onMessage) this.onMessage(m)
    }
  },

  host(code) {
    this._side = 1
    this._open(code)
    return Promise.resolve()
  },

  join(code) {
    this._side = 2
    this._open(code)
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this.close()
        reject(new Error('NO SUCH ROOM'))
      }, this.JOIN_TIMEOUT)

      /* The host's ack doubles as proof the room is real, so the join
         promise settles here rather than in the protocol layer above. */
      this._ackWaiter = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      this.send({ t: 'hello' })
    })
  },

  send(msg) {
    if (!this._ch) return
    msg.v = PROTO_VERSION
    if (msg.from === undefined) msg.from = this._side
    this._ch.postMessage(msg)
  },

  close() {
    if (this._ch) { try { this._ch.close() } catch (err) {} }
    this._ch = null
    this._ackWaiter = null
  }
}

/* ---------------- driver: relay (SSE + POST) ----------------
   Two machines. server.js already serves this page, so the relay lives at
   /api/room on the same origin - no second process, no new dependency, and
   nothing to configure at a judging table.

   Server-sent events downstream, plain POSTs upstream. EventSource reconnects
   by itself when a laptop's wifi blinks, which is most of what a websocket
   would have bought us here for a protocol that moves about 1KB per match.

   The relay is a pipe and is not trusted with anything: commit-reveal, the
   host-owned round nonce and the commit check on every reveal are all
   enforced below, in the browser, exactly as they are over BroadcastChannel. */
const RelayDriver = {
  name: 'relay',
  label: 'RELAY',
  JOIN_TIMEOUT: 3500,

  _es: null,
  _code: null,
  _side: 0,
  _ackWaiter: null,
  onMessage: null,

  available() {
    return typeof EventSource === 'function' && typeof fetch === 'function'
  },

  endpoint() {
    return (typeof CONFIG !== 'undefined' && CONFIG.RELAY_ENDPOINT) || '/api/room'
  },

  _open(code, side) {
    return new Promise((resolve, reject) => {
      this._code = code
      this._side = side
      let es
      try {
        es = new EventSource(this.endpoint() + '/sub?code=' + code + '&side=' + side)
      } catch (err) {
        return reject(new Error('NO RELAY'))
      }
      this._es = es

      let settled = false
      es.onopen = () => {
        if (settled) return
        settled = true
        resolve()
      }
      /* Before the stream opens this means there is no server. After it has
         opened it means the connection dropped, and EventSource is already
         retrying on its own - so it is not ours to report. */
      es.onerror = () => {
        if (settled) return
        settled = true
        try { es.close() } catch (e) {}
        this._es = null
        reject(new Error('NO RELAY'))
      }
      es.onmessage = (e) => {
        let m = null
        try { m = JSON.parse(e.data) } catch (err) { return }
        if (!m || m.v !== PROTO_VERSION || m.from === this._side) return
        if (m.t === 'welcome' && this._ackWaiter) this._ackWaiter()
        if (this.onMessage) this.onMessage(m)
      }
    })
  },

  async host(code) {
    await this._open(code, 1)
  },

  async join(code) {
    await this._open(code, 2)
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this.close()
        reject(new Error('NO SUCH ROOM'))
      }, this.JOIN_TIMEOUT)

      this._ackWaiter = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      this.send({ t: 'hello' })
    })
  },

  send(msg) {
    if (!this._es) return
    msg.v = PROTO_VERSION
    if (msg.from === undefined) msg.from = this._side
    /* keepalive so the `bye` posted from beforeunload still goes out while
       the tab is being torn down - otherwise the other player waits out the
       full heartbeat timeout for a door that was politely closed. */
    fetch(this.endpoint() + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: this._code, side: this._side, msg: msg }),
      keepalive: true
    }).catch(() => {})
  },

  close() {
    if (this._es) { try { this._es.close() } catch (err) {} }
    this._es = null
    this._ackWaiter = null
  }
}

/* ---------------- the room ---------------- */

const Net = {
  online: false,
  driver: null,
  code: null,
  side: 0,                 // 1 = host / PLAYER 1, 2 = guest / PLAYER 2
  status: 'idle',          // idle | waiting | connected | lost
  peerSeen: 0,
  peerResult: null,
  roundNonce: 0,           // host-owned, mixed into every round's seed

  commits: { 1: null, 2: null },
  fighters: { 1: null, 2: null },   // parsePrompt-shaped, ready to simulate

  /* Spectating. The wallets are what a spectator's bet is actually placed
     ON - ArenaBattle.placeSpectatorBet() takes a fighter ADDRESS, not a
     side - so each player publishes their own connected address into the
     room and the host folds both into what it announces to the board.
     Nobody can publish anybody else's: `wallet` is keyed by m.from, and the
     relay stamps the side itself. */
  wallets: { 1: null, 2: null },
  chainMatchId: 0,         // the ArenaBattle match these two staked on
  spectators: 0,           // how many people are watching, per the relay

  /* The UI hangs its callbacks here rather than threading them through every
     call. All optional - an unset hook is an event the UI does not care
     about yet. */
  onPeerJoin: null,
  onPeerHello: null,       // every hello, including a rejoin after refresh
  onPeerLeave: null,
  onNewRound: null,        // (n) the host opened a fresh round
  onRoundRequest: null,    // host only: the guest asked for a fresh round
  onCommit: null,          // (side)
  onFighter: null,         // (side, parsed)
  onGo: null,              // (seed)
  onRematch: null,         // (seed)
  onStatus: null,          // (status)
  onWallet: null,          // (side, address)
  onChainMatch: null,      // (matchId)
  onSpectators: null,      // (n) the crowd changed size

  HEARTBEAT_MS: 1000,
  PEER_TIMEOUT_MS: 5000,

  _beat: null,
  _watch: null,
  _pending: null,          // our own fighter, held until both commits land

  /* Relay first, so a room works across two machines whenever server.js is
     up - which is also the case where two tabs on one machine still work,
     since the relay fans out by side and does not care where a side sits.
     BroadcastChannel is the floor underneath it: no server, no network, so
     a same-machine demo keeps working with nothing running at all. */
  drivers() { return [RelayDriver, LocalDriver] },

  get peerSide() { return this.side === 1 ? 2 : 1 },
  get connected() { return this.status === 'connected' },

  newCode() {
    let s = ''
    for (let i = 0; i < ROOM_LEN; i++) {
      s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]
    }
    return s
  },

  /* Typed codes arrive with stray spaces and the wrong case, and anyone
     reading one off a screen will type O for Q. Fold rather than reject -
     the alphabet has no O, so the intent is never ambiguous. */
  normalizeCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      .replace(/[O0]/g, 'Q')
      .replace(/[IL1]/g, 'J')
      .replace(/[S5]/g, '3')
      .slice(0, ROOM_LEN)
  },

  async host() {
    const code = this.newCode()
    await this._connect((d) => d.host(code), code, 1)
    this._setStatus('waiting')
    return code
  },

  async join(rawCode) {
    const code = this.normalizeCode(rawCode)
    if (code.length !== ROOM_LEN) throw new Error('CODE MUST BE ' + ROOM_LEN + ' CHARACTERS')
    await this._connect((d) => d.join(code), code, 2)
    /* The join handshake only completes once the host has answered, so by
       this line the room is genuinely two-sided. */
    this.peerSeen = Date.now()
    this._setStatus('connected')
    return code
  },

  /* Re-enter a room this browser was already in, after a refresh. The host
     re-opens its own code (there is no registry to have lost it from); the
     guest re-joins, which still requires the host to answer, so a guest
     whose host has gone lands back on the room picker rather than in a
     room of one. */
  async resume(code, side) {
    const c = this.normalizeCode(code)
    if (c.length !== ROOM_LEN) throw new Error('BAD CODE')
    if (side === 1) {
      await this._connect((d) => d.host(c), c, 1)
      this._setStatus('waiting')
    } else {
      await this._connect((d) => d.join(c), c, 2)
      this.peerSeen = Date.now()
      this._setStatus('connected')
    }
    return c
  },

  /* Walk the driver list until one takes the room. A driver that throws is a
     driver that is down, not a dead end - except NO SUCH ROOM, which is a
     real answer from a working transport and must not fall through to the
     next one, or a typo'd code would crawl the whole list before admitting
     it could not find the room. */
  async _connect(fn, code, side) {
    let lastErr = null
    let sawNoRoom = false
    for (const d of this.drivers()) {
      if (!d.available()) continue
      try {
        d.onMessage = (m) => this._onMessage(m)
        await fn(d)
        this.driver = d
        this.code = code
        this.side = side
        this.online = true
        this.peerResult = null
        this.commits = { 1: null, 2: null }
        this.fighters = { 1: null, 2: null }
        this._pending = null
        this._sentFighter = false
        this._startHeartbeat()
        return
      } catch (err) {
        lastErr = err
        d.onMessage = null
        /* NO SUCH ROOM is a real answer from a working transport, not a dead
           one - but it is only the final answer once every transport has
           said it. A room created over BroadcastChannel before the server
           came up is still reachable on BroadcastChannel now. */
        if (String(err && err.message).indexOf('NO SUCH ROOM') >= 0) sawNoRoom = true
      }
    }
    if (sawNoRoom) throw new Error('NO SUCH ROOM')
    throw lastErr || new Error('NO TRANSPORT AVAILABLE')
  },

  leave() {
    if (this.online) this._send({ t: 'bye' })
    this._stopHeartbeat()
    if (this.driver) { this.driver.close(); this.driver.onMessage = null }
    this.driver = null
    this.online = false
    this.code = null
    this.side = 0
    this.peerSeen = 0
    this.peerResult = null
    this.commits = { 1: null, 2: null }
    this.fighters = { 1: null, 2: null }
    this.wallets = { 1: null, 2: null }
    this.chainMatchId = 0
    this.spectators = 0
    this._pending = null
    this._setStatus('idle')
  },

  /* Start a fresh round on a room that is already up: same peers, same
     code, everything about the last fight forgotten. */
  resetRound() {
    this.peerResult = null
    this.commits = { 1: null, 2: null }
    this.fighters = { 1: null, 2: null }
    this._pending = null
    /* Per-round, not per-connection. Left set, _flush would swallow every
       fighter after the first and both sides would wait forever. */
    this._sentFighter = false
  },

  /* ---------------- protocol ---------------- */

  /* Step one: publish a hash of what we are going to fight with. The text is
     what is hashed, because the text is the thing the player authored and
     the only thing the other side can check us against later. */
  commit(text) {
    const h = promptCommit(String(text || ''))
    this.commits[this.side] = h
    this._send({ t: 'commit', hash: h })
    this._flush()
    return h
  },

  bothCommitted() { return !!(this.commits[1] && this.commits[2]) },
  bothReady() { return !!(this.fighters[1] && this.fighters[2]) },

  /* Step two: hand over the parsed fighter. Held until both commits are
     down - releasing it earlier would let a slow-locking opponent read the
     strategy and answer it. */
  publishFighter(parsed) {
    /* Through JSON once: strips anything a structured clone would choke on
       and guarantees the relay driver can send the identical bytes. */
    this._pending = JSON.parse(JSON.stringify(parsed))
    this.fighters[this.side] = this._pending
    this._flush()
  },

  _flush() {
    if (!this._pending) return
    if (!this.bothCommitted()) return
    if (this._sentFighter) return
    this._sentFighter = true
    this._send({ t: 'fighter', parsed: this._pending })
  },

  /* Both fighters are in. The seed has to be identical on both sides and
     derived, never sent - a seed one client picks is a seed that client can
     shop for. Room code plus both commits means neither side can compute it
     before committing.

     Known gap, for P3: player 2 sees player 1's commit before making their
     own, so P2 could grind prompt wording for a seed they like. Mixing in
     the join block hash from the chain driver closes it, because that is a
     number neither side chooses. */
  deriveSeed() {
    return hashString(this.code + '|' + this.commits[1] + '|' + this.commits[2] +
      '|' + (this.roundNonce >>> 0))
  },

  /* A digest each side computes from its own simulation. If these disagree,
     the two browsers watched different fights - worth saying out loud, and
     far better than two screens quietly crowning different winners. */
  resultHash(who, frame, hp1, hp2) {
    return promptCommit([who, frame, Math.round(hp1), Math.round(hp2)].join(':'))
  },

  /* Published as soon as a wallet connects, and again on every hello, so a
     spectator who opens the board mid-match still learns where to send a
     bet. Cheap enough to repeat; there is exactly one address per side. */
  publishWallet(address) {
    if (!address) return
    this.wallets[this.side] = address
    this._send({ t: 'wallet', addr: address })
  },

  /* Host only: the ArenaBattle matchId these two actually staked on. Until
     this lands, a spectator can watch but has nothing to bet against - a
     bet needs an on-chain match, and the room code is not one. */
  publishChainMatch(matchId) {
    this.chainMatchId = matchId | 0
    this._send({ t: 'chain', matchId: this.chainMatchId })
  },

  sendResult(hash) { this._send({ t: 'result', hash: hash }) },
  sendRematch(seed) { this._send({ t: 'rematch', seed: seed >>> 0 }) },

  /* Host only. The nonce is what keeps a rematch between the same two
     prompts from replaying the identical fight, and it has to be one number
     both sides hold - a per-client round counter drifts the moment someone
     refreshes, and a drifted salt is a silent desync. */
  sendNewRound(n, nonce) {
    this.roundNonce = nonce >>> 0
    this._send({ t: 'newround', n: n | 0, nonce: this.roundNonce })
  },
  requestNewRound() { this._send({ t: 'reqround' }) },

  _send(msg) {
    if (!this.driver) return
    msg.from = this.side
    this.driver.send(msg)
  },

  _onMessage(m) {
    /* The server sends this one, not the other player, and it must be dealt
       with before a single line of presence logic runs. Everything below
       treats an inbound frame as proof the opponent is there; a crowd count
       is proof only that somebody is watching, and a host alone in a lobby
       being told the fight can start because a stranger opened the board is
       the exact bug this early return exists to prevent. */
    if (m.t === 'spectators') {
      this.spectators = m.n | 0
      if (this.onSpectators) this.onSpectators(this.spectators)
      return
    }

    /* Everything else the SERVER says, for the same reason and before the
       same line. `from: 0` is the server talking - the market opening, the
       pools moving, the bell - and none of it is evidence that the opponent
       is on the other end of the room. Falling through to the presence
       logic below would let a house table's own chatter, or this room's
       market updates, tell a host sitting alone that their guest arrived. */
    if (m.from === 0) {
      if (this.onServerEvent) this.onServerEvent(m)
      return
    }

    this.peerSeen = Date.now()
    /* Anything at all from the other side means the seat is filled. This is
       what lets a host that refreshed and re-opened its own code notice the
       guest who never went anywhere and so never says hello again. */
    if (this.status === 'waiting' && m.t !== 'bye') this._peerHere()

    switch (m.t) {
      case 'hello':
        /* Host side: someone is on the channel. Answer so their join promise
           resolves, then replay whatever we already locked in - a player who
           joins mid-handshake must not wait forever for a commit that was
           broadcast before they arrived. */
        if (this.side === 1) {
          this._send({ t: 'welcome' })
          if (this.commits[1]) this._send({ t: 'commit', hash: this.commits[1] })
          if (this.wallets[1]) this._send({ t: 'wallet', addr: this.wallets[1] })
          if (this.chainMatchId) this._send({ t: 'chain', matchId: this.chainMatchId })
          this._sentFighter = false
          this._flush()
        }
        /* Both directions. A guest that reconnects has to re-offer its
           address or the host announces a match with one bettable side. */
        if (this.wallets[this.side]) this._send({ t: 'wallet', addr: this.wallets[this.side] })
        this._peerHere()
        /* Fired on every hello, not just the first. A player who refreshes
           mid-match sends one on the way back in, and the side that never
           left has to hear about it - its status never changed, so the join
           hook above would stay silent. */
        if (this.onPeerHello) this.onPeerHello()
        break

      case 'welcome':
        this._peerHere()
        break

      case 'commit':
        this.commits[m.from] = m.hash
        if (this.onCommit) this.onCommit(m.from)
        this._flush()
        break

      case 'fighter': {
        const parsed = m.parsed
        if (!parsed || !parsed.stats) return
        /* The commit is only worth having if it is checked. A fighter whose
           prompt does not hash to what was committed is a changed answer,
           and the round is void rather than quietly played out. */
        const expect = this.commits[m.from]
        if (expect && promptCommit(parsed.prompt || '') !== expect) {
          console.warn('[net] commit mismatch from player ' + m.from)
          this._setStatus('lost')
          if (this.onPeerLeave) this.onPeerLeave('COMMIT MISMATCH')
          return
        }
        this.fighters[m.from] = parsed
        if (this.onFighter) this.onFighter(m.from, parsed)
        break
      }

      case 'wallet': {
        /* Keyed by the sender's own side, never by anything in the payload.
           A player may say where to pay THEM and nothing else. */
        const a = String(m.addr || '')
        if (!/^0x[0-9a-fA-F]{40}$/.test(a)) break
        this.wallets[m.from] = a
        if (this.onWallet) this.onWallet(m.from, a)
        break
      }

      /* Same rule as the round nonce: the match is created by the host, so
         its id has one author. A guest claiming a different matchId is a
         guest pointing the crowd's money at a match of its choosing. */
      case 'chain':
        if (m.from !== 1) break
        this.chainMatchId = m.matchId | 0
        if (this.onChainMatch) this.onChainMatch(this.chainMatchId)
        break

      case 'rematch':
        if (this.onRematch) this.onRematch(m.seed >>> 0)
        break

      case 'newround':
        /* The nonce decides the seed, and the seed decides who wins, so it
           gets exactly one author. A round opened by anyone but the host is
           not a round - it is the guest picking its own seed. */
        if (m.from !== 1) break
        this.resetRound()
        this.roundNonce = m.nonce >>> 0
        if (this.onNewRound) this.onNewRound(m.n | 0)
        break

      /* The guest cannot start a round of its own, because the nonce has one
         owner. It asks; the host answers with a newround. */
      case 'reqround':
        if (this.side === 1 && this.onRoundRequest) this.onRoundRequest()
        break

      case 'result':
        this.peerResult = m.hash
        break

      case 'bye':
        this._setStatus('lost')
        if (this.onPeerLeave) this.onPeerLeave('OPPONENT LEFT')
        break

      case 'ping':
        this._send({ t: 'pong' })
        break

      case 'pong':
        break
    }
  },

  _peerHere() {
    if (this.status === 'connected') return
    this._setStatus('connected')
    if (this.onPeerJoin) this.onPeerJoin()
  },

  /* ---------------- presence ----------------
     A tab that is closed sends `bye`; a tab that crashes, sleeps or loses
     its network does not. The heartbeat is what turns that second case into
     a visible OPPONENT LOST instead of a lobby that waits forever. */
  _startHeartbeat() {
    this._stopHeartbeat()
    this._beat = setInterval(() => this._send({ t: 'ping' }), this.HEARTBEAT_MS)
    this._watch = setInterval(() => {
      if (this.status !== 'connected') return
      if (Date.now() - this.peerSeen < this.PEER_TIMEOUT_MS) return
      this._setStatus('lost')
      if (this.onPeerLeave) this.onPeerLeave('OPPONENT LOST')
    }, 1000)
  },

  _stopHeartbeat() {
    if (this._beat) clearInterval(this._beat)
    if (this._watch) clearInterval(this._watch)
    this._beat = this._watch = null
  },

  _setStatus(s) {
    if (this.status === s) return
    this.status = s
    if (this.onStatus) this.onStatus(s)
  }
}

/* Closing the tab frees the other player immediately rather than leaving
   them to sit through the heartbeat timeout. */
window.addEventListener('beforeunload', () => { if (Net.online) Net._send({ t: 'bye' }) })
