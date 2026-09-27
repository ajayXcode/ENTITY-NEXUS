#!/usr/bin/env node
/* ------------------------------------------------------------------
   scripts/make-champion-assets.js

   Builds the champion asset pack out of the one reference sheet.

   The sheet carries a portrait, a full body, a WEAPONS panel, a colour
   palette, a silhouette strip and a spec table. Everything on it is a
   printed asset, so this script prints them again as vectors: two files per
   champion, drawn from that champion's own palette.

       assets/champions/<id>-crest.svg     the heraldic mark
       assets/champions/<id>-weapon.svg    the weapon glyph

   It reads the real registry (js/characters.js) rather than duplicating it,
   so an asset can never describe a champion the game does not have.

       node scripts/make-champion-assets.js
------------------------------------------------------------------- */

'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'assets', 'champions')

const STEEL = '#cfd6e0'
const INK = '#0b0d12'

/* ---- the registry, loaded exactly as the browser loads it ---- */
function loadCharacters() {
  const sandbox = {
    console, Math, JSON, Set, Map, Object, Array, String, Number, Boolean,
    RegExp, Error, isNaN, isFinite, parseInt, parseFloat,
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    Image: function () {}, localStorage: { getItem: () => null, setItem() {} }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.createContext(sandbox)
  for (const f of ['js/utils.js', 'js/config.js', 'js/prompt-parser.js', 'js/characters.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f })
  }
  return vm.runInContext('CHARACTERS', sandbox)
}

/* ---- weapon glyphs -------------------------------------------------
   viewBox 0 0 120 64. {S} steel, {A} the champion's accent, {D} a dark
   shade of it. One entry per weapon in the registry; a champion naming a
   weapon that is not here is a build error, not a silent fallback.
------------------------------------------------------------------- */

const WEAPONS = {
  sai: `
    <rect x="10" y="29" width="22" height="6" rx="3" fill="{S}"/>
    <rect x="30" y="21" width="7" height="22" rx="3" fill="{S}"/>
    <path d="M37 28 L100 26 L114 32 L100 38 L37 36 Z" fill="{S}"/>
    <path d="M44 26 q16 -12 14 6" fill="none" stroke="{S}" stroke-width="3.4"/>
    <path d="M44 38 q16 12 14 -6" fill="none" stroke="{S}" stroke-width="3.4"/>`,
  steel_sword: `
    <circle cx="12" cy="32" r="6" fill="{A}"/>
    <rect x="18" y="29" width="18" height="6" rx="3" fill="{S}"/>
    <rect x="34" y="19" width="7" height="26" rx="2" fill="{A}"/>
    <path d="M41 27 L104 30 L116 32 L104 34 L41 37 Z" fill="{S}"/>`,
  rapier: `
    <rect x="12" y="30" width="18" height="4" rx="2" fill="{S}"/>
    <circle cx="34" cy="32" r="10" fill="none" stroke="{A}" stroke-width="3"/>
    <path d="M34 32 q8 -12 16 -8" fill="none" stroke="{A}" stroke-width="2.4"/>
    <path d="M44 30 L112 31.4 L112 32.6 L44 34 Z" fill="{S}"/>`,
  scythe: `
    <path d="M26 8 L98 58" stroke="{S}" stroke-width="5" stroke-linecap="round"/>
    <path d="M98 58 q-10 -34 -38 -40 q26 14 30 40 z" fill="{A}"/>
    <circle cx="26" cy="8" r="4" fill="{A}"/>`,
  twin_daggers: `
    <rect x="10" y="14" width="16" height="5" rx="2" fill="{S}"/>
    <path d="M26 12 L76 14 L88 16.5 L76 19 L26 21 Z" fill="{S}"/>
    <rect x="18" y="46" width="16" height="5" rx="2" fill="{S}"/>
    <path d="M34 44 L84 45 L96 47.5 L84 50 L34 51 Z" fill="{A}"/>`,
  sunspear: `
    <rect x="8" y="30" width="82" height="4" rx="2" fill="{S}"/>
    <path d="M90 20 q24 12 24 12 q-24 12 -24 12 z" fill="{A}"/>
    <circle cx="20" cy="32" r="11" fill="none" stroke="{A}" stroke-width="2.6"/>
    <path d="M20 23 v18 M11 32 h18" stroke="{A}" stroke-width="2"/>`,
  shield_hammer: `
    <path d="M12 12 h30 v40 h-30 z" fill="none" stroke="{A}" stroke-width="3"/>
    <path d="M16 32 L27 20 L38 32" fill="none" stroke="{A}" stroke-width="3"/>
    <rect x="50" y="29" width="46" height="6" rx="3" fill="{S}"/>
    <rect x="92" y="16" width="20" height="32" rx="3" fill="{S}"/>
    <rect x="92" y="16" width="20" height="32" rx="3" fill="none" stroke="{A}" stroke-width="2.4"/>`,
  claws: `
    <path d="M18 12 q44 2 60 14" fill="none" stroke="{S}" stroke-width="5" stroke-linecap="round"/>
    <path d="M18 32 q50 0 66 0" fill="none" stroke="{S}" stroke-width="5" stroke-linecap="round"/>
    <path d="M18 52 q44 -2 60 -14" fill="none" stroke="{S}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="18" cy="12" r="4" fill="{A}"/><circle cx="18" cy="32" r="4" fill="{A}"/>
    <circle cx="18" cy="52" r="4" fill="{A}"/>`,
  vine_whip: `
    <path d="M10 32 q14 -22 30 -8 q16 14 30 -6 q12 -18 26 -4" fill="none"
          stroke="{A}" stroke-width="4.4" stroke-linecap="round"/>
    <path d="M22 22 l6 7 -8 1 z" fill="{A}"/>
    <path d="M46 38 l7 -7 2 8 z" fill="{A}"/>
    <path d="M70 22 l7 7 -8 1 z" fill="{A}"/>
    <path d="M10 32 h-4" stroke="{A}" stroke-width="4" stroke-linecap="round"/>`,
  frost_glaive: `
    <rect x="8" y="30" width="60" height="4" rx="2" fill="{S}"/>
    <path d="M66 6 Q100 20 106 32 Q100 44 66 58 Q80 32 66 6 Z" fill="{A}"/>
    <path d="M66 6 Q80 32 66 58" fill="none" stroke="{S}" stroke-width="2.4"/>
    <circle cx="16" cy="32" r="5" fill="{A}"/>
    <path d="M78 24 l5 8 -6 0 z" fill="{S}"/>`,
  phase_blades: `
    <path d="M14 20 L84 14 L96 20 L84 26 L14 32 Z" fill="{A}" opacity=".85"/>
    <path d="M26 44 L96 38 L108 44 L96 50 L26 56 Z" fill="{S}" opacity=".85"/>
    <path d="M14 20 L84 14" stroke="{A}" stroke-width="2"/>
    <path d="M26 56 L96 50" stroke="{S}" stroke-width="2"/>`,
  star_cannon: `
    <rect x="10" y="25" width="52" height="14" rx="4" fill="{S}"/>
    <rect x="10" y="25" width="52" height="14" rx="4" fill="none" stroke="{A}" stroke-width="2.2"/>
    <circle cx="70" cy="32" r="13" fill="none" stroke="{S}" stroke-width="3"/>
    <circle cx="98" cy="32" r="15" fill="{A}"/>
    <circle cx="98" cy="32" r="6" fill="#ffffff" opacity=".9"/>`,
  chain_lightning: `
    <path d="M8 30 L30 30 L38 16 L50 44 L60 24 L70 34 L94 34 L112 32" fill="none"
          stroke="{A}" stroke-width="4.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="30" cy="30" r="4.5" fill="{S}"/>
    <circle cx="70" cy="34" r="4.5" fill="{S}"/>
    <circle cx="112" cy="32" r="4.5" fill="{S}"/>`,
  tower_shield_sword: `
    <path d="M12 10 h28 v44 h-28 z" fill="none" stroke="{A}" stroke-width="3"/>
    <path d="M16 32 L26 21 L36 32" fill="none" stroke="{A}" stroke-width="3"/>
    <path d="M46 28 L106 30 L118 32 L106 34 L46 36 Z" fill="{S}"/>
    <rect x="44" y="21" width="6" height="22" rx="2" fill="{A}"/>`,
  halo_glaive: `
    <circle cx="18" cy="32" r="13" fill="none" stroke="{A}" stroke-width="2.6"/>
    <path d="M18 22 v20 M8 32 h20" stroke="{A}" stroke-width="1.8"/>
    <rect x="30" y="30" width="42" height="4" rx="2" fill="{S}"/>
    <path d="M70 8 Q104 20 110 32 Q104 44 70 56 Q84 32 70 8 Z" fill="{A}"/>
    <path d="M70 8 Q84 32 70 56" fill="none" stroke="{S}" stroke-width="2.2"/>`,
  void_glaive: `
    <rect x="8" y="30" width="62" height="4" rx="2" fill="{S}"/>
    <circle cx="14" cy="32" r="5" fill="{A}"/>
    <path d="M68 4 Q104 20 110 32 Q104 44 68 60 Q84 32 68 4 Z" fill="{A}"/>
    <path d="M68 4 Q84 32 68 60" fill="none" stroke="{S}" stroke-width="2.2"/>
    <path d="M56 20 l12 5 -12 5 z" fill="{A}"/>
    <circle cx="88" cy="32" r="4" fill="{S}"/>`,
  maul: `
    <rect x="8" y="30" width="66" height="5" rx="2.5" fill="{S}"/>
    <circle cx="10" cy="32.5" r="5" fill="{A}"/>
    <rect x="72" y="12" width="34" height="40" rx="5" fill="{S}"/>
    <rect x="72" y="12" width="34" height="40" rx="5" fill="none" stroke="{A}" stroke-width="2.6"/>
    <path d="M80 22 h18 M80 32 h18 M80 42 h18" stroke="{A}" stroke-width="2.4"/>`,
  longsword: `
    <circle cx="12" cy="32" r="6" fill="{A}"/>
    <rect x="18" y="29" width="18" height="6" rx="3" fill="{S}"/>
    <rect x="34" y="18" width="7" height="28" rx="2" fill="{A}"/>
    <path d="M41 27 L106 30 L118 32 L106 34 L41 37 Z" fill="{S}"/>`
}

/* which glyph belongs to which champion, by the weapon wording on the sheet */
function glyphFor(c) {
  const w = (c.weapons || '').toLowerCase()
  if (w.indexOf('sai') >= 0) return 'sai'
  if (w.indexOf('silver sword') >= 0 || w.indexOf('steel sword') >= 0) return 'steel_sword'
  if (w.indexOf('rapier') >= 0) return 'rapier'
  if (w.indexOf('scythe') >= 0) return 'scythe'
  if (w.indexOf('dagger') >= 0) return 'twin_daggers'
  if (w.indexOf('sunspear') >= 0) return 'sunspear'
  if (w.indexOf('warhammer') >= 0) return 'shield_hammer'
  if (w.indexOf('claw') >= 0) return 'claws'
  if (w.indexOf('vine') >= 0) return 'vine_whip'
  if (w.indexOf('halo') >= 0) return 'halo_glaive'
  if (w.indexOf('maul') >= 0) return 'maul'
  if (w.indexOf('void glaive') >= 0) return 'void_glaive'
  if (w.indexOf('glaive') >= 0) return 'frost_glaive'
  if (w.indexOf('phase') >= 0) return 'phase_blades'
  if (w.indexOf('cannon') >= 0) return 'star_cannon'
  if (w.indexOf('lightning') >= 0) return 'chain_lightning'
  if (w.indexOf('broadsword') >= 0) return 'tower_shield_sword'
  if (w.indexOf('sword') >= 0) return 'longsword'
  return null
}

/* ---- heraldic crest -------------------------------------------------
   An accent shield with the chevron knocked out of it - the same mark as
   the site's logo and favicon, so every champion wears the house sign.
------------------------------------------------------------------- */
function crestSVG(c) {
  const a = c.accent
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${c.name} crest">
  <path d="M32 3 L59 14 V34 C59 48 47 57 32 61 C17 57 5 48 5 34 V14 Z" fill="${a}"/>
  <path d="M17 22 L32 47 L47 22" fill="none" stroke="${INK}" stroke-width="6.5" stroke-linejoin="miter"/>
</svg>
`
}

function weaponSVG(c, key) {
  const body = WEAPONS[key].replace(/\{S\}/g, STEEL).replace(/\{A\}/g, c.accent)
    .replace(/\{D\}/g, INK)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 64" role="img" aria-label="${c.weapons}">
${body.trim()}
</svg>
`
}

/* ---- run ---- */

const champions = loadCharacters()
fs.mkdirSync(OUT, { recursive: true })

let written = 0
const problems = []

for (const c of champions) {
  const key = glyphFor(c)
  if (!key) { problems.push(c.id + ': no weapon glyph for "' + c.weapons + '"'); continue }
  fs.writeFileSync(path.join(OUT, c.id + '-crest.svg'), crestSVG(c))
  fs.writeFileSync(path.join(OUT, c.id + '-weapon.svg'), weaponSVG(c, key))
  written += 2
}

console.log('wrote ' + written + ' files to assets/champions/ for ' + champions.length + ' champions')
console.log('weapon glyphs: ' + champions.map((c) => c.id + '=' + glyphFor(c)).join(' '))
if (problems.length) {
  console.error('\nPROBLEMS:')
  problems.forEach((p) => console.error('  ' + p))
  process.exit(1)
}
