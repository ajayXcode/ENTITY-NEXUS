/* ------------------------------------------------------------------
   house/chain.js - the house's own hands on ArenaBattle.

   The director decides WHEN a house match moves; this file is the only
   place that makes it move on chain. It is deliberately thin and it holds
   no policy: every argument it sends was decided elsewhere, and everything
   it returns is read back off the contract rather than assumed from the
   transaction it just sent.

   WHOSE KEY THIS IS

   The arbiter's. That is not a convenience - the contract requires it.
   lockAgents, openBetting and startMatch are all onlyArbiter, so a separate
   house wallet would need the arbiter to co-sign every cycle anyway. What
   it does mean is that the arbiter account pays gas for the floor, and that
   it is the `creator` and the `owner` of both agent snapshots on a house
   match. ArenaBattle explicitly allows one address to own both sides -
   "that is a legitimate solo demo" (submitAgent, ArenaBattle.sol) - and the
   betting rules do not care who is fighting.

   WHAT IT STILL CANNOT DO, WHICH IS THE POINT

   Nothing here can move a pool. There is no withdrawal path on this
   contract for the arbiter, spectator payouts are pull-based, and the seed
   this file reads back in closeAndStart() was computed by the contract out
   of blockhash(closedAtBlock) and the final pool sizes - not supplied by
   this process. The house can start a fight. It cannot aim one.

   FAILURE IS A DEGRADED FLOOR, NEVER A FAKE ONE

   Every method throws on failure and the director catches it into paper
   mode. What must never happen is a half-state that still looks live:
   openHouseMatch() returns a matchId only once betting is genuinely open,
   because the browser reads that matchId before it will spend anything
   (js/betting.js), and a matchId for a match that is not accepting bets
   would send a spectator's MON into a revert.
------------------------------------------------------------------- */

const fs = require('fs')
const path = require('path')

const { confirmTx } = require('./txwait.js')

let ethers = null
try {
  ethers = require('ethers')
} catch (e) {
  /* Same posture as arbiter.js: without it the floor runs on paper and
     says so, rather than pretending to settle. */
}

/* Only what the house itself sends or reads. The arbiter keeps its own copy
   of the fragments it needs; these are the additional ones - creating a
   match, putting the agents on chain, and closing the market. */
const ARENA_ABI = [
  'function createMatch(uint32 simVersion) external returns (uint256)',
  'function submitAgent(uint256 matchId, uint8 side, (address owner, string name, string prompt, string model, string modelVersion, string archetype, bytes32 jevConfigHash, uint8 aggression, uint8 defense, uint8 speed, uint32 simVersion) snap) external',
  'function closeBetting(uint256 matchId) external',
  'function cancelMatch(uint256 matchId) external',
  'function settleMatch((uint256 matchId, bytes32 agentAHash, bytes32 agentBHash, uint256 seed, uint8 winner, uint8 finishType, bytes32 resultDigest, bytes32 decisionHash, uint32 simVersion) s, bytes signature) external',
  'function getMatch(uint256 matchId) external view returns ((uint8 state, uint16 feeBps, uint32 simVersion, address creator, uint64 createdAt, uint64 bettingClosesAt, uint64 closedAtBlock, uint64 settledAt, uint256 minBet, uint256 maxBet, bytes32 seedCommit, uint256 seed, uint256 poolA, uint256 poolB, uint8 winner, uint8 finishType, uint256 distributable, uint256 winningPool, uint256 paidOut, uint256 nftTokenId))',
  'function agentHash(uint256 matchId, uint8 side) external view returns (bytes32)',
  'event MatchCreated(uint256 indexed matchId, address indexed creator, uint16 feeBps, uint32 simVersion, uint256 minBet, uint256 maxBet)'
]

const SIDE_A = 1
const SIDE_B = 2

/* MatchState, mirrored from ArenaBattle.sol. Named rather than inlined
   because these were wrong here once: BettingOpen is 3, and a hardcoded 2
   silently skipped closeBetting entirely, so startMatch then reverted with
   "betting not closed" and the match stranded in an open market. A number
   that is off by one against a contract enum fails far away from the
   mistake, which is exactly the kind that deserves a name. */
const STATE = {
  NONE: 0,
  CREATED: 1,
  AGENTS_LOCKED: 2,
  BETTING_OPEN: 3,
  BETTING_CLOSED: 4,
  LIVE: 5,
  SETTLED: 6,
  CANCELLED: 7,
  VOIDED: 8
}

/* Must match MONAD.SIM_VERSION in js/config.js. The contract rejects a
   settlement whose simVersion differs from the one the match was created
   with, which is exactly the check that stops a fight being settled under
   rules it was not fought under. */
const SIM_VERSION = 1

/* How long the market stays open on chain.

   This MUST NOT exceed the director's own betting phase (PHASE.betting in
   house/director.js). closeBetting is gated on block.timestamp >=
   bettingClosesAt and is deliberately not something the arbiter may rush -
   "an arbiter who could close the instant the pools looked favourable would
   be choosing the odds" (ArenaBattle.sol). So a window longer than the
   phase means every close reverts, the seed never arrives, and the match
   never settles.

   It is set slightly SHORTER than the phase instead, and closeAndStart
   below waits on the contract's clock rather than this process's - server
   time and chain time are not the same clock and only one of them is
   authoritative here. */
const BETTING_WINDOW_SECONDS = 50

function deployedArena(root) {
  try {
    const f = path.join(root, 'contracts', 'deployments.10143.json')
    if (!fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf8')).arenaAddress || null
  } catch (e) {
    return null
  }
}

function makeHouseChain({ root, arbiter, jevConfigHash }) {
  const arenaAddress = process.env.ARENA_ADDRESS || deployedArena(root)
  const chainId = Number(process.env.MONAD_CHAIN_ID || 10143)
  const rpc = process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz'

  /* One transaction at a time across the whole floor. Eight tables sharing
     one key would otherwise race for the same nonce and most of them would
     fail; ethers does not serialise this for us. A promise chain is enough
     here - the floor sends a handful of transactions a minute, not a
     stream. */
  let queue = Promise.resolve()
  function serial(fn) {
    const next = queue.then(fn, fn)
    /* Keep the chain alive after a rejection, but let the caller see it. */
    queue = next.then(() => {}, () => {})
    return next
  }

  /* ONE provider for the life of the process, not one per call.

     This was a real bug and worth naming: contract() used to build a fresh
     JsonRpcProvider every time. That was harmless while the only callers
     were a handful of transactions per match - and then the market poller
     arrived, reading the pools every few seconds for every open table, and
     each read minted another provider. ethers keeps a background poller on
     each one, so they accumulate: nothing is ever released, the public RPC
     sees a steadily growing number of clients from one process, and the
     transactions that matter start failing behind the rate limit. The
     symptom was a match stuck in BettingOpen whose closeBetting never
     landed, which looks nothing like "too many providers".

     One provider, one contract, built on first use. */
  let _cached = null
  function contract() {
    if (!ethers) throw new Error('ethers is not installed')
    if (!arbiter || !arbiter.enabled()) throw new Error('arbiter is not configured')
    if (!arenaAddress || !/^0x[0-9a-fA-F]{40}$/.test(arenaAddress)) {
      throw new Error('no arena address - set ARENA_ADDRESS or commit contracts/deployments.10143.json')
    }
    if (_cached) return _cached
    /* staticNetwork: the chain id is known and fixed, so ethers must not
       re-detect it on every call - that is an extra RPC round trip per
       read, and on a flaky endpoint it is an extra way to fail. */
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true })
    _cached = new ethers.Contract(arenaAddress, ARENA_ABI, arbiter.wallet.connect(provider))
    return _cached
  }

  /* The same shape js/blockchain.js toSnapshot() builds, field for field.
     It has to be: agentHash is computed over these fields by AgentTypes.hash
     and folded into the settlement signature, so a snapshot that differs
     from the browser's in any respect would be a different fighter from the
     one on screen. */
  function toSnapshot(agent, owner) {
    const pct = (v) => Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100)))
    return {
      owner: owner,
      name: String(agent.archetype || 'Fighter').slice(0, 32),
      prompt: String(agent.prompt || '').slice(0, 280),
      model: String(agent.model || 'house').slice(0, 64),
      modelVersion: String(agent.modelVersion || 'builtin').slice(0, 64),
      archetype: String(agent.archetype || 'Brawler').slice(0, 32),
      /* JEV.configHash() is a 32-BIT fold ('0x' + 8 hex, see js/jev.js), and
         the struct field is bytes32. Left-padding is not cosmetic: ethers
         rejects a short value outright, so an unpadded hash means
         submitAgent never reaches the chain at all. Right-aligned, which is
         what zeroPadValue does and what the browser now does too. */
      jevConfigHash: padHash(jevConfigHash()),
      aggression: pct(agent.stats.aggression),
      defense: pct(agent.stats.defense),
      speed: pct(agent.stats.speed),
      simVersion: SIM_VERSION
    }
  }

  function padHash(h) {
    if (!h) return ethers.ZeroHash
    try { return ethers.zeroPadValue(h, 32) } catch (e) { return ethers.ZeroHash }
  }

  return {
    ready() {
      return !!(ethers && arbiter && arbiter.enabled() && arenaAddress)
    },

    /* WHY the chain is off, in words an operator can act on.

       ready() is three conditions ANDed together, and on a fresh
       deployment "the floor is running on paper" is the same sentence for
       all three - a missing dependency, a missing key and a missing
       address look identical from the outside. That ambiguity costs more
       time than the check is worth, so this names the one that is
       actually wrong. */
    whyNotReady() {
      if (!ethers) return 'ethers is not installed (npm install did not run?)'
      if (!arbiter || !arbiter.wallet) {
        return 'no valid ARBITER_PRIVATE_KEY - set it in the environment. ' +
          'A truncated paste is the usual cause: it must be 64 hex characters ' +
          '(66 with the 0x), and the address it derives must be the one ' +
          'ArenaBattle holds as `arbiter`'
      }
      if (!arenaAddress) {
        return 'no arena address - set ARENA_ADDRESS, or commit ' +
          'contracts/deployments.10143.json'
      }
      return null
    },

    address() {
      return arbiter && arbiter.wallet ? arbiter.wallet.address : ''
    },

    arenaAddress() { return arenaAddress || '' },
    chainId() { return chainId },

    /* The pools and the clock, read straight off the contract. This is the
       gate: a match starts only when BOTH pools are non-zero, and that is
       decided by these numbers, never by anything a browser reported. */
    async pools(matchId) {
      const arena = contract()
      /* Both reads in flight together: this runs on a poll loop for every
         open market, so halving its round trips is halving the load the
         floor puts on the RPC. */
      const [m, block] = await Promise.all([
        arena.getMatch(matchId),
        arena.runner.provider.getBlock('latest')
      ])
      return {
        state: Number(m.state),
        poolA: BigInt(m.poolA),
        poolB: BigInt(m.poolB),
        closesAt: Number(m.bettingClosesAt),
        now: Number(block.timestamp),
        backed: BigInt(m.poolA) > 0n && BigInt(m.poolB) > 0n
      }
    },

    /* Abandon an open market. The arbiter is authorised to cancel during
       BettingOpen (ArenaBattle.cancelMatch), and Cancelled means every bet
       is refundable through claim() - nobody's MON is ever stranded by the
       house walking away from a market nobody joined. */
    async cancel(matchId) {
      return serial(async () => {
        const arena = contract()
        const tx = await arena.cancelMatch(matchId)
        const r = await confirmTx(tx)
        return { txHash: r.hash }
      })
    },

    /* create -> submit both agents -> lock + commit seed -> open betting.
       Returns only once the market is genuinely open. `windowSeconds` is
       how long the contract keeps the market open; the caller decides,
       because a house table and a player room want different clocks. */
    async openHouseMatch(agentA, agentB, windowSeconds) {
      return serial(async () => {
        const arena = contract()
        const owner = arbiter.wallet.address

        const created = await arena.createMatch(SIM_VERSION)
        const receipt = await confirmTx(created)

        /* The matchId is read out of the event rather than guessed from a
           local counter: two processes pointed at one deployment would
           otherwise both think they owned the same id. */
        let matchId = 0
        for (const log of receipt.logs) {
          try {
            const parsed = arena.interface.parseLog(log)
            if (parsed && parsed.name === 'MatchCreated') {
              matchId = Number(parsed.args.matchId)
              break
            }
          } catch (e) { /* not one of ours */ }
        }
        if (!matchId) throw new Error('createMatch produced no MatchCreated event')

        const subA = await arena.submitAgent(matchId, SIDE_A, toSnapshot(agentA, owner))
        await confirmTx(subA)
        const subB = await arena.submitAgent(matchId, SIDE_B, toSnapshot(agentB, owner))
        await confirmTx(subB)

        /* lockAgents + openBetting, through the arbiter's own helper so the
           seed commitment is made in exactly the same place and at exactly
           the same moment it is for a player match. */
        await arbiter.lockAndOpen(arenaAddress, matchId,
          Math.max(15, Number(windowSeconds) || BETTING_WINDOW_SECONDS))

        return { matchId, arena: arenaAddress, chainId }
      })
    },

    /* closeBetting is permissionless and on a clock, so it can legitimately
       already have been called by someone else - a spectator's page, a
       watcher, anyone. That is not an error, and treating it as one would
       strand the match. */
    async closeAndStart(matchId) {
      return serial(async () => {
        const arena = contract()

        let m = await arena.getMatch(matchId)

        /* Anything past BettingOpen has already been closed by someone
           else, which is legitimate - closeBetting is permissionless
           precisely so a stalled arbiter cannot strand a market. */
        if (Number(m.state) === STATE.BETTING_OPEN) {
          /* Wait on the CONTRACT's clock, not this process's. The two are
             not the same clock, and the contract's is the one that decides
             whether the call reverts. */
          const block = await arena.runner.provider.getBlock('latest')
          const waitMs = (Number(m.bettingClosesAt) - Number(block.timestamp) + 1) * 1000
          if (waitMs > 0) {
            await new Promise((r) => setTimeout(r, Math.min(waitMs, 120000)))
          }

          try {
            const close = await arena.closeBetting(matchId)
            await confirmTx(close)
          } catch (err) {
            m = await arena.getMatch(matchId)
            /* BettingClosed or later means the job is done and the revert
               was just a race with whoever got there first. */
            if (Number(m.state) < STATE.BETTING_CLOSED) throw err
          }
        }

        /* startMatch must land at least one block after the close, because
           blockhash(currentBlock) is always zero and the seed is mixed from
           blockhash(closedAtBlock). Two separate transactions are already
           two different blocks, so this is a guarantee rather than a wait -
           but it is the reason they are not batched. */
        const out = await arbiter.start(arenaAddress, matchId)
        return { seed: out.seed, txHash: out.txHash }
      })
    },

    /* Ask the arbiter to sign, then send the settlement. The signature and
       the send are separate on purpose: the arbiter validates and can
       refuse, and a refusal must not look like a failed transaction. */
    async settleHouseMatch(matchId, result) {
      return serial(async () => {
        const arena = contract()

        const agentAHash = await arena.agentHash(matchId, SIDE_A)
        const agentBHash = await arena.agentHash(matchId, SIDE_B)
        const m = await arena.getMatch(matchId)

        /* p1 is side A everywhere: the board, the advisor and the contract
           all use that mapping (see the jevSide note in startFight). */
        const winner = result.winner === 'p1' ? SIDE_A : (result.winner === 'p2' ? SIDE_B : 0)
        const finishType = result.how === 'KO' ? 1 : 2

        /* The digest binds the settlement to the fight's actual numbers, so
           a signature for one outcome cannot be replayed onto another. */
        const resultDigest = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint256', 'uint8', 'uint8', 'uint32', 'uint32', 'uint32'],
            [matchId, winner, finishType, result.frames, result.hpA, result.hpB]
          )
        )

        const signed = await arbiter.sign({
          matchId: String(matchId),
          arena: arenaAddress,
          chainId: chainId,
          agentAHash, agentBHash,
          seed: m.seed.toString(),
          winner, finishType,
          resultDigest,
          decisionHash: result.decisionHash || ethers.ZeroHash,
          simVersion: SIM_VERSION
        })
        if (signed.error) throw new Error('arbiter refused to sign: ' + signed.error)

        const tx = await arena.settleMatch(signed.settlement, signed.signature)
        const r = await confirmTx(tx)
        return { txHash: r.hash }
      })
    }
  }
}

module.exports = { makeHouseChain, SIM_VERSION, SIDE_A, SIDE_B, STATE }
