/* ------------------------------------------------------------------
   classes.js - Sprite / Fighter

   Based on the Fight-ME-Monk (Chris Courses lineage) classes, with these
   changes:
     - update() split from render(), so the loop can move everything
       before it draws anything (upstream drew last frame's positions) and
       so a headless benchmark can run without a canvas.
     - moveSpeed is a property instead of a hardcoded +/-5.
     - takeHit() takes a damage amount.
     - attack() can play attack1 or attack2 (upstream only ever used
       attack1, but both sheets ship an Attack2 with the same frame count).
     - switchSprite's "don't interrupt an attack" guard now covers attack2.
       Upstream only guarded attack1, so an attack2 could be cancelled
       mid-swing by a movement input.
     - stunUntil / canAttack(), which close the phantom-hit hole: attack()
       sets isAttacking even when switchSprite refuses the animation, and
       the damage test is (isAttacking && framesCurrent === N) against
       *whatever* animation is playing - so a fighter that attacked while
       stunned would deal full damage with a take-hit animation on screen.
------------------------------------------------------------------- */

class Sprite {
  constructor({ position, imageSrc, scale = 1, framesMax = 1, framesHold = 5, offset = { x: 0, y: 0 } }) {
    this.position = position
    this.width = 50
    this.height = 150
    this.image = new Image()
    this.image.src = imageSrc
    this.scale = scale
    this.framesMax = framesMax
    this.framesCurrent = 0
    this.framesElapsed = 0
    /* Per-animation playback speed. Upstream hardcoded 5 for everything,
       which left the Samurai's 6-frame attack running 30 game frames against
       the Monk's 4-frame / 20-frame attack. Since a fighter is locked and
       defenceless for its whole attack animation, that was a permanent
       structural disadvantage for P1 worth ~15 points of win rate. Letting
       each animation set its own hold lets us equalise the two without
       touching the artwork. */
    this.framesHold = framesHold
    this.offset = offset
  }

  /* Which animation an image belongs to, by identity. this.image is always
     one of sprites[*].image, and so is pose.img - so this answers "what is
     being drawn" without guessing and without a second source of truth. */
  animNameFor(img) {
    for (const k in this.sprites) {
      if (this.sprites[k].image === img) return k
    }
    return null
  }

  draw() {
    /* `pose` is a render-only override (see showWhiff in game.js): it swaps
       what is drawn for a few frames without touching image, framesCurrent
       or any of the animation state the simulation reads. Nothing outside
       this method is allowed to consult it. */
    const p = this.pose
    let img = p ? p.img : this.image
    let fm = p ? p.fm : this.framesMax
    let frame = p ? p.frame : this.framesCurrent
    let scale = this.scale

    /* ---- champion battle art (render-only) --------------------------

       Some champions ship their own sprites instead of borrowing one of
       the two sheets. `skin` is set by js/ui.js from the registry and is
       read HERE and nowhere else - same rule as `tint` and `crest` in
       render(), and for the same reason: house/sim.js must not be able to
       tell a skinned fighter from a borrowed one.

       The frames are laid out on the engine's exact geometry by
       scripts/make-battle-sprites.py, so the offset below is already
       correct and only the scale differs, by 1/R - the frames are emitted
       at R times the resolution, so the on-screen frame is the same 500px
       the base sheet produced.

       If the art has not decoded yet we fall through to the sheet it
       replaces. A fighter must never be invisible because an image is
       still in flight. */
    const skin = this.skin
    if (skin) {
      const name = this.animNameFor(img)
      const art = name ? skin.images[name] : null
      if (art && art.complete && art.naturalWidth) {
        img = art
        fm = 1
        frame = 0
        scale = skin.scale
      }
    }

    if (!img.complete || !img.naturalWidth) return
    const fw = img.width / fm
    const baseW = fw * scale
    const baseH = img.height * scale
    /* Squash and stretch, anchored at the feet and centred horizontally.
       Costs nothing and is most of what makes a landing read as weight. */
    const w = baseW * (this.squashX || 1)
    const h = baseH * (this.squashY || 1)
    c.drawImage(
      img,
      frame * fw, 0, fw, img.height,
      this.position.x - this.offset.x + (baseW - w) / 2,
      this.position.y - this.offset.y + (baseH - h),
      w, h
    )
  }

  /* Last frame of the range currently playing. A move may play a sub-range
     of its sheet (see Fighter.attack), so this is NOT always framesMax - 1. */
  get frameEnd() {
    return this.frameTo === undefined ? this.framesMax - 1 : this.frameTo
  }

  atAnimEnd() { return this.framesCurrent >= this.frameEnd }

  animateFrames() {
    this.framesElapsed++
    if (this.framesElapsed % this.framesHold === 0) {
      if (this.framesCurrent < this.frameEnd) this.framesCurrent++
      else if (!this.oneShot) this.framesCurrent = this.frameFrom || 0
    }
  }

  update() { this.animateFrames() }
  render() { this.draw() }
}

class Fighter extends Sprite {
  constructor({
    position, velocity, color = 'red', imageSrc, scale = 1, framesMax = 1,
    offset = { x: 0, y: 0 }, sprites, moves,
    attackBox = { offset: {}, width: undefined, height: undefined }
  }) {
    super({ position, imageSrc, scale, framesMax, offset })

    this.velocity = velocity
    this.width = 50
    this.height = 150
    this.lastKey = ''
    this.attackBox = {
      position: { x: this.position.x, y: this.position.y },
      offset: attackBox.offset,
      width: attackBox.width,
      height: attackBox.height
    }
    this.color = color
    this.isAttacking = false
    this.health = 100
    this.framesCurrent = 0
    this.framesElapsed = 0
    this.framesHold = 5
    this.sprites = sprites
    this.moves = moves          // animation ranges; mechanics live in CONFIG.MOVES
    this.attackMove = 'normal'  // which move is currently in flight
    this.pose = null            // render-only frame override; see draw()
    this.blockUntil = 0         // frame this guard drops
    this.blockReadyAt = 0       // frame another guard may be raised
    this.blockedHits = 0        // for the HUD / winner card
    // Neither sheet is mirrored, so facing is fixed for the whole fight:
    // the Samurai always faces right, the Monk always left.
    this.facing = color === 'blue' ? -1 : 1
    this.dead = false

    // --- added ---
    this.moveSpeed = 5
    this.stunUntil = 0          // frame index; see canAttack()
    this.recoverUntil = 0       // set when an attack WHIFFS - the opponent's
                                // free punish window, and the thing that
                                // makes patient prompts actually pay off
    this.comboUntil = 0         // set when an attack LANDS - a brief window
                                // where the follow-up costs less cooldown
    this.attackLandFrame = -1   // frame this swing's damage resolves on
    this.attackDamage = 20
    this.damageTakenMult = 1
    this.trail = []             // recent positions, for the speed afterimage
    this.skin = null            // render-only champion battle art; see draw()
    this.auraColor = null
    this.auraStrength = 0
    this.squashX = 1            // decays back to 1 every frame
    this.squashY = 1
    this.stepTimer = 0          // footfall dust cadence
    this.lastStandUsed = false
    this.lastStandArmed = false       // rolled per fight from the seed
    this.lastStandTriggered = false   // read once by applyHit, then cleared
    this.hitsLanded = 0
    this.damageDealt = 0        // plain tally for the post-fight summary

    for (const sprite in this.sprites) {
      sprites[sprite].image = new Image()
      sprites[sprite].image.src = sprites[sprite].imageSrc
    }
  }

  get grounded() { return this.position.y >= CONFIG.GROUND_Y }

  /* 0 while healthy, ramping to 1 at death's door. Drives the comeback. */
  get rage() {
    return clamp01((CONFIG.RAGE_START - this.health / 100) / CONFIG.RAGE_START)
  }

  isStunned(frame) { return frame < this.stunUntil }

  isAttackAnim() {
    return this.image === this.sprites.attack1.image ||
           this.image === this.sprites.attack2.image
  }

  isBlocking(frame) {
    return frame < this.blockUntil && !this.dead
  }

  /* Raise a guard. Refused while one is already up, on cooldown, stunned or
     mid-swing - a block must be a decision made BEFORE the attack lands, or
     it would just be a free undo button on a bad read.

     Guards wither as the pressure ramp climbs, down to 45% duration at full
     pressure. Blocking is the one mechanic in the game that can make a round
     take LONGER, and the pressure ramp exists precisely so that two cagey
     prompts still produce a finish. Without this, two defensive fighters
     could trade guards indefinitely and the ramp would have nothing to bite
     on - the bench showed coward-vs-coward KO rate sliding on exactly that. */
  startBlock(frame, pressure) {
    if (this.dead || this.isAttacking || this.isStunned(frame)) return false
    if (frame < this.blockReadyAt || this.isBlocking(frame)) return false
    const dur = Math.round(CONFIG.BLOCK.MAX_FRAMES * (1 - 0.55 * clamp01(pressure || 0)))
    this.blockFrom = frame
    this.blockUntil = frame + Math.max(8, dur)
    this.blockReadyAt = this.blockUntil + CONFIG.BLOCK.COOLDOWN
    return true
  }

  /* Guard broken by a heavy: the block ends immediately and cannot be
     raised again for a long beat. */
  breakGuard(frame) {
    this.blockUntil = 0
    this.blockReadyAt = frame + CONFIG.BLOCK.COOLDOWN * 2
  }

  /* The single gate every attack must pass through. */
  canAttack(frame) {
    return !this.dead &&
           !this.isAttacking &&
           !this.isStunned(frame) &&
           !this.isBlocking(frame) &&
           this.image !== this.sprites.death.image
  }

  update(frame) {
    if (!this.dead) this.animateFrames()

    // Expire the render-only whiff pose. Read by draw() and nothing else,
    // so counting it down here cannot feed back into the simulation.
    if (this.pose && --this.pose.life <= 0) this.pose = null

    const wasAirborne = !this.grounded
    this.squashX += (1 - this.squashX) * 0.18
    this.squashY += (1 - this.squashY) * 0.18

    // Death animation finishes -> freeze on the last frame.
    if (this.image === this.sprites.death.image &&
        this.framesCurrent === this.sprites.death.framesMax - 1) {
      this.dead = true
    }

    this.attackBox.position.x = this.position.x + this.attackBox.offset.x
    this.attackBox.position.y = this.position.y + this.attackBox.offset.y

    this.position.x += this.velocity.x
    this.position.y += this.velocity.y

    // Clamp to the canvas AFTER moving. Upstream clamped the stale position,
    // which let a fighter overshoot the wall by one frame.
    if (this.position.x < 0) this.position.x = 0
    else if (this.position.x + this.width > canvas.width) {
      this.position.x = canvas.width - this.width
    }

    // Gravity / ground
    if (this.position.y + this.height + this.velocity.y >= canvas.height - 96) {
      this.velocity.y = 0
      this.position.y = CONFIG.GROUND_Y
    } else this.velocity.y += gravity

    // Landed this frame: compress, and kick up dust.
    if (wasAirborne && this.grounded) {
      this.squashX = 1.30; this.squashY = 0.74
      FX.dustPuff(this.position.x + this.width / 2, canvas.height - 96, 9)
    }

    // Footfalls while running.
    if (this.grounded && Math.abs(this.velocity.x) > 3) {
      if (++this.stepTimer % 9 === 0) {
        FX.dustPuff(this.position.x + this.width / 2, canvas.height - 96, 2,
          this.velocity.x > 0 ? -1 : 1)
      }
    }

    // Afterimage trail (only meaningful for fast fighters)
    if (this.auraStrength > 0 || this.moveSpeed > 8) {
      this.trail.push({ x: this.position.x, y: this.position.y, f: this.framesCurrent, img: this.image })
      if (this.trail.length > 4) this.trail.shift()
    }
  }

  render() {
    /* ---- champion identity (render-only) ----------------------------

       `tint` and `crest` are set by the UI from the champion registry. They
       live here, in render(), and not one line of the simulation reads
       them: update()/stepFight() never call render(), so house/sim.js and
       its frame-for-frame agreement with the browser are untouched by
       anything a champion looks like.

       tint  a canvas filter, so fifteen champions are fifteen readable
             silhouettes instead of two shared sheets. Off for a champion
             that ships its own sprites - see draw().
       crest anaccent colour for the painted mark above the fighter's head.
       ------------------------------------------------------------------ */
    const tint = this.tint
    if (tint) { c.save(); c.filter = tint }

    /* Ground shadow. Shrinks and fades with height, which is the cheapest
       possible way to make jump height readable on a projector. */
    {
      const air = clamp01((CONFIG.GROUND_Y - this.position.y) / 220)
      const sw = 34 * (1 - air * 0.55)
      c.save()
      c.globalAlpha = 0.45 * (1 - air * 0.65)
      c.fillStyle = '#000'
      c.beginPath()
      c.ellipse(this.position.x + this.width / 2, canvas.height - 96, sw, sw * 0.30, 0, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }

    // Speed afterimage. The trail records the SHEET image, so a skinned
    // fighter resolves each entry back to its own art - otherwise a turtle
    // would leave a samurai's afterimages behind it.
    if (this.trail.length && this.moveSpeed > 8 && Math.abs(this.velocity.x) > 0.1) {
      for (let i = 0; i < this.trail.length; i++) {
        const t = this.trail[i]
        let timg = t.img
        let tframes = t.img === this.image ? this.framesMax : 1
        let tscale = this.scale
        if (this.skin) {
          const art = this.skin.images[this.animNameFor(t.img)]
          if (art && art.complete && art.naturalWidth) {
            timg = art
            tframes = 1
            tscale = this.skin.scale
          }
        }
        if (!timg.complete || !timg.naturalWidth) continue
        const fw = timg.width / tframes
        c.save()
        c.globalAlpha = 0.10 + 0.04 * i
        c.drawImage(timg, Math.min(t.f, tframes - 1) * fw, 0, fw, timg.height,
          t.x - this.offset.x, t.y - this.offset.y, fw * tscale, timg.height * tscale)
        c.restore()
      }
    }

    /* Guard. A raised block has to be visible BEFORE the attack arrives or
       the mechanic is unreadable - the whole read is "they guessed right",
       and you cannot see a guess that is invisible until it pays off.

       Drawn as a bracket standing in front of the fighter on the side the
       attack is coming from, not as anything layered on the body itself.
       It thins as the guard runs out, so you can see a block about to drop. */
    if (this.isBlocking(game.frame)) {
      // Fraction of THIS guard remaining - its length varies with pressure.
      const span = Math.max(1, this.blockUntil - this.blockFrom)
      const left = (this.blockUntil - game.frame) / span
      const gx = this.position.x + this.width / 2 + this.facing * 46
      const gy = this.position.y + this.height - 74
      const h = 96
      c.save()
      c.globalAlpha = 0.30 + 0.45 * clamp01(left)
      c.strokeStyle = '#8fd4ff'
      c.lineWidth = 3 + 2 * clamp01(left)
      c.lineCap = 'round'
      c.beginPath()
      // A shallow arc facing the opponent, capped top and bottom.
      c.ellipse(gx, gy, 16, h / 2, 0, -Math.PI / 2.1, Math.PI / 2.1)
      c.stroke()
      c.globalAlpha *= 0.55
      c.lineWidth = 2
      c.beginPath()
      c.ellipse(gx - this.facing * 9, gy, 12, h / 2.6, 0, -Math.PI / 2.1, Math.PI / 2.1)
      c.stroke()
      c.restore()
    }

    // Aggression / defense aura on the ground under the fighter
    if (this.auraColor && this.auraStrength > 0.05) {
      const cx = this.position.x + this.width / 2
      const cy = this.position.y + this.height
      const r = 40 + 30 * this.auraStrength
      const g = c.createRadialGradient(cx, cy, 2, cx, cy, r)
      g.addColorStop(0, this.auraColor.replace('ALPHA', 0.45 * this.auraStrength))
      g.addColorStop(1, this.auraColor.replace('ALPHA', 0))
      c.save()
      c.fillStyle = g
      c.beginPath()
      c.ellipse(cx, cy, r, r * 0.30, 0, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }

    this.draw()

    if (tint) c.restore()

    /* The crest sits outside the tint, so it keeps its true colour. Two
       stacked chevrons over the head - enough to tell two fighters of the
       same archetype apart at a glance, and cheap enough to draw every
       frame. */
    if (this.crest) {
      const cx = this.position.x + this.width / 2
      const cy = this.position.y - 18
      c.save()
      c.strokeStyle = this.crest
      c.lineCap = 'round'
      c.lineJoin = 'round'
      c.globalAlpha = 0.92
      c.lineWidth = 3
      c.beginPath()
      c.moveTo(cx - 9, cy - 5)
      c.lineTo(cx, cy + 4)
      c.lineTo(cx + 9, cy - 5)
      c.stroke()
      c.globalAlpha = 0.4
      c.lineWidth = 1.8
      c.beginPath()
      c.moveTo(cx - 6, cy + 6)
      c.lineTo(cx, cy + 13)
      c.lineTo(cx + 6, cy + 6)
      c.stroke()
      c.restore()
    }

    /* The weapon, printed from the champion's own asset file. Drawn only
       once the image has decoded: a missing or still-loading asset costs a
       frame of nothing, never a broken fight. Mirrored with the fighter, so
       both sides carry their weapon outward. Render-only, like the rest of
       this file's champion work. */
    const wp = this.weaponImg
    if (wp && wp.complete && wp.naturalWidth) {
      const w = 46
      const h = w * ((wp.naturalHeight / wp.naturalWidth) || 0.53)
      const y = this.position.y + this.height - 58
      const x = this.position.x + (this.facing > 0 ? this.width + 2 : -w - 2)
      c.save()
      c.globalAlpha = 0.92
      if (this.facing < 0) {
        c.translate(x + w, y)
        c.scale(-1, 1)
        c.drawImage(wp, 0, 0, w, h)
      } else {
        c.drawImage(wp, x, y, w, h)
      }
      c.restore()
    }
  }

  /* Damage timing is driven by an explicit frame stamp, NOT by the sprite's
     own animation frame. Upstream keyed the hit off `framesCurrent === N`,
     which meant each character's startup was whatever its sheet happened to
     be: the Samurai landed 12 game frames after the swing began, the Monk
     at 10. Two extra frames of telegraph let defenders escape the Samurai
     far more often - a permanent ~7-point accuracy deficit for P1 that no
     amount of damage tuning could fix. A shared startup makes the two
     fighters mechanically identical; the animations still play at their own
     natural speeds, purely visually.

     Each move now carries its own startup (CONFIG.MOVES), but the principle
     is unchanged and is the reason this is safe: a move's startup is the
     same number for both characters, so the sprite sheets still have no
     mechanical say in anything. */
  attack(move, frame) {
    const name = CONFIG.MOVES[move] ? move : 'normal'
    const anim = this.moves && this.moves[name]
    if (anim) this.playMove(anim)
    else this.switchSprite('attack1')      // no move table: old behaviour
    this.attackMove = name
    this.isAttacking = true
    this.attackLandFrame = frame + CONFIG.MOVES[name].startup
  }

  /* The mechanics of the swing currently in flight. */
  get move() { return CONFIG.MOVES[this.attackMove] || CONFIG.MOVES.normal }

  takeHit(dmg, blocked) {
    let applied = Math.max(1, Math.round(dmg * this.damageTakenMult))
    /* A guarded hit braces rather than recoils - squashed the other way, and
       no take-hit animation, because the whole point is that the defender
       does not flinch. */
    if (blocked) { this.squashX = 1.14; this.squashY = 0.92 }
    else { this.squashX = 0.80; this.squashY = 1.20 }

    /* Last stand: one blow per fighter that would have killed them from a
       healthy bar leaves them on a sliver instead. This is where the
       nail-biting finishes come from. */
    if (this.health - applied <= 0 &&
        this.lastStandArmed &&
        !this.lastStandUsed &&
        this.health >= CONFIG.LAST_STAND_MIN_HP) {
      this.lastStandUsed = true
      this.lastStandTriggered = true
      applied = this.health - CONFIG.LAST_STAND_HP
      this.health = CONFIG.LAST_STAND_HP
      this.switchSprite('takeHit')
      return applied
    }

    this.health = Math.max(0, this.health - applied)
    if (this.health <= 0) this.switchSprite('death')
    else if (!blocked) this.switchSprite('takeHit')
    return applied
  }

  switchSprite(sprite) {
    // Dead overrides everything.
    if (this.image === this.sprites.death.image) return

    /* Don't interrupt an attack in progress. Upstream only guarded attack1;
       this covers attack2 as well. It tests frameEnd rather than framesMax-1
       because a move may be playing a sub-range of its sheet - a jab that
       ends on frame 5 of 6 is finished, and comparing against the sheet
       length instead would leave the fighter locked out of its next move. */
    if (this.isAttackAnim() && !this.atAnimEnd()) return

    // Don't interrupt a take-hit.
    if (this.image === this.sprites.takeHit.image &&
        this.framesCurrent < this.sprites.takeHit.framesMax - 1) return

    const s = this.sprites[sprite]
    if (!s) return
    if (this.image !== s.image || this.frameFrom || this.oneShot) {
      this.image = s.image
      this.framesMax = s.framesMax
      this.framesHold = s.framesHold || 5
      this.framesCurrent = 0
      this.framesElapsed = 0
      // Plain sprites play their whole sheet on a loop; only playMove()
      // narrows the range or stops at the end.
      this.frameFrom = 0
      this.frameTo = undefined
      this.oneShot = false
    }
  }

  /* Play a sub-range of a sheet at its own speed, once. This is what turns
     two attack sheets into a movelist: the same six frames are a heavy swing
     slowed down, or a jab with the wind-up cut off.

     Unlike switchSprite this does NOT refuse to interrupt an attack, so it
     must only be called when the caller already knows the fighter is free.
     In practice that is guaranteed: attack() is reached only through
     tryAttack(), which gates on canAttack(), and the AI additionally waits
     out a cooldown whose floor (25) exceeds every move's animation length. */
  playMove(m) {
    const s = this.sprites[m.sprite]
    if (!s) return
    this.image = s.image
    this.framesMax = s.framesMax
    this.frameFrom = m.from || 0
    this.frameTo = Math.min(m.to === undefined ? s.framesMax - 1 : m.to, s.framesMax - 1)
    this.framesHold = m.hold || 5
    this.oneShot = true
    this.framesCurrent = this.frameFrom
    this.framesElapsed = 0
  }
}
