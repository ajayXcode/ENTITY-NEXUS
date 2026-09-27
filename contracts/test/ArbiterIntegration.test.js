const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const path = require("path");

/* ------------------------------------------------------------------
   The real arbiter against the real contract.

   Every other test signs with a hardhat signer and hand-written EIP-712
   types, which proves the contract verifies what the test believes it
   signed - and nothing at all about the thing that will actually sign in
   production. This one loads arbiter.js itself, the same module server.js
   requires, and puts its output straight into settleMatch.

   If the domain name, the version string, the field order or a single type
   in either file ever drifts apart, this is what fails.
------------------------------------------------------------------- */

const { Arbiter } = require(path.join(__dirname, "..", "..", "arbiter.js"));

const SIDE_A = 1, SIDE_B = 2;
const FINISH_KO = 1, FINISH_DRAW = 3;
const SIM = 1, WINDOW = 3600;
const mon = (n) => ethers.parseEther(String(n));

function agentFor(addr, o = {}) {
  return {
    owner: addr, name: "Ronin",
    prompt: "Hold the centre and punish every overextension.",
    model: "jev/jev-1.0.0/gemini-3.6-flash", modelVersion: "gemini-3.6-flash",
    archetype: "Counterpuncher",
    jevConfigHash: ethers.keccak256(ethers.toUtf8Bytes("jev-config-v1")),
    aggression: 40, defense: 80, speed: 55, simVersion: SIM, ...o
  };
}

describe("arbiter.js <-> ArenaBattle", function () {
  let nft, arena, owner, arbiterSigner, playerA, playerB, alice, bob;

  before(function () {
    /* The arbiter reads its key from the environment exactly as it does in
       server.js. A throwaway key: this never touches a real network. */
    process.env.ARBITER_PRIVATE_KEY =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    expect(Arbiter.init()).to.equal(true);
  });

  beforeEach(async function () {
    [owner, , playerA, playerB, alice, bob] = await ethers.getSigners();
    arbiterSigner = new ethers.Wallet(process.env.ARBITER_PRIVATE_KEY, ethers.provider);
    await owner.sendTransaction({ to: arbiterSigner.address, value: mon(10) });

    const NFT = await ethers.getContractFactory("FighterNFT");
    nft = await NFT.deploy(owner.address);
    const Arena = await ethers.getContractFactory("ArenaBattle");
    arena = await Arena.deploy(await nft.getAddress(), arbiterSigner.address, owner.address);
    await nft.connect(owner).setArenaContract(await arena.getAddress());

    Arbiter.matches.clear();
  });

  async function fullMatch() {
    await arena.connect(playerA).createMatch(SIM);
    const matchId = (await arena.nextMatchId()) - 1n;

    await arena.connect(playerA).submitAgent(matchId, SIDE_A, agentFor(playerA.address));
    await arena.connect(playerB).submitAgent(matchId, SIDE_B, agentFor(playerB.address, {
      name: "Kenji", prompt: "Rush immediately and never let them breathe.",
      archetype: "Pressure", aggression: 90, defense: 25, speed: 75
    }));

    /* The seed preimage the arbiter rolls itself - this is the value the
       whole anti-grinding argument rests on, and it is generated here, before
       a single bet exists. */
    const { commit } = Arbiter.commitSeed(matchId);
    await arena.connect(arbiterSigner).lockAgents(matchId, commit);
    await arena.connect(arbiterSigner).openBetting(matchId, WINDOW);

    await arena.connect(alice).placeBet(matchId, SIDE_A, { value: mon(60) });
    await arena.connect(bob).placeBet(matchId, SIDE_B, { value: mon(40) });

    await time.increase(WINDOW + 1);
    await arena.closeBetting(matchId);

    const { preimage } = Arbiter.revealSeed(matchId);
    await arena.connect(arbiterSigner).startMatch(matchId, preimage);

    return matchId;
  }

  async function settlementRequest(matchId, overrides = {}) {
    const m = await arena.getMatch(matchId);
    return {
      matchId: matchId.toString(),
      agentAHash: await arena.agentHash(matchId, SIDE_A),
      agentBHash: await arena.agentHash(matchId, SIDE_B),
      seed: m.seed.toString(),
      winner: SIDE_A,
      finishType: FINISH_KO,
      resultDigest: ethers.keccak256(ethers.toUtf8Bytes("digest-from-the-sim")),
      decisionHash: ethers.keccak256(ethers.toUtf8Bytes("jev-decision-log")),
      simVersion: SIM,
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      arena: await arena.getAddress(),
      ...overrides
    };
  }

  it("produces a signature ArenaBattle accepts, end to end", async function () {
    const matchId = await fullMatch();
    const req = await settlementRequest(matchId);

    const signed = await Arbiter.sign(req);
    expect(signed.error, signed.error).to.equal(undefined);
    expect(signed.arbiter).to.equal(arbiterSigner.address);

    // Straight from arbiter.js into the contract, untouched.
    await expect(arena.connect(alice).settleMatch(signed.settlement, signed.signature))
      .to.emit(arena, "MatchSettled");

    const m = await arena.getMatch(matchId);
    expect(m.distributable).to.equal(mon(95));
    expect(await arena.claimable(matchId, alice.address)).to.equal(mon(95));
    expect(await nft.ownerOf(m.nftTokenId)).to.equal(playerA.address);

    await expect(arena.connect(alice).claim(matchId)).to.emit(arena, "Claimed");
  });

  it("the seed it commits to is the seed the contract reveals", async function () {
    const matchId = await fullMatch();
    const m = await arena.getMatch(matchId);
    expect(m.seed).to.not.equal(0n);
    // and it is not simply the preimage - the contract mixed in blockhash and pools
    const { preimage } = Arbiter.revealSeed(matchId);
    expect(m.seed).to.not.equal(BigInt(preimage));
  });

  it("refuses to sign when the two sides report different fights", async function () {
    const matchId = await fullMatch();

    let agree = Arbiter.report(matchId, "A", {
      winner: SIDE_A, finishType: FINISH_KO,
      resultDigest: ethers.keccak256(ethers.toUtf8Bytes("A saw this")),
      decisionHash: ethers.keccak256(ethers.toUtf8Bytes("log"))
    });
    expect(agree.ready).to.equal(true);   // one report so far: a solo match

    agree = Arbiter.report(matchId, "B", {
      winner: SIDE_B, finishType: FINISH_KO,
      resultDigest: ethers.keccak256(ethers.toUtf8Bytes("B saw something else")),
      decisionHash: ethers.keccak256(ethers.toUtf8Bytes("log"))
    });
    expect(agree.ready).to.equal(false);
    expect(agree.disputed).to.equal(true);
  });

  it("agrees when both sides saw the same fight", async function () {
    const matchId = await fullMatch();
    const result = {
      winner: SIDE_A, finishType: FINISH_KO,
      resultDigest: ethers.keccak256(ethers.toUtf8Bytes("same")),
      decisionHash: ethers.keccak256(ethers.toUtf8Bytes("same log"))
    };
    Arbiter.report(matchId, "A", result);
    const agree = Arbiter.report(matchId, "B", result);
    expect(agree.ready).to.equal(true);
    expect(agree.disputed).to.equal(undefined);
  });

  it("refuses malformed settlement data before it costs anyone gas", async function () {
    const matchId = await fullMatch();

    expect((await Arbiter.sign(await settlementRequest(matchId, { winner: 9 }))).error)
      .to.contain("winner must be");
    expect((await Arbiter.sign(await settlementRequest(matchId, { winner: 0, finishType: FINISH_KO }))).error)
      .to.contain("disagree about a draw");
    expect((await Arbiter.sign(await settlementRequest(matchId, { resultDigest: "0x1234" }))).error)
      .to.contain("bytes32");
    expect((await Arbiter.sign(await settlementRequest(matchId, { arena: "not-an-address" }))).error)
      .to.contain("arena address");
  });

  it("a signature for one chain is worthless on another", async function () {
    const matchId = await fullMatch();
    const signed = await Arbiter.sign(await settlementRequest(matchId, { chainId: 1 }));
    expect(signed.error).to.equal(undefined);
    await expect(arena.settleMatch(signed.settlement, signed.signature))
      .to.be.revertedWith("Arena: bad arbiter signature");
  });

  it("a signature for another deployment is worthless here", async function () {
    const matchId = await fullMatch();
    const signed = await Arbiter.sign(await settlementRequest(matchId, {
      arena: "0x000000000000000000000000000000000000dEaD"
    }));
    await expect(arena.settleMatch(signed.settlement, signed.signature))
      .to.be.revertedWith("Arena: bad arbiter signature");
  });

  it("signs a draw, which voids the market and mints nothing", async function () {
    const matchId = await fullMatch();
    const signed = await Arbiter.sign(await settlementRequest(matchId, {
      winner: 0, finishType: FINISH_DRAW
    }));
    expect(signed.error).to.equal(undefined);

    await expect(arena.settleMatch(signed.settlement, signed.signature))
      .to.emit(arena, "MatchVoided");

    expect(await nft.totalMinted()).to.equal(0);
    expect(await arena.accumulatedFees()).to.equal(0);
    expect(await arena.claimable(matchId, alice.address)).to.equal(mon(60));
    expect(await arena.claimable(matchId, bob.address)).to.equal(mon(40));
  });
});
