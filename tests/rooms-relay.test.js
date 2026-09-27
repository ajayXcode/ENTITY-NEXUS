/* ------------------------------------------------------------------
   The relay driver against a real server.js process.

   Two clients in two vm contexts, neither given a BroadcastChannel, so the
   local driver reports itself unavailable and the relay is the only thing
   under test. Node has no global EventSource, so there is a small SSE
   client below - it speaks the same wire format a browser does, which is
   the point: js/net.js is exercised unmodified.
------------------------------------------------------------------- */
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const ROOT = process.argv[2] || process.cwd()
const PORT = 8431
const BASE = 'http://127.0.0.1:' + PORT

/* ---------------- a minimal EventSource ---------------- */

function makeEventSource() {
  return class EventSource {
    constructor(url) {
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this._closed = false
      this._buf = ''

      this._req = http.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          if (this.onerror) this.onerror(new Error('http ' + res.statusCode))
          return
        }
        if (this.onopen) this.onopen()
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          this._buf += chunk
          let i
          while ((i = this._buf.indexOf('\n\n')) >= 0) {
            const frame = this._buf.slice(0, i)
            this._buf = this._buf.slice(i + 2)
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ') && this.onmessage) {
                this.onmessage({ data: line.slice(6) })
              }
            }
          }
        })
        res.on('end', () => { if (!this._closed && this.onerror) this.onerror(new Error('ended')) })
      })
      this._req.on('error', () => { if (!this._closed && this.onerror) this.onerror(new Error('refused')) })
    }
    close() { this._closed = true; try { this._req.destroy() } catch (e) {} }
  }
}

/* ---------------- clients ---------------- */

const utils = fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8')
const net = fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8')

function makeClient(tag) {
  const ctx = {
    // No BroadcastChannel on purpose: the relay is the only transport here.
    EventSource: makeEventSource(),
    fetch,
    setInterval, clearInterval, setTimeout, clearTimeout,
    console, Math, Date, JSON, Promise, Error, String, Number, Object, Array,
    CONFIG: { RELAY_ENDPOINT: BASE + '/api/room' },
    window: { addEventListener() {} }
  }
  vm.createContext(ctx)
  vm.runInContext(['var NetExport;', utils, net, 'NetExport = Net;'].join('\n'), ctx, { filename: tag })
  return ctx.NetExport
}

let fails = 0
const check = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''))
  if (!cond) fails++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fighter = (side, prompt) => ({
  prompt, stats: { aggression: 0.5, defense: 0.4, speed: 0.5 },
  matched: [], improvised: false, archetype: 'T' + side, tagline: 't', source: 'lexicon'
})

async function getJSON(p) {
  const r = await fetch(BASE + p)
  return r.json()
}

/* ---------------- run ---------------- */

let server = null

async function waitForServer(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const h = await getJSON('/api/health')
      if (h) return true
    } catch (e) {}
    await wait(150)
  }
  return false
}

;(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stdout.on('data', () => {})
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

  console.log('\n--- server ---')
  const up = await waitForServer(8000)
  check('server.js is up on ' + PORT, up)
  if (!up) { server.kill(); process.exit(1) }

  const health = await getJSON('/api/health')
  check('health reports the relay', health.relay === true)
  check('health reports zero rooms to start', health.rooms === 0, String(health.rooms))

  console.log('\n--- no such room, over the relay ---')
  const X = makeClient('X')
  try {
    await X.join('QQQQ')
    check('unknown code rejected', false)
  } catch (e) {
    check('unknown code rejected', /NO SUCH ROOM/.test(e.message), e.message)
  }

  console.log('\n--- host + join across the relay ---')
  const A = makeClient('A')
  const B = makeClient('B')
  const code = await A.host()
  check('host opened a room', A.status === 'waiting', A.status)
  check('driver is the relay, not BroadcastChannel',
    A.driver && A.driver.name === 'relay', A.driver && A.driver.name)

  await B.join(code)
  check('guest joined', B.status === 'connected', B.status)
  await wait(300)
  check('host saw the join', A.status === 'connected', A.status)

  const h2 = await getJSON('/api/health')
  check('server is holding the room', h2.rooms === 1, String(h2.rooms))

  console.log('\n--- a full round over the relay ---')
  A.resetRound()
  A.sendNewRound(1, 123456)
  await wait(250)
  check('guest got the round nonce', B.roundNonce === 123456, String(B.roundNonce))

  const p1 = 'relentless berserker, attack without mercy'
  const p2 = 'patient counter puncher, punish mistakes'
  A.publishFighter(fighter(1, p1)); A.commit(p1)
  await wait(250)
  check('nothing revealed on one commit', !B.fighters[1])

  B.publishFighter(fighter(2, p2)); B.commit(p2)
  await wait(400)
  check('host has both fighters', A.bothReady(), 'host')
  check('guest has both fighters', B.bothReady(), 'guest')
  check('seeds agree across machines', A.deriveSeed() === B.deriveSeed(),
    A.deriveSeed() + ' / ' + B.deriveSeed())

  console.log('\n--- tampering is still caught over the relay ---')
  let dropped = null
  A.onPeerLeave = (why) => { dropped = why }
  B._send({ t: 'fighter', parsed: fighter(2, 'not what was committed') })
  await wait(300)
  check('commit mismatch detected', dropped === 'COMMIT MISMATCH', String(dropped))

  console.log('\n--- leaving ---')
  const C = makeClient('C')
  const D = makeClient('D')
  const code2 = await C.host()
  await D.join(code2)
  await wait(250)
  let left = null
  D.onPeerLeave = (why) => { left = why }
  C.leave()
  await wait(400)
  check('bye crosses the relay', left === 'OPPONENT LEFT', String(left))

  await wait(300)
  const h3 = await getJSON('/api/health')
  /* A+B are still in one room and D is still in the other, so two is the
     right answer here - one seat emptying is not a room closing. */
  check('a room survives one player leaving', h3.rooms === 2, String(h3.rooms))

  console.log('\n--- the server lets go ---')
  ;[X, A, B, C, D].forEach((c) => { try { c.leave() } catch (e) {} })
  await wait(600)
  const h4 = await getJSON('/api/health')
  check('every room released once empty', h4.rooms === 0, String(h4.rooms))

  server.kill()
  console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n')
  process.exit(fails ? 1 : 0)
})().catch((e) => {
  console.error(e)
  if (server) server.kill()
  process.exit(1)
})
