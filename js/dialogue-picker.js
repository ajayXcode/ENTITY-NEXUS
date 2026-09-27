/* ------------------------------------------------------------------
   dialogue-picker.js - the Dialogue Vault, as an overlay inside the cabinet.

   This is deliberately NOT a new branch of the flow, and it is written the
   same way js/champions.js is, for the same reason. Picking a line does
   exactly one thing: it writes that line into the player's existing textarea
   and fires an `input` event. From there the cabinet behaves as it always
   has - the same liveParse, the same word count, the same LOCK IN, the same
   commit/reveal, the same fight, the same market and the same mint.

   It goes through UI.castDialogue(), which is also what the shortlist chips
   under the box use, so there is one code path and not two.

   Nothing in this file reads or writes UI.parsed, UI.locked or the room
   protocol. Delete this file and its markup and the cabinet is the game it
   was before - which is the point.

   Load order: after js/ui.js (it calls into it) and after js/dialogues.js
   (for the vault).
------------------------------------------------------------------- */

const DialoguePicker = {
  side: 1,
  lang: 'all',
  root: null,

  init() {
    this.root = document.getElementById('dlg-overlay')

    /* The "OPEN THE DIALOGUE VAULT" buttons, one per side. Purely additive
       markup in play.html - the dialogue phase does not know they exist. */
    for (const b of document.querySelectorAll('[data-dlg-open]')) {
      b.addEventListener('click', () => this.open(parseInt(b.dataset.dlgOpen, 10) || 1))
    }

    if (!this.root) return

    /* One delegated listener: the cards are re-rendered on every tab change. */
    this.root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-dlg-tab]')
      if (tab) {
        if (typeof FX !== 'undefined') FX.click()
        this.lang = tab.dataset.dlgTab
        this.render()
        return
      }

      const pick = e.target.closest('[data-dlg-pick]')
      if (pick) {
        const side = parseInt(pick.dataset.dlgSide, 10) || this.side
        if (typeof FX !== 'undefined') FX.click()
        /* castDialogue returns false if the side is already locked. The
           overlay still closes - the card was read, and the lock stands. */
        if (typeof castDialogue === 'function') castDialogue(pick.dataset.dlgPick, side)
        this.close()
        return
      }

      /* A roll over the real vault, so it can never land on a line the
         cabinet does not have. */
      if (e.target.closest('[data-dlg-random]')) {
        if (typeof FX !== 'undefined') FX.click()
        if (typeof castDialogue === 'function') castDialogue(Dialogues.random(this.lang).id, this.side)
        this.close()
        return
      }

      if (e.target.closest('[data-dlg-close]')) this.close()
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
    })
  },

  open(side) {
    if (!this.root || typeof Dialogues === 'undefined') return
    this.side = side

    if (typeof FX !== 'undefined') { FX.unlock(); FX.click() }

    /* Open on the language of the line already in the box, when there is one.
       Coming back to the vault to swap a Tamil line should not dump you back
       on the Hindi tab. */
    const cur = document.getElementById('in-' + side)
    this.lang = 'all'
    if (cur && cur.value) {
      const d = Dialogues.byPrompt(cur.value)
      if (d && d.dialogue) this.lang = d.dialogue.language
    }

    this.render()
    this.root.hidden = false
    this.root.setAttribute('aria-hidden', 'false')
    document.body.classList.add('dlg-picking')
  },

  close() {
    if (!this.root || this.root.hidden) return
    this.root.hidden = true
    this.root.textContent = ''
    this.root.setAttribute('aria-hidden', 'true')
    document.body.classList.remove('dlg-picking')
  },

  render() {
    const langs = [{ id: 'all', label: 'Any' }].concat(Dialogues.languages)
    const counts = Dialogues.counts()
    const shown = Dialogues.byLanguage(this.lang)

    const tabs = langs.map((l) =>
      `<button type="button" class="dlg-tab${l.id === this.lang ? ' on' : ''}" ` +
      `data-dlg-tab="${l.id}">${l.label}<i>${counts[l.id]}</i></button>`
    ).join('')

    const cards = shown.map((d) => Dialogues.cardHTML(d, { side: this.side })).join('')

    this.root.innerHTML =
      `<div class="dlg-panel" role="dialog" aria-modal="true"
            aria-label="Dialogue vault, casting for player ${this.side}">
        <header class="dlg-bar">
          <div class="dlg-bar-l">
            <span class="dlg-kicker">The dialogue vault</span>
            <b>Cast a line for Player ${this.side}</b>
          </div>
          <div class="dlg-bar-actions">
            <button class="dlg-btn" type="button" data-dlg-random>Any line</button>
            <button class="dlg-close" type="button" data-dlg-close
                    aria-label="Close the dialogue vault">&times;</button>
          </div>
        </header>

        <div class="dlg-tabrow">${tabs}</div>

        <p class="dlg-note">Casting a line writes it into your box and nothing
          else. The line is what the parser scores and what both fighters are
          built from &mdash; the same read-only box, the same lock&#8209;in, the
          same 25&#8209;second fight, the same pool and the same mint.</p>

        <div class="dlg-grid" data-lang="${this.lang}">${cards}</div>
      </div>`
  }
}

DialoguePicker.init()
