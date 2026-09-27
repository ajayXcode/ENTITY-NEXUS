/* ------------------------------------------------------------------
   spectate-fight.js - the fight, on the spectator's screen.

   WHY THE REAL ENGINE AND NOT A VIDEO OF ONE

   A spectator with money on a fighter is entitled to watch the fight they
   bet on, not a recording of a fight that resembles it. So this page loads
   the same js/classes.js, js/ai-controller.js and js/game.js that a player
   loads, and runs them on the seed the CONTRACT produced. Nothing is
   streamed, nothing is replayed from a log: the browser re-derives the
   fight from (both agents, the seed, the two frozen playbooks) and arrives
   at the same knockout the server did, because those five inputs are all a
   fight is (see the determinism note in house/sim.js).

   That is also why the server never sends the winner in the fight payload.
   If it did, the page would be free to believe it, and the day the two
   disagreed nobody would notice. Letting the screen reach its own verdict
   means a desync is visible rather than papered over - and the board
   arriving a moment later with the settled result is a genuine second
   opinion.

   WHY THE UI SHIM IS HERE

   js/game.js calls UI.updateHealth(), UI.announce() and UI.updateFightHud()
   from inside the damage and clock paths. The real UI lives in js/ui.js,
   which is the whole cabinet - screen flow, prompt boxes, mint dialogs -
   and which also declares `const $`, colliding with the `$` spectate.js
   already defines. Loading it here would be both far too much and a syntax
   error. So this file provides the three methods the engine actually calls,
   pointed at this page's own scoreboard.
------------------------------------------------------------------- */

/* MUST be declared before js/game.js runs: game.js starts its rAF loop on
   its last line, and the first tick calls UI.updateFightHud(). */
const UI = {
  mode: 'fighter',
  lastSeed: 0,

  updateHealth() { SpectateFight.paintHud() },
  updateFightHud() { SpectateFight.paintClock() },

  /* FIRST BLOOD, GUARD BREAK, K.O. - the engine's own callouts. On the
     cabinet these animate across the middle of the arena; here they are a
     line in the room feed, where a spectator is already reading. */
  announce(text) { SpectateFight.callout(text) }
}

const SpectateFight = {
  active: false,
  code: null,          // the room this fight belongs to
  payload: null,
  onDone: null,

  /* ---------------- mounting ---------------- */

  /* The canvas lives in the detail panel and is empty until a fight starts.
     game.js found it at load - it has to exist in the document before that
     script runs - so nothing here creates it, only shows and hides it. */
  mount() {
    this.wrap = document.querySelector('#fight-wrap')
    this.hud = document.querySelector('#fight-hud')
    this.mounted = true

    /* Every show and hide below is guarded on having found #fight-wrap, so
       a module that was never mounted does nothing at all - no error, no
       canvas, just a fight playing out invisibly while the feed narrates
       it. Worth failing loudly instead. */
    if (!this.wrap) {
      console.error('[spectate] #fight-wrap is missing from the page - ' +
        'the fight will run but stay invisible')
    }

    /* Muted by default, and not as a courtesy: a spectate page that starts
       playing combat audio on load is a page people close. FX keeps its own
       gain node, so this is the real thing rather than a volume the fight
       can override. */
    if (typeof FX !== 'undefined' && FX.setMuted) FX.setMuted(true)

    const btn = document.querySelector('#btn-sound')
    if (btn) {
      btn.addEventListener('click', () => {
        const on = btn.getAttribute('aria-pressed') === 'true'
        if (typeof FX !== 'undefined') {
          /* The first unmute doubles as the user gesture the audio context
             needs; without it the browser leaves it suspended and the
             button appears to do nothing. */
          if (FX.unlock) FX.unlock()
          if (FX.setMuted) FX.setMuted(on)
        }
        btn.setAttribute('aria-pressed', on ? 'false' : 'true')
        btn.textContent = on ? 'SOUND OFF' : 'SOUND ON'
      })
    }

    this.bindFullscreen()
  },

  /* ---------------- full screen ----------------

     The whole #fight-wrap goes full screen rather than just the canvas, so
     the health bars, the clock and the fighters' names go with it - a
     fight with no scoreboard is worse to watch, not better.

     The button reflects the real state via the fullscreenchange event
     rather than its own click, because Escape and the browser's own chrome
     can leave full screen without ever telling this code. */
  bindFullscreen() {
    const btn = document.querySelector('#btn-fullscreen')
    if (!btn) return

    if (!this.fullscreenAvailable()) {
      /* Some browsers and most iOS Safari builds have no element-level
         full screen. An enabled button that cannot work is worse than an
         honest one that is gone. */
      btn.classList.add('hidden')
      return
    }

    btn.addEventListener('click', () => this.toggleFullscreen())

    const sync = () => {
      const on = !!this.fullscreenElement()
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
      btn.textContent = on ? 'EXIT FULL SCREEN' : 'FULL SCREEN'
    }
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(ev, sync)
    }
    sync()
  },

  fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null
  },

  fullscreenAvailable() {
    const el = this.wrap
    if (!el) return false
    return !!(el.requestFullscreen || el.webkitRequestFullscreen)
  },

  /* Leave full screen if we are in it, and only if the thing that is full
     screen is ours - a viewer who put some other element full screen should
     not have it closed by a fight ending. */
  exitFullscreen() {
    if (this._exitTimer) { clearTimeout(this._exitTimer); this._exitTimer = null }
    const el = this.fullscreenElement()
    if (!el || el !== this.wrap) return
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen
      if (exit) { const r = exit.call(document); if (r && r.catch) r.catch(() => {}) }
    } catch (e) { /* never let a display preference break the page */ }
  },

  toggleFullscreen() {
    const el = this.wrap
    if (!el) return
    try {
      if (this.fullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen
        if (exit) exit.call(document)
      } else {
        const req = el.requestFullscreen || el.webkitRequestFullscreen
        /* A rejected promise here is a browser refusing the request - a
           permissions policy, or no user gesture. Not worth throwing over;
           the fight carries on in the page. */
        if (req) { const r = req.call(el); if (r && r.catch) r.catch(() => {}) }
      }
    } catch (e) { /* never let a display preference break the fight */ }
  },

  /* ---------------- running one ---------------- */

  /* payload: { seed, agents:{p1,p2}, playbooks, frames, startedAt }
     `startedAt` is only present when catching up - see joinLate(). */
  run(code, payload, opts) {
    if (typeof startFight !== 'function') return false
    /* Self-heal rather than run invisibly: if something started a fight
       before init() mounted this, find the canvas now. */
    if (!this.mounted) this.mount()
    this.stop()

    this.code = code
    this.payload = payload || {}
    this.active = true

    /* The advisor's frozen plan, exactly as the server ran it. An empty
       object is the documented "no playbook" state and drops every
       controller back to the seeded local planner - on this screen and on
       the server alike, so the fight stays reproducible either way. */
    if (typeof JEV !== 'undefined') {
      JEV.playbooks = (payload && payload.playbooks) || {}
    }

    if (this.wrap) {
      this.wrap.classList.remove('hidden')
      /* The bet form is below the arena, so anyone who just placed a bet is
         looking at the wrong part of the page when the bell rings. Bring
         the fight to them rather than expecting them to go find it. */
      try {
        this.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch (e) {
        /* Older engines want no argument; and a failed scroll must never
           stop the fight from running. */
        try { this.wrap.scrollIntoView() } catch (e2) {}
      }
    }

    startFight(payload.agents.p1, payload.agents.p2, payload.seed >>> 0)

    /* Late joiner: the fight has been running on every other screen for a
       while, so this one is stepped forward, without drawing, to the frame
       everybody else is on. The engine is deterministic, so fast-forwarding
       and watching from the start reach an identical state - the catching-up
       tab has simply missed the show, not the result. */
    const behind = this.framesBehind(payload)
    if (behind > 0) {
      let n = 0
      while (!game.over && n++ < behind) stepFight()
      this.callout(behind > 60
        ? 'joined ' + Math.round(behind / 60) + 's into the fight'
        : 'joined mid-fight')
    }

    this.onDone = (opts && opts.onDone) || null
    game.onEnd = (who, how) => {
      this.active = false
      /* Hold full screen for a beat so the knockout actually lands, then
         come back to the page - where the result, the pools and the CLAIM
         button are. Staying full screen would hide the half of this that
         the spectator has money on. */
      if (this.fullscreenElement()) {
        this._exitTimer = setTimeout(() => this.exitFullscreen(), 3000)
      }
      if (this.onDone) this.onDone(who, how)
    }

    this.paintNames()
    this.paintHud()
    return true
  },

  framesBehind(payload) {
    if (!payload.startedAt) return 0
    const elapsedMs = Date.now() - Number(payload.startedAt)
    if (!(elapsedMs > 0)) return 0
    const frames = Math.floor(elapsedMs / (1000 / 60))
    /* Never past the end: a fight that finished before this tab arrived is
       handled by the board's result, not by stepping into a dead engine. */
    return Math.min(frames, Math.max(0, (payload.frames || 0) - 1))
  },

  stop() {
    this.active = false
    this.onDone = null
    if (this._exitTimer) { clearTimeout(this._exitTimer); this._exitTimer = null }

    /* MUST happen before the wrapper is hidden below. `.hidden` is
       `display: none !important`, which beats the :fullscreen rules - so a
       wrapper hidden while still full screen leaves the viewer staring at a
       black screen with no fight in it and no obvious way back except
       Escape. Leave full screen first, every time. */
    this.exitFullscreen()
    if (typeof game !== 'undefined') {
      game.onEnd = null
      /* IDLE rather than OVER: tickWorld only steps the simulation in
         FIGHT, so this parks the engine with both fighters idling instead
         of leaving a half-run fight one rAF away from resuming. */
      game.state = 'IDLE'
      game.over = false
    }
    if (this.wrap) this.wrap.classList.add('hidden')
    this.code = null
    this.payload = null
  },

  /* ---------------- the scoreboard ---------------- */

  paintNames() {
    const a = this.payload && this.payload.agents
    if (!a) return
    const n1 = document.querySelector('#fh-name1')
    const n2 = document.querySelector('#fh-name2')
    if (n1) n1.textContent = a.p1.archetype || 'PLAYER 1'
    if (n2) n2.textContent = a.p2.archetype || 'PLAYER 2'
  },

  paintHud() {
    if (typeof player === 'undefined' || typeof enemy === 'undefined') return
    const b1 = document.querySelector('#fh-hp1')
    const b2 = document.querySelector('#fh-hp2')
    if (b1) b1.style.width = Math.max(0, Math.min(100, player.health)) + '%'
    if (b2) b2.style.width = Math.max(0, Math.min(100, enemy.health)) + '%'
  },

  paintClock() {
    const el = document.querySelector('#fh-clock')
    if (!el || typeof game === 'undefined') return
    const left = Math.max(0, game.totalFrames - game.frame)
    el.textContent = String(Math.ceil(left / 60))
  },

  /* The engine's callouts go to the room feed rather than over the canvas:
     a spectator is already watching that column for bets and results, and
     text burned across the fight would cover the thing they paid to see. */
  callout(text) {
    if (typeof Spectate !== 'undefined' && Spectate.log) Spectate.log(String(text))
  }
}
