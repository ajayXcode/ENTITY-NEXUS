/* ------------------------------------------------------------------
   jev.js - JEV, the tactical advisor.

   WHAT JEV IS, AND WHAT IT IS NOT

   JEV decides what the fighter is TRYING to do. It does not move anything.
   Movement, attacks, collision, hit detection, health, knockback, timing, KO
   and rendering all stay in the deterministic engine exactly where they were.
   JEV writes one word - RUSH, ZONE, BAIT, HUNT or TURTLE - into tier 1 of
   ai-controller, and the existing utility scorer and reflex layer do the rest.

     game state  ->  JEV  ->  tactical intent  ->  deterministic controller
                                                        -> 60 FPS engine

   WHY IT PLANS THE WHOLE FIGHT UP FRONT

   The obvious design - call the model every second or two during the fight -
   breaks two things at once, and neither is fixable later:

     1. The fight loop is synchronous. There is nothing sensible to do at
        frame 900 while an HTTP request is in flight; whatever we do instead,
        we have now made the outcome depend on network timing.

     2. Two browsers watching the same match would each get their own answer
        at their own moment. Two screens that quietly crown different winners
        is the worst bug this project can have, and a settled result makes it
        expensive as well as embarrassing.

   So JEV runs ONCE per agent, before the bell, and returns a PLAYBOOK: which
   tactical intent to hold in each phase of the fight, plus how to react to
   falling behind or getting read. During the fight, tier 1 consults the
   playbook synchronously. No network in the loop, no async in the sim, and
   the same playbook on every screen because it is fetched by
   (matchId, side) from a server-side cache - the first caller pays for the
   model, everyone else gets that exact answer back.

   The playbook is genuinely the model's tactical read of two PUBLIC
   strategies against each other. That is the interesting part, and it is the
   part a frame-by-frame call would not have done any better.

   WHEN JEV IS NOT AVAILABLE

   No server, no key, or the model fails: the deterministic planner that was
   already in ai-controller takes over, unchanged. It is seeded, so it gives
   identical results on both screens too. The decision log records which
   source produced every single decision, so a fight advised by the model and
   a fight run on the fallback are told apart by reading the log, not by
   trusting a label.

   THE DECISION LOG

   Every tier-1 decision is appended, in order, with the frame it happened
   on, a hash of the state it was made against, the intent chosen and where
   that intent came from. The whole sequence folds into one decisionHash,
   which goes into the settlement signature and onto the NFT. Anyone holding
   the log can recompute the hash and prove the log belongs to this fight.
   The log itself stays off chain - it is far too big, and the hash is the
   only part anyone needs to verify.
------------------------------------------------------------------- */

const JEV = {
  /* ------------------------------------------------------------------
     Version and configuration.

     Every field in here changes how the agent behaves, so all of it folds
     into configHash(), which is part of the Agent Snapshot and therefore
     part of what spectators are betting on. Change the cadence or the action
     set and you have changed the fighter, even if the prompt is identical -
     which is exactly the substitution the snapshot exists to prevent.
  ------------------------------------------------------------------- */
  VERSION: 'jev-1.0.0',
  CONFIG: {
    cadenceFrames: [60, 130],          // tier-1 re-plan window, at 60fps
    actions: ['RUSH', 'ZONE', 'BAIT', 'HUNT', 'TURTLE'],
    phases: ['opening', 'mid', 'late', 'suddenDeath'],
    reactions: ['behind', 'ahead', 'readBeaten', 'readWinning'],
    temperature: 0                      // advisory only; playbook is fixed
  },

  playbooks: {},        // side -> playbook
  log: [],              // the full decision sequence
  seq: 0,
  model: 'local-planner',
  modelVersion: 'builtin',

  /* ------------------------------------------------------------------
     Identity
  ------------------------------------------------------------------- */

  /* Folds VERSION + CONFIG into the hash that goes in the Agent Snapshot. */
  configHash() {
    return '0x' + this._h(this.VERSION + '|' + JSON.stringify(this.CONFIG))
  },

  modelId() {
    return 'jev/' + this.VERSION + '/' + this.model
  },

  /* ------------------------------------------------------------------
     Pre-fight: fetch a playbook for each side.

     Keyed by (matchId, side) so the server can cache: both players' browsers
     and every spectator ask the same question and get back the same bytes.
     `seed` is included because the playbook is allowed to depend on the
     match, and because it stops a playbook from being reused across matches.
  ------------------------------------------------------------------- */
  async prepare(matchId, agents, seed, onStep) {
    this.reset()

    const sides = ['A', 'B']
    for (const side of sides) {
      const me = agents[side]
      const them = agents[side === 'A' ? 'B' : 'A']
      let book = null

      try {
        book = await this._ask(matchId, side, me, them, seed)
      } catch (e) {
        book = null
      }

      if (book) {
        this.model = book.model || 'jev'
        this.modelVersion = book.modelVersion || 'unknown'
        if (onStep) onStep('  JEV playbook ' + side + ': ' + this._summarize(book))
      } else {
        if (onStep) onStep('  JEV unavailable for ' + side + ' - deterministic planner')
      }
      this.playbooks[side] = book
    }

    return {
      model: this.model,
      modelVersion: this.modelVersion,
      advised: sides.filter((s) => !!this.playbooks[s])
    }
  },

  async _ask(matchId, side, me, them, seed) {
    const res = await fetch('/api/jev/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        matchId: String(matchId),
        side,
        seed: String(seed),
        jevVersion: this.VERSION,
        actions: this.CONFIG.actions,
        phases: this.CONFIG.phases,
        reactions: this.CONFIG.reactions,
        self: { name: me.name, prompt: me.prompt, archetype: me.archetype, stats: me.stats },
        opponent: { name: them.name, prompt: them.prompt, archetype: them.archetype, stats: them.stats }
      })
    })
    if (!res.ok) return null
    const j = await res.json()
    return this._shape(j)
  },

  /* Never trust the wire. A playbook with an action the engine does not have
     would silently fall through to `undefined` in PLANS and crash tier 2
     mid-fight, which is the worst possible moment to find out. */
  _shape(j) {
    if (!j || !j.playbook) return null
    const ok = (v, fb) => (this.CONFIG.actions.indexOf(v) >= 0 ? v : fb)
    const p = j.playbook
    const book = {
      opening: ok(p.opening, 'ZONE'),
      mid: ok(p.mid, 'HUNT'),
      late: ok(p.late, 'RUSH'),
      suddenDeath: ok(p.suddenDeath, 'RUSH'),
      behind: ok(p.behind, 'RUSH'),
      ahead: ok(p.ahead, 'ZONE'),
      readBeaten: ok(p.readBeaten, 'BAIT'),
      readWinning: ok(p.readWinning, 'RUSH'),
      note: String(j.note || p.note || '').slice(0, 160),
      model: j.model || 'jev',
      modelVersion: j.modelVersion || 'unknown'
    }
    return book
  },

  _summarize(b) {
    return b.opening + ' -> ' + b.mid + ' -> ' + b.late +
      (b.note ? '  (' + b.note + ')' : '')
  },

  /* ------------------------------------------------------------------
     In-fight: the synchronous consult.

     Called from tier 1 of ai-controller on every re-plan. Returns an intent
     string, or null to mean "I have nothing, use the local planner". There
     is no await here and there never can be.

     The phase/reaction shape is what keeps this a TACTICAL advisor rather
     than a lookup table: the model chose what to do when behind, when ahead,
     and when its reads are landing or not - and which of those applies is
     decided by the live fight, not by the model.
  ------------------------------------------------------------------- */
  consult(side, ctx) {
    const book = this.playbooks[side]
    let plan = null
    let rule = 'local'

    if (book) {
      if (ctx.suddenDeath) { plan = book.suddenDeath; rule = 'suddenDeath' }
      else if (ctx.hitsTakenStreak >= 2) { plan = book.readBeaten; rule = 'readBeaten' }
      else if (ctx.hitsGivenStreak >= 2) { plan = book.readWinning; rule = 'readWinning' }
      else if (ctx.hpFrac < ctx.oppHpFrac - 0.15) { plan = book.behind; rule = 'behind' }
      else if (ctx.hpFrac > ctx.oppHpFrac + 0.15) { plan = book.ahead; rule = 'ahead' }
      else if (ctx.pressure > 0.66) { plan = book.late; rule = 'late' }
      else if (ctx.pressure > 0.33) { plan = book.mid; rule = 'mid' }
      else { plan = book.opening; rule = 'opening' }
    }

    return { plan, rule, source: plan ? 'jev' : 'local' }
  },

  /* ------------------------------------------------------------------
     The audit trail.

     One record per tier-1 decision, in the order they happened. stateHash
     summarises what the decision was made against, so the log says not just
     "it chose RUSH" but "it chose RUSH looking at this".
  ------------------------------------------------------------------- */
  record(side, frame, ctx, decision) {
    const stateSummary = [
      Math.round(ctx.hpFrac * 1000),
      Math.round(ctx.oppHpFrac * 1000),
      Math.round(ctx.distance),
      Math.round(ctx.pressure * 100),
      ctx.suddenDeath ? 1 : 0,
      ctx.hitsTakenStreak,
      ctx.hitsGivenStreak
    ].join(',')

    this.log.push({
      seq: this.seq++,
      side,
      frame,
      stateHash: this._h(stateSummary),
      decision: decision.plan,
      rule: decision.rule,
      source: decision.source
    })
  },

  /* The whole sequence in 32 bytes. Goes into the settlement signature and
     onto the NFT; the log stays off chain where its size does no harm. */
  decisionHash() {
    if (!this.log.length) return '0x' + '00'.repeat(32)
    const body = this.log
      .map((d) => [d.seq, d.side, d.frame, d.stateHash, d.decision, d.rule, d.source].join(':'))
      .join('|')
    return this._expand(this._h(this.VERSION + '#' + this.log.length + '#' + body))
  },

  /* What the settlement needs to know about how this fight was advised. */
  manifest() {
    return {
      jevVersion: this.VERSION,
      configHash: this.configHash(),
      model: this.model,
      modelVersion: this.modelVersion,
      decisions: this.log.length,
      decisionHash: this.decisionHash(),
      advised: this.log.filter((d) => d.source === 'jev').length
    }
  },

  /* The last few decisions, for the live HUD. */
  recent(side, n) {
    const out = []
    for (let i = this.log.length - 1; i >= 0 && out.length < (n || 4); i--) {
      if (!side || this.log[i].side === side) out.push(this.log[i])
    }
    return out
  },

  reset() {
    this.playbooks = {}
    this.log = []
    this.seq = 0
    this.model = 'local-planner'
    this.modelVersion = 'builtin'
  },

  /* ------------------------------------------------------------------
     Hashing.

     Deliberately NOT keccak: this has to run inside the fight loop and
     inside the headless test harness, neither of which has ethers loaded.
     FNV-1a over the canonical string, expanded to 32 bytes for the chain.
     What matters here is that both browsers compute the same value from the
     same log - not that it resists a preimage attack, because nobody gains
     anything by forging a decision log that still has to match a result
     digest, a seed and an arbiter signature.
  ------------------------------------------------------------------- */
  _h(str) {
    let h = 2166136261 >>> 0
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  },

  /* Stretch the 32-bit digest into a bytes32 the contract can hold. */
  _expand(hex8) {
    let out = ''
    let cur = hex8
    for (let i = 0; i < 8; i++) {
      out += cur
      cur = this._h(cur + '|' + i)
    }
    return '0x' + out.slice(0, 64)
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { JEV }
