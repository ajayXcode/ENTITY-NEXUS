/* ------------------------------------------------------------------
   fx.js - sound, screen shake, hitstop, particles, damage numbers.

   All audio is synthesised with WebAudio. The repo ships no audio files and
   we deliberately don't add any: nothing to 404, nothing to license, nothing
   to decode, and the whole demo still runs with the wifi off.

   AudioContext has to be created inside a user gesture, so FX.unlock() is
   called from the title screen's button.
------------------------------------------------------------------- */

const FX = {
  ctx: null,
  master: null,
  muted: false,
  musicOn: false,
  _musicTimer: null,

  shakeFrames: 0,
  shakeMag: 0,
  hitstopFrames: 0,
  flash: 0,
  particles: [],
  floaters: [],

  // --- camera + time ---
  zoom: 0,               // additive scale punch on impact
  timeScale: 1,          // 1 = normal; dropped for the KO slow-motion
  timeScaleTarget: 1,
  vignette: 0,           // red edge glow, driven by sudden death

  // --- world effects ---
  dust: [],              // landing puffs and footstep kicks
  slashes: [],           // arc drawn along a swing
  rings: [],             // expanding impact ring

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume()
      return
    }
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    this.ctx = new AC()
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.30
    this.master.connect(this.ctx.destination)
  },

  setMuted(m) {
    this.muted = m
    if (this.master) this.master.gain.value = m ? 0 : 0.30
  },

  _now() { return this.ctx ? this.ctx.currentTime : 0 },

  _noiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds)
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buf
  },

  _tone({ type = 'square', freq = 440, to = null, dur = 0.15, gain = 0.5, delay = 0 }) {
    if (!this.ctx) return
    const t = this._now() + delay
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur)
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g); g.connect(this.master)
    osc.start(t); osc.stop(t + dur + 0.02)
  },

  _noise({ dur = 0.2, type = 'lowpass', from = 1200, to = 200, q = 1, gain = 0.5, delay = 0 }) {
    if (!this.ctx) return
    const t = this._now() + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this._noiseBuffer(dur)
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.Q.value = q
    f.frequency.setValueAtTime(from, t)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f); f.connect(g); g.connect(this.master)
    src.start(t); src.stop(t + dur)
  },

  /* ---------------- one-shots ---------------- */

  click()      { this._tone({ type: 'square', freq: 660, dur: 0.05, gain: 0.25 }) },
  type()       { this._tone({ type: 'square', freq: 1200 + Math.random() * 300, dur: 0.02, gain: 0.07 }) },
  beep()       { this._tone({ type: 'square', freq: 440, dur: 0.12, gain: 0.35 }) },
  beepHigh()   { this._tone({ type: 'square', freq: 880, dur: 0.38, gain: 0.4 }) },

  bell() {
    this._tone({ type: 'sine', freq: 784, dur: 1.2, gain: 0.45 })
    this._tone({ type: 'sine', freq: 1174, dur: 1.1, gain: 0.30 })
    this._noise({ dur: 0.10, from: 6000, to: 2000, type: 'highpass', gain: 0.35 })
  },

  whoosh() {
    this._noise({ dur: 0.18, type: 'bandpass', from: 400, to: 2600, q: 2.5, gain: 0.22 })
  },

  hit(heavy) {
    this._noise({ dur: heavy ? 0.22 : 0.14, from: 1400, to: 140, gain: heavy ? 0.6 : 0.42 })
    this._tone({ type: 'sine', freq: heavy ? 110 : 90, to: 45, dur: heavy ? 0.28 : 0.18, gain: heavy ? 0.65 : 0.4 })
  },

  /* Metal on metal - bright, short, and pitched well above the thud of a
     landed hit so a blocked exchange is audibly different with your eyes
     shut. That distinction is most of what teaches the mechanic. */
  guard() {
    this._tone({ type: 'square', freq: 1760, to: 1200, dur: 0.07, gain: 0.22 })
    this._tone({ type: 'sine', freq: 2640, to: 1900, dur: 0.11, gain: 0.14 })
    this._noise({ dur: 0.06, type: 'highpass', from: 5200, to: 3000, gain: 0.20 })
  },

  guardBreak() {
    this._noise({ dur: 0.30, from: 2600, to: 180, gain: 0.55 })
    this._tone({ type: 'sawtooth', freq: 300, to: 70, dur: 0.38, gain: 0.45 })
    this._tone({ type: 'square', freq: 1200, to: 300, dur: 0.14, gain: 0.22 })
  },

  ko() {
    this._tone({ type: 'sawtooth', freq: 220, to: 55, dur: 0.9, gain: 0.5 })
    this._noise({ dur: 0.7, from: 3000, to: 200, gain: 0.35 })
    this._tone({ type: 'square', freq: 130, to: 60, dur: 0.6, gain: 0.25, delay: 0.1 })
  },

  cheer() {
    if (!this.ctx) return
    const t = this._now()
    const src = this.ctx.createBufferSource()
    src.buffer = this._noiseBuffer(2.6)
    const f = this.ctx.createBiquadFilter()
    f.type = 'bandpass'; f.frequency.value = 850; f.Q.value = 0.8
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.35)
    g.gain.setValueAtTime(0.45, t + 1.5)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6)
    // slow wobble so it breathes like a crowd rather than hissing like static
    const lfo = this.ctx.createOscillator()
    const lfoG = this.ctx.createGain()
    lfo.frequency.value = 3.5; lfoG.gain.value = 0.12
    lfo.connect(lfoG); lfoG.connect(g.gain)
    lfo.start(t); lfo.stop(t + 2.6)
    src.connect(f); f.connect(g); g.connect(this.master)
    src.start(t); src.stop(t + 2.6)
    for (let i = 0; i < 9; i++) {
      this._noise({ dur: 0.05, type: 'highpass', from: 2200, to: 1800, gain: 0.12, delay: 0.2 + Math.random() * 1.8 })
    }
  },

  alarm() {
    this._tone({ type: 'sawtooth', freq: 300, to: 600, dur: 0.25, gain: 0.3 })
    this._tone({ type: 'sawtooth', freq: 300, to: 600, dur: 0.25, gain: 0.3, delay: 0.3 })
  },

  /* ---------------- pen fight ----------------

     Hollow plastic tubes, not fists. Everything here is pitched an octave
     and a half above hit() and decays in well under a tenth of a second,
     because a pen clack is over before you have finished hearing it.

     v is 0..1 of impact strength and moves three things at once: pitch (a
     harder strike excites a higher partial of the same tube), brightness of
     the transient, and how much low body comes with it. One parameter, three
     correlated cues - which is how a real object sounds like one object hit
     at different strengths rather than two different samples. */
  clack(v) {
    const s = clamp01(v)
    const f = 780 + s * 900
    // The strike itself: a filtered noise transient, 12ms.
    this._noise({ dur: 0.012 + s * 0.012, type: 'bandpass', from: 2600 + s * 4200,
      to: 1400, q: 1.1, gain: 0.22 + s * 0.30 })
    // The tube ringing afterwards. Two partials, the upper one detuned so it
    // beats slightly instead of sounding like a synth tone.
    this._tone({ type: 'triangle', freq: f, to: f * 0.78, dur: 0.055 + s * 0.05,
      gain: 0.16 + s * 0.26 })
    this._tone({ type: 'sine', freq: f * 2.71, to: f * 2.2, dur: 0.035,
      gain: 0.06 + s * 0.12 })
    // Body, only on a real smash - this is the desk answering, not the pen.
    if (s > 0.55) {
      this._tone({ type: 'sine', freq: 150, to: 70, dur: 0.10, gain: 0.20 * s })
      this._noise({ dur: 0.07, from: 700, to: 120, gain: 0.16 * s })
    }
  },

  // Fingernail leaving the barrel, then the barrel leaving the desk.
  penFlick(power) {
    const p = clamp01(power)
    this._tone({ type: 'square', freq: 2100 + p * 900, to: 1500, dur: 0.012, gain: 0.10 + p * 0.10 })
    this._noise({ dur: 0.05 + p * 0.10, type: 'bandpass', from: 900,
      to: 2400 + p * 1600, q: 3.0, gain: 0.05 + p * 0.13 })
  },

  // The wind-up: a pen being turned on the spot, barely audible on purpose.
  penDraw(power) {
    this._noise({ dur: 0.06, type: 'bandpass', from: 500, to: 260, q: 4,
      gain: 0.04 + clamp01(power) * 0.05 })
  },

  /* ---------------- music: 4-note bass arp, ~20 lines, big energy lift ---------------- */
  startMusic() {
    if (!this.ctx || this.musicOn) return
    this.musicOn = true
    const notes = [110, 130.81, 146.83, 98]
    let i = 0
    const step = () => {
      if (!this.musicOn) return
      const f = notes[i % notes.length]
      this._tone({ type: 'sawtooth', freq: f, dur: 0.18, gain: 0.12 })
      if (i % 4 === 0) this._noise({ dur: 0.06, from: 2000, to: 400, gain: 0.10 })
      i++
      this._musicTimer = setTimeout(step, 214)   // ~140bpm
    }
    step()
  },
  stopMusic() {
    this.musicOn = false
    if (this._musicTimer) clearTimeout(this._musicTimer)
  },

  /* ---------------- visual feel ---------------- */

  /* Hitstop: freeze physics for a few frames on impact but keep drawing.
     Single highest-impact-per-line change in the whole project - it is what
     makes contact feel like contact. */
  doHitstop(frames) { this.hitstopFrames = Math.max(this.hitstopFrames, frames) },

  shake(mag) {
    this.shakeMag = Math.max(this.shakeMag, mag)
    this.shakeFrames = Math.max(this.shakeFrames, CONFIG.SHAKE_FRAMES)
  },

  whiteFlash(a) { this.flash = Math.max(this.flash, a) },

  /* Impact sparks. `dir` biases them away from the attacker so a hit reads
     directionally instead of as a symmetrical puff. */
  burst(x, y, color, n, dir) {
    const d = dir || 0
    for (let i = 0; i < (n || 12); i++) {
      const ang = Math.random() * Math.PI * 2
      const spd = 2 + Math.random() * 7
      this.particles.push({
        x, y,
        vx: Math.cos(ang) * spd + d * 3.2,
        vy: Math.sin(ang) * spd - 2,
        life: 18 + Math.random() * 14, max: 32, color
      })
    }
  },

  /* Ground dust: drifts outward and upward, then settles. Used on landings,
     dashes and footfalls - it is what stops the fighters looking like they
     are sliding on glass. */
  dustPuff(x, y, n, dir) {
    for (let i = 0; i < (n || 6); i++) {
      this.dust.push({
        x: x + (Math.random() - 0.5) * 18,
        y: y - Math.random() * 4,
        vx: (dir || (Math.random() - 0.5) * 2) * (0.6 + Math.random() * 1.9),
        vy: -0.3 - Math.random() * 1.1,
        r: 3 + Math.random() * 7,
        life: 16 + Math.random() * 16, max: 34
      })
    }
  },

  /* Arc swept along an attack, drawn in front of the fighter. */
  slash(x, y, dir, color) {
    this.slashes.push({ x, y, dir, color: color || '#ffffff', life: 11, max: 11 })
  },

  ring(x, y, color) {
    this.rings.push({ x, y, color, life: 16, max: 16 })
  },

  punch(z) { this.zoom = Math.max(this.zoom, z) },

  /* KO slow-motion. Only ever runs after the fight is decided, so it cannot
     affect the simulation or the balance. */
  slowmo(scale) { this.timeScale = scale; this.timeScaleTarget = 1 },

  floatText(x, y, text, color) {
    this.floaters.push({ x, y, text, color, life: 45, max: 45 })
  },

  step() {
    if (this.shakeFrames > 0) {
      this.shakeFrames--
      if (this.shakeFrames === 0) this.shakeMag = 0
    }
    this.flash *= 0.82
    if (this.flash < 0.01) this.flash = 0

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.vx *= 0.97; p.life--
      if (p.life <= 0) this.particles.splice(i, 1)
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]
      f.y -= 1.4; f.life--
      if (f.life <= 0) this.floaters.splice(i, 1)
    }
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const p = this.dust[i]
      p.x += p.vx; p.y += p.vy
      p.vx *= 0.92; p.vy = p.vy * 0.90 + 0.035
      p.r += 0.35; p.life--
      if (p.life <= 0) this.dust.splice(i, 1)
    }
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      if (--this.slashes[i].life <= 0) this.slashes.splice(i, 1)
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      if (--this.rings[i].life <= 0) this.rings.splice(i, 1)
    }

    this.zoom *= 0.86
    if (this.zoom < 0.001) this.zoom = 0
    this.timeScale += (this.timeScaleTarget - this.timeScale) * 0.035
  },

  shakeOffset() {
    if (this.shakeFrames <= 0) return { x: 0, y: 0 }
    const decay = this.shakeFrames / CONFIG.SHAKE_FRAMES
    const m = this.shakeMag * decay
    return { x: (Math.random() - 0.5) * 2 * m, y: (Math.random() - 0.5) * 2 * m }
  },

  /* Drawn BEFORE the fighters, so dust kicks up around their feet rather
     than over their faces. */
  renderBehind() {
    for (const p of this.dust) {
      const a = p.life / p.max
      c.save()
      c.globalAlpha = Math.max(0, a * 0.42)
      c.fillStyle = '#cbb89a'
      c.beginPath()
      c.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }
    for (const r of this.rings) {
      const t = 1 - r.life / r.max
      c.save()
      c.globalAlpha = Math.max(0, (1 - t) * 0.8)
      c.strokeStyle = r.color
      c.lineWidth = 5 * (1 - t) + 1
      c.beginPath()
      c.arc(r.x, r.y, 8 + t * 62, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }
  },

  render() {
    // Swing arcs, in front of the fighter that threw them.
    for (const s of this.slashes) {
      const t = 1 - s.life / s.max
      c.save()
      c.globalAlpha = Math.max(0, 1 - t) * 0.85
      c.translate(s.x, s.y)
      c.scale(s.dir, 1)
      c.strokeStyle = s.color
      c.lineWidth = 9 * (1 - t) + 1
      c.lineCap = 'round'
      c.beginPath()
      c.arc(0, 0, 64 + t * 52, -1.05 + t * 0.5, 1.05 + t * 0.5)
      c.stroke()
      c.restore()
    }

    for (const p of this.particles) {
      const a = p.life / p.max
      c.save()
      c.globalAlpha = Math.max(0, a)
      c.fillStyle = p.color
      c.fillRect(p.x, p.y, 4, 4)
      c.restore()
    }
    for (const f of this.floaters) {
      const a = Math.min(1, f.life / 20)
      c.save()
      c.globalAlpha = a
      c.font = 'bold 30px Consolas, monospace'
      c.textAlign = 'center'
      c.lineWidth = 5
      c.strokeStyle = '#000'
      c.strokeText(f.text, f.x, f.y)
      c.fillStyle = f.color
      c.fillText(f.text, f.x, f.y)
      c.restore()
    }
  },

  /* Screen-space, drawn AFTER the camera transform is popped so the flash
     and vignette always cover the full frame regardless of zoom. */
  renderOverlay() {
    if (this.flash > 0.01) {
      c.save()
      c.globalAlpha = Math.min(0.85, this.flash)
      c.fillStyle = '#fff'
      c.fillRect(0, 0, canvas.width, canvas.height)
      c.restore()
    }

    // Sudden-death vignette: pulses red from the edges inward.
    if (this.vignette > 0.01) {
      const pulse = 0.72 + 0.28 * Math.sin(Date.now() / 190)
      const g = c.createRadialGradient(
        canvas.width / 2, canvas.height / 2, canvas.height * 0.30,
        canvas.width / 2, canvas.height / 2, canvas.height * 0.82)
      g.addColorStop(0, 'rgba(255,0,60,0)')
      g.addColorStop(1, 'rgba(255,0,60,' + (0.58 * this.vignette * pulse).toFixed(3) + ')')
      c.save()
      c.fillStyle = g
      c.fillRect(0, 0, canvas.width, canvas.height)
      c.restore()
    }
  },

  reset() {
    this.particles.length = 0
    this.floaters.length = 0
    this.dust.length = 0
    this.slashes.length = 0
    this.rings.length = 0
    this.shakeFrames = 0; this.shakeMag = 0
    this.hitstopFrames = 0; this.flash = 0
    this.zoom = 0; this.vignette = 0
    this.timeScale = 1; this.timeScaleTarget = 1
  }
}
