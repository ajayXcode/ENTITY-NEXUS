/* ------------------------------------------------------------------
   dialogues.js - the Dialogue Vault.

   WHAT CHANGED AND WHY

   The cabinet used to ask for a "strategy prompt": a free-text box, and a
   lexicon that scored the words you typed. That is a fine demo and a bad
   game - it is a vocabulary test with a fight at the end, and the person
   who happens to know the word "immovable" wins.

   So the box is gone. You no longer WRITE the fighter, you CAST it: pick a
   dialogue out of a film, and that dialogue is what the fight is built
   from. Same engine, same parser, same lock-in, same bell - the line of
   dialogue is simply the text that goes in.

   THE ONE RULE THIS FILE OBEYS

   A dialogue is a STRING. Exactly the string the textarea used to hold.
   Nothing here adds a field to the commit, the reveal, the room protocol,
   the market or the settlement, and the engine never loads this file. The
   cabinet puts `line` into #in-1 / #in-2 and fires an `input` event, and
   everything downstream behaves as it did on the day it was written.

   That is also why every line below was TUNED against the real
   parsePrompt() rather than written to sound good: the negator-two-words-
   back rule in prompt-parser.js means "never careless" scores as CAREFUL,
   and a line that reads like a threat can quietly parse as a coward. Every
   line in DIALOGUES was scored before it was accepted, and the set covers
   all eight archetypes with no two lines sharing a stat line.

   ON THE LINES THEMSELVES

   These are ORIGINAL lines written in the idiom of each film industry -
   not quotations. Famous dialogue is somebody's copyrighted work, and a
   vault of it is a liability, not a feature. What is real here is the
   language, the genre and the shape of the scene: a Hindi action closer, a
   Tamil comedy coward, a Korean revenge monologue.

   Load order: utils.js, config.js, prompt-parser.js, characters.js, then
   this file (characters.js supplies the shared stat-bar renderer).
------------------------------------------------------------------- */

const DIALOGUE_LANGUAGES = [
  { id: 'hindi',   label: 'Hindi',   note: 'Hindi cinema' },
  { id: 'english', label: 'English', note: 'English cinema' },
  { id: 'tamil',   label: 'Tamil',   note: 'Tamil cinema' },
  { id: 'telugu',  label: 'Telugu',  note: 'Telugu cinema' },
  { id: 'korean',  label: 'Korean',  note: 'Korean cinema' }
]

/* Every `line` below was scored through the game's own parsePrompt() and
   carries the archetype the parser returns for it - not the one it was
   written to be. `hue` and `accent` are the render-only identity, applied
   in Fighter.render() through exactly the path a champion already uses, so
   a dialogue-built fighter is a distinct silhouette rather than the same
   borrowed sprite twice.

   `hue` is spread across the wheel so no two dialogues produce the same
   body colour. */
const DIALOGUES = [
  {
    id: 'hindi-aakhri',
    language: 'hindi', genre: 'Action', film: 'Aakhri Chunauti',
    speaker: 'Inspector Rathore', role: 'The last man on the roof',
    hue: 0, accent: '#ef4444',
    line: 'Fast, nimble, relentless, rushing forward, never careless'
  },
  {
    id: 'hindi-loha',
    language: 'hindi', genre: 'Drama', film: 'Loha Dil',
    speaker: 'Bade Sahab', role: 'The man who does not move',
    hue: 25, accent: '#f59e0b',
    line: 'Sluggish and heavy, a stone wall that endures, patient but furious when hit'
  },
  {
    id: 'hindi-aag',
    language: 'hindi', genre: 'Action', film: 'Aag Aur Khoon',
    speaker: 'Veer Singh', role: 'Nothing left to lose',
    hue: 50, accent: '#eab308',
    line: 'All out attack, no defense, do or die'
  },
  {
    id: 'hindi-andheri',
    language: 'hindi', genre: 'Thriller', film: 'Andheri Gali',
    speaker: 'Chhaya', role: 'Never seen coming',
    hue: 75, accent: '#84cc16',
    line: 'Quick and nimble, dodge everything, hit and run'
  },
  {
    id: 'hindi-muqabla',
    language: 'hindi', genre: 'Action', film: 'Muqabla',
    speaker: 'Tiger Sethi', role: 'Trades every punch',
    hue: 100, accent: '#22c55e',
    line: 'Aggressive and ruthless, attack and attack, take the hits and answer, never careless'
  },
  {
    id: 'eng-ridge',
    language: 'english', genre: 'Action', film: 'The Ridge',
    speaker: 'Sergeant Cole', role: 'First through the door',
    hue: 125, accent: '#10b981',
    line: 'Rush them swiftly and furiously, dodge, but keep a guard up'
  },
  {
    id: 'eng-harbour',
    language: 'english', genre: 'Thriller', film: 'Cold Harbour',
    speaker: 'The Warden', role: 'The door that does not open',
    hue: 150, accent: '#14b8a6',
    line: 'Defend and endure, patient as stone, quick only to close the door'
  },
  {
    id: 'eng-nine',
    language: 'english', genre: 'Heist', film: 'Nine Doors',
    speaker: 'Vin', role: 'Waits for the one mistake',
    hue: 175, accent: '#06b6d4',
    line: 'Patient, block, counter. Quick to strike when they open up'
  },
  {
    id: 'eng-small',
    language: 'english', genre: 'Drama', film: 'Small Hours',
    speaker: 'Danny', role: 'Not the hero of this one',
    hue: 200, accent: '#38bdf8',
    line: 'Slightly defensive, a bit slow, nothing special either way'
  },
  {
    id: 'eng-ledger',
    language: 'english', genre: 'Spy', film: 'Silent Ledger',
    speaker: 'Agent Wren', role: 'One strike, then gone',
    hue: 225, accent: '#6366f1',
    line: 'Lightning fast, blink and dash, evasive, then strike once and vanish'
  },
  {
    id: 'tam-vetri',
    language: 'tamil', genre: 'Action', film: 'Vetrikodi',
    speaker: 'Aarumugam', role: 'The storm arrives early',
    hue: 250, accent: '#8b5cf6',
    line: 'Attack quickly, furious and relentless, dodging as you rush, never careless'
  },
  {
    id: 'tam-odi',
    language: 'tamil', genre: 'Comedy', film: 'Odipolama',
    speaker: 'Kumar', role: 'Runs first, thinks later',
    hue: 275, accent: '#a855f7',
    line: 'Run away, hide, dodge everything and avoid all damage'
  },
  {
    id: 'tam-kanavu',
    language: 'tamil', genre: 'Drama', film: 'Kanavu Kalam',
    speaker: 'Thalaivar', role: 'Has seen every trick already',
    hue: 300, accent: '#d946ef',
    line: 'Extremely defensive, very patient, calm and slow to commit'
  },
  {
    id: 'tam-mazhai',
    language: 'tamil', genre: 'Action', film: 'Mazhai Mazhai',
    speaker: 'Sakthi', role: 'Keeps walking forward',
    hue: 325, accent: '#ec4899',
    line: 'Brutal and savage pressure, smash them, trade hits, but keep the guard up'
  },
  {
    id: 'tam-thee',
    language: 'tamil', genre: 'Action', film: 'Thee Pidikkum',
    speaker: 'Bharath', role: 'Burns out or burns through',
    hue: 350, accent: '#f43f5e',
    line: 'Furious and swift, attack quickly, dodge, rush them hard'
  },
  {
    id: 'tel-vajra',
    language: 'telugu', genre: 'Action', film: 'Vajrayudham',
    speaker: 'Raghu', role: 'Immovable, and proud of it',
    hue: 12, accent: '#fb923c',
    line: 'Slow and immovable, stand your ground, absorb everything'
  },
  {
    id: 'tel-nidhanam',
    language: 'telugu', genre: 'Drama', film: 'Nidhanam',
    speaker: 'Satyam', role: 'Answers only when it is right',
    hue: 38, accent: '#fbbf24',
    line: 'Patient and careful, disciplined, block and wait, then dodge in quickly'
  },
  {
    id: 'tel-vaayu',
    language: 'telugu', genre: 'Thriller', film: 'Vaayuputhram',
    speaker: 'Anand', role: 'Reason first, then force',
    hue: 62, accent: '#a3e635',
    line: 'Aggressive, extremely defensive, quick'
  },
  {
    id: 'tel-rakta',
    language: 'telugu', genre: 'Action', film: 'Raktabeejam',
    speaker: 'Naga', role: 'Nothing but motion',
    hue: 88, accent: '#4ade80',
    line: 'Super fast flurry, rapid dodge, slippery as water'
  },
  {
    id: 'tel-adhurs',
    language: 'telugu', genre: 'Comedy', film: 'Adhurs',
    speaker: 'Bunty', role: 'Turned up unprepared',
    hue: 112, accent: '#2dd4bf',
    line: 'Careless and sloppy, no plan and no speciality, just show up'
  },
  {
    id: 'kor-seoul',
    language: 'korean', genre: 'Action', film: 'Seoul Blade',
    speaker: 'Kang', role: 'Gave up on defence years ago',
    hue: 138, accent: '#0ea5e9',
    line: 'Reckless and violent, no guard, all out, kill fast'
  },
  {
    id: 'kor-dawn',
    language: 'korean', genre: 'Thriller', film: 'No Mercy, No Dawn',
    speaker: 'Jun', role: 'The debt collector',
    hue: 162, accent: '#818cf8',
    line: 'Ruthless and wild, no guard, smash and crush until it ends'
  },
  {
    id: 'kor-debt',
    language: 'korean', genre: 'Crime', film: 'The Long Debt',
    speaker: 'Hyun', role: 'Slow, patient revenge',
    hue: 188, accent: '#c084fc',
    line: 'I will destroy you slowly, crush you completely, no escape'
  },
  {
    id: 'kor-river',
    language: 'korean', genre: 'Drama', film: 'River Guard',
    speaker: 'Old Man Park', role: 'Has never been knocked down',
    hue: 212, accent: '#e879f9',
    line: 'Hold the line, unbreakable, withstand the storm slowly, then crush them'
  },
  {
    id: 'kor-lucky',
    language: 'korean', genre: 'Comedy', film: 'Lucky Room',
    speaker: 'Soo', role: 'Nervous, but weirdly dangerous',
    hue: 238, accent: '#f472b6',
    line: 'Slightly aggressive, block a bit, and move quickly'
  }
]

/* ------------------------------------------------------------------
   The renderer. Pure string building - no DOM, no storage, nothing read
   back - so this file stays loadable by a headless tool the same way
   characters.js is.
------------------------------------------------------------------- */

const Dialogues = {
  all: DIALOGUES,
  languages: DIALOGUE_LANGUAGES,

  byId(id) {
    return DIALOGUES.find((d) => d.id === id) || null
  },

  language(id) {
    return DIALOGUE_LANGUAGES.find((l) => l.id === id) || null
  },

  languageLabel(id) {
    const l = this.language(id)
    return l ? l.label : ''
  },

  byLanguage(id) {
    if (!id || id === 'all') return DIALOGUES
    return DIALOGUES.filter((d) => d.language === id)
  },

  /* How many of the vault each language holds - the tabs print it. */
  counts() {
    const out = { all: DIALOGUES.length }
    for (const l of DIALOGUE_LANGUAGES) out[l.id] = this.byLanguage(l.id).length
    return out
  },

  /* The real parser, never a copy of it. */
  parsed(d) {
    return parsePrompt(d.line)
  },

  stats(d) {
    return this.parsed(d).stats
  },

  archetype(d) {
    return this.parsed(d).archetype
  },

  /* ------------------------------------------------------------------
     RECOGNITION.

     The cabinet recognises a champion by its PROMPT (Characters.byPrompt),
     which is how a champion's look survives a local match, a room, a
     rematch and a spectator's replay without a field being added to the
     protocol. A dialogue gets in the same way, for the same reason: the
     line already travels, so the vault does not need to travel with it.

     The object returned here is deliberately champion-SHAPED - `hue` and
     `accent` are the only two fields Characters.tint() and Characters.aura()
     read, and `sprite` is absent, so js/ui.js takes the ordinary
     tint-and-crest path. Nothing about it can move a frame of the fight.
  ------------------------------------------------------------------ */
  normLine(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  },

  byPrompt(prompt) {
    const k = this.normLine(prompt)
    if (!k) return null
    const d = DIALOGUES.find((x) => this.normLine(x.line) === k)
    if (!d) return null
    return {
      id: 'dlg-' + d.id,
      name: d.speaker.toUpperCase(),
      title: d.role,
      dialogue: d,
      accent: d.accent,
      hue: d.hue
    }
  },

  /* ------------------------------------------------------------------
     A random line from one language, or from the vault. Used by the
     "any line" button. Rolled from Math.random() on purpose: this is a
     choice made before the bell, exactly like clicking a card, and it
     never enters the simulation.
  ------------------------------------------------------------------ */
  random(languageId) {
    const pool = this.byLanguage(languageId)
    return pool[Math.floor(Math.random() * pool.length)]
  },

  /* Ten-segment bars, the same ones the champion sheets use. Delegated
     rather than duplicated so the two pages cannot drift apart. */
  barsHTML(stats) {
    if (typeof Characters !== 'undefined' && Characters.barsHTML) {
      return Characters.barsHTML(stats)
    }
    return ''
  },

  /* ------------------------------------------------------------------
     MARKUP
  ------------------------------------------------------------------ */

  /* The small button the cabinet's quick row uses: speaker, film, and how
     the parser scores it. Compact on purpose - it sits under a textarea. */
  chipHTML(d) {
    return `<button class="dlg-chip" type="button" data-dlg-pick="${d.id}">` +
      `<b>${d.speaker}</b>` +
      `<em>${this.archetype(d)}</em>` +
      `<span>${d.film}</span>` +
      `</button>`
  },

  /* The full card - the vault page, and the overlay inside the cabinet.

     opts.side  adds the CAST button wired to a player, for the cabinet.
     opts.wide  the roomier vault-page card, which prints the stat bars. */
  cardHTML(d, opts) {
    const o = opts || {}
    const p = this.parsed(d)
    const lang = this.languageLabel(d.language)

    const cast = o.side
      ? `<button class="dlg-cast" type="button" data-dlg-pick="${d.id}" ` +
        `data-dlg-side="${o.side}">CAST THIS LINE</button>`
      : ''

    const bars = o.wide
      ? `<div class="dlg-bars">${this.barsHTML(p.stats)}</div>`
      : ''

    return `<article class="dlg-card${o.wide ? ' wide' : ''}" data-lang="${d.language}"
                     data-archetype="${p.archetype}">
      <header class="dlg-card-top">
        <span class="dlg-lang">${lang}</span>
        <span class="dlg-genre">${d.genre}</span>
      </header>
      <h3 class="dlg-film">${d.film}</h3>
      <div class="dlg-speaker">${d.speaker}<em>${d.role}</em></div>
      <blockquote class="dlg-line">&ldquo;${d.line}&rdquo;</blockquote>
      <div class="dlg-read">
        <span class="dlg-arch">${p.archetype}</span>
        <span class="dlg-tag">${p.tagline}</span>
      </div>
      ${bars}
      ${cast}
    </article>`
  }
}
