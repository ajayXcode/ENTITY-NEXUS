/* ------------------------------------------------------------------
   characters.js - the selectable champion registry.

   Two sources, one format. RAPHAEL and THE WITCHER are transcribed from
   the character sheet (species / style / weapons / role / traits / colour
   palette); the others are originals in that same sheet layout.

   IMPORTANT: a champion is NOT a set of hardcoded stats. Every champion
   carries a `prompt` - the plain-English strategy the cabinet has always
   taken - and its ATK/DEF/SPD and archetype are produced by the game's own
   parsePrompt() at render time. That means:

     - the card can never disagree with the fight it starts,
     - the deterministic-seed and commit/reveal paths are untouched,
     - nothing downstream (reveal, market, settlement, NFT) needs to know
       that a champion was picked rather than typed.

   IDENTITY IN THE FIGHT

   The engine ships two sprite sheets, and most champions have to borrow
   one. Rather than pretend otherwise, each of those is given a `tint` (a
   canvas filter applied at draw time) and a painted crest, so fifteen
   champions are fifteen readable silhouettes instead of two.

   RAPHAEL and MALGRAVE do not borrow anything: they arrive with their own
   sprites (see CHAMPION_ART below), laid out on the engine's exact frame
   geometry by scripts/make-battle-sprites.py. Everything in that paragraph
   is render-only - js/classes.js applies it inside render(), and the
   simulation never reads a byte of it. See the note in Fighter.render().

   Load order: utils.js, config.js, prompt-parser.js, then this file.
   Pure data + string building. No DOM at load time.
------------------------------------------------------------------- */

const CHARACTERS = [
  {
    id: 'raphael',
    name: 'RAPHAEL',
    title: 'The Relentless Ninja',
    tier: 'Rare',
    species: 'Mutant Turtle',
    style: 'Ninjutsu',
    weapons: 'Sai (pair)',
    role: 'Frontline Fighter',
    traits: ['Brave', 'Loyal', 'Fearless'],
    palette: ['#6f7d3f', '#c0392b', '#2b2b2b', '#c9a86a'],
    accent: '#c0392b',
    hue: 0,
    /* Ships real battle art. `sprite` turns the tint and the printed weapon
       glyph off for this champion - it has its own body and its own sai. */
    sprite: true,
    prompt: 'relentless fearless ninja, fast agile and quick to close, keep a tight guard while charging in'
  },
  {
    id: 'malgrave',
    name: 'MALGRAVE',
    title: 'The Violet Glaive',
    tier: 'Epic',
    species: 'Revenant Knight',
    style: 'Glaive Mastery',
    weapons: 'Void glaive',
    role: 'Zoner',
    traits: ['Stern', 'Patient', 'Unrelenting'],
    palette: ['#a78bfa', '#4c1d95', '#0f172a', '#c4b5fd'],
    accent: '#a78bfa',
    hue: 262,
    /* Ships real battle art - the violet glaive knight from Character 2. */
    sprite: true,
    /* Tuned against the real parsePrompt(): TACTICIAN, 0.56 / 0.93 / 0.46.
       The stat line is unique in the registry, and it is the parser that
       produced it, not this comment - run tools or js/characters.js and
       check. 'immovable' is a COMPOUND (its own defense bump), so the
       wording has to be kept whole if anyone edits this. */
    prompt: 'relentless glaive knight, immovable and quick, guard high, punishes the opening'
  },
  {
    id: 'witcher',
    name: 'THE WITCHER',
    title: 'The Silent Blade',
    tier: 'Epic',
    species: 'Human (Witcher)',
    style: 'Swordsmanship',
    weapons: 'Steel sword, silver sword',
    role: 'Versatile Fighter',
    traits: ['Calm', 'Strategic', 'Lethal'],
    palette: ['#f2f2f2', '#9aa3ad', '#3a3f45', '#b3261e', '#7ec8e3'],
    accent: '#7ec8e3',
    hue: 180,
    portrait: true,
    prompt: 'calm and strategic swordsman, patient counter puncher, quick to pressure then punish the opening'
  },
  {
    id: 'vyra',
    name: 'VYRA',
    title: 'The Glass Duelist',
    tier: 'Rare',
    species: 'Human (Augmented)',
    style: 'Fencing',
    weapons: 'Rapier',
    role: 'Rushdown Duelist',
    traits: ['Precise', 'Arrogant', 'Swift'],
    palette: ['#e07a9a', '#f5f0e6', '#4a4f55', '#7b1f3a'],
    accent: '#e07a9a',
    hue: 315,
    prompt: 'all out duelist, no defense at all, do or die on every exchange, blindingly fast riposte'
  },
  {
    id: 'morrow',
    name: 'MORROW',
    title: 'The Grave Warden',
    tier: 'Uncommon',
    species: 'Revenant',
    style: 'Grave Ward',
    weapons: 'Scythe, soul lantern',
    role: 'Anchor',
    traits: ['Stoic', 'Unyielding', 'Cold'],
    palette: ['#2f8f83', '#e6e0cf', '#23272b', '#4c5b34'],
    accent: '#2f8f83',
    hue: 140,
    prompt: 'patient grave warden, defensive and slow to break, quick to absorb everything they throw, wait them out'
  },
  {
    id: 'nox',
    name: 'NOX',
    title: 'The Hollow Assassin',
    tier: 'Epic',
    species: 'Human (Shade)',
    style: 'Shadowstep',
    weapons: 'Twin daggers',
    role: 'Assassin',
    traits: ['Silent', 'Patient', 'Merciless'],
    palette: ['#3b3f7a', '#14161c', '#6b6f78', '#7d4bd6'],
    accent: '#7d4bd6',
    hue: 270,
    portrait: true,
    prompt: 'silent hollow assassin, careful but fast, dodge everything and strike from behind'
  },
  {
    id: 'solara',
    name: 'SOLARA',
    title: 'The Sunforged Champion',
    tier: 'Mythic',
    species: 'Celestial (Emberborn)',
    style: 'Solar Bulwark',
    weapons: 'Sunspear, aegis',
    role: 'Spearhead',
    traits: ['Valiant', 'Radiant', 'Relentless'],
    palette: ['#f0a02a', '#ffd24a', '#f6ecd8', '#8a4b25'],
    accent: '#ffd24a',
    hue: 40,
    prompt: 'relentless champion, fearless and sunforged, quick to push forward and keep the guard high'
  },
  {
    id: 'grimmaw',
    name: 'GRIMMAW',
    title: 'The Siege Sentinel',
    tier: 'Legendary',
    species: 'Forged Golem',
    style: 'Heavy Ordnance',
    weapons: 'Tower shield, warhammer',
    role: 'Tank',
    traits: ['Patient', 'Immovable', 'Blunt'],
    palette: ['#a8623a', '#c98a4b', '#3b3f45', '#e2622a'],
    accent: '#e2622a',
    hue: 25,
    prompt: 'slow immovable siege sentinel, defensive and sturdy, stand your ground and absorb everything'
  },
  {
    id: 'kaelen',
    name: 'KAELEN',
    title: 'The Stormcaller',
    tier: 'Uncommon',
    species: 'Human (Skyborn)',
    style: 'Storm Magic',
    weapons: 'Chain lightning',
    role: 'Versatile Caster',
    traits: ['Volatile', 'Arcane', 'Unbound'],
    palette: ['#7d4bd6', '#3fc6e0', '#4a5568', '#ffd24a'],
    accent: '#3fc6e0',
    hue: 195,
    prompt: 'storm duelist, arcane and skyborn, never timid, answers at every range'
  },
  {
    id: 'talon',
    name: 'TALON',
    title: 'The Ash Falcon',
    tier: 'Rare',
    species: 'Human (Feral)',
    style: 'Talon Fighting',
    weapons: 'Twin claws',
    role: 'Skirmisher',
    traits: ['Restless', 'Feral', 'Patient'],
    palette: ['#a3e635', '#3f3f2a', '#1f2416', '#e5e7eb'],
    accent: '#a3e635',
    hue: 85,
    prompt: 'feral ash falcon, restless and fast, dodge in and strike, never careless'
  },
  {
    id: 'bramble',
    name: 'BRAMBLE',
    title: 'The Thorn Warden',
    tier: 'Uncommon',
    species: 'Dryad',
    style: "Nature's Grasp",
    weapons: 'Vine whip, bramble shield',
    role: 'Bulwark',
    traits: ['Rooted', 'Patient', 'Vengeful'],
    palette: ['#4ade80', '#1f3a24', '#23301f', '#d9f99d'],
    accent: '#4ade80',
    hue: 110,
    prompt: 'rooted thorn warden, defensive and patient, quick to absorb everything, wait them out'
  },
  {
    id: 'hayle',
    name: 'HAYLE',
    title: 'The Frostbound',
    tier: 'Rare',
    species: 'Human (Rimekin)',
    style: 'Cryomancy',
    weapons: 'Frost glaive',
    role: 'Zoner',
    traits: ['Cold', 'Patient', 'Calculated'],
    palette: ['#93c5fd', '#dbeafe', '#334155', '#0ea5e9'],
    accent: '#93c5fd',
    hue: 225,
    prompt: 'patient frostbound cryomancer, defensive and quick to pressure, punish the opening'
  },
  {
    id: 'rhea',
    name: 'RHEA',
    title: 'The Rift Dancer',
    tier: 'Epic',
    species: 'Human (Voidtouched)',
    style: 'Riftstep',
    weapons: 'Phase blades',
    role: 'Duelist',
    traits: ['Elusive', 'Mercurial', 'Reckless'],
    palette: ['#f472b6', '#312e81', '#0f172a', '#a78bfa'],
    accent: '#f472b6',
    hue: 300,
    prompt: 'all out rift dancer, no defense at all, do or die, lightning fast phase strikes'
  },
  {
    id: 'draven',
    name: 'DRAVEN',
    title: 'The Black Standard',
    tier: 'Legendary',
    species: 'Human (Warlord)',
    style: 'Shield And Blade',
    weapons: 'Tower shield, broadsword',
    role: 'Spearhead',
    traits: ['Stubborn', 'Commanding', 'Brutal'],
    palette: ['#fb7185', '#7f1d1d', '#1c1917', '#e7e5e4'],
    accent: '#fb7185',
    hue: 355,
    prompt: 'relentless black standard warlord, fearless and aggressive, push forward behind the tower shield'
  },
  {
    id: 'seraph',
    name: 'SERAPH',
    title: 'The Halo Vigil',
    tier: 'Legendary',
    species: 'Celestial (Seraphim)',
    style: 'Halo Guard',
    weapons: 'Halo glaive',
    role: 'Zoner',
    traits: ['Serene', 'Watchful', 'Inexorable'],
    palette: ['#fcd34d', '#fef3c7', '#1c1917', '#38bdf8'],
    accent: '#fcd34d',
    hue: 55,
    prompt: 'patient halo sentinel, mobile, waits them out'
  },
  {
    id: 'vosk',
    name: 'VOSK',
    title: 'The Iron Verdict',
    tier: 'Rare',
    species: 'Forged Warden',
    style: 'Cudgel Law',
    weapons: 'Judgement maul',
    role: 'Enforcer',
    traits: ['Stern', 'Patient', 'Implacable'],
    palette: ['#94a3b8', '#475569', '#0f172a', '#f59e0b'],
    accent: '#94a3b8',
    hue: 210,
    prompt: 'immovable enforcer, heavy and grounded, strike back'
  },

  {
    id: 'orion',
    name: 'ORION',
    title: 'The Starforged Sentinel',
    tier: 'Mythic',
    species: 'Construct',
    style: 'Arc Ordnance',
    weapons: 'Star cannon',
    role: 'Artillery',
    traits: ['Unflinching', 'Measured', 'Ancient'],
    palette: ['#c4b5fd', '#1e1b4b', '#0b1120', '#67e8f9'],
    accent: '#c4b5fd',
    hue: 245,
    prompt: 'starforged construct, never hesitant, answers at every range'
  }
]

/* ------------------------------------------------------------------
   The renderer.
------------------------------------------------------------------- */

const STAT_ROWS = [['ATK', 'aggression', 'atk'], ['DEF', 'defense', 'def'], ['SPD', 'speed', 'spd']]

const Characters = {
  all: CHARACTERS,

  byId(id) {
    return CHARACTERS.find((c) => c.id === id) || null
  },

  /* Prompts are compared with punctuation flattened, because the prompt that
     survives the textarea, the parser, the commit and the reveal is not
     always byte-identical (shortPrompt truncates, sanitizePrompt strips).
     This is how a champion is recognised without adding a single field to
     the room protocol - the strategy already travels. */
  normPrompt(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  },

  byPrompt(prompt) {
    const k = this.normPrompt(prompt)
    if (!k) return null
    return CHARACTERS.find((c) => this.normPrompt(c.prompt) === k) || null
  },

  /* ---- the asset pack ---------------------------------------------------
     Two files per champion, printed from the reference sheet by
     scripts/make-champion-assets.js. Regenerate with:

         node scripts/make-champion-assets.js

     They are real files rather than inline markup so the browser can cache
     them, and so the card, the picker and the fight all show the same
     drawing instead of three approximations of it. */

  crestArt(c) { return 'assets/champions/' + c.id + '-crest.svg' },
  weaponArt(c) { return 'assets/champions/' + c.id + '-weapon.svg' },

  /* ---- real battle art -------------------------------------------------

     A champion flagged `sprite` ships its own eight-frame set instead of
     borrowing samuraiMack/kenji. The frames are laid out on the engine's
     own geometry by scripts/make-battle-sprites.py, so a Fighter draws them
     with the offset it already had and one number changed: the scale, by
     1/R, because the frames are emitted at R times the resolution.

     The filenames are the ENGINE's animation names, lowercased, which is
     the whole mapping table - no lookup to drift.

     Nothing here loads an image or touches the DOM: this hands back paths
     and one number, and js/ui.js owns the Image objects. That is what keeps
     this file loadable by scripts/make-champion-assets.js and by every
     headless harness with no browser underneath it. */

  ART: {
    names: ['idle', 'run', 'jump', 'fall', 'attack1', 'attack2', 'takeHit', 'death'],
    R: 2,
    baseScale: 2.5,          // js/game.js's Fighter scale, both sides

    has(c) { return !!(c && c.sprite) },
    hasPortrait(c) { return !!(c && (c.sprite || c.portrait)) },

    dir(c, side) {
      return 'assets/img/champ/' + c.id + '/' + (side === 2 ? 'p2' : 'p1') + '/'
    },

    file(name) { return String(name).toLowerCase() + '.png' },

    /* The card / index portrait, printed by the same script. */
    portrait(c) { return 'assets/img/champ/' + c.id + '/portrait.png' },

    /* One descriptor, everything js/ui.js needs to build the Image set. */
    for_(c, side) {
      if (!this.has(c)) return null
      return {
        dir: this.dir(c, side),
        names: this.names,
        scale: this.baseScale / this.R,
        portrait: this.portrait(c)
      }
    }
  },

  skin(c, side) { return this.ART.for_(c, side) },

  /* ---- the points ledger -------------------------------------------------

     Awarded on the winner screen at the end of a round, to BOTH fighters -
     a loss pays too, because a fighter that only ever scores when it wins
     is a scoreboard for the winner, not for the person playing.

     It is deliberately the last thing that happens and the least connected
     thing in the file. Nothing in the fight reads it:

       - the simulation never loads this file at all (see house/sim.js's
         SCRIPTS list, which stops at game.js),
       - the planner, the pool and the settlement take their numbers from
         Arena.resultFrom(), not from here,
       - it is browser-local, like the record above, so it cannot disagree
         with a chain that was never told about it.

     The arithmetic is a pure function of the round's own counters, so it
     can be tested on its own - see tests/champion-points.test.js. */

  points: {
    KEY: 'entitynexus.champion-points',

    /* What a decided round pays. The winner's bonus is the only term that
       differs by outcome, and it is capped so that a lucky KO never
       out-earns a real performance. */
    PAY: {
      fought: 10,      // both fighters: the round happened and was finished
      win: 25,         // winner only
      hpDivisor: 10,   // winner only: floor(hp left / 10), so 0-10
      hpMax: 10,
      hit: 1,          // both: per hit landed
      hitMax: 10,
      block: 1,        // both: per hit blocked
      blockMax: 5
    },

    /* Pure. `o` is a round's counters, all of which are already on screen:
         won, hpLeft, hitsLanded, blockedHits
       Returns the points and the itemised receipt the winner screen prints. */
    score(o) {
      const P = this.PAY
      const r = o || {}
      const lines = []
      let gained = P.fought
      lines.push({ label: 'Fought to the bell', pts: P.fought })

      if (r.won) {
        gained += P.win
        lines.push({ label: 'Won the round', pts: P.win })
        const hp = Math.max(0, Math.min(P.hpMax, Math.floor((r.hpLeft || 0) / P.hpDivisor)))
        if (hp > 0) { gained += hp; lines.push({ label: 'Health remaining', pts: hp }) }
      }

      const hits = Math.max(0, Math.min(P.hitMax, Math.round(r.hitsLanded || 0) * P.hit))
      if (hits > 0) { gained += hits; lines.push({ label: 'Hits landed', pts: hits }) }

      const blocks = Math.max(0, Math.min(P.blockMax, Math.round(r.blockedHits || 0) * P.block))
      if (blocks > 0) { gained += blocks; lines.push({ label: 'Hits blocked', pts: blocks }) }

      return { gained: gained, lines: lines }
    },

    all() {
      try { return JSON.parse(localStorage.getItem(this.KEY) || '{}') || {} }
      catch (err) { return {} }
    },

    get(id) {
      const p = this.all()[id]
      return { pts: (p && p.pts) || 0, w: (p && p.w) || 0, l: (p && p.l) || 0 }
    },

    /* Books the round and returns the receipt, including the champion's
       running total, so the winner screen can paint it in one pass. */
    award(id, o) {
      const book = this.score(o)
      if (!id) return { gained: book.gained, total: book.gained, lines: book.lines }
      const all = this.all()
      const cur = all[id] || { pts: 0, w: 0, l: 0 }
      cur.pts = (cur.pts || 0) + book.gained
      if (o && o.won) cur.w = (cur.w || 0) + 1
      else cur.l = (cur.l || 0) + 1
      all[id] = cur
      try { localStorage.setItem(this.KEY, JSON.stringify(all)) } catch (err) { /* private mode */ }
      return { gained: book.gained, total: cur.pts, lines: book.lines, w: cur.w, l: cur.l }
    },

    total() {
      const all = this.all()
      let pts = 0
      for (const k in all) pts += all[k].pts || 0
      return pts
    },

    clear() {
      try { localStorage.removeItem(this.KEY) } catch (err) { /* private mode */ }
    }
  },

  /* ---- the session record -----------------------------------------------
     Who you have won and lost with, kept in this browser only. Nothing is
     sent anywhere and nothing is settled against it - it is a scoreboard for
     the person holding the keyboard. */

  record: {
    KEY: 'entitynexus.champion-record',

    all() {
      try { return JSON.parse(localStorage.getItem(this.KEY) || '{}') || {} }
      catch (err) { return {} }
    },

    get(id) {
      const r = this.all()[id]
      return { w: (r && r.w) || 0, l: (r && r.l) || 0 }
    },

    /* Returns the updated tally so the caller can paint it immediately.
       The record and the points ledger above are kept apart on purpose:
       this one is a win/loss tally, that one is a score. A champion can be
       3W-1L and still be behind on points, and both are real. */
    note(id, won) {
      if (!id) return { w: 0, l: 0 }
      const all = this.all()
      const cur = all[id] || { w: 0, l: 0 }
      if (won) cur.w = (cur.w || 0) + 1
      else cur.l = (cur.l || 0) + 1
      all[id] = cur
      try { localStorage.setItem(this.KEY, JSON.stringify(all)) } catch (err) { /* private mode */ }
      return { w: cur.w, l: cur.l }
    },

    total() {
      const all = this.all()
      let w = 0, l = 0
      for (const k in all) { w += all[k].w || 0; l += all[k].l || 0 }
      return { w: w, l: l }
    },

    clear() {
      try { localStorage.removeItem(this.KEY) } catch (err) { /* private mode */ }
    }
  },

  /* The canvas filter that gives a champion its own body. Applied at draw
     time only - see Fighter.render().

     A champion that ships real art returns null: hue-rotating a drawing
     that was painted in its own colours would be vandalism, and it would
     also move the palette off the one on its card. */
  tint(c) {
    if (this.ART.has(c)) return null
    return 'hue-rotate(' + (c.hue || 0) + 'deg) saturate(1.35) contrast(1.06)'
  },

  /* The aura string the renderer expects: 'rgba(r,g,b,ALPHA)' with ALPHA
     substituted per frame (see Fighter.render). */
  aura(c) {
    const h = String(c.accent || '#ffffff').replace('#', '')
    const full = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h
    const n = parseInt(full, 16) || 0
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',ALPHA)'
  },

  /* The real parser, not a copy of it. CONFIG/prompt-parser must be loaded
     before this runs - index.html, champions.html and play.html all load
     them first. */
  parsed(c) {
    return parsePrompt(c.prompt)
  },

  /* Ten-segment bar, same visual language as the cabinet's readout. */
  barsHTML(stats) {
    return STAT_ROWS.map(([label, key, cls]) => {
      const on = Math.round(clamp01(stats[key]) * 10)
      let segs = ''
      for (let i = 0; i < 10; i++) segs += `<i class="seg${i < on ? ' on' : ''}"></i>`
      return `<div class="ch-bar ${cls}"><span>${label}</span><div class="ch-track">${segs}</div>` +
             `<b>${Math.round(clamp01(stats[key]) * 100)}</b></div>`
    }).join('')
  },

  /* The design sheet, built once and used everywhere.

     Straight off the reference image: the crest, the identity block, the
     SPECIES/STYLE/WEAPONS/ROLE/TRAITS table, the WEAPONS panel with its
     drawing, the colour palette, and the stats the fight will actually use.

     opts.pickSide      add the CHOOSE button (the cabinet's picker)
     opts.strategy      add the strategy this champion writes for you
     opts.wide          the roomier index-page sheet
     opts.showRecord    always print the win/loss chip, even at 0-0      */
  sheet(c, opts) {
    const o = opts || {}
    const p = this.parsed(c)
    const rec = this.record.get(c.id)
    const pts = this.points.get(c.id)
    const played = rec.w + rec.l

    const pick = o.pickSide
      ? `<button class="ch-pick" type="button" data-champ-pick="${c.id}" ` +
        `data-champ-side="${o.pickSide}">CHOOSE</button>`
      : ''

    const strategy = o.strategy
      ? `<div class="ch-strategy">
           <span class="ch-lab">Strategy it writes</span>
           <q>${c.prompt}</q>
         </div>`
      : ''

    const record = (played || o.showRecord)
      ? `<div class="ch-record" data-champ-record="${c.id}"` +
        (played ? '' : ' hidden') + `>` +
        `<span class="ch-lab">Your record</span>` +
        `<b data-rec-w>${rec.w}</b><em>W</em>` +
        `<b data-rec-l>${rec.l}</b><em>L</em>` +
        `<b data-rec-p>${pts.pts.toLocaleString()}</b><em>PTS</em>` +
        `</div>`
      : ''

    /* A champion that ships real battle art or portrait shows it. The rest keep the
       crest, because a portrait of a hue-rotate filter is not a portrait. */
    const portrait = this.ART.hasPortrait(c)
      ? `<figure class="ch-art"><img src="${this.ART.portrait(c)}" alt="${c.name}"
           loading="lazy" width="320" height="320" />
         <figcaption>Battle art</figcaption></figure>`
      : ''

    return `<article class="ch-card${o.wide ? ' ch-card-wide' : ''}" data-champ-card="${c.id}"
      style="--ch-accent:${c.accent}">
      <div class="ch-rail" aria-hidden="true"></div>
      ${portrait}

      <header class="ch-head">
        <img class="ch-crest" src="${this.crestArt(c)}" alt="" loading="lazy"
             width="46" height="46" />
        <div class="ch-head-txt">
          <span class="ch-tier">${c.tier}</span>
          <h3 class="ch-name font-podium">${c.name}</h3>
          <p class="ch-title">${c.title}</p>
        </div>
      </header>

      <dl class="ch-spec">
        <div><dt>Species</dt><dd>${c.species}</dd></div>
        <div><dt>Style</dt><dd>${c.style}</dd></div>
        <div><dt>Weapons</dt><dd>${c.weapons}</dd></div>
        <div><dt>Role</dt><dd>${c.role}</dd></div>
        <div><dt>Traits</dt><dd>${c.traits.join(' · ')}</dd></div>
      </dl>

      <div class="ch-panel">
        <img class="ch-weapon" src="${this.weaponArt(c)}" alt="${c.weapons}"
             loading="lazy" height="44" />
      </div>

      <div class="ch-pal">
        <span class="ch-lab">Palette</span>
        <div class="ch-swatches">${swatchesOf(c)}</div>
      </div>

      <div class="ch-derived">
        <div class="ch-arch"><span>Archetype</span><b>${p.archetype}</b></div>
        <div class="ch-bars">${this.barsHTML(p.stats)}</div>
      </div>

      ${strategy}
      ${record}
      ${pick}
    </article>`
  },

  cardHTML(c, pickSide) { return this.sheet(c, { pickSide: pickSide }) },
  showcaseHTML(c) { return this.sheet(c, { wide: true, strategy: true, showRecord: true }) }
}

function swatchesOf(c) {
  return c.palette.map((hex) => `<i style="background:${hex}"></i>`).join('')
}
