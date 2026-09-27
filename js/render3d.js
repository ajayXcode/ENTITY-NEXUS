/* ------------------------------------------------------------------
   render3d.js - optional 3D renderer. Loaded, but inert until asked for.

   ISOLATION
     A SECOND way to draw the fight. It does not replace the 2D renderer,
     does not modify it, and never writes to the simulation. The only hooks
     into existing code are one early-return at the top of renderAll() and
     one button. Switch it off and the project behaves exactly as before.

     Everything here READS player, enemy, game, CONFIG and FX. Nothing here
     writes to them. The balance tuning, seeded replays and headless bench
     all have to keep holding, and a renderer with no write access cannot
     break them.

   WHAT IS REUSED
     Nearly all of it. The simulation, AI, prompt parser, movelist, blocking,
     HUD, screen flow and audio are the same code that drives the 2D game.

     The impact effects are reused too, which is the trick that makes this
     file small: applyHit() already fills FX.particles, FX.rings and FX.flash
     in canvas pixel coordinates. Rather than duplicate all of that, the 3D
     scene READS those arrays each frame and re-projects them into the world
     (see _updateImpactFX). So a hit shakes the camera, throws sparks and
     blooms in 3D without game.js knowing this file exists.

   THE CHARACTER
     assets/models/Soldier.glb - the stock Mixamo soldier rig, shipped with three.js.
     See assets/models/CREDITS.md.

     It arrives with Idle, Walk and Run only. Every combat animation - the
     three attacks, block, hit reaction and death - is authored HERE, as
     direct rotations on the Mixamo skeleton (see the POSES section). That is
     not a workaround: stock clips could never match this game's timings, and
     our attacks have to land damage on an exact frame (jab 7, normal 11,
     heavy 17). Authoring against those numbers is the only way the swing and
     the hit agree.

     The katana is built from primitives and parented to the right hand bone,
     so it inherits the arm chain and tracks every swing for free.

   COORDINATES
     One world unit is 100 simulation pixels:
       x = (f.position.x + f.width / 2 - 512) / 100
       y = (CONFIG.GROUND_Y - f.position.y) / 100
------------------------------------------------------------------- */

const Render3D = {
  enabled: false, ready: false, loading: false, failed: false,

  scene: null, camera: null, renderer: null, composer: null, bloom: null,
  fighters: {},
  clock: 0, camShake: 0, crowdCheer: 0,

  UNIT: 100,
  TARGET_H: 1.8,
  GROUND_PX: 480,          // canvas y of the floor line (canvas.height - 96)

  MODEL: './assets/models/Soldier.glb',

  available() {
    return typeof THREE !== 'undefined' &&
           typeof THREE.GLTFLoader !== 'undefined' && !this.failed
  },

  /* ---------------- lifecycle ---------------- */

  enable(done) {
    if (this.ready) { this._show(true); if (done) done(true); return }
    if (this.loading) return
    if (!this.available()) {
      this.failed = true
      if (done) done(false, 'three.js or GLTFLoader missing')
      return
    }
    this.loading = true
    try { this._buildScene() } catch (err) {
      console.error('[render3d] scene build failed', err)
      this.failed = true; this.loading = false
      if (done) done(false, err.message); return
    }

    /* Loaded twice rather than cloned: cloning a skinned mesh needs
       SkeletonUtils, and two independent skeletons are provably correct. */
    let pending = 2
    const loader = new THREE.GLTFLoader()
    const onOne = (key, colour, facing) => (gltf) => {
      try {
        this.fighters[key] = this._buildFighter(gltf, colour, facing)
        this.scene.add(this.fighters[key].root)
      } catch (err) {
        console.error('[render3d] rig build failed', err); this.failed = true
      }
      if (--pending === 0) {
        this.loading = false
        this.ready = !this.failed
        if (this.ready) this._show(true)
        if (done) done(this.ready)
      }
    }
    const onErr = (err) => {
      console.error('[render3d] model load failed', err)
      this.failed = true; this.loading = false
      if (done) done(false, 'model failed to load')
    }
    loader.load(this.MODEL, onOne('p1', 0xff3b6b, 1), undefined, onErr)
    loader.load(this.MODEL, onOne('p2', 0x40dcff, -1), undefined, onErr)
  },

  disable() { this._show(false) },

  _show(on) {
    this.enabled = !!on && this.ready
    const a3 = document.querySelector('#arena3d')
    const a2 = document.querySelector('#arena')
    if (a3) a3.classList.toggle('hidden', !this.enabled)
    if (a2) a2.classList.toggle('hidden', this.enabled)
    document.body.classList.toggle('mode-3d', this.enabled)
  },

  /* ---------------- scene ---------------- */

  _buildScene() {
    const canvas = document.querySelector('#arena3d')
    canvas.width = 1024; canvas.height = 576

    const r = new THREE.WebGLRenderer({ canvas, antialias: true })
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    r.setSize(1024, 576, false)
    r.shadowMap.enabled = true
    r.shadowMap.type = THREE.PCFSoftShadowMap
    /* Filmic tone mapping plus sRGB output. This single pair is the largest
       visual difference in the file - without it, lights above 1.0 clip to
       flat white and the whole scene reads like a flat-shaded toy. */
    r.toneMapping = THREE.ACESFilmicToneMapping
    r.toneMappingExposure = 1.15
    if (THREE.sRGBEncoding !== undefined) r.outputEncoding = THREE.sRGBEncoding
    this.renderer = r

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x05060d)
    // Exponential fog: the crowd runs a long way back and linear fog leaves
    // a visible seam where it starts.
    this.scene.fog = new THREE.FogExp2(0x05060d, 0.030)

    this.camera = new THREE.PerspectiveCamera(40, 1024 / 576, 0.1, 200)
    this.camera.position.set(0, 2.6, 9.5)

    this._buildEnvironment()
    this._buildLights()
    this._buildArena()
    this._buildCrowd()
    this._buildImpactFX()
    this._buildComposer()
  },

  /* A procedural environment map. Metal with nothing to reflect looks like
     grey plastic, and PBR needs an environment to be worth using - but an
     HDR file is a megabyte we do not need. So: paint a vertical gradient on
     a canvas, and let PMREM convolve it into a proper IBL probe. */
  _buildEnvironment() {
    const c2 = document.createElement('canvas')
    c2.width = 16; c2.height = 128
    const g = c2.getContext('2d')
    const grad = g.createLinearGradient(0, 0, 0, 128)
    grad.addColorStop(0.00, '#20304f')   // cool sky
    grad.addColorStop(0.45, '#4a3a55')   // warm horizon haze
    grad.addColorStop(0.55, '#2a2036')
    grad.addColorStop(1.00, '#08060c')   // dark floor bounce
    g.fillStyle = grad
    g.fillRect(0, 0, 16, 128)

    const tex = new THREE.CanvasTexture(c2)
    tex.mapping = THREE.EquirectangularReflectionMapping
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    pmrem.compileEquirectangularShader()
    this.scene.environment = pmrem.fromEquirectangular(tex).texture
    tex.dispose()
    pmrem.dispose()
  },

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x8899cc, 0x241a33, 0.35))

    /* One shadow caster. A second map costs real time at this scene size and
       the eye cannot tell on a stage this small. */
    const key = new THREE.DirectionalLight(0xfff2da, 2.1)
    key.position.set(-5, 12, 7)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    const d = 8
    key.shadow.camera.left = -d; key.shadow.camera.right = d
    key.shadow.camera.top = d; key.shadow.camera.bottom = -d
    key.shadow.camera.near = 1; key.shadow.camera.far = 34
    key.shadow.bias = -0.0012
    key.shadow.normalBias = 0.02
    this.scene.add(key)

    /* Coloured rims that ride with each fighter. This is how the two sides
       stay instantly tellable apart - lighting, not recolouring. Kept low and
       behind them so it catches the shoulders and the blade. */
    this.p1Light = new THREE.PointLight(0xff3b6b, 12, 12, 2)
    this.p1Light.position.set(-3, 2.2, -2.2)
    this.p2Light = new THREE.PointLight(0x40dcff, 12, 12, 2)
    this.p2Light.position.set(3, 2.2, -2.2)
    this.scene.add(this.p1Light, this.p2Light)

    const spot = new THREE.SpotLight(0xffe8c0, 120, 30, 0.8, 0.6, 1.8)
    spot.position.set(0, 14, 1)
    this.scene.add(spot, spot.target)
  },

  _buildArena() {
    const g = new THREE.Group()

    /* Polished deck. Low roughness plus the environment probe gives a real
       reflection of the rim lights, which is most of what makes the floor
       look like a lit surface rather than a coloured rectangle. */
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(17, 0.5, 11),
      new THREE.MeshStandardMaterial({
        color: 0x241c30, roughness: 0.22, metalness: 0.65 }))
    deck.position.y = -0.25
    deck.receiveShadow = true
    g.add(deck)

    // Emissive lips. These are what the bloom pass picks up.
    const lip = (z, colour) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(17.2, 0.1, 0.26),
        new THREE.MeshStandardMaterial({
          color: colour, emissive: colour, emissiveIntensity: 2.2,
          roughness: 0.3, metalness: 0.4 }))
      m.position.set(0, 0.03, z)
      g.add(m)
      return m
    }
    lip(5.55, 0xffd24a)
    lip(-5.55, 0x40dcff)

    // Side strips in the player colours, so each fighter owns their half.
    const side = (x, colour) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.1, 11.2),
        new THREE.MeshStandardMaterial({
          color: colour, emissive: colour, emissiveIntensity: 2.0,
          roughness: 0.3 }))
      m.position.set(x, 0.03, 0)
      g.add(m)
    }
    side(-8.5, 0xff3b6b)
    side(8.5, 0x40dcff)

    /* Grid inlay as thin emissive strips rather than a texture: nothing to
       load and it stays crisp at any camera distance. */
    const line = new THREE.MeshStandardMaterial({
      color: 0x5b6ea8, emissive: 0x24304f, emissiveIntensity: 1.2,
      roughness: 0.6, transparent: true, opacity: 0.5 })
    for (let i = -8; i <= 8; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 11), line)
      s.position.set(i, 0.005, 0); g.add(s)
    }
    for (let i = -5; i <= 5; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(17, 0.02, 0.02), line)
      s.position.set(0, 0.005, i); g.add(s)
    }

    // Pillars with glowing capitals, framing the stage.
    const stone = new THREE.MeshStandardMaterial({ color: 0x15111f, roughness: 0.85 })
    for (const px of [-9.6, 9.6]) {
      for (const pz of [4.6, -4.6]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 6, 12), stone)
        col.position.set(px, 3, pz); col.castShadow = true; g.add(col)
        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.42, 0.16, 12),
          new THREE.MeshStandardMaterial({
            color: 0xffd24a, emissive: 0xffa640, emissiveIntensity: 2.6, roughness: 0.4 }))
        cap.position.set(px, 6.05, pz); g.add(cap)
        const torch = new THREE.PointLight(0xffa640, 6, 10, 2)
        torch.position.set(px, 6.1, pz)
        g.add(torch)
      }
    }

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x0b0912, roughness: 0.55, metalness: 0.3 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.5
    floor.receiveShadow = true
    g.add(floor)

    this.scene.add(g)
  },

  // Instanced boxes: the whole crowd is one draw call.
  _buildCrowd() {
    const COUNT = 320
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.4, 1.05, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x171d30, roughness: 0.95 }),
      COUNT)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.crowdData = []
    let i = 0
    for (let ring = 0; ring < 5 && i < COUNT; ring++) {
      const radius = 12 + ring * 1.9
      const n = Math.floor(COUNT / 5)
      for (let k = 0; k < n && i < COUNT; k++, i++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.13
        this.crowdData.push({
          x: Math.cos(a) * radius * 1.4, z: Math.sin(a) * radius,
          base: -0.3 + ring * 0.6, phase: Math.random() * Math.PI * 2,
          rate: 0.9 + Math.random() * 1.4, scale: 0.85 + Math.random() * 0.4
        })
      }
    }
    this.crowd = mesh
    this._dummy = new THREE.Object3D()
    this.scene.add(mesh)
  },

  /* Spark pool and shockwave rings. Both are driven entirely by the existing
     2D FX arrays - see _updateImpactFX. */
  _buildImpactFX() {
    const MAX = 260
    this.sparks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.05),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      MAX)
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.sparks.frustumCulled = false
    if (this.sparks.instanceColor === null && this.sparks.setColorAt) {
      // three.js only allocates the colour buffer once setColorAt is used.
      this.sparks.setColorAt(0, new THREE.Color(0xffffff))
    }
    this.scene.add(this.sparks)
    this._sparkColor = new THREE.Color()

    this.ringPool = []
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.035, 8, 40),
        new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0 }))
      m.visible = false
      this.ringPool.push(m)
      this.scene.add(m)
    }

    // Full-screen impact flash, driven by FX.flash.
    this.flashPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false }))
    this.flashPlane.frustumCulled = false
    this.flashPlane.renderOrder = 999
    this.camera.add(this.flashPlane)
    this.flashPlane.position.set(0, 0, -0.2)
    this.scene.add(this.camera)
  },

  /* Bloom. Emissive trim, the blade and the sparks all bleed light, which is
     what separates "3D scene" from "lit set". Threshold is deliberately high
     so only genuinely bright things glow and the characters stay crisp. */
  _buildComposer() {
    if (typeof THREE.EffectComposer === 'undefined' ||
        typeof THREE.UnrealBloomPass === 'undefined') {
      this.composer = null          // degrade to a plain render
      return
    }
    this.composer = new THREE.EffectComposer(this.renderer)
    this.composer.addPass(new THREE.RenderPass(this.scene, this.camera))
    this.bloom = new THREE.UnrealBloomPass(
      new THREE.Vector2(1024, 576), 0.75, 0.55, 0.82)
    this.composer.addPass(this.bloom)
  },

  /* ---------------- the fighter ---------------- */

  /* Mixamo bone names arrive as "mixamorig:RightArm", and GLTFLoader
     sanitises the punctuation differently across versions. Normalising and
     matching the tail is version-proof, and the exact-tail test matters:
     a plain "contains" would match RightHandThumb1 when looking for
     RightHand. */
  _bone(root, tail) {
    const want = tail.toLowerCase()
    let found = null
    root.traverse((o) => {
      if (found || !o.isBone) return
      const n = o.name.replace(/[^a-z0-9]/gi, '').toLowerCase()
      if (n.endsWith(want)) found = o
    })
    return found
  },

  _buildFighter(gltf, colour, facing) {
    const model = gltf.scene

    /* Auto-fit rather than a magic constant: FBX-derived glTF bakes unit
       conversion into the hierarchy, so measuring the assembled object is
       the only reliable way to get a fighter the right height on the mat. */
    let box = new THREE.Box3().setFromObject(model)
    model.scale.setScalar(this.TARGET_H / Math.max(0.001, box.max.y - box.min.y))
    box = new THREE.Box3().setFromObject(model)
    model.position.y = -box.min.y

    model.traverse((o) => {
      if (!o.isMesh) return
      o.castShadow = true
      o.receiveShadow = true
      o.frustumCulled = false        // skinned bounds go stale mid-animation
      if (o.material) {
        // Shared across both loads - clone before touching, or tinting P1
        // would tint P2 as well.
        o.material = o.material.clone()
        o.material.envMapIntensity = 1.1
        o.material.roughness = Math.min(1, (o.material.roughness || 0.8) * 0.85)
        /* The team colour goes on as an EMISSIVE wash, not a base-colour
           repaint. The soldier keeps his own textures and reads as the same
           character on both sides; the glow says which corner he is in. */
        o.material.emissive = new THREE.Color(colour)
        o.material.emissiveIntensity = 0.16
      }
    })

    const root = new THREE.Group()
    root.add(model)

    const bones = {
      hips: this._bone(model, 'hips'),
      spine: this._bone(model, 'spine'),
      spine1: this._bone(model, 'spine1'),
      spine2: this._bone(model, 'spine2'),
      head: this._bone(model, 'head'),
      rArm: this._bone(model, 'rightarm'),
      rFore: this._bone(model, 'rightforearm'),
      rHand: this._bone(model, 'righthand'),
      lArm: this._bone(model, 'leftarm'),
      lFore: this._bone(model, 'leftforearm'),
      rUpLeg: this._bone(model, 'rightupleg'),
      lUpLeg: this._bone(model, 'leftupleg')
    }

    /* Bind rotations, captured once. Every authored pose below is expressed
       as an OFFSET from these, so a pose composes with whatever clip is
       playing instead of fighting it. */
    const bind = {}
    for (const k in bones) {
      if (bones[k]) bind[k] = bones[k].quaternion.clone()
    }

    const sword = this._buildKatana()
    if (bones.rHand) {
      /* Parented to the hand bone, so it inherits the whole arm chain and
         tracks every swing with no per-frame code. The bone carries the
         model's scale, so the sword is counter-scaled to stay life-sized. */
      const s = new THREE.Vector3()
      bones.rHand.getWorldScale(s)
      sword.scale.setScalar(1 / Math.max(0.0001, s.x))
      bones.rHand.add(sword)
    } else {
      sword.visible = false
    }

    // Guard shield, shown only while blocking.
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 22, 16, 0, Math.PI),
      new THREE.MeshStandardMaterial({
        color: 0x8fd4ff, emissive: 0x3aa6d8, emissiveIntensity: 1.8,
        transparent: true, opacity: 0.3, roughness: 0.15,
        side: THREE.DoubleSide }))
    shield.visible = false
    shield.position.y = 1.0
    root.add(shield)

    const mixer = new THREE.AnimationMixer(model)
    const actions = {}
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip)

    return {
      root, model, shield, sword, mixer, actions, bones, bind, facing,
      baseScale: model.scale.x,
      cur: null, blockK: 0, attackT: 0, attackMove: 'normal', attackLen: 18,
      hitT: 0, deathT: 0, prevAttacking: false, prevHealth: 100
    }
  },

  /* A katana, from primitives. Blade, hamon line, guard, wrapped grip. */
  _buildKatana() {
    const g = new THREE.Group()
    const steel = new THREE.MeshStandardMaterial({
      color: 0xe8eef7, roughness: 0.12, metalness: 1.0,
      emissive: 0x9fc4e8, emissiveIntensity: 0.25 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 0.7 })
    const gold = new THREE.MeshStandardMaterial({
      color: 0xffd24a, roughness: 0.3, metalness: 0.9 })

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1.0, 0.09), steel)
    blade.position.y = 0.62
    blade.castShadow = true
    g.add(blade)

    // Tip, angled - a flat-ended box never reads as a sword.
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 4), steel)
    tip.position.y = 1.2
    tip.rotation.y = Math.PI / 4
    g.add(tip)

    const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.022, 8), gold)
    guard.position.y = 0.1
    g.add(guard)

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.06), dark)
    grip.position.y = -0.02
    g.add(grip)

    /* Sits in a closed fist, blade running forward out of the thumb side.
       These two rotations are the difference between "holding a sword" and
       "a sword stuck through the wrist". */
    g.rotation.set(Math.PI * 0.5, 0, Math.PI * 0.06)
    g.position.set(0, 0.03, 0.02)
    return g
  },

  _play(rig, name, rate) {
    const next = rig.actions[name]
    if (!next) return
    if (rig.cur === next) {
      next.setEffectiveTimeScale(rate === undefined ? 1 : rate)
      return
    }
    next.reset()
    next.setEffectiveTimeScale(rate === undefined ? 1 : rate)
    next.setEffectiveWeight(1)
    next.enabled = true
    next.play()
    if (rig.cur) next.crossFadeFrom(rig.cur, 0.22, false)
    rig.cur = next
  },

  /* ---------------- hooks ---------------- */

  kick(mag) { this.camShake = Math.max(this.camShake, mag || 0.25) },
  cheer(a) { this.crowdCheer = Math.min(1, this.crowdCheer + (a || 0.5)) },

  /* ---------------- per frame ---------------- */

  render() {
    if (!this.ready) return
    const dt = 1 / 60
    this.clock += dt

    this._syncFighter(this.fighters.p1, player, dt)
    this._syncFighter(this.fighters.p2, enemy, dt)
    this.fighters.p1.mixer.update(dt)
    this.fighters.p2.mixer.update(dt)
    // Authored poses go on AFTER the mixer, so they override the clip.
    this._applyPose(this.fighters.p1, player)
    this._applyPose(this.fighters.p2, enemy)

    this._updateImpactFX()
    this._updateCamera()
    this._updateCrowd()

    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  },

  _syncFighter(rig, f, dt) {
    if (!rig) return

    rig.root.position.x = (f.position.x + f.width / 2 - 512) / this.UNIT
    rig.root.position.y = (CONFIG.GROUND_Y - f.position.y) / this.UNIT
    rig.root.rotation.y = rig.facing > 0 ? Math.PI / 2 : -Math.PI / 2

    const blocking = f.isBlocking(game.frame)
    rig.blockK += ((blocking ? 1 : 0) - rig.blockK) * 0.25
    rig.shield.visible = rig.blockK > 0.05
    rig.shield.material.opacity = 0.34 * rig.blockK
    rig.shield.rotation.y = rig.facing > 0 ? 0 : Math.PI

    if (f.health < rig.prevHealth) rig.hitT = 1
    rig.prevHealth = f.health
    if (rig.hitT > 0) rig.hitT = Math.max(0, rig.hitT - 0.08)

    const attacking = f.isAttackAnim()
    if (attacking && !rig.prevAttacking) {
      rig.attackMove = f.attackMove || 'normal'
      // Match the authored swing to the move's real length in game frames,
      // so the blade is at full extension when the damage actually lands.
      rig.attackLen = rig.attackMove === 'jab' ? 10
        : rig.attackMove === 'heavy' ? 26 : 18
      rig.attackT = 1
    }
    rig.prevAttacking = attacking
    if (rig.attackT > 0) rig.attackT = Math.max(0, rig.attackT - 1 / rig.attackLen)

    const dying = f.dead || f.health <= 0
    rig.deathT += ((dying ? 1 : 0) - rig.deathT) * 0.07

    // Base locomotion clip. Everything else is layered on top of it.
    const speed = Math.abs(f.velocity.x)
    if (dying) this._play(rig, 'Idle', 0.25)
    else if (blocking) this._play(rig, 'Idle', 0.5)
    else if (speed > 3) this._play(rig, 'Run', 0.55 + speed * 0.05)
    else if (speed > 0.4) this._play(rig, 'Walk', 1.1)
    else this._play(rig, 'Idle', 1)
  },

  /* ---------------- POSES ----------------
     Authored combat animation. Each helper nudges a bone by an offset from
     its bind rotation, weighted, so poses layer over the locomotion clip
     rather than replacing it. */

  _rot(rig, key, x, y, z, w) {
    const b = rig.bones[key]
    if (!b || !rig.bind[key]) return
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z))
    q.premultiply(rig.bind[key])
    b.quaternion.slerp(q, w)
  },

  _applyPose(rig, f) {
    if (!rig) return
    const ease = (x) => x * x * (3 - 2 * x)

    if (rig.deathT > 0.02) {
      const k = Math.min(1, rig.deathT)
      rig.root.rotation.z = (rig.facing > 0 ? -1 : 1) * 1.45 * k
      rig.root.position.y -= 0.0
      this._rot(rig, 'spine', 0.5 * k, 0, 0, k)
      this._rot(rig, 'head', 0.5 * k, 0, 0, k)
      this._rot(rig, 'rArm', -0.8 * k, 0, 0.5 * k, k)
      this._rot(rig, 'lArm', -0.8 * k, 0, -0.5 * k, k)
      return
    }
    rig.root.rotation.z = 0

    // Block: crouch behind a high guard, sword across the body.
    if (rig.blockK > 0.03) {
      const k = rig.blockK
      rig.model.scale.y = rig.baseScale * (1 - 0.06 * k)
      this._rot(rig, 'spine', 0.22 * k, 0, 0, k)
      this._rot(rig, 'spine2', 0.14 * k, 0.3 * k, 0, k)
      this._rot(rig, 'rArm', -1.5 * k, 0, -0.5 * k, k)
      this._rot(rig, 'rFore', -1.7 * k, 0, 0, k)
      this._rot(rig, 'lArm', -1.3 * k, 0, 0.6 * k, k)
      this._rot(rig, 'lFore', -1.5 * k, 0, 0, k)
      this._rot(rig, 'head', 0.2 * k, 0, 0, k)
    } else {
      rig.model.scale.y = rig.baseScale
    }

    // Attack: wind up, commit, recover. p runs 0 -> 1 across the swing.
    if (rig.attackT > 0) {
      const p = 1 - rig.attackT
      const m = rig.attackMove
      let wind, strike, settle, w

      if (m === 'jab') {
        // Straight thrust from a tight guard. No big wind-up - that is the
        // whole point of a 7-frame startup.
        const ext = p < 0.36 ? ease(p / 0.36) : 1 - ease((p - 0.36) / 0.64)
        w = 1
        this._rot(rig, 'spine2', 0, -0.55 * ext, 0, w)
        this._rot(rig, 'rArm', -1.15 - 0.45 * ext, 0, -0.15, w)
        this._rot(rig, 'rFore', -1.5 + 1.35 * ext, 0, 0, w)
        this._rot(rig, 'lArm', -0.8, 0, 0.5, w * 0.7)
        return
      }

      if (m === 'heavy') {
        /* Overhead, committed with the hips. The hold at the top IS the
           17-frame telegraph the opponent is supposed to read. */
        wind = p < 0.46 ? ease(p / 0.46) : 1
        strike = p < 0.46 ? 0 : ease((p - 0.46) / 0.34)
        settle = p < 0.8 ? 0 : ease((p - 0.8) / 0.2)
        w = 1
        this._rot(rig, 'hips', 0, 0.45 * wind - 0.8 * strike, 0, w * 0.8)
        this._rot(rig, 'spine', -0.35 * wind + 0.55 * strike - 0.2 * settle, 0, 0, w)
        this._rot(rig, 'spine2', -0.3 * wind + 0.5 * strike, 0.7 * wind - 1.3 * strike, 0, w)
        this._rot(rig, 'rArm', -2.7 * wind + 2.3 * strike, 0, -0.5 * wind + 0.4 * strike, w)
        this._rot(rig, 'rFore', -1.0 * wind + 0.85 * strike, 0, 0, w)
        this._rot(rig, 'lArm', -1.6 * wind + 1.0 * strike, 0, 0.7 * wind, w)
        this._rot(rig, 'head', -0.25 * wind + 0.45 * strike, 0, 0, w * 0.6)
        return
      }

      // normal: a committed diagonal cut.
      wind = p < 0.36 ? ease(p / 0.36) : 1
      strike = p < 0.36 ? 0 : ease((p - 0.36) / 0.4)
      settle = p < 0.76 ? 0 : ease((p - 0.76) / 0.24)
      w = 1
      this._rot(rig, 'spine2', -0.2 * wind + 0.35 * strike - 0.1 * settle,
        0.55 * wind - 1.05 * strike, 0, w)
      this._rot(rig, 'rArm', -2.1 * wind + 1.8 * strike, 0, -0.35 * wind + 0.3 * strike, w)
      this._rot(rig, 'rFore', -1.15 * wind + 0.95 * strike, 0, 0, w)
      this._rot(rig, 'lArm', -1.2 * wind + 0.6 * strike, 0, 0.55 * wind, w)
      return
    }

    // Hit reaction, layered over whatever is playing.
    if (rig.hitT > 0) {
      const k = rig.hitT
      this._rot(rig, 'spine', -0.45 * k, 0, 0, k)
      this._rot(rig, 'spine2', -0.3 * k, 0.25 * k, 0, k)
      this._rot(rig, 'head', -0.5 * k, 0.3 * k, 0, k)
      this._rot(rig, 'rArm', 0.4 * k, 0, -0.35 * k, k * 0.8)
      this._rot(rig, 'lArm', 0.4 * k, 0, 0.35 * k, k * 0.8)
    }
  },

  /* ---------------- impact FX, re-projected from the 2D FX system ----------
     applyHit() already produced all of this in canvas pixels. Reading it here
     means a hit blooms, sparks and shakes in 3D with no changes at all to
     game.js - and it can never drift out of sync with the 2D version,
     because it IS the 2D version. */

  _px2world(x, y) {
    return { x: (x - 512) / this.UNIT, y: (this.GROUND_PX - y) / this.UNIT }
  },

  _updateImpactFX() {
    // --- sparks ---
    const d = this._dummy
    const n = Math.min(this.sparks.count, FX.particles.length)
    for (let i = 0; i < this.sparks.count; i++) {
      if (i < n) {
        const p = FX.particles[i]
        const w = this._px2world(p.x, p.y)
        const life = Math.max(0, p.life / p.max)
        d.position.set(w.x, Math.max(0.02, w.y), 0.1)
        d.scale.setScalar(0.4 + life * 1.5)
        d.rotation.set(p.x * 0.05, p.y * 0.05, 0)
        d.updateMatrix()
        this.sparks.setMatrixAt(i, d.matrix)
        if (this.sparks.setColorAt) {
          this._sparkColor.set(p.hot ? 0xffffff : (p.color || '#ffd24a'))
          this._sparkColor.multiplyScalar(0.4 + life * 2.2)   // fade by brightness
          this.sparks.setColorAt(i, this._sparkColor)
        }
      } else {
        d.position.set(0, -999, 0)
        d.scale.setScalar(0.0001)
        d.updateMatrix()
        this.sparks.setMatrixAt(i, d.matrix)
      }
    }
    this.sparks.instanceMatrix.needsUpdate = true
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true

    // --- shockwave rings ---
    for (let i = 0; i < this.ringPool.length; i++) {
      const mesh = this.ringPool[i]
      const r = FX.rings[i]
      if (!r) { mesh.visible = false; continue }
      const t = 1 - r.life / r.max
      const w = this._px2world(r.x, r.y)
      const rad = 0.1 + (1 - Math.pow(1 - t, 3)) * 1.1
      mesh.visible = true
      mesh.position.set(w.x, Math.max(0.1, w.y), 0)
      mesh.scale.setScalar(rad)
      mesh.material.color.set(r.color || '#ffd24a')
      mesh.material.opacity = Math.max(0, (1 - t) * 0.9)
      mesh.rotation.y = this.clock * 0.6
    }

    // --- screen flash ---
    this.flashPlane.material.opacity = Math.min(0.7, FX.flash * 0.8)

    /* Camera shake and crowd noise, both read straight off FX rather than
       needing their own triggers. FX.shake() is called on every landed hit. */
    const mag = FX.shakeFrames > 0
      ? FX.shakeMag * (FX.shakeFrames / CONFIG.SHAKE_FRAMES) : 0
    if (mag > 0) this.camShake = Math.max(this.camShake, mag * 0.016)
    if (mag > 10) this.crowdCheer = Math.min(1, this.crowdCheer + 0.06)
  },

  _updateCamera() {
    const ax = (player.position.x + player.width / 2 - 512) / this.UNIT
    const bx = (enemy.position.x + enemy.width / 2 - 512) / this.UNIT
    const mid = (ax + bx) / 2
    const gap = Math.abs(bx - ax)

    // Same instinct as the 2D camera: track the action, pull back as they
    // separate so both fighters stay in frame.
    const wantZ = 6.6 + gap * 0.95
    const wantX = mid * 0.5
    const wantY = 2.1 + gap * 0.06

    this.camera.position.x += (wantX - this.camera.position.x) * 0.06
    this.camera.position.y += (wantY - this.camera.position.y) * 0.05
    this.camera.position.z += (wantZ - this.camera.position.z) * 0.05

    this.camShake *= 0.85
    const s = this.camShake
    this.camera.position.x += (Math.random() - 0.5) * s
    this.camera.position.y += (Math.random() - 0.5) * s
    this.camera.lookAt(mid * 0.75, 1.1, 0)
    // A little roll on impact; reads as weight rather than as a glitch.
    this.camera.rotation.z += (Math.random() - 0.5) * s * 0.12

    this.p1Light.position.x = ax - 1.4
    this.p2Light.position.x = bx + 1.4
  },

  _updateCrowd() {
    this.crowdCheer *= 0.975
    const d = this._dummy
    const t = this.clock
    for (let i = 0; i < this.crowdData.length; i++) {
      const m = this.crowdData[i]
      const hop = Math.abs(Math.sin(t * m.rate * 3 + m.phase)) * 0.6 * this.crowdCheer
      const sway = Math.sin(t * m.rate + m.phase) * 0.06
      d.position.set(m.x, m.base + hop + sway, m.z)
      d.rotation.set(0, Math.atan2(-m.x, -m.z), 0)
      d.scale.setScalar(m.scale)
      d.updateMatrix()
      this.crowd.setMatrixAt(i, d.matrix)
    }
    this.crowd.instanceMatrix.needsUpdate = true
  }
}
