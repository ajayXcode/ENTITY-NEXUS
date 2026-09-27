/* ------------------------------------------------------------------
   js/matchup.js - the Matchup Lab page.

   It knows two things and no more: how to list the champions, and how to
   ask the server to run them. Every number on the page is a field in the
   response from /api/matchup. Nothing here estimates, scales, or fills a
   gap with something plausible - if a field is absent the cell says so.

   WHY THE PROMPT TRAVELS AND THE ID DOES NOT

   A champion IS its prompt: the stats and the archetype are produced by
   parsePrompt() from that sentence, on both sides. Sending the prompt means
   the server runs the exact fighter the cabinet would build, and there is
   no second registry on the server to drift from the one here.

   Load order: utils.js, config.js, prompt-parser.js, characters.js, then
   this file. requires nothing else.
------------------------------------------------------------------- */

(function () {
  if (typeof Characters === 'undefined') return

  const el = (id) => document.getElementById(id)
  const selA = el('mt-select-a')
  const selB = el('mt-select-b')
  const bar = el('mt-split')
  const grid = el('mt-grid')
  const strat = el('mt-strat')
  const logBody = el('mt-log-body')
  const logCap = el('mt-log-cap')
  const note = el('mt-note')
  const band = el('mt-result-band')
  const status = el('mt-status')
  const runBtn = el('mt-run')

  if (!selA || !selB) return

  const SIDES = { a: '#63b6e8', b: '#f1709a' }

  /* ---- the pickers ---- */

  function options() {
    /* Grouped by archetype so the list reads as eight families rather than
       as sixteen names in registry order. */
    const by = {}
    Characters.all.forEach((c) => {
      const a = Characters.parsed(c).archetype
      if (!by[a]) by[a] = []
      by[a].push(c)
    })
    return Object.keys(by).sort().map((a) => {
      const opts = by[a].map((c) =>
        '<option value="' + c.id + '">' + c.name + ' \u2014 ' + c.title + '</option>').join('')
      return '<optgroup label="' + a + '">' + opts + '</optgroup>'
    }).join('')
  }

  const html = options()
  selA.innerHTML = html
  selB.innerHTML = html

  /* Distinct defaults, so the first thing anyone sees is a real contest. */
  selA.value = Characters.all[0].id
  selB.value = Characters.all[2] ? Characters.all[2].id : Characters.all[1].id

  const chosen = (side) => {
    const sel = side === 'a' ? selA : selB
    return Characters.byId(sel.value) || Characters.all[0]
  }

  function paintPick(side) {
    const c = chosen(side)
    const p = Characters.parsed(c)
    const nameEl = el(side === 'a' ? 'mt-name-a' : 'mt-name-b')
    const subEl = el(side === 'a' ? 'mt-sub-a' : 'mt-sub-b')
    if (nameEl) nameEl.textContent = c.name
    if (subEl) subEl.textContent = p.archetype + ' \u00b7 ' + c.style + ' \u00b7 ' + c.weapons
  }

  selA.addEventListener('change', () => paintPick('a'))
  selB.addEventListener('change', () => paintPick('b'))
  paintPick('a')
  paintPick('b')

  /* ---- the readout ---- */

  function barsHTML(stats, colour) {
    const rows = [['ATK', 'aggression'], ['DEF', 'defense'], ['SPD', 'speed']]
    return '<div class="mt-bars" style="--side:' + colour + '">' + rows.map(function (r) {
      const on = Math.round(Math.max(0, Math.min(1, stats[r[1]])) * 10)
      let segs = ''
      for (let i = 0; i < 10; i++) segs += '<i class="' + (i < on ? 'on' : '') + '"></i>'
      return '<div class="mt-bar"><span>' + r[0] + '</span>' +
             '<div class="mt-bar-track">' + segs + '</div>' +
             '<b>' + Math.round(stats[r[1]] * 100) + '</b></div>'
    }).join('') + '</div>'
  }

  function cell(label, value, unit, cls) {
    return '<div class="mt-cell ' + (cls || '') + '"><span>' + label + '</span><b>' +
      value + (unit ? ' <em>' + unit + '</em>' : '') + '</b></div>'
  }

  function pct(x) { return (x * 100).toFixed(1) + '%' }

  function render(d) {
    const A = chosen('a'), B = chosen('b')

    /* --- the split bar. Widths are the actual shares, including draws, so
       the three segments always add up to the whole series. --- */
    const wa = d.winRate.a, wb = d.winRate.b, wd = d.winRate.draw
    let segs = ''
    if (wa > 0) segs += '<div class="mt-seg a" style="width:' + (wa * 100) + '%">' +
      (wa > 0.08 ? A.name + ' ' + d.wins.a : d.wins.a) + '</div>'
    if (wd > 0) segs += '<div class="mt-seg draw" style="width:' + (wd * 100) + '%">' +
      (wd > 0.08 ? 'DRAW ' + d.wins.draws : '') + '</div>'
    if (wb > 0) segs += '<div class="mt-seg b" style="width:' + (wb * 100) + '%">' +
      (wb > 0.08 ? d.wins.b + ' ' + B.name : d.wins.b) + '</div>'
    bar.innerHTML = segs

    /* --- the numbers --- */
    const leader = d.wins.a === d.wins.b
      ? 'Level'
      : (d.wins.a > d.wins.b ? A.name : B.name)

    grid.innerHTML = [
      cell('Series', d.seeds, 'fights'),
      cell('Win rate A', pct(wa), '', wa > wb ? 'good' : ''),
      cell('Win rate B', pct(wb), '', wb > wa ? 'good' : ''),
      cell('Draws', d.wins.draws, '', ''),
      cell('Leads', leader, ''),
      cell('Knockouts', d.finishes.KO, 'of ' + d.seeds),
      cell('Decisions', d.finishes.DECISION, 'of ' + d.seeds),
      cell('Avg length', d.avgSeconds, 's'),
      cell('Avg HP left A', d.avgHpLeft.a, ''),
      cell('Avg HP left B', d.avgHpLeft.b, '')
    ].join('')

    /* --- the strategies, with the stats the server actually used --- */
    strat.innerHTML = [
      ['a', A, d.a, SIDES.a],
      ['b', B, d.b, SIDES.b]
    ].map(function (row) {
      const side = row[0], c = row[1], s = row[2], colour = row[3]
      return '<div class="mt-strat-card" style="--side:' + colour + '">' +
        '<h4>Side ' + side.toUpperCase() + ' \u00b7 ' + c.name + '</h4>' +
        '<q>' + s.prompt + '</q>' +
        '<p class="mt-pick-sub" style="margin:10px 0 0">' + s.archetype + ' \u00b7 ' + s.tagline + '</p>' +
        barsHTML(s.stats, colour) +
        '</div>'
    }).join('')

    /* --- the seed log --- */
    logCap.textContent = 'First ' + d.log.length + ' fights of ' + d.seeds
    logBody.innerHTML = d.log.map(function (r, i) {
      const who = r.winner === 'p1' ? A.name : (r.winner === 'p2' ? B.name : 'DRAW')
      const cls = r.winner === 'p1' ? 'w1' : (r.winner === 'p2' ? 'w2' : '')
      return '<tr><td>' + (i + 1) + '</td><td>' + r.seed + '</td>' +
        '<td class="' + cls + '">' + who + '</td>' +
        '<td>' + r.frames + '</td><td>' + (r.frames / 60).toFixed(2) + '</td>' +
        '<td>' + r.hpA + '</td><td>' + r.hpB + '</td><td>' + r.how + '</td></tr>'
    }).join('')

    /* --- the honesty line --- */
    const det = d.determinism && d.determinism.ok
      ? 'The harness re-ran the first fight and reached the same frame and the same health, so this series is reproducible.'
      : 'WARNING: the harness did not reproduce its own first fight, so treat every number above as suspect.'

    note.textContent = 'Seeds are the first ' + d.seeds + ' multiples of ' + d.seedStride +
      ', so this exact series can be re-run rather than taken on faith. ' + det

    band.hidden = false
  }

  /* ---- the request ---- */

  let running = false

  async function run() {
    if (running) return
    running = true
    runBtn.disabled = true
    status.className = 'mt-status'
    status.textContent = 'Playing the series\u2026'

    const a = chosen('a')
    const b = chosen('b')
    const n = (el('mt-n') && el('mt-n').value) || 41
    const t0 = Date.now()

    try {
      const url = '/api/matchup?a=' + encodeURIComponent(a.prompt) +
        '&b=' + encodeURIComponent(b.prompt) + '&n=' + encodeURIComponent(n)
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || ('server returned ' + res.status))
      render(data)
      status.textContent = data.seeds + ' fights in ' + ((Date.now() - t0) / 1000).toFixed(1) +
        's \u00b7 ' + data.wins.a + '\u2013' + data.wins.b +
        (data.wins.draws ? '\u2013' + data.wins.draws : '') +
        ' (' + a.name + '\u2013' + b.name + ')'
    } catch (err) {
      status.className = 'mt-status bad'
      status.textContent = 'Could not run the series: ' + err.message
    }

    running = false
    runBtn.disabled = false
  }

  runBtn.addEventListener('click', run)

  el('mt-swap').addEventListener('click', function () {
    const a = selA.value
    selA.value = selB.value
    selB.value = a
    paintPick('a')
    paintPick('b')
    if (!band.hidden) run()
  })

  el('mt-random').addEventListener('click', function () {
    const pick = () => Characters.all[Math.floor(Math.random() * Characters.all.length)].id
    let a = pick(), b = pick()
    let guard = 0
    while (b === a && guard++ < 40) b = pick()
    selA.value = a
    selB.value = b
    paintPick('a')
    paintPick('b')
    run()
  })

  /* A ?a=champ&b=champ link is shareable and lands already loaded, which is
     the point of a GET: somebody can send you the exact series they ran. */
  const qs = new URLSearchParams(location.search)
  const qa = qs.get('a'), qb = qs.get('b')
  if (qa && Characters.byId(qa)) { selA.value = qa; paintPick('a') }
  if (qb && Characters.byId(qb)) { selB.value = qb; paintPick('b') }
  if (el('mt-n') && qs.get('n')) el('mt-n').value = qs.get('n')
  if (qa && qb) run()
})()
