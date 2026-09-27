/* ------------------------------------------------------------------
   wallet.js - the wallet chip, in one place.

   Every page that shows a wallet shows the SAME control: a dot, a label,
   and a small panel with the full address, the network, the MON balance and
   a way out. It was already a button on the landing page and on the
   cabinet's title screen, and two copies of a wallet control is two places
   for them to disagree about whether a wallet is connected.

   WHAT IT IS NOT

   It is not a precondition for anything. No fight reads it, no analysis
   waits on it, and a page with no wallet at all renders, plays and settles
   exactly as before - the chip just says so. Connecting from here is the
   same Chain.connectWallet() the arena screen has always called, so there
   is one wallet session per page rather than one per button.

   GRACEFUL BY CONSTRUCTION

   `window.ethereum` is absent in a plain browser, in a private window with
   no extension, and in every headless test run. Every branch below is
   written so that case is a state it displays, not an exception it throws.

   Usage:

       <button class="wchip" id="x"><i></i><span>Connect wallet</span></button>
       WalletChip.attach(document.getElementById('x'), { label: 'Connect wallet' })

   Load order: after js/utils.js, js/config.js and js/blockchain.js.
------------------------------------------------------------------- */

const WalletChip = {
  /* Everything the chip knows is derived from Chain plus one injected-provider
     call. Nothing is cached across a disconnect. */
  async _facts() {
    if (typeof Chain === 'undefined' || !Chain.hasWallet()) {
      return { state: 'absent' }
    }
    const id = await Chain.chainIdHex()
    const base = { state: Chain.userAddress ? 'on' : 'off', chainId: id, onMonad: Chain.onMonad(id) }
    if (!Chain.userAddress) return base
    try {
      const bal = await Chain.monBalance()
      base.balance = bal ? bal.mon : null
    } catch (e) {
      /* A dead RPC must not empty the chip - the address is still true. */
      base.balance = null
    }
    return base
  },

  _short(a) {
    return a ? a.slice(0, 6) + '\u2026' + a.slice(-4) : ''
  },

  _fmtMon(mon) {
    if (mon == null) return '\u2014'
    const n = Number(mon)
    if (!isFinite(n)) return '\u2014'
    if (n === 0) return '0'
    if (n < 0.0001) return '<0.0001'
    return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  },

  attach(el, opts) {
    if (!el || el.dataset.wchip === '1') return null
    el.dataset.wchip = '1'

    const o = opts || {}
    const label = o.label || 'Connect wallet'
    const absentText = o.absentText || 'No wallet found'
    const title = el.querySelector('span')

    /* The panel lives on <body>, not beside the button. The cabinet's stage
       carries a CSS transform (it is scaled to fit the window), and a
       transformed ancestor makes `position: fixed` resolve against that
       ancestor instead of the viewport - so a sibling panel would be placed
       in the scaled coordinate space and land nowhere near the button.
       Hanging it off body keeps the viewport as the frame of reference on
       every page. */
    const panel = document.createElement('div')
    panel.className = 'wchip-panel'
    panel.hidden = true
    document.body.appendChild(panel)

    const setLabel = (t) => {
      if (title) title.textContent = t
      else el.textContent = t
    }

    let busy = false

    const paint = async () => {
      const f = await this._facts()

      if (f.state === 'absent') {
        el.disabled = true
        el.classList.add('off')
        el.classList.remove('on')
        setLabel(absentText)
        el.setAttribute('title', 'Install a browser wallet (e.g. MetaMask) to connect')
        panel.hidden = true
        return
      }

      el.disabled = false
      el.classList.toggle('on', f.state === 'on')
      el.classList.remove('off')
      setLabel(f.state === 'on' ? this._short(Chain.userAddress) : label)
      el.setAttribute('title', f.state === 'on'
        ? 'Connected \u2014 click for balance and network'
        : 'Connect a browser wallet')

      if (f.state !== 'on') { panel.hidden = true; return }

      const rows = [
        '<div class="wchip-row"><span>Address</span><b title="' + Chain.userAddress + '">' +
          this._short(Chain.userAddress) + '</b></div>',
        '<div class="wchip-row"><span>Network</span><b>' +
          (f.onMonad ? MONAD.chainName : 'Not ' + MONAD.chainName) + '</b></div>',
        '<div class="wchip-row"><span>Balance</span><b>' +
          this._fmtMon(f.balance) + ' <em>MON</em></b></div>'
      ]

      const actions = []
      if (!f.onMonad) {
        actions.push('<button class="wchip-act" data-wact="switch" type="button">Switch to ' +
          MONAD.chainName + '</button>')
      }
      actions.push('<button class="wchip-act" data-wact="copy" type="button">Copy address</button>')
      actions.push('<button class="wchip-act" data-wact="refresh" type="button">Refresh</button>')
      actions.push('<button class="wchip-act quit" data-wact="disconnect" type="button">Disconnect</button>')

      panel.innerHTML = '<div class="wchip-in">' + rows.join('') +
        '<div class="wchip-acts">' + actions.join('') + '</div></div>'
    }

    /* Fixed positioning rather than absolute: the chip lives inside a
       header on one page and a button stack on another, and an absolutely
       positioned panel would inherit whichever of those happens to clip.
       The coordinates are recomputed on every open so a scroll or a resize
       cannot leave it floating over the wrong thing. */
    const place = () => {
      const r = el.getBoundingClientRect()
      const w = panel.offsetWidth || 250
      const h = panel.offsetHeight || 0
      const left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))
      const below = r.bottom + 8
      /* Below the button unless there is no room and there is room above. */
      const top = (below + h > window.innerHeight - 12 && r.top - h - 8 > 12)
        ? r.top - h - 8
        : below
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
    }

    const open = async () => { panel.hidden = false; await paint(); place() }
    const shut = () => { panel.hidden = true }

    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (busy) return

      /* Closed and disconnected: the click is a connect. */
      if (!Chain.userAddress) {
        busy = true
        el.disabled = true
        setLabel('Connecting\u2026')
        try { await Chain.connectWallet() } catch (err) { /* refused or absent */ }
        busy = false
        await paint()
        if (Chain.userAddress) await open()
        return
      }

      if (panel.hidden) await open()
      else shut()
    })

    panel.addEventListener('click', async (e) => {
      e.stopPropagation()
      const b = e.target.closest('[data-wact]')
      if (!b || busy) return
      const act = b.dataset.wact

      if (act === 'copy') {
        try { await navigator.clipboard.writeText(Chain.userAddress) } catch (err) { /* denied */ }
        b.textContent = 'Copied'
        setTimeout(() => { b.textContent = 'Copy address' }, 1200)
        return
      }

      busy = true
      b.disabled = true
      try {
        if (act === 'switch') await Chain.ensureMonadNetwork()
        else if (act === 'disconnect') { Chain.disconnect(); shut() }
      } catch (err) { /* refused; paint() below shows where we actually are */ }
      busy = false
      await paint()
    })

    /* Clicking anywhere else closes it, and so does Escape - the same
       courtesy the cabinet's overlay already extends. */
    document.addEventListener('click', () => { if (!panel.hidden) shut() })
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut() })

    /* A wallet can be swapped or disconnected from its own UI at any time. */
    if (typeof window !== 'undefined' && window.ethereum && window.ethereum.on) {
      const resync = async (e) => {
        const accts = e && e.length ? e : []
        if (!accts.length) Chain.disconnect()
        else { Chain.signer = null; Chain.userAddress = null }
        await paint()
      }
      window.ethereum.on('accountsChanged', resync)
      window.ethereum.on('chainChanged', () => paint())
    }

    paint()
    return { refresh: paint }
  },

  /* Attach to every [data-wallet-chip] on the page. */
  mount(scope) {
    const root = scope || document
    const els = root.querySelectorAll('[data-wallet-chip]')
    const out = []
    els.forEach((el) => out.push(this.attach(el)))
    return out
  }
}
