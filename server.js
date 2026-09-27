#!/usr/bin/env node
/* ------------------------------------------------------------------
   server.js - static file server + Gemini proxy for the arena.

   Two jobs, one process, zero dependencies (node's own http/fs only), so
   there is no `npm install` standing between a cold laptop and a demo:

     GET  /*             -> static files from the repo root (the same thing
                            `python -m http.server` did)
     POST /api/analyze   -> { prompt } -> { stats, archetype, tagline, ... }
     GET  /api/health    -> how many keys and models this process has

   The API keys live in .env and never leave this process - the browser
   talks to us, we talk to Google. Shipping them to the client would put
   eight working keys into the page source on the projector.

   If this server is not running, the front end falls back to the local
   lexicon parser and the demo proceeds exactly as it did before. Nothing
   here is on the critical path; it only ever upgrades the result.
------------------------------------------------------------------- */

'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const url = require('url')
const os = require('os')

const ROOT = __dirname
const PORT = Number(process.env.PORT || 8080)

/* ---------------- .env ---------------- */

/* Deliberately minimal: KEY=VALUE, # comments, blank lines, and a matched
   pair of quotes stripped - that is all the file has. An already-set
   process env wins, so `GEMINI_API_KEY_1=x node server.js` still works. */
function loadEnv(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return
  }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq < 1) continue
    const k = s.slice(0, eq).trim()
    let v = s.slice(eq + 1).trim()
    const quoted = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    if (quoted && v.length > 1) v = v.slice(1, -1)
    if (!(k in process.env)) process.env[k] = v
  }
}

loadEnv(path.join(ROOT, '.env'))

/* GEMINI_API_KEY_1 .. GEMINI_API_KEY_8 - the loop just keeps reading until
   the numbers run out, so adding a ninth key needs no code change. A bare
   GEMINI_API_KEY is accepted too, for a single-key setup. */
function loadKeys() {
  const found = []
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    found.push({ id: 'GEMINI_API_KEY', key: process.env.GEMINI_API_KEY.trim() })
  }
  for (let i = 1; i <= 64; i++) {
    const v = process.env['GEMINI_API_KEY_' + i]
    if (v && v.trim()) found.push({ id: 'GEMINI_API_KEY_' + i, key: v.trim() })
  }
  return found.map((k, i) => ({ id: k.id, key: k.key, n: i, cooldownUntil: 0, ok: 0, fail: 0 }))
}

const { ethers } = require('ethers')
const { Arbiter } = require('./arbiter')
Arbiter.init()

const KEYS = loadKeys()

/* Verified against these keys. gemini-3.6-flash answers in ~2.1s, which is
   the only reason the analyze screen can afford to wait for it at all; the
   other two are here because during testing roughly one call in four came
   back 503 "high demand", and a 503 must not become a 503 for the player. */
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']

const ATTEMPT_TIMEOUT_MS = 5000   // one call to Google
const TOTAL_BUDGET_MS = 12000     // every retry for one player, combined
const KEY_COOLDOWN_MS = 30000     // after a 429, leave that key alone a while

/* ---------------- the prompt ---------------- */

const SYSTEM = [
  'You are the stat engine for an arcade fighting game. A player types a plain-English',
  'strategy for their fighter; you turn it into numbers.',
  '',
  'Return three stats, each 0.05 to 0.95:',
  '  aggression - how much they press, attack, and take trades.',
  '  defense    - how much they block, counter, absorb, and play safe.',
  '  speed      - how much they dash, dodge, evade, and reposition.',
  '',
  'HARD RULE - the three stats must add up to between 1.30 and 1.95. They are a',
  'budget, not a rating. A prompt that asks for everything gets a fighter that is',
  'good at nothing in particular; every strategy must give something up. Never',
  'return three high stats.',
  '',
  'Read intent, not keywords. "I would rather run than trade hits" is low aggression',
  'and high speed even though it never says the word "fast". Honour negations ("never',
  'block" is LOW defense) and intensifiers ("extremely patient" is very high defense).',
  'Judge the whole sentence, including sarcasm and bluff.',
  '',
  'If the prompt is nonsense, off-topic, or not a strategy at all (song lyrics, a',
  'recipe, keyboard mash), do not refuse and do not return neutral stats - invent a',
  'characterful fighter that suits the vibe of the words, and set improvised true.',
  '',
  'archetype: 1-2 words, UPPERCASE, max 18 characters, naming this fighter (GLASS',
  '  CANNON, IRON WALL, PHANTOM). It is minted onto an NFT card - letters and single',
  '  spaces only, no quotes or punctuation.',
  'tagline: one line, max 48 characters, in the voice of an arcade attract screen.',
  'traits: 2 to 4 short lowercase phrases (1-2 words) naming what you actually read in',
  '  the prompt - the player is shown these as your reasoning.',
  'Never mention that you are an AI or a language model.'
].join('\n')

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    aggression: { type: 'NUMBER' },
    defense: { type: 'NUMBER' },
    speed: { type: 'NUMBER' },
    archetype: { type: 'STRING' },
    tagline: { type: 'STRING' },
    traits: { type: 'ARRAY', items: { type: 'STRING' } },
    improvised: { type: 'BOOLEAN' }
  },
  required: ['aggression', 'defense', 'speed', 'archetype', 'tagline', 'traits']
}

/* The three prompt-driven games want the same three numbers read slightly
   differently - "aggressive" on a desk means a hard flick, not a combo. */
const MODE_CONTEXT = {
  fighter: 'The game is a 1v1 arcade duel: two fighters, one health bar each, 25 seconds.',
  pen: 'The game is Pen Fight: two pens on a desk, each player flicks their pen to knock the ' +
       'other one off the edge. aggression is flick power, defense is holding good position near ' +
       'the centre, speed is turn rate and how often they flick.',
  /* The racer is the odd one: the prompt builds a machine rather than a
     temperament, and there is nobody to fight. Said plainly here, because
     left to the fighter context the model reads "reckless" as a brawler
     trait and returns numbers that mean nothing to a ship. */
  hex: 'The game is a solo time trial on a futuristic racing track, and the prompt describes ' +
       'the ship the player will fly rather than a fighter. aggression is throttle discipline: ' +
       'raw acceleration, how hard the booster is used, and how willing the pilot is to trade ' +
       'paint with a wall. defense is the hull: shield strength and how well the ship holds its ' +
       'speed through a collision. speed is top speed. The three trade off against each other - ' +
       'a ship described as all-out fast should score high speed and low defense.'
}

function buildBody(prompt, mode) {
  const context = MODE_CONTEXT[mode] || MODE_CONTEXT.fighter
  return JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM + '\n\n' + context }] },
    contents: [{
      role: 'user',
      parts: [{ text: 'Fighter strategy prompt:\n"""\n' + prompt + '\n"""\n\nRate this fighter.' }]
    }],
    generationConfig: {
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      /* These models think by default, which took the same request from
         ~2s to 7-12s - far past anything a player will sit through. */
      thinkingConfig: { thinkingLevel: 'low' }
    },
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
  })
}

/* ==================================================================
   JEV - the tactical advisor.

   ONE call per agent per match, answered before the bell and CACHED by
   (matchId, side). That cache is not an optimisation, it is the correctness
   argument: both players' browsers and every spectator ask the same
   question, and they must all receive the same bytes or their simulations
   diverge and two screens crown different winners.

   JEV is asked for a PLAYBOOK, not a move. It reads two public strategies
   against each other and says which tactical intent to hold in each phase of
   the fight and how to react to falling behind or being read. The
   deterministic engine does everything else - see js/jev.js for why a call
   per frame is the wrong shape entirely.
================================================================== */

const JEV_ACTIONS = ['RUSH', 'ZONE', 'BAIT', 'HUNT', 'TURTLE']

const JEV_SYSTEM = [
  'You are JEV, a tactical advisor for a 2D fighting game.',
  'You are given two fighters, each with a PUBLIC strategy prompt and stats',
  'in 0..1 for aggression, defense and speed.',
  '',
  'You advise ONE fighter (the "self"). You do not control movement, attacks,',
  'timing or positioning - a deterministic engine does all of that. You choose',
  'only the TACTICAL INTENT the fighter holds in each situation.',
  '',
  'The five intents:',
  '  RUSH   close the distance and pressure relentlessly. Wins against passive',
  '         opponents and against anyone low on health. Loses to good punishers.',
  '  ZONE   hold mid range and control space. Safe, patient, good when ahead.',
  '  BAIT   provoke a committal attack and punish the recovery. Strong against',
  '         aggressive opponents, weak against patient ones.',
  '  HUNT   stalk and strike into mistakes. Strong against opponents who whiff.',
  '  TURTLE defend and survive. Only sensible when badly hurt or very defensive.',
  '',
  'Advise the self fighter to BEAT the specific opponent described, honouring',
  'the self fighter and its own stated strategy. A defensive prompt should not be',
  'handed an all-RUSH playbook; work within its character.',
  '',
  'Return the intent for each fight phase and each reaction.'
].join('\n')

const JEV_SCHEMA = {
  type: 'OBJECT',
  properties: {
    opening: { type: 'STRING', enum: JEV_ACTIONS },
    mid: { type: 'STRING', enum: JEV_ACTIONS },
    late: { type: 'STRING', enum: JEV_ACTIONS },
    suddenDeath: { type: 'STRING', enum: JEV_ACTIONS },
    behind: { type: 'STRING', enum: JEV_ACTIONS },
    ahead: { type: 'STRING', enum: JEV_ACTIONS },
    readBeaten: { type: 'STRING', enum: JEV_ACTIONS },
    readWinning: { type: 'STRING', enum: JEV_ACTIONS },
    note: { type: 'STRING' }
  },
  required: ['opening', 'mid', 'late', 'suddenDeath', 'behind', 'ahead', 'readBeaten', 'readWinning']
}

const jevCache = new Map()      // matchId|side -> shaped playbook
const JEV_CACHE_MAX = 400

function jevBody(req) {
  const describe = (f, label) => [
    label + ':',
    '  name: ' + String(f.name || 'Fighter'),
    '  strategy: "' + String(f.prompt || '').slice(0, 280) + '"',
    '  archetype: ' + String(f.archetype || 'unknown'),
    '  stats: aggression ' + num(f.stats && f.stats.aggression) +
      ', defense ' + num(f.stats && f.stats.defense) +
      ', speed ' + num(f.stats && f.stats.speed)
  ].join('\n')

  const text = [
    describe(req.self, 'SELF (advise this one)'),
    '',
    describe(req.opponent, 'OPPONENT'),
    '',
    'Give SELF a playbook that beats OPPONENT.'
  ].join('\n')

  return JSON.stringify({
    systemInstruction: { parts: [{ text: JEV_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: {
      /* Zero temperature: the playbook has to be reproducible enough that
         re-running it is a sane thing to do, and this is a tactical read,
         not a creative one. */
      temperature: 0,
      topP: 1,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
      responseSchema: JEV_SCHEMA,
      thinkingConfig: { thinkingLevel: 'low' }
    },
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
  })
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(clamp01(n) * 100) / 100 : 0.35
}

/* An intent the engine does not have would fall through to `undefined` in
   PLANS and take out tier 2 mid-fight. Everything is checked against the
   action list, and anything unrecognised becomes a sane default. */
function shapePlaybook(raw) {
  const ok = (v, fb) => (JEV_ACTIONS.indexOf(String(v).toUpperCase()) >= 0 ? String(v).toUpperCase() : fb)
  return {
    opening: ok(raw.opening, 'ZONE'),
    mid: ok(raw.mid, 'HUNT'),
    late: ok(raw.late, 'RUSH'),
    suddenDeath: ok(raw.suddenDeath, 'RUSH'),
    behind: ok(raw.behind, 'RUSH'),
    ahead: ok(raw.ahead, 'ZONE'),
    readBeaten: ok(raw.readBeaten, 'BAIT'),
    readWinning: ok(raw.readWinning, 'RUSH'),
    note: cleanLine(raw.note, 160)
  }
}

async function jevDecide(req) {
  const cacheKey = String(req.matchId) + '|' + String(req.side)
  if (jevCache.has(cacheKey)) {
    return Object.assign({}, jevCache.get(cacheKey), { cached: true })
  }
  if (!KEYS.length) {
    const e = new Error('no GEMINI_API_KEY_n in .env')
    e.noKeys = true
    throw e
  }

  const body = jevBody(req)
  const tried = []
  const state = { done: false }

  for (const model of MODELS) {
    const keys = pickKeys()
    if (!keys.length) break
    const first = attemptJev(model, keys[0], body, tried)
    const wave = [first]
    if (keys[1]) wave.push(hedgeAfter(HEDGE_AFTER_MS, state, first, () => attemptJev(model, keys[1], body, tried)))

    const r = await firstSuccess(wave, state)
    if (r && r.out) {
      const out = {
        ok: true,
        playbook: r.out.playbook,
        note: r.out.playbook.note,
        model: 'jev/' + (req.jevVersion || '1') + '/' + r.out.model,
        modelVersion: r.out.model,
        cached: false
      }
      jevCache.set(cacheKey, out)
      if (jevCache.size > JEV_CACHE_MAX) jevCache.delete(jevCache.keys().next().value)
      return out
    }
  }

  const err = new Error('every JEV attempt failed')
  err.tried = tried
  throw err
}

async function attemptJev(model, keyRec, body, tried) {
  const res = await callGemini(model, keyRec, body)
  tried.push(model + '#' + keyRec.n + ':' + (res.status || res.error))

  if (res.status === 200) {
    let payload = null
    try { payload = JSON.parse(res.data) } catch (e) { payload = null }
    const text = extractText(payload)
    let parsed = null
    if (text) {
      try { parsed = JSON.parse(text) } catch (e) {
        const m = text.match(/\{[\s\S]*\}/)
        if (m) { try { parsed = JSON.parse(m[0]) } catch (e2) { parsed = null } }
      }
    }
    if (parsed) {
      keyRec.ok++
      return { out: { playbook: shapePlaybook(parsed), model: model } }
    }
    keyRec.fail++
    return { error: 'unparseable response' }
  }

  keyRec.fail++
  if (res.status === 429) {
    keyRec.cooldownUntil = Date.now() + KEY_COOLDOWN_MS
    return { error: 'rate limited' }
  }
  return { error: res.status ? 'http ' + res.status : (res.error || 'network error') }
}

/* ==================================================================
   Readiness

   Cached, because /api/ready makes RPC calls and a dashboard left open on it
   should not hammer a public endpoint. 30 seconds is long enough to protect
   the RPC and short enough that a fix shows up while you are still looking
   at the screen.
================================================================== */

const VERSION = '2.0.0'
const READY_TTL_MS = 30000
let readyCache = { at: 0, value: null }

const READY_ABI = [
  'function arbiter() view returns (address)',
  'function owner() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function nextMatchId() view returns (uint256)',
  'function fighterNFT() view returns (address)'
]

async function readiness(fresh) {
  if (!fresh && readyCache.value && Date.now() - readyCache.at < READY_TTL_MS) {
    return Object.assign({}, readyCache.value, { cached: true })
  }

  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  add('gemini', KEYS.length > 0,
    KEYS.length ? KEYS.length + ' key(s) loaded' : 'no GEMINI_API_KEY_n - JEV falls back to the local planner')

  add('arbiter key', Arbiter.enabled(),
    Arbiter.enabled() ? Arbiter.address() : 'no ARBITER_PRIVATE_KEY - cannot sign or start matches')

  const arenaAddress = process.env.ARENA_ADDRESS || deployedArena()
  add('arena address', !!arenaAddress, arenaAddress || 'unknown - set ARENA_ADDRESS or commit contracts/deployments.10143.json')

  /* Everything past here needs the chain. A failure is reported as a failed
     CHECK rather than thrown, so one unreachable RPC does not hide the
     answers that were already known. */
  if (Arbiter.enabled() && arenaAddress) {
    try {
      const rpc = process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz'
      const provider = new ethers.JsonRpcProvider(rpc)
      const arena = new ethers.Contract(arenaAddress, READY_ABI, provider)

      const [onChainArbiter, owner, feeBps, nextId, nft, balance] = await Promise.all([
        arena.arbiter(), arena.owner(), arena.feeBps(), arena.nextMatchId(),
        arena.fighterNFT(), provider.getBalance(Arbiter.address())
      ])

      add('rpc', true, rpc)

      const matches = onChainArbiter.toLowerCase() === Arbiter.address().toLowerCase()
      add('arbiter matches contract', matches, matches
        ? 'this server can sign settlements'
        : 'contract expects ' + onChainArbiter + ' but this server signs with ' +
          Arbiter.address() + ' - every settlement would revert')

      /* Three transactions per match. A tenth of a MON is a handful of
         matches; flagging it early beats discovering it when a market is
         already open and cannot be started. */
      const gas = Number(ethers.formatEther(balance))
      add('arbiter gas', gas > 0.05,
        ethers.formatEther(balance) + ' MON' + (gas > 0.05 ? '' : ' - too low, needs ~3 tx per match'))

      const separate = owner.toLowerCase() !== Arbiter.address().toLowerCase()
      add('owner separate from arbiter', separate, separate
        ? 'owner is ' + owner
        : 'the arbiter key is ALSO the owner - this process can withdraw fees and pause the contract')

      add('nft wired', nft && !/^0x0{40}$/i.test(nft), nft)
      add('fee', Number(feeBps) === 500, Number(feeBps) / 100 + '%')
      add('matches created', true, (Number(nextId) - 1) + ' so far')
    } catch (e) {
      add('rpc', false, e.shortMessage || e.message)
    }
  }

  const value = {
    ready: checks.every((c) => c.ok),
    version: VERSION,
    /* The distinction that matters when this says ready:false - a server
       that cannot settle is still perfectly able to run fights and rooms. */
    canSettle: checks.filter((c) => ['arbiter key', 'arbiter matches contract', 'arbiter gas', 'rpc']
      .indexOf(c.name) > -1).every((c) => c.ok),
    checks: checks,
    cached: false,
    checkedAt: new Date().toISOString()
  }

  readyCache = { at: Date.now(), value: value }
  return value
}

/* The address the deploy script last wrote. Committing that file is what
   lets a hosted instance know its own contracts without another env var. */
function deployedArena() {
  try {
    const f = path.join(ROOT, 'contracts', 'deployments.10143.json')
    if (!fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf8')).arenaAddress || null
  } catch (e) {
    return null
  }
}

/* ---------------- key selection ---------------- */

/* Random order, not round-robin, as asked: with eight keys two browsers
   firing at the same instant rarely land on the same one, and a key that is
   rate-limited drops out of the pool until its cooldown expires. */
function pickKeys() {
  const now = Date.now()
  const live = KEYS.filter((k) => k.cooldownUntil < now)
  const pool = (live.length ? live : KEYS).slice()
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp
  }
  return pool
}

/* ---------------- one call to Google ---------------- */

function callGemini(model, keyRec, body) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/' + model + ':generateContent',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-goog-api-key': keyRec.key
      }
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, data: data }))
    })
    req.setTimeout(ATTEMPT_TIMEOUT_MS, () => {
      req.destroy()
      resolve({ status: 0, data: '', error: 'timeout' })
    })
    req.on('error', (e) => resolve({ status: 0, data: '', error: e.message }))
    req.write(body)
    req.end()
  })
}

function extractText(payload) {
  const parts = payload
    && payload.candidates
    && payload.candidates[0]
    && payload.candidates[0].content
    && payload.candidates[0].content.parts
  if (!Array.isArray(parts)) return null
  const text = parts.map((p) => p.text || '').join('').trim()
  return text || null
}

/* ---------------- shaping the answer ---------------- */

const isNum = (v) => typeof v === 'number' && isFinite(v)
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const round2 = (v) => Math.round(v * 100) / 100

/* The model is told the budget and mostly respects it, but "mostly" is not
   a balance guarantee - one 0.9/0.9/0.9 fighter slipping through simply
   beats everything, and then the prompt stops mattering, which is the whole
   demo. The browser re-applies this too; belt and braces. */
function budget(stats) {
  const s = {
    aggression: clamp01(isNum(stats.aggression) ? stats.aggression : 0.35),
    defense: clamp01(isNum(stats.defense) ? stats.defense : 0.35),
    speed: clamp01(isNum(stats.speed) ? stats.speed : 0.35)
  }
  const total = s.aggression + s.defense + s.speed
  if (total > 1.95) {
    const k = 1.95 / total
    for (const x in s) s[x] = clamp01(s[x] * k)
  } else if (total < 0.95 && total > 0) {
    const k = 0.95 / total
    for (const x in s) s[x] = clamp01(s[x] * k)
  }
  for (const x in s) s[x] = round2(s[x])
  return s
}

/* Goes straight onto an on-chain SVG card, so: letters, digits and single
   spaces, nothing else. */
function cleanArchetype(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 18).trim() : ''
}

function cleanLine(s, max) {
  return String(s || '').replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function shape(raw) {
  return {
    stats: budget(raw),
    archetype: cleanArchetype(raw.archetype),
    tagline: cleanLine(raw.tagline, 60),
    traits: (Array.isArray(raw.traits) ? raw.traits : [])
      .map((t) => cleanLine(t, 22).toLowerCase())
      .filter(Boolean)
      .slice(0, 4),
    improvised: !!raw.improvised
  }
}

/* ---------------- retry across keys, then models ---------------- */

const cache = new Map()   // normalised prompt -> shaped result
const CACHE_MAX = 400

/* One call, fully interpreted: a usable fighter, or null plus the reason. */
async function attempt(model, keyRec, body, tried) {
  const res = await callGemini(model, keyRec, body)
  tried.push(model + '#' + keyRec.n + ':' + (res.status || res.error))

  if (res.status === 200) {
    let payload = null
    try { payload = JSON.parse(res.data) } catch (e) { payload = null }
    const text = extractText(payload)
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        /* responseSchema makes this rare, but a fenced ```json block would
           otherwise throw away a perfectly good answer. */
        const m = text.match(/\{[\s\S]*\}/)
        if (m) { try { parsed = JSON.parse(m[0]) } catch (e2) { parsed = null } }
      }
    }
    if (parsed) {
      keyRec.ok++
      return { out: Object.assign(shape(parsed), { model: model, key: keyRec.id }) }
    }
    keyRec.fail++
    return { error: 'unparseable response' }
  }

  keyRec.fail++
  if (res.status === 429) {
    keyRec.cooldownUntil = Date.now() + KEY_COOLDOWN_MS
    return { error: 'rate limited' }
  }
  if (res.status === 404) {
    /* This project cannot see the model at all; another key will not
       conjure it back, so the whole model is done. */
    return { error: 'model unavailable', deadModel: true }
  }
  return { error: res.status ? 'http ' + res.status : (res.error || 'network error') }
}

/* Resolves the moment any attempt returns a usable fighter; only waits for
   the whole wave if every one of them failed.

   Promise.race is wrong here and Promise.all is worse. race settles on the
   first promise to finish either way, so a key that 429s in 300ms would
   beat a key about to return a perfect fighter in 2s. all makes the wave as
   slow as its slowest member, which is the exact opposite of the point. */
function firstSuccess(promises, state) {
  return new Promise((resolve) => {
    let pending = promises.length
    const failures = []
    promises.forEach((p) => p.then((r) => {
      if (r && r.out) {
        if (state) state.done = true    // stops any hedge that has not fired yet
        return resolve(r)
      }
      failures.push(r)
      if (--pending === 0) resolve({ failures: failures })
    }))
  })
}

/* The hedge fires on whichever comes first: the timer, or the first call
   coming back unusable - there is no reason to sit out the rest of a timer
   once the answer it was insuring against has already failed. If the first
   call succeeds instead, the hedge is never sent at all, which is what
   keeps this close to one request per fighter. */
function hedgeAfter(ms, state, first, fn) {
  return new Promise((resolve) => {
    let fired = false
    const go = () => {
      if (fired) return
      fired = true
      if (state.done) return resolve({ error: 'not needed' })
      fn().then(resolve)
    }
    const timer = setTimeout(go, ms)
    first.then((r) => {
      if (!r || !r.out) { clearTimeout(timer); go() }
    })
  })
}

/* A DEFERRED hedge, which is the whole reason eight keys are worth having.

   Sequential retry fixes errors but not slowness, and both are real: the
   median call comes back in ~2.2s, but roughly one in eight takes 7s+ on a
   perfectly healthy key, and the player gives up at 6.5s. So a second key
   is sent - but only once the first has already taken HEDGE_AFTER_MS, by
   which point it is a bad draw rather than a normal one. The first usable
   answer wins and the other is discarded.

   Firing both immediately was measurably worse. These are rate-limited
   keys; under load 429 was by far the most common failure, and hedging
   every request doubles the request volume that causes it. Hedging only the
   slow quarter keeps the tail short without feeding the problem. */
const HEDGE = 2
const HEDGE_AFTER_MS = 2800

async function analyze(prompt, mode) {
  const cacheKey = (mode || 'fighter') + '|' + prompt.trim().toLowerCase().replace(/\s+/g, ' ')
  if (cache.has(cacheKey)) {
    const hit = cache.get(cacheKey)
    return Object.assign({}, hit, { cached: true, ms: 0 })
  }

  const body = buildBody(prompt, mode)
  const started = Date.now()
  const tried = []
  let lastError = 'no attempt made'

  for (const model of MODELS) {
    const keys = pickKeys()
    let deadModel = false
    let rateLimited = 0

    for (let i = 0; i < keys.length && !deadModel; i += HEDGE) {
      if (Date.now() - started > TOTAL_BUDGET_MS) { lastError = 'out of time budget'; break }
      /* Two full waves of nothing but 429 means this model's quota is gone
         right now, not that these particular keys are unlucky. Grinding
         through the remaining four keys to collect four more 429s costs
         seconds the analyze screen does not have - another model is the
         better bet, and its quota is counted separately. */
      if (rateLimited >= 2 * HEDGE) { lastError = 'rate limited'; break }
      const wave = keys.slice(i, i + HEDGE)

      const state = { done: false }
      const lead = attempt(model, wave[0], body, tried)
      const calls = [lead].concat(wave.slice(1).map((k) =>
        hedgeAfter(HEDGE_AFTER_MS, state, lead, () => attempt(model, k, body, tried))))
      const won = await firstSuccess(calls, state)

      if (won.out) {
        const out = Object.assign(won.out, { ms: Date.now() - started, tried: tried })
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
        cache.set(cacheKey, out)
        return out
      }
      for (const r of (won.failures || [])) {
        if (!r) continue
        if (r.error) lastError = r.error
        if (r.error === 'rate limited') rateLimited++
        if (r.deadModel) deadModel = true
      }
    }
  }

  const err = new Error(lastError)
  err.tried = tried
  throw err
}

/* ---------------- http ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      data += c
      if (data.length > limit) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/* The entire point of proxying through this process is that the keys stay
   inside it - and a static server rooted one directory above .env undoes
   that in a single GET. Blocked per path SEGMENT after normalisation, so
   /.env, /../.env, /%2e%2e/.env and /.git/config are all covered, along with
   anything else starting with a dot, which is the shape secrets arrive in.

   (`python -m http.server`, which this replaces, served .env quite happily.
   Nobody noticed, which is exactly why it is written down here.) */
const BLOCKED_DIRS = new Set(['node_modules', 'artifacts', 'cache'])

function isBlocked(rel) {
  return rel.split(/[/\\]+/).filter(Boolean).some((seg) =>
    seg.startsWith('.') || BLOCKED_DIRS.has(seg.toLowerCase()))
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname || '/')
  if (rel.endsWith('/')) rel += 'index.html'
  const norm = path.normalize(rel).replace(/^([/\\])+/, '')
  if (isBlocked(norm)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('404')
  }
  const file = path.join(ROOT, norm)
  /* path.normalize collapses ../ before the join; this catches anything
     that still tries to climb out of the repo. */
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    return res.end('forbidden')
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end('404 ' + rel)
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  })
}

/* ---------------- rooms relay ----------------

   Two players on two machines, joined by a 4-character code. The server is a
   dumb pipe and deliberately so: it knows nothing about fighters, prompts,
   seeds or who is winning. It holds a set of subscribers per code and copies
   each message to the other side. Every rule that matters - commit-reveal,
   who owns the round nonce, whether a reveal matches its commit - is enforced
   in the browser by js/net.js and stays enforced no matter what this relay
   does or who is running it.

     GET  /api/room/sub?code=XXXX&side=N   server-sent events, one per peer
     POST /api/room/send                   { code, side, msg } -> the others

   SSE rather than a websocket because a websocket means either a dependency
   or a hand-rolled RFC6455 handshake, and this carries about 1KB per match.
   The `npm install`-free promise at the top of this file is worth more than
   the frame efficiency. */

const rooms = new Map()          // code -> Set of { side, res }

const ROOM_CODE_RE = /^[A-Z0-9]{4}$/
const ROOM_MAX = 500             // rooms held at once
const ROOM_MSG_MAX = 32 * 1024   // one message
const ROOM_IDLE_MS = 30 * 60 * 1000

function roomSubscribe(req, res, code, side) {
  if (!rooms.has(code)) {
    if (rooms.size >= ROOM_MAX) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      return res.end('too many rooms')
    }
    rooms.set(code, new Set())
  }
  const peers = rooms.get(code)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    /* Nginx and friends buffer by default, which turns a live stream into a
       stream that arrives all at once when the match is already over. */
    'X-Accel-Buffering': 'no'
  })
  res.write('retry: 1000\n\n')

  const client = { side: side, res: res, at: Date.now() }
  peers.add(client)
  const who = side === 0 ? 'spectator' : 'player ' + side
  console.log('[room] ' + code + ' <- ' + who + '  (' + peers.size + ' in room)')
  /* The players are told how many people are watching. It is the only thing
     a spectator's presence changes about the room, and it is worth showing:
     a crowd number on the lobby is the difference between a fight and a
     fight someone is watching. */
  if (side === 0) roomAnnounceCrowd(code)

  let keepalive = null
  const bye = () => {
    if (keepalive) { clearInterval(keepalive); keepalive = null }
    peers.delete(client)
    if (!peers.size) rooms.delete(code)
    else if (side === 0) roomAnnounceCrowd(code)
    console.log('[room] ' + code + ' -> ' + who + ' left  (' + peers.size + ' left)')
  }

  /* Matters once this is deployed behind a proxy. While both players are in,
     their 1s heartbeats keep the stream busy - but a host sitting alone in
     the lobby waiting for someone to join receives nothing at all, and most
     proxies hang up a connection that has been idle for a minute. A comment
     line is not an SSE event, so the browser never sees it; it just keeps
     the pipe warm. */
  keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch (e) { bye() }
  }, 15000)

  req.on('close', bye)
  req.on('error', bye)
}

/* The crowd size, to everybody in the room including the crowd itself.
   `from: 0` is what marks it as the server talking rather than a player, and
   js/net.js peels it off before its presence logic runs - otherwise a
   spectator arriving would read as the opponent arriving, and a host sitting
   alone in a lobby would be told their fight was ready to start. */
function roomAnnounceCrowd(code) {
  const peers = rooms.get(code)
  if (!peers) return
  let n = 0
  for (const c of peers) if (c.side === 0) n++
  const frame = 'data: ' + JSON.stringify({ v: 1, from: 0, t: 'spectators', n: n }) + '\n\n'
  for (const c of peers) {
    try { c.res.write(frame) } catch (e) { peers.delete(c) }
  }
}

/* Back to everyone in the room except the sender's own side. Same rule the
   BroadcastChannel driver applies locally, so both transports look identical
   from inside js/net.js. */
function roomFanout(code, side, msg) {
  const peers = rooms.get(code)
  if (!peers) return 0
  const frame = 'data: ' + JSON.stringify(msg) + '\n\n'
  let sent = 0
  for (const c of peers) {
    if (c.side === side) continue
    try { c.res.write(frame); sent++ } catch (e) { peers.delete(c) }
  }
  return sent
}

/* A tab that is closed fires req.on('close'); a laptop that is shut does not
   always, so a room nobody has spoken in for half an hour is swept. */
setInterval(() => {
  const now = Date.now()
  for (const [code, peers] of rooms) {
    for (const c of peers) {
      if (now - c.at > ROOM_IDLE_MS) {
        try { c.res.end() } catch (e) {}
        peers.delete(c)
      }
    }
    if (!peers.size) rooms.delete(code)
  }
}, 60000).unref()


/* ---------------- the live match board ----------------

   The relay above is deliberately blind: it moves bytes between two sides
   and knows nothing about them. A spectator needs the exact opposite - a
   directory of what is happening right now, BEFORE they have picked a room
   to watch. You cannot join a room whose code you were never told.

   So hosts announce. Three rules keep this honest:

     one writer   only side 1, the host, writes a match record. Two writers
                  on one record is two versions of who is winning.
     whole snaps  every announce is the complete state, never a diff. A
                  spectator who connects mid-match gets one object and is
                  immediately correct; no replay, no catch-up log.
     it expires   a record nobody refreshed for LIVE_TTL is gone. A board
                  listing fights that ended twenty minutes ago is worse
                  than no board at all.

   What is deliberately NOT here: money. Bet pools, odds, payouts and who
   claimed what are read from ArenaBattle on Monad by the browser, never
   from this process. If this server lied about a pool the chain would
   simply disagree with it. It is a noticeboard, not a bookmaker.

     POST /api/match/announce   { code, side, snap }  -> upsert
     GET  /api/match/list                             -> everything still live
     GET  /api/match/get?code=XXXX                    -> one, for a late joiner
     POST /api/match/close      { code, side }        -> the host left
*/

/* The last time anyone asked what was on the board. The house floor spends
   real gas to open a market, so it asks this before it does: a server
   nobody is looking at should cost nothing to leave running. */
let lastBoardPoll = 0

const board = new Map()            // code -> snapshot
const BOARD_MAX = 400
const LIVE_TTL = 90 * 1000         // an open match nobody refreshed
const DONE_TTL = 6 * 60 * 1000     // a finished one, kept so results can be read

const STATUSES = ['lobby', 'writing', 'ready', 'live', 'done', 'gone']
const MODES = ['fighter', 'pen', 'hexgl']

/* Everything below crosses a network from a browser we do not control, so
   every field is clamped rather than trusted. A 4MB archetype string on the
   board would be served to every spectator who loads the page. */
function str(v, max) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
}
function num(v, lo, hi, dflt) {
  const n = Number(v)
  if (!isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}
function addr(v) {
  const s = str(v, 42)
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s : ''
}

function cleanSide(s) {
  const o = s && typeof s === 'object' ? s : {}
  const st = o.stats && typeof o.stats === 'object' ? o.stats : {}
  return {
    name: str(o.name, 24),
    archetype: str(o.archetype, 24),
    tagline: str(o.tagline, 64),
    /* The prompt is the whole spectacle - it is what the bet is actually
       on - but it is also player-authored text on a public board, so it is
       clamped here and rendered as text, never HTML, on the other end. */
    prompt: str(o.prompt, 240),
    addr: addr(o.addr),
    stats: {
      aggression: num(st.aggression, 0, 1, 0),
      defense: num(st.defense, 0, 1, 0),
      speed: num(st.speed, 0, 1, 0)
    },
    locked: !!o.locked,
    seated: !!o.seated
  }
}

/* A pair of fighters as the host reports them, clamped the same way the
   board clamps a snapshot. These become on-chain agent snapshots, so a
   field that is wrong here is wrong in contract storage - and the stats
   are re-budgeted rather than trusted, because a host that sent 1/1/1
   would otherwise put an unbeatable fighter in a market. */
function cleanAgents(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const one = (side) => {
    const a = o[side] && typeof o[side] === 'object' ? o[side] : null
    if (!a) return null
    const st = a.stats && typeof a.stats === 'object' ? a.stats : {}
    const stats = {
      aggression: num(st.aggression, 0, 1, 0.35),
      defense: num(st.defense, 0, 1, 0.35),
      speed: num(st.speed, 0, 1, 0.35)
    }
    const total = stats.aggression + stats.defense + stats.speed
    if (total > 1.95) {
      const k = 1.95 / total
      for (const key in stats) stats[key] = Math.round(stats[key] * k * 100) / 100
    }
    return {
      prompt: str(a.prompt, 280),
      archetype: str(a.archetype, 24) || 'FIGHTER',
      tagline: str(a.tagline, 64),
      stats,
      model: str(a.model, 64),
      modelVersion: str(a.modelVersion, 64)
    }
  }
  const p1 = one('p1')
  const p2 = one('p2')
  if (!p1 || !p2 || !p1.prompt || !p2.prompt) return null
  return { p1, p2 }
}

function cleanSnap(raw, code) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const chain = o.chain && typeof o.chain === 'object' ? o.chain : {}
  return {
    code: code,
    mode: MODES.indexOf(o.mode) >= 0 ? o.mode : 'fighter',
    status: STATUSES.indexOf(o.status) >= 0 ? o.status : 'lobby',
    round: num(o.round, 0, 9999, 1) | 0,
    /* Stake and matchId are the two numbers a bettor needs before they can
       do anything on chain, and both are echoed from the host rather than
       verified here. The browser checks them against ArenaBattle before it
       will spend anything - see Chain.readMatch() in js/blockchain.js. */
    stake: str(o.stake, 24),
    chain: {
      matchId: num(chain.matchId, 0, 1e12, 0) | 0,
      arena: addr(chain.arena),
      chainId: num(chain.chainId, 0, 1e9, 0) | 0
    },
    p1: cleanSide(o.p1),
    p2: cleanSide(o.p2),
    winner: (o.winner === 'p1' || o.winner === 'p2') ? o.winner : null,
    how: str(o.how, 24),
    seed: num(o.seed, 0, 0xffffffff, 0) >>> 0,
    startedAt: num(o.startedAt, 0, 1e15, 0),

    /* A house match: seated, run and reported by this server rather than by
       two players (house/director.js). It is on the board so the floor is
       never empty, and it is FLAGGED so that it is never mistaken for two
       humans - the one guarantee a house match cannot offer is the arbiter's
       "both machines independently agreed", because there is only one
       machine. js/spectate.js labels every row and panel carrying this.

       Note where this flag can come from: /api/match/announce runs
       untrusted host input through cleanSnap too, so a browser could set
       it. That direction is harmless - the flag only ever ADDS a caveat to
       what is claimed, and a host lying that its own match is house-run
       makes its match look less authoritative, not more. The dangerous
       direction, a house match that fails to declare itself, is not
       reachable: the director sets it on every snapshot it writes. */
    house: !!o.house,
    houseNote: str(o.houseNote, 64),

    updatedAt: Date.now()
  }
}

/* How many people are watching, counted straight off the relay's own
   subscriber set rather than reported by the host - so nobody can inflate
   their own audience. */
function spectatorCount(code) {
  const peers = rooms.get(code)
  if (!peers) return 0
  let n = 0
  for (const c of peers) if (c.side === 0) n++
  return n
}

function boardTTL(snap) {
  return (snap.status === 'done' || snap.status === 'gone') ? DONE_TTL : LIVE_TTL
}

function boardList() {
  const now = Date.now()
  const out = []
  for (const [code, snap] of board) {
    if (now - snap.updatedAt > boardTTL(snap)) { board.delete(code); continue }
    out.push(Object.assign({}, snap, {
      spectators: spectatorCount(code),
      age: now - snap.updatedAt
    }))
  }
  /* Live fights first, then the ones still filling up, then results - the
     order a spectator's attention goes in. Ties break on most recently
     updated, so an active board keeps moving. */
  const rank = { live: 0, ready: 1, writing: 2, lobby: 3, done: 4, gone: 5 }
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.updatedAt - a.updatedAt))
  return out
}

setInterval(() => {
  const now = Date.now()
  for (const [code, snap] of board) {
    if (now - snap.updatedAt > boardTTL(snap)) board.delete(code)
  }
}, 30000).unref()

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
  const pathname = parsedUrl.pathname
  const query = Object.fromEntries(parsedUrl.searchParams)
  const parsed = { pathname, query }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    return res.end()
  }

  /* ------------------------------------------------------------------
     /api/health - liveness. Render polls this, so it does NO network.

     It answers from process memory only. An earlier draft checked the chain
     here, which meant every health poll made two RPC calls: Render hits this
     every few seconds, so that was a few thousand calls an hour to a public
     endpoint, and a rate-limited RPC would have made the service look DOWN
     when the only thing wrong was the health check itself.

     `ok` is deliberately about the PROCESS, not the deployment. The relay
     works with no Gemini keys and no contracts, so a server missing those is
     degraded, not dead - and returning non-200 would make Render restart a
     process that is running perfectly.

     For "is this deployment actually wired up correctly", see /api/ready.
  ------------------------------------------------------------------- */

  if (pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      version: VERSION,

      // Gemini. Counts only - no key material ever goes over this wire.
      keys: KEYS.length,
      models: MODELS,
      cached: cache.size,
      usage: KEYS.map((k) => ({
        id: k.id, ok: k.ok, fail: k.fail, cooling: k.cooldownUntil > Date.now()
      })),

      // Relay and board. Independent of the keys and of the chain.
      relay: true,
      rooms: rooms.size,
      board: board.size,

      /* The floor, so "is spectate.html going to have anything on it" is
         answerable without loading spectate.html. Still no network done
         here - this is read straight out of the director's own state. */
      house: House ? House.status() : null,

      // JEV
      jevCached: jevCache.size,

      /* Arbiter. The ADDRESS is public information - it is written into the
         contract - so reporting it is safe and is the fastest way to catch a
         deployment whose env var went missing. The key never appears. */
      arbiter: Arbiter.enabled() ? Arbiter.address() : null,

      /* WHY the chain is or is not live, in one field.

         "The markets are all paper" is the single most confusing state this
         server has, because everything else about it looks healthy: the
         page loads, the board fills, bets appear to land. The reason lives
         in the startup log, which on a hosted deployment means digging
         through a log viewer to find one line that scrolled past.

         So it is answerable from a URL instead. `ok` false means nothing
         will ever be settled, and `why` says which of the three conditions
         failed and what to do about it. */
      chain: (() => {
        const why = houseChain.whyNotReady()
        return {
          ok: !why,
          why: why,
          arena: houseChain.arenaAddress() || null,
          chainId: houseChain.chainId(),
          /* The length is the giveaway for the usual cause - a truncated
             paste. The key itself is never reported, only its shape. */
          keyChars: String(process.env.ARBITER_PRIVATE_KEY || '')
            .trim().replace(/^["']|["']$/g, '').replace(/^0x/, '').length,
          keyCharsExpected: 64
        }
      })(),
      arbiterMatches: Arbiter.matches.size
    })
  }

  /* ------------------------------------------------------------------
     /api/ready - readiness. Is this deployment actually able to run a match?

     Separate from /api/health because it costs RPC calls, so it is cached
     and nothing polls it automatically. This is the endpoint to open after a
     deploy, and the one to check first when settlement misbehaves.

     It answers the question the addresses alone cannot: does the arbiter key
     in this process match the arbiter the CONTRACT is holding, and does it
     have gas. Those two are the difference between a deployment that looks
     healthy and one that can actually settle a match - and both fail late,
     after bets are already in the pool.
  ------------------------------------------------------------------- */

  if (pathname === '/api/ready') {
    const fresh = parsed.query && parsed.query.fresh === '1'
    return sendJSON(res, 200, await readiness(fresh))
  }

  if (pathname === '/api/analyze') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    if (!KEYS.length) return sendJSON(res, 503, { ok: false, error: 'no GEMINI_API_KEY_n in .env' })
    let prompt = ''
    let mode = 'fighter'
    try {
      const body = await readBody(req, 64 * 1024)
      const parsed = JSON.parse(body) || {}
      prompt = String(parsed.prompt || '').slice(0, 2000).trim()
      if (MODE_CONTEXT[parsed.mode]) mode = parsed.mode
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request body' })
    }
    if (!prompt) return sendJSON(res, 400, { ok: false, error: 'empty prompt' })
    try {
      const out = await analyze(prompt, mode)
      console.log('[analyze] ' + mode + '  ' + out.ms + 'ms  ' + out.model + '  ' + out.key +
        (out.cached ? '  (cached)' : '') + '  -> ' + out.archetype + '  ' +
        JSON.stringify(out.stats))
      return sendJSON(res, 200, Object.assign({ ok: true, source: 'gemini' }, out))
    } catch (e) {
      console.warn('[analyze] every attempt failed: ' + e.message + '   ' + (e.tried || []).join(' '))
      return sendJSON(res, 502, { ok: false, error: e.message, tried: e.tried || [] })
    }
  }

  /* ---- JEV: one playbook per agent, cached so every screen agrees ---- */

  if (pathname === '/api/jev/decide') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try {
      body = JSON.parse(await readBody(req, 32 * 1024)) || {}
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request body' })
    }
    if (!body.matchId || !body.side || !body.self || !body.opponent) {
      return sendJSON(res, 400, { ok: false, error: 'need matchId, side, self, opponent' })
    }
    try {
      const out = await jevDecide(body)
      console.log('[jev] match ' + body.matchId + ' side ' + body.side + '  ' +
        (out.cached ? '(cached)  ' : '') + out.playbook.opening + '->' +
        out.playbook.mid + '->' + out.playbook.late)
      return sendJSON(res, 200, out)
    } catch (e) {
      /* A 503 here is not an error state for the product: js/jev.js falls
         back to the deterministic planner and the fight runs anyway. */
      console.warn('[jev] unavailable: ' + e.message)
      return sendJSON(res, 503, { ok: false, error: e.message, tried: e.tried || [] })
    }
  }

  /* ---- the arbiter ---- */

  if (pathname === '/api/arena/seed-commit') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try { body = JSON.parse(await readBody(req, 4096)) || {} } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request body' })
    }
    if (!body.matchId) return sendJSON(res, 400, { ok: false, error: 'need matchId' })
    const out = Arbiter.commitSeed(body.matchId)
    if (!out) return sendJSON(res, 503, { ok: false, error: 'arbiter is not configured' })
    return sendJSON(res, 200, { ok: true, commit: out.commit })
  }

  /* lockAgents + openBetting, sent by the arbiter because the contract will
     not accept them from anyone else. This is the moment the strategies
     become immutable and the market opens. */
  if (pathname === '/api/arena/lock-open') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    if (!Arbiter.enabled()) return sendJSON(res, 503, { ok: false, error: 'arbiter is not configured' })
    let body = null
    try { body = JSON.parse(await readBody(req, 4096)) || {} } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request body' })
    }
    if (!body.matchId || !body.arena) return sendJSON(res, 400, { ok: false, error: 'need matchId and arena' })
    try {
      const out = await Arbiter.lockAndOpen(body.arena, body.matchId, Number(body.window) || 120)
      console.log('[arbiter] locked + opened match ' + body.matchId)
      return sendJSON(res, 200, Object.assign({ ok: true }, out))
    } catch (e) {
      console.warn('[arbiter] lock/open failed for ' + body.matchId + ': ' + e.message)
      return sendJSON(res, 502, { ok: false, error: e.message })
    }
  }

  /* startMatch: reveal the preimage and let the fight begin. Betting is
     already shut by the time this can succeed. */
  if (pathname === '/api/arena/start') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    if (!Arbiter.enabled()) return sendJSON(res, 503, { ok: false, error: 'arbiter is not configured' })
    let body = null
    try { body = JSON.parse(await readBody(req, 4096)) || {} } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request body' })
    }
    if (!body.matchId || !body.arena) return sendJSON(res, 400, { ok: false, error: 'need matchId and arena' })
    try {
      const out = await Arbiter.start(body.arena, body.matchId)
      console.log('[arbiter] started match ' + body.matchId + ' seed ' + out.seed.slice(0, 12) + '...')
      return sendJSON(res, 200, Object.assign({ ok: true }, out))
    } catch (e) {
      console.warn('[arbiter] start failed for ' + body.matchId + ': ' + e.message)
      return sendJSON(res, 502, { ok: false, error: e.message })
    }
  }

  if (pathname === '/api/arena/seed-reveal') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try { body = JSON.parse(await readBody(req, 4096)) || {} } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request body' })
    }
    const out = Arbiter.revealSeed(body.matchId)
    if (!out) return sendJSON(res, 404, { ok: false, error: 'no seed committed for that match' })
    return sendJSON(res, 200, { ok: true, preimage: out.preimage })
  }

  if (pathname === '/api/arena/settle') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    if (!Arbiter.enabled()) {
      return sendJSON(res, 503, { ok: false, error: 'arbiter signing is not configured on this server' })
    }
    let body = null
    try { body = JSON.parse(await readBody(req, 16 * 1024)) || {} } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request body' })
    }

    /* Both sides report; a signature only exists if they agree. Two browsers
       that watched different fights must not settle at all - there is no way
       to tell which was right, and the loser is about to lose real money. */
    if (body.side) {
      const agree = Arbiter.report(body.matchId, body.side, {
        winner: Number(body.winner),
        finishType: Number(body.finishType),
        resultDigest: body.resultDigest,
        decisionHash: body.decisionHash
      })
      if (!agree.ready) {
        return sendJSON(res, 409, { ok: false, error: agree.reason, disputed: !!agree.disputed })
      }
    }

    const out = await Arbiter.sign(body)
    if (out.error) {
      console.warn('[arbiter] refused to sign match ' + body.matchId + ': ' + out.error)
      return sendJSON(res, 400, { ok: false, error: out.error })
    }
    console.log('[arbiter] signed match ' + body.matchId + ' winner=' + body.winner +
      ' finish=' + body.finishType)
    return sendJSON(res, 200, Object.assign({ ok: true }, out))
  }

  /* ---- the live match board ---- */

  if (pathname === '/api/match/list') {
    /* Somebody has the floor open. spectate.html polls this every three
       seconds, so it is the cheapest honest answer to "is anyone here" -
       and the house floor uses it to decide whether opening a real market
       is worth real gas. See audience() below. */
    lastBoardPoll = Date.now()
    return sendJSON(res, 200, { ok: true, now: Date.now(), matches: boardList() })
  }

  /* ------------------------------------------------------------------
     The Matchup Lab.

     "If these two met, who wins?" - answered by the engine rather than by
     a table of opinions. It is a GET with two prompts, so it is linkable
     and cacheable, and it settles nothing: no match is opened, no market is
     touched, no wallet is asked for.

     Read-only and side-effect free by construction. house/matchup.js runs
     house/sim.js - the same harness the settlement path trusts - and
     returns counts. If it is ever wrong, it is wrong on a page nobody bets
     on, which is the only place a head-to-head is allowed to be.
  ------------------------------------------------------------------- */
  if (pathname === '/api/matchup') {
    const a = String(parsed.query.a || '')
    const b = String(parsed.query.b || '')
    if (!a.trim() || !b.trim()) {
      return sendJSON(res, 400, { ok: false, error: 'need a and b (two prompts)' })
    }
    try {
      const out = Matchup.series(a, b, parsed.query.n)
      if (!out.ok) return sendJSON(res, 400, out)
      console.log('[matchup] ' + out.a.archetype + ' vs ' + out.b.archetype + '  ' +
        out.seeds + ' seeds  ' + out.wins.a + '/' + out.wins.b +
        (out.wins.draws ? ' (' + out.wins.draws + 'd)' : '') +
        '  ' + (out.determinism.ok ? 'reproducible' : 'NON-DETERMINISTIC'))
      return sendJSON(res, 200, out)
    } catch (e) {
      console.warn('[matchup] failed: ' + e.message)
      return sendJSON(res, 500, { ok: false, error: e.message })
    }
  }

  /* The fight running in a house room, for a spectator whose tab opened
     after the relay carried it. Everything in here is already public - the
     strategies are on chain and the seed came from the contract - so there
     is nothing to gate. It is 404 outside the live phase on purpose: a
     payload for a fight that has not started would be a way to read the
     outcome while the market is still open. */
  if (pathname === '/api/house/fight') {
    const code = String(parsed.query.code || '').toUpperCase()
    if (!ROOM_CODE_RE.test(code)) return sendJSON(res, 400, { ok: false, error: 'bad code' })
    /* Both kinds of server-run match answer here: a house table and a
       player room are the same thing to a spectator who arrived late - a
       fight already running that they need the inputs for. */
    const fight = (House && House.fightFor(code)) ||
      (RoomMatches && RoomMatches.fightFor(code)) || null
    if (!fight) return sendJSON(res, 404, { ok: false, error: 'no fight running in that room' })
    return sendJSON(res, 200, { ok: true, fight: fight })
  }

  /* ------------------------------------------------------------------
     A player room goes on chain.

     The host posts both revealed fighters; the server opens the market,
     waits for a backer on each side, starts the fight on the contract's
     seed and settles it. See house/rooms-chain.js for why the server owns
     this rather than the two browsers.

     Host only - side 1 - for the same reason the board has one writer: two
     callers would open two markets for one room.
  ------------------------------------------------------------------- */
  if (pathname === '/api/room/chain-open') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try { body = JSON.parse(await readBody(req, ROOM_MSG_MAX)) || {} } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad body' })
    }
    const code = String(body.code || '').toUpperCase()
    if (!ROOM_CODE_RE.test(code) || parseInt(body.side, 10) !== 1) {
      return sendJSON(res, 400, { ok: false, error: 'host only' })
    }
    if (!RoomMatches.ready()) {
      return sendJSON(res, 503, { ok: false, error: 'this server has no chain configured' })
    }
    const agents = cleanAgents(body.agents)
    if (!agents) return sendJSON(res, 400, { ok: false, error: 'need both fighters with stats' })
    try {
      const rm = RoomMatches.open(code, agents)
      return sendJSON(res, 200, { ok: true, phase: rm.phase, matchId: rm.matchId })
    } catch (e) {
      return sendJSON(res, 502, { ok: false, error: e.message })
    }
  }

  /* A browser's account of the fight it just watched. No wallet and no gas:
     the server settles with the arbiter's key, and this is the check that
     it is settling the same fight the players saw. */
  if (pathname === '/api/room/report') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try { body = JSON.parse(await readBody(req, 4096)) || {} } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad body' })
    }
    const out = RoomMatches.report(body.matchId, String(body.side || ''), body.result || {})
    return sendJSON(res, out.ok ? 200 : 404, out)
  }

  if (pathname === '/api/match/get') {
    const code = String(parsed.query.code || '').toUpperCase()
    if (!ROOM_CODE_RE.test(code)) return sendJSON(res, 400, { ok: false, error: 'bad code' })
    const snap = board.get(code)
    if (!snap) return sendJSON(res, 404, { ok: false, error: 'no such match' })
    return sendJSON(res, 200, {
      ok: true,
      match: Object.assign({}, snap, { spectators: spectatorCount(code), age: Date.now() - snap.updatedAt })
    })
  }

  if (pathname === '/api/match/announce') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try {
      body = JSON.parse(await readBody(req, ROOM_MSG_MAX)) || {}
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad body' })
    }
    const code = String(body.code || '').toUpperCase()
    /* Host only. The guest has its own view of the match and would overwrite
       the host's with it half a second later; one record needs one author. */
    if (!ROOM_CODE_RE.test(code) || parseInt(body.side, 10) !== 1) {
      return sendJSON(res, 400, { ok: false, error: 'bad code or side' })
    }
    if (!board.has(code) && board.size >= BOARD_MAX) {
      return sendJSON(res, 503, { ok: false, error: 'board full' })
    }
    const snap = cleanSnap(body.snap, code)
    board.set(code, snap)
    return sendJSON(res, 200, { ok: true, spectators: spectatorCount(code) })
  }

  if (pathname === '/api/match/close') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try {
      body = JSON.parse(await readBody(req, 2048)) || {}
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad body' })
    }
    const code = String(body.code || '').toUpperCase()
    if (!ROOM_CODE_RE.test(code) || parseInt(body.side, 10) !== 1) {
      return sendJSON(res, 400, { ok: false, error: 'bad code or side' })
    }
    /* Not deleted outright: a spectator watching the last second of a fight
       should still be able to read the result and claim on it. The record is
       marked gone and the sweeper takes it on the DONE_TTL clock. */
    const snap = board.get(code)
    if (snap) {
      if (snap.status !== 'done') snap.status = 'gone'
      snap.updatedAt = Date.now()
    }
    return sendJSON(res, 200, { ok: true })
  }

  if (pathname === '/api/room/sub') {
    const code = String(parsed.query.code || '').toUpperCase()
    const side = parseInt(parsed.query.side, 10)
    /* 0 is a spectator. They read the room and may never write to it - see
       /api/room/send below, which still only accepts 1 and 2. That one
       asymmetry is the whole security model of spectating: a spectator
       cannot commit, cannot reveal a fighter, cannot open a round and
       cannot claim a result, because the pipe will not carry it. */
    if (!ROOM_CODE_RE.test(code) || (side !== 0 && side !== 1 && side !== 2)) {
      return sendJSON(res, 400, { ok: false, error: 'bad code or side' })
    }
    return roomSubscribe(req, res, code, side)
  }

  if (pathname === '/api/room/send') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' })
    let body = null
    try {
      body = JSON.parse(await readBody(req, ROOM_MSG_MAX)) || {}
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad body' })
    }
    const code = String(body.code || '').toUpperCase()
    const side = parseInt(body.side, 10)
    if (!ROOM_CODE_RE.test(code) || (side !== 1 && side !== 2) || !body.msg) {
      return sendJSON(res, 400, { ok: false, error: 'bad code, side or msg' })
    }
    const peers = rooms.get(code)
    if (peers) for (const c of peers) { if (c.side === side) c.at = Date.now() }
    /* `delivered: 0` is not an error - the other player simply is not here
       yet. js/net.js already treats silence as "no such room" after its own
       timeout, and that is the only place that judgement belongs. */
    return sendJSON(res, 200, { ok: true, delivered: roomFanout(code, side, body.msg) })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' })
    return res.end('method not allowed')
  }
  serveStatic(req, res, pathname)
})

/* The other player is on another laptop, so localhost is the one address
   that cannot possibly work for them. Print what will. */
function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

/* ---------------- matches this server runs ----------------

   Two things here, and they share everything below the surface:

     RoomMatches   the market for a room two real players opened. NOT
                   optional and not part of the house floor - if this
                   server has a chain, the rooms on it get markets.
     House         tables the server seats itself, so spectate.html is
                   never an empty page (house/director.js).

   Both drive a match through house/market.js, which is where the rule that
   matters lives: no fight starts until a backer is on each side.

   Everything is passed in rather than imported, because the board, the
   relay and the stat engine all live in this file's closure - and because
   a director that can only reach what it was handed cannot grow a second
   way to write the board. */
const { RoomMatches } = require('./house/rooms-chain.js')
const { makeHouseChain } = require('./house/chain.js')
const houseSim = require('./house/sim.js')
const Matchup = require('./house/matchup.js')
const PAIRS_COUNT = require('./house/fixtures.js').PAIRS.length

const houseChain = makeHouseChain({
  root: ROOT,
  arbiter: Arbiter,
  jevConfigHash: () => houseSim.jevConfigHash()
})

RoomMatches.init({
  chain: houseChain,
  fanout(code, side, msg) { roomFanout(code, side, msg) },
  /* Whether anyone is still sitting in the two player seats - a room both
     players walked out of should not keep opening markets. */
  playersPresent(code) {
    const peers = rooms.get(code)
    if (!peers) return false
    for (const c of peers) if (c.side === 1 || c.side === 2) return true
    return false
  }
})

/* The floor is on unless told otherwise: an empty spectate page is the
   wrong default for a demo. It falls back to labelled paper tables on a
   laptop with no arbiter key. */
const HOUSE_ENABLED = String(process.env.HOUSE_FLOOR || 'on').toLowerCase() !== 'off'

/* How long after the last visitor the floor keeps spending. Generous
   enough that someone reading two strategies before betting is not counted
   as gone, short enough that a tab closed at midnight stops the meter. */
const AUDIENCE_MS = 90 * 1000

let House = null
if (HOUSE_ENABLED) {
  try {
    const { HouseDirector } = require('./house/director.js')

    House = HouseDirector
    House.start({
      /* The board, through the same cleanSnap every announced match goes
         through. The house gets no privileged path to the board: if a
         field would be clamped off a player's snapshot, it is clamped off
         the house's too. */
      putSnap(code, snap) {
        if (!code) return
        if (!board.has(code) && board.size >= BOARD_MAX) return
        board.set(code, cleanSnap(snap, code))
      },
      codeTaken(code) { return board.has(code) || rooms.has(code) },

      /* side -1 so roomFanout's "everyone except the sender's own side"
         excludes nobody - a house event is for the whole room, and there
         is no player side it could be echoing back to. */
      fanout(code, side, msg) { roomFanout(code, side, msg) },

      analyze: (prompt, mode) => analyze(prompt, mode),
      jevDecide: (req) => jevDecide(req),

      houseAddress: () => houseChain.address(),
      chain: houseChain,

      /* IS ANYONE WATCHING.

         An empty on-chain cycle is not free: create, two submits, lock,
         open and then cancel is six transactions and about 0.1 MON. A
         floor left running overnight with nobody on it would burn through
         the arbiter's balance and be empty by morning - which is exactly
         when a judge opens it.

         So a table only opens a REAL market when somebody has loaded the
         floor recently. Otherwise it idles, costing nothing, and comes
         alive within one cycle of the first visitor. Two signals, either
         will do: the board being polled (spectate.html does that every
         three seconds) or anyone sitting in a relay room. */
      audience() {
        if (Date.now() - lastBoardPoll < AUDIENCE_MS) return true
        for (const peers of rooms.values()) if (peers.size) return true
        return false
      }
    })
  } catch (err) {
    console.warn('[house] floor did not start: ' + err.message)
    console.warn('[house] spectate.html will only show matches real players create')
    House = null
  }
}

server.listen(PORT, () => {
  const names = KEYS.map((k) => k.id.replace('GEMINI_API_KEY_', 'k')).join(' ')
  console.log('arena server   http://localhost:' + PORT + '/play.html')
  console.log('  gemini keys : ' + KEYS.length +
    (KEYS.length ? ' (' + names + ')' : ' - NONE; the front end will use the local parser'))
  console.log('  models      : ' + MODELS.join(' -> '))
  const lan = lanAddresses()
  console.log('  rooms relay : on  (two machines, same 4-character code)')
  console.log('  spectating  : http://localhost:' + PORT + '/spectate.html')
  if (House) {
    const st = House.status()
    const onChain = st.filter((t) => t.chain).length
    console.log('  house floor : ' + st.length + (onChain ? ' on-chain' : ' paper') +
      ' tables, rotating through ' + (PAIRS_COUNT * 2) + ' strategies' +
      (onChain ? '  (each fights only once both sides are backed)'
        : '  (no arbiter key - nothing will settle)'))
  } else {
    console.log('  house floor : off  (spectate shows only real player matches)')
  }
  if (lan.length) {
    for (const a of lan) {
      console.log('  other player: http://' + a + ':' + PORT + '/play.html')
    }
  } else {
    console.log('  other player: no LAN address found - same-machine rooms only')
  }
})
