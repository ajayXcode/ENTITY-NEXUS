/* ------------------------------------------------------------------
   hexgl.js - the Hex Racer prompt practice range.

   AI Fighter and Pen Fight are simulations: two parsed prompts go in,
   nobody touches a key, a winner comes out. The trouble with practising
   your prompt-writing there is that the answer is always tangled up in
   whoever you were matched against - a bad prompt beats a worse one and
   teaches you nothing.

   This mode takes the other half of that problem away. One prompt, no
   opponent, and a fixed distance to cover. The same three numbers the
   other two games run on are mapped onto the ship instead of a fighter,
   so the sentence you typed is the machine you fly, and the clock at the
   end is a straight answer about the sentence: it covered the distance in
   time, or it did not.

   HexGL (Thibaut "BKcore" Despoulain) is written against Three.js r50dev,
   which is what practice.html loads (libs/Three.dev.js - the r53 build also
   in libs/ moved worldPosition out of the shadowmap chunk, so HexGL's own
   normal-map shader fails to compile against it and the track renders
   black). The hub vendors a modern build, and both want window.THREE.
   Rather than fight that, the game runs in an iframe: its own global scope,
   its own Three, its own render loop, zero contact with render3d.js or
   penfight3d.js. The only channel between the two is postMessage.

   games/hexgl/practice.html is the bridge on the far side - it auto-starts
   the track, applies the lap count and target, and posts the result back.
------------------------------------------------------------------- */

/* Ship builds rather than fighting styles, and each one deliberately
   lopsided - a preset that was good at everything would teach the player
   that the prompt does not matter much. */
const HEX_PRESETS = [
  { name: 'TOP SPEED',  text: 'built for pure top speed, hold the throttle flat out, I will take the wall hits' },
  { name: 'GLASS',      text: 'lightest possible hull, everything spent on acceleration and boost, nothing left for armour' },
  { name: 'CLEAN LINE', text: 'steady and precise, never touch a wall, keep every bit of speed through the corners' },
  { name: 'TANK',       text: 'heavy reinforced hull, slow but it shrugs off the barriers and never loses the run' },
  { name: 'BALANCED',   text: 'quick but controlled, push the straights, back off into the tight corners' }
]

const HexRacer = {
  active: false,
  laps: 1,
  targetKey: 'standard',
  lastRun: null,
  /* The prompt's stats, local parse first and Gemini's reading once it
     answers - the same parsePrompt shape the other two modes pass around. */
  parsed: null,
  analyzing: false,
  _wasMuted: false,

  /* Per-lap targets in ms. The 'standard' figure is BKcore's own reference
     time for a Cityscape lap (Gameplay.simu hardcodes 92300/91250/90365 as
     the shape of a decent run), so standard is genuinely par rather than a
     number picked to feel good. */
  TARGETS: {
    relaxed:  120000,
    standard: 100000,
    brutal:    88000
  },

  /* No WebGL, no racer. Same rule the pen fight card follows: offering a
     mode that cannot render is worse than not offering it. */
  available() {
    try {
      const c = document.createElement('canvas')
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'))
    } catch (err) {
      return false
    }
  },

  targetMs() {
    if (this.targetKey === '0') return 0
    return (this.TARGETS[this.targetKey] || this.TARGETS.standard) * this.laps
  },

  /* ---------------- the prompt becomes a ship ---------------- */

  /* HexGL's own difficulty-0 numbers, which is what the TARGETS above were
     measured against. A prompt is a multiplier on these, never a rewrite:
     stock is what 0.5 across the board produces, so an average prompt races
     the same ship BKcore balanced the track for. */
  STOCK: {
    maxSpeed: 7.0, thrust: 0.02, airResist: 0.02, boosterRatio: 0.5,
    angularSpeed: 0.0125, airAngularSpeed: 0.0135, shieldDamage: 0.06,
    collisionSpeedDecrease: 0.8, collisionSpeedDecreaseCoef: 0.5
  },

  /* aggression / defense / speed -> the dozen numbers ShipControls actually
     flies with.

     The mapping has to make the trade-off real or the whole practice loop
     collapses: if "fast AND tough AND aggressive" simply won, the lesson
     would be to type every adjective you know. So handling is spent, not
     granted - a ship only turns as well as its caution and its restraint on
     top speed allow - and aggression buys acceleration with hull. */
  tuning(stats) {
    const k = this.STOCK
    const a = stats.aggression, d = stats.defense, v = stats.speed
    /* Speed is bought from the corners. At v=1 the ship is 20% faster in a
       straight line and distinctly worse at changing direction, which is
       exactly the bargain a "flat out, no brakes" prompt is asking for. */
    const handling = 0.5 * d + 0.5 * (1 - v)

    return {
      maxSpeed: k.maxSpeed * (0.80 + 0.40 * v),
      thrust: k.thrust * (0.80 + 0.40 * a),
      /* Drag: a slippery hull reaches its top speed, a draggy one only
         approaches it. Without this, maxSpeed alone made the stat feel
         binary - either you hit the number or you did not. */
      airResist: k.airResist * (1.15 - 0.30 * v),
      boosterSpeed: k.maxSpeed * (0.80 + 0.40 * v) * (k.boosterRatio * (0.80 + 0.40 * a)),
      angularSpeed: k.angularSpeed * (0.82 + 0.36 * handling),
      airAngularSpeed: k.airAngularSpeed * (0.82 + 0.36 * handling),
      /* Damage taken per wall scrape. Defense is the main term; aggression
         adds a little because a ship built to lean on the barriers is the
         one that will be leaning on them. */
      shieldDamage: k.shieldDamage * (1.45 - 0.90 * d) * (0.90 + 0.20 * a),
      collisionSpeedDecrease: k.collisionSpeedDecrease * (0.92 + 0.16 * d),
      collisionSpeedDecreaseCoef: k.collisionSpeedDecreaseCoef * (1.30 - 0.60 * d)
    }
  },

  /* The same tuning restated for a human: three numbers a player can hold
     in their head while they rewrite the sentence. */
  spec(stats) {
    const t = this.tuning(stats)
    return {
      top: t.maxSpeed,
      /* Wall hits survived, which is what shieldDamage means in practice
         and what nobody would work out from "0.081". The 0.8 and the square
         are ShipControls' own collision maths at a hard-ish scrape. */
      hits: Math.max(1, Math.round(1 / (t.shieldDamage * 0.8))),
      grip: t.angularSpeed / this.STOCK.angularSpeed
    }
  },

  /* Formatted the way HexGL's own HUD formats it, so the number on the
     setup screen and the number on the track are recognisably the same. */
  fmt(ms) {
    if (!ms) return '--'
    const m = Math.floor(ms / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    const cs = Math.floor((ms % 1000) / 10)
    return m + "'" + (s < 10 ? '0' + s : s) + "''" + (cs < 10 ? '0' + cs : cs)
  },

  init() {
    const host = document.getElementById('hexgl-host')
    if (!host) return

    document.querySelectorAll('#seg-laps button').forEach((b) => {
      b.addEventListener('click', () => {
        FX.click()
        this.laps = parseInt(b.dataset.laps, 10)
        this._seg('#seg-laps', b)
        this._readout()
      })
    })
    document.querySelectorAll('#seg-target button').forEach((b) => {
      b.addEventListener('click', () => {
        FX.click()
        this.targetKey = b.dataset.target
        this._seg('#seg-target', b)
        this._readout()
      })
    })

    /* The prompt box. Parsed on every keystroke by the local lexicon so the
       bars move while you type; Gemini only gets asked once, at START RUN,
       because a call per keystroke would burn the key pool in a minute. */
    const box = document.getElementById('in-hex')
    if (box) {
      box.addEventListener('input', () => { FX.type(); this.enforceWordLimit(); this.liveParse() })
    }
    this.buildPresets()

    const go = document.getElementById('btn-hex-go')
    if (go) go.addEventListener('click', () => { FX.click(); this.start() })

    const back = document.getElementById('btn-hex-back')
    if (back) back.addEventListener('click', () => { FX.click(); UI.screen('screen-title') })

    /* The iframe is same-origin, but the messages are still treated as
       untrusted input - only our own shape is acted on. */
    window.addEventListener('message', (e) => {
      const d = e.data
      if (!d || d.source !== 'hexgl-practice') return
      this._onMessage(d)
    })

    /* Esc while a run is live. practice.html binds it too, because whichever
       document has focus is the one that sees the key. */
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.active) this.stop()
    })

    this._readout()
    this.liveParse()
  },

  /* ---------------- prompt entry ---------------- */

  buildPresets() {
    const host = document.getElementById('presets-hex')
    if (!host) return
    host.innerHTML = ''
    HEX_PRESETS.forEach((p) => {
      const b = document.createElement('button')
      b.className = 'preset'
      b.textContent = p.name
      b.addEventListener('click', () => {
        if (this.analyzing) return
        FX.click()
        document.getElementById('in-hex').value = p.text
        this.enforceWordLimit()
        this.liveParse()
      })
      host.appendChild(b)
    })
  },

  enforceWordLimit() {
    const el = document.getElementById('in-hex')
    if (!el) return
    const words = promptWords(el.value)
    if (words.length > CONFIG.MAX_PROMPT_WORDS) {
      el.value = words.slice(0, CONFIG.MAX_PROMPT_WORDS).join(' ')
    }
    const n = promptWords(el.value).length
    const wc = document.getElementById('wc-hex')
    if (!wc) return
    wc.textContent = n + ' / ' + CONFIG.MAX_PROMPT_WORDS + ' WORDS'
    wc.classList.toggle('warn', n > CONFIG.MAX_PROMPT_WORDS * 0.8 && n < CONFIG.MAX_PROMPT_WORDS)
    wc.classList.toggle('full', n >= CONFIG.MAX_PROMPT_WORDS)
  },

  /* Same readout the fighter boxes get - archetype, three bars, keyword
     chips - plus the line the other modes have no use for: what the stats
     mean once they are bolted to a ship. */
  liveParse() {
    const el = document.getElementById('in-hex')
    if (!el) return
    const text = el.value
    const res = parsePrompt(text)
    this.parsed = res

    this.paint(res, !!text.trim())
  },

  /* Shared by the live lexicon parse and by whatever Gemini sends back, so
     the readout can never end up showing one source's bars next to the
     other's reasoning. */
  paint(res, hasText) {
    const arch = document.getElementById('arch-hex')
    if (arch) arch.textContent = hasText ? res.archetype : '—'
    UI.renderBars(document.getElementById('bars-hex'), res.stats)

    const chips = document.getElementById('chips-hex')
    if (chips) {
      chips.innerHTML = ''
      if (hasText) {
        if (res.improvised && !res.matched.length) {
          chips.innerHTML = '<span class="chip improv">no keywords — improvising</span>'
        } else {
          const seen = new Set()
          res.matched.forEach((m) => {
            if (seen.has(m.label)) return
            seen.add(m.label)
            const c = document.createElement('span')
            c.className = 'chip ' + (m.compound ? (m.stat === 'ai' ? 'ai' : 'compound') : m.stat)
            c.textContent = m.compound ? m.compound : (m.delta < 0 ? '−' : '+') + m.label
            chips.appendChild(c)
          })
        }
      }
    }
    this._buildLine(res.stats)
  },

  _buildLine(stats) {
    const el = document.getElementById('hex-build')
    if (!el) return
    const sp = this.spec(stats)
    el.innerHTML =
      '<span>TOP <b>' + sp.top.toFixed(1) + '</b></span>' +
      '<span>GRIP <b>' + Math.round(sp.grip * 100) + '%</b></span>' +
      '<span>HULL <b>' + sp.hits + ' HITS</b></span>'
  },

  _seg(sel, btn) {
    document.querySelectorAll(sel + ' button').forEach((b) => b.classList.toggle('on', b === btn))
  },

  _readout() {
    const el = document.getElementById('hex-target-read')
    if (!el) return
    const t = this.targetMs()
    el.textContent = t ? this.fmt(t) + '   (' + this.laps + (this.laps === 1 ? ' LAP)' : ' LAPS)')
      : 'NO TARGET - FREE RUN'
  },

  /* START RUN is the one place Gemini is asked, and the run is not held up
     for it: the local parse is already on screen and is what flies if the
     model is slow, missing or offline. Same contract as the fighter modes -
     null means "keep the local parse", never an error. */
  async start() {
    const go = document.getElementById('btn-hex-go')
    const box = document.getElementById('in-hex')
    if (this.analyzing) return

    /* An empty box would fly the improvised default every time and teach
       nothing, so draft a build rather than refuse to start. */
    if (box && !box.value.trim()) {
      const p = HEX_PRESETS[Math.floor(Math.random() * HEX_PRESETS.length)]
      box.value = p.text
      this.enforceWordLimit()
    }
    this.liveParse()

    if (typeof AI !== 'undefined' && AI.enabled() && AI.available !== false) {
      this.analyzing = true
      if (go) { go.classList.add('busy'); go.textContent = 'READING PROMPT…' }
      const res = await AI.analyze(this.parsed.prompt, 'hex').catch(() => null)
      this.analyzing = false
      if (go) { go.classList.remove('busy'); go.textContent = 'START RUN' }
      if (res) {
        this.parsed = res
        this.paint(res, true)
      }
    }

    this.launch()
  },

  launch() {
    const host = document.getElementById('hexgl-host')
    const frame = document.getElementById('hexgl-frame')
    if (!host || !frame) return

    /* Anything the hub was drawing stops now. The racer owns the screen and
       a pen fight left ticking behind an opaque iframe is pure waste. */
    if (typeof PenFight !== 'undefined' && PenFight.active) PenFight.stop()
    /* HexGL brings its own engine hum and crash SFX, so the hub's audio is
       silenced for the duration - but the player's own mute choice is
       remembered, not overwritten. */
    this._wasMuted = FX.muted
    FX.setMuted(true)

    this.active = true
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'))
    document.getElementById('hud').classList.add('hidden')
    host.classList.remove('hidden')
    document.body.classList.add('mode-hexgl')

    /* The query string is identical on every launch, so without a nonce the
       browser serves practice.html straight from cache and edits to it never
       reach the iframe. */
    /* The ship crosses the iframe boundary as one JSON blob: the tuning
       ShipControls needs, plus the stats and the name behind it so the
       result panel in there can explain the run in terms of the prompt
       rather than just handing back a number. */
    const stats = this.parsed.stats
    const build = encodeURIComponent(JSON.stringify({
      arch: this.parsed.archetype,
      tag: this.parsed.tagline,
      stats: { a: round2(stats.aggression), d: round2(stats.defense), s: round2(stats.speed) },
      spec: this.spec(stats),
      tune: this.tuning(stats)
    }))
    const q = 'laps=' + this.laps + '&target=' + this.targetMs() +
      '&quality=3&build=' + build + '&_=' + Date.now()
    frame.src = 'games/hexgl/practice.html?' + q
    // The iframe only receives keys once it actually has focus.
    setTimeout(() => { try { frame.contentWindow.focus() } catch (err) {} }, 80)
  },

  stop() {
    const host = document.getElementById('hexgl-host')
    const frame = document.getElementById('hexgl-frame')
    this.active = false
    document.body.classList.remove('mode-hexgl')
    if (host) host.classList.add('hidden')
    /* about:blank rather than hiding it - an idle HexGL keeps a WebGL
       context and a rAF loop alive, and the hub needs both back. */
    if (frame) frame.src = 'about:blank'
    FX.setMuted(this._wasMuted)
    window.focus()
    UI.screen('screen-hexgl')
  },

  _onMessage(d) {
    if (d.type === 'exit') { this.stop(); return }

    if (d.type === 'error') {
      console.warn('[hexgl] ' + d.reason + ' - practice unavailable')
      this.stop()
      const card = document.querySelector('[data-mode="hexgl"]')
      if (card) { card.classList.add('unavailable'); card.title = 'WebGL unavailable' }
      /* Dropping them back on the setup screen for a game that cannot run is
         a dead end - send them to the two games that still work. */
      UI.setMode('fighter')
      UI.screen('screen-title')
      return
    }

    if (d.type === 'finish') {
      this.lastRun = d
      console.log('[hexgl] ' + ((d.build && d.build.arch) ? d.build.arch + '  ' : '')
        + (d.wrecked ? 'wrecked' : this.fmt(d.timeMs))
        + (d.targetMs ? '  target ' + this.fmt(d.targetMs) + '  ' + (d.passed ? 'PASS' : 'MISS') : ''))
      /* The result panel lives inside the iframe, which already offers RUN
         AGAIN and BACK TO HUB. Nothing to do here but remember the time -
         practice runs are deliberately not minted. */
    }
  }
}
