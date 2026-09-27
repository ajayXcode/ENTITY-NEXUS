/* ------------------------------------------------------------------
   penfight.js - PEN FIGHT 3D: the simulation.

   THE GAME
     The one everybody played on the back bench. Two pens on a desk. You
     flick yours into theirs and try to put them over the edge. Last pen on
     the desk keeps both.

   WHAT IS SHARED WITH THE MAIN GAME
     Everything above the simulation. The same prompt box, the same parser,
     the same three stats, the same analyse / reveal / HUD / winner / mint
     flow, the same seeded RNG, the same FX and audio. A strategy typed for
     the fighting game produces a pen with a recognisably identical
     personality, because it is literally the same
     {aggression, defense, speed} triple read by different rules.

   WHAT IS NOT SHARED
     The simulation (this file) and the renderer (penfight3d.js). Neither
     touches player, enemy or game - the fighting game does not know this
     mode exists, so its balance, its seeded replays and ?bench all keep
     working untouched. Two hooks in game.js (one in tickWorld, one in
     renderAll) hand the frame over while this mode is active, exactly the
     way render3d.js hooks the renderer.

   THE PHYSICS IS REAL
     Not "arcade physics". Two rigid bodies in the plane of the desk, in SI
     units, each a capsule with mass, a real moment of inertia and a centre
     of mass offset toward the heavy cap end. Contacts resolve with a proper
     normal impulse plus a clamped Coulomb friction impulse, at the true
     closest points of the two capsules, with the angular terms included.

     That last part is the entire feel of the mode: hit a pen square and it
     slides, clip its tip and it SPINS, and a spinning pen sweeps a far
     wider arc than it looks like it should. Nobody wrote that behaviour -
     it falls out of cross(r, J) / I.

     Determinism is preserved throughout (fixed 60Hz step, every random
     number from the seeded mulberry32), so ?seed replays a pen fight
     exactly and ?penbench=N grinds a thousand of them headlessly.

   COORDINATES
     Metres. The desk surface is y = 0 and spans x in [-hx, hx],
     z in [-hz, hz]. A pen's heading angle `a` points from the cap toward
     the nib: dir = (cos a, sin a) in (x, z). three.js rotation.y is -a.
------------------------------------------------------------------- */

const PenFight = {
  active: false, ready: false, failed: false, bench: false,

  pens: null,
  frame: 0, totalFrames: 0, over: false, winner: null, how: '',
  seed: 1,
  hx: 0, hz: 0,                 // CURRENT desk half-extents (sudden death shrinks them)
  shrinkAnnounced: false,

  // read by penfight3d.js, written nowhere else
  camShake: 0, camPush: 0, focus: null,

  available() { return typeof THREE !== 'undefined' && !this.failed },

  /* ================================================================
     LIFECYCLE
     ================================================================ */

  start(p1Data, p2Data, seed) {
    this.bench = false
    if (!this.ready) {
      try { this.buildScene() } catch (err) {
        console.error('[penfight] scene build failed', err)
        this.failed = true
        return false
      }
      this.ready = true
    }
    this.startSim(p1Data, p2Data, seed)
    this.syncMeshes()
    this._show(true)
    FX.startMusic()
    return true
  },

  stop() {
    this.active = false
    this._show(false)
    FX.stopMusic()
  },

  _show(on) {
    this.active = !!on
    const pen = document.querySelector('#pen3d')
    const a2 = document.querySelector('#arena')
    const a3 = document.querySelector('#arena3d')
    if (pen) pen.classList.toggle('hidden', !this.active)
    // Whichever renderer the fighting game was using stands down.
    if (a2) a2.classList.toggle('hidden', this.active)
    if (a3) {
      const wants3d = typeof Render3D !== 'undefined' && Render3D.enabled
      a3.classList.toggle('hidden', this.active || !wants3d)
    }
    document.body.classList.toggle('mode-pen', this.active)
  },

  /* ================================================================
     THE SIMULATION
     ================================================================ */

  startSim(p1Data, p2Data, seed) {
    this.seed = seed >>> 0
    this.frame = 0
    this.totalFrames = CONFIG.FIGHT_SECONDS * 60
    this.over = false
    this.winner = null
    this.how = ''
    this.hx = PEN.DESK_HX
    this.hz = PEN.DESK_HZ
    this.shrinkAnnounced = false
    this.camShake = 0
    this.camPush = 0
    this.focus = null
    this.active = true

    /* Two independent streams split off the one seed, so P1's aim jitter
       cannot shift P2's - the same discipline ai-controller.js uses, and the
       reason a replayed seed replays exactly. */
    const rng1 = mulberry32(this.seed ^ 0x9e3779b9)
    const rng2 = mulberry32((this.seed + 0x85ebca6b) >>> 0)

    /* Set down within reach of each other, the way you actually start a pen
       fight - nobody opens from opposite ends of the desk. Symmetric about
       the centre so neither side starts nearer an edge. */
    this.pens = [
      this._makePen(1, p1Data, rng1, -0.26, 0, 0),
      this._makePen(2, p2Data, rng2, 0.26, 0, Math.PI)
    ]
  },

  _makePen(side, data, rng, x, z, a) {
    const halfL = PEN.LEN / 2
    const off = PEN.COM_OFFSET * halfL
    return {
      side, stats: data.stats, data, rng,
      x, z, a,                     // x,z = CENTRE OF MASS, a = heading
      vx: 0, vz: 0, vy: 0, w: 0,
      m: PEN.MASS,
      /* A rod about its own centre, shifted to the real centre of mass by
         the parallel axis theorem. */
      I: PEN.MASS * (PEN.LEN * PEN.LEN / 12 + off * off),
      halfL, off, r: PEN.RAD,
      hp: 100,
      cd: 20,                      // identical: a first-flick edge is a P1 win rate
      charge: 0, chargeMax: 1, align: 0,
      aimA: a, aimErr: 0, power: 0, english: 0, move: 'drive', intent: 'attack',
      fallen: false, fallFrames: 0, y: PEN.RAD,
      tilt: 0, tiltAxis: 0, teeter: 0, lastTeeter: 0,
      tumble: 0, spinOff: 0,
      hits: 0, flicks: 0
    }
  },

  /* One 60Hz tick. Called from tickWorld() in game.js. */
  tick() {
    if (!this.active) return
    if (FX.hitstopFrames > 0) { FX.hitstopFrames--; return }
    this.step()
    FX.step()
    UI.setTimer(Math.max(0, Math.ceil((this.totalFrames - this.frame) / 60)))
    UI.setHealth(this.pens[0].hp, this.pens[1].hp)
  },

  step() {
    const dt = 1 / 60
    const A = this.pens[0], B = this.pens[1]

    this._shrinkDesk()

    // Round over but the loser is still in the air: keep the tumble and the
    // camera running, stop everything else.
    if (this.over) {
      this._integrate(A, dt); this._integrate(B, dt)
      this.frame++
      return
    }

    this._aiTick(A, B)
    this._aiTick(B, A)

    this._integrate(A, dt)
    this._integrate(B, dt)

    if (!A.fallen && !B.fallen) this._collide(A, B)

    this._edgeCheck(A)
    this._edgeCheck(B)

    this.frame++
    this._checkEnd()
  },

  /* Sudden death does not multiply damage here - it takes away desk. The
     glowing boundary walks inward and whoever was loitering near an edge
     suddenly is not on the desk any more. A pen fight decided by a health
     bar is a pen fight nobody remembers. */
  _shrinkDesk() {
    const t = this.frame / 60
    if (t < PEN.SHRINK_START_S) return
    if (!this.shrinkAnnounced) {
      this.shrinkAnnounced = true
      if (!this.bench) {
        UI.announce('DESK CLOSING IN')
        FX.alarm()
        FX.vignette = 1
        document.body.classList.add('sudden-death')
      }
    }
    const k = clamp01((t - PEN.SHRINK_START_S) / PEN.SHRINK_SECONDS)
    const f = lerp(1, PEN.SHRINK_TO, k)
    this.hx = PEN.DESK_HX * f
    this.hz = PEN.DESK_HZ * f
  },

  _pressure() {
    const t = this.frame / 60
    if (t <= CONFIG.PRESSURE_START_S) return 0
    return clamp01((t - CONFIG.PRESSURE_START_S) /
      (CONFIG.PRESSURE_FULL_S - CONFIG.PRESSURE_START_S))
  },

  /* ---------------- integration ---------------- */

  _integrate(p, dt) {
    if (p.fallen) {
      // No desk under it any more: gravity and the tumble take over and the
      // horizontal velocity simply carries.
      p.fallFrames++
      p.vy -= 9.81 * dt
      p.y += p.vy * dt
      p.x += p.vx * dt
      p.z += p.vz * dt
      p.tumble += Math.abs(p.w) * dt * 0.5 + 0.10
      p.spinOff += p.w * dt + 0.04
      if (p.y < -0.60) {          // hits the classroom floor
        p.y = -0.60
        p.vy *= -0.22
        p.vx *= 0.55; p.vz *= 0.55; p.w *= 0.5
        if (Math.abs(p.vy) < 0.15) p.vy = 0
      }
      return
    }

    p.x += p.vx * dt
    p.z += p.vz * dt
    p.a += p.w * dt

    /* Coulomb friction: a constant deceleration opposing motion, NOT a
       velocity-proportional damping. The difference is visible - damping
       makes a pen creep toward a stop forever, and a real pen on a desk
       stops dead. */
    const sp = Math.hypot(p.vx, p.vz)
    if (sp > 0) {
      const drop = PEN.MU * dt
      if (sp <= drop || sp < PEN.STOP_V) { p.vx = 0; p.vz = 0 }
      else { const k = (sp - drop) / sp; p.vx *= k; p.vz *= k }
    }
    const aw = Math.abs(p.w)
    if (aw > 0) {
      const dw = PEN.SPIN_MU * dt
      if (aw <= dw || aw < PEN.STOP_W) p.w = 0
      else p.w -= Math.sign(p.w) * dw
    }
  },

  /* ---------------- geometry ---------------- */

  _dir(p) { return { x: Math.cos(p.a), z: Math.sin(p.a) } },

  /* The two ends of the barrel in world space. The geometric centre sits
     AHEAD of the centre of mass by `off`, because the cap end is heavier -
     which is why a real pen pivots around its back third and not its
     middle. */
  _ends(p) {
    const d = this._dir(p)
    const gx = p.x + d.x * p.off, gz = p.z + d.z * p.off
    return {
      gx, gz,
      nx: gx + d.x * p.halfL, nz: gz + d.z * p.halfL,     // nib
      cx: gx - d.x * p.halfL, cz: gz - d.z * p.halfL      // cap
    }
  },

  /* Closest points between two segments (Ericson, Real-Time Collision
     Detection s5.1.9). Both pens always have length, so the degenerate
     branches are unreachable and left out. */
  _segSeg(p1x, p1z, q1x, q1z, p2x, p2z, q2x, q2z) {
    const d1x = q1x - p1x, d1z = q1z - p1z
    const d2x = q2x - p2x, d2z = q2z - p2z
    const rx = p1x - p2x, rz = p1z - p2z
    const a = d1x * d1x + d1z * d1z
    const e = d2x * d2x + d2z * d2z
    const f = d2x * rx + d2z * rz
    const c = d1x * rx + d1z * rz
    const b = d1x * d2x + d1z * d2z
    const denom = a * e - b * b
    let s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0
    let t = (b * s + f) / e
    if (t < 0) { t = 0; s = clamp(-c / a, 0, 1) }
    else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1) }
    return {
      ax: p1x + d1x * s, az: p1z + d1z * s,
      bx: p2x + d2x * t, bz: p2z + d2z * t
    }
  },

  /* ---------------- the contact ---------------- */

  _collide(A, B) {
    const ea = this._ends(A), eb = this._ends(B)
    const cp = this._segSeg(ea.nx, ea.nz, ea.cx, ea.cz, eb.nx, eb.nz, eb.cx, eb.cz)

    let nx = cp.bx - cp.ax, nz = cp.bz - cp.az
    let dist = Math.hypot(nx, nz)
    const minD = A.r + B.r
    if (dist >= minD) return

    if (dist < 1e-9) {          // exactly coincident: fall back to the COM line
      nx = B.x - A.x; nz = B.z - A.z
      dist = Math.hypot(nx, nz) || 1e-9
    }
    nx /= dist; nz /= dist

    const px = (cp.ax + cp.bx) / 2
    const pz = (cp.az + cp.bz) / 2

    const rax = px - A.x, raz = pz - A.z
    const rbx = px - B.x, rbz = pz - B.z

    // point velocity = v + w * perp(r),  perp(x, z) = (-z, x)
    const vax = A.vx - A.w * raz, vaz = A.vz + A.w * rax
    const vbx = B.vx - B.w * rbz, vbz = B.vz + B.w * rbx
    const rvx = vbx - vax, rvz = vbz - vaz
    const vn = rvx * nx + rvz * nz

    /* Who was the ATTACKER has to be decided here, BEFORE the impulse - the
       whole point of the collision is that it swaps the two pens' speeds, so
       reading them afterwards names the pen that just got hit as the one
       doing the hitting. It did exactly that, and inverted the damage split:
       the struck pen took the 34% share while the striker took the full hit.
       Attacking damaged you three times as much as the pen you aimed at,
       which is a coherent enough rule that the bench looked plausible -
       passive prompts on top, every aggressive one at the bottom, no crashes.
       It cost the berserker about 20 points of win rate. */
    const atkIsA = Math.hypot(A.vx, A.vz) >= Math.hypot(B.vx, B.vz)

    /* Positional correction always runs: two resting pens must not sink
       into each other just because they stopped approaching. */
    const corr = Math.max(minD - dist - 0.0002, 0) * 0.5
    A.x -= nx * corr; A.z -= nz * corr
    B.x += nx * corr; B.z += nz * corr

    if (vn > 0) return          // separating

    const rnA = rax * nz - raz * nx
    const rnB = rbx * nz - rbz * nx
    const kN = 1 / A.m + 1 / B.m + rnA * rnA / A.I + rnB * rnB / B.I
    const j = -(1 + PEN.RESTITUTION) * vn / kN

    A.vx -= j * nx / A.m; A.vz -= j * nz / A.m; A.w -= j * rnA / A.I
    B.vx += j * nx / B.m; B.vz += j * nz / B.m; B.w += j * rnB / B.I

    /* Tangential impulse, clamped to the friction cone. This is what turns
       a clip on the tip into a spin instead of a slide, and it is the single
       most important block in the file for how the mode feels. */
    const tx = -nz, tz = nx
    const vt = rvx * tx + rvz * tz
    const rtA = rax * tz - raz * tx
    const rtB = rbx * tz - rbz * tx
    const kT = 1 / A.m + 1 / B.m + rtA * rtA / A.I + rtB * rtB / B.I
    let jt = clamp(-vt / kT, -PEN.FRICTION * Math.abs(j), PEN.FRICTION * Math.abs(j))

    A.vx -= jt * tx / A.m; A.vz -= jt * tz / A.m; A.w -= jt * rtA / A.I
    B.vx += jt * tx / B.m; B.vz += jt * tz / B.m; B.w += jt * rtB / B.I

    this._applyDamage(A, B, -vn, px, pz, atkIsA)
  },

  /* Damage is the CLOSING SPEED, not the flick power - so a smash that
     arrives after the other pen has already drifted away lands soft, and a
     head-on trade where both pens are moving lands enormous. */
  _applyDamage(A, B, vn, px, pz, atkIsA) {
    if (vn < 0.12) return
    const base = PEN.DMG * Math.pow(vn, 1.15)

    /* Whoever was moving faster INTO the contact is the attacker - decided by
       _collide from the PRE-impulse velocities - and from there the
       attacker's aggression and the defender's defense read exactly as they
       do in the fighting game. */
    const atk = atkIsA ? A : B
    const def = atkIsA ? B : A
    const rage = atk.hp < 100 * CONFIG.RAGE_START
      ? (1 - atk.hp / (100 * CONFIG.RAGE_START)) : 0
    const mult = (1 + CONFIG.RAGE_DMG * rage) *
      (1 + CONFIG.PRESSURE_DMG * this._pressure() * 0.5)

    def.hp = Math.max(0, round2(def.hp - base * mult * CONFIG.damageTakenMult(def.stats)))
    // The attacker takes a share too: you cannot smash a pen without your
    // own pen taking the same clack.
    atk.hp = Math.max(0, round2(atk.hp - base * 0.34 * CONFIG.damageTakenMult(atk.stats)))
    atk.hits++

    if (this.bench) return

    const heavy = vn > 1.05
    FX.clack(Math.min(1, vn / 1.8))
    FX.doHitstop(heavy ? CONFIG.HITSTOP_FRAMES : 2)
    this.camShake = Math.max(this.camShake, Math.min(0.055, 0.012 + vn * 0.020))
    this.camPush = Math.max(this.camPush, Math.min(0.11, vn * 0.055))
    this.spark(px, pz, Math.min(1, vn / 1.6))
    if (heavy) FX.punch(0.03)
  },

  /* ---------------- the edge ---------------- */

  _edgeCheck(p) {
    if (p.fallen) return
    const mx = this.hx - Math.abs(p.x)
    const mz = this.hz - Math.abs(p.z)
    const margin = Math.min(mx, mz)

    /* The centre of MASS decides. A pen hanging half off the desk is still
       on the desk - which is exactly the heart-stopping moment the real game
       is made of, so it gets a visible tilt rather than a rule. */
    if (margin < 0) {
      p.fallen = true
      p.vy = 0.12
      if (!this.bench) {
        FX.whoosh()
        this.focus = p
        this.camShake = Math.max(this.camShake, 0.03)
      }
      return
    }

    const over = clamp01(1 - margin / (p.halfL * 1.4))
    p.teeter = over
    p.tiltAxis = mx < mz ? 0 : 1          // 0 = hanging over an x edge
    p.tilt = over * 0.40
    if (!this.bench) {
      if (over > 0.55 && over > p.lastTeeter + 0.22) { p.lastTeeter = over; FX.beep() }
      if (over < 0.30) p.lastTeeter = 0
    }
  },

  /* ================================================================
     THE AI - the same three stats, read by desk rules
     ================================================================ */

  _aiTick(p, o) {
    if (p.fallen || this.over) return

    if (p.charge > 0) {
      /* Winding up: the pen physically rotates onto its line. That rotation
         IS the telegraph - the job ATTACK_STARTUP does in the fighting game,
         except here you can read the aim as well as the timing.

         An ATTACK keeps tracking its target through the wind-up, carrying the
         aim error it rolled when it committed. Without this the aim is fixed
         at decision time and a smash - 39 frames of wind-up, two thirds of a
         second - is thrown at where the other pen used to be. The berserker
         throws mostly smashes and it landed 0.0 hits per round: not a
         balance problem, a pen aiming at a ghost.

         Keeping your pen pointed at theirs while you draw your finger back is
         also simply what a person does. The telegraph still costs what it
         should - the target gets two thirds of a second to be somewhere else,
         and a pen that has already started sliding cannot be tracked onto -
         but the wind-up no longer throws the shot away on its own. */
      if (p.intent === 'attack' && !o.fallen) {
        p.aimA = Math.atan2(o.z - p.z, o.x - p.x) + p.aimErr
      }
      const rate = PEN.TURN_RATE * (0.7 + 0.6 * p.stats.speed)
      p.a += clamp(this._angDiff(p.aimA, p.a), -rate, rate)
      if (--p.charge > 0) return

      /* Fire only once the pen is actually POINTING where it decided to
         point. A flick leaves along the barrel, so a pen that ran out of
         wind-up mid-turn used to launch itself down a heading nobody chose -
         and every safety check had been done against the heading it meant to
         have. A tap only gets ~13 frames of turn (about 68 degrees) so any
         decision needing a bigger turn than that fired essentially at
         random, which is most of where "half of all losses are pens flicking
         themselves off the desk" was coming from.

         Capped, so a pen fighting a big turn cannot stall forever - at the
         cap it commits anyway, which is its own kind of mistake. */
      if (Math.abs(this._angDiff(p.aimA, p.a)) > PEN.AIM_TOL &&
          p.align++ < PEN.MAX_ALIGN) {
        p.charge = 1
        return
      }
      this._flick(p)
      return
    }

    if (Math.hypot(p.vx, p.vz) > PEN.SETTLE_SPEED) return   // still sliding
    if (Math.abs(p.w) > PEN.STOP_W * 3) return              // still spinning
    if (p.cd > 0) { p.cd--; return }

    this._decide(p, o)
  },

  _angDiff(target, cur) {
    let d = (target - cur) % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return d
  },

  /* Which way is the nearest edge FROM a pen - i.e. the direction you would
     have to shove it to put it on the floor. */
  _exit(p) {
    const mx = this.hx - Math.abs(p.x)
    const mz = this.hz - Math.abs(p.z)
    return mx < mz
      ? { x: Math.sign(p.x) || 1, z: 0 }
      : { x: 0, z: Math.sign(p.z) || 1 }
  },

  /* How much of a shove along (ax, az) actually goes toward the opponent's
     nearest edge. 1 = they go straight off; 0 or less = you are pushing them
     back into the middle of the desk and doing them a favour. */
  _lineQuality(o, ax, az) {
    const e = this._exit(o)
    return ax * e.x + az * e.z
  },

  /* How much desk is left in front of this pen along a heading - i.e. how
     far it may slide before it is on the floor. */
  _runway(p, ax, az) {
    let t = Infinity
    if (ax > 1e-6) t = Math.min(t, (this.hx - p.x) / ax)
    else if (ax < -1e-6) t = Math.min(t, (-this.hx - p.x) / ax)
    if (az > 1e-6) t = Math.min(t, (this.hz - p.z) / az)
    else if (az < -1e-6) t = Math.min(t, (-this.hz - p.z) / az)
    return Math.max(0, t === Infinity ? this.hx * 2 : t)
  },

  _decide(p, o) {
    const s = p.stats
    const rng = p.rng
    const pressure = this._pressure()
    const rage = p.hp < 100 * CONFIG.RAGE_START
      ? (1 - p.hp / (100 * CONFIG.RAGE_START)) : 0

    const aggr = clamp01(s.aggression + 0.28 * pressure + CONFIG.RAGE_AGGRO * rage)
    const def = clamp01(s.defense * (1 - 0.40 * pressure))

    const tx = o.x - p.x, tz = o.z - p.z
    const dist = Math.hypot(tx, tz) || 1e-6
    let ax = tx / dist, az = tz / dist

    let move = 'drive'
    let intent = 'attack'
    let travel = dist

    const margin = Math.min(this.hx - Math.abs(p.x), this.hz - Math.abs(p.z))
    const cornered = margin < PEN.DANGER_MARGIN + 0.06 * def

    // Surface to surface, which is the distance a flick actually has to
    // cover - measuring centre to centre overstates it by a whole pen.
    const gap = Math.max(0.01, dist - p.halfL - o.halfL)
    // Under pressure everyone commits from further out, and gives up more.
    const strike = PEN.STRIKE_RANGE + PEN.STRIKE_RANGE_AGGR * aggr + 0.10 * pressure

    if (cornered && rng() < 0.30 + 0.62 * def - 0.22 * aggr) {
      /* Back to the edge: spend the turn getting off it. A berserker skips
         this check almost every time and dies on the counter, which is
         precisely how a berserker is supposed to lose. */
      const cl = Math.hypot(p.x, p.z) || 1e-6
      ax = -p.x / cl; az = -p.z / cl
      travel = Math.min(0.30, cl * 0.75)
      move = 'tap'; intent = 'retreat'
    } else if (gap > strike) {
      /* Too far to commit. Close the distance and STOP SHORT, so the next
         decision is taken from inside striking range with the pen settled -
         which is the difference between a pen fight and two pens taking
         turns to throw themselves across a desk. */
      travel = Math.max(0.05, gap - strike * 0.55)
      move = 'tap'; intent = 'approach'
    } else {
      const q = this._lineQuality(o, ax, az)
      /* A pen shoved along a line that does not end at an edge is a pen you
         have merely annoyed. Checking the line before swinging is the
         clearest behavioural difference between a careful prompt and an
         angry one. */
      const thinks = rng() < (0.70 - 0.60 * aggr + 0.25 * def) * (1 - 0.6 * pressure)
      if (q < PEN.SETUP_QUALITY && thinks) {
        const e = this._exit(o)
        const want = Math.max(0.14, dist * 0.85)
        const mx = (o.x - e.x * want) - p.x
        const mz = (o.z - e.z * want) - p.z
        const ml = Math.hypot(mx, mz)
        if (ml > 0.06) {
          ax = mx / ml; az = mz / ml
          travel = Math.min(0.34, ml)
          move = 'tap'; intent = 'setup'
        }
      }
      if (intent === 'attack') {
        const r = rng()
        /* Capped at 0.70, not 0.86. A smash is 39 frames of wind-up and the
           other pen gets all of them to be somewhere else, so a prompt that
           throws nothing but smashes is the easiest thing on the desk to
           read. Forcing even an all-out pen to mix in drives is not a nerf -
           it was worth several points TO the berserker. */
        const pSmash = clamp(0.10 + 0.55 * aggr - 0.28 * def + 0.30 * Math.max(0, q), 0.04, 0.70)
        const pTap = clamp(0.30 - 0.28 * aggr + 0.26 * def + 0.18 * s.speed, 0.04, 0.60)
        move = r < pSmash ? 'smash' : (r < pSmash + pTap ? 'tap' : 'drive')
      }
    }

    const M = PEN.MOVES[move]
    const vPerPower = PEN.MAX_IMPULSE / p.m

    /* Power. For an attack it comes from the flick; for a reposition it is
       SOLVED from the distance you want to cover (v = sqrt(2*MU*d)), because
       overshooting a reposition puts you on the floor by your own hand. */
    let v0
    if (intent === 'attack') {
      /* Solve the launch speed backwards from the speed this flick wants to
         be doing when it ARRIVES: v0 = sqrt(arrive^2 + 2*MU*gap). Damage is
         closing speed, so the arrival is the number that matters, and a pen
         that plans its shot at the finger instead of at the contact either
         dribbles to a halt on the way or rockets straight past. */
      const vArrive = M.arrive * (0.70 + 0.60 * aggr) * (1 + CONFIG.RAGE_DMG * rage * 0.5)
      v0 = Math.sqrt(vArrive * vArrive + 2 * PEN.MU * gap)
    } else {
      // Repositioning: solve for a flick that STOPS at the target spot.
      v0 = Math.sqrt(2 * PEN.MU * travel)
    }

    /* Aim error. Speed and defense are steadiness; raw aggression is a wild
       swing. Scaled by distance, because a pen at arm's length is a much
       harder shot than one you are already touching. */
    const spread = PEN.AIM_SPREAD *
      clamp(1.05 - 0.40 * s.speed - 0.30 * s.defense + 0.15 * aggr, 0.18, 1.6) *
      clamp(0.45 + dist * 1.1, 0.45, 1.5)
    const err = (rng() * 2 - 1) * spread * (intent === 'attack' ? 1 : 0.4)
    const nomA = Math.atan2(az, ax)

    /* Never flick faster than you can stop before your own back edge.

       A flick that misses keeps every metre of travel it was given, so the
       honest question before committing is not "can I hit them" but "where do
       I stop if I don't".

       The runway is the WORST of the three directions this flick might
       actually take, not the one it is aimed down. A pen that budgets only
       for its intended line is budgeting for a shot it does not have: the
       spread runs to ~25 degrees, the desk is only 76cm deep, and a flick
       that leaves 25 degrees off across the short axis runs out of desk in
       half the distance. That single oversight was the whole loss column -
       65% of all defeats were pens flicking themselves off, against 4% for
       pens actually being knocked off, which is not a pen fight, it is two
       players taking turns to lose.

       Budgeting for your own inaccuracy is also just what a careful player
       does, so the fix says something true about the prompt: steadier pens
       (speed, defense) have a narrower cone to insure against and can
       therefore commit harder from the same spot. */
    /* Every pen budgets for its FULL spread, aggressive or not.

       Scaling this down by aggression was tried and it is a trap: letting a
       wild pen skip its own safety margin does not make it dangerous, it
       makes it dead, because a bigger cone is exactly the case where the
       margin was load-bearing. It cost the berserker five more points.
       Aggression takes its risk in the three places below instead, all of
       which a defender can actually punish. */
    const cone = spread
    const runway = Math.min(
      this._runway(p, ax, az),
      this._runway(p, Math.cos(nomA + cone), Math.sin(nomA + cone)),
      this._runway(p, Math.cos(nomA - cone), Math.sin(nomA - cone)))

    /* Scale is in units of "stops exactly on the edge", so 1.0 is the cliff
       and anything above it is a guaranteed loss on a miss. It reads like a
       gentle dial and it is not: at 1.50 the berserker died in 1.9 seconds
       flat and lost every matchup 3-13%. The band is narrow and sits below
       1.0 - aggression buys a shot taken with less margin, never a shot taken
       off the desk. Aggression takes its risk elsewhere: it commits from
       longer range, aims worse, and will not retreat off an edge. Three
       dangers a defender can punish, instead of one that just kills you. */
    const reckless = intent === 'attack' ? lerp(0.70, 0.98, aggr) : lerp(0.66, 0.90, aggr)
    const vSafe = Math.sqrt(2 * PEN.MU * runway) * reckless
    const power = clamp(Math.min(v0, vSafe) / vPerPower, 0.10, 1)

    p.aimA = nomA + err
    p.aimErr = err
    p.move = move
    p.intent = intent
    p.power = power
    /* Side-spin. Fast, twitchy prompts put english on the flick, which makes
       their pen curl and their hits glance - dangerous to the other pen and,
       occasionally, to their own. */
    p.english = (rng() * 2 - 1) * PEN.ENGLISH * (0.25 + 0.85 * s.speed) *
      (intent === 'attack' ? 1 : 0.3)

    const windup = Math.round(M.windup * clamp(1.25 - 0.45 * s.speed, 0.6, 1.4))
    p.charge = Math.max(4, windup)
    p.chargeMax = p.charge
    p.align = 0
    if (!this.bench) FX.penDraw(power)
  },

  /* The flick: an impulse applied at the CAP end of the pen, along the pen's
     own axis, offset sideways by the english. Applying it at the cap rather
     than at the centre of mass is what makes a flicked pen rotate as it
     goes - a real off-centre impulse, not a spin value someone typed in. */
  _flick(p) {
    const d = this._dir(p)
    const e = this._ends(p)
    const J = p.power * PEN.MAX_IMPULSE

    const cx = e.cx + (-d.z) * p.english * p.r
    const cz = e.cz + (d.x) * p.english * p.r
    const rx = cx - p.x, rz = cz - p.z
    const fx = d.x * J, fz = d.z * J

    p.vx += fx / p.m
    p.vz += fz / p.m
    p.w += (rx * fz - rz * fx) / p.I

    p.flicks++
    p.cd = Math.round(PEN.MOVES[p.move].cd *
      clamp(1.25 - 0.45 * p.stats.speed - 0.18 * p.stats.aggression, 0.55, 1.4))

    if (!this.bench) {
      FX.penFlick(p.power)
      this.dustAt(e.cx, e.cz, p.power)
    }
  },

  /* ---------------- the end ---------------- */

  _checkEnd() {
    if (this.over) return
    const A = this.pens[0], B = this.pens[1]

    if (A.fallen || B.fallen) {
      this._end(A.fallen && B.fallen ? 'draw' : (A.fallen ? 'p2' : 'p1'), 'RING OUT')
      return
    }
    if (A.hp <= 0 || B.hp <= 0) {
      const aDead = A.hp <= 0, bDead = B.hp <= 0
      this._end(aDead && bDead ? 'draw' : (aDead ? 'p2' : 'p1'), 'KO')
      return
    }
    if (this.frame >= this.totalFrames) {
      if (A.hp === B.hp) this._end('draw', 'TIME')
      else this._end(A.hp > B.hp ? 'p1' : 'p2', 'TIME')
    }
  },

  _end(who, how) {
    this.over = true
    this.winner = who
    this.how = how
    if (this.bench) return

    FX.stopMusic()
    FX.shake(20)
    FX.whiteFlash(0.5)
    FX.ko()
    UI.announce(how === 'RING OUT' ? 'OFF THE DESK!' : how === 'KO' ? 'PEN CRACKED' : 'TIME UP')
    // A ring-out gets the deeper slow-motion: the pen is in the air and the
    // fall is the entire payoff of the mode.
    FX.slowmo(how === 'RING OUT' ? 0.16 : 0.26)
    setTimeout(() => FX.cheer(), 600)

    const A = this.pens[0], B = this.pens[1]
    setTimeout(() => {
      UI.showWinner(who, how === 'RING OUT' ? 'KO' : how, {
        label: how,
        hp1: A.hp, hp2: B.hp,
        durationMs: Math.round(this.frame / 60 * 1000),
        seed: this.seed,
        mode: 'PEN FIGHT 3D'
      })
    }, how === 'RING OUT' ? 3000 : 1800)
  }
}

/* ================================================================
   HEADLESS BALANCE BENCH:  ?penbench=200

   Same discipline as runBench() on the fighting side - the mode ships with
   a way to prove its own balance rather than a claim that it is balanced.
   Renderer never starts; this is pure simulation.
   ================================================================ */

function runPenBench(n) {
  const cases = [
    ['berserker', 'relentless berserker, attack without mercy, never back down'],
    ['turtle', 'patient and careful, block everything, wait for an opening'],
    ['assassin', 'extremely fast, dodge everything, hit and run'],
    ['coward', 'be a total coward, run away and avoid all damage'],
    ['balanced', 'fight smart, mix attack and defense']
  ]
  const out = []
  PenFight.bench = true
  for (let i = 0; i < cases.length; i++) {
    for (let j = 0; j < cases.length; j++) {
      let p1w = 0, p2w = 0, draws = 0, frames = 0, ringOut = 0
      for (let k = 0; k < n; k++) {
        PenFight.startSim(parsePrompt(cases[i][1]), parsePrompt(cases[j][1]),
          hashString('pen-seed-' + k))
        let guard = 0
        while (!PenFight.over && guard++ < PenFight.totalFrames + 10) PenFight.step()
        frames += PenFight.frame
        if (PenFight.winner === 'p1') p1w++
        else if (PenFight.winner === 'p2') p2w++
        else draws++
        if (PenFight.how === 'RING OUT') ringOut++
      }
      out.push({
        matchup: cases[i][0] + ' vs ' + cases[j][0],
        p1: Math.round(100 * p1w / n) + '%',
        p2: Math.round(100 * p2w / n) + '%',
        draw: draws,
        avgSec: round2(frames / n / 60),
        ringOut: Math.round(100 * ringOut / n) + '%'
      })
    }
  }
  console.table(out)
  PenFight.bench = false
  PenFight.active = false
  return out
}
