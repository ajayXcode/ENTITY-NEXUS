/* ------------------------------------------------------------------
   penfight3d.js - PEN FIGHT 3D: the renderer.

   Bolted onto the PenFight object from penfight.js with Object.assign, so
   the simulation file stays runnable with no renderer at all (that is what
   ?penbench=N uses). Nothing in here writes to the simulation - it READS
   pen positions, angles, tilt and the shrinking desk bounds and draws them.

   WHAT MAKES IT LOOK LIKE A DESK AND NOT A TABLE OF BOXES

     1. One warm lamp, and everything else is what that lamp does. A single
        shadow-casting spot at 2800K hanging over the desk, a visible cone of
        light with dust drifting through it, and a room that falls off to
        black. Dramatic lighting is cheaper and more convincing than more
        geometry.

     2. Procedural wood. A 1024px grain canvas becomes the albedo, a derived
        roughness map (grain reads wetter than the surrounding varnish), and
        a Sobel-derived NORMAL map so the grain actually catches the lamp at
        a grazing angle. Three maps from one canvas.

     3. Contact shadows. The pens are millimetres off a surface and the
        shadow under a pen is the single strongest cue that it is ON the
        desk rather than floating above it.

     4. Real pen geometry. Tapered barrel, moulded grip ribs, chrome clip,
        clicker button, and a centre of mass drawn where the sim thinks it
        is - the meshes are positioned from the sim's geometric centre, not
        its centre of mass, so the pivot you see is the pivot being solved.

     5. A floor 60cm below the desk, which is where a pen that goes over the
        edge actually lands. The fall is the payoff of the mode; it deserved
        somewhere to land.
------------------------------------------------------------------- */

Object.assign(PenFight, {

  scene: null, camera: null, renderer: null, composer: null, bloom: null,
  meshes: {}, sparks: null, motes: null, boundary: null,
  aimLines: {},
  clock: 0,
  camPos: null, camAim: null,

  W: 1024, H: 576,

  COLORS: {
    1: { body: 0xb2182b, accent: 0xff3b6b, ink: 0xff5878 },
    2: { body: 0x1b4f8f, accent: 0x40dcff, ink: 0x6fe6ff }
  },

  /* ================================================================
     SCENE
     ================================================================ */

  buildScene() {
    const canvas = document.querySelector('#pen3d')
    canvas.width = this.W; canvas.height = this.H

    const r = new THREE.WebGLRenderer({ canvas, antialias: true })
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    r.setSize(this.W, this.H, false)
    r.shadowMap.enabled = true
    r.shadowMap.type = THREE.PCFSoftShadowMap
    r.toneMapping = THREE.ACESFilmicToneMapping
    r.toneMappingExposure = 0.98
    if (THREE.sRGBEncoding !== undefined) r.outputEncoding = THREE.sRGBEncoding
    this.renderer = r

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x05050a)
    this.scene.fog = new THREE.FogExp2(0x05050a, 0.55)

    this.camera = new THREE.PerspectiveCamera(36, this.W / this.H, 0.02, 40)
    this.camPos = new THREE.Vector3(0, 0.74, 1.04)
    this.camAim = new THREE.Vector3(0, 0, -0.02)
    this.camera.position.copy(this.camPos)
    this.camera.lookAt(this.camAim)

    this._buildEnvironment()
    this._buildLights()
    this._buildDesk()
    this._buildRoom()
    this._buildBoundary()
    this.meshes[1] = this._buildPen(1)
    this.meshes[2] = this._buildPen(2)
    this.scene.add(this.meshes[1].root, this.meshes[2].root)
    this._buildAimLines()
    this._buildSparks()
    this._buildMotes()
    this._buildComposer()
  },

  /* A dim room probe. Plastic and chrome with nothing to reflect look like
     grey clay, and an HDR file is a megabyte we do not need. */
  _buildEnvironment() {
    const c = document.createElement('canvas')
    c.width = 16; c.height = 128
    const g = c.getContext('2d')
    const grad = g.createLinearGradient(0, 0, 0, 128)
    grad.addColorStop(0.00, '#14161f')   // ceiling, out of the lamp's reach
    grad.addColorStop(0.34, '#54432c')   // the lamp, smeared across the ceiling
    grad.addColorStop(0.50, '#241d16')   // the room
    grad.addColorStop(1.00, '#0a0908')   // floor bounce, nearly nothing
    g.fillStyle = grad
    g.fillRect(0, 0, 16, 128)
    const tex = new THREE.CanvasTexture(c)
    tex.mapping = THREE.EquirectangularReflectionMapping
    const pm = new THREE.PMREMGenerator(this.renderer)
    pm.compileEquirectangularShader()
    this.scene.environment = pm.fromEquirectangular(tex).texture
    tex.dispose(); pm.dispose()
  },

  _buildLights() {
    // Floor bounce only. Everything else comes from the lamp.
    this.scene.add(new THREE.HemisphereLight(0x3a4358, 0x0a0908, 0.16))

    /* The lamp. One shadow caster, 2800K, hung 0.85m over the middle of the
       desk. Every shadow in the scene is this light, which is why they all
       agree with each other. */
    /* Intensity 3.4, not 22. physicallyCorrectLights is off (the project's
       other 3D renderer assumes legacy units too), so this number is not
       candela and does not fall off with the inverse square - at 22 the desk
       came out a blown white sheet with the grain burned out of it. */
    const lamp = new THREE.SpotLight(0xffe0ae, 4.6, 4.2, 0.62, 0.55, 1.6)
    /* Off to one side, not straight overhead. A lamp directly above the desk
       puts every shadow directly under the thing casting it, where you cannot
       see it - and the contact shadow is the whole reason the pens read as
       lying ON the desk. Off-axis, each pen throws a shadow its own length. */
    lamp.position.set(-0.42, 0.72, 0.40)
    lamp.target.position.set(0, 0, 0)
    lamp.castShadow = true
    lamp.shadow.mapSize.set(2048, 2048)
    /* The shadow frustum is wrapped tight around the desk. At near 0.1 /
       far 3.2 the depth precision was spread over ten times the range that
       has anything in it, and the desk came out crawling with acne - regular
       dotted bands across the grain that read as a texture bug. A metre of
       useful range plus a real normalBias is the whole fix. */
    lamp.shadow.camera.near = 0.35
    lamp.shadow.camera.far = 1.9
    lamp.shadow.bias = -0.0008
    /* 0.003, not 0.022. normalBias is in world units and a pen is 6mm thick,
       so 22mm of it pushed the shadow sample clean past the pen and deleted
       every contact shadow in the scene - the one cue that says the pens are
       ON the desk rather than hovering a centimetre above it. The dotted
       banding it was fighting turned out to be the normal map, not acne. */
    lamp.shadow.normalBias = 0.003
    lamp.shadow.radius = 1.6
    this.scene.add(lamp, lamp.target)
    this.lamp = lamp

    /* Coloured fills that ride with each pen. This is how the two sides stay
       instantly tellable apart at a glance - lighting, not labels. Kept low,
       weak and close so they read as a glow on the barrel rather than as a
       second lamp. */
    this.fill1 = new THREE.PointLight(this.COLORS[1].accent, 0.40, 0.55, 2)
    this.fill2 = new THREE.PointLight(this.COLORS[2].accent, 0.40, 0.55, 2)
    this.scene.add(this.fill1, this.fill2)
  },

  /* ---------------- the desk ---------------- */

  /* Grain, once, into three maps. The normal map is the one that matters:
     without it the desk is a brown rectangle, and with it the lamp rakes
     across real grain at the far edge. */
  _woodMaps() {
    /* 512, not 1024. The normal map is a Sobel pass over every pixel, and at
       1024 that is a million iterations of JavaScript on the frame the mode
       starts - a visible hitch exactly as the round begins. At 512 the grain
       is still finer than the desk's on-screen size and the pass is a quarter
       of the work. buildScene is also preloaded from the title screen (see
       UI.setMode), so in practice this runs while the player is typing. */
    const S = 512
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = c.getContext('2d')

    g.fillStyle = '#6a5138'      // muted oak, not polished mahogany
    g.fillRect(0, 0, S, S)

    // Grain: long bands that wander, like a plank cut across the rings.
    const height = new Float32Array(S * S)
    for (let band = 0; band < 190; band++) {
      const y0 = Math.random() * S
      const amp = 4 + Math.random() * 26
      const freq = 0.004 + Math.random() * 0.012
      const ph = Math.random() * 6.28
      const dark = Math.random() * 0.45 + 0.12
      const w = 0.7 + Math.random() * 3.6
      g.strokeStyle = 'rgba(46,32,18,' + dark.toFixed(3) + ')'
      g.lineWidth = w
      g.beginPath()
      /* The visible stroke is sampled every 4px (the canvas interpolates the
         path anyway), but the HEIGHT FIELD must be written at EVERY column.
         Writing it every 4th pixel too left three empty columns between every
         filled one, and the Sobel pass below turned that comb into a lattice
         of hard vertical dashes across the whole desk - a texture artifact
         obvious enough to read as a rendering bug. */
      for (let x = 0; x <= S; x++) {
        const y = y0 + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.1 + ph) * amp * 0.25
        if (x % 4 === 0 || x === S) { if (x === 0) g.moveTo(x, y); else g.lineTo(x, y) }
        if (x >= S) continue
        const yi = Math.round(y)
        for (let k = -2; k <= 2; k++) {
          const yy = yi + k
          if (yy >= 0 && yy < S) height[yy * S + x] -= dark * (1 - Math.abs(k) / 3)
        }
      }
      g.stroke()
    }

    // Knots. Two or three per plank is what stops it reading as wallpaper.
    for (let k = 0; k < 3; k++) {
      const kx = Math.random() * S, ky = Math.random() * S
      for (let ring = 22; ring > 0; ring--) {
        g.strokeStyle = 'rgba(30,15,6,' + (0.05 + ring * 0.012).toFixed(3) + ')'
        g.lineWidth = 1 + Math.random() * 2
        g.beginPath()
        g.ellipse(kx, ky, ring * 2.4, ring * 1.3, Math.random() * 0.4, 0, 6.283)
        g.stroke()
      }
    }

    // A decade of being a school desk: scratches, biro, a compass gouge.
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = 'rgba(255,240,215,' + (0.02 + Math.random() * 0.06).toFixed(3) + ')'
      g.lineWidth = Math.random() * 1.2
      const x = Math.random() * S, y = Math.random() * S
      const a = Math.random() * 6.283, l = 10 + Math.random() * 120
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke()
    }
    for (let i = 0; i < 7; i++) {
      g.strokeStyle = 'rgba(30,40,120,' + (0.10 + Math.random() * 0.16).toFixed(3) + ')'
      g.lineWidth = 1.6
      g.beginPath()
      let x = Math.random() * S, y = Math.random() * S
      g.moveTo(x, y)
      for (let s = 0; s < 14; s++) {
        x += (Math.random() - 0.5) * 42; y += (Math.random() - 0.5) * 30
        g.lineTo(x, y)
      }
      g.stroke()
    }

    const map = new THREE.CanvasTexture(c)
    map.wrapS = map.wrapT = THREE.RepeatWrapping
    if (THREE.sRGBEncoding !== undefined) map.encoding = THREE.sRGBEncoding
    map.anisotropy = 8

    /* Roughness, built from the HEIGHT FIELD rather than from the albedo.

       three.js reads roughness out of the GREEN channel and multiplies it by
       material.roughness. Feeding it the albedo meant the desk's roughness
       was the green channel of brown - about 0.27 - which multiplied down to
       0.14 and turned a school desk into wet orange plastic with mirror
       smears across it. Here the base is a genuinely matte 0.82 and the grain
       sits slightly glossier, the way grain that has been polished into for
       years actually does. */
    const rc = document.createElement('canvas')
    rc.width = rc.height = S
    const rg = rc.getContext('2d')
    const rd = rg.createImageData(S, S)
    for (let i = 0, n = S * S; i < n; i++) {
      const v = clamp(0.82 + height[i] * 0.22, 0.42, 0.95) * 255
      rd.data[i * 4] = rd.data[i * 4 + 1] = rd.data[i * 4 + 2] = v
      rd.data[i * 4 + 3] = 255
    }
    rg.putImageData(rd, 0, 0)
    const rough = new THREE.CanvasTexture(rc)
    rough.wrapS = rough.wrapT = THREE.RepeatWrapping
    rough.anisotropy = 8

    // Normal map, Sobel over the accumulated grain height field.
    const nc = document.createElement('canvas')
    nc.width = nc.height = S
    const nd = nc.getContext('2d').createImageData(S, S)
    const at = (x, y) => height[((y + S) % S) * S + ((x + S) % S)]
    const strength = 2.4
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength
        let nx = -dx, ny = -dy, nz = 1
        const l = Math.hypot(nx, ny, nz)
        const i = (y * S + x) * 4
        nd.data[i] = (nx / l * 0.5 + 0.5) * 255
        nd.data[i + 1] = (ny / l * 0.5 + 0.5) * 255
        nd.data[i + 2] = (nz / l * 0.5 + 0.5) * 255
        nd.data[i + 3] = 255
      }
    }
    nc.getContext('2d').putImageData(nd, 0, 0)
    const normal = new THREE.CanvasTexture(nc)
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping
    normal.anisotropy = 8

    return { map, rough, normal }
  },

  _buildDesk() {
    const t = this._woodMaps()
    const hx = PEN.DESK_HX, hz = PEN.DESK_HZ
    const g = new THREE.Group()

    const top = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, 0.028, hz * 2),
      new THREE.MeshStandardMaterial({
        map: t.map, roughnessMap: t.rough, normalMap: t.normal,
        normalScale: new THREE.Vector2(0.45, 0.45),
        color: 0xffffff, roughness: 1.0, metalness: 0.0
      }))
    top.position.y = -0.014
    top.receiveShadow = true
    top.castShadow = true
    g.add(top)

    // The lip. A desk edge has a highlight along it and that highlight is
    // most of how you read where the edge IS - which, in this mode, is the
    // only thing that matters.
    const lipMat = new THREE.MeshStandardMaterial({
      color: 0x2a1a0e, roughness: 0.34, metalness: 0.15 })
    const lipT = 0.006
    const mk = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.031, d), lipMat)
      m.position.set(x, -0.013, z)
      m.castShadow = m.receiveShadow = true
      g.add(m)
    }
    mk(hx * 2 + lipT * 2, lipT, 0, hz + lipT / 2)
    mk(hx * 2 + lipT * 2, lipT, 0, -hz - lipT / 2)
    mk(lipT, hz * 2, hx + lipT / 2, 0)
    mk(lipT, hz * 2, -hx - lipT / 2, 0)

    // Frame underneath, so the desk has a believable underside in the shot
    // when the camera drops to follow a falling pen.
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x14171d, roughness: 0.42, metalness: 0.75 })
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.58, 12), barMat)
      leg.position.set(sx * (hx - 0.05), -0.32, -hz + 0.05)
      leg.castShadow = true
      g.add(leg)
    }

    this.scene.add(g)
    this.deskGroup = g
  },

  _buildRoom() {
    // The floor a fallen pen lands on. Matches PenFight._integrate's -0.60.
    const fc = document.createElement('canvas')
    fc.width = fc.height = 256
    const fg = fc.getContext('2d')
    fg.fillStyle = '#232228'; fg.fillRect(0, 0, 256, 256)
    fg.strokeStyle = '#1a191e'; fg.lineWidth = 6
    fg.strokeRect(0, 0, 256, 256)
    for (let i = 0; i < 900; i++) {
      fg.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.03).toFixed(3) + ')'
      fg.fillRect(Math.random() * 256, Math.random() * 256, 2, 2)
    }
    const ft = new THREE.CanvasTexture(fc)
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping
    ft.repeat.set(8, 8)
    if (THREE.sRGBEncoding !== undefined) ft.encoding = THREE.sRGBEncoding

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshStandardMaterial({ map: ft, roughness: 0.75, metalness: 0.05 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.615
    floor.receiveShadow = true
    this.scene.add(floor)

    /* There was a translucent cone here for a visible beam of lamplight.
       Seen from this camera it presented as a large flat quad slicing across
       the top corner of the frame - an obvious stray polygon rather than
       atmosphere, because a single-layer open cone has hard silhouette edges
       wherever it crosses the view. The dust motes carry the same idea
       (you see a beam because there is dust in it) without the geometry. */

    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.10, 24, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x1d2028, roughness: 0.35, metalness: 0.8, side: THREE.DoubleSide }))
    shade.position.set(-0.10, 0.88, 0.30)
    this.scene.add(shade)

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff0d0 }))
    bulb.position.set(-0.10, 0.845, 0.30)
    this.scene.add(bulb)
  },

  /* The play boundary. Normally a faint chalk line just inside the lip - it
     tells you where the edge is without the camera having to prove it. In
     sudden death it turns red and walks inward, and the pens are suddenly
     standing outside it. */
  _buildBoundary() {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0xffd24a, transparent: true, opacity: 0.30 })
    this.boundary = new THREE.Line(geo, mat)
    this.boundary.position.y = 0.0016
    this.scene.add(this.boundary)
  },

  /* ---------------- the pens ---------------- */

  _plastic(color, rough, metal) {
    const M = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial
    const opts = { color, roughness: rough, metalness: metal || 0 }
    if (THREE.MeshPhysicalMaterial) { opts.clearcoat = 0.85; opts.clearcoatRoughness = 0.10 }
    return new M(opts)
  },

  /* Built along local +X, origin at the GEOMETRIC centre of the barrel -
     the same point _ends() measures the two tips from. */
  _buildPen(side) {
    const C = this.COLORS[side]
    const r = PEN.RAD, L = PEN.LEN
    const root = new THREE.Group()
    const body = new THREE.Group()
    root.add(body)

    const add = (mesh, x, rotZ) => {
      mesh.position.x = x
      if (rotZ !== undefined) mesh.rotation.z = rotZ
      mesh.castShadow = true
      mesh.receiveShadow = true
      body.add(mesh)
      return mesh
    }
    const cyl = (r1, r2, len, mat) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 24, 1), mat)
      m.rotation.z = -Math.PI / 2
      return m
    }

    const barrelMat = this._plastic(C.body, 0.18, 0.08)
    const chrome = this._plastic(0xdfe4ea, 0.12, 1.0)
    const rubber = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.85 })

    // nib -> cap, laid out from +X back to -X
    const half = L / 2
    add(cyl(r * 0.16, r * 0.44, 0.012, chrome), half - 0.006)                  // the tip
    add(cyl(r * 0.44, r * 0.92, 0.020, this._plastic(0x20242c, 0.25, 0.2)), half - 0.022)
    add(cyl(r * 0.92, r * 1.02, 0.030, rubber), half - 0.047)                  // moulded grip
    for (let i = 0; i < 5; i++) {                                              // grip ribs
      const rib = new THREE.Mesh(new THREE.TorusGeometry(r * 1.0, r * 0.12, 6, 16), rubber)
      rib.rotation.y = Math.PI / 2
      add(rib, half - 0.036 - i * 0.0055)
    }
    add(cyl(r * 1.0, r * 1.0, 0.062, barrelMat), half - 0.093)                 // barrel
    const band = add(cyl(r * 1.06, r * 1.06, 0.005, chrome), half - 0.064)     // trim band
    band.userData.trim = true
    add(cyl(r * 1.0, r * 1.04, 0.030, this._plastic(C.body, 0.14, 0.3)), -half + 0.015) // cap
    add(cyl(r * 0.55, r * 0.55, 0.008, chrome), -half - 0.002)                 // clicker
    const btn = add(cyl(r * 0.45, r * 0.45, 0.006, this._plastic(C.accent, 0.25, 0.4)), -half - 0.008)
    btn.material.emissive = new THREE.Color(C.accent)
    btn.material.emissiveIntensity = 1.4

    // The clip, which is what makes a cylinder read as a pen.
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.030, r * 0.30, r * 0.85), chrome)
    clip.position.set(-half + 0.020, r * 1.12, 0)
    clip.castShadow = true
    body.add(clip)
    const clipHead = new THREE.Mesh(new THREE.BoxGeometry(r * 0.9, r * 0.9, r * 0.85), chrome)
    clipHead.position.set(-half + 0.006, r * 0.95, 0)
    body.add(clipHead)

    /* A dim emissive sliver along the barrel in the player's colour. Not a
       pen part - it is the readability budget. Two dark pens under one warm
       lamp are genuinely hard to tell apart in a wide shot, and this reads
       the same way the HUD bars do. */
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.052, r * 0.20, r * 0.30),
      new THREE.MeshBasicMaterial({ color: C.accent }))
    // On TOP of the barrel. It was on the underside, pressed against the
    // desk, which is a thorough way to hide the one thing that tells the two
    // pens apart in a wide shot.
    glow.position.set(half - 0.093, r * 0.92, 0)
    body.add(glow)

    this.scene.add(root)
    return { root, body, glow, clip, color: C }
  },

  /* The aim line drawn on the desk during a windup: chalk, because this is a
     desk, and because a laser sight would be a different game. It is the
     only gameplay-only object in the scene and it earns its place - without
     it the wind-up is invisible until the pen is already moving. */
  _buildAimLines() {
    for (const side of [1, 2]) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
        color: this.COLORS[side].accent, transparent: true, opacity: 0,
        dashSize: 0.012, gapSize: 0.010 }))
      line.position.y = 0.0014
      this.scene.add(line)
      this.aimLines[side] = line
    }
  },

  /* ---------------- particles ---------------- */

  _dot(inner, outer) {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, inner)
    grad.addColorStop(0.35, outer)
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(c)
  },

  _buildSparks() {
    const N = 220
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    const mat = new THREE.PointsMaterial({
      size: 0.011, map: this._dot('rgba(255,255,255,1)', 'rgba(255,190,110,0.85)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexColors: true, sizeAttenuation: true })
    this.sparks = new THREE.Points(geo, mat)
    this.sparks.frustumCulled = false
    this.scene.add(this.sparks)
    this._sparkPool = []
    for (let i = 0; i < N; i++) {
      this._sparkPool.push({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, r: 1, g: 1, b: 1 })
    }
  },

  /* Dust in the lamp beam. Slow, tiny, and never in a hurry - the moment
     they move at a readable speed they stop looking like dust. */
  _buildMotes() {
    const N = 260
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(N * 3)
    this._motePhase = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      /* Kept behind the action, between the lamp and the far half of the
         desk. A mote that drifts in front of the lens is a single additive
         point a few centimetres from the near plane, and the bloom pass turns
         it into a white blob sitting over the desk edge that reads as a
         rendering fault rather than as dust. */
      pos[i * 3] = (Math.random() - 0.5) * 1.5
      pos[i * 3 + 1] = Math.random() * 0.8
      pos[i * 3 + 2] = -0.52 + Math.random() * 0.62
      this._motePhase[i * 3] = Math.random() * 6.283
      this._motePhase[i * 3 + 1] = 0.006 + Math.random() * 0.02
      this._motePhase[i * 3 + 2] = 0.4 + Math.random() * 1.2
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.motes = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.0038, map: this._dot('rgba(255,235,200,0.9)', 'rgba(255,220,170,0.25)'),
      transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true }))
    this.motes.frustumCulled = false
    this.scene.add(this.motes)
  },

  _buildComposer() {
    if (typeof THREE.EffectComposer === 'undefined' ||
        typeof THREE.UnrealBloomPass === 'undefined') { this.composer = null; return }
    this.composer = new THREE.EffectComposer(this.renderer)
    this.composer.addPass(new THREE.RenderPass(this.scene, this.camera))
    // Tight and weak: this is a lamp-lit desk, not a nightclub. The bloom is
    // here for the clicker buttons, the chrome and the boundary line.
    this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(this.W, this.H), 0.42, 0.7, 0.86)
    this.composer.addPass(this.bloom)
  },

  /* ================================================================
     PER FRAME
     ================================================================ */

  spark(x, z, power) {
    if (!this._sparkPool) return
    const n = Math.round(10 + power * 26)
    let made = 0
    for (const s of this._sparkPool) {
      if (s.life > 0) continue
      const a = Math.random() * 6.283
      const sp = (0.10 + Math.random() * 0.55) * (0.4 + power)
      s.x = x; s.y = PEN.RAD; s.z = z
      s.vx = Math.cos(a) * sp
      s.vz = Math.sin(a) * sp
      s.vy = 0.15 + Math.random() * 0.75 * power
      s.max = s.life = 16 + Math.random() * 20
      const warm = Math.random()
      s.r = 1; s.g = 0.55 + warm * 0.4; s.b = 0.20 + warm * 0.35
      if (++made >= n) break
    }
  },

  dustAt(x, z, power) {
    if (!this._sparkPool) return
    let made = 0
    for (const s of this._sparkPool) {
      if (s.life > 0) continue
      const a = Math.random() * 6.283
      s.x = x; s.y = PEN.RAD * 0.5; s.z = z
      s.vx = Math.cos(a) * 0.06 * power
      s.vz = Math.sin(a) * 0.06 * power
      s.vy = 0.02 + Math.random() * 0.06
      s.max = s.life = 20 + Math.random() * 14
      s.r = 0.55; s.g = 0.5; s.b = 0.42
      if (++made >= 6) break
    }
  },

  _updateSparks(dt) {
    const pos = this.sparks.geometry.attributes.position.array
    const col = this.sparks.geometry.attributes.color.array
    let i = 0
    for (const s of this._sparkPool) {
      if (s.life > 0) {
        s.life--
        s.vy -= 3.2 * dt
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt
        if (s.y < PEN.RAD * 0.3) { s.y = PEN.RAD * 0.3; s.vy *= -0.32; s.vx *= 0.7; s.vz *= 0.7 }
        const k = s.life / s.max
        pos[i] = s.x; pos[i + 1] = s.y; pos[i + 2] = s.z
        col[i] = s.r * k; col[i + 1] = s.g * k; col[i + 2] = s.b * k
      } else {
        pos[i + 1] = -99
        col[i] = col[i + 1] = col[i + 2] = 0
      }
      i += 3
    }
    this.sparks.geometry.attributes.position.needsUpdate = true
    this.sparks.geometry.attributes.color.needsUpdate = true
  },

  /* Place one pen's meshes from the sim. The sim tracks the centre of MASS;
     the mesh origin is the geometric centre, so the offset is added back
     here - which means the pivot you watch is the pivot being solved. */
  syncMeshes() {
    for (const p of this.pens) {
      const m = this.meshes[p.side]
      if (!m) continue
      const d = this._dir(p)
      m.root.position.set(p.x + d.x * p.off, p.y, p.z + d.z * p.off)
      m.root.rotation.set(0, -p.a, 0)

      if (p.fallen) {
        // Tumbling off the edge: roll about the barrel's own axis and pitch
        // end over end, which is what a pen actually does.
        m.body.rotation.set(p.spinOff, 0, p.tumble)
      } else if (p.tilt > 0.001) {
        // Hanging over an edge. Tilt about the edge it is hanging over, and
        // drop the overhanging end rather than the whole pen.
        const sign = p.tiltAxis === 0 ? Math.sign(p.x) : Math.sign(p.z)
        const along = p.tiltAxis === 0 ? d.x : d.z
        m.body.rotation.set(0, 0, -p.tilt * Math.sign(along * sign || 1))
      } else {
        m.body.rotation.set(0, 0, 0)
      }
    }
  },

  _updateBoundary() {
    const a = this.boundary.geometry.attributes.position.array
    const hx = this.hx - 0.004, hz = this.hz - 0.004
    const pts = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz], [-hx, -hz]]
    for (let i = 0; i < 5; i++) { a[i * 3] = pts[i][0]; a[i * 3 + 1] = 0; a[i * 3 + 2] = pts[i][1] }
    this.boundary.geometry.attributes.position.needsUpdate = true

    const shrinking = this.shrinkAnnounced
    this.boundary.material.color.setHex(shrinking ? 0xff3b2b : 0xffd24a)
    this.boundary.material.opacity = shrinking
      ? 0.55 + 0.35 * Math.sin(this.clock * 9)
      : 0.22 + 0.06 * Math.sin(this.clock * 2)
  },

  _updateAimLines() {
    for (const p of this.pens) {
      const line = this.aimLines[p.side]
      if (!line) continue
      if (p.charge > 0 && !p.fallen) {
        const d = this._dir(p)
        const e = this._ends(p)
        // Length grows as the wind-up completes: it is a power meter that
        // happens to also be the aim.
        const k = 1 - p.charge / p.chargeMax
        const len = 0.05 + p.power * 0.34 * (0.35 + 0.65 * k)
        const a = line.geometry.attributes.position.array
        a[0] = e.nx; a[1] = 0; a[2] = e.nz
        a[3] = e.nx + d.x * len; a[4] = 0; a[5] = e.nz + d.z * len
        line.geometry.attributes.position.needsUpdate = true
        if (line.computeLineDistances) line.computeLineDistances()
        line.material.opacity = 0.25 + 0.45 * k
      } else {
        line.material.opacity *= 0.82
      }
    }
  },

  /* Broadcast camera. Frames the midpoint of the two pens, pulls back as
     they separate, punches in on contact, and on a ring-out abandons the
     desk entirely to follow the pen over the edge. */
  _updateCamera(dt, snap) {
    const A = this.pens[0], B = this.pens[1]
    let tx, ty, tz, dist

    if (this.focus) {
      const f = this.focus
      tx = f.x; ty = f.y; tz = f.z
      dist = 0.52
    } else {
      tx = (A.x + B.x) / 2
      ty = 0
      tz = (A.z + B.z) / 2
      const sep = Math.hypot(A.x - B.x, A.z - B.z)
      dist = clamp(0.46 + sep * 0.52, 0.56, 0.94) - this.camPush
    }

    // Aim: ease toward the target so the camera never snaps.
    const aimEase = snap ? 1 : (this.focus ? 0.10 : 0.045)
    this.camAim.x += (tx * 0.80 - this.camAim.x) * aimEase
    this.camAim.y += (ty - this.camAim.y) * (snap ? 1 : (this.focus ? 0.08 : 0.05))
    this.camAim.z += (tz * 0.70 - this.camAim.z) * aimEase

    const height = this.focus ? Math.max(0.16, 0.35 + this.focus.y * 0.6) : 0.66
    const wantX = this.camAim.x * 0.55 - 0.02
    const wantY = this.camAim.y + height * (dist / 1.0)
    const wantZ = this.camAim.z + dist

    const ease = snap ? 1 : (this.focus ? 0.055 : 0.035)
    this.camPos.x += (wantX - this.camPos.x) * ease
    this.camPos.y += (wantY - this.camPos.y) * ease
    this.camPos.z += (wantZ - this.camPos.z) * ease

    // Handheld: a tiny amount of drift so the shot is never mechanically
    // still. Two frequencies, neither of them a whole number of the other.
    const bx = Math.sin(this.clock * 0.7) * 0.004 + Math.sin(this.clock * 1.31) * 0.002
    const by = Math.cos(this.clock * 0.9) * 0.003

    const s = this.camShake
    this.camera.position.set(
      this.camPos.x + bx + (Math.random() - 0.5) * s,
      this.camPos.y + by + (Math.random() - 0.5) * s,
      this.camPos.z + (Math.random() - 0.5) * s * 0.6)
    this.camera.lookAt(this.camAim)

    this.camShake *= 0.86
    if (this.camShake < 0.0005) this.camShake = 0
    this.camPush *= 0.90
  },

  render() {
    if (!this.ready) return
    const dt = (1 / 60) * (FX.timeScale || 1)
    this.clock += dt

    this.syncMeshes()
    this._updateBoundary()
    this._updateAimLines()
    this._updateSparks(dt)
    this._updateCamera(dt)

    // The coloured fills ride just above and behind each pen.
    const A = this.pens[0], B = this.pens[1]
    this.fill1.position.set(A.x, A.y + 0.045, A.z)
    this.fill2.position.set(B.x, B.y + 0.045, B.z)
    this.fill1.intensity = A.fallen ? 0.2 : 0.42 + (A.charge > 0 ? 0.55 : 0)
    this.fill2.intensity = B.fallen ? 0.2 : 0.42 + (B.charge > 0 ? 0.55 : 0)

    // Motes drift; the beam breathes very slightly, the way a hung lamp does.
    const mp = this.motes.geometry.attributes.position.array
    for (let i = 0; i < mp.length; i += 3) {
      mp[i] += Math.sin(this.clock * this._motePhase[i + 2] + this._motePhase[i]) * 0.00012
      mp[i + 1] -= this._motePhase[i + 1] * dt * 0.5
      if (mp[i + 1] < -0.05) mp[i + 1] = 0.82
    }
    this.motes.geometry.attributes.position.needsUpdate = true

    if (FX.flash > 0.01 && this.bloom) this.bloom.strength = 0.42 + FX.flash * 1.4
    else if (this.bloom) this.bloom.strength = 0.42

    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }
})
