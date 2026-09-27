/* ------------------------------------------------------------------
   rooms.js - the screens and flow that turn a two-players-one-keyboard
   cabinet into one player per browser.

   WHY THIS IS A WRAPPER AND NOT AN EDIT TO ui.js
   ui.js is being worked on in parallel, so every line this feature adds to
   it is a merge conflict waiting to happen. Instead the six methods that
   care about there being two local players are wrapped here, at load time,
   with the originals kept and called. ui.js keeps working exactly as it
   does today when nobody is in a room, and the diff to it stays at zero.

   THE FLOW
     INSERT COIN -> screen-room   create a code, or type theirs
                 -> screen-lobby  wait for the other seat to fill
                 -> screen-prompt YOUR box only; theirs is a status panel
                 -> screen-analyze  analyse your own, publish, await theirs
                 -> reveal -> fight -> winner, identical on both screens

   Nothing about the fight itself is networked. Both browsers hold both
   fighters and the same derived seed before the bell, and the simulation is
   deterministic, so they draw the same fight independently. The result hash
   swapped afterwards is the check on that, not the mechanism.
------------------------------------------------------------------- */

const Rooms = {
  /* null until the player picks on screen-room. 'local' is the original
     both-players-here cabinet; 'online' is a room. Sticky across rematches
     so NEW FIGHTERS does not drop anyone back to the room picker. */
  choice: null,
  round: 0,

  _orig: {},
  _headers: {},
  _remoteStart: false,
  _waitTimer: null,

  /* How long to sit on the analyze screen waiting for the other side before
     saying so. Their prompt clock is 60s and their Gemini call has a 7s
     budget on top, so anything past that is a real problem, not slowness. */
  PEER_WAIT_MS: 95000,

  init() {
    if (typeof UI === 'undefined' || typeof Net === 'undefined') return
    this._capture()
    this._wrap()
    this._bindRoomScreen()
    this._bindNet()

    /* ?p1=&p2= is the rehearsal shortcut: both strategies supplied on the
       URL, one machine. Asking that to pick a room first would break the
       one path whose whole job is to skip the furniture. */
    if (typeof QP !== 'undefined' && (QP.p1 || QP.p2)) this.choice = 'local'

    /* ?room=CODE joins on load, so the host can send a link instead of
       reading four characters across a noisy room. */
    const code = new URLSearchParams(location.search).get('room')
    if (code) { this._joinFromLink(code); return }

    this._resume()
  },

  async _joinFromLink(code) {
    this.showRoomScreen()
    const input = document.querySelector('#in-room-code')
    if (input) input.value = Net.normalizeCode(code)
    try {
      const c = await Net.join(code)
      this.choice = 'online'
      this._remember(c, 2)
      this.showLobby()
      setTimeout(() => this._startIfReady(), 700)
    } catch (err) {
      /* The link is stale or the host is not up yet. Leave them on the room
         screen with the code already typed, so one button finishes the job. */
      this._err(this._reason(err))
    }
  },

  /* ---------------- setup ---------------- */

  _capture() {
    for (const side of [1, 2]) {
      const h = document.querySelector(`.pbox.p${side} header`)
      if (h) this._headers[side] = h.innerHTML
    }
  },

  _wrap() {
    const o = this._orig
    const self = this
    for (const name of ['startPromptPhase', 'lockIn', 'submitAll', 'beginFight', 'showWinner']) {
      o[name] = UI[name].bind(UI)
    }

    UI.startPromptPhase = function () { self.startPromptPhase() }
    UI.lockIn = function (side) { self.lockIn(side) }
    UI.submitAll = function () { self.submitAll() }
    UI.beginFight = function (p1, p2, seed) { self.beginFight(p1, p2, seed) }
    UI.showWinner = function (who, how, info) { self.showWinner(who, how, info) }
  },

  _bindRoomScreen() {
    const on = (sel, fn) => {
      const el = document.querySelector(sel)
      if (el) el.addEventListener('click', fn)
    }

    on('#btn-room-create', async () => {
      FX.click()
      this._err('')
      try {
        const code = await Net.host()
        this.choice = 'online'
        this._remember(code, 1)
        this.showLobby()
      } catch (err) {
        this._err(this._reason(err))
      }
    })

    on('#btn-room-join', () => this._doJoin())

    const input = document.querySelector('#in-room-code')
    if (input) {
      /* Fold as they type, so the box always shows the code that will
         actually be used rather than what their fingers did. */
      input.addEventListener('input', () => {
        const pos = input.selectionStart
        input.value = Net.normalizeCode(input.value)
        try { input.setSelectionRange(pos, pos) } catch (e) {}
        this._err('')
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._doJoin() }
      })
    }

    on('#btn-room-local', () => {
      FX.click()
      this.choice = 'local'
      this._orig.startPromptPhase()
    })

    on('#btn-room-back', () => { FX.click(); this.choice = null; UI.screen('screen-title') })
    on('#btn-lobby-leave', () => { FX.click(); this.leave() })
  },

  async _doJoin() {
    const input = document.querySelector('#in-room-code')
    if (!input) return
    FX.click()
    this._err('')
    try {
      const code = await Net.join(input.value)
      this.choice = 'online'
      this._remember(code, 2)
      this.showLobby()
      /* Both seats are full the moment a join succeeds - the host had to
         answer for the room to exist at all - so go straight on. */
      setTimeout(() => this._startIfReady(), 700)
    } catch (err) {
      this._err(this._reason(err))
    }
  },

  _reason(err) {
    const m = String((err && err.message) || err || 'CONNECTION FAILED')
    if (m.indexOf('NO SUCH ROOM') >= 0) return 'NO ROOM WITH THAT CODE'
    return m.toUpperCase()
  },

  _err(text) {
    const el = document.querySelector('#room-err')
    if (el) { el.textContent = text || ''; el.classList.toggle('on', !!text) }
  },

  /* ---------------- net hooks ---------------- */

  /* The board is a nice-to-have bolted onto a room that works without it,
     so every call is guarded: no arena-feed.js loaded, or a host that is not
     us, and this is a no-op rather than a broken room. */
  _feed(fn) {
    if (typeof ArenaFeed === 'undefined') return
    if (!Net.online || Net.side !== 1) return
    fn(ArenaFeed)
  },

  /* Published the moment a wallet is available on either side, because the
     address is what a spectator's bet is placed on - ArenaBattle takes a
     fighter ADDRESS, not a side - and a match with no addresses is a match
     nobody can back. */
  _publishWallet() {
    if (!Net.online) return
    const a = typeof Chain !== 'undefined' && Chain.userAddress
    if (a) Net.publishWallet(a)
  },

  _bindNet() {
    Net.onWallet = () => this._feed((f) => f.push())
    Net.onChainMatch = () => this._feed((f) => f.push())
    Net.onSpectators = (n) => {
      const el = document.querySelector('#lobby-crowd')
      if (el) {
        el.textContent = n === 1 ? '1 WATCHING' : n + ' WATCHING'
        el.classList.toggle('on', n > 0)
      }
    }

    Net.onPeerJoin = () => {
      this._paintLobby()
      FX.bell()
      /* Host has been sitting on an empty room; the other seat just filled. */
      setTimeout(() => this._startIfReady(), 700)
    }

    /* Every hello, including one from a player coming back after a refresh.
       Both sides drop back to a fresh round rather than trying to resume a
       half-played one - a round is 60 seconds, and guessing at what the
       other screen is showing is how two cabinets end up out of step. */
    Net.onPeerHello = () => {
      this._started = false
      setTimeout(() => this._startIfReady(), 500)
    }

    Net.onNewRound = (n) => { this.round = n; this._enterPrompt() }
    Net.onRoundRequest = () => this.startRound()

    Net.onPeerLeave = (why) => {
      this._started = false
      this._paintLobby()
      this._note(why || 'OPPONENT LOST')
      /* Mid-fight the simulation is local and deterministic, so it plays out
         to a real result - no reason to rip the screen away. Anywhere else
         there is nothing to wait for. */
      const onFight = document.querySelector('#hud') && !document.querySelector('#hud').classList.contains('hidden')
      if (!onFight) {
        this._stopWait()
        this.showRoomScreen()
        this._err(why || 'OPPONENT LOST')
      }
    }

    Net.onCommit = () => {
      this._paintPromptStatus()
      /* Both commits down means both prompts are revealed and the board can
         finally show what is actually fighting. Until this point every side
         it publishes is a name on an empty seat, on purpose: a board that
         leaked a strategy while the opponent was still typing would be a way
         to read it, and commit-reveal is the only reason the round is fair. */
      this._feed((f) => f.setPhase(Net.bothCommitted() ? 'ready' : 'writing'))
    }
    Net.onFighter = () => {
      this._paintPromptStatus()
      this._feed((f) => f.push())
    }
    Net.onStatus = () => this._paintLobby()

    Net.onRematch = (seed) => {
      this._remoteStart = true
      this.startUngated(UI.parsed[1], UI.parsed[2], seed)
    }

    /* Everything the server says about this room's market. Routed here
       rather than into the presence logic - see the `from: 0` guard in
       js/net.js. */
    Net.onServerEvent = (m) => {
      if (typeof ChainRoom !== 'undefined') ChainRoom.onServerEvent(m)
    }
  },

  /* ---------------- screens ---------------- */

  showRoomScreen() {
    UI.screen('screen-room')
    const input = document.querySelector('#in-room-code')
    if (input) { input.value = ''; setTimeout(() => input.focus(), 50) }
  },

  showLobby() {
    /* The board entry is born here, at the moment the room becomes real and
       has a code. A lobby is a listing too - a spectator watching a room
       fill up is how they end up there when the bell rings. */
    this._feed((f) => f.start())
    this._publishWallet()
    this._paintLobby()
    UI.screen('screen-lobby')
  },

  _paintLobby() {
    const code = document.querySelector('#lobby-code')
    if (code) code.textContent = Net.code || '----'

    const hint = document.querySelector('#lobby-hint')
    if (hint) {
      hint.textContent = Net.connected ? 'OPPONENT IS IN - STARTING'
        : Net.status === 'lost' ? 'OPPONENT LOST'
        : Net.side === 1 ? 'READ THIS CODE TO YOUR OPPONENT'
        : 'CONNECTING'
    }

    for (const side of [1, 2]) {
      const seat = document.querySelector('#seat-' + side)
      if (!seat) continue
      const filled = side === Net.side || Net.connected
      seat.classList.toggle('on', filled)
      seat.classList.toggle('me', side === Net.side)
      const tag = seat.querySelector('span')
      if (tag) {
        tag.textContent = side === Net.side ? 'YOU'
          : Net.connected ? 'READY'
          : Net.status === 'lost' ? 'GONE' : 'WAITING'
      }
    }

    const net = document.querySelector('#lobby-net')
    if (net) net.textContent = Net.driver ? (Net.driver.label + ' LINK') : 'NO LINK'

    /* Only the host has something to share - the guest is already here. */
    const share = document.querySelector('#lobby-share')
    if (share) {
      if (Net.code && Net.side === 1) {
        const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
        /* The one address that cannot work on the other laptop is the one
           the host is looking at. server.js prints the LAN URLs on startup;
           say so rather than let them send a link that dead-ends. */
        share.textContent = local
          ? 'ON ANOTHER MACHINE? SHARE THE LAN URL THE SERVER PRINTED, NOT LOCALHOST'
          : 'OR SEND  ' + location.origin + location.pathname + '?room=' + Net.code
        share.classList.add('on')
      } else {
        share.textContent = ''
        share.classList.remove('on')
      }
    }
  },

  /* Both seats full: move to the prompt phase together. Only the host opens
     a round, because the round's nonce has to have exactly one author - see
     startRound. The guest asks and waits. Guarded because the join ack and
     the host's hello can both land here. */
  _startIfReady() {
    if (!Net.connected) return
    if (this._started) return
    this._started = true
    if (Net.side === 1) this.startRound()
    else Net.requestNewRound()
  },

  /* Host only. Picks the nonce that salts this round's seed and tells the
     guest, then both sides walk into the prompt phase off the same number.
     A guest that calls this gets nothing but a request. */
  startRound() {
    if (!Net.connected) return
    if (Net.side !== 1) { Net.requestNewRound(); return }
    /* On a fresh join the host opens a round because the seat filled, and
       the guest asks for one because it just sat down. Both are correct and
       they arrive together, so the second must not restart the first - the
       player would watch their prompt box clear itself a moment after it
       appeared. */
    if (Date.now() - (this._lastRoundAt || 0) < 1500) return
    this._lastRoundAt = Date.now()
    this.round++
    Net.resetRound()
    Net.sendNewRound(this.round, (Math.random() * 0xffffffff) >>> 0)
    this._enterPrompt()
  },

  _enterPrompt() {
    this._feed((f) => f.setPhase('writing'))
    this._started = true
    this._orig.startPromptPhase()
    this._adaptPrompt()
  },

  /* ---------------- wrapped: prompt phase ---------------- */

  startPromptPhase() {
    /* Rooms are for the fighting game. Pen Fight and Hex Racer are
       untouched by all this and go straight where they always did. */
    if (UI.mode !== 'fighter') { this._restorePrompt(); this._orig.startPromptPhase(); return }

    if (this.choice === null) { this.showRoomScreen(); return }

    if (this.choice === 'online') {
      if (!Net.connected) { this.showRoomScreen(); return }
      /* NEW FIGHTERS on either cabinet. The host opens the round for both;
         the guest asks and is walked in by the answer, so nobody is left
         sitting on the winner screen while the other retypes a strategy. */
      if (Net.side === 1) this.startRound()
      else { Net.requestNewRound(); this._note('ASKING HOST FOR A NEW ROUND') }
      return
    }

    this._restorePrompt()
    this._orig.startPromptPhase()
  },

  /* Turn the opponent's half of the screen into a status panel. Their
     strategy is theirs until the reveal, so there is nothing to show in it
     but whether they are still writing. */
  _adaptPrompt() {
    const me = Net.side
    const opp = Net.peerSide

    /* Their lock happens on their machine, so locally we treat their box as
       already locked. That is also what lets the original lockIn() fire
       submitAll the moment WE lock, instead of waiting for a second click
       that is never coming. */
    UI.locked[opp] = true

    const mine = document.querySelector('.pbox.p' + me)
    const theirs = document.querySelector('.pbox.p' + opp)
    if (mine) mine.classList.add('mine')
    if (theirs) {
      theirs.classList.add('remote')
      theirs.classList.remove('locked')
      if (!theirs.querySelector('.remote-status')) {
        const d = document.createElement('div')
        d.className = 'remote-status'
        d.innerHTML = '<div class="rs-dot"></div><div class="rs-line" id="remote-line">CONNECTING</div>' +
          '<div class="rs-sub" id="remote-sub">THEIR STRATEGY IS HIDDEN UNTIL BOTH SIDES LOCK IN</div>'
        theirs.appendChild(d)
      }
    }

    const tin = document.querySelector('#in-' + opp)
    if (tin) tin.disabled = true

    const head = (side, label) => {
      const h = document.querySelector(`.pbox.p${side} header`)
      if (!h) return
      h.innerHTML = side === 1
        ? `${label} <b class="dot"></b>`
        : `<b class="dot"></b> ${label}`
    }
    head(me, 'YOU &mdash; PLAYER ' + me)
    head(opp, 'OPPONENT &mdash; PLAYER ' + opp)

    this._paintPromptStatus()
    const myIn = document.querySelector('#in-' + me)
    if (myIn) myIn.focus()
  },

  _restorePrompt() {
    for (const side of [1, 2]) {
      const box = document.querySelector('.pbox.p' + side)
      if (box) box.classList.remove('remote', 'mine')
      const h = document.querySelector(`.pbox.p${side} header`)
      if (h && this._headers[side]) h.innerHTML = this._headers[side]
      const rs = box && box.querySelector('.remote-status')
      if (rs) rs.remove()
    }
  },

  _paintPromptStatus() {
    if (this.choice !== 'online' || !Net.online) return
    const opp = Net.peerSide
    const line = document.querySelector('#remote-line')
    if (!line) return
    line.textContent = Net.fighters[opp] ? 'FIGHTER READY'
      : Net.commits[opp] ? 'LOCKED IN'
      : Net.connected ? 'STILL WRITING'
      : 'OPPONENT LOST'
    const box = document.querySelector('.pbox.p' + opp)
    if (box) box.classList.toggle('locked', !!Net.commits[opp])
  },

  /* ---------------- wrapped: lock in ---------------- */

  lockIn(side) {
    /* In a room the only box you can lock is your own. The other one has no
       button rendered, but a stray keyboard path should not reach it. */
    if (this.choice === 'online' && Net.online && side !== Net.side) return
    this._orig.lockIn(side)
  },

  /* ---------------- wrapped: submit ---------------- */

  submitAll() {
    if (this.choice !== 'online' || !Net.online) { this._orig.submitAll(); return }

    const me = Net.side
    const box = document.querySelector('#in-' + me)

    /* Same auto-draft the local cabinet does when the clock runs out on an
       empty box - a player who typed nothing still gets a fighter. */
    if (!box.value.trim()) {
      const p = PRESETS[Math.floor(Math.random() * PRESETS.length)]
      box.value = p.text
    }
    const text = box.value

    /* The local lexicon parse is the floor. If Gemini answers it replaces
       this; if it does not, this is what gets published. */
    UI.parsed[me] = parsePrompt(text)
    Net.commit(text)

    /* Deliberately not awaited. Staking is a wallet popup and a block
       confirmation; the prompt clock and the other player are not waiting
       for either. If it lands, the crowd can bet on this fight; if it does
       not, the fight happens anyway and the board falls back to paper. */
    this.stakeOnChain(text)

    UI.screen('screen-analyze')
    this.runAnalyzeOnline(text)
  },

  /* ---------------- putting the match on chain ----------------

     This is what turns a room into something a spectator can actually back.
     ArenaBattle.placeSpectatorBet() takes a matchId and a fighter ADDRESS,
     so until these two have staked there is no match to bet into and no
     addresses to bet on - the board can list the fight, and the betting
     stays on paper.

     The handshake is the contract's own: player 1 createMatch()s with a
     stake, player 2 joinMatch()es with a stake that must EQUAL it, and the
     match goes Active. Which means it is strictly ordered - the guest cannot
     move until the host's matchId arrives over the room relay.

     Off unless a deployment has been configured. MONAD.USE_REAL_CHAIN is
     the switch, and with it false this whole path is skipped and nothing
     about the cabinet changes. */
  async stakeOnChain(text) {
    if (typeof MONAD === 'undefined' || !MONAD.USE_REAL_CHAIN) return
    if (typeof Bets === 'undefined' || !Bets.configured()) return
    if (this._staking) return
    this._staking = true

    try {
      await Chain.connectWallet((l) => this._note(l))
      /* Published before the stake, not after: even if the stake fails, the
         address is what a spectator page needs to recognise this player. */
      Net.publishWallet(Chain.userAddress)
      this._feed((f) => f.push())


      if (Net.side === 1) {
        const id = await Chain.createMatch((l) => this._note(l))
        if (!id) throw new Error('no matchId came back from createMatch')
        Net.publishChainMatch(id)
        this._feed((f) => f.push())
        this._note('MATCH #' + id + ' IS OPEN FOR BETS')
      } else {
        const id = await this._awaitChainMatch()
        this._feed((f) => f.push())
        this._note('STAKED INTO MATCH #' + id)
      }
    } catch (err) {
      /* A refused wallet popup is a player declining to stake, not a broken
         room. Say so once and let the fight proceed. */
      this._note('NOT STAKED — ' + ((err && err.message) || 'chain unavailable').slice(0, 60))
    }

    this._staking = false
  },

  /* The guest's half of the handshake. The host may still be waiting on its
     own confirmation, so this is a wait on a relay message rather than a
     value that is already there. */
  _awaitChainMatch() {
    if (Net.chainMatchId) return Promise.resolve(Net.chainMatchId)
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const poll = setInterval(() => {
        if (Net.chainMatchId) { clearInterval(poll); resolve(Net.chainMatchId); return }
        /* Roughly the prompt clock plus a block. Past that the host has
           declined to stake or its transaction is stuck, and either way
           there is nothing for the guest to join. */
        if (Date.now() - started > 75000) {
          clearInterval(poll)
          reject(new Error('host never opened an on-chain match'))
        }
      }, 400)
    })
  },

  /* The analyze screen, rewritten for a room: only YOUR prompt is sent to
     the stat engine, and the wait that follows is a real wait on another
     human rather than a scripted one. */
  runAnalyzeOnline(text) {
    const me = Net.side
    const opp = Net.peerSide
    const log = document.querySelector('#analyze-log')
    log.innerHTML = ''

    const say = (t, cls) => {
      const d = document.createElement('div')
      if (cls) d.className = cls
      d.textContent = t
      log.appendChild(d)
      log.scrollTop = log.scrollHeight
      FX.type()
    }

    say('> room ' + Net.code + '  ·  you are player ' + me)
    say('> strategy committed  ' + (Net.commits[me] || '').slice(0, 12))

    const useAI = typeof AI !== 'undefined' && AI.enabled() && AI.available !== false
    say(useAI ? '> gemini stat engine — reading your prompt...'
      : '> scanning strategy lexicon (218 terms)...')

    const publish = (res) => {
      if (res) {
        UI.parsed[me] = res
        const pct = (v) => String(Math.round(v * 100)).padStart(2, ' ')
        say('> you: ' + res.archetype + '  atk ' + pct(res.stats.aggression) +
          '  def ' + pct(res.stats.defense) + '  spd ' + pct(res.stats.speed))
      } else if (useAI) {
        say('> gemini unreachable — local lexicon parse stands')
      }
      /* Publishing the PARSED fighter, not the prompt. Two browsers asking
         Gemini to read the same sentence at temperature 0.5 can get two
         different answers, and two different answers is two different
         fights. Whoever wrote the prompt owns its reading. */
      Net.publishFighter(UI.parsed[me])
      say('> fighter published to room')
      this._awaitPeer()
    }

    if (!useAI) { setTimeout(() => publish(null), 500); return }
    AI.analyze(text, UI.mode).then(publish).catch(() => publish(null))
  },

  _awaitPeer() {
    const opp = Net.peerSide
    const log = document.querySelector('#analyze-log')
    const started = Date.now()

    const waitLine = document.createElement('div')
    waitLine.className = 'wait'
    log.appendChild(waitLine)

    this._stopWait()
    this._waitTimer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000)

      if (Net.fighters[opp]) {
        this._stopWait()
        UI.parsed[opp] = Net.fighters[opp]
        waitLine.textContent = '> opponent fighter received: ' + Net.fighters[opp].archetype
        const done = document.createElement('div')
        done.className = 'ok'
        done.textContent = '>> BOTH FIGHTERS READY'
        log.appendChild(done)
        FX.beepHigh()
        setTimeout(() => UI.showReveal(), 600)
        return
      }

      if (Net.status === 'lost') {
        this._stopWait()
        waitLine.className = 'bad'
        waitLine.textContent = '> opponent lost the connection'
        return
      }

      if (Date.now() - started > this.PEER_WAIT_MS) {
        this._stopWait()
        waitLine.className = 'bad'
        waitLine.textContent = '> opponent never answered — leaving the room'
        setTimeout(() => { this.leave(); this._err('OPPONENT NEVER ANSWERED') }, 1600)
        return
      }

      waitLine.textContent = Net.commits[opp]
        ? '> opponent locked in — waiting for their fighter... ' + secs + 's'
        : '> waiting for opponent to lock in... ' + secs + 's'
      log.scrollTop = log.scrollHeight
    }, 250)
  },

  _stopWait() {
    if (this._waitTimer) clearInterval(this._waitTimer)
    this._waitTimer = null
  },

  /* ---------------- wrapped: the fight ---------------- */

  /* The bell, once something has decided it may ring. Called by ChainRoom
     when the contract has produced a seed, and by beginFight itself when
     there is no chain to wait for. Bypasses the gate below - that is the
     whole point of it being a separate door. */
  startUngated(p1, p2, seed) {
    this._ungated = true
    try {
      UI.beginFight(p1, p2, seed)
    } finally {
      this._ungated = false
    }
  },

  beginFight(p1, p2, seed) {
    const online = this.choice === 'online' && Net.online

    /* THE GATE. An online room with a chain does not start on a timer: the
       server opens a market and the fight waits until a backer is on each
       side (js/chain-room.js). Everything below this is what happens once
       that has been satisfied, or when there is no chain to satisfy.

       `seed === undefined` distinguishes the first bell from a rematch,
       which carries its own seed and has its own market. */
    if (online && !this._ungated && seed === undefined &&
        typeof ChainRoom !== 'undefined' && ChainRoom.enabled()) {
      this._feed((f) => f.setPhase('ready'))
      ChainRoom.begin(p1, p2)
      return
    }

    if (online) {
      if (seed === undefined) {
        /* Derived on both sides from the room code, the two commits and the
           host's round nonce, so it is identical without being sent - and
           nobody could compute it before committing. */
        seed = Net.deriveSeed()
      } else if (!this._remoteStart) {
        /* A rematch this player started. Carry the seed so both cabinets
           replay the same one. */
        Net.sendRematch(seed)
      }
    }
    this._remoteStart = false

    this._orig.beginFight(p1, p2, seed)

    if (online) {
      this._feed((f) => f.setPhase('live'))
      const n1 = document.querySelector('#hud-name-1')
      const n2 = document.querySelector('#hud-name-2')
      if (n1) n1.textContent = Net.side === 1 ? 'YOU' : 'OPPONENT'
      if (n2) n2.textContent = Net.side === 2 ? 'YOU' : 'OPPONENT'
    }
  },

  /* ---------------- wrapped: the result ---------------- */

  showWinner(who, how, info) {
    this._orig.showWinner(who, how, info)
    if (this.choice !== 'online' || !Net.online) return

    const i = info || {}
    const hp1 = i.hp1 !== undefined ? i.hp1 : player.health
    const hp2 = i.hp2 !== undefined ? i.hp2 : enemy.health
    const mine = Net.resultHash(who, game.frame, hp1, hp2)
    Net.sendResult(mine)

    /* Tell the server what this cabinet saw. It settles on the fight it ran
       itself, but it will not settle at all if either browser reports a
       different one - which is how "two machines agreed" survives the
       server being the one holding the key. */
    if (typeof ChainRoom !== 'undefined' && ChainRoom.matchId) {
      ChainRoom.report(who, typeof game !== 'undefined' ? game.frame : 0, hp1, hp2)
    }

    this._feed((f) => f.setResult(who, (i.label || how || '')))

    const iWon = (who === 'p1' && Net.side === 1) || (who === 'p2' && Net.side === 2)
    const title = document.querySelector('#win-title')
    if (title && who) title.textContent = iWon ? 'YOU WIN' : 'OPPONENT WINS'

    /* The token is the winner's fighter. Both cabinets agree on who that is,
       so the loser's mint button would be minting someone else's card. */
    const mint = document.querySelector('#btn-mint')
    if (mint && who) {
      mint.disabled = !iWon
      mint.textContent = iWon ? 'MINT ON MONAD' : 'WINNER MINTS THIS ONE'
    }

    this._checkAgreement(mine)
  },

  /* Both sides ran the same simulation from the same inputs, so the digests
     must match. If they ever do not, the two screens watched different
     fights and the honest thing is to say so rather than let each player
     walk away with a different idea of who won. */
  _checkAgreement(mine) {
    const started = Date.now()
    const poll = setInterval(() => {
      if (Net.peerResult) {
        clearInterval(poll)
        if (Net.peerResult !== mine) {
          this._note('DESYNC — THE TWO SCREENS DISAGREE')
          console.warn('[rooms] result mismatch: mine=' + mine + ' theirs=' + Net.peerResult)
        }
        return
      }
      if (Date.now() - started > 6000) clearInterval(poll)
    }, 200)
  },

  /* ---------------- leaving, and coming back ---------------- */

  leave() {
    this._stopWait()
    this._started = false
    this._feed((f) => f.stop(true))
    Net.leave()
    this.choice = null
    this._restorePrompt()
    try { sessionStorage.removeItem('arena-room') } catch (e) {}
    this.showRoomScreen()
  },

  _remember(code, side) {
    try { sessionStorage.setItem('arena-room', JSON.stringify({ code, side })) } catch (e) {}
  },

  /* F5 in the middle of a match is common enough at a demo table to be worth
     handling: the room is re-entered rather than orphaned, and the other
     side never sees more than a heartbeat's gap. */
  async _resume() {
    let saved = null
    try { saved = JSON.parse(sessionStorage.getItem('arena-room') || 'null') } catch (e) {}
    if (!saved || !saved.code) return
    try {
      await Net.resume(saved.code, saved.side)
      this.choice = 'online'
      /* showLobby restarts the feed, so a host who refreshed mid-match is
         back on the board within one heartbeat rather than expiring off it. */
      this.showLobby()
      this._note('REJOINED ROOM ' + saved.code)
    } catch (err) {
      try { sessionStorage.removeItem('arena-room') } catch (e) {}
    }
  },

  /* A short banner over whatever is on screen. Used for things the player
     must know but that should not take the screen away from them. */
  _note(text) {
    let el = document.querySelector('#room-note')
    if (!el) {
      el = document.createElement('div')
      el.id = 'room-note'
      const stage = document.querySelector('#stage')
      if (!stage) return
      stage.appendChild(el)
    }
    el.textContent = text
    el.classList.add('on')
    clearTimeout(this._noteTimer)
    this._noteTimer = setTimeout(() => el.classList.remove('on'), 3200)
  }
}

Rooms.init()
