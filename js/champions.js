/* ------------------------------------------------------------------
   champions.js - the optional champion picker in the cabinet.

   This is deliberately NOT a new branch of the flow. Picking a champion
   does exactly one thing: it writes the champion's strategy text into the
   player's existing textarea and fires an `input` event. From there the
   cabinet behaves as it always has - the same liveParse, the same 200-word
   cap, the same LOCK IN, the same commit/reveal, the same fight, the same
   market and the same mint.

   Nothing in this file reads or writes UI.parsed, UI.locked or the room
   protocol. Delete this file and its two buttons and the cabinet is
   byte-for-byte the game it was before, which is the point.

   Load order: after js/ui.js (it dispatches into listeners that init()
   registers) and after js/characters.js (for the registry).
------------------------------------------------------------------- */

const Champions = {
  side: 1,
  root: null,

  init() {
    this.root = document.getElementById('champ-overlay')

    /* The two "CHOOSE A CHAMPION" buttons. Purely additive markup in
       play.html - the prompt phase does not know they exist. */
    for (const b of document.querySelectorAll('.champ-open')) {
      b.addEventListener('click', () => this.open(parseInt(b.dataset.champ, 10) || 1))
    }

    if (!this.root) return

    /* One delegated listener: cards are re-rendered on every open. */
    this.root.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-champ-pick]')
      if (pick) {
        this.pick(pick.dataset.champPick, parseInt(pick.dataset.champSide, 10) || this.side)
        return
      }
      /* A coin flip over the real registry, so it can never land on a
         champion the cabinet does not have. */
      if (e.target.closest('[data-champ-random]')) {
        const list = Characters.all
        this.pick(list[Math.floor(Math.random() * list.length)].id, this.side)
        return
      }
      if (e.target.closest('[data-champ-close]')) this.close()
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
    })
  },

  open(side) {
    if (!this.root || typeof Characters === 'undefined') return
    this.side = side

    if (typeof FX !== 'undefined') { FX.unlock(); FX.click() }

    const cards = Characters.all.map((c) => Characters.cardHTML(c, side)).join('')
    this.root.innerHTML =
      `<div class="champ-panel" role="dialog" aria-modal="true"
            aria-label="Choose a champion for player ${side}">
        <header class="champ-bar">
          <div class="champ-bar-l">Choose a champion &mdash; <b>Player ${side}</b></div>
          <div class="champ-bar-actions">
            <button class="champ-btn" type="button" data-champ-random>Surprise me</button>
            <button class="champ-close" type="button" data-champ-close
                    aria-label="Close champion list">&times;</button>
          </div>
        </header>
        <p class="champ-note">Picking a champion types its strategy into your
          box for you. Everything after that is unchanged: the same parser,
          the same lock&#8209;in, the same fight, the same pool and the same
          mint &mdash; your champion is a prompt like any other.</p>
        <div class="champ-grid">${cards}</div>
      </div>`

    this.root.hidden = false
    this.root.setAttribute('aria-hidden', 'false')
    document.body.classList.add('champ-picking')
  },

  close() {
    if (!this.root || this.root.hidden) return
    this.root.hidden = true
    this.root.textContent = ''
    this.root.setAttribute('aria-hidden', 'true')
    document.body.classList.remove('champ-picking')
  },

  /* The whole integration, in four lines. */
  pick(id, side) {
    const c = typeof Characters !== 'undefined' ? Characters.byId(id) : null
    const box = document.getElementById('in-' + side)
    if (!c || !box || box.disabled) { this.close(); return }

    box.value = c.prompt
    /* Hand it to the cabinet exactly as if it had been typed. ui.js already
       listens for this and does the rest. */
    box.dispatchEvent(new Event('input', { bubbles: true }))
    this.close()
  }
}

Champions.init()
