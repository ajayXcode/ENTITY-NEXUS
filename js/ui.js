/* ------------------------------------------------------------------
   ui.js - screen flow, live prompt parsing, HUD, winner, mint.
------------------------------------------------------------------- */

/* The drafting pool.

   These used to be six hand-written keyword strings - one per shape the
   parser can produce. They are now the Dialogue Vault itself
   (js/dialogues.js), which means every auto-draft in the cabinet and in
   rooms.js fields a real line that the vault page prints as a card, rather
   than a strategy nobody can see anywhere in the UI.

   Load order: js/dialogues.js must be loaded before this file. play.html
   puts it next to characters.js, well above ui.js. */
const PRESETS = DIALOGUES.map((d) => ({ name: d.speaker, text: d.line, id: d.id }))

/* A dialogue for a side that never picked one - the 60-second clock ran out,
   or a room opponent never showed up. Rolled from Math.random() on purpose:
   this is a choice made BEFORE the bell, exactly like clicking a card, and
   it never enters the simulation. */
function draftDialogue(languageId) {
  return Dialogues.random(languageId)
}

/* The one and only way a dialogue reaches a fighter.

   It writes the line into that side's existing textarea and fires `input`,
   which is the entire integration: the cabinet's own listener then does the
   word count, the lexicon parse and the readout it has always done. Nothing
   here reads or writes UI.parsed, UI.locked, the commit, the room protocol or
   the market, so a line cannot be delivered any way other than the way a
   typed prompt used to be.

   Returns false when the side is already locked - the buttons stay on screen
   after a lock, and clicking one must not move a fighter that has committed. */
function castDialogue(id, side) {
  const d = typeof Dialogues !== 'undefined' ? Dialogues.byId(id) : null
  const box = document.getElementById('in-' + side)
  if (!d || !box || box.disabled) return false
  box.value = d.line
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/* Pen Fight reads the SAME three stats out of the SAME parser - these are
   only phrased in the language of a desk, so a player writing for this mode
   is not fighting the lexicon. "Relentless" scores identically whether you
   are swinging a katana or a Reynolds 045. */
const PEN_PRESETS = [
  { name: 'SMASHER',   text: 'relentless, smash their pen off the desk, full power every flick' },
  { name: 'SNIPER',    text: 'patient and careful, line up the shot, never rush a flick' },
  { name: 'FLICKER',   text: 'extremely fast, quick light taps, spin away and reset' },
  { name: 'SURVIVOR',  text: 'stay in the middle, avoid the edge, let them overreach' },
  { name: 'ALL OR NOTHING', text: 'all out attack, no caution at all, do or die on every flick' },
  { name: 'ANCHOR',    text: 'slow and immovable, hold the centre, absorb everything they throw' }
]

/* The two games. Everything above the simulation is shared, so a mode is
   nothing more than which one gets handed the parsed prompts. */
const MODES = {
  fighter: {
    /* `presets` is gone: the cabinet's quick row is built from the vault by
       buildDialogueRow() below, and the drafting pool above still feeds the
       auto-draft paths. */
    name: 'AI FIGHTER',
    ph1: 'No dialogue cast yet \u2014 open the vault',
    ph2: 'No dialogue cast yet \u2014 open the vault'
  }
}

const DEFAULT_HINT = 'No controllers. Nobody touches a key once the bell rings.'

const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))

/* ------------------------------------------------------------------
   Champion identity, applied to a fighter just before the bell.

   All three properties are read in exactly one place - Fighter.render() -
   so none of them can move a frame of the simulation. That is the whole
   reason this is allowed to live on the UI side of the fence: the fight is
   still a pure function of (stats, stats, seed, playbooks).

   A champion is recognised from its PROMPT, never from a side channel, so
   it works in a local match, in an online room, in a rematch and on a
   spectator's replay without a single field being added to the protocol.
------------------------------------------------------------------- */
function championOf(parsed) {
  if (!parsed) return null

  /* A champion first. Seventeen of them ship hand-written strategy text and
     each is recognised by that text. */
  if (typeof Characters !== 'undefined') {
    const c = Characters.byPrompt(parsed.prompt)
    if (c) return c
  }

  /* Then a dialogue. A vault line is not a champion prompt, so this can only
     ever match a line that was actually cast - and it is matched by TEXT,
     exactly like a champion, which is what lets a dialogue's look survive a
     local match, a room, a rematch and a spectator's replay without a single
     field being added to the protocol.

     What comes back is champion-SHAPED on purpose: js/ui.js only ever reads
     .name, .title, .accent, .id and (through Characters.tint) .hue, which is
     everything a look needs and nothing the fight can see. */
  if (typeof Dialogues !== 'undefined') {
    const d = Dialogues.byPrompt(parsed.prompt)
    if (d) return d
  }

  return null
}

/* The weapon drawing is decoded once per champion and reused for every
   later fight, rather than once per bell. */
applyChampionLook._weapons = {}
applyChampionLook._skins = {}

/* The battle-art Image set for one champion on one side: eight files, and
   the pair of them is well under a megabyte. Built once, reused for every
   later bell - which is why the reveal screen can warm them 5.6s early.

   Nothing here is trusted to have loaded. If an image is still in flight
   when the bell goes, js/classes.js draws the sheet it replaces instead of
   drawing nothing. */
applyChampionLook.skinFor = function (champ, side) {
  if (!champ || typeof Characters === 'undefined' || !Characters.ART.has(champ)) return null
  const key = champ.id + ':' + side
  const cached = applyChampionLook._skins[key]
  if (cached) return cached

  const desc = Characters.skin(champ, side)
  const images = {}
  for (const name of desc.names) {
    const im = new Image()
    im.src = desc.dir + Characters.ART.file(name)
    images[name] = im
  }
  const skin = { scale: desc.scale, images: images }
  applyChampionLook._skins[key] = skin
  return skin
}

/* Called from the reveal screen, seconds before the fighters take the stage,
   so the art is decoded by the time anyone can see it. Harmless to repeat. */
applyChampionLook.preload = function (champ, side) {
  applyChampionLook.skinFor(champ, side)
}

function applyChampionLook(f, data, champ, side) {
  if (!champ || typeof Characters === 'undefined') {
    f.tint = null
    f.crest = null
    f.weaponImg = null
    f.skin = null
    return
  }
  /* The aura keeps saying which stat is dominant; the champion just decides
     what colour it is. */
  f.crest = champ.accent
  f.auraColor = Characters.aura(champ)
  f.auraStrength = Math.max(data.stats.aggression, data.stats.defense, data.stats.speed)

  const skin = applyChampionLook.skinFor(champ, side || 1)
  f.skin = skin
  if (skin) {
    /* The sprites already carry the body, the palette and the weapon.
       Tinting them or printing a second weapon beside them would show two
       of each, in colours the champion does not have. */
    f.tint = null
    f.weaponImg = null
    return
  }

  /* The hue tint is the whole look for a dialogue.

     A champion is a DESIGNED fighter and ships a crest and a weapon glyph in
     the asset pack (see scripts/make-champion-assets.js). A dialogue is a
     line, not a design: it gets the tinted body and the accent aura its hue
     implies, and nothing else. Asking for assets/champions/<id>-weapon.svg
     for a vault id would be a request for a file that was never printed - a
     404 in the console on every fight, for a drawing that would be wrong
     anyway. So the guard is here, in the one place the paths are read. */
  f.tint = Characters.tint(champ)
  if (champ.dialogue) {
    f.weaponImg = null
    return
  }

  let img = applyChampionLook._weapons[champ.id]
  if (!img) {
    img = new Image()
    img.src = Characters.weaponArt(champ)
    applyChampionLook._weapons[champ.id] = img
  }
  f.weaponImg = img
}

const UI = {
  mode: 'fighter',
  parsed: { 1: null, 2: null },
  locked: { 1: false, 2: false },
  clock: null,
  clockLeft: CONFIG.PROMPT_SECONDS,
  pendingMint: null,
  pendingSettlement: null,
  lastSeed: 1,

  /* ---------------- boot ---------------- */

  init() {
    this.scale()
    window.addEventListener('resize', () => this.scale())

    $('#btn-begin').addEventListener('click', () => {
      FX.unlock(); FX.click()
      this.startPromptPhase()
    })

    this.setMode(this.mode)

    for (const side of [1, 2]) {
      $(`#in-${side}`).addEventListener('input', () => {
        FX.type()
        this.enforceWordLimit(side)
        this.liveParse(side)
        /* A line can arrive from three places now - the shortlist chips, the
           vault overlay and js/champions.js - and all three go through this
           event. Repainting here is what keeps the highlighted chip honest
           without any of them telling this file what they did. */
        this.buildDialogueRow(side)
      })
    }

    /* ---- the dialogue row -------------------------------------------

       One delegated listener, both sides. Language tabs re-render the
       shortlist; a chip casts the line. A pick goes through castDialogue()
       and therefore through the same `input` event a typed prompt used to
       produce, which is the whole reason the dialogue feature cannot touch
       lock-in, the commit, the reveal, the fight or the market. */
    document.addEventListener('click', (e) => {
      const tab = e.target.closest && e.target.closest('[data-dlg-lang]')
      if (tab) {
        const side = parseInt(tab.dataset.dlgTabSide, 10) || 1
        if (this.locked[side]) return
        FX.click()
        this.dlgLang[side] = tab.dataset.dlgLang
        this.buildDialogueRow(side)
        return
      }
      const chip = e.target.closest && e.target.closest('.dlg-chip[data-dlg-pick]')
      if (chip) {
        const box = chip.closest('.pbox')
        const side = box ? parseInt(box.dataset.side, 10) || 1 : 1
        if (this.locked[side]) return
        FX.click()
        castDialogue(chip.dataset.dlgPick, side)
      }
    })

    $$('[data-lock]').forEach((btn) => {
      btn.addEventListener('click', () => this.lockIn(parseInt(btn.dataset.lock, 10)))
    })

    /* 3D mode. Everything about the fight is unchanged - this only swaps
       which renderer draws it, so the button can be hit at any time and the
       simulation never notices. The model is ~450KB and loads on demand, so
       the button reports progress rather than appearing to hang. */
    const btn3d = $('#btn-3d')
    if (btn3d) {
      if (typeof Render3D === 'undefined' || !Render3D.available()) {
        btn3d.classList.add('hidden')       // no WebGL: never offer it
      } else {
        btn3d.addEventListener('click', () => {
          FX.click()
          if (Render3D.enabled) {
            Render3D.disable()
            btn3d.textContent = 'VIEW IN 3D'
            return
          }
          if (Render3D.ready) {
            Render3D.enable()
            btn3d.textContent = 'BACK TO 2D'
            return
          }
          btn3d.disabled = true
          btn3d.textContent = 'LOADING 3D...'
          Render3D.enable((ok, why) => {
            btn3d.disabled = false
            btn3d.textContent = ok ? 'BACK TO 2D' : '3D UNAVAILABLE'
            if (!ok) console.warn('[3d]', why)
          })
        })
      }
    }

    $('#btn-mint').addEventListener('click', () => this.runMint())
    $('#btn-again').addEventListener('click', () => {
      FX.click()
      this.beginFight(this.parsed[1], this.parsed[2], (this.lastSeed + 7919) >>> 0)
    })
    /* A fresh fighter means a fresh line. The box is read-only now, so a
       "NEW FIGHTERS" that silently kept the old line would read as broken:
       there would be no way to change anything without noticing the vault
       button. Cleared HERE and not inside startPromptPhase(), which
       js/rooms.js also drives when a room is rejoined - and there the line
       has to survive. */
    $('#btn-new').addEventListener('click', () => {
      FX.click()
      for (const side of [1, 2]) {
        const box = $(`#in-${side}`)
        if (!box) continue
        box.value = ''
        this.enforceWordLimit(side)
        this.liveParse(side)
      }
      this.startPromptPhase()
    })
    $('#btn-mint-back').addEventListener('click', () => { FX.click(); this.screen('screen-winner') })

    /* The in-page betting widget that used to live here is gone. It credited
       a local counter, sent bets to two hardcoded fighter addresses
       (0x...0001 and 0x...0002) that belong to nobody, and defaulted the
       match id to 1 - so every bet in the building landed on the same
       nonexistent match and the pool on screen was a number this file had
       made up. Betting now happens in arena.js against a real match id, and
       every figure on screen is read back from ArenaBattle. */

    /* ---------------- wallet ----------------
       Deliberately its own button and its own state. Connecting changes
       nothing about a fight: the simulation does not read a wallet, and a
       local match settles nothing. It exists so nobody has to reach the
       arena screen to find out whether a wallet is there at all. */
    /* js/wallet.js owns this control now - the same module the landing page
       and the champion index use, so all three pages report the same thing
       about the same wallet. This used to be a second implementation here,
       which is how two pages end up disagreeing about whether a wallet is
       connected. */
    const bw = $('#btn-wallet')
    if (bw && typeof WalletChip !== 'undefined') {
      WalletChip.attach(bw, { label: 'CONNECT WALLET', absentText: 'NO WALLET FOUND' })
    }

    $('#mute').addEventListener('click', () => this.toggleMute())
    window.addEventListener('keydown', (e) => {
      // Not while someone is typing their strategy - "m" is a common letter.
      const t = e.target && e.target.tagName
      if (t === 'TEXTAREA' || t === 'INPUT') return
      if (e.key === 'm' || e.key === 'M') this.toggleMute()
    })

    game.onEnd = (who, how) => this.showWinner(who, how)

    // ?bench=200 -> headless balance run, no UI
    if (QP.bench > 0) {
      console.log('running bench, ' + QP.bench + ' fights per matchup...')
      setTimeout(() => runBench(QP.bench), 300)
      return
    }

    if (QP.mode) this.setMode(QP.mode)

    // ?p1=&p2=&seed=&auto=1 -> skip straight in. Typing prompts live on a
    // projector while nervous is a known way to lose two minutes.
    if (QP.p1 || QP.p2) {
      $('#in-1').value = QP.p1 || PRESETS[0].text
      $('#in-2').value = QP.p2 || PRESETS[1].text
      this.liveParse(1); this.liveParse(2)
      if (QP.auto) {
        FX.unlock()
        this.parsed[1] = parsePrompt($('#in-1').value)
        this.parsed[2] = parsePrompt($('#in-2').value)
        this.screen('screen-analyze')
        this.runAnalyze()
        return
      }
      this.startPromptPhase()
    }
  },

  scale() {
    const s = Math.min(window.innerWidth / 1060, window.innerHeight / 620)
    $('#stage').style.transform = `scale(${Math.max(0.3, s)})`
  },

  /* ---------------- the dialogue row ----------------

     Per side: a language tab strip, and a shortlist of lines from whichever
     language is selected. This replaced the six preset chips the screen used
     to print. The pool is the vault, so the row cannot drift from the cards
     the overlay shows, and adding a language to js/dialogues.js is all it
     takes for a tab to appear here.

     `all` is a real tab, not a special case: with 25 lines and five
     languages, "any line" is a legitimate way to play. */

  dlgLang: { 1: 'all', 2: 'all' },

  buildDialogueRow(side) {
    if (typeof Dialogues === 'undefined') return
    const tabs = $(`.dlg-tabs[data-dlg-tabs="${side}"]`)
    const quick = $(`.dlg-quick[data-dlg-quick="${side}"]`)
    if (!tabs || !quick) return

    const mine = this.dlgLang[side] || 'all'
    const counts = Dialogues.counts()
    const items = [{ id: 'all', label: 'Any' }].concat(Dialogues.languages)

    tabs.innerHTML = items.map((l) =>
      `<button type="button" class="dlg-tab${l.id === mine ? ' on' : ''}" ` +
      `data-dlg-lang="${l.id}" data-dlg-tab-side="${side}" ` +
      `title="${Dialogues.languageLabel(l.id) || 'Any language'}">` +
      `${l.label}<i>${counts[l.id]}</i></button>`
    ).join('')

    /* Four lines from the chosen language - enough to be a shortcut, few
       enough that the vault stays the place you actually browse.

       The order is STABLE (the first four of the language, always) with one
       exception: if the line already in the box is not among them, it takes
       the last slot. That way the row never reshuffles itself under the
       cursor every time you cast something, but it always shows what you are
       currently holding. */
    const pool = Dialogues.byLanguage(mine)
    const now = Dialogues.normLine($('#in-' + side).value)
    const out = pool.slice(0, Math.min(4, pool.length))
    const picked = pool.find((d) => Dialogues.normLine(d.line) === now)
    if (picked && out.indexOf(picked) === -1 && out.length) out[out.length - 1] = picked
    quick.innerHTML = out.map((d) => Dialogues.chipHTML(d)).join('')

    /* Which chip is the one in the box. The vault writes through the same
       textarea as before, so this is a read of the box, not of state this
       file keeps. */
    for (const chip of Array.from(quick.querySelectorAll('[data-dlg-pick]'))) {
      const d = Dialogues.byId(chip.dataset.dlgPick)
      chip.classList.toggle('on', !!d && Dialogues.normLine(d.line) === Dialogues.normLine(now))
    }
  },

  /* ---------------- game select ---------------- */

  setMode(mode) {
    if (!MODES[mode]) return
    this.mode = mode
    const m = MODES[mode]

    /* The title screen has to stop promising a hands-off fight when the
       selected game is one you drive, and the coin slot has to say what it
       actually does next. */
    const begin = $('#btn-begin')
    if (begin) begin.textContent = 'INSERT COIN'
    const hint = $('.title-stack .hint')
    if (hint) hint.textContent = m.hint || DEFAULT_HINT
    /* VIEW IN 3D drives the fight renderer. Only touched when 3D was on offer
       use. Only touched when 3D was on offer at all - init hides it for good
       when there is no WebGL, and that decision stands. */
    const btn3d = $('#btn-3d')
    if (btn3d && typeof Render3D !== 'undefined' && Render3D.available()) {
      btn3d.classList.remove('hidden')
    }

    $('#in-1').placeholder = m.ph1
    $('#in-2').placeholder = m.ph2
    const tag = $('#mode-tag')
    if (tag) tag.textContent = m.name
    this.buildDialogueRow(1)
    this.buildDialogueRow(2)
  },

  screen(id) {
    $$('.screen').forEach((el) => el.classList.toggle('active', el.id === id))
    $('#hud').classList.toggle('hidden', id !== null && id !== '')
  },

  showFightHud() {
    $$('.screen').forEach((el) => el.classList.remove('active'))
    $('#hud').classList.remove('hidden')
  },

  toggleMute() {
    FX.setMuted(!FX.muted)
    $('#mute').classList.toggle('off', FX.muted)
  },

  /* ---------------- prompt phase ---------------- */

  startPromptPhase() {
    document.body.classList.remove('sudden-death')
    FX.vignette = 0
    this.locked = { 1: false, 2: false }
    this.parsed = { 1: null, 2: null }
    this.clockLeft = CONFIG.PROMPT_SECONDS
    for (const side of [1, 2]) {
      $(`.pbox.p${side}`).classList.remove('locked')
      const b = $(`[data-lock="${side}"]`)
      b.classList.remove('done'); b.disabled = false; b.textContent = 'LOCK IN'
      $(`#in-${side}`).disabled = false
      this.enforceWordLimit(side)
      this.liveParse(side)
      this.buildDialogueRow(side)
    }
    this.screen('screen-prompt')
    $('#hud').classList.add('hidden')
    /* The box is read-only now, so focusing it would just put a caret in a
       field nobody can type in. The vault button is the first thing the
       player needs, so that is what takes focus. */
    const opener = $('[data-dlg-open="1"]')
    if (opener) opener.focus()

    if (this.clock) clearInterval(this.clock)
    this.updateClock()
    this.clock = setInterval(() => {
      this.clockLeft--
      this.updateClock()
      if (this.clockLeft <= 10 && this.clockLeft > 0) FX.beep()
      if (this.clockLeft <= 0) { clearInterval(this.clock); this.clock = null; this.submitAll() }
    }, 1000)
  },

  updateClock() {
    const el = $('#prompt-clock')
    $('#clock-val').textContent = Math.max(0, this.clockLeft)
    el.classList.toggle('warn', this.clockLeft <= 20 && this.clockLeft > 10)
    el.classList.toggle('crit', this.clockLeft <= 10)
  },

  /* Hard 200-word cap, enforced as you type rather than silently truncating
     at submit - a strategy that got cut in half would lose its keywords and
     produce a fighter the player never asked for. */
  enforceWordLimit(side) {
    const el = $(`#in-${side}`)
    const words = promptWords(el.value)
    if (words.length > CONFIG.MAX_PROMPT_WORDS) {
      el.value = words.slice(0, CONFIG.MAX_PROMPT_WORDS).join(' ')
    }
    const n = promptWords(el.value).length
    const wc = $(`#wc-${side}`)
    wc.textContent = n + ' / ' + CONFIG.MAX_PROMPT_WORDS + ' WORDS'
    wc.classList.toggle('warn', n > CONFIG.MAX_PROMPT_WORDS * 0.8 && n < CONFIG.MAX_PROMPT_WORDS)
    wc.classList.toggle('full', n >= CONFIG.MAX_PROMPT_WORDS)
  },

  liveParse(side) {
    const text = $(`#in-${side}`).value
    const res = parsePrompt(text)
    this.parsed[side] = res

    $(`#arch-${side}`).textContent = text.trim() ? res.archetype : '—'
    this.renderBars($(`#bars-${side}`), res.stats)

    const chips = $(`#chips-${side}`)
    if (!chips) return
    chips.textContent = ''
    if (!text.trim()) return
    if (res.improvised) {
      const span = document.createElement('span')
      span.className = 'chip improv'
      span.textContent = 'no keywords — improvising'
      chips.appendChild(span)
      return
    }
    const seen = new Set()
    res.matched.forEach((m) => {
      if (seen.has(m.label)) return
      seen.add(m.label)
      const el = document.createElement('span')
      const cls = m.compound ? 'compound' : m.stat
      el.className = 'chip ' + cls
      el.textContent = m.compound ? m.compound : (m.delta < 0 ? '−' : '+') + m.label
      chips.appendChild(el)
    })
  },

  renderBars(el, stats, wide) {
    const rows = [['ATK', 'aggression', 'atk'], ['DEF', 'defense', 'def'], ['SPD', 'speed', 'spd']]
    el.className = 'bars' + (wide ? ' wide' : '')
    el.innerHTML = rows.map(([label, key, cls]) => {
      const v = stats[key]
      const on = Math.round(v * 10)
      let segs = ''
      for (let i = 0; i < 10; i++) segs += `<i class="seg${i < on ? ' on' : ''}"></i>`
      return `<div class="bar-row ${cls}"><label>${label}</label><div class="bar-track">${segs}</div><b>${Math.round(v * 100)}</b></div>`
    }).join('')
  },

  lockIn(side) {
    if (this.locked[side]) return
    FX.click()
    // An empty box would hash to the same "improvised" fighter on both
    // sides, so auto-draft one instead - and it is more fun anyway.
    if (!$(`#in-${side}`).value.trim()) {
      /* Nothing cast: draft a line rather than fight an empty box. It is the
         same thing the player would have got by pressing ANY, and it is a
         real line from the vault, so the reveal and the winner screen can
         still name the fighter that turned up. */
      $(`#in-${side}`).value = draftDialogue(this.dlgLang[side]).line
      this.enforceWordLimit(side)
      this.liveParse(side)
      this.buildDialogueRow(side)
    }
    this.locked[side] = true
    $(`.pbox.p${side}`).classList.add('locked')
    $(`#in-${side}`).disabled = true
    const b = $(`[data-lock="${side}"]`)
    b.classList.add('done'); b.disabled = true; b.textContent = 'LOCKED'
    if (this.locked[1] && this.locked[2]) {
      if (this.clock) { clearInterval(this.clock); this.clock = null }
      this.submitAll()
    }
  },

  submitAll() {
    for (const side of [1, 2]) {
      if (!$(`#in-${side}`).value.trim()) {
        $(`#in-${side}`).value = draftDialogue(this.dlgLang[side]).line
        this.enforceWordLimit(side)
        this.liveParse(side)
      }
      this.parsed[side] = parsePrompt($(`#in-${side}`).value)
    }
    this.screen('screen-analyze')
    this.runAnalyze()
  },

  /* ---------------- analysis ---------------- */

  /* Ask Gemini to read both prompts, in parallel, on two of the eight keys.

     Only the two head-to-head games come through here: Hex Racer has a
     prompt too, but only one of them, asked for at START RUN (hexgl.js).
     Resolves to [{side, res}] where res is a parsePrompt-shaped
     object or null, and never rejects - a dead server, an empty key pool or
     a timeout all arrive here as null, which means "keep the local parse". */
  requestAI() {
    if (typeof AI === 'undefined' || !AI.enabled()) return null
    if (AI.available === false) return null
    const mode = this.mode
    return Promise.all([1, 2].map((side) => {
      const text = (this.parsed[side] && this.parsed[side].prompt) || $(`#in-${side}`).value
      return AI.analyze(text, mode)
        .then((res) => ({ side, res }))
        .catch(() => ({ side, res: null }))
    }))
  },

  runAnalyze() {
    const log = $('#analyze-log')
    log.innerHTML = ''
    this.analyzeDone = false

    const say = (text, cls) => {
      const d = document.createElement('div')
      if (cls) d.className = cls
      d.textContent = text
      log.appendChild(d)
      log.scrollTop = log.scrollHeight
      FX.type()
    }

    /* Fired before the first line is drawn, so the ~2s round trip runs
       underneath the scripted log instead of after it. By the time the last
       scripted line lands the verdict is usually already in. */
    const job = this.requestAI()

    const m1 = this.parsed[1].matched.map((m) => m.compound || m.label)
    const m2 = this.parsed[2].matched.map((m) => m.compound || m.label)
    const lines = [
      '> tokenizing both strategy prompts...',
      job ? '> gemini stat engine online' + (AI.keys ? ' (' + AI.keys + ' keys)' : '') + ' — sending both prompts...'
        : '> scanning strategy lexicon (218 terms)...',
      '> p1 matched: ' + (m1.length ? m1.slice(0, 6).join(', ') : 'none — improvising'),
      '> p2 matched: ' + (m2.length ? m2.slice(0, 6).join(', ') : 'none — improvising'),
      '> applying intensifiers and negations...',
      '> normalizing stat budget...',
      '> compiling fight behaviour trees...'
    ]
    const per = CONFIG.ANALYZE_MS / (lines.length + 1)
    lines.forEach((t, i) => setTimeout(() => say(t), per * i))

    const finish = () => {
      if (this.analyzeDone) return
      this.analyzeDone = true
      say('>> FIGHTERS READY', 'ok')
      setTimeout(() => this.showReveal(), 400)
    }

    // No AI in play: the screen behaves exactly as it always did.
    if (!job) {
      setTimeout(finish, CONFIG.ANALYZE_MS)
      return
    }

    const started = Date.now()
    let settled = false
    const pct = (v) => String(Math.round(v * 100)).padStart(2, ' ')

    job.then((results) => {
      if (settled) return
      settled = true
      let used = 0
      results.forEach(({ side, res }) => {
        if (!res) return
        used++
        /* The whole point: the local parse on screen is replaced by what
           Gemini read in the sentence, and every consumer downstream - the
           reveal card, the fight sim, the NFT mint - simply reads
           this.parsed and never learns the difference. */
        this.parsed[side] = res
        say('> gemini p' + side + ': ' + res.archetype +
          '  atk ' + pct(res.stats.aggression) +
          '  def ' + pct(res.stats.defense) +
          '  spd ' + pct(res.stats.speed))
      })
      if (!used) say('> gemini unreachable — local lexicon parse stands')
      /* Never cut the scripted log short just because the answer was fast. */
      setTimeout(finish, Math.max(0, CONFIG.ANALYZE_MS - (Date.now() - started)))
    })

    /* The backstop that makes this safe to run on stage. Whatever Google is
       doing, the fight starts. */
    setTimeout(() => {
      if (settled) return
      settled = true
      say('> gemini slow to answer — local lexicon parse stands')
      finish()
    }, CONFIG.AI_MAX_WAIT_MS)
  },

  /* ---------------- reveal ---------------- */

  showReveal() {
    this.screen('screen-reveal')
    for (const side of [1, 2]) {
      const p = this.parsed[side]
      const champ = championOf(p)
      /* Decode the battle art NOW. The bell is 5.6s away and the images are
         small, so a champion that ships its own sprites is on screen from
         its first frame rather than from its first download. */
      applyChampionLook.preload(champ, side)
      const card = $(`#card-${side}`)
      card.innerHTML = `
        <h3>PLAYER ${side}</h3>
        ${champ ? `<div class="rv-champ" style="--ch:${champ.accent}">${champ.name}<i>${champ.title}</i></div>` : ''}
        <div class="big-arch">${p.archetype}</div>
        <div class="tag">${p.tagline}</div>
        <blockquote>${this.esc(shortPrompt(p.prompt, 260))}</blockquote>
        <div class="bars" id="rb-${side}"></div>`
      this.renderBars($(`#rb-${side}`), p.stats)
    }
    $('#reveal-go').classList.remove('go')
    FX.beepHigh()
    setTimeout(() => { $('#reveal-go').classList.add('go'); FX.bell() }, CONFIG.REVEAL_MS - 900)
    setTimeout(() => this.beginFight(this.parsed[1], this.parsed[2]), CONFIG.REVEAL_MS)
  },

  esc(s) {
    return String(s).replace(/[&<>"]/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  },

  /* ---------------- fight ---------------- */

  beginFight(p1, p2, seed) {
    /* Fresh seed per fight.
       This used to be hashString(p1.prompt + '|' + p2.prompt), so the same
       pair of prompts replayed the identical fight forever - if that one
       seed happened to favour P2, P2 won every single run. Deterministic
       *stats* from the prompt is the property we want (and that lives in
       parsePrompt); a deterministic *battle* is not.
       ?seed=N still pins an exact fight for replay, and the seed in use is
       shown bottom-right on the HUD. */
    const s = seed !== undefined ? seed
      : (QP.seed !== null ? QP.seed
        : (Math.random() * 0xffffffff) >>> 0)
    this.lastSeed = s

    /* Whatever the last round left behind. Both modes set the sudden-death
       body class and only their own reset clears it, so a rematch across
       modes would otherwise start already red. */
    document.body.classList.remove('sudden-death')
    FX.vignette = 0
    FX.timeScale = FX.timeScaleTarget = 1
    console.log('[fight] seed=' + s + '  ' + p1.archetype + ' vs ' + p2.archetype)

    const champ1 = championOf(p1)
    const champ2 = championOf(p2)

    $('#hud-name-1').textContent = 'PLAYER 1'
    $('#hud-name-2').textContent = 'PLAYER 2'
    $('#hud-arch-1').textContent = p1.archetype
    $('#hud-arch-2').textContent = p2.archetype
    /* Deliberately a different element from #hud-name-*: rooms.js rewrites
       those to YOU/OPPONENT in an online match, and the champion has to
       survive that. */
    const hc1 = $('#hud-champ-1')
    const hc2 = $('#hud-champ-2')
    if (hc1) { hc1.textContent = champ1 ? champ1.name : ''; hc1.style.color = champ1 ? champ1.accent : '' }
    if (hc2) { hc2.textContent = champ2 ? champ2.name : ''; hc2.style.color = champ2 ? champ2.accent : '' }
    $('#hud-prompt-1').textContent = shortPrompt(p1.prompt)
    $('#hud-prompt-2').textContent = shortPrompt(p2.prompt)
    $('#seed-val').textContent = s
    for (const id of ['#playerHealth', '#enemyHealth', '#playerChip', '#enemyChip']) {
      if (window.gsap) gsap.killTweensOf(id)
      $(id).style.width = '100%'
    }
    $$('.hp-track').forEach((t) => t.classList.remove('low'))
    $('#timer').textContent = CONFIG.FIGHT_SECONDS
    $('#hud-timer').classList.remove('crit')

    // Reset spectator betting pools
    const sp1 = $('#spec-pool-1')
    const sp2 = $('#spec-pool-2')
    if (sp1) sp1.textContent = '0.00 MON'
    if (sp2) sp2.textContent = '0.00 MON'

    this.showFightHud()

    /* One game now. The arena is the product. */
    {
    }
    startFight(p1, p2, s)

    /* After startFight(), on purpose: that is what runs applyStats() and
       would otherwise overwrite the aura the champion just claimed. */
    applyChampionLook(player, p1, champ1, 1)
    applyChampionLook(enemy, p2, champ2, 2)

    this.announce('FIGHT!')
  },

  updateHealth() { this.setHealth(player.health, enemy.health) },

  /* The HUD is shared by both games, so it takes numbers rather than
     reaching into the fighting game's globals. Pen Fight calls this with the
     two pens' condition and gets the trailing ghost bar, the danger state and
     the low-health styling for nothing. */
  setHealth(h1, h2) {
    const pairs = [['#playerHealth', '#playerChip', h1],
                   ['#enemyHealth', '#enemyChip', h2]]
    for (const [fill, chip, hp] of pairs) {
      if (window.gsap) {
        gsap.to(fill, { width: hp + '%', duration: 0.18, ease: 'power2.out' })
        // the ghost bar trails, which is what makes a big hit read as big
        gsap.to(chip, { width: hp + '%', duration: 0.75, delay: 0.32, ease: 'power2.inOut' })
      } else {
        $(fill).style.width = hp + '%'
        $(chip).style.width = hp + '%'
      }
    }
    $$('.hp-side')[0].querySelector('.hp-track').classList.toggle('low', h1 <= CONFIG.DANGER_HP)
    $$('.hp-side')[1].querySelector('.hp-track').classList.toggle('low', h2 <= CONFIG.DANGER_HP)
  },

  updateFightHud() {
    this.setTimer(Math.max(0, Math.ceil((game.totalFrames - game.frame) / 60)))
  },

  setTimer(left) {
    const el = $('#timer')
    if (el.textContent !== String(left)) {
      el.textContent = left
      if (left <= 10) FX.beep()
    }
    $('#hud-timer').classList.toggle('crit', left <= 10)
  },

  announce(text) {
    const el = $('#announce')
    el.textContent = text
    el.classList.remove('show')
    void el.offsetWidth          // restart the animation
    el.classList.add('show')
  },

  /* ---------------- winner ---------------- */

  /* `info` carries the simulation's own view of the result. Omitted (the
     fighting game's own call) it falls back to player/enemy/game. */
  showWinner(who, how, info) {
    const i = info || {}
    const hp1 = i.hp1 !== undefined ? i.hp1 : player.health
    const hp2 = i.hp2 !== undefined ? i.hp2 : enemy.health
    const win = who === 'p1' ? this.parsed[1] : who === 'p2' ? this.parsed[2] : null
    $('#win-how').textContent = i.label === 'RING OUT' ? 'OFF THE DESK'
      : how === 'KO' ? 'K.O.' : 'TIME UP'

    if (!win) {
      $('#win-title').textContent = 'DRAW'
      $('#win-arch').textContent = 'NOBODY WINS'
      const wcDraw = $('#win-champ')
      if (wcDraw) wcDraw.hidden = true
      const wrDraw = $('#win-record')
      if (wrDraw) wrDraw.hidden = true
      /* Nobody won, so nobody is paid. A draw voids the market; it does not
         pay out a scoreboard either. */
      const wpDraw = $('#win-points')
      if (wpDraw) wpDraw.hidden = true
      $('#win-prompt').textContent = 'Both fighters standing. A draw voids the market - every bet is refunded, no fee is taken, and no NFT is minted.'
      $('#win-bars').innerHTML = ''
      $('#btn-mint').disabled = true
      this.pendingMint = null
    } else {
      const champWin = championOf(win)
      $('#win-title').textContent = (who === 'p1' ? 'PLAYER 1' : 'PLAYER 2') + ' WINS'
      $('#win-arch').textContent = 'THE ' + win.archetype
      const wc = $('#win-champ')
      if (wc) {
        wc.hidden = !champWin
        wc.textContent = champWin ? champWin.name + ' \u2014 ' + champWin.title : ''
        if (champWin) wc.style.setProperty('--ch', champWin.accent)
      }

      /* The session scoreboard. Both champions are logged when both sides
         fielded one - a loss is a result too, and a record that only counts
         wins is not a record. Local to this browser; nothing is sent. */
      const champLose = championOf(who === 'p1' ? this.parsed[2] : this.parsed[1])
      let rec = null
      if (champWin && typeof Characters !== 'undefined') {
        rec = Characters.record.note(champWin.id, true)
        if (champLose) Characters.record.note(champLose.id, false)
      } else if (champLose && typeof Characters !== 'undefined') {
        Characters.record.note(champLose.id, false)
      }
      const wr = $('#win-record')
      if (wr) {
        wr.hidden = !rec
        if (rec) {
          wr.innerHTML = '<b>' + rec.w + '</b>W <i>\u00b7</i> <b>' + rec.l + '</b>L'
          wr.style.setProperty('--ch', champWin.accent)
          wr.setAttribute('title', champWin.name + ' this session')
        }
      }

      /* ---- the points ledger ------------------------------------------

         Booked last, and paid to BOTH fighters. A round that only paid its
         winner would be a scoreboard for whoever is ahead; the loser gets
         paid for the round it actually fought, out of the same counters the
         summary above already prints.

         Order matters here and nowhere else: nothing above this line reads
         a point, and nothing below it re-decides the round. The simulation
         does not load this file at all, the pool and the settlement take
         their numbers from Arena.resultFrom(), and this ledger is
         browser-local - so a scoreboard can never move a fight. */
      const wIsP1 = who === 'p1'
      const winF = wIsP1 ? player : enemy
      const loseF = wIsP1 ? enemy : player
      const winBook = champWin
        ? Characters.points.award(champWin.id, {
            won: true,
            hpLeft: wIsP1 ? hp1 : hp2,
            hitsLanded: winF.hitsLanded,
            blockedHits: winF.blockedHits
          })
        : null
      const loseBook = champLose
        ? Characters.points.award(champLose.id, {
            won: false,
            hpLeft: wIsP1 ? hp2 : hp1,
            hitsLanded: loseF.hitsLanded,
            blockedHits: loseF.blockedHits
          })
        : null
      const wp = $('#win-points')
      if (wp) {
        const rows = this.pointsHTML(champWin, winBook, champLose, loseBook)
        wp.hidden = !rows
        if (rows) {
          wp.innerHTML = rows +
            '<div class="wp-foot">Session total <b>' +
            Characters.points.total().toLocaleString() +
            '</b><i>local to this browser \u2014 never settled, never minted</i></div>'
        }
      }
      $('#win-prompt').textContent = '"' + sanitizePrompt(win.prompt) + '"'
      this.renderBars($('#win-bars'), win.stats, true)
      $('#btn-mint').disabled = false

      /* Everything the deferred chain pass needs, captured here and nowhere
         else. */
      this.pendingMint = {
        prompt: sanitizePrompt(win.prompt),
        stats: win.stats,
        archetype: win.archetype,
        won: true,
        hpRemaining: who === 'p1' ? hp1 : hp2,
        durationMs: i.durationMs !== undefined ? i.durationMs : Math.round(game.frame / 60 * 1000),
        seed: i.seed !== undefined ? i.seed : this.lastSeed,
        // Which game this fighter won. The two modes mint into the same
        // collection, and a token that cannot say which desk it came from is
        // a token missing half its provenance.
        game: i.mode || 'AI FIGHTER',
        finish: i.label || how,
        timestamp: Math.floor(Date.now() / 1000)
      }
    }

    /* The settlement payload is built for a DRAW too - a draw is a real
       result the contract has to be told about, because it is what voids the
       market and releases everybody's refund. Skipping it would leave the
       pools sitting in the contract until someone called voidMatch by hand. */
    this.pendingSettlement = (typeof Arena !== 'undefined')
      ? Arena.resultFrom(who, how, Object.assign({
          hp1: hp1, hp2: hp2, frame: (typeof game !== 'undefined' ? game.frame : 0),
          seed: this.lastSeed
        }, i))
      : null

    /* ---- the round, in numbers ----
       Read straight off the fighters' own counters. Nothing here is
       estimated, and nothing is invented when a counter is absent. */
    const sum = $('#win-summary')
    if (sum) {
      const ms = i.durationMs !== undefined
        ? i.durationMs
        : Math.round((typeof game !== 'undefined' ? game.frame : 0) / 60 * 1000)
      const rows = [
        ['Duration', (ms / 1000).toFixed(1) + 's'],
        ['Hits landed', player.hitsLanded + ' / ' + enemy.hitsLanded],
        ['Blocks', player.blockedHits + ' / ' + enemy.blockedHits],
        ['Damage dealt', Math.round(player.damageDealt) + ' / ' + Math.round(enemy.damageDealt)],
        ['HP left', Math.round(hp1) + ' / ' + Math.round(hp2)],
        ['Seed', String(i.seed !== undefined ? i.seed : this.lastSeed)]
      ]
      sum.innerHTML = rows.map(function (r) {
        return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'
      }).join('')
    }

    /* What the button does depends on whether there is a match to settle.
       Naming it MINT when nothing can be minted is how the old build ended up
       showing people fake token ids. */
    const mint = $('#btn-mint')
    if (mint) {
      const settleable = typeof Arena !== 'undefined' && Arena.matchId && Arena.live()
      mint.textContent = settleable
        ? (win ? 'SETTLE ON MONAD & MINT' : 'SETTLE DRAW ON MONAD')
        : 'NO ON-CHAIN MATCH'
      mint.disabled = !settleable
    }

    this.screen('screen-winner')
  },

  /* Two rows, one per champion, with the itemised receipt on the row's own
     tooltip - the arithmetic is worth showing but not worth a screenful. */
  pointsHTML(champW, bookW, champL, bookL) {
    const row = (champ, book) => {
      if (!champ || !book) return ''
      const receipt = book.lines.map((l) => l.label + ' +' + l.pts).join(' \u00b7 ')
      return '<div class="wp-row" style="--ch:' + champ.accent + '" title="' +
        this.esc(receipt) + '">' +
        '<span class="wp-name">' + this.esc(champ.name) + '</span>' +
        '<b class="wp-gain">+' + book.gained + '</b>' +
        '<em class="wp-total">' + book.total.toLocaleString() + ' pts</em>' +
        '</div>'
    }
    const body = row(champW, bookW) + row(champL, bookL)
    return body ? '<div class="wp-head">Points earned this round</div>' + body : ''
  },

  /* ---------------- settlement ---------------- */

  /* The old version of this called Chain.mint(), which fell back to a
     "simulated" mint that produced a random token id and a fabricated
     transaction hash. Nothing here invents either. Either Monad settled the
     match and the receipt says so, or the screen says it did not. */
  async runMint() {
    if (typeof Arena === 'undefined' || !Arena.matchId || !Arena.live()) {
      this.screen('screen-mint')
      const log = $('#mint-log')
      log.innerHTML = ''
      const d = document.createElement('div')
      d.textContent = '! ' + (typeof Chain !== 'undefined' ? Chain.whyNotLive() : 'no chain')
      log.appendChild(d)
      const d2 = document.createElement('div')
      d2.textContent = '  this fight was local. Nothing was settled and nothing was minted.'
      log.appendChild(d2)
      return
    }

    FX.click()
    this.screen('screen-mint')
    const log = $('#mint-log')
    log.innerHTML = ''
    $('#mint-result').classList.add('hidden')

    const say = (line) => {
      const d = document.createElement('div')
      d.textContent = line
      log.appendChild(d)
      log.scrollTop = log.scrollHeight
      FX.type()
    }

    /* The decision log is the audit trail for how JEV advised this fight.
       Its hash is about to go into the settlement signature, so it is worth
       saying out loud what is being committed to. */
    if (typeof JEV !== 'undefined') {
      const man = JEV.manifest()
      say('> JEV ' + man.jevVersion + '  model ' + man.model)
      say('  ' + man.decisions + ' tactical decisions, ' + man.advised + ' from the advisor')
      say('  decision hash ' + man.decisionHash.slice(0, 18) + '...')
    }

    Arena.say = say
    const res = await Arena.settle(this.pendingSettlement)

    if (!res || !res.settled) {
      say('! settlement did not complete. Nothing was minted.')
      return
    }

    if (res.voided) {
      say('> the market VOIDED: ' + res.reason)
      say('  every bet is refundable in full, and no fee was taken.')
      $('#mint-tx').textContent = res.txHash
      $('#mint-token').textContent = 'none (voided)'
      $('#sim-chip').classList.add('hidden')
      $('#mint-result').classList.remove('hidden')
      return
    }

    $('#mint-tx').textContent = res.txHash
    $('#mint-token').textContent = res.tokenId ? '#' + res.tokenId : 'none'
    $('#sim-chip').classList.add('hidden')   // this path is never simulated
    $('#mint-result').classList.remove('hidden')
    FX.cheer()
  }

}

UI.init()
