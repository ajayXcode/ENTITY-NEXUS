/* ------------------------------------------------------------------
   blockchain.js - the Monad adapter.

   ONE RULE ABOVE ALL OTHERS

   This file never says a transaction happened when it did not. The previous
   version shipped a settlement path that sent `signature = '0x00'` and a
   hardcoded loser address, reported `tokenId: 1` regardless of what came
   back, and fell through to a simulated mint that produced a plausible-
   looking fake transaction hash. A demo that lies about being on chain is
   worse than a demo that admits it is a demo, because the second one can be
   fixed and the first one gets believed.

   So: DEMO mode exists, it is clearly labelled everywhere it surfaces, and
   it never invents a transaction hash. Real mode requires a deployed
   contract and a real arbiter signature, and if either is missing it says so
   instead of pretending.

   WHO SIGNS WHAT

     the browser   signs nothing about the result. It sends its own view of
                   the fight to the arbiter and asks for a settlement.
     the arbiter   (server.js) holds the settlement key, checks that both
                   sides reported the same digest, and returns an EIP-712
                   signature over the result.
     the contract  verifies that signature against the agents, seed and
                   simulation version it already holds.

   The browser is therefore never trusted with the outcome, which is the
   point: a player who patches this file can change what their own screen
   shows and nothing else.
------------------------------------------------------------------- */

const Chain = {
  provider: null,
  signer: null,
  userAddress: null,
  lastMint: null,
  lastSettlement: null,

  /* ---------------- availability ---------------- */

  hasWallet() {
    return typeof window !== 'undefined' && typeof window.ethereum !== 'undefined'
  },

  /* A configured address is the difference between "on Monad" and "a demo".
     Everything in this file branches on it, and nothing anywhere should
     claim a chain write without it. */
  configured() {
    return !!MONAD.arenaAddress && !/^0x0{40}$/i.test(MONAD.arenaAddress)
  },

  live() {
    return MONAD.USE_REAL_CHAIN && this.configured() && this.hasWallet()
  },

  /* Why the chain path is unavailable, in words a user can act on. */
  whyNotLive() {
    if (!this.hasWallet()) return 'no wallet detected - install MetaMask'
    if (!this.configured()) return 'contracts not deployed yet'
    if (!MONAD.USE_REAL_CHAIN) return 'live chain mode is off in js/config.js'
    return null
  },

  /* ---------------- wallet ---------------- */

  async connectWallet(onStep) {
    if (!this.hasWallet()) throw new Error('No Web3 wallet (e.g. MetaMask) detected.')
    if (this.signer && this.userAddress) return this.userAddress

    if (onStep) onStep('> requesting wallet connection...')
    await window.ethereum.request({ method: 'eth_requestAccounts' })

    this.provider = new ethers.BrowserProvider(window.ethereum)
    this.signer = await this.provider.getSigner()
    this.userAddress = await this.signer.getAddress()

    if (onStep) onStep('  wallet: ' + short(this.userAddress))
    await this.ensureMonadNetwork(onStep)
    return this.userAddress
  },

  async ensureMonadNetwork(onStep) {
    const current = await window.ethereum.request({ method: 'eth_chainId' })
    if (current.toLowerCase() === MONAD.chainIdHex.toLowerCase()) return

    if (onStep) onStep('> switching to Monad Testnet (10143)...')
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: MONAD.chainIdHex }]
      })
    } catch (err) {
      if (err.code === 4902) {
        if (onStep) onStep('> adding Monad Testnet to wallet...')
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: MONAD.chainIdHex,
            chainName: MONAD.chainName,
            rpcUrls: MONAD.rpcUrls,
            blockExplorerUrls: MONAD.blockExplorerUrls,
            nativeCurrency: MONAD.nativeCurrency
          }]
        })
      } else throw err
    }
    /* The provider caches the old network; rebuild or every later call goes
       to the chain the user just left. */
    this.provider = new ethers.BrowserProvider(window.ethereum)
    this.signer = await this.provider.getSigner()
  },

  /* ---------------- read-only wallet facts ----------------
     None of these sign anything and none of them is on the path to a
     fight. They exist so the wallet chip can show a person what their
     wallet actually holds instead of just a truncated address. */

  async monBalance(who) {
    const addr = who || this.userAddress
    if (!addr) return null
    const wei = await this._reader().getBalance(addr)
    return { wei, mon: ethers.formatEther(wei) }
  },

  async chainIdHex() {
    if (!this.hasWallet()) return null
    try { return await window.ethereum.request({ method: 'eth_chainId' }) } catch (e) { return null }
  },

  onMonad(hex) {
    return String(hex || '').toLowerCase() === MONAD.chainIdHex.toLowerCase()
  },

  /* Forgetting the session, nothing more. The injected provider owns which
     account it has selected; revoking that is best-effort, because older
     wallets do not implement it and a failure there must not look like a
     failure to disconnect. */
  disconnect() {
    this.signer = null
    this.userAddress = null
    this.lastMint = null
    this.lastSettlement = null
    try {
      if (this.hasWallet() && window.ethereum.request) {
        const p = window.ethereum.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }]
        })
        if (p && typeof p.catch === 'function') p.catch(() => {})
      }
    } catch (e) { /* not supported; the local session is already cleared */ }
  },

  arena(readOnly) {
    if (!this.configured()) throw new Error('ArenaBattle address not configured in js/config.js')
    const runner = readOnly ? this._reader() : this.signer
    return new ethers.Contract(MONAD.arenaAddress, MONAD.ARENA_ABI, runner)
  },

  nft() {
    return new ethers.Contract(MONAD.nftAddress, MONAD.NFT_ABI, this._reader())
  },

  /* Reads must work for a spectator with no wallet at all, so they go
     through a plain RPC provider rather than the injected one. */
  _reader() {
    if (this.provider) return this.provider
    if (!this._rpc) this._rpc = new ethers.JsonRpcProvider(MONAD.rpcUrls[0])
    return this._rpc
  },

  explorerTx(hash) {
    return MONAD.blockExplorerUrls[0] + '/tx/' + hash
  },

  explorerToken(tokenId) {
    return MONAD.blockExplorerUrls[0] + '/token/' + MONAD.nftAddress + '?a=' + tokenId
  },

  /* ==================================================================
     Match lifecycle
  ================================================================== */

  /**
   * Open a match on chain. Returns its id, read off the event rather than
   * assumed: nextMatchId increments inside the call, so the id is only ever
   * knowable from the receipt, and a guessed id is the coordinate every
   * spectator's money would be sent to.
   */
  async createMatch(onStep) {
    await this.connectWallet(onStep)
    const arena = this.arena()

    if (onStep) onStep('> createMatch(sim v' + MONAD.SIM_VERSION + ')...')
    const tx = await arena.createMatch(MONAD.SIM_VERSION)
    if (onStep) onStep('  tx: ' + tx.hash)
    const receipt = await tx.wait()

    const matchId = this._eventArg(receipt, arena, 'MatchCreated', 'matchId')
    if (!matchId) throw new Error('could not read matchId from receipt')
    if (onStep) onStep('  match #' + matchId + ' open')
    return Number(matchId)
  },

  /**
   * Freeze an agent on chain. This is the moment the strategy becomes public
   * and unchangeable, and everything a bettor is shown afterwards is read
   * back from here rather than from the relay.
   */
  async submitAgent(matchId, side, agent, onStep) {
    await this.connectWallet(onStep)
    const arena = this.arena()

    const snap = this.toSnapshot(agent, this.userAddress)
    if (onStep) onStep('> submitAgent(#' + matchId + ', ' + (side === MONAD.SIDE_A ? 'A' : 'B') + ')...')
    const tx = await arena.submitAgent(matchId, side, snap)
    const receipt = await tx.wait()

    const h = this._eventArg(receipt, arena, 'AgentSubmitted', 'snapshotHash')
    if (onStep) onStep('  snapshot ' + String(h).slice(0, 12) + '... locked')
    return h
  },

  /**
   * Build the on-chain Agent Snapshot from a parsed fighter.
   *
   * Everything that changes behaviour goes in, including the JEV config
   * hash. A prompt that reads the same while the advisor underneath was
   * swapped is exactly the substitution this is here to make impossible.
   */
  toSnapshot(agent, owner) {
    return {
      owner,
      name: String(agent.name || agent.archetype || 'Fighter').slice(0, 32),
      prompt: String(agent.prompt || '').slice(0, 280),
      model: String(agent.model || (typeof JEV !== 'undefined' ? JEV.modelId() : 'local')).slice(0, 64),
      modelVersion: String(agent.modelVersion || (typeof JEV !== 'undefined' ? JEV.modelVersion : 'builtin')).slice(0, 64),
      archetype: String(agent.archetype || 'Brawler').slice(0, 32),
      /* Padded, not passed straight through: JEV.configHash() is a 32-BIT
         fold ('0x' + 8 hex characters, see js/jev.js) and this struct field
         is bytes32. ethers refuses a short value rather than padding it
         itself, so the unpadded version made submitAgent throw before it
         ever reached the chain - which took the whole match with it. */
      jevConfigHash: typeof JEV !== 'undefined'
        ? ethers.zeroPadValue(JEV.configHash(), 32)
        : ethers.ZeroHash,
      aggression: Math.round(clamp01(agent.stats.aggression) * 100),
      defense: Math.round(clamp01(agent.stats.defense) * 100),
      speed: Math.round(clamp01(agent.stats.speed) * 100),
      simVersion: MONAD.SIM_VERSION
    }
  },

  async placeBet(matchId, side, amountMon, onStep) {
    await this.connectWallet(onStep)
    const arena = this.arena()
    const value = ethers.parseEther(String(amountMon))

    if (onStep) onStep('> placeBet(' + amountMon + ' MON on ' + (side === MONAD.SIDE_A ? 'A' : 'B') + ')...')
    const tx = await arena.placeBet(matchId, side, { value })
    if (onStep) onStep('  tx: ' + tx.hash)
    const receipt = await tx.wait()
    if (onStep) onStep('  bet confirmed on Monad')
    return receipt
  },

  async closeBetting(matchId, onStep) {
    await this.connectWallet(onStep)
    if (onStep) onStep('> closeBetting(#' + matchId + ')...')
    const tx = await this.arena().closeBetting(matchId)
    await tx.wait()
    if (onStep) onStep('  pool locked')
  },

  async claim(matchId, onStep) {
    await this.connectWallet(onStep)
    const arena = this.arena()

    const owed = await arena.claimable(matchId, this.userAddress)
    if (owed === 0n) throw new Error('nothing to claim on match #' + matchId)

    if (onStep) onStep('> claim(' + fmtMon(owed, 4) + ' MON)...')
    const tx = await arena.claim(matchId)
    const receipt = await tx.wait()
    if (onStep) onStep('  paid. tx: ' + receipt.hash)
    return { amount: owed, txHash: receipt.hash, explorer: this.explorerTx(receipt.hash) }
  },

  /* ==================================================================
     Settlement

     The browser never signs the result. It reports what it saw to the
     arbiter, receives a signature or a refusal, and relays the signed
     settlement to the contract.
  ================================================================== */

  /**
   * @param result {matchId, winner (1|2|0), finishType, resultDigest,
   *                decisionHash, seed}
   */
  async settle(matchId, result, onStep) {
    if (!this.live()) {
      const why = this.whyNotLive()
      if (onStep) onStep('! settlement unavailable: ' + why)
      return { settled: false, demo: true, reason: why }
    }

    await this.connectWallet(onStep)
    const arena = this.arena()

    const m = await arena.getMatch(matchId)
    if (Number(m.state) !== 5) {
      throw new Error('match #' + matchId + ' is ' + MONAD.STATE[Number(m.state)] + ', not live')
    }

    if (onStep) onStep('> asking arbiter to sign the result...')
    const signed = await this._requestSignature(matchId, result, m)
    if (!signed || !signed.signature) {
      throw new Error(signed && signed.error ? signed.error : 'arbiter declined to sign')
    }
    if (onStep) onStep('  arbiter signed ' + String(signed.signature).slice(0, 14) + '...')

    if (onStep) onStep('> settleMatch() on Monad...')
    const tx = await arena.settleMatch(signed.settlement, signed.signature)
    if (onStep) onStep('  tx: ' + tx.hash)
    const receipt = await tx.wait()

    /* Read the outcome back off the log. A void looks nothing like a win and
       reporting one as the other would be the same class of lie as the fake
       mint this file used to do. */
    const voided = this._event(receipt, arena, 'MatchVoided')
    if (voided) {
      const out = { settled: true, voided: true, reason: voided.args.reason, txHash: receipt.hash, explorer: this.explorerTx(receipt.hash) }
      if (onStep) onStep('> market VOIDED: ' + out.reason, true)
      this.lastSettlement = out
      return out
    }

    const settled = this._event(receipt, arena, 'MatchSettled')
    const tokenId = settled ? Number(settled.args.nftTokenId) : 0
    const out = {
      settled: true,
      voided: false,
      demo: false,
      winner: settled ? Number(settled.args.winner) : result.winner,
      totalPool: settled ? settled.args.totalPool : 0n,
      fee: settled ? settled.args.fee : 0n,
      distributable: settled ? settled.args.distributable : 0n,
      tokenId,
      txHash: receipt.hash,
      explorer: this.explorerTx(receipt.hash),
      tokenUrl: tokenId ? this.explorerToken(tokenId) : null
    }

    if (onStep) {
      onStep('> settled on Monad. NFT #' + tokenId + ' minted to the winner.', true)
    }
    this.lastSettlement = out
    this.lastMint = tokenId ? { tokenId, txHash: receipt.hash, explorer: out.explorer, simulated: false } : null
    return out
  },

  async _requestSignature(matchId, result, m) {
    const res = await fetch('/api/arena/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        matchId: String(matchId),
        winner: result.winner,
        finishType: result.finishType,
        resultDigest: result.resultDigest,
        decisionHash: result.decisionHash,
        seed: m.seed.toString(),
        agentAHash: await this.arena(true).agentHash(matchId, MONAD.SIDE_A),
        agentBHash: await this.arena(true).agentHash(matchId, MONAD.SIDE_B),
        simVersion: MONAD.SIM_VERSION,
        chainId: MONAD.chainIdDec,
        arena: MONAD.arenaAddress
      })
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return { error: body.error || ('arbiter returned ' + res.status) }
    }
    return res.json()
  },

  /* ==================================================================
     Reads
  ================================================================== */

  async readMatch(matchId) {
    const arena = this.arena(true)
    const [m, a, b] = await Promise.all([
      arena.getMatch(matchId),
      arena.getAgent(matchId, MONAD.SIDE_A),
      arena.getAgent(matchId, MONAD.SIDE_B)
    ])
    return {
      matchId,
      state: MONAD.STATE[Number(m.state)],
      stateIndex: Number(m.state),
      feeBps: Number(m.feeBps),
      poolA: m.poolA,
      poolB: m.poolB,
      closesAt: Number(m.bettingClosesAt),
      seed: m.seed,
      winner: Number(m.winner),
      finishType: Number(m.finishType),
      distributable: m.distributable,
      winningPool: m.winningPool,
      nftTokenId: Number(m.nftTokenId),
      minBet: m.minBet,
      maxBet: m.maxBet,
      agents: { A: this._agent(a), B: this._agent(b) }
    }
  },

  _agent(a) {
    if (!a || a.owner === ethers.ZeroAddress) return null
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

  async myBets(matchId, who) {
    const arena = this.arena(true)
    const addr = who || this.userAddress
    if (!addr) return { A: 0n, B: 0n, claimed: false, claimable: 0n }
    const [A, B, cl, owed] = await Promise.all([
      arena.betOf(matchId, addr, MONAD.SIDE_A),
      arena.betOf(matchId, addr, MONAD.SIDE_B),
      arena.claimed(matchId, addr),
      arena.claimable(matchId, addr)
    ])
    return { A, B, claimed: cl, claimable: owed }
  },

  /* ==================================================================
     Receipt helpers
  ================================================================== */

  _event(receipt, contract, name) {
    if (!receipt || !receipt.logs) return null
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log)
        if (parsed && parsed.name === name) return parsed
      } catch (e) { /* a log from another contract; not ours to read */ }
    }
    return null
  },

  _eventArg(receipt, contract, name, arg) {
    const e = this._event(receipt, contract, name)
    return e ? e.args[arg] : null
  }
}
