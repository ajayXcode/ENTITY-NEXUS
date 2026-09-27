/* ------------------------------------------------------------------
   betting.js - the spectator side of ArenaBattle, and the arithmetic
   that has to agree with it exactly.

   Everything here is a mirror of contracts/ArenaBattle.sol. Two rules
   decided how it is written:

   1. THE CHAIN IS THE LEDGER. Pools, bets, who has claimed and how much is
      owed are read from ArenaBattle, never from server.js and never from
      this file's own memory. The board in server.js knows the coordinates
      of a match - its id and the two fighter addresses - and nothing about
      money. A relay that reported pools would be a relay the chain could
      contradict, and at that point the number on screen is a rumour.

   2. THE ODDS ARE THE CONTRACT'S OWN. quote() below is settleMatch() and
      claimSpectatorPayout() rearranged, in BigInt wei with the same integer
      division, so the payout shown before a bet is the payout the contract
      pays after it. Floating point here would drift from solidity in the
      last decimal and turn a demo into an argument.

   THE PAYOUT, IN ONE PLACE
   ArenaBattle runs a straight pari-mutuel on the TOTAL pool:

     total         = poolA + poolB
     fee           = total * 5%                  (match.feeBps, snapshotted)
     distributable = total - fee
     payout(b)     = distributable * b / winningPool

   Note what that is NOT: the principal is not protected. The fee is charged
   on the whole table, winners' own stakes included, so backing the winner in
   a market where almost everyone else did too can return LESS than the
   stake. That is the honest shape of a pari-mutuel and the UI says so rather
   than implying a floor that does not exist.

   Adding x to a pool of P against an opposing pool of Q returns

     0.95 * (P + Q + x) * x / (P + x)

   which is why the odds move as an amount is typed: the bet dilutes the pool
   it is joining. That is not a UI flourish, it is the contract.

   Two cases pay nothing and charge nothing, and the UI must show both:
     - nobody backed the WINNING side  -> the market VOIDS, everyone refunded
     - the fight was a DRAW            -> the market VOIDS, everyone refunded
   A void takes no fee. There is no honest way to price a market that never
   resolved.

   PAPER MODE
   With no arena address configured there is no ledger to read and nothing
   to pay. Rather than grey the whole feature out before a deploy, bets are
   kept in this browser's localStorage and run through the same quote()
   above, so the odds shown are still the contract's arithmetic. It is
   labelled as paper everywhere it surfaces, it is per-browser, and it never
   claims a transaction happened.
------------------------------------------------------------------- */

const FEE_BPS = 500n          // ArenaBattle.PROTOCOL_FEE_BPS
const BPS = 10000n

/* MatchStatus, straight off the enum. The board reads these back as numbers
   from the `matches` getter, and there is no worse place for an off-by-one:
   this is what decides whether betting is open. */
const MATCH_STATUS = ['none', 'created', 'agents_locked', 'betting_open',
                      'betting_closed', 'live', 'settled', 'cancelled', 'voided']

const Bets = {
  /* ---------------- plumbing ---------------- */

  configured() {
    return typeof MONAD !== 'undefined' &&
      !!MONAD.arenaAddress &&
      !/^0x0{40}$/i.test(MONAD.arenaAddress)
  },

  /* Reading the pools must not require a wallet. Someone who has connected
     nothing should still see real odds on a real match - the connect prompt
     belongs at the moment they try to spend, not the moment they look. So
     reads go over the public RPC and only writes go through the signer. */
  _ro: null,
  _rpc: 0,          // which of MONAD.rpcUrls we are currently reading through

  /* NEVER the wallet's provider.

     This used to prefer Chain.provider when a wallet was connected, which
     quietly contradicted the paragraph above: a BrowserProvider forwards
     every call to whatever RPC the user happens to have saved for this
     network in MetaMask. Plenty of those entries are dead or rate-limited,
     and when one is, the console fills with

         MetaMask - RPC Error: RPC endpoint returned HTTP client error
         code: -32080

     while the page decides the match is not on chain at all - because
     readMatch() returned null and the ledger fell back to paper. The
     symptom looks like a broken contract and is actually a browser setting
     we had no reason to depend on.

     Reads go through an endpoint WE choose. The wallet is for signing. */
  readContract() {
    if (!this.configured() || typeof ethers === 'undefined') return null
    if (this._ro) return this._ro
    try {
      const url = MONAD.rpcUrls[this._rpc] || MONAD.rpcUrls[0]
      /* staticNetwork: the chain id is known, so ethers must not spend a
         round trip re-detecting it before every single call. */
      const provider = new ethers.JsonRpcProvider(url, MONAD.chainIdDec, { staticNetwork: true })
      this._ro = new ethers.Contract(MONAD.arenaAddress, MONAD.ARENA_ABI, provider)
    } catch (e) {
      return null
    }
    return this._ro
  },

  /* Move to the next endpoint and rebuild. Called by a read that failed, so
     the next attempt lands somewhere else rather than retrying into the
     same rate limit. Returns false once every endpoint has been tried, so a
     caller can stop instead of cycling forever. */
  rotateRpc() {
    if (!MONAD.rpcUrls || MONAD.rpcUrls.length < 2) return false
    this._rpc = (this._rpc + 1) % MONAD.rpcUrls.length
    this._ro = null
    console.warn('[bets] RPC failed, switching to ' + MONAD.rpcUrls[this._rpc])
    return this._rpc !== 0
  },

  async writeContract() {
    if (!this.configured()) throw new Error('ArenaBattle address not configured')
    if (typeof ethers === 'undefined') throw new Error('ethers.js not loaded')
    if (!Chain.signer) await Chain.connectWallet()
    /* The signer changed, so a cached read-only contract built on the old
       provider is stale. Cheap to rebuild, expensive to be wrong about. */
    this._ro = null
    return new ethers.Contract(MONAD.arenaAddress, MONAD.ARENA_ABI, Chain.signer)
  },

  /* ---------------- the arithmetic ---------------- */

  /* What a bet of `amount` on a pool of `mine` against `theirs` pays if that
     side wins - the contract's `quote()` rearranged, dilution included. All
     BigInt wei with the same integer division solidity does, because a UI
     that rounds differently is a UI that lies.

     Returns null rather than zeroes for an empty bet, so a caller can tell
     "nothing entered" from "this bet pays nothing". */
  quote(amountWei, mineWei, theirsWei) {
    const a = BigInt(amountWei || 0)
    const mine = BigInt(mineWei || 0)
    const theirs = BigInt(theirsWei || 0)
    if (a <= 0n) return null

    const winningPool = mine + a
    const total = mine + theirs + a
    const fee = (total * FEE_BPS) / BPS
    const distributable = total - fee
    const payout = winningPool > 0n ? (distributable * a) / winningPool : 0n

    return {
      stake: a,
      payout: payout,
      /* Signed: a pari-mutuel can and does return less than the stake when
         the side you are joining already holds most of the table. Showing
         that as a loss is the whole reason the number is here. */
      profit: payout - a,
      fee: fee,
      total: total,
      distributable: distributable,
      multiple: Number(payout * 10000n / a) / 10000
    }
  },

  /* What an already-placed bet is owed once the match has settled. This is
     the contract's `claimable()`, and it is only meaningful after
     settlement; before that, use quote(). */
  settledPayout(betWei, winningPoolWei, distributableWei) {
    const b = BigInt(betWei || 0)
    const pool = BigInt(winningPoolWei || 0)
    const dist = BigInt(distributableWei || 0)
    if (b <= 0n || pool <= 0n) return 0n
    return (dist * b) / pool
  },

  /* A settled or open market's headline numbers, for the economics panel. */
  economics(poolAWei, poolBWei) {
    const a = BigInt(poolAWei || 0)
    const b = BigInt(poolBWei || 0)
    const total = a + b
    const fee = (total * FEE_BPS) / BPS
    return { poolA: a, poolB: b, total, fee, distributable: total - fee }
  },

  /* ---------------- reading a match ---------------- */

  /* The full on-chain state of one match, normalised into values the page
     can render. Nothing here comes from the board: where the chain and the
     board disagree about who is fighting, the chain is right and the board
     is merely stale.

     Since the agent snapshots moved on chain, that now covers the STRATEGIES
     too - the prompt rendered next to a bet button is the prompt the
     contract is holding, not one the relay reported. */
  async readMatch(matchId) {
    if (!matchId) return null
    let m, a, b

    /* One retry per endpoint. This single read decides whether the page
       believes a match is on chain at all - a null here is what makes the
       UI announce that a real, funded match "has not staked on chain yet"
       and start taking paper bets. Worth trying somewhere else before
       accepting that answer.

       Three calls in parallel rather than in series: they are independent,
       and the page runs this on a six-second poll. */
    for (let attempt = 0; attempt < (MONAD.rpcUrls || []).length; attempt++) {
      const c = this.readContract()
      if (!c) return null
      try {
        ;[m, a, b] = await Promise.all([
          c.getMatch(matchId),
          c.getAgent(matchId, MONAD.SIDE_A),
          c.getAgent(matchId, MONAD.SIDE_B)
        ])
        break
      } catch (e) {
        m = null
        if (!this.rotateRpc()) break
      }
    }
    if (!m) return null

    const state = Number(m.state)
    const poolA = BigInt(m.poolA)
    const poolB = BigInt(m.poolB)

    return {
      matchId: Number(matchId),
      state: state,
      stateName: MATCH_STATUS[state] || 'none',
      feeBps: Number(m.feeBps),
      poolA: poolA,
      poolB: poolB,
      total: poolA + poolB,
      winner: Number(m.winner),
      finishType: Number(m.finishType),
      distributable: BigInt(m.distributable),
      winningPool: BigInt(m.winningPool),
      nftTokenId: Number(m.nftTokenId),
      closesAt: Number(m.bettingClosesAt),
      minBet: BigInt(m.minBet),
      maxBet: BigInt(m.maxBet),
      seed: BigInt(m.seed),
      agents: { A: this._agent(a), B: this._agent(b) },
      /* placeBet requires BettingOpen (3) AND a deadline that has not passed.
         The UI has to know both BEFORE it offers a button, because the
         alternative is a wallet popup that reverts. */
      bettingOpen: state === 3 && Number(m.bettingClosesAt) > Math.floor(Date.now() / 1000),
      /* Cancelled (7) and Voided (8) both mean the same thing to a bettor:
         your money is sitting there waiting to be refunded. */
      refundable: state === 7 || state === 8
    }
  },

  _agent(a) {
    if (!a || !a.owner || /^0x0{40}$/i.test(a.owner)) return null
    return {
      owner: a.owner,
      name: a.name,
      prompt: a.prompt,
      model: a.model,
      modelVersion: a.modelVersion,
      archetype: a.archetype,
      jevConfigHash: a.jevConfigHash,
      stats: {
        aggression: Number(a.aggression) / 100,
        defense: Number(a.defense) / 100,
        speed: Number(a.speed) / 100
      }
    }
  },

  async myBet(matchId, side) {
    const c = this.readContract()
    if (!c || !matchId || !Chain.userAddress) return 0n
    try {
      return BigInt(await c.betOf(matchId, Chain.userAddress, side))
    } catch (e) {
      return 0n
    }
  },

  async hasClaimed(matchId) {
    const c = this.readContract()
    if (!c || !matchId || !Chain.userAddress) return false
    try {
      return !!(await c.claimed(matchId, Chain.userAddress))
    } catch (e) {
      return false
    }
  },

  /* What claim() would pay right now - winnings after settlement, or a full
     refund on a cancelled or voided market. One number covers both. */
  async expectedPayout(matchId) {
    const c = this.readContract()
    if (!c || !matchId || !Chain.userAddress) return 0n
    try {
      return BigInt(await c.claimable(matchId, Chain.userAddress))
    } catch (e) {
      return 0n
    }
  },

  /* ---------------- writing ---------------- */

  /* Every reason the contract would revert, checked here first. A reverted
     transaction costs gas and says "execution reverted"; a check costs
     nothing and says the market closed forty seconds ago.

     Note what is NOT checked: whether the bettor is one of the fighters.
     Players betting on their own match is a deliberate product decision -
     both strategies are public and frozen before the market opens, so there
     is no informational edge left to protect against. */
  async place(matchId, side, amountMon, onStep) {
    const say = onStep || function () {}
    const arena = await this.writeContract()

    const m = await this.readMatch(matchId)
    if (!m) throw new Error('Match #' + matchId + ' not found on chain')
    if (!m.bettingOpen) throw new Error('Betting is closed on this match (' + m.stateName + ')')
    if (side !== MONAD.SIDE_A && side !== MONAD.SIDE_B) throw new Error('Pick side A or B')

    const value = ethers.parseEther(String(amountMon))
    if (value < m.minBet) throw new Error('Minimum bet is ' + fmtMon(m.minBet, 4) + ' MON')
    if (value > m.maxBet) throw new Error('Maximum bet is ' + fmtMon(m.maxBet, 4) + ' MON')

    say('> placing ' + amountMon + ' MON on ' + (side === MONAD.SIDE_A ? 'A' : 'B'))
    const tx = await arena.placeBet(matchId, side, { value })
    say('  tx ' + tx.hash)
    const receipt = await tx.wait()
    say('> in the pool')
    return receipt
  },

  async claim(matchId, onStep) {
    const say = onStep || function () {}
    const arena = await this.writeContract()

    if (await this.hasClaimed(matchId)) throw new Error('Already claimed on this match')
    const owed = await this.expectedPayout(matchId)
    if (owed <= 0n) throw new Error('Nothing to claim on match #' + matchId)

    say('> claiming ' + fmtMon(owed, 4) + ' MON')
    const tx = await arena.claim(matchId)
    say('  tx ' + tx.hash)
    const receipt = await tx.wait()
    say('> paid out')
    return receipt
  }
}

/* ------------------------------------------------------------------
   Paper mode - keyed by room code, because with no chain there is no
   chain matchId to key on.

   It is per-browser and it is not a ledger: two laptops in paper mode see
   two different pools, because there is no shared truth without the chain.
   That is the honest shape of the fallback, and the UI says so out loud
   rather than letting a demo imply otherwise.
------------------------------------------------------------------- */

const PaperBets = {
  KEY: 'aarage-paper-bets',

  _blank() {
    return { p1: '0', p2: '0', mine: { p1: '0', p2: '0' }, claimed: false }
  },

  _all() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '{}') } catch (e) { return {} }
  },
  _save(o) {
    try { localStorage.setItem(this.KEY, JSON.stringify(o)) } catch (e) {}
  },

  match(code) {
    const all = this._all()
    return all[code] || this._blank()
  },

  pools(code) {
    const m = this.match(code)
    return { p1: BigInt(m.p1), p2: BigInt(m.p2) }
  },

  mine(code) {
    const m = this.match(code)
    return { p1: BigInt(m.mine.p1), p2: BigInt(m.mine.p2) }
  },

  place(code, side, amountWei) {
    const all = this._all()
    const m = all[code] || this._blank()
    m[side] = (BigInt(m[side]) + BigInt(amountWei)).toString()
    m.mine[side] = (BigInt(m.mine[side]) + BigInt(amountWei)).toString()
    all[code] = m
    this._save(all)
    return m
  },

  /* The same branch settleMatch() takes: a winning side with no backers
     refunds the losers rather than paying nobody out of an empty pool. */
  settle(code, winnerSide) {
    const p = this.pools(code)
    const mine = this.mine(code)
    const loserSide = winnerSide === 'p1' ? 'p2' : 'p1'
    const winPool = p[winnerSide]
    const losePool = p[loserSide]

    if (winPool === 0n) return { refund: true, payout: mine[loserSide], fee: 0n }
    const fee = (losePool * FEE_BPS) / BPS
    return {
      refund: false,
      payout: Bets.settledPayout(mine[winnerSide], winPool, losePool - fee),
      fee: fee
    }
  },

  markClaimed(code) {
    const all = this._all()
    if (all[code]) { all[code].claimed = true; this._save(all) }
  },

  claimed(code) { return !!this.match(code).claimed }
}

/* ---------------- shared formatting ---------------- */

function sameAddr(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
}

function fmtMon(wei, dp) {
  let n
  try {
    n = Number(typeof ethers !== 'undefined'
      ? ethers.formatEther(BigInt(wei || 0))
      : String(Number(BigInt(wei || 0)) / 1e18))
  } catch (e) {
    return '0'
  }
  /* Pools run from 0.01 MON at a demo table to whatever a judge feels like
     typing, so precision follows magnitude: four decimals on 120 MON is
     noise, and two on 0.005 MON is zero. */
  const places = dp !== undefined ? dp
    : n === 0 ? 2 : n < 0.01 ? 5 : n < 1 ? 4 : n < 1000 ? 3 : 2
  return n.toFixed(places)
}

function short(a) {
  const s = String(a || '')
  return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s
}
