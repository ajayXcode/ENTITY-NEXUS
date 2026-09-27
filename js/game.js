/* ------------------------------------------------------------------
   game.js - arena, fighters, the loop, hit resolution.
   Port of Fight-ME-Monk's index.js. Human input is gone; the `keys` object
   it used to fill is now driven by ai-controller.js.
------------------------------------------------------------------- */

const canvas = document.querySelector('#arena')
const c = canvas.getContext('2d')
canvas.width = 1024
canvas.height = 576

const gravity = 0.7
const STEP_MS = 1000 / 60
const QP = queryParams()

const background = new Sprite({ position: { x: 0, y: 0 }, imageSrc: './assets/img/background.png' })
const shop = new Sprite({ position: { x: 600, y: 128 }, imageSrc: './assets/img/shop.png', scale: 2.75, framesMax: 6 })

/* Frame counts below were read off the sprite sheets (every frame is
   200x200), not copied from upstream - upstream never wired up Attack2 even
   though both sheets ship one. Attack2 has the same frame count as Attack1
   for each character, so the hardcoded damage frames (4 / 2) hold for both
   and we get combo variety for free. */
const player = new Fighter({
  position: { x: CONFIG.START_P1_X, y: 0 },
  velocity: { x: 0, y: 0 },
  imageSrc: './assets/img/samuraiMack/Idle.png',
  framesMax: 8, scale: 2.5,
  offset: { x: 215, y: 157 },
  sprites: {
    idle:    { imageSrc: './assets/img/samuraiMack/Idle.png', framesMax: 8 },
    run:     { imageSrc: './assets/img/samuraiMack/Run.png', framesMax: 8 },
    jump:    { imageSrc: './assets/img/samuraiMack/Jump.png', framesMax: 2 },
    fall:    { imageSrc: './assets/img/samuraiMack/Fall.png', framesMax: 2 },
    // framesHold 3 -> 6 frames x 3 = 18 game frames, matching the Monk's
    // 4 x 5 = 20. Without this the Samurai is locked in its swing 50%
    // longer than the Monk and loses every mirror match.
    attack1: { imageSrc: './assets/img/samuraiMack/Attack1.png', framesMax: 6, framesHold: 3 },
    attack2: { imageSrc: './assets/img/samuraiMack/Attack2.png', framesMax: 6, framesHold: 3 },
    // 4 x 4 = 16 game frames vs the Monk's 3 x 5 = 15.
    takeHit: { imageSrc: './assets/img/samuraiMack/Take Hit - white silhouette.png', framesMax: 4, framesHold: 4 },
    death:   { imageSrc: './assets/img/samuraiMack/Death.png', framesMax: 6 }
  },
  /* Animation only - CONFIG.MOVES holds the mechanics, shared with the Monk.
     Six attack frames to carve up:
       jab    frames 2-5 fast. Cutting frames 0-1 removes the wind-up, which
              is exactly what makes a jab read as already in motion.
       heavy  the full arc at half speed: 6 x 4 = 24 frames, so the swing is
              still travelling when the damage lands on frame 17.
       normal unchanged from before - the whole sheet at hold 3. */
  moves: {
    jab:    { sprite: 'attack1', from: 2, to: 5, hold: 2 },
    normal: { sprite: 'attack1', from: 0, to: 5, hold: 3 },
    heavy:  { sprite: 'attack2', from: 0, to: 5, hold: 4 }
  },
  /* Width is 120, not upstream's 160. Upstream's box spanned [x+100, x+260],
     giving the Samurai a reach of d<=260 against the Monk's d<=220 - a
     40px band where P1 could hit and P2 could not answer. The bench put P1
     at ~61% in every mirror match because of it. 120 makes both windows
     top out at 220. */
  attackBox: { offset: { x: 100, y: 50 }, width: 120, height: 50 }
})

const enemy = new Fighter({
  position: { x: CONFIG.START_P2_X, y: 0 },
  velocity: { x: 0, y: 0 },
  color: 'blue',
  imageSrc: './assets/img/kenji/Idle.png',
  framesMax: 4, scale: 2.5,
  offset: { x: 215, y: 167 },
  sprites: {
    idle:    { imageSrc: './assets/img/kenji/Idle.png', framesMax: 4 },
    run:     { imageSrc: './assets/img/kenji/Run.png', framesMax: 8 },
    jump:    { imageSrc: './assets/img/kenji/Jump.png', framesMax: 2 },
    fall:    { imageSrc: './assets/img/kenji/Fall.png', framesMax: 2 },
    attack1: { imageSrc: './assets/img/kenji/Attack1.png', framesMax: 4 },
    attack2: { imageSrc: './assets/img/kenji/Attack2.png', framesMax: 4 },
    takeHit: { imageSrc: './assets/img/kenji/Take hit.png', framesMax: 3 },
    death:   { imageSrc: './assets/img/kenji/Death.png', framesMax: 7 }
  },
  /* Four attack frames instead of the Samurai's six, so the ranges differ -
     but the totals are matched on purpose: jab 3x3 = 9 against 4x2 = 8,
     heavy 4x6 = 24 against 6x4 = 24. Neither fighter is locked in an
     animation longer than the other for the same move. */
  moves: {
    jab:    { sprite: 'attack1', from: 1, to: 3, hold: 3 },
    normal: { sprite: 'attack1', from: 0, to: 3, hold: 5 },
    heavy:  { sprite: 'attack2', from: 0, to: 3, hold: 6 }
  },
  attackBox: { offset: { x: -170, y: 50 }, width: 170, height: 50 }
})

/* The virtual keyboard. ai-controller.js writes here; handleMovement reads. */
const keys = {
  a: { pressed: false }, d: { pressed: false },
  ArrowLeft: { pressed: false }, ArrowRight: { pressed: false }
}

const STUN_FRAMES = { player: 15, enemy: 15 }   // shared: hitstun is a rule, not artwork
/* Punish window after a missed attack. Now per-move (CONFIG.MOVES.recovery):
   a whiffed jab is nearly free, a whiffed heavy is a gift. `normal` still
   uses 24, so this constant is the value the movelist was built around. */
const COMBO_WINDOW = 26       // cheap-follow-up window after a landed hit

const game = {
  state: 'IDLE',          // IDLE | FIGHT | OVER
  over: false,
  frame: 0,
  totalFrames: CONFIG.FIGHT_SECONDS * 60,
  seed: 0,
  rng: Math.random,
  p1: null, p2: null,     // parsed prompt data
  ai1: null, ai2: null,
  winner: null,
  suddenDeathAnnounced: false,
  firstBlood: false,
  streak: { p1: 0, p2: 0 },
  onEnd: null
}

/* ---------------- input plumbing the AI calls into ---------------- */

function tryJump(f) {
  if (f.dead || !f.grounded) return false      // upstream had no ground check,
  f.velocity.y = CONFIG.JUMP_V                 // which allowed infinite air jumps
  return true
}

function tryAttack(f, move) {
  if (!f.canAttack(game.frame)) return false
  f.attack(move, game.frame)

  /* The swing reads differently per move, so the effects do too. A jab gets
     a short, tight arc; a heavy gets a big slow one and a real wind-up sound.
     This is the only cue the audience gets BEFORE the damage lands, which is
     what lets them see a heavy coming and react to it. */
  const m = f.attackMove
  const dir = f === player ? 1 : -1
  const col = f === player ? '#ffe0e8' : '#dcf7ff'
  FX.whoosh()
  if (m === 'heavy') {
    FX.whoosh()
    FX.slash(f.position.x + f.width / 2 + dir * 70, f.position.y + 62, dir, col)
    if (f.grounded) FX.dustPuff(f.position.x + f.width / 2 - dir * 16, canvas.height - 96, 4, -dir)
  } else if (m === 'jab') {
    FX.slash(f.position.x + f.width / 2 + dir * 54, f.position.y + 80, dir, col)
  } else {
    FX.slash(f.position.x + f.width / 2 + dir * 62, f.position.y + 72, dir, col)
  }
  return true
}

/* Unchanged from upstream apart from moveSpeed. Note the `lastKey` gate -
   pressing a key without also setting lastKey does nothing. */
function handleMovement() {
  player.velocity.x = 0
  enemy.velocity.x = 0

  if (keys.a.pressed && player.lastKey === 'a') {
    player.velocity.x = -player.moveSpeed
    player.switchSprite('run')
  } else if (keys.d.pressed && player.lastKey === 'd') {
    player.velocity.x = player.moveSpeed
    player.switchSprite('run')
  } else {
    player.switchSprite('idle')
  }
  if (player.velocity.y < 0) player.switchSprite('jump')
  else if (player.velocity.y > 0) player.switchSprite('fall')

  if (keys.ArrowLeft.pressed && enemy.lastKey === 'ArrowLeft') {
    enemy.velocity.x = -enemy.moveSpeed
    enemy.switchSprite('run')
  } else if (keys.ArrowRight.pressed && enemy.lastKey === 'ArrowRight') {
    enemy.velocity.x = enemy.moveSpeed
    enemy.switchSprite('run')
  } else {
    enemy.switchSprite('idle')
  }
  if (enemy.velocity.y < 0) enemy.switchSprite('jump')
  else if (enemy.velocity.y > 0) enemy.switchSprite('fall')
}

/* A whiff opens the opponent's free punish window - 15 frames after a jab,
   34 after a heavy - and until now absolutely nothing on screen said so. The
   whole reason patient prompts can beat aggressive ones is invisible.

   So on a miss, hold the fighter in its overextended last frame instead of
   letting it snap back to idle.

   This goes through `pose`, a render-only override read by nothing but
   draw(), and NOT through playMove/switchSprite. The first version drove the
   animation state machine, and the balance harness caught it changing fight
   outcomes within the hour: holding an attack sheet keeps isAttackAnim()
   true, switchSprite's "don't interrupt an attack" guard then refuses the
   takeHit and death switches that takeHit() issues, and a fighter whose
   death sprite never applied never sets `dead`. A cosmetic flourish was
   deciding rounds. Anything that wants to change what is on screen without
   changing the fight has to live outside the state machine.

   Jabs are skipped: 15 frames is barely a window, and freezing the pose for
   it reads as a stutter rather than a mistake. */
function showWhiff(f) {
  if (f.attackMove === 'jab') return
  const anim = f.moves && f.moves[f.attackMove]
  if (!anim) return
  const s = f.sprites[anim.sprite]
  if (!s) return
  f.pose = {
    img: s.image,
    fm: s.framesMax,
    frame: Math.min(anim.to, s.framesMax - 1),
    life: Math.round(f.move.recovery * 0.6)
  }
}

/* Neither sprite sheet has a mirrored variant, so if the fighters ever
   crossed over both attack boxes would point away from the opponent and no
   hit could land again. This is the hard guarantee that never happens.
   Pushing both sides symmetrically reads as a shove rather than a bug. */
function resolveSeparation() {
  let d = enemy.position.x - player.position.x
  if (d < CONFIG.MIN_GAP) {
    const push = (CONFIG.MIN_GAP - d) / 2
    player.position.x -= push
    enemy.position.x += push
  }
  player.position.x = clamp(player.position.x, 0, canvas.width - player.width)
  enemy.position.x = clamp(enemy.position.x, 0, canvas.width - enemy.width)

  // If one of them is pinned against a wall the symmetric push isn't enough.
  d = enemy.position.x - player.position.x
  if (d < CONFIG.MIN_GAP) {
    if (player.position.x <= 0) {
      enemy.position.x = Math.min(canvas.width - enemy.width, CONFIG.MIN_GAP)
    } else {
      player.position.x = Math.max(0, enemy.position.x - CONFIG.MIN_GAP)
    }
  }
}

/* ---------------- pressure ramp ---------------- */

function pressureNow() {
  const t = game.frame / 60
  return clamp01((t - CONFIG.PRESSURE_START_S) / (CONFIG.PRESSURE_FULL_S - CONFIG.PRESSURE_START_S))
}
function suddenDeathNow() { return game.frame / 60 >= CONFIG.SUDDEN_DEATH_S }

/* ---------------- hit resolution ---------------- */

function applyHit(attacker, defender, defenderKey, world) {
  let dmg = attacker.attackDamage * attacker.move.dmg
  dmg *= (1 + CONFIG.PRESSURE_DMG * world.pressure)
  dmg *= (1 + CONFIG.RAGE_DMG * attacker.rage)   // comeback scaling
  if (world.suddenDeath) dmg *= CONFIG.SUDDEN_DEATH_DMG

  const defenderWasAhead = defender.health > attacker.health
  const attackerKey = attacker === player ? 'p1' : 'p2'
  const otherKey = attackerKey === 'p1' ? 'p2' : 'p1'
  const defenderStreak = game.streak[otherKey]

  /* ---- guard check ----
     Three outcomes, not two. A guarded jab is nearly nothing; a guarded
     heavy breaks the guard and is nearly everything. */
  const B = CONFIG.BLOCK
  const guarded = defender.isBlocking(game.frame)
  const guardBreak = guarded && attacker.attackMove === 'heavy'
  const blocked = guarded && !guardBreak

  if (blocked) dmg *= B.CHIP
  else if (guardBreak) dmg *= B.BREAK_DMG

  const applied = defender.takeHit(dmg, blocked)

  /* A clean hit stuns for 15. A guarded one barely staggers - that is the
     whole reward for reading the attack. A broken guard is the longest
     punish window in the game. */
  defender.stunUntil = game.frame +
    (blocked ? B.STUN : guardBreak ? B.BREAK_STUN : STUN_FRAMES[defenderKey])

  if (guardBreak) defender.breakGuard(game.frame)
  if (blocked) defender.blockedHits++

  attacker.isAttacking = false
  attacker.comboUntil = game.frame + COMBO_WINDOW
  attacker.recoverUntil = 0
  attacker.hitsLanded++
  /* A plain integer tally, read only by the post-fight summary. No roll, no
     ordering change - the determinism contract is untouched. */
  attacker.damageDealt += applied

  const dir = attacker === player ? 1 : -1

  /* Knockback. A blocked hit shoves the ATTACKER off instead of the
     defender - that reversal is what makes a successful guard read as
     winning the exchange rather than merely surviving it. */
  if (blocked) attacker.position.x -= B.PUSHBACK * dir
  else defender.position.x += CONFIG.KNOCKBACK * dir

  // Let the plan tier react to momentum rather than grinding on regardless.
  const aAI = attacker === player ? game.ai1 : game.ai2
  const dAI = defender === player ? game.ai1 : game.ai2
  if (aAI && aAI.notifyHitGiven) aAI.notifyHitGiven()
  if (dAI && dAI.notifyHitTaken) dAI.notifyHitTaken()

  const heavy = applied >= 20
  const col = heavy ? '#ff3b6b' : '#ffd24a'
  const hx = defender.position.x + 25
  const hy = defender.position.y + 70

  if (blocked) {
    /* Deliberately the quietest event in the game: a bright metallic ping,
       a small spark, almost no shake and no white flash. Nothing landed, and
       it should sound and feel like nothing landed. */
    FX.guard()
    FX.doHitstop(3)
    FX.shake(4)
    FX.burst(hx, hy, '#cfe9ff', 8, -dir)
    FX.ring(hx, hy, '#8fd4ff')
    FX.floatText(hx, defender.position.y + 44, 'BLOCK', '#8fd4ff')
  } else {
    FX.hit(heavy)
    FX.doHitstop(heavy ? CONFIG.HITSTOP_FRAMES + 2 : CONFIG.HITSTOP_FRAMES)
    FX.shake(heavy ? 14 : 8)
    FX.whiteFlash(heavy ? 0.5 : 0.28)
    FX.punch(heavy ? 0.048 : 0.022)
    Scene3D.kick((heavy ? 0.012 : 0.005) * dir)
    FX.burst(hx, hy, col, heavy ? 22 : 13, dir)
    FX.ring(hx, hy, col)
    FX.dustPuff(hx, canvas.height - 96, heavy ? 6 : 3, dir)
    FX.floatText(hx, defender.position.y + 50, '-' + applied, col)
  }

  if (guardBreak) {
    // The loudest event in the game, because it is the biggest swing in it.
    FX.guardBreak()
    FX.doHitstop(CONFIG.HITSTOP_FRAMES + 5)
    FX.shake(20)
    FX.whiteFlash(0.65)
    FX.punch(0.06)
    FX.burst(hx, hy, '#8fd4ff', 26, dir)
  }

  /* ---- momentum ----
     A blocked hit is not momentum. Counting it would let a fighter walk into
     a guard three times and be told it was DOMINATING. */
  if (!blocked) {
    game.streak[attackerKey]++
    game.streak[otherKey] = 0
  }

  if (game.bench) return

  UI.updateHealth()

  /* ---- dramatic beats, in priority order ---- */
  if (defender.lastStandTriggered) {
    defender.lastStandTriggered = false
    UI.announce('LAST STAND')
    FX.whiteFlash(0.92); FX.shake(26); FX.punch(0.09)
    FX.doHitstop(16); FX.slowmo(0.20); Scene3D.kick(0.03 * dir)
    FX.cheer()
  } else if (guardBreak) {
    UI.announce('GUARD BREAK')
  } else if (defenderStreak >= 3 && defenderWasAhead) {
    // The fighter who was being beaten on just answered back.
    UI.announce('COMEBACK!')
    FX.cheer()
  } else if (game.streak[attackerKey] === 4) {
    UI.announce('DOMINATING')
  } else if (!game.firstBlood) {
    game.firstBlood = true
    UI.announce('FIRST BLOOD')
  }

  if (defender.health > 0 && defender.health <= CONFIG.DANGER_HP && !defender.dangerAnnounced) {
    defender.dangerAnnounced = true
    FX.alarm()
  }
}

/* ---------------- one simulation step ---------------- */

function stepFight() {
  const world = {
    frame: game.frame,
    pressure: pressureNow(),
    suddenDeath: suddenDeathNow(),
    d: enemy.position.x - player.position.x
  }

  if (world.suddenDeath && !game.suddenDeathAnnounced) {
    game.suddenDeathAnnounced = true
    if (!game.bench) {
      UI.announce('SUDDEN DEATH'); FX.alarm(); FX.punch(0.05)
      FX.vignette = 1
      document.body.classList.add('sudden-death')
    }
  }

  /* Snapshot both attack flags before either AI ticks, so neither gets
     same-frame information about the other. Reading them live gave whoever
     ticked second a one-frame reaction edge. */
  const p1Attacking = player.isAttacking
  const p2Attacking = enemy.isAttacking
  if (game.ai1) game.ai1.tick(game.frame, Object.assign({ oppAttacking: p2Attacking }, world))
  if (game.ai2) game.ai2.tick(game.frame, Object.assign({ oppAttacking: p1Attacking }, world))

  handleMovement()
  player.update(game.frame)
  enemy.update(game.frame)
  resolveSeparation()

  /* Both hit tests are snapshotted BEFORE either is applied, so a
     simultaneous trade damages both fighters.
     Resolving them sequentially (as upstream did) handed P1 every trade:
     P1's hit switched P2 into the takeHit sprite and reset framesCurrent to
     0, which made P2's own `framesCurrent === 2` damage test fail on that
     same frame. It was worth ~20 points of win rate in every mirror match. */
  const p1Lands = player.isAttacking && game.frame === player.attackLandFrame
  const p2Lands = enemy.isAttacking && game.frame === enemy.attackLandFrame
  const p1Hits = p1Lands && rectangularCollision({ rectangle1: player, rectangle2: enemy })
  const p2Hits = p2Lands && rectangularCollision({ rectangle1: enemy, rectangle2: player })

  if (p1Hits) applyHit(player, enemy, 'enemy', world)
  if (p2Hits) applyHit(enemy, player, 'player', world)

  /* Whiffs: clear the flag on the damage frame whether or not it connected,
     and open a recovery window the opponent can punish. Whiff-punishing is
     the mechanic that gives defensive prompts something to actually win
     with - without it, aggression strictly dominates and every
     berserker-vs-turtle ends 100/0. */
  if (p1Lands) {
    if (!p1Hits) { player.recoverUntil = game.frame + player.move.recovery; showWhiff(player) }
    player.isAttacking = false
  }
  if (p2Lands) {
    if (!p2Hits) { enemy.recoverUntil = game.frame + enemy.move.recovery; showWhiff(enemy) }
    enemy.isAttacking = false
  }

  if (p1Hits || p2Hits) resolveSeparation()   // knockback must not breach the clamp

  game.frame++

  // One-shot end guard. Upstream called determineWinner() from inside the
  // loop every single frame once a health bar hit zero.
  if (!game.over && (player.health <= 0 || enemy.health <= 0)) {
    /* A double KO is a draw. This used to read `player.health <= 0 ? 'p2'
       : 'p1'`, which silently handed every mutual knockout to P2 - and
       mutual knockouts are common precisely in the aggressive mirror
       matches where both fighters trade on the same frame. */
    const p1Dead = player.health <= 0
    const p2Dead = enemy.health <= 0
    endFight(p1Dead && p2Dead ? 'draw' : (p1Dead ? 'p2' : 'p1'), 'KO')
  } else if (!game.over && game.frame >= game.totalFrames) {
    if (player.health === enemy.health) endFight('draw', 'TIME')
    else endFight(player.health > enemy.health ? 'p1' : 'p2', 'TIME')
  }
}

function endFight(who, how) {
  game.over = true
  game.state = 'OVER'
  game.winner = who
  keys.a.pressed = keys.d.pressed = keys.ArrowLeft.pressed = keys.ArrowRight.pressed = false
  player.velocity.x = 0
  enemy.velocity.x = 0
  if (game.bench) return

  FX.shake(22)
  FX.whiteFlash(0.7)
  FX.punch(0.075)
  Scene3D.kick(0.02)
  FX.ko()
  FX.stopMusic()
  const clutch = how === 'KO' && who !== 'draw' &&
    (who === 'p1' ? player.health : enemy.health) <= 20
  UI.announce(how !== 'KO' ? 'TIME UP' : (clutch ? 'CLUTCH K.O.' : 'K.O.'))

  /* ---- the finish ----
     On a knockout the camera leaves the fight tracker and pushes in on the
     fighter who went down, while time drops to a crawl. The whole point of
     a KO is the last half-second, and at the normal framing - two bodies,
     full arena width - it is over before anyone can see what happened.

     Slow-motion is safe here by construction: the fight is already decided,
     timeScale only feeds the fixed-timestep accumulator in animate(), and
     nothing in stepFight() reads it. It changes how long the finish takes in
     real seconds, never what happened.

     A draw has no loser to frame, so it keeps the wide shot. */
  const loser = how !== 'KO' || who === 'draw' ? null
    : (who === 'p1' ? enemy : player)

  if (loser) {
    FX.slowmo(clutch ? 0.10 : 0.14)   // deeper than the old flat 0.22
    Scene3D.koCam(loser, clutch ? 470 : 520)
  } else {
    FX.slowmo(0.22)
  }

  setTimeout(() => FX.cheer(), 500)

  /* Hold on the KO before the winner screen. The delay is wall-clock, so it
     has to grow with the slow-motion or the shot gets cut off mid-push -
     at 0.10 scale the death animation alone is still playing at 1900ms. */
  if (game.onEnd) setTimeout(() => game.onEnd(who, how), loser ? 3200 : 1900)
}

/* ---------------- setup ---------------- */

function resetFighters() {
  Scene3D.koCam(null)      // hand the camera back to the fight tracker
  player.position.x = CONFIG.START_P1_X; player.position.y = 0
  enemy.position.x = CONFIG.START_P2_X; enemy.position.y = 0
  for (const f of [player, enemy]) {
    f.velocity.x = 0; f.velocity.y = 0
    f.health = 100
    f.dead = false
    f.isAttacking = false
    f.lastStandUsed = false
    f.lastStandArmed = false
    f.lastStandTriggered = false
    f.dangerAnnounced = false
    f.stunUntil = 0
    f.recoverUntil = 0
    f.comboUntil = 0
    f.attackLandFrame = -1
    f.hitsLanded = 0
    f.trail.length = 0
    f.framesCurrent = 0
    f.framesElapsed = 0
    f.image = f.sprites.idle.image
    f.framesMax = f.sprites.idle.framesMax
    // Clear any move sub-range left behind by the previous round's last
    // swing, or idle would play that range on a loop instead of the sheet.
    f.frameFrom = 0
    f.frameTo = undefined
    f.oneShot = false
    f.attackMove = 'normal'
    f.pose = null
    f.blockUntil = 0
    f.blockFrom = 0
    f.blockReadyAt = 0
    f.blockedHits = 0
    f.damageDealt = 0
    f.lastKey = ''
  }
  keys.a.pressed = keys.d.pressed = keys.ArrowLeft.pressed = keys.ArrowRight.pressed = false
}

function applyStats(f, data, side) {
  const s = data.stats
  f.moveSpeed = CONFIG.moveSpeed(s)
  f.attackDamage = CONFIG.baseDamage(s) * CONFIG.CHAR_DMG[side]
  f.damageTakenMult = CONFIG.damageTakenMult(s)

  // Visual tell: weights alone are far too subtle to read from the back of
  // a room, so the dominant stat gets a colour.
  const top = Math.max(s.aggression, s.defense, s.speed)
  if (top === s.aggression) { f.auraColor = 'rgba(255,59,107,ALPHA)'; f.auraStrength = s.aggression }
  else if (top === s.defense) { f.auraColor = 'rgba(64,220,255,ALPHA)'; f.auraStrength = s.defense }
  else { f.auraColor = 'rgba(255,214,74,ALPHA)'; f.auraStrength = s.speed }
}

function startFight(p1Data, p2Data, seed) {
  resetFighters()
  FX.reset()
  document.body.classList.remove('sudden-death')

  game.p1 = p1Data
  game.p2 = p2Data
  game.seed = seed >>> 0
  game.frame = 0
  game.over = false
  game.winner = null
  game.suddenDeathAnnounced = false
  game.firstBlood = false
  game.streak = { p1: 0, p2: 0 }
  FX.vignette = 0
  game.totalFrames = CONFIG.FIGHT_SECONDS * 60
  game.bench = false

  applyStats(player, p1Data, 'left')
  applyStats(enemy, p2Data, 'right')

  // Roll last stand per fighter, per fight - deterministic with the seed.
  const lsRng = mulberry32(game.seed ^ 0xc2b2ae35)
  player.lastStandArmed = lsRng() < CONFIG.LAST_STAND_CHANCE
  enemy.lastStandArmed = lsRng() < CONFIG.LAST_STAND_CHANCE

  // Two independent streams so one fighter's rolls can't shift the other's.
  const rng1 = mulberry32(game.seed ^ 0x9e3779b9)
  const rng2 = mulberry32(game.seed ^ 0x85ebca6b)

  /* jevSide names which playbook each controller consults. Side A is always
     the left fighter, matching the contract's SIDE_A, so the advisor, the
     board and the chain all agree on who "A" is. */
  game.ai1 = QP.debugHuman ? null : createAI({
    self: player, opponent: enemy, keymap: { left: 'a', right: 'd' },
    stats: p1Data.stats, rng: rng1, side: 'left', jevSide: 'A'
  })
  game.ai2 = createAI({
    self: enemy, opponent: player, keymap: { left: 'ArrowLeft', right: 'ArrowRight' },
    stats: p2Data.stats, rng: rng2, side: 'right', jevSide: 'B'
  })

  game.state = 'FIGHT'
  if (!benchMode) FX.startMusic()
}

/* ---------------- the loop ---------------- */

let _last = performance.now()
let _acc = 0
let benchMode = false     // set by runBench so the rAF loop stands down

/* ---------------- attract mode ----------------

   The title screen is transparent, so the arena behind it is the real,
   running arena - tickWorld already plays both idle cycles whenever the game
   is not in FIGHT state. That means the title gets two genuinely animated
   fighters for free: no new artwork, no second render path, no pre-rendered
   video. It is the same two characters the player is about to command.

   They stand wider apart than their fight positions so they frame the title
   text rather than standing behind it.
------------------------------------------------------------------- */

const ATTRACT_P1_X = 140
const ATTRACT_P2_X = 834

function attractPose() {
  player.position.x = ATTRACT_P1_X
  enemy.position.x = ATTRACT_P2_X
  // Drop them straight onto the floor. Starting at y = 0 would have them
  // fall in and kick up a landing puff the moment the page loads.
  player.position.y = CONFIG.GROUND_Y
  enemy.position.y = CONFIG.GROUND_Y
  player.velocity.x = player.velocity.y = 0
  enemy.velocity.x = enemy.velocity.y = 0
}

let _attractTimer = 0
let _titleEl = null

/* Every couple of seconds one of them throws a swing. Two statues breathing
   reads as a screenshot; an occasional flourish tells you at a glance that
   this is a live scene and these are the fighters.

   No call into tryAttack(): that sets isAttacking and schedules a damage
   frame, and nothing clears either outside stepFight() - which never runs
   here - so they would lock up mid-swing. Driving switchSprite directly is
   enough, because switchSprite refuses to interrupt an attack until its last
   frame and tickWorld's switchSprite('idle') then takes them back. */
function attractFlourish() {
  if (!_titleEl) _titleEl = document.querySelector('#screen-title')
  if (!_titleEl || !_titleEl.classList.contains('active')) { _attractTimer = 0; return }
  if (++_attractTimer < 140) return       // ~2.3s at 60Hz
  _attractTimer = 0

  const f = Math.random() < 0.5 ? player : enemy
  if (f.isAttackAnim()) return
  f.switchSprite(Math.random() < 0.5 ? 'attack1' : 'attack2')
  FX.whoosh()
  const dir = f === player ? 1 : -1
  FX.slash(f.position.x + f.width / 2 + dir * 62, f.position.y + 72, dir,
    f === player ? '#ffe0e8' : '#dcf7ff')
}

attractPose()

function tickWorld() {
  // ?bench drives stepFight() directly in a tight loop; letting the render
  // loop step it as well would interleave two simulations.
  if (benchMode) return

  /* Hook 1 of 2 into PEN FIGHT (js/penfight.js). While that mode is active
     it owns the frame: its own simulation steps here and the fighting game
     below this line is not touched at all - the fighters simply stand where
     they were. It borrows the fixed timestep, the hitstop and FX.timeScale,
     which is why slow-motion and seeded replays work there for free. */
  if (typeof PenFight !== 'undefined' && PenFight.active) { PenFight.tick(); return }

  background.update()
  shop.update()

  if (game.state !== 'FIGHT') {
    player.switchSprite('idle'); enemy.switchSprite('idle')
    player.update(game.frame); enemy.update(game.frame)
    attractFlourish()
    FX.step()
    return
  }

  // Hitstop: freeze the simulation but keep rendering, so a hit reads as
  // an impact instead of a number changing.
  if (FX.hitstopFrames > 0) { FX.hitstopFrames--; return }

  stepFight()
  FX.step()
  if (!game.bench) UI.updateFightHud()
}

function renderAll() {
  /* The one and only hook into the 3D renderer (js/render3d.js). It is an
     alternative way to DRAW the frame that has already been simulated - the
     fight above this line is identical either way. If render3d.js is absent
     or WebGL is unavailable, this is a no-op and the 2D path runs. */
  // Hook 2 of 2 into PEN FIGHT. Checked before Render3D because the pen
  // mode brings its own renderer and its own canvas.
  if (typeof PenFight !== 'undefined' && PenFight.active) {
    PenFight.render()
    return
  }

  if (typeof Render3D !== 'undefined' && Render3D.enabled) {
    Render3D.render()
    return
  }

  const sh = FX.shakeOffset()
  const z = 1 + FX.zoom

  if (QP.flat) return renderFlat(sh, z)

  /* ---- perspective arena (scene3d.js) ---- */
  Scene3D.update(player, enemy, game.state === 'FIGHT')

  c.fillStyle = '#070911'
  c.fillRect(0, 0, canvas.width, canvas.height)

  c.save()
  c.translate(sh.x, sh.y)

  // Everything behind the fight plane, projected per-vertex.
  Scene3D.renderBackdrop(background, shop)
  Scene3D.renderCrowd()
  Scene3D.renderStage()

  /* The fight plane itself is one flat layer under a single transform, so
     sprites, particles, slashes and damage numbers all inherit the camera
     without needing to know it exists. */
  Scene3D.applyCamera(1 + FX.zoom)
  Scene3D.renderReflection(player)
  Scene3D.renderReflection(enemy)
  FX.renderBehind()
  player.render()
  enemy.render()
  FX.render()
  drawHitboxes()
  Scene3D.popCamera()

  c.restore()
  FX.renderOverlay()
}

function drawHitboxes() {
  if (!QP.hitboxes) return
  c.strokeStyle = '#0f0'; c.lineWidth = 2
  for (const f of [player, enemy]) {
    c.strokeRect(f.position.x, f.position.y, f.width, f.height)
    c.strokeStyle = '#f00'
    c.strokeRect(f.attackBox.position.x, f.attackBox.position.y, f.attackBox.width, f.attackBox.height)
    c.strokeStyle = '#0f0'
  }
}

/* The original flat renderer, kept behind ?flat=1 for side-by-side
   comparison. Identical gameplay - only the presentation differs. */
function renderFlat(sh, z) {
  c.save()
  c.translate(canvas.width / 2, canvas.height / 2)
  c.scale(z, z)
  c.translate(-canvas.width / 2 + sh.x, -canvas.height / 2 + sh.y)

  c.fillStyle = 'black'
  c.fillRect(-60, -60, canvas.width + 120, canvas.height + 120)

  const mid = (player.position.x + enemy.position.x) / 2 + 25
  const px = (mid - canvas.width / 2) * -0.035
  c.save()
  c.translate(canvas.width / 2 + px, canvas.height / 2)
  c.scale(1.06, 1.06)
  c.translate(-canvas.width / 2, -canvas.height / 2)
  background.render()
  shop.render()
  c.restore()

  c.fillStyle = 'rgba(255, 255, 255, 0.15)'
  c.fillRect(-60, -60, canvas.width + 120, canvas.height + 120)

  FX.renderBehind()
  player.render()
  enemy.render()
  FX.render()
  drawHitboxes()
  c.restore()
  FX.renderOverlay()
}

let _errStreak = 0
let _loopDead = false

function showFatal(err) {
  let el = document.querySelector('#fatal')
  if (!el) {
    el = document.createElement('div')
    el.id = 'fatal'
    document.body.appendChild(el)
  }
  /* Use DOM APIs so that an exception whose .message contains '<' or '>'
     (e.g. from a crafted network payload triggering a parse error) cannot
     inject markup into the error banner. */
  el.textContent = ''
  const title = document.createElement('b')
  title.textContent = 'RENDER LOOP STOPPED'
  el.appendChild(title)
  const msg = document.createElement('p')
  msg.textContent = String(err && err.message ? err.message : err)
  el.appendChild(msg)
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = 'If you just edited a file this is almost always a stale cached script. Hard-refresh with Ctrl+Shift+R.'
  el.appendChild(hint)
}

function animate(now) {
  if (_loopDead) return
  window.requestAnimationFrame(animate)
  try {
    const dt = Math.min(100, now - _last)
    _last = now
    _acc += dt * FX.timeScale
    // Fixed timestep: without this the whole fight runs ~2.4x fast on a 144Hz
    // laptop, which is exactly the machine a demo gets run on.
    let steps = 0
    while (_acc >= STEP_MS && steps < 5) { _acc -= STEP_MS; tickWorld(); steps++ }
    renderAll()
    _errStreak = 0
  } catch (err) {
    /* Without this, one bad frame rethrows every frame forever: the loop is
       already rescheduled above, so it spams the console and the canvas
       never updates again. Report the first failure, tolerate a short
       hiccup, then stop cleanly and say so on screen. */
    if (_errStreak === 0) console.error('[frame error]', err)
    if (++_errStreak > 30) {
      _loopDead = true
      console.error('Render loop stopped after 30 consecutive frame errors.')
      showFatal(err)
    }
  }
}

window.requestAnimationFrame(animate)

/* ---------------- headless balance bench: ?bench=200 ---------------- */

function runBench(n) {
  benchMode = true
  const cases = [
    ['berserker', 'relentless berserker, attack without mercy, never back down'],
    ['turtle', 'patient and careful, block everything, wait for an opening'],
    ['assassin', 'extremely fast, dodge everything, hit and run'],
    ['coward', 'be a total coward, run away and avoid all damage'],
    ['balanced', 'fight smart, mix attack and defense']
  ]
  const out = []
  for (let i = 0; i < cases.length; i++) {
    for (let j = 0; j < cases.length; j++) {
      let p1w = 0, p2w = 0, draws = 0, frames = 0, ko = 0
      for (let k = 0; k < n; k++) {
        const a = parsePrompt(cases[i][1])
        const b = parsePrompt(cases[j][1])
        // Well-distributed but identical across matchups (common random
        // numbers), so matchups are compared on the same sample of fights.
        startFight(a, b, hashString('bench-seed-' + k))
        game.bench = true
        FX.hitstopFrames = 0
        let guard = 0
        while (!game.over && guard++ < game.totalFrames + 10) stepFight()
        frames += game.frame
        if (game.winner === 'p1') p1w++
        else if (game.winner === 'p2') p2w++
        else draws++
        if (game.frame < game.totalFrames) ko++
      }
      out.push({
        matchup: cases[i][0] + ' vs ' + cases[j][0],
        p1: Math.round(100 * p1w / n) + '%',
        p2: Math.round(100 * p2w / n) + '%',
        draw: draws,
        avgSec: round2(frames / n / 60),
        koRate: Math.round(100 * ko / n) + '%'
      })
    }
  }
  console.table(out)
  game.bench = false
  game.state = 'IDLE'
  benchMode = false
  resetFighters()
  return out
}
