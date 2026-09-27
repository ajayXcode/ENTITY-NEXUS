/* ------------------------------------------------------------------
   ai-controller.js - the fighter brains.

   ARCHITECTURE (modelled on how real agent-driven games are built):

     Tier 1  PLAN      slow deliberation, re-picked every ~1-2s or on a big
                       event. Chooses a game plan: RUSH / ZONE / BAIT /
                       HUNT / TURTLE. This is the same slow-plan/fast-execute
                       split that LLM-agent games (Voyager, Generative
                       Agents) use - we just derive the plan from stats and
                       an opponent model instead of from a language model,
                       so it costs microseconds and never stalls the frame.

     Tier 2  UTILITY   every decision tick each candidate action is SCORED
                       against considerations (range error, cooldown, health,
                       opponent state, plan bias, opponent tendencies), then
                       chosen by weighted random among the positives. This is
                       Utility AI / IAUS - the thing that stops fights
                       looking like a loop, because the scores slide
                       continuously instead of tripping fixed thresholds.

     Tier 3  REFLEX    every single frame: stun lockout, attack commitment,
                       dodge reaction to the opponent's windup, punish on
                       stun or whiff-recovery.

   OPPONENT MODEL: each AI keeps exponential moving averages of how often the
   opponent jumps, attacks and whiffs, and shifts its plan weights
   accordingly. That is what makes a fight feel like the fighters are
   reading each other rather than rolling dice.

   The AI is still a VIRTUAL KEYBOARD: it writes into the same `keys` object
   the human controls used. That keeps upstream's movement and sprite logic
   on the path it was written for - in particular handleMovement()'s
   unconditional switchSprite('run'/'idle') every frame, which is the only
   thing that releases a fighter from a finished attack animation.

   NOTE: this repo's handleMovement gates on `lastKey` as well as `pressed`
   (`keys.a.pressed && player.lastKey === 'a'`), so every press must set both
   or the fighter silently refuses to move.
------------------------------------------------------------------- */

const STATE = {
  ADVANCE: 'ADVANCE', HOLD: 'HOLD', RETREAT: 'RETREAT', DASH: 'DASH',
  COMMIT: 'COMMIT', DODGE: 'DODGE', HOP: 'HOP', PUNISH: 'PUNISH',
  BLOCK: 'BLOCK', OVER: 'OVER'
}

/* Game plans. `range` is the preferred separation; the rest are additive
   biases applied to the utility scores. */
/* `range` must stay comfortably inside the [50,220] strike band. Earlier
   values (up to 204) parked defensive fighters right on the edge of their
   own reach, where the ATTACK score tapers to nearly nothing - turtles
   camped there and never swung a single time in a whole round. */
const PLANS = {
  RUSH:   { range: 128, atk:  0.45, ret: -0.40, dodge: -0.18, jump:  0.04, dash:  0.30 },
  ZONE:   { range: 178, atk:  0.06, ret:  0.22, dodge:  0.10, jump:  0.06, dash:  0.05 },
  BAIT:   { range: 166, atk: -0.08, ret:  0.18, dodge:  0.32, jump:  0.16, dash:  0.10 },
  HUNT:   { range: 172, atk:  0.18, ret:  0.06, dodge:  0.26, jump: -0.02, dash:  0.14 },
  TURTLE: { range: 186, atk: -0.18, ret:  0.42, dodge:  0.42, jump: -0.06, dash: -0.10 }
}

function createAI({ self, opponent, keymap, stats, rng, side, jevSide }) {
  const towardDir = side === 'left' ? 1 : -1
  const cdFloor = side === 'left' ? CONFIG.COOLDOWN_FLOOR_P1 : CONFIG.COOLDOWN_FLOOR_P2
  const baseSpeed = CONFIG.moveSpeed(stats)
  const period = CONFIG.decisionPeriod(stats)

  // Which separations can this fighter actually land a hit at? These MUST
  // match the attackBox numbers in game.js or the AI attacks from ranges
  // that can only whiff. (see the geometry note at the top of config.js)
  /* Geometrically the lower bounds differ (50 for the Samurai, 0 for the
     Monk) but MIN_GAP is 70, so neither is ever reachable. Using the raw
     values made the close-range ATTACK score taper for P1 and not for P2,
     which quietly gave P2 more attacks per round. Clamp both to the
     distance that can actually occur. */
  const hitMin = Math.max(side === 'left' ? 50 : 0, CONFIG.MIN_GAP)
  const hitMax = 220

  const ai = {
    state: STATE.HOLD,
    plan: 'ZONE',
    stateUntil: 0,
    planUntil: 0,
    nextDecision: 0,
    nextAttack: 0,
    shuffleDir: 1,
    shuffleFlip: 0,
    lastOppAttacking: false,
    planSource: 'local',    // 'jev' when the advisor chose this plan
    planRule: 'opening',    // which playbook branch fired
    baseSpeed,
    // opponent model (exponential moving averages, 0..1-ish)
    opp: { jumpy: 0.2, attacky: 0.3, whiffy: 0.2 },
    hitsTakenStreak: 0,
    hitsGivenStreak: 0,
    debug: {}
  }

  const jit = (v) => v + (rng() - 0.5) * 2 * CONFIG.JITTER

  function release() {
    keys[keymap.left].pressed = false
    keys[keymap.right].pressed = false
    self.velocity.x = 0
  }

  /* dir: -1 left, 0 none, +1 right. mult scales moveSpeed for this frame. */
  function move(dir, mult) {
    self.moveSpeed = baseSpeed * (1 + CONFIG.RAGE_SPEED * self.rage) *
      (mult === undefined ? 1 : mult)
    if (dir === 0) {
      keys[keymap.left].pressed = false
      keys[keymap.right].pressed = false
      return
    }
    const key = dir > 0 ? keymap.right : keymap.left
    const other = dir > 0 ? keymap.left : keymap.right
    keys[other].pressed = false
    keys[key].pressed = true
    self.lastKey = key            // required: handleMovement checks lastKey
  }

  function setState(s, frames, frame) {
    ai.state = s
    ai.stateUntil = frame + (frames || 0)
  }

  function doAttack(frame, world) {
    if (!self.canAttack(frame)) return false
    if (frame < ai.nextAttack) return false
    /* Never swing while airborne. The attack box rises with the fighter, so
       against a grounded opponent it is geometrically incapable of
       connecting - a pure wasted attack plus a cooldown. */
    if (!self.grounded) return false

    const move = chooseMove(frame, world)
    tryAttack(self, move)

    let cd = CONFIG.cooldown(stats) * (1 - CONFIG.RAGE_CD * self.rage)
    // Combo window: a landed hit buys a much faster follow-up, which is what
    // produces visible 2-3 hit strings instead of isolated pokes.
    if (frame < self.comboUntil) cd *= (0.42 + 0.25 * (1 - stats.aggression))
    cd = Math.round(cd * (1 - 0.4 * world.pressure))
    if (world.suddenDeath) cd = Math.round(cd * 0.75)
    cd = Math.round(cd * CONFIG.MOVES[move].cdMult)
    ai.nextAttack = frame + Math.max(cdFloor, cd)
    return true
  }

  /* ---------------- move selection ----------------

     This is where the prompt reaches the movelist. A berserker does not just
     attack more often than a turtle, it swings differently - and that is
     visible from the back of a room in a way that a cooldown number is not.

       aggression -> heavy. Committing to a slow, hard swing IS aggression.
       speed      -> jab. Fast fighters poke.
       defense    -> jab, but only as a punish (see below).

     Situation overrides temperament, because that is what a competent player
     does:

       punishing a whiff   jab. The window is short and guaranteed; a heavy
                           would be too slow to land inside it and throwing
                           one away here is the single worst decision in the
                           game.
       mid-combo           jab. The combo discount already shortened the
                           cooldown, and a heavy's 17-frame startup gives the
                           opponent time to recover out of the string.
       finishing blow      heavy. If it kills, the extra risk costs nothing.
  ------------------------------------------------------------------- */
  function chooseMove(frame, world) {
    const oppHp = opponent.health

    // Punish: the opponent is stuck in whiff recovery. Take the guaranteed
    // fast hit, never gamble the window on a heavy.
    if (frame < opponent.recoverUntil) return 'jab'

    // Mid-string: keep it fast or the string drops.
    if (frame < self.comboUntil) return rng() < 0.82 ? 'jab' : 'normal'

    // Kill shot: a heavy that finishes the round has no downside.
    if (oppHp <= 26 && oppHp > 0) return rng() < 0.62 ? 'heavy' : 'normal'

    /* Otherwise temperament. Sudden death pushes everyone toward heavies -
       damage is doubled, so the payoff for committing is at its highest and
       the round is about to end anyway. */
    let pHeavy = 0.10 + 0.42 * stats.aggression - 0.18 * stats.speed
    let pJab = 0.16 + 0.44 * stats.speed + 0.16 * stats.defense - 0.14 * stats.aggression
    if (world.suddenDeath) { pHeavy += 0.22; pJab -= 0.10 }

    const r = rng()
    if (r < clamp01(pHeavy)) return 'heavy'
    if (r < clamp01(pHeavy) + clamp01(pJab)) return 'jab'
    return 'normal'
  }

  /* ---------------- opponent model ---------------- */

  function observe(frame, world) {
    const k = 0.012
    const jumping = !opponent.grounded ? 1 : 0
    const attacking = world.oppAttacking ? 1 : 0
    ai.opp.jumpy += (jumping - ai.opp.jumpy) * k
    ai.opp.attacky += (attacking - ai.opp.attacky) * k
    const whiffing = opponent.recoverUntil > frame ? 1 : 0
    ai.opp.whiffy += (whiffing - ai.opp.whiffy) * k
  }

  /* ---------------- tier 1: pick a game plan ---------------- */

  /* JEV, the tactical advisor, gets first refusal on every re-plan.

     It is consulted SYNCHRONOUSLY against a playbook fetched before the bell
     (see jev.js for why it cannot be a call per decision), so this costs
     nothing and cannot stall a frame. When JEV has no playbook - no server,
     no key, or the model failed - `consult` returns a null plan and the
     weighted local planner below runs exactly as it always did.

     Either way the decision is logged. The log is what the decision hash is
     built from, and a hash that only covered the model's decisions would be
     a hash that went quiet precisely when the fallback was doing the work. */
  function pickPlan(frame, world, hpFrac, oppHpFrac) {
    if (typeof JEV !== 'undefined' && jevSide) {
      const ctx = {
        hpFrac, oppHpFrac,
        distance: Math.abs(self.position.x - opponent.position.x),
        pressure: world.pressure,
        suddenDeath: !!world.suddenDeath,
        hitsTakenStreak: ai.hitsTakenStreak,
        hitsGivenStreak: ai.hitsGivenStreak
      }
      const advice = JEV.consult(jevSide, ctx)
      JEV.record(jevSide, frame, ctx, advice)

      if (advice.plan) {
        ai.plan = advice.plan
        ai.planRule = advice.rule
        ai.planSource = 'jev'
        /* Same cadence window the local planner uses, and still drawn from
           the seeded rng - the advisor chooses WHAT, never WHEN. */
        ai.planUntil = frame + 60 + Math.round(rng() * 70)
        return
      }
      ai.planSource = 'local'
    }

    pickPlanLocal(frame, world, hpFrac, oppHpFrac)
  }

  function pickPlanLocal(frame, world, hpFrac, oppHpFrac) {
    const a = stats.aggression, d = stats.defense, s = stats.speed
    const losing = hpFrac < oppHpFrac - 0.15
    const winning = hpFrac > oppHpFrac + 0.15

    const w = {
      RUSH:   0.10 + 1.30 * a + 0.9 * world.pressure + (losing && a > 0.5 ? 0.45 : 0),
      ZONE:   0.15 + 0.70 * d + 0.55 * s + (winning ? 0.35 : 0),
      BAIT:   0.10 + 0.55 * d + 0.60 * s + 0.9 * ai.opp.attacky,
      HUNT:   0.10 + 0.70 * d + 0.35 * a + 1.5 * ai.opp.whiffy,
      TURTLE: 0.05 + 1.10 * d + (losing && d > 0.5 ? 0.55 : 0)
    }
    // Pressure squeezes every passive plan out of the pool.
    const squeeze = 1 - 0.85 * world.pressure
    w.ZONE *= squeeze; w.BAIT *= squeeze; w.TURTLE *= squeeze
    if (world.suddenDeath) { w.ZONE = w.BAIT = w.TURTLE = 0.01; w.RUSH += 2 }

    // Getting opened up repeatedly should change the plan, not repeat it.
    if (ai.hitsTakenStreak >= 2) { w.BAIT += 0.5; w.TURTLE += 0.4; w.RUSH *= 0.6 }
    if (ai.hitsGivenStreak >= 2) w.RUSH += 0.5

    let total = 0
    for (const k in w) { w[k] = Math.max(0.01, w[k]); total += w[k] }
    let r = rng() * total
    for (const k in w) { r -= w[k]; if (r <= 0) { ai.plan = k; break } }

    const dur = 60 + Math.round(rng() * 70)
    ai.planUntil = frame + dur
  }

  /* ---------------- tier 2: score the candidate actions ---------------- */

  function scoreActions(frame, world, d, a_eff, d_eff, hpFrac) {
    const P = PLANS[ai.plan]
    const target = world.suddenDeath ? 138 : lerp(P.range, 138, world.pressure)
    const err = d - target                       // >0 means too far apart
    const ready = frame >= ai.nextAttack && self.canAttack(frame) && self.grounded
    const oppStunned = opponent.isStunned(frame)
    const oppRecovering = frame < opponent.recoverUntil
    const oppAir = !opponent.grounded
    const inRange = d >= hitMin && d <= hitMax
    /* Cornered fighters used to just run. Past three-quarters rage they
       stop fleeing and start swinging - that is the comeback. */
    const desperate = hpFrac < 0.30 && stats.defense > 0.6 &&
      !world.suddenDeath && self.rage < 0.75

    const S = {}

    // ---- ATTACK ----
    if (ready && inRange) {
      let v = 0.32 + 0.60 * a_eff + P.atk
      /* Taper only near the true edges of the strike band. A /70 divisor
         damped the whole outer half of the band, which is precisely where
         defensive plans live - they never attacked. /40 leaves everything
         from ~90 to ~180 at full value. */
      const edge = Math.min(d - hitMin, hitMax - d)
      v *= clamp01(edge / 40)
      if (oppStunned) v += 0.95                      // punish
      if (oppRecovering) v += 0.85                   // whiff punish
      if (frame < self.comboUntil) v += 0.55         // continue the string
      if (oppAir) v -= 0.75                          // they are above the box
      if (world.oppAttacking) v -= 0.30 * (1 - a_eff)  // trading is a choice
      S.ATTACK = v
    }

    // ---- ADVANCE ----
    {
      let v = 0.20 + 0.45 * a_eff + clamp01(err / 160) * 0.95 - P.ret * 0.5
      if (d <= CONFIG.MIN_GAP + 6) v = -1
      if (oppRecovering) v += 0.70                   // close in for the punish
      S.ADVANCE = v
    }

    // ---- RETREAT ----
    if (d < CONFIG.MAX_KITE && !world.suddenDeath) {
      let v = 0.10 + 0.55 * d_eff + P.ret + clamp01(-err / 120) * 0.75
      if (desperate) v += 0.55
      if (world.oppAttacking) v += 0.35 * d_eff
      if (frame < self.comboUntil) v -= 0.5          // don't abandon a string
      S.RETREAT = v
    }

    // ---- HOLD (footsies) ----
    S.HOLD = 0.34 + clamp01(1 - Math.abs(err) / 150) * 0.40 + (ai.plan === 'BAIT' ? 0.22 : 0)

    // ---- DASH ----
    if (self.grounded && Math.abs(err) > 55) {
      S.DASH = 0.05 + 0.75 * stats.speed + P.dash + clamp01(Math.abs(err) / 200) * 0.35
    }

    // ---- JUMP ----
    if (self.grounded) {
      let v = 0.06 + 0.32 * stats.speed + P.jump
      // Jumping into someone who attacks a lot is how you get hit out of it.
      v -= 0.30 * ai.opp.attacky
      if (world.suddenDeath) v -= 0.25
      S.JUMP = v
    }

    return S
  }

  /* Weighted-random among positive scores. Softmax-ish: squaring widens the
     gap between good and mediocre options while still leaving room for the
     surprising choice that keeps fights from looking scripted. */
  function chooseAction(S) {
    let total = 0
    const w = {}
    for (const k in S) {
      const v = jit(S[k])
      if (v <= 0) continue
      w[k] = v * v
      total += w[k]
    }
    if (total <= 0) return 'HOLD'
    let r = rng() * total
    for (const k in w) { r -= w[k]; if (r <= 0) return k }
    return 'HOLD'
  }

  /* ---------------- main tick ---------------- */

  ai.tick = function (frame, world) {
    const d = world.d
    // Floor of 0.22 so that even a pure-coward prompt still throws the
    // occasional attack. At a=0.07 the ATTACK score never cleared the
    // others and cowards went entire rounds without swinging once.
    /* Rage folds into effective aggression, so a fighter on the ropes
       genuinely comes forward instead of dying quietly. */
    const a_eff = Math.min(1, Math.max(0.22, stats.aggression) +
      0.6 * world.pressure + CONFIG.RAGE_AGGRO * self.rage)
    const d_eff = stats.defense * (1 - 0.8 * world.pressure)
    const hpFrac = self.health / 100
    const oppHpFrac = opponent.health / 100
    /* Cornered fighters used to just run. Past three-quarters rage they
       stop fleeing and start swinging - that is the comeback. */
    const desperate = hpFrac < 0.30 && stats.defense > 0.6 &&
      !world.suddenDeath && self.rage < 0.75

    ai.debug = { d: Math.round(d), plan: ai.plan, state: ai.state, opp: ai.opp,
                 planSource: ai.planSource, planRule: ai.planRule }

    /* ---------- tier 3: reflex, highest priority first ---------- */

    if (self.dead || opponent.dead || game.over) { setState(STATE.OVER, 0, frame); release(); return }

    // Stunned: no input, and critically NO attack - attacking out of a
    // take-hit is what produces phantom hits.
    if (self.isStunned(frame)) { release(); return }

    // COMMIT: our own attack is in flight. Never retreat during the windup -
    // the damage test only looks at where we are on the damage frame, so
    // backing off here turns every attack into a whiff.
    if (self.isAttacking || self.isAttackAnim()) {
      ai.state = STATE.COMMIT
      const P = PLANS[ai.plan]
      if (d > P.range + 30) move(towardDir, 0.35)
      else move(0)
      return
    }

    observe(frame, world)

    /* Read the opponent's attack state from the frame snapshot, not live.
       ai1 ticks before ai2, so reading opponent.isAttacking directly let P2
       see P1's attack on the frame it started while P1 saw P2's a frame
       late - worth ~7 points of accuracy in every mirror match. */
    const oppAttacking = world.oppAttacking
    const rising = oppAttacking && !ai.lastOppAttacking
    ai.lastOppAttacking = oppAttacking

    if (rising && d < 290 && ai.state !== STATE.DODGE) {
      /* The opponent just started a swing. Three answers, in the order a
         defensive fighter would actually consider them.

         Guard first, and only from inside the strike band: a block only
         beats an attack that was going to reach you, and raising one at
         range wastes the cooldown for nothing. Out of range, retreating is
         strictly better and the old dodge roll handles it. */
      let blocked = false
      if (d <= CONFIG.BAND_MAX + 20 && self.grounded && frame >= self.blockReadyAt) {
        let pb = jit(CONFIG.pBlock(stats) + PLANS[ai.plan].dodge * 0.25)
        /* Cornered fighters block more - there is nowhere left to retreat
           to, and eating the hit is how a cornered fighter dies. */
        const toWall = side === 'left'
          ? self.position.x
          : canvas.width - self.width - self.position.x
        if (toWall < 120) pb += 0.18
        // ...but never guard in sudden death. Damage is doubled and chip
        // alone will finish you; the round has to be won, not survived.
        if (world.suddenDeath) pb = 0
        if (rng() < pb && self.startBlock(frame, world.pressure)) {
          setState(STATE.BLOCK, self.blockUntil - frame, frame)
          blocked = true
        }
      }

      if (!blocked) {
        let p = jit(CONFIG.pDodgeReact(d_eff) + PLANS[ai.plan].dodge * 0.5)
        if (desperate) p += 0.20
        if (rng() < p) {
          if (stats.speed > 0.55 && self.grounded && rng() < 0.45) {
            tryJump(self)            // real i-frames: rising >100px clears the box
            setState(STATE.DODGE, 20, frame)
          } else {
            setState(STATE.DODGE, 16, frame)
          }
        }
        // A failed roll means walking into the hit. That is exactly what a
        // low-defense prompt should look like.
      }
    }

    /* Holding a guard: stand absolutely still. Blocking while walking would
       let a fighter advance behind an invulnerable wall, which is the single
       most degenerate thing a block can do to a fighting game. */
    if (self.isBlocking(frame)) {
      ai.state = STATE.BLOCK
      move(0)
      return
    }

    if (ai.state === STATE.DODGE && frame < ai.stateUntil) {
      if (d < CONFIG.MAX_KITE) move(-towardDir, 1)
      else move(0)
      return
    }

    // Free punish on a stunned or whiff-recovering opponent.
    if ((opponent.isStunned(frame) || frame < opponent.recoverUntil) &&
        d >= hitMin && d <= hitMax) {
      if (rng() < jit(CONFIG.pPunish(a_eff)) && doAttack(frame, world)) {
        ai.state = STATE.PUNISH
        move(0)
        return
      }
    }

    /* ---------- tier 1: re-plan ---------- */
    if (frame >= ai.planUntil) pickPlan(frame, world, hpFrac, oppHpFrac)

    /* ---------- tier 2: decide ---------- */
    if (frame >= ai.nextDecision) {
      ai.nextDecision = frame + Math.max(4, Math.round(period * (1 - 0.35 * world.pressure)))

      const S = scoreActions(frame, world, d, a_eff, d_eff, hpFrac)
      const pick = chooseAction(S)
      ai.debug.scores = S
      ai.debug.pick = pick

      switch (pick) {
        case 'ATTACK':
          if (doAttack(frame, world)) { setState(STATE.COMMIT, 0, frame); return }
          setState(STATE.HOLD, period, frame); break
        case 'ADVANCE': setState(STATE.ADVANCE, period * 2, frame); break
        case 'RETREAT': setState(STATE.RETREAT, period, frame); break
        case 'DASH':    setState(STATE.DASH, 14, frame); break
        case 'JUMP':
          if (self.grounded) { tryJump(self); setState(STATE.HOP, 18, frame) }
          else setState(STATE.HOLD, period, frame)
          break
        default:        setState(STATE.HOLD, period, frame)
      }
    }

    applyState(frame, d, world)
  }

  function applyState(frame, d, world) {
    const tooClose = d <= CONFIG.MIN_GAP + 6
    const P = PLANS[ai.plan]
    const target = world.suddenDeath ? 138 : lerp(P.range, 138, world.pressure)

    switch (ai.state) {
      case STATE.ADVANCE:
        if (tooClose) move(0); else move(towardDir, 1)
        break

      case STATE.DASH:
        // Short burst of speed - the clearest read on a high speed stat.
        if (frame >= ai.stateUntil) { setState(STATE.HOLD, 0, frame); move(0); break }
        if (d > target) { if (tooClose) move(0); else move(towardDir, 1.85) }
        else if (d < CONFIG.MAX_KITE) move(-towardDir, 1.85)
        else move(0)
        break

      case STATE.RETREAT:
        if (d >= CONFIG.MAX_KITE || world.suddenDeath) move(0)
        else move(-towardDir, 1)
        break

      case STATE.HOP:
        move(towardDir, 0.8)
        break

      case STATE.PUNISH:
      case STATE.COMMIT:
        move(0)
        break

      case STATE.HOLD:
      default: {
        /* HOLD is never "stand still". Upstream falls through to idle when
           no key is held, and two fighters idling at each other reads as a
           crashed game. This runs footsies instead: short shuffles in and
           out around the target distance, which looks like deliberate
           spacing play - and doubles as whiff bait. */
        if (++ai.shuffleFlip % (period * 2) === 0) ai.shuffleDir *= -1
        const err = d - target
        let dir
        if (Math.abs(err) > 18) dir = err > 0 ? towardDir : -towardDir
        else dir = ai.shuffleDir * towardDir
        if (tooClose && dir === towardDir) dir = 0
        if (d >= CONFIG.MAX_KITE && dir === -towardDir) dir = 0
        move(dir, 0.42)
        break
      }
    }
  }

  /* Called from game.js so the plan tier can react to momentum. */
  ai.notifyHitTaken = function () { ai.hitsTakenStreak++; ai.hitsGivenStreak = 0; ai.planUntil = 0 }
  ai.notifyHitGiven = function () { ai.hitsGivenStreak++; ai.hitsTakenStreak = 0 }

  return ai
}
