/* ------------------------------------------------------------------
   utils.js - math helpers, seeded RNG, collision
   Loaded first. Everything else may assume these exist.
------------------------------------------------------------------- */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
function clamp01(v) { return clamp(v, 0, 1) }
function lerp(a, b, t) { return a + (b - a) * t }
function round2(v) { return Math.round(v * 100) / 100 }

/* Deterministic PRNG. Same seed -> same fight, every time.
   This is demo insurance: when rehearsal throws a great fight, note the
   seed off the HUD and relaunch it with ?seed=<n>. */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/* Upstream's attack-box overlap test, unchanged. */
function rectangularCollision({ rectangle1, rectangle2 }) {
  return (
    rectangle1.attackBox.position.x + rectangle1.attackBox.width >=
      rectangle2.position.x &&
    rectangle1.attackBox.position.x <=
      rectangle2.position.x + rectangle2.width &&
    rectangle1.attackBox.position.y + rectangle1.attackBox.height >=
      rectangle2.position.y &&
    rectangle1.attackBox.position.y <= rectangle2.position.y + rectangle2.height
  )
}

/* Read ?p1=&p2=&seed=&auto=1&bench=N off the URL. */
function queryParams() {
  const q = new URLSearchParams(location.search)
  return {
    p1: q.get('p1'),
    p2: q.get('p2'),
    seed: q.get('seed') ? parseInt(q.get('seed'), 10) : null,
    auto: q.get('auto') === '1',
    bench: q.get('bench') ? parseInt(q.get('bench'), 10) : 0,
    penbench: q.get('penbench') ? parseInt(q.get('penbench'), 10) : 0,
    mode: q.get('mode'),                 // 'pen' opens straight on Pen Fight
    debugHuman: q.get('human') === '1',
    hitboxes: q.get('hitboxes') === '1',
    flat: q.get('flat') === '1',
    noai: q.get('noai') === '1'       // force the local lexicon parser
  }
}
