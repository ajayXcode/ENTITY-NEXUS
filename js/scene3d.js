/* ------------------------------------------------------------------
   scene3d.js - perspective arena + 3D camera.

   The fighters are 2D sprite sheets with direction-locked attack boxes, so
   they stay as billboards on a single fight plane (z = 0). Everything the
   eye reads as "3D" is built around them: a floor projected to a real
   vanishing point, a raised stage with visible thickness, crowd billboards
   at depth, reflections, depth haze, and a camera that dollies and tracks
   in three dimensions.

   PROJECTION
     world x  = the same 0..1024 the game already uses
     world y  = height above the floor (0 at the floor line)
     world z  = depth; the fight plane is z = 0, the camera sits at -camDist

       s  = focal / (z + camDist)          perspective scale
       sx = 512 + (x - camX) * s
       sy = horizon + (camH - y) * s

   With focal = camDist, s = 1 at z = 0. Combined with camH = 150 and
   horizon = 330, a point on the fight plane lands on exactly the same pixel
   the old flat renderer used - so the sprites, hitboxes, particles and
   shadows all keep working untouched, and the camera becomes a pure
   transform on top.

   That equivalence is the whole trick: the fight plane is drawn as one 2D
   layer under a single canvas transform (so FX, auras and damage numbers
   need no per-object projection), while the floor and scenery are projected
   properly per-vertex.
------------------------------------------------------------------- */

const Scene3D = {
  FOCAL: 900,
  camH: 150,
  horizon: 330,

  camX: 512, camXTarget: 512,
  camDist: 900, camDistTarget: 900,
  roll: 0,
  bob: 0,

  /* KO cam. While this is set, update() stops tracking the midpoint of the
     action and instead pushes in on one fighter - the one who just went
     down. Cleared by resetFighters(). */
  focus: null,           // { x } in world units, or null for normal tracking
  focusDist: 520,        // how close to push. lower = tighter shot

  crowd: null,

  // Stage extents in world units
  STAGE_X0: -260, STAGE_X1: 1284,
  STAGE_Z0: -360, STAGE_Z1: 760,

  scaleAt(z) { return this.FOCAL / (z + this.camDist) },

  project(x, y, z) {
    const s = this.scaleAt(z)
    return { x: 512 + (x - this.camX) * s, y: this.horizon + (this.camH - y) * s, s }
  },

  /* Scale of the fight plane itself - what the camera transform applies. */
  planeScale() { return this.FOCAL / this.camDist },

  init(rng) {
    const r = rng || Math.random
    this.crowd = []
    // Three ranks of spectators at increasing depth.
    for (const [z, n, h] of [[900, 26, 74], [1450, 30, 68], [2100, 34, 62]]) {
      for (let i = 0; i < n; i++) {
        this.crowd.push({
          x: -700 + (2450 / n) * (i + r() * 0.7),
          z: z + r() * 220,
          h: h * (0.82 + r() * 0.36),
          w: 26 * (0.8 + r() * 0.4),
          phase: r() * Math.PI * 2,
          rate: 0.9 + r() * 1.3,
          tone: 8 + Math.floor(r() * 16)
        })
      }
    }
    this.crowd.sort((a, b) => b.z - a.z)   // painter's algorithm: far first
  },

  update(p, e, excited) {
    if (this.focus) {
      /* KO cam: forget the midpoint, frame the fighter who went down and
         push all the way in. The clamp is wider than the normal one - at
         this focal length the arena edge is well off screen anyway, and
         refusing to travel would leave a cornered KO half out of frame.

         Eased slower than the normal dolly (0.035 vs 0.05) so the push
         reads as a deliberate camera move rather than a snap. */
      this.camXTarget = clamp(this.focus.x, 512 - 300, 512 + 300)
      this.camDistTarget = this.focusDist
      this.camX += (this.camXTarget - this.camX) * 0.045
      this.camDist += (this.camDistTarget - this.camDist) * 0.035
      this.bob += 0.011
      this.roll += (0 - this.roll) * 0.12
      return
    }

    // Track the midpoint of the action, but never let the arena slide away.
    const mid = (p.position.x + e.position.x) / 2 + 25
    this.camXTarget = clamp(mid, 512 - 130, 512 + 130)

    /* Dolly: pull back when they separate, push in when they close. This is
       the single strongest 3D cue - the whole scene's perspective shifts. */
    const gap = Math.abs(e.position.x - p.position.x)
    this.camDistTarget = lerp(830, 1010, clamp01((gap - 70) / 400))

    this.camX += (this.camXTarget - this.camX) * 0.07
    this.camDist += (this.camDistTarget - this.camDist) * 0.05

    this.bob += 0.011
    this.roll += (0 - this.roll) * 0.12
    if (excited) this.roll += (Math.random() - 0.5) * 0.0015
  },

  kick(amount) { this.roll += amount },

  /* Point the camera at one fighter and hold there. `dist` is the camera
     distance to settle on: 900 is the neutral framing, so smaller is
     tighter. Call koCam(null) to hand control back to the fight tracker. */
  koCam(fighter, dist) {
    if (!fighter) { this.focus = null; return }
    this.focus = { x: fighter.position.x + fighter.width / 2 }
    this.focusDist = dist || 520
  },

  /* Momentary dolly toward the action on impact. `amount` is in world units
     of camera distance; update() eases camDist back to its target over the
     following frames, so this needs no decay of its own. Floored so a rapid
     combo cannot walk the camera into the fighters' faces. */
  punchIn(amount) {
    this.camDist = Math.max(640, this.camDist - (amount || 0))
  },

  /* ---------------- backdrop ---------------- */

  renderBackdrop(bgSprite, shopSprite) {
    const par = (this.camX - 512) * 0.06
    const zoom = 1.10 + (900 - this.camDist) * 0.00008
    c.save()
    c.translate(512 - par, this.horizon - 40)
    c.scale(zoom, zoom)
    c.translate(-512, -(this.horizon - 40))
    if (bgSprite) bgSprite.render()
    if (shopSprite) shopSprite.render()
    c.restore()

    // Haze toward the horizon so distance reads as distance.
    const g = c.createLinearGradient(0, this.horizon - 150, 0, this.horizon + 70)
    g.addColorStop(0, 'rgba(18,22,34,0)')
    g.addColorStop(1, 'rgba(18,22,34,0.85)')
    c.fillStyle = g
    c.fillRect(0, this.horizon - 150, canvas.width, 220)
  },

  /* ---------------- crowd ---------------- */

  renderCrowd() {
    if (!this.crowd) this.init()
    const t = this.bob
    for (const m of this.crowd) {
      const bobY = Math.sin(t * m.rate + m.phase) * 7
      const base = this.project(m.x, 0, m.z)
      const top = this.project(m.x, m.h + bobY, m.z)
      if (base.y < this.horizon - 4) continue
      const w = m.w * base.s
      const h = base.y - top.y
      if (w < 0.6 || h < 1) continue

      // Depth haze: far ranks wash out toward the backdrop colour.
      const fog = clamp01((m.z - 700) / 1800)
      const v = m.tone + fog * 26
      c.save()
      c.globalAlpha = 0.92 - fog * 0.25
      c.fillStyle = 'rgb(' + Math.round(v) + ',' + Math.round(v + 3) + ',' + Math.round(v + 10) + ')'
      c.beginPath()
      // body
      c.ellipse(base.x, base.y - h * 0.34, w * 0.5, h * 0.36, 0, 0, Math.PI * 2)
      c.fill()
      // head
      c.beginPath()
      c.arc(base.x, base.y - h * 0.78, w * 0.27, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }
  },

  /* ---------------- the stage ---------------- */

  renderStage() {
    const fl = this.project(this.STAGE_X0, 0, this.STAGE_Z0)
    const fr = this.project(this.STAGE_X1, 0, this.STAGE_Z0)
    const bl = this.project(this.STAGE_X0, 0, this.STAGE_Z1)
    const br = this.project(this.STAGE_X1, 0, this.STAGE_Z1)

    // --- deck ---
    const g = c.createLinearGradient(0, bl.y, 0, fl.y)
    g.addColorStop(0, '#2a2036')
    g.addColorStop(0.45, '#3a2c44')
    g.addColorStop(1, '#4a3a55')
    c.save()
    c.beginPath()
    c.moveTo(fl.x, fl.y); c.lineTo(fr.x, fr.y); c.lineTo(br.x, br.y); c.lineTo(bl.x, bl.y)
    c.closePath()
    c.fillStyle = g
    c.fill()
    c.clip()

    // --- lines of constant z, converging toward the horizon ---
    c.strokeStyle = 'rgba(255,255,255,0.07)'
    c.lineWidth = 1
    for (let z = this.STAGE_Z0; z <= this.STAGE_Z1; z += 80) {
      const a = this.project(this.STAGE_X0, 0, z)
      const b = this.project(this.STAGE_X1, 0, z)
      c.globalAlpha = 1 - clamp01((z - this.STAGE_Z0) / (this.STAGE_Z1 - this.STAGE_Z0)) * 0.7
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke()
    }
    // --- lines of constant x, running to the vanishing point ---
    for (let x = this.STAGE_X0; x <= this.STAGE_X1; x += 96) {
      const a = this.project(x, 0, this.STAGE_Z0)
      const b = this.project(x, 0, this.STAGE_Z1)
      c.globalAlpha = 0.5
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke()
    }
    c.globalAlpha = 1

    // --- pool of light on the fight plane ---
    const cen = this.project(512, 0, 0)
    const lg = c.createRadialGradient(cen.x, cen.y, 10, cen.x, cen.y, 520 * cen.s)
    lg.addColorStop(0, 'rgba(255,226,170,0.20)')
    lg.addColorStop(1, 'rgba(255,226,170,0)')
    c.fillStyle = lg
    c.fillRect(0, this.horizon, canvas.width, canvas.height - this.horizon)
    c.restore()

    // --- front face, giving the stage real thickness ---
    const drop = 150
    const fl2 = { x: fl.x, y: fl.y + drop * fl.s }
    const fr2 = { x: fr.x, y: fr.y + drop * fr.s }
    c.beginPath()
    c.moveTo(fl.x, fl.y); c.lineTo(fr.x, fr.y); c.lineTo(fr2.x, fr2.y); c.lineTo(fl2.x, fl2.y)
    c.closePath()
    c.fillStyle = '#16111f'
    c.fill()
    c.strokeStyle = 'rgba(255,210,74,0.55)'
    c.lineWidth = 3
    c.beginPath(); c.moveTo(fl.x, fl.y); c.lineTo(fr.x, fr.y); c.stroke()

    // --- back edge highlight ---
    c.strokeStyle = 'rgba(64,220,255,0.30)'
    c.lineWidth = 2
    c.beginPath(); c.moveTo(bl.x, bl.y); c.lineTo(br.x, br.y); c.stroke()
  },

  /* ---------------- fight-plane camera ---------------- */

  /* Everything on z = 0 - fighters, particles, slashes, damage numbers -
     is drawn under this one transform, in the exact screen coordinates the
     flat renderer used. */
  applyCamera(extraScale) {
    const s = this.planeScale() * (extraScale || 1)
    c.save()
    c.translate(512, this.horizon)
    if (this.roll) c.rotate(this.roll)
    c.scale(s, s)
    c.translate(-this.camX, -this.horizon)
  },

  popCamera() { c.restore() },

  /* Vertical mirror of a fighter on the deck. Drawn inside the camera
     transform, squashed because the floor recedes away from the eye. */
  renderReflection(f) {
    if (!f.image || !f.image.complete || !f.image.naturalWidth) return
    const footY = canvas.height - 96
    c.save()
    c.globalAlpha = 0.16
    c.translate(0, footY)
    c.scale(1, -0.42)
    c.translate(0, -footY)
    f.draw()
    c.restore()
  }
}
