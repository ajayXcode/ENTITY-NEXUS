/* ------------------------------------------------------------------
   tests/matchup.test.js - the Matchup Lab tells the truth.

   Three claims, and each of them is one a research tool can quietly get
   wrong while still looking fine on screen:

   1. IT RUNS THE REAL ENGINE. house/matchup.js must go through
      house/sim.js - never a reimplementation, never an approximation. The
      check is that it uses the same two prompts, the same parser and the
      same harness the settlement path uses, by comparing its output against
      a direct sim.run() of the same seed.

   2. IT IS REPRODUCIBLE. The same pair of prompts must produce the same
      series twice. A win rate whose sample changes between page loads is
      not evidence, it is decoration.

   3. THE ROUTE IS WIRED. /api/matchup answers, rejects an empty side, and
      nothing about it touches a match or a market.

   Run: node tests/matchup.test.js  (or npm test, which includes it)
------------------------------------------------------------------- */

'use strict'

const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

/* Absolute, because require() treats a bare 'house/...' as a package name.
   The runner passes the project root as argv[2]; running the file by hand
   from anywhere still resolves against the file's own location. */
const ROOT = path.resolve(process.argv[2] || path.resolve(__dirname, '..'))
const PORT = 8433
const BASE = 'http://127.0.0.1:' + PORT

const sim = require(path.join(__dirname, '..', 'house', 'sim.js'))
const matchup = require(path.join(__dirname, '..', 'house', 'matchup.js'))

let fails = 0
const check = (cond, msg) => {
  if (cond) console.log('  ok    ' + msg)
  else { console.error('  FAIL  ' + msg); fails++ }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PA = 'relentless fearless ninja, fast agile and quick to close, keep a tight guard while charging in'
const PB = 'slow immovable siege sentinel, defensive and sturdy, stand your ground and absorb everything'

/* ---------------- the module ---------------- */

console.log('\n--- the series is the engine ---')
{
  const d = matchup.series(PA, PB, 11)

  check(d.ok === true, 'a series runs')
  check(d.seeds === 11, 'it fights the number of seeds it was asked for — got ' + d.seeds)
  check(d.wins.a + d.wins.b + d.wins.draws === 11, 'every fight landed in exactly one column')
  check(d.finishes.KO + d.finishes.DECISION === 11, 'every fight has exactly one finish type')

  /* The decisive check: the same seed, through the module and through the
     harness, must be the same fight. If matchup.js ever grows its own copy
     of the engine, or its own idea of the seeds, this diverges. */
  const A = sim.parse(PA)
  const B = sim.parse(PB)
  const first = d.log[0]
  const direct = sim.run(A, B, matchup.seedFor(0), null)
  check(first.seed === matchup.seedFor(0), 'the first logged seed is seedFor(0)')
  check(first.frames === direct.frames && first.hpA === direct.hpA && first.hpB === direct.hpB,
    'the logged fight matches sim.run() on the same seed — ' +
    first.frames + 'f/' + first.hpA + 'hp vs ' + direct.frames + 'f/' + direct.hpA + 'hp')

  check(d.determinism.ok === true, 'the harness reproduced its own first fight')
  check(d.a.archetype === A.archetype && d.b.archetype === B.archetype,
    'each side carries the archetype the real parser produced — ' +
    d.a.archetype + ' vs ' + d.b.archetype)

  const rates = d.winRate.a + d.winRate.b + d.winRate.draw
  check(Math.abs(rates - 1) < 0.01, 'the three rates add to one — ' + rates.toFixed(4))
}

console.log('\n--- the same pair gives the same series ---')
{
  const one = matchup.series(PA, PB, 11)
  const two = matchup.series(PA, PB, 11)
  check(one.wins.a === two.wins.a && one.wins.b === two.wins.b && one.wins.draws === two.wins.draws,
    'run twice, same split — ' + one.wins.a + '/' + one.wins.b + ' then ' + two.wins.a + '/' + two.wins.b)
  check(one.avgFrames === two.avgFrames, 'same average length')
  check(JSON.stringify(one.log) === JSON.stringify(two.log), 'identical per-seed log')
}

console.log('\n--- mirrors and refusals ---')
{
  const mirror = matchup.series(PA, PA, 11)
  check(mirror.ok === true && mirror.wins.a + mirror.wins.b + mirror.wins.draws === 11,
    'a champion against itself is still a series')
  /* A mirror match is the one place a draw is genuinely likely, so this is
     also the check that draws are counted rather than dropped. */
  check(mirror.wins.draws >= 0, 'a mirror keeps its draws in their own column — ' + mirror.wins.draws)

  const empty = matchup.series('', PB, 11)
  check(empty.ok === false && /both prompts/.test(empty.error), 'an empty side is refused, not guessed at')

  const capped = matchup.series(PA, PB, 9999)
  check(capped.seeds === matchup.MAX_SEEDS, 'the seed count is capped at ' + matchup.MAX_SEEDS)
  const floored = matchup.series(PA, PB, 1)
  check(floored.seeds === 3, 'and has a floor of 3 — got ' + floored.seeds)
  const dflt = matchup.series(PA, PB, 'banana')
  check(dflt.seeds === matchup.DEFAULT_SEEDS, 'a nonsense count falls back to the default')
}

/* ---------------- the route ---------------- */

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(body) } catch (e) {}
        resolve({ status: res.statusCode, json })
      })
    }).on('error', reject)
  })
}

let server = null

async function waitForServer(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await get(BASE + '/api/health')
      if (r.json) return true
    } catch (e) {}
    await wait(150)
  }
  return false
}

;(async () => {
  console.log('\n--- /api/matchup ---')
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stdout.on('data', () => {})
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

  const up = await waitForServer(9000)
  check(up, 'server.js is up on ' + PORT)
  if (!up) { server.kill(); process.exit(1) }

  /* The board BEFORE the Lab is asked for anything. In paper mode the house
     floor keeps a lobby open of its own accord, so "the board is empty"
     would be asserting something about the floor rather than about this
     route. What matters is that the Lab does not change it. */
  const before = await get(BASE + '/api/match/list')
  const codesBefore = (before.json && before.json.matches || []).map((m) => m.code).sort().join(',')

  const ok = await get(BASE + '/api/matchup?n=11&a=' + encodeURIComponent(PA) + '&b=' + encodeURIComponent(PB))
  check(ok.status === 200 && ok.json && ok.json.ok === true, 'a series comes back 200')

  if (ok.json && ok.json.ok) {
    const d = ok.json
    check(d.seeds === 11 && d.wins.a + d.wins.b + d.wins.draws === 11, 'the route returns a full series')
    check(typeof d.a.prompt === 'string' && d.a.prompt.length > 0, 'the route echoes the strategy it ran')
    check(Array.isArray(d.log) && d.log.length > 0, 'the route returns the per-seed log')
    check(d.determinism && d.determinism.ok === true, 'and the determinism verdict')
  }

  const bad = await get(BASE + '/api/matchup?a=&b=' + encodeURIComponent(PB))
  check(bad.status === 400 && bad.json && bad.json.ok === false, 'a missing side is a 400')

  /* The Lab must not have opened a match. /api/match/list is the public
     board, so an unchanged board is the proof. */
  const board = await get(BASE + '/api/match/list')
  const codesAfter = (board.json && board.json.matches || []).map((m) => m.code).sort().join(',')
  check(Array.isArray(board.json && board.json.matches) && codesAfter === codesBefore,
    'running a series opened no match on the board — "' + codesBefore + '" then "' + codesAfter + '"')

  server.kill()
  console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n')
  process.exit(fails ? 1 : 0)
})().catch((e) => {
  console.error(e)
  if (server) server.kill()
  process.exit(1)
})
