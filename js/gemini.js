/* ------------------------------------------------------------------
   gemini.js - asks the arena server what a strategy prompt is worth.

   The local lexicon in prompt-parser.js reads keywords. This reads the
   sentence: "I would rather run than trade hits" has no speed word in it,
   and Gemini still rates it fast.

   The contract with the rest of the app is deliberately narrow:

     AI.analyze(prompt) -> Promise<parsed | null>

   It resolves to the SAME object shape parsePrompt() returns, so every
   caller downstream - the bars, the reveal card, the fight sim, the NFT
   mint - needs no knowledge that an LLM was involved. It resolves to null,
   never rejects, on any failure at all: no server, no keys, timeout, rate
   limit, garbage JSON, aeroplane mode. null means "use the local parse",
   which is always already computed by then.

   Two things therefore have to stay true:
     - nothing here may throw into a caller.
     - nothing here may make the player wait longer than AI_TIMEOUT_MS.
------------------------------------------------------------------- */

const AI = {
  /* null = not asked yet, true/false once /api/health has answered. The
     probe is fired at boot so that by the time anyone locks in a prompt we
     already know whether to bother, and the UI can say so honestly. */
  available: null,
  keys: 0,
  lastError: '',

  endpoint() {
    return (typeof CONFIG !== 'undefined' && CONFIG.AI_ENDPOINT) || '/api/analyze'
  },
  healthEndpoint() {
    return this.endpoint().replace(/\/analyze$/, '/health')
  },
  enabled() {
    if (typeof CONFIG !== 'undefined' && CONFIG.AI_ENABLED === false) return false
    if (typeof QP !== 'undefined' && QP.noai) return false
    return true
  },

  /* fetch + AbortController, so a hung socket cannot hold the screen. */
  async post(url, body, ms) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store'
      })
      const json = await res.json().catch(() => null)
      return { ok: res.ok, status: res.status, json: json }
    } catch (e) {
      return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'timeout' : e.message }
    } finally {
      clearTimeout(timer)
    }
  },

  /* Cheap, fire-and-forget, and the only thing that ever sets available. */
  async probe() {
    if (!this.enabled()) { this.available = false; this.lastError = 'disabled'; return false }
    const r = await this.post(this.healthEndpoint(), null, 2500)
    const ok = !!(r.ok && r.json && r.json.ok && r.json.keys > 0)
    this.available = ok
    this.keys = (r.json && r.json.keys) || 0
    if (!ok) {
      this.lastError = (r.json && r.json.error) || r.error ||
        (r.status ? 'health http ' + r.status : 'no arena server')
      console.info('[ai] offline - using the local lexicon parser (' + this.lastError + ')')
    } else {
      console.info('[ai] online - ' + this.keys + ' gemini key(s), models: ' +
        ((r.json.models || []).join(', ')))
    }
    return ok
  },

  /* The one call the UI makes. `mode` is 'fighter', 'pen' or 'hex' - the
     three prompt-driven games - and only changes how the stats are
     described to the model: flicking a pen off a desk, a swordfight and a
     lap of a racing track want the same three numbers, but not the same
     reading of "aggressive".

     Returns a parsePrompt-shaped object, or null to mean "nothing better
     than the local parse". */
  async analyze(prompt, mode) {
    const text = String(prompt || '').trim()
    if (!text || !this.enabled()) return null
    if (this.available === false) return null   // probe already said no

    const ms = (typeof CONFIG !== 'undefined' && CONFIG.AI_TIMEOUT_MS) || 7000
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const r = await this.post(this.endpoint(), { prompt: text, mode: mode || 'fighter' }, ms)
    const took = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)

    if (!r.ok || !r.json || !r.json.ok) {
      this.lastError = (r.json && r.json.error) || r.error || ('http ' + r.status)
      /* A single failed fight must not switch the AI off for the session -
         a 429 on one key is routine and the next fight may well work. Only
         a total absence of server (status 0) is treated as terminal. */
      if (r.status === 0 && r.error !== 'timeout') this.available = false
      console.warn('[ai] analyze failed after ' + took + 'ms: ' + this.lastError)
      return null
    }

    this.available = true
    const out = this.toParsed(r.json, text)
    if (out) {
      console.log('[ai] ' + (r.json.model || 'gemini') + ' ' + took + 'ms' +
        (r.json.cached ? ' (cached)' : '') + ' -> ' + out.archetype + ' ' +
        JSON.stringify(out.stats))
    }
    return out
  },

  /* Server JSON -> the exact object parsePrompt() hands back.

     Everything is re-validated here rather than trusted. The server already
     clamps and budgets, but this file is what the fight sim actually eats,
     and an undefined slipping into stats.speed is a NaN fighter that stands
     still on the projector. */
  toParsed(j, rawPrompt) {
    const s = j && j.stats
    if (!s) return null
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null)
    if (n(s.aggression) === null || n(s.defense) === null || n(s.speed) === null) return null

    let stats = {
      aggression: clamp01(s.aggression),
      defense: clamp01(s.defense),
      speed: clamp01(s.speed)
    }
    /* Same budget the local parser lives under. The model is told the rule
       and mostly follows it; "mostly" is not a balance guarantee. */
    stats = budgetStats(stats)

    const prompt = sanitizePrompt(rawPrompt)
    const traits = Array.isArray(j.traits) ? j.traits.filter((t) => typeof t === 'string' && t.trim()) : []

    /* The bars render matched[] as chips, so the traits Gemini reports
       become the reasoning shown under the prompt box. stat: 'ai' just
       picks the chip colour. */
    const matched = traits.slice(0, 4).map((t) => ({
      label: String(t).slice(0, 22), stat: 'ai', delta: 0, compound: String(t).slice(0, 22)
    }))

    const fallbackArch = archetypeFor(stats)
    const archetype = cleanArchetype(j.archetype) || fallbackArch.name
    const tagline = cleanTagline(j.tagline) || fallbackArch.tag

    return {
      prompt: prompt,
      stats: stats,
      matched: matched,
      improvised: !!j.improvised,
      archetype: archetype,
      tagline: tagline,
      source: 'gemini',
      model: j.model || 'gemini'
    }
  }
}

/* Letters, digits, single spaces - this string is minted into the on-chain
   SVG, and the reveal card has room for about 18 characters. */
function cleanArchetype(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length >= 2 ? t.slice(0, 18).trim() : ''
}

function cleanTagline(s) {
  const t = String(s || '').replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length >= 3 ? t.slice(0, 60) : ''
}

/* Probe once, early, without blocking anything. */
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => { AI.probe() })
}
