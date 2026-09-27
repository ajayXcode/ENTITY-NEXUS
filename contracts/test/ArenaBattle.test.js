const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

/* ------------------------------------------------------------------
   ArenaBattle v2

   The suite is organised around the one invariant the contract exists to
   hold: once betting opens, nothing a player controls can change the
   economic identity of either agent or the rules of the match. Most of what
   follows is an attempt to break that from a different angle.

   The payout arithmetic is checked against numbers computed by hand rather
   than by re-running the contract's own formula in JavaScript - a test that
   reimplements the code under test agrees with its bugs.
------------------------------------------------------------------- */

const SIDE_A = 1;
const SIDE_B = 2;
const SIDE_NONE = 0;

const FINISH_KO = 1;
const FINISH_TIMEOUT = 2;
const FINISH_DRAW = 3;

const STATE = {
  None: 0, Created: 1, AgentsLocked: 2, BettingOpen: 3, BettingClosed: 4,
  Live: 5, Settled: 6, Cancelled: 7, Voided: 8
};

const SIM = 1;
const WINDOW = 3600;
const FEE_BPS = 500n;
const BPS = 10000n;

const coder = ethers.AbiCoder.defaultAbiCoder();
const mon = (n) => ethers.parseEther(String(n));

/* The seed preimage the arbiter commits to before betting opens. */
const PREIMAGE = 0x5eedn;
const SEED_COMMIT = ethers.keccak256(coder.encode(["uint256"], [PREIMAGE]));

const SETTLEMENT_TYPES = {
  Settlement: [
    { name: "matchId", type: "uint256" },
    { name: "agentAHash", type: "bytes32" },
    { name: "agentBHash", type: "bytes32" },
    { name: "seed", type: "uint256" },
    { name: "winner", type: "uint8" },
    { name: "finishType", type: "uint8" },
    { name: "resultDigest", type: "bytes32" },
    { name: "decisionHash", type: "bytes32" },
    { name: "simVersion", type: "uint32" }
  ]
};

function agentFor(addr, overrides = {}) {
  return {
    owner: addr,
    name: "Ronin",
    prompt: "Play defensively and punish overextension.",
    model: "jev-gemini-3.6-flash",
    modelVersion: "2026-05-01",
    archetype: "Counterpuncher",
    jevConfigHash: ethers.keccak256(ethers.toUtf8Bytes("jev-config-v1")),
    aggression: 40,
    defense: 80,
    speed: 55,
    simVersion: SIM,
    ...overrides
  };
}

describe("ArenaBattle v2", function () {
  let nft, arena, owner, arbiter, playerA, playerB, alice, bob, carol, outsider;
  let domain;

  beforeEach(async function () {
    [owner, arbiter, playerA, playerB, alice, bob, carol, outsider] = await ethers.getSigners();

    const NFT = await ethers.getContractFactory("FighterNFT");
    nft = await NFT.deploy(owner.address);
    await nft.waitForDeployment();

    const Arena = await ethers.getContractFactory("ArenaBattle");
    arena = await Arena.deploy(await nft.getAddress(), arbiter.address, owner.address);
    await arena.waitForDeployment();

    await nft.connect(owner).setArenaContract(await arena.getAddress());

    domain = {
      name: "AARAGE ArenaBattle",
      version: "2",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await arena.getAddress()
    };
  });

  /* ---------------- helpers ---------------- */

  async function createWithAgents(agentAOverrides = {}, agentBOverrides = {}) {
    const tx = await arena.connect(playerA).createMatch(SIM);
    await tx.wait();
    const matchId = (await arena.nextMatchId()) - 1n;

    await arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address, agentAOverrides));
    await arena.connect(playerB).submitAgent(matchId, SIDE_B, agentFor(playerB.address, {
      name: "Kenji", archetype: "Pressure", aggression: 85, defense: 30, speed: 70, ...agentBOverrides
    }));
    return matchId;
  }

  async function openMarket(overridesA, overridesB) {
    const matchId = await createWithAgents(overridesA, overridesB);
    await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
    await arena.connect(arbiter).openBetting(matchId, WINDOW);
    return matchId;
  }

  async function goLive(matchId) {
    await time.increase(WINDOW + 1);
    await arena.closeBetting(matchId);
    await arena.connect(arbiter).startMatch(matchId, PREIMAGE);
  }

  async function signSettlement(matchId, winner, finishType = FINISH_KO, overrides = {}, signer = arbiter) {
    const m = await arena.getMatch(matchId);
    const value = {
      matchId,
      agentAHash: await arena.agentHash(matchId, SIDE_A),
      agentBHash: await arena.agentHash(matchId, SIDE_B),
      seed: m.seed,
      winner,
      finishType,
      resultDigest: ethers.keccak256(ethers.toUtf8Bytes("result")),
      decisionHash: ethers.keccak256(ethers.toUtf8Bytes("decisions")),
      simVersion: SIM,
      ...overrides
    };
    const signature = await signer.signTypedData(domain, SETTLEMENT_TYPES, value);
    return { value, signature };
  }

  async function settle(matchId, winner, finishType = FINISH_KO) {
    const { value, signature } = await signSettlement(matchId, winner, finishType);
    return arena.connect(outsider).settleMatch(value, signature);
  }

  /* ================================================================
     Configuration
  ================================================================ */

  describe("deployment", function () {
    it("wires the arena, arbiter and owner", async function () {
      expect(await arena.arbiter()).to.equal(arbiter.address);
      expect(await arena.owner()).to.equal(owner.address);
      expect(await nft.arenaContract()).to.equal(await arena.getAddress());
      expect(await arena.feeBps()).to.equal(500);
    });

    it("rejects zero addresses", async function () {
      const Arena = await ethers.getContractFactory("ArenaBattle");
      await expect(Arena.deploy(ethers.ZeroAddress, arbiter.address, owner.address))
        .to.be.revertedWith("Arena: zero NFT");
      await expect(Arena.deploy(await nft.getAddress(), ethers.ZeroAddress, owner.address))
        .to.be.revertedWith("Arena: zero arbiter");
    });

    it("refuses direct deposits", async function () {
      await expect(alice.sendTransaction({ to: await arena.getAddress(), value: mon(1) }))
        .to.be.revertedWith("Arena: direct deposits disabled");
    });
  });

  /* ================================================================
     Agent snapshots  (spec 5, 16, 23.21)
  ================================================================ */

  describe("agent snapshots", function () {
    it("records both agents and their hashes", async function () {
      const matchId = await createWithAgents();
      const a = await arena.getAgent(matchId, SIDE_A);
      expect(a.owner).to.equal(playerA.address);
      expect(a.prompt).to.equal("Play defensively and punish overextension.");
      expect(await arena.agentHash(matchId, SIDE_A)).to.not.equal(ethers.ZeroHash);
      expect(await arena.agentHash(matchId, SIDE_A)).to.not.equal(await arena.agentHash(matchId, SIDE_B));
    });

    it("stores the strategy publicly on chain before betting opens", async function () {
      const matchId = await openMarket();
      // A spectator with nothing but the chain can read both strategies.
      const a = await arena.getAgent(matchId, SIDE_A);
      const b = await arena.getAgent(matchId, SIDE_B);
      expect(a.prompt.length).to.be.greaterThan(0);
      expect(b.prompt.length).to.be.greaterThan(0);
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.BettingOpen);
    });

    it("only the agent owner may submit it", async function () {
      const tx = await arena.connect(playerA).createMatch(SIM);
      await tx.wait();
      const matchId = (await arena.nextMatchId()) - 1n;
      await expect(arena.connect(playerB).submitAgent(matchId, SIDE_A, agentFor(playerA.address)))
        .to.be.revertedWith("Arena: not agent owner");
    });

    it("refuses to overwrite a submitted side", async function () {
      const matchId = await createWithAgents();
      await expect(arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address)))
        .to.be.revertedWith("Arena: side taken");
    });

    it("cannot submit once agents are locked", async function () {
      const matchId = await createWithAgents();
      await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
      await expect(arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address)))
        .to.be.revertedWith("Arena: agents not open");
    });

    it("rejects an agent built against a different simulation version", async function () {
      const tx = await arena.connect(playerA).createMatch(SIM);
      await tx.wait();
      const matchId = (await arena.nextMatchId()) - 1n;
      await expect(
        arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address, { simVersion: 99 }))
      ).to.be.revertedWith("Arena: sim version mismatch");
    });

    it("bounds prompt, name and stats", async function () {
      const tx = await arena.connect(playerA).createMatch(SIM);
      await tx.wait();
      const matchId = (await arena.nextMatchId()) - 1n;

      await expect(arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address, { prompt: "" })))
        .to.be.revertedWith("Agent: bad prompt");
      await expect(arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address, { prompt: "x".repeat(281) })))
        .to.be.revertedWith("Agent: bad prompt");
      await expect(arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address, { aggression: 101 })))
        .to.be.revertedWith("Agent: stats out of range");
      await expect(arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address, { name: "" })))
        .to.be.revertedWith("Agent: bad name");
    });

    it("a changed hidden field changes the snapshot hash", async function () {
      /* The attack this defends against: identical visible prompt, different
         model version underneath. Two agents that look the same to a bettor
         must not hash the same. */
      const m1 = await createWithAgents();
      const m2 = await createWithAgents({}, {});
      expect(await arena.agentHash(m1, SIDE_A)).to.equal(await arena.agentHash(m2, SIDE_A));

      const tx = await arena.connect(playerA).createMatch(SIM);
      await tx.wait();
      const m3 = (await arena.nextMatchId()) - 1n;
      await arena.connect(playerA).submitAgent(m3, SIDE_A, agentFor(playerA.address, { modelVersion: "2026-09-01" }));
      expect(await arena.agentHash(m3, SIDE_A)).to.not.equal(await arena.agentHash(m1, SIDE_A));
    });

    it("cannot lock with only one agent", async function () {
      const tx = await arena.connect(playerA).createMatch(SIM);
      await tx.wait();
      const matchId = (await arena.nextMatchId()) - 1n;
      await arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address));
      await expect(arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT))
        .to.be.revertedWith("Arena: agents incomplete");
    });

    it("only the arbiter can lock agents or open betting", async function () {
      const matchId = await createWithAgents();
      await expect(arena.connect(playerA).lockAgents(matchId, SEED_COMMIT))
        .to.be.revertedWith("Arena: not arbiter");
      await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
      await expect(arena.connect(playerA).openBetting(matchId, WINDOW))
        .to.be.revertedWith("Arena: not arbiter");
    });
  });

  /* ================================================================
     Fee locking  (spec 10)
  ================================================================ */

  describe("fee locking", function () {
    it("snapshots fee and bet bounds at creation", async function () {
      const matchId = await openMarket();
      const m = await arena.getMatch(matchId);
      expect(m.feeBps).to.equal(500);
      expect(m.minBet).to.equal(mon("0.001"));
    });

    it("an owner cannot re-price a market that already exists", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(60) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(40) });

      // Owner tries to take 10% after the crowd has deposited at 5%.
      await arena.connect(owner).setParams(1000, mon("0.001"), mon(1000));
      expect((await arena.getMatch(matchId)).feeBps).to.equal(500);

      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const m = await arena.getMatch(matchId);
      expect(m.distributable).to.equal(mon(95));   // still 5%, not 10%
      expect(await arena.accumulatedFees()).to.equal(mon(5));
    });

    it("new matches do pick up the new fee", async function () {
      await arena.connect(owner).setParams(250, mon("0.001"), mon(1000));
      const matchId = await openMarket();
      expect((await arena.getMatch(matchId)).feeBps).to.equal(250);
    });

    it("caps the fee at 10%", async function () {
      await expect(arena.connect(owner).setParams(1001, mon("0.001"), mon(1000)))
        .to.be.revertedWith("Arena: fee too high");
    });

    it("only the owner can change params or the arbiter", async function () {
      await expect(arena.connect(alice).setParams(100, mon("0.001"), mon(1)))
        .to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
      await expect(arena.connect(alice).setArbiter(alice.address))
        .to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    });
  });

  /* ================================================================
     Betting  (spec 7, 12, 23.1-23.5)
  ================================================================ */

  describe("betting", function () {
    it("accepts bets on both sides and tracks the pools", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(20) });
      await arena.connect(bob).placeBet(matchId, SIDE_A, { value: mon(30) });
      await arena.connect(carol).placeBet(matchId, SIDE_B, { value: mon(40) });

      const p = await arena.pools(matchId);
      expect(p.poolA).to.equal(mon(50));
      expect(p.poolB).to.equal(mon(40));
      expect(await arena.betOf(matchId, alice.address, SIDE_A)).to.equal(mon(20));
    });

    it("lets a player bet on their own match", async function () {
      /* Explicit product decision: strategies are public before betting, so a
         player has no informational edge over the crowd. */
      const matchId = await openMarket();
      await expect(arena.connect(playerA).placeBet(matchId, SIDE_A, { value: mon(10) }))
        .to.emit(arena, "BetPlaced");
      await expect(arena.connect(playerA).placeBet(matchId, SIDE_B, { value: mon(5) }))
        .to.emit(arena, "BetPlaced");
      expect(await arena.betOf(matchId, playerA.address, SIDE_A)).to.equal(mon(10));
    });

    it("accumulates repeat bets from the same address", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(15) });
      expect(await arena.betOf(matchId, alice.address, SIDE_A)).to.equal(mon(25));
    });

    it("rejects a zero bet", async function () {
      const matchId = await openMarket();
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: 0 }))
        .to.be.revertedWith("Arena: below min bet");
    });

    it("rejects bets below the minimum and above the maximum", async function () {
      const matchId = await openMarket();
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: 1n }))
        .to.be.revertedWith("Arena: below min bet");
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1001) }))
        .to.be.revertedWith("Arena: above max bet");
    });

    it("rejects an invalid side", async function () {
      const matchId = await openMarket();
      await expect(arena.connect(alice).placeBet(matchId, 3, { value: mon(1) }))
        .to.be.revertedWith("Arena: bad side");
      await expect(arena.connect(alice).placeBet(matchId, 0, { value: mon(1) }))
        .to.be.revertedWith("Arena: bad side");
    });

    it("rejects a bet on a match that does not exist", async function () {
      await expect(arena.connect(alice).placeBet(999, SIDE_A, { value: mon(1) }))
        .to.be.revertedWith("Arena: betting not open");
    });

    it("rejects a bet before betting opens", async function () {
      const matchId = await createWithAgents();
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) }))
        .to.be.revertedWith("Arena: betting not open");
      await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) }))
        .to.be.revertedWith("Arena: betting not open");
    });

    it("rejects a bet after the deadline, even before closeBetting is called", async function () {
      const matchId = await openMarket();
      await time.increase(WINDOW + 1);
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) }))
        .to.be.revertedWith("Arena: betting deadline passed");
    });

    it("rejects a bet once betting is closed", async function () {
      const matchId = await openMarket();
      await time.increase(WINDOW + 1);
      await arena.closeBetting(matchId);
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) }))
        .to.be.revertedWith("Arena: betting not open");
    });

    it("rejects a bet during the live match - there is no in-play betting", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await expect(arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(10) }))
        .to.be.revertedWith("Arena: betting not open");
    });

    it("rejects a bet after settlement", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      await expect(arena.connect(bob).placeBet(matchId, SIDE_A, { value: mon(1) }))
        .to.be.revertedWith("Arena: betting not open");
    });

    it("refuses to close betting before the deadline", async function () {
      const matchId = await openMarket();
      await expect(arena.closeBetting(matchId)).to.be.revertedWith("Arena: betting still open");
      // Not even the arbiter, who would otherwise be choosing the odds.
      await expect(arena.connect(arbiter).closeBetting(matchId)).to.be.revertedWith("Arena: betting still open");
    });

    it("lets anyone close betting once the deadline passes", async function () {
      const matchId = await openMarket();
      await time.increase(WINDOW + 1);
      await expect(arena.connect(outsider).closeBetting(matchId)).to.emit(arena, "BettingClosed");
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.BettingClosed);
    });

    it("bounds the betting window", async function () {
      const matchId = await createWithAgents();
      await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
      await expect(arena.connect(arbiter).openBetting(matchId, 5)).to.be.revertedWith("Arena: bad window");
      await expect(arena.connect(arbiter).openBetting(matchId, 8 * 24 * 3600)).to.be.revertedWith("Arena: bad window");
    });
  });

  /* ================================================================
     Seed fairness  (spec 13)
  ================================================================ */

  describe("seed", function () {
    it("requires the committed preimage", async function () {
      const matchId = await openMarket();
      await time.increase(WINDOW + 1);
      await arena.closeBetting(matchId);
      await expect(arena.connect(arbiter).startMatch(matchId, 0x1234n))
        .to.be.revertedWith("Arena: seed commit mismatch");
    });

    it("only the arbiter can start the match", async function () {
      const matchId = await openMarket();
      await time.increase(WINDOW + 1);
      await arena.closeBetting(matchId);
      await expect(arena.connect(playerA).startMatch(matchId, PREIMAGE))
        .to.be.revertedWith("Arena: not arbiter");
    });

    it("cannot start before betting is closed", async function () {
      const matchId = await openMarket();
      await expect(arena.connect(arbiter).startMatch(matchId, PREIMAGE))
        .to.be.revertedWith("Arena: betting not closed");
    });

    it("mixes in pool sizes, so the same preimage yields a different seed", async function () {
      /* Two matches, same committed preimage, different betting. If the seed
         were just the preimage, an arbiter could have ground it once and
         reused it forever. */
      const m1 = await openMarket();
      await arena.connect(alice).placeBet(m1, SIDE_A, { value: mon(10) });
      await goLive(m1);

      const m2 = await openMarket();
      await arena.connect(alice).placeBet(m2, SIDE_A, { value: mon(11) });
      await goLive(m2);

      expect((await arena.getMatch(m1)).seed).to.not.equal((await arena.getMatch(m2)).seed);
      expect((await arena.getMatch(m1)).seed).to.not.equal(PREIMAGE);
    });

    it("voids rather than starting once the blockhash window has expired", async function () {
      const matchId = await openMarket();
      await time.increase(WINDOW + 1);
      await arena.closeBetting(matchId);
      await mine(260);
      await expect(arena.connect(arbiter).startMatch(matchId, PREIMAGE))
        .to.be.revertedWith("Arena: seed window expired");
      await arena.connect(arbiter).voidMatch(matchId);
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.Voided);
    });
  });

  /* ================================================================
     Payouts  (spec 8 - the worked example from the specification)
  ================================================================ */

  describe("pari-mutuel payouts", function () {
    it("pays the specification's worked example exactly", async function () {
      /* A = 60, B = 40, total 100, fee 5, distributable 95. A wins.
         Alice 20 -> 95 * 20/60 = 31.666...
         Bob   30 -> 95 * 30/60 = 47.5
         Carol 10 -> 95 * 10/60 = 15.833... */
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(20) });
      await arena.connect(bob).placeBet(matchId, SIDE_A, { value: mon(30) });
      await arena.connect(carol).placeBet(matchId, SIDE_A, { value: mon(10) });
      await arena.connect(outsider).placeBet(matchId, SIDE_B, { value: mon(40) });

      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const m = await arena.getMatch(matchId);
      expect(m.distributable).to.equal(mon(95));
      expect(m.winningPool).to.equal(mon(60));
      expect(await arena.accumulatedFees()).to.equal(mon(5));

      const expected = (stake) => (mon(95) * stake) / mon(60);
      expect(await arena.claimable(matchId, alice.address)).to.equal(expected(mon(20)));
      expect(await arena.claimable(matchId, bob.address)).to.equal(expected(mon(30)));
      expect(await arena.claimable(matchId, carol.address)).to.equal(expected(mon(10)));

      // and Bob's share is exactly half the distributable pool
      expect(await arena.claimable(matchId, bob.address)).to.equal(mon("47.5"));

      // the losing side gets nothing
      expect(await arena.claimable(matchId, outsider.address)).to.equal(0);
    });

    it("actually transfers the payout on claim", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(20) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(80) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const owed = await arena.claimable(matchId, alice.address);
      expect(owed).to.equal(mon(95));   // sole winner takes the whole distributable pool

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await arena.connect(alice).claim(matchId);
      const rc = await tx.wait();
      const after = await ethers.provider.getBalance(alice.address);
      expect(after - before + rc.gasUsed * rc.gasPrice).to.equal(owed);
    });

    it("charges the fee on the total pool, not just the losing side", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(50) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(50) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      // 5% of 100, not 5% of the 50 that lost.
      expect(await arena.accumulatedFees()).to.equal(mon(5));
      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(95));
    });

    it("pays out when only the winning side had bets", async function () {
      /* Nobody backed the loser: the winners split their own money back,
         minus the fee. Not a void - the market resolved. */
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(100) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      expect((await arena.getMatch(matchId)).state).to.equal(STATE.Settled);
      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(95));
      expect(await arena.accumulatedFees()).to.equal(mon(5));
    });

    it("splits proportionally among many bettors on the same side", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) });
      await arena.connect(bob).placeBet(matchId, SIDE_A, { value: mon(2) });
      await arena.connect(carol).placeBet(matchId, SIDE_A, { value: mon(7) });
      await arena.connect(outsider).placeBet(matchId, SIDE_B, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const d = mon(19);   // 20 total - 5%
      expect(await arena.claimable(matchId, alice.address)).to.equal(d / 10n);
      expect(await arena.claimable(matchId, bob.address)).to.equal((d * 2n) / 10n);
      expect(await arena.claimable(matchId, carol.address)).to.equal((d * 7n) / 10n);
    });

    it("a player who backed themselves is paid like any other bettor", async function () {
      const matchId = await openMarket();
      await arena.connect(playerA).placeBet(matchId, SIDE_A, { value: mon(50) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(50) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      expect(await arena.claimable(matchId, playerA.address)).to.equal(mon(95));
    });

    it("a bettor who backed both sides is paid only on the winner", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(30) });
      await arena.connect(alice).placeBet(matchId, SIDE_B, { value: mon(70) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      // distributable 95, winning pool is alice's own 30 -> she gets all 95
      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(95));
    });

    it("leaves only wei-scale dust after every winner has claimed", async function () {
      /* Three bettors on a pool that does not divide evenly. Floor division
         means the contract keeps a remainder; it must be tiny, and it must
         never be negative (which would mean insolvency). */
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) + 1n });
      await arena.connect(bob).placeBet(matchId, SIDE_A, { value: mon(1) + 2n });
      await arena.connect(carol).placeBet(matchId, SIDE_A, { value: mon(1) + 3n });
      await arena.connect(outsider).placeBet(matchId, SIDE_B, { value: mon(3) + 7n });

      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const m = await arena.getMatch(matchId);
      const paid =
        (await arena.claimable(matchId, alice.address)) +
        (await arena.claimable(matchId, bob.address)) +
        (await arena.claimable(matchId, carol.address));

      expect(paid).to.be.lessThanOrEqual(m.distributable);
      expect(m.distributable - paid).to.be.lessThan(3n);   // at most 1 wei per winner

      await arena.connect(alice).claim(matchId);
      await arena.connect(bob).claim(matchId);
      await arena.connect(carol).claim(matchId);

      // The contract still holds exactly the fee plus the dust - it is solvent.
      const held = await ethers.provider.getBalance(await arena.getAddress());
      expect(held).to.equal((await arena.accumulatedFees()) + (m.distributable - paid));
    });

    it("quote() agrees with what the contract actually pays", async function () {
      const matchId = await openMarket();
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(40) });

      // What alice is told before she bets 20 on A, with A empty.
      const quoted = await arena.quote(matchId, SIDE_A, mon(20));

      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(20) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      expect(await arena.claimable(matchId, alice.address)).to.equal(quoted);
    });
  });

  /* ================================================================
     Void and refund  (spec 9, 19, 23.8, 23.11)
  ================================================================ */

  describe("void and refund", function () {
    it("voids and refunds when nobody backed the winning side", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(100) });
      await goLive(matchId);
      await settle(matchId, SIDE_B);   // B wins; nobody bet on B

      const m = await arena.getMatch(matchId);
      expect(m.state).to.equal(STATE.Voided);
      expect(await arena.accumulatedFees()).to.equal(0);   // no fee on a void
      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(100));   // full refund
    });

    it("voids and refunds both sides on a draw, and mints no NFT", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(60) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(40) });
      await goLive(matchId);
      await settle(matchId, SIDE_NONE, FINISH_DRAW);

      const m = await arena.getMatch(matchId);
      expect(m.state).to.equal(STATE.Voided);
      expect(m.nftTokenId).to.equal(0);
      expect(await nft.totalMinted()).to.equal(0);
      expect(await arena.accumulatedFees()).to.equal(0);
      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(60));
      expect(await arena.claimable(matchId, bob.address)).to.equal(mon(40));
    });

    it("refunds a bettor who backed both sides of a void in full", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(30) });
      await arena.connect(alice).placeBet(matchId, SIDE_B, { value: mon(20) });
      await goLive(matchId);
      await settle(matchId, SIDE_NONE, FINISH_DRAW);
      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(50));
    });

    it("rejects a winner that disagrees with the finish type", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const bad = await signSettlement(matchId, SIDE_A, FINISH_DRAW);
      await expect(arena.settleMatch(bad.value, bad.signature))
        .to.be.revertedWith("Arena: winner/finish disagree");
      const bad2 = await signSettlement(matchId, SIDE_NONE, FINISH_KO);
      await expect(arena.settleMatch(bad2.value, bad2.signature))
        .to.be.revertedWith("Arena: winner/finish disagree");
    });

    it("settles a timeout decision like any other win", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A, FINISH_TIMEOUT);
      expect((await arena.getMatch(matchId)).finishType).to.equal(FINISH_TIMEOUT);
      expect(await nft.totalMinted()).to.equal(1);
    });
  });

  /* ================================================================
     Cancellation  (spec 23.10)
  ================================================================ */

  describe("cancellation", function () {
    it("lets the creator cancel before betting opens", async function () {
      const matchId = await createWithAgents();
      await expect(arena.connect(playerA).cancelMatch(matchId)).to.emit(arena, "MatchCancelled");
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.Cancelled);
    });

    it("refunds every bettor when an open market is cancelled", async function () {
      /* The bug this replaces: the old contract refunded player stakes on
         cancel and left every spectator bet stranded in the contract. */
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(20) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(30) });

      await arena.connect(arbiter).cancelMatch(matchId);

      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(20));
      expect(await arena.claimable(matchId, bob.address)).to.equal(mon(30));

      await arena.connect(alice).claim(matchId);
      await arena.connect(bob).claim(matchId);
      expect(await ethers.provider.getBalance(await arena.getAddress())).to.equal(0);
    });

    it("stops the creator cancelling a market that has money in it", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(20) });
      await expect(arena.connect(playerA).cancelMatch(matchId))
        .to.be.revertedWith("Arena: not authorized yet");
    });

    it("lets anyone cancel a stalled setup after the timeout", async function () {
      const matchId = await createWithAgents();
      await expect(arena.connect(outsider).cancelMatch(matchId))
        .to.be.revertedWith("Arena: not authorized yet");
      await time.increase(2 * 3600 + 1);
      await expect(arena.connect(outsider).cancelMatch(matchId)).to.emit(arena, "MatchCancelled");
    });

    it("cannot cancel a live or settled match", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      await expect(arena.connect(arbiter).cancelMatch(matchId)).to.be.revertedWith("Arena: not cancellable");
      await settle(matchId, SIDE_A);
      await expect(arena.connect(arbiter).cancelMatch(matchId)).to.be.revertedWith("Arena: not cancellable");
    });

    it("lets anyone void a live match that never produced a result", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);

      await expect(arena.connect(outsider).voidMatch(matchId)).to.be.revertedWith("Arena: not timed out");
      await time.increase(2 * 3600 + 1);
      await expect(arena.connect(outsider).voidMatch(matchId)).to.emit(arena, "MatchVoided");
      expect(await arena.claimable(matchId, alice.address)).to.equal(mon(10));
    });
  });

  /* ================================================================
     Settlement security  (spec 18, 23.6, 23.7, 23.17-23.22)
  ================================================================ */

  describe("settlement security", function () {
    it("rejects a signature from anyone but the arbiter", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A, FINISH_KO, {}, playerA);
      await expect(arena.settleMatch(value, signature)).to.be.revertedWith("Arena: bad arbiter signature");
    });

    it("rejects a settlement whose data was altered after signing", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A);
      await expect(arena.settleMatch({ ...value, winner: SIDE_B }, signature))
        .to.be.revertedWith("Arena: bad arbiter signature");
    });

    it("rejects a settlement for the wrong match", async function () {
      const m1 = await openMarket();
      const m2 = await openMarket();
      await goLive(m1);
      await goLive(m2);

      const { value, signature } = await signSettlement(m1, SIDE_A);
      /* Same signature, pointed at a different match. The seed check fires
         before the signature recovery does, so this is caught one step
         earlier than a forged signature would be - rejected either way. */
      await expect(arena.settleMatch({ ...value, matchId: m2 }, signature))
        .to.be.revertedWith("Arena: seed mismatch");
    });

    it("cannot replay a used settlement against the same match", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A);
      await arena.settleMatch(value, signature);
      await expect(arena.settleMatch(value, signature)).to.be.revertedWith("Arena: match not live");
    });

    it("cannot replay a settlement against a redeployed contract", async function () {
      /* The domain separator carries verifyingContract, so the same signed
         result is meaningless to a different deployment. */
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A);

      const Arena = await ethers.getContractFactory("ArenaBattle");
      const arena2 = await Arena.deploy(await nft.getAddress(), arbiter.address, owner.address);
      await arena2.waitForDeployment();

      await expect(arena2.settleMatch(value, signature)).to.be.revertedWith("Arena: match not live");
      expect(await arena2.domainSeparator()).to.not.equal(await arena.domainSeparator());
    });

    it("rejects a settlement that names the wrong agent snapshot", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A, FINISH_KO, {
        agentAHash: ethers.keccak256(ethers.toUtf8Bytes("some other agent"))
      });
      await expect(arena.settleMatch(value, signature)).to.be.revertedWith("Arena: agent A mismatch");
    });

    it("rejects a settlement that names the wrong seed", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A, FINISH_KO, { seed: 999n });
      await expect(arena.settleMatch(value, signature)).to.be.revertedWith("Arena: seed mismatch");
    });

    it("rejects a settlement built against a different simulation version", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A, FINISH_KO, { simVersion: 7 });
      await expect(arena.settleMatch(value, signature)).to.be.revertedWith("Arena: sim version mismatch");
    });

    it("rejects an out-of-range winner or finish type", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const bad = await signSettlement(matchId, 5, FINISH_KO);
      await expect(arena.settleMatch(bad.value, bad.signature)).to.be.revertedWith("Arena: bad winner");
      const bad2 = await signSettlement(matchId, SIDE_A, 9);
      await expect(arena.settleMatch(bad2.value, bad2.signature)).to.be.revertedWith("Arena: bad finish type");
    });

    it("cannot settle a match that is not live", async function () {
      const matchId = await openMarket();
      const { value, signature } = await signSettlement(matchId, SIDE_A, FINISH_KO, { seed: 0n });
      await expect(arena.settleMatch(value, signature)).to.be.revertedWith("Arena: match not live");
    });

    it("a rotated arbiter invalidates the old arbiter's signatures", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A);
      await arena.connect(owner).setArbiter(outsider.address);
      await expect(arena.settleMatch(value, signature)).to.be.revertedWith("Arena: bad arbiter signature");
    });

    it("settlement is permissionless once the signature is valid", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      const { value, signature } = await signSettlement(matchId, SIDE_A);
      // Anyone can relay it - the signature is the authorization, not the sender.
      await expect(arena.connect(carol).settleMatch(value, signature)).to.emit(arena, "MatchSettled");
    });
  });

  /* ================================================================
     Claims  (spec 23.6)
  ================================================================ */

  describe("claims", function () {
    it("blocks a second claim", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      await arena.connect(alice).claim(matchId);
      await expect(arena.connect(alice).claim(matchId)).to.be.revertedWith("Arena: already claimed");
      expect(await arena.claimable(matchId, alice.address)).to.equal(0);
    });

    it("blocks a claim from someone who never bet", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      await expect(arena.connect(outsider).claim(matchId)).to.be.revertedWith("Arena: nothing to claim");
    });

    it("blocks a claim from the losing side", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      await expect(arena.connect(bob).claim(matchId)).to.be.revertedWith("Arena: nothing to claim");
    });

    it("blocks a claim before settlement", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await expect(arena.connect(alice).claim(matchId)).to.be.revertedWith("Arena: nothing to claim");
      await goLive(matchId);
      await expect(arena.connect(alice).claim(matchId)).to.be.revertedWith("Arena: nothing to claim");
    });

    it("a reverting claimant cannot block anyone else", async function () {
      /* This is why settlement pays nobody. The rejector's own claim fails;
         every other claim, and the settlement itself, is untouched. */
      const Rejector = await ethers.getContractFactory("RejectingBettor");
      const rejector = await Rejector.deploy(await arena.getAddress());
      await rejector.waitForDeployment();

      const matchId = await openMarket();
      await rejector.bet(matchId, SIDE_A, { value: mon(50) });
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(50) });
      await goLive(matchId);

      // Settlement succeeds even though a winner cannot receive money.
      await expect(settle(matchId, SIDE_A)).to.emit(arena, "MatchSettled");

      await expect(rejector.claim(matchId)).to.be.revertedWith("Arena: transfer failed");
      await expect(arena.connect(alice).claim(matchId)).to.emit(arena, "Claimed");
    });

    it("survives a reentrant claim attempt", async function () {
      const Attacker = await ethers.getContractFactory("ReentrantBettor");
      const attacker = await Attacker.deploy(await arena.getAddress());
      await attacker.waitForDeployment();

      const matchId = await openMarket();
      await attacker.bet(matchId, SIDE_A, { value: mon(50) });
      await arena.connect(alice).placeBet(matchId, SIDE_B, { value: mon(50) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      // The reentrant call inside receive() is what fails, taking the outer
      // transfer down with it - the attacker gets nothing, twice.
      await expect(attacker.claim(matchId)).to.be.revertedWith("Arena: transfer failed");
      expect(await arena.claimed(matchId, await attacker.getAddress())).to.equal(false);
    });
  });

  /* ================================================================
     NFT  (spec 19)
  ================================================================ */

  describe("winner NFT", function () {
    it("mints to the winning agent's owner and records the audit hashes", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const m = await arena.getMatch(matchId);
      expect(m.nftTokenId).to.equal(1);
      expect(await nft.ownerOf(1)).to.equal(playerA.address);

      const f = await nft.getFighter(1);
      expect(f.matchId).to.equal(matchId);
      expect(f.snapshotHash).to.equal(await arena.agentHash(matchId, SIDE_A));
      expect(f.opponentHash).to.equal(await arena.agentHash(matchId, SIDE_B));
      expect(f.opponent).to.equal(playerB.address);
      expect(f.seed).to.equal(m.seed);
      expect(f.decisionHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes("decisions")));
      expect(f.resultDigest).to.equal(ethers.keccak256(ethers.toUtf8Bytes("result")));
    });

    it("produces a valid on-chain data URI with the public strategy in it", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const uri = await nft.tokenURI(1);
      expect(uri).to.match(/^data:application\/json;base64,/);
      const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
      expect(json.name).to.contain("AARAGE Victory #1");
      expect(json.description).to.contain("Play defensively");
      expect(json.image).to.match(/^data:image\/svg\+xml;base64,/);

      const svg = Buffer.from(json.image.split(",")[1], "base64").toString();
      expect(svg).to.contain("<svg");
      expect(svg).to.contain("SETTLED ON MONAD");
      expect(svg).to.contain("K.O.");
    });

    it("escapes a prompt that would otherwise break its own metadata", async function () {
      const matchId = await openMarket({ prompt: 'Rush & "punish" <them> always' });
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      const uri = await nft.tokenURI(1);
      const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());  // would throw if broken
      expect(json.description).to.contain('"punish"');

      const svg = Buffer.from(json.image.split(",")[1], "base64").toString();
      expect(svg).to.contain("&amp;");
      expect(svg).to.contain("&lt;them&gt;");
    });

    it("mints nothing on a draw", async function () {
      const matchId = await openMarket();
      await goLive(matchId);
      await settle(matchId, SIDE_NONE, FINISH_DRAW);
      expect(await nft.totalMinted()).to.equal(0);
      expect(await nft.tokenOfMatch(matchId)).to.equal(0);
    });

    it("mints nothing when the market voids for want of winning bettors", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_B);
      expect(await nft.totalMinted()).to.equal(0);
    });

    it("refuses a second mint for the same match", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      expect(await nft.tokenOfMatch(matchId)).to.equal(1);

      // Direct attempt, bypassing the arena's own state machine.
      await expect(
        nft.connect(owner).mintWinner({
          to: outsider.address, matchId, name: "x", prompt: "y", archetype: "z", model: "m",
          aggression: 1, defense: 1, speed: 1, finishType: FINISH_KO, seed: 1,
          opponent: outsider.address, snapshotHash: ethers.ZeroHash, opponentHash: ethers.ZeroHash,
          decisionHash: ethers.ZeroHash, resultDigest: ethers.ZeroHash, simVersion: 1
        })
      ).to.be.revertedWith("FighterNFT: not arena");
    });

    it("only the arena can mint", async function () {
      await expect(
        nft.connect(alice).mintWinner({
          to: alice.address, matchId: 42, name: "x", prompt: "y", archetype: "z", model: "m",
          aggression: 1, defense: 1, speed: 1, finishType: FINISH_KO, seed: 1,
          opponent: alice.address, snapshotHash: ethers.ZeroHash, opponentHash: ethers.ZeroHash,
          decisionHash: ethers.ZeroHash, resultDigest: ethers.ZeroHash, simVersion: 1
        })
      ).to.be.revertedWith("FighterNFT: not arena");
    });
  });

  /* ================================================================
     State machine  (spec 11, 23)
  ================================================================ */

  describe("state machine", function () {
    it("walks the happy path in order", async function () {
      const tx = await arena.connect(playerA).createMatch(SIM);
      await tx.wait();
      const matchId = (await arena.nextMatchId()) - 1n;
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.Created);

      await arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address));
      await arena.connect(playerB).submitAgent(matchId, SIDE_B, agentFor(playerB.address, { name: "Kenji" }));
      await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.AgentsLocked);

      await arena.connect(arbiter).openBetting(matchId, WINDOW);
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.BettingOpen);

      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) });
      await time.increase(WINDOW + 1);
      await arena.closeBetting(matchId);
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.BettingClosed);

      await arena.connect(arbiter).startMatch(matchId, PREIMAGE);
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.Live);

      await settle(matchId, SIDE_A);
      expect((await arena.getMatch(matchId)).state).to.equal(STATE.Settled);
    });

    it("refuses every out-of-order transition", async function () {
      const matchId = await createWithAgents();

      await expect(arena.connect(arbiter).openBetting(matchId, WINDOW))
        .to.be.revertedWith("Arena: agents not locked");
      await expect(arena.closeBetting(matchId)).to.be.revertedWith("Arena: betting not open");
      await expect(arena.connect(arbiter).startMatch(matchId, PREIMAGE))
        .to.be.revertedWith("Arena: betting not closed");
      await expect(arena.connect(arbiter).voidMatch(matchId)).to.be.revertedWith("Arena: not voidable");

      await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
      await expect(arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT))
        .to.be.revertedWith("Arena: not in created");

      await arena.connect(arbiter).openBetting(matchId, WINDOW);
      await expect(arena.connect(arbiter).openBetting(matchId, WINDOW))
        .to.be.revertedWith("Arena: agents not locked");
    });

    it("rejects a zero seed commit", async function () {
      const matchId = await createWithAgents();
      await expect(arena.connect(arbiter).lockAgents(matchId, ethers.ZeroHash))
        .to.be.revertedWith("Arena: zero seed commit");
    });

    it("gives each match its own id", async function () {
      const m1 = await openMarket();
      const m2 = await openMarket();
      expect(m2).to.equal(m1 + 1n);
    });
  });

  /* ================================================================
     Pause and treasury  (spec 23.16)
  ================================================================ */

  describe("pause and treasury", function () {
    it("blocks new markets and new bets while paused", async function () {
      const matchId = await openMarket();
      await arena.connect(owner).pause();

      await expect(arena.connect(playerA).createMatch(SIM))
        .to.be.revertedWithCustomError(arena, "EnforcedPause");
      await expect(arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) }))
        .to.be.revertedWithCustomError(arena, "EnforcedPause");
    });

    it("never blocks a claim while paused", async function () {
      /* A pause must not become a freeze on money that is already owed. */
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(10) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      await arena.connect(owner).pause();
      await expect(arena.connect(alice).claim(matchId)).to.emit(arena, "Claimed");
    });

    it("withdraws fees to the owner's chosen address", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(60) });
      await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(40) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);

      expect(await arena.accumulatedFees()).to.equal(mon(5));
      await expect(arena.connect(owner).withdrawFees(carol.address))
        .to.changeEtherBalance(carol, mon(5));
      expect(await arena.accumulatedFees()).to.equal(0);
      await expect(arena.connect(owner).withdrawFees(carol.address)).to.be.revertedWith("Arena: no fees");
    });

    it("cannot withdraw money that belongs to bettors", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(100) });
      // Nothing settled, so nothing is the protocol's.
      await expect(arena.connect(owner).withdrawFees(owner.address)).to.be.revertedWith("Arena: no fees");
      expect(await ethers.provider.getBalance(await arena.getAddress())).to.equal(mon(100));
    });

    it("time-locks the dust sweep", async function () {
      const matchId = await openMarket();
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(1) + 1n });
      await arena.connect(bob).placeBet(matchId, SIDE_A, { value: mon(1) + 2n });
      await arena.connect(carol).placeBet(matchId, SIDE_B, { value: mon(2) });
      await goLive(matchId);
      await settle(matchId, SIDE_A);
      await arena.connect(alice).claim(matchId);
      await arena.connect(bob).claim(matchId);

      await expect(arena.connect(owner).sweepDust(matchId)).to.be.revertedWith("Arena: too early");
      await time.increase(90 * 24 * 3600 + 1);
      await expect(arena.connect(owner).sweepDust(matchId)).to.emit(arena, "DustSwept");
      await expect(arena.connect(owner).sweepDust(matchId)).to.be.revertedWith("Arena: nothing to sweep");
    });
  });

  /* ================================================================
     End to end  (spec 27)
  ================================================================ */

  describe("end-to-end", function () {
    it("runs one full match from two agents to a claimed payout and a minted NFT", async function () {
      // 1. create + two agents
      await arena.connect(playerA).createMatch(SIM);
      const matchId = (await arena.nextMatchId()) - 1n;
      await arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address, {
        name: "Ronin", prompt: "Hold the centre and punish every overextension."
      }));
      await arena.connect(playerB).submitAgent(matchId, SIDE_B, agentFor(playerB.address, {
        name: "Kenji", prompt: "Rush immediately and never let them breathe.",
        aggression: 90, defense: 25, speed: 75
      }));

      // 2. lock + publish
      await arena.connect(arbiter).lockAgents(matchId, SEED_COMMIT);
      expect((await arena.getAgent(matchId, SIDE_B)).prompt).to.contain("Rush immediately");

      // 3. betting, players included
      await arena.connect(arbiter).openBetting(matchId, WINDOW);
      await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(20) });
      await arena.connect(bob).placeBet(matchId, SIDE_A, { value: mon(30) });
      await arena.connect(playerA).placeBet(matchId, SIDE_A, { value: mon(10) });
      await arena.connect(carol).placeBet(matchId, SIDE_B, { value: mon(40) });

      // 4. close + seed
      await time.increase(WINDOW + 1);
      await arena.closeBetting(matchId);
      await arena.connect(arbiter).startMatch(matchId, PREIMAGE);
      const seed = (await arena.getMatch(matchId)).seed;
      expect(seed).to.not.equal(0n);

      // 5. settle
      await settle(matchId, SIDE_A);
      const m = await arena.getMatch(matchId);
      expect(m.state).to.equal(STATE.Settled);
      expect(m.distributable).to.equal(mon(95));      // 100 total, 5% fee
      expect(m.winningPool).to.equal(mon(60));

      // 6. claim
      await expect(arena.connect(alice).claim(matchId))
        .to.changeEtherBalance(alice, (mon(95) * mon(20)) / mon(60), { includeFee: false });
      await arena.connect(bob).claim(matchId);
      await arena.connect(playerA).claim(matchId);
      await expect(arena.connect(carol).claim(matchId)).to.be.revertedWith("Arena: nothing to claim");

      // 7. NFT
      expect(await nft.ownerOf(m.nftTokenId)).to.equal(playerA.address);
      const f = await nft.getFighter(m.nftTokenId);
      expect(f.name).to.equal("Ronin");
      expect(f.seed).to.equal(seed);

      // solvent: only the fee and wei-scale dust left behind
      const left = await ethers.provider.getBalance(await arena.getAddress());
      expect(left - (await arena.accumulatedFees())).to.be.lessThan(3n);
    });
  });
});
