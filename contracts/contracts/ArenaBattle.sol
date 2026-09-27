// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./AgentTypes.sol";
import "./FighterNFT.sol";

/**
 * @title ArenaBattle
 * @notice Pre-match pari-mutuel betting escrow and settlement for AI agent
 *         duels on Monad.
 *
 * ------------------------------------------------------------------
 * THE ONE INVARIANT
 *
 *   Once betting opens, nothing a player controls can change the economic
 *   identity of either agent, or the rules of the match.
 *
 * Everything below is in service of that sentence. The agent snapshots are
 * frozen and hashed before betting opens; the fee and the bet limits are
 * copied into the match at creation so an owner cannot re-price a live
 * market; the seed is committed before the pools exist and revealed after
 * they are closed; and the settlement signature binds all of it at once, so
 * a settlement for a different agent, a different seed, a different
 * simulation version, a different contract or a different chain simply does
 * not verify.
 *
 * ------------------------------------------------------------------
 * THE MONEY, IN ONE PLACE
 *
 *   total         = poolA + poolB
 *   fee           = total * feeBps / 10000        (feeBps snapshotted, 500)
 *   distributable = total - fee
 *   payout(i)     = distributable * stake(i) / winningPool
 *
 * The fee is charged on the TOTAL pool, not on the losing side, so a winning
 * bettor's own principal is inside the taxed base. This is a plain
 * pari-mutuel: you are not guaranteed your stake back, you are buying a
 * proportional share of everything on the table after the house cut.
 *
 * Two cases pay nothing and charge nothing (see _resolve):
 *   - nobody backed the winning side
 *   - the fight was a draw
 * Both VOID the market. A void refunds every bettor on both sides in full and
 * takes no fee, because there is no honest way to price a market that never
 * resolved.
 *
 * ------------------------------------------------------------------
 * PAYMENTS ARE PULLED, NEVER PUSHED
 *
 * settleMatch() moves no money. It records the result and mints, and every
 * MON leaves through claim(), one claimant at a time, at their own request.
 * An earlier version paid the winner from inside settlement; a winner whose
 * address reverts on receive would have made the match permanently
 * unsettleable, taking the NFT and every spectator's claim down with it.
 * Nobody else's money should depend on one recipient's fallback function.
 */
contract ArenaBattle is Ownable, ReentrancyGuard, Pausable, EIP712 {
    using ECDSA for bytes32;
    using AgentTypes for AgentTypes.AgentSnapshot;

    /* ------------------------------------------------------------------
       State machine

       The failure paths matter as much as the happy one:
         CREATED       -> CANCELLED    nobody ever showed up
         AGENTS_LOCKED -> CANCELLED    locked but never opened
         BETTING_OPEN  -> CANCELLED    abandoned mid-market
         BETTING_CLOSED-> VOIDED       never started
         LIVE          -> VOIDED       started, never produced a result
       CANCELLED and VOIDED are the same thing economically (everyone is
       refunded); they are separate states only so the UI can say which
       happened and the event log can be read back honestly.
    ------------------------------------------------------------------- */
    enum MatchState {
        None,           // 0 - never existed
        Created,        // 1 - exists, no agents yet
        AgentsLocked,   // 2 - both snapshots frozen, seed committed
        BettingOpen,    // 3 - taking deposits
        BettingClosed,  // 4 - pools final, seed not yet revealed
        Live,           // 5 - seed revealed, fight running
        Settled,        // 6 - result recorded, claims open
        Cancelled,      // 7 - refunds open, never reached Live
        Voided          // 8 - refunds open, reached Live or closed without a result
    }

    uint8 internal constant SIDE_NONE = 0;
    uint8 internal constant SIDE_A = 1;
    uint8 internal constant SIDE_B = 2;

    /* Finish types, recorded on the NFT and bound into the signature. */
    uint8 public constant FINISH_KO = 1;
    uint8 public constant FINISH_TIMEOUT = 2;
    uint8 public constant FINISH_DRAW = 3;

    struct MatchInfo {
        MatchState state;
        uint16 feeBps;          // snapshotted at creation, never re-read from storage
        uint32 simVersion;      // must match both agents and the settlement
        address creator;
        uint64 createdAt;
        uint64 bettingClosesAt;
        uint64 closedAtBlock;   // block betting closed in; feeds the seed
        uint64 settledAt;
        uint256 minBet;         // snapshotted
        uint256 maxBet;         // snapshotted
        bytes32 seedCommit;     // set at lockAgents, BEFORE any pool exists
        uint256 seed;           // revealed at startMatch
        uint256 poolA;
        uint256 poolB;
        uint8 winner;           // SIDE_A / SIDE_B once settled
        uint8 finishType;
        uint256 distributable;  // total - fee, fixed at settlement
        uint256 winningPool;    // denominator of every payout
        uint256 paidOut;        // running total actually claimed
        uint256 nftTokenId;
    }

    FighterNFT public immutable fighterNFT;

    address public arbiter;
    uint256 public nextMatchId = 1;
    uint256 public accumulatedFees;

    /* Live defaults. Copied into each match at creation; changing them can
       never touch a market that already exists. */
    uint16 public feeBps = 500;             // 5.00%
    uint256 public minBet = 0.001 ether;
    uint256 public maxBet = 1000 ether;

    uint16 public constant MAX_FEE_BPS = 1000;   // 10% ceiling, enforced on the setter
    uint256 public constant BPS = 10000;

    /* Timeouts. Generous, because they only ever unlock refunds. */
    uint64 public constant SETUP_TIMEOUT = 2 hours;   // Created/AgentsLocked -> Cancelled
    uint64 public constant BETTING_GRACE = 2 hours;   // BettingOpen -> Cancelled after close
    uint64 public constant LIVE_TIMEOUT = 2 hours;    // Live -> Voided
    uint256 public constant UNCLAIMED_PERIOD = 90 days;

    /* Bounds on betting windows, so a match cannot open a market that closes
       in the same block (nobody can bet) or in a decade (funds parked). */
    uint64 public constant MIN_BETTING_WINDOW = 30 seconds;
    uint64 public constant MAX_BETTING_WINDOW = 7 days;

    mapping(uint256 => MatchInfo) private _matches;
    mapping(uint256 => mapping(uint8 => AgentTypes.AgentSnapshot)) private _agents;
    mapping(uint256 => mapping(uint8 => bytes32)) public agentHash;
    mapping(uint256 => mapping(address => mapping(uint8 => uint256))) public betOf;
    mapping(uint256 => mapping(address => bool)) public claimed;

    /* ------------------------------------------------------------------
       EIP-712

       The domain separator carries chainId and address(this), so a signature
       produced for the testnet deployment is meaningless against mainnet, and
       one produced for a previous deployment is meaningless against a
       redeploy. That is the whole replay story for free.
    ------------------------------------------------------------------- */
    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(uint256 matchId,bytes32 agentAHash,bytes32 agentBHash,uint256 seed,uint8 winner,uint8 finishType,bytes32 resultDigest,bytes32 decisionHash,uint32 simVersion)"
    );

    struct Settlement {
        uint256 matchId;
        bytes32 agentAHash;
        bytes32 agentBHash;
        uint256 seed;
        uint8 winner;           // SIDE_A, SIDE_B, or SIDE_NONE for a draw
        uint8 finishType;
        bytes32 resultDigest;   // commits to the frame-by-frame outcome
        bytes32 decisionHash;   // commits to the whole JEV decision sequence
        uint32 simVersion;
    }

    event MatchCreated(uint256 indexed matchId, address indexed creator, uint16 feeBps, uint32 simVersion, uint256 minBet, uint256 maxBet);
    event AgentSubmitted(uint256 indexed matchId, uint8 indexed side, address indexed owner, bytes32 snapshotHash);
    event AgentsLocked(uint256 indexed matchId, bytes32 agentAHash, bytes32 agentBHash, bytes32 seedCommit);
    event BettingOpened(uint256 indexed matchId, uint64 closesAt);
    event BetPlaced(uint256 indexed matchId, address indexed bettor, uint8 indexed side, uint256 amount, uint256 poolA, uint256 poolB);
    event BettingClosed(uint256 indexed matchId, uint256 poolA, uint256 poolB);
    event MatchStarted(uint256 indexed matchId, uint256 seed);
    event MatchSettled(uint256 indexed matchId, uint8 indexed winner, uint8 finishType, uint256 totalPool, uint256 fee, uint256 distributable, uint256 nftTokenId, bytes32 resultDigest, bytes32 decisionHash);
    event MatchCancelled(uint256 indexed matchId, string reason);
    event MatchVoided(uint256 indexed matchId, string reason);
    event Claimed(uint256 indexed matchId, address indexed bettor, uint256 amount);
    event ArbiterUpdated(address indexed newArbiter);
    event ParamsUpdated(uint16 feeBps, uint256 minBet, uint256 maxBet);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event DustSwept(uint256 indexed matchId, uint256 amount);

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Arena: not arbiter");
        _;
    }

    constructor(address _fighterNFT, address _arbiter, address _owner)
        Ownable(_owner)
        EIP712("AARAGE ArenaBattle", "2")
    {
        require(_fighterNFT != address(0), "Arena: zero NFT");
        require(_arbiter != address(0), "Arena: zero arbiter");
        fighterNFT = FighterNFT(_fighterNFT);
        arbiter = _arbiter;
    }

    /* ==================================================================
       Admin. None of these can reach a match that already exists.
    ================================================================== */

    function setArbiter(address a) external onlyOwner {
        require(a != address(0), "Arena: zero arbiter");
        arbiter = a;
        emit ArbiterUpdated(a);
    }

    /**
     * @notice Update the defaults copied into FUTURE matches.
     * @dev Deliberately cannot touch a live market: every match carries its
     *      own feeBps/minBet/maxBet from the moment it was created. An owner
     *      who could raise the fee after the crowd deposited would be able to
     *      take their money after the fact.
     */
    function setParams(uint16 _feeBps, uint256 _minBet, uint256 _maxBet) external onlyOwner {
        require(_feeBps <= MAX_FEE_BPS, "Arena: fee too high");
        require(_minBet > 0 && _minBet <= _maxBet, "Arena: bad bet bounds");
        feeBps = _feeBps;
        minBet = _minBet;
        maxBet = _maxBet;
        emit ParamsUpdated(_feeBps, _minBet, _maxBet);
    }

    /** @dev Pausing blocks new markets and new deposits. It never blocks
     *       claim(): money already in the contract must always be able to
     *       leave, or a pause becomes a freeze on other people's funds. */
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /* ==================================================================
       Lifecycle
    ================================================================== */

    /**
     * @notice Open a new match and snapshot the economics that govern it.
     */
    function createMatch(uint32 simVersion) external whenNotPaused returns (uint256) {
        require(simVersion > 0, "Arena: bad sim version");

        uint256 matchId = nextMatchId++;
        MatchInfo storage m = _matches[matchId];
        m.state = MatchState.Created;
        m.creator = msg.sender;
        m.createdAt = uint64(block.timestamp);
        m.simVersion = simVersion;

        // Snapshot, once. Everything downstream reads these, never the live vars.
        m.feeBps = feeBps;
        m.minBet = minBet;
        m.maxBet = maxBet;

        emit MatchCreated(matchId, msg.sender, m.feeBps, simVersion, m.minBet, m.maxBet);
        return matchId;
    }

    /**
     * @notice Submit an agent snapshot for side A or B.
     * @dev Callable only by the agent's own owner. Nothing stops one address
     *      from owning both sides - that is a legitimate solo demo, and the
     *      betting rules do not care who is fighting.
     */
    function submitAgent(uint256 matchId, uint8 side, AgentTypes.AgentSnapshot calldata snap)
        external
        whenNotPaused
    {
        MatchInfo storage m = _matches[matchId];
        require(m.state == MatchState.Created, "Arena: agents not open");
        require(side == SIDE_A || side == SIDE_B, "Arena: bad side");
        require(snap.owner == msg.sender, "Arena: not agent owner");
        require(agentHash[matchId][side] == bytes32(0), "Arena: side taken");
        require(snap.simVersion == m.simVersion, "Arena: sim version mismatch");

        AgentTypes.validate(snap);

        _agents[matchId][side] = snap;
        bytes32 h = AgentTypes.hash(snap);
        agentHash[matchId][side] = h;

        emit AgentSubmitted(matchId, side, snap.owner, h);
    }

    /**
     * @notice Freeze both snapshots and commit to the seed.
     * @param seedCommit keccak256(abi.encode(preimage)) for a preimage the
     *        arbiter has already chosen.
     *
     * @dev The commit lands HERE, before betting opens, which is the entire
     *      anti-grinding argument: at the moment the arbiter fixes the seed
     *      material, no pool exists to grind it against. See startMatch() for
     *      the other half.
     */
    function lockAgents(uint256 matchId, bytes32 seedCommit) external onlyArbiter whenNotPaused {
        MatchInfo storage m = _matches[matchId];
        require(m.state == MatchState.Created, "Arena: not in created");
        require(seedCommit != bytes32(0), "Arena: zero seed commit");

        bytes32 a = agentHash[matchId][SIDE_A];
        bytes32 b = agentHash[matchId][SIDE_B];
        require(a != bytes32(0) && b != bytes32(0), "Arena: agents incomplete");

        m.seedCommit = seedCommit;
        m.state = MatchState.AgentsLocked;

        emit AgentsLocked(matchId, a, b, seedCommit);
    }

    /**
     * @notice Open the market. Strategies are already public and frozen.
     */
    function openBetting(uint256 matchId, uint64 window) external onlyArbiter whenNotPaused {
        MatchInfo storage m = _matches[matchId];
        require(m.state == MatchState.AgentsLocked, "Arena: agents not locked");
        require(window >= MIN_BETTING_WINDOW && window <= MAX_BETTING_WINDOW, "Arena: bad window");

        m.bettingClosesAt = uint64(block.timestamp) + window;
        m.state = MatchState.BettingOpen;

        emit BettingOpened(matchId, m.bettingClosesAt);
    }

    /**
     * @notice Back side A or B with native MON.
     * @dev Players are explicitly allowed. Both strategies are public and
     *      frozen before this function can be reached, so a player betting on
     *      themselves knows exactly what every spectator knows and nothing
     *      more - there is no informational edge left to protect against.
     */
    function placeBet(uint256 matchId, uint8 side) external payable nonReentrant whenNotPaused {
        MatchInfo storage m = _matches[matchId];
        require(m.state == MatchState.BettingOpen, "Arena: betting not open");
        require(block.timestamp < m.bettingClosesAt, "Arena: betting deadline passed");
        require(side == SIDE_A || side == SIDE_B, "Arena: bad side");
        require(msg.value >= m.minBet, "Arena: below min bet");
        require(msg.value <= m.maxBet, "Arena: above max bet");

        betOf[matchId][msg.sender][side] += msg.value;
        if (side == SIDE_A) m.poolA += msg.value;
        else m.poolB += msg.value;

        emit BetPlaced(matchId, msg.sender, side, msg.value, m.poolA, m.poolB);
    }

    /**
     * @notice Close the market once its deadline has passed.
     * @dev Permissionless, and gated purely on the clock. The arbiter is NOT
     *      allowed to close early: an arbiter who could close the instant the
     *      pools looked favourable would be choosing the odds, which is the
     *      same manipulation as choosing the seed.
     */
    function closeBetting(uint256 matchId) external {
        MatchInfo storage m = _matches[matchId];
        require(m.state == MatchState.BettingOpen, "Arena: betting not open");
        require(block.timestamp >= m.bettingClosesAt, "Arena: betting still open");

        m.state = MatchState.BettingClosed;
        m.closedAtBlock = uint64(block.number);

        emit BettingClosed(matchId, m.poolA, m.poolB);
    }

    /**
     * @notice Reveal the seed preimage and start the fight.
     *
     * @dev The seed nobody controls:
     *
     *        seed = H(preimage, blockhash(closedAtBlock), poolA, poolB,
     *                 matchId, address(this))
     *
     *      - the arbiter fixed `preimage` before any pool existed, so it
     *        cannot have been ground against the betting;
     *      - `blockhash(closedAtBlock)` was not knowable when the preimage
     *        was committed, so it cannot have been ground against the agents
     *        either;
     *      - the pools are final and public by now, so nobody can move them;
     *      - matchId and address(this) stop the same preimage producing the
     *        same seed twice.
     *
     *      Neither player touches any input. The arbiter touches one, early
     *      and blind. That is the anti-grinding story in full, and its one
     *      residual limitation is documented in deploy.md.
     *
     *      Must run at least one block after the close (blockhash of the
     *      current block is always zero) and within the 256-block window
     *      where blockhash is still readable; past that the match can only be
     *      voided, and everyone is refunded.
     */
    function startMatch(uint256 matchId, uint256 preimage) external onlyArbiter {
        MatchInfo storage m = _matches[matchId];
        require(m.state == MatchState.BettingClosed, "Arena: betting not closed");
        require(keccak256(abi.encode(preimage)) == m.seedCommit, "Arena: seed commit mismatch");
        require(block.number > m.closedAtBlock, "Arena: same block as close");
        require(block.number <= m.closedAtBlock + 256, "Arena: seed window expired");

        uint256 seed = uint256(
            keccak256(
                abi.encode(
                    preimage,
                    blockhash(m.closedAtBlock),
                    m.poolA,
                    m.poolB,
                    matchId,
                    address(this)
                )
            )
        );

        m.seed = seed;
        m.state = MatchState.Live;

        emit MatchStarted(matchId, seed);
    }

    /* ==================================================================
       Settlement
    ================================================================== */

    /**
     * @notice Record an arbiter-signed result, fix the payout ratios, and
     *         mint the winner's NFT. Moves no money.
     */
    function settleMatch(Settlement calldata s, bytes calldata signature) external nonReentrant {
        MatchInfo storage m = _matches[s.matchId];
        require(m.state == MatchState.Live, "Arena: match not live");

        /* Bind the signed result to the match that is actually on chain.
           Each of these is a separate class of forged settlement: a result
           for a different agent build, a different seed, or a different set
           of simulation rules. */
        require(s.agentAHash == agentHash[s.matchId][SIDE_A], "Arena: agent A mismatch");
        require(s.agentBHash == agentHash[s.matchId][SIDE_B], "Arena: agent B mismatch");
        require(s.seed == m.seed, "Arena: seed mismatch");
        require(s.simVersion == m.simVersion, "Arena: sim version mismatch");
        require(
            s.winner == SIDE_A || s.winner == SIDE_B || s.winner == SIDE_NONE,
            "Arena: bad winner"
        );
        require(
            s.finishType == FINISH_KO || s.finishType == FINISH_TIMEOUT || s.finishType == FINISH_DRAW,
            "Arena: bad finish type"
        );
        require(
            (s.winner == SIDE_NONE) == (s.finishType == FINISH_DRAW),
            "Arena: winner/finish disagree"
        );

        address signer = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SETTLEMENT_TYPEHASH,
                    s.matchId,
                    s.agentAHash,
                    s.agentBHash,
                    s.seed,
                    s.winner,
                    s.finishType,
                    s.resultDigest,
                    s.decisionHash,
                    s.simVersion
                )
            )
        ).recover(signature);
        require(signer == arbiter, "Arena: bad arbiter signature");

        _resolve(m, s);
    }

    /**
     * @dev Split out purely to keep settleMatch inside the stack limit.
     */
    function _resolve(MatchInfo storage m, Settlement calldata s) private {
        uint256 total = m.poolA + m.poolB;
        uint256 winningPool = s.winner == SIDE_A ? m.poolA : (s.winner == SIDE_B ? m.poolB : 0);

        m.finishType = s.finishType;
        m.settledAt = uint64(block.timestamp);

        /* A draw, or a winning side nobody backed. Either way there is no
           denominator to divide by, so the market never resolved: refund
           everyone on both sides and take no fee. Charging a house cut on a
           market that produced no winners would be taking money for nothing.

           Note this is reached even when `total` is zero (a match nobody bet
           on) - harmless, and it keeps the branch honest rather than special
           casing an empty pool. */
        if (s.winner == SIDE_NONE || winningPool == 0) {
            m.state = MatchState.Voided;
            m.winner = s.winner;
            emit MatchVoided(
                s.matchId,
                s.winner == SIDE_NONE ? "draw - all bets refunded" : "no winning bettors - all bets refunded"
            );
            emit MatchSettled(s.matchId, s.winner, s.finishType, total, 0, 0, 0, s.resultDigest, s.decisionHash);
            return;
        }

        uint256 fee = (total * m.feeBps) / BPS;
        uint256 distributable = total - fee;

        m.state = MatchState.Settled;
        m.winner = s.winner;
        m.winningPool = winningPool;
        m.distributable = distributable;
        accumulatedFees += fee;

        /* Mint last. It is the only external call in here, it goes to a
           contract this one deployed alongside, and every piece of state it
           could observe is already written. */
        uint256 tokenId = _mintWinner(m, s);
        m.nftTokenId = tokenId;

        emit MatchSettled(s.matchId, s.winner, s.finishType, total, fee, distributable, tokenId, s.resultDigest, s.decisionHash);
    }

    function _mintWinner(MatchInfo storage m, Settlement calldata s) private returns (uint256) {
        uint8 loserSide = s.winner == SIDE_A ? SIDE_B : SIDE_A;
        AgentTypes.AgentSnapshot storage w = _agents[s.matchId][s.winner];

        return fighterNFT.mintWinner(
            FighterNFT.WinnerData({
                to: w.owner,
                matchId: s.matchId,
                name: w.name,
                prompt: w.prompt,
                archetype: w.archetype,
                model: w.model,
                aggression: w.aggression,
                defense: w.defense,
                speed: w.speed,
                finishType: s.finishType,
                seed: m.seed,
                opponent: _agents[s.matchId][loserSide].owner,
                snapshotHash: agentHash[s.matchId][s.winner],
                opponentHash: agentHash[s.matchId][loserSide],
                decisionHash: s.decisionHash,
                resultDigest: s.resultDigest,
                simVersion: m.simVersion
            })
        );
    }

    /* ==================================================================
       Failure paths
    ================================================================== */

    /**
     * @notice Abandon a match that never reached the fight. Bets refund via claim().
     */
    function cancelMatch(uint256 matchId) external {
        MatchInfo storage m = _matches[matchId];
        MatchState st = m.state;
        require(
            st == MatchState.Created || st == MatchState.AgentsLocked || st == MatchState.BettingOpen,
            "Arena: not cancellable"
        );

        bool authorized = msg.sender == arbiter || msg.sender == owner();
        if (!authorized && msg.sender == m.creator && st != MatchState.BettingOpen) {
            /* The creator can walk away from a match nobody has money in yet.
               Once betting is open that door closes - otherwise a creator
               watching the pools go against them could cancel the market
               instead of losing it. */
            authorized = true;
        }
        if (!authorized) {
            uint64 deadline = st == MatchState.BettingOpen
                ? m.bettingClosesAt + BETTING_GRACE
                : m.createdAt + SETUP_TIMEOUT;
            require(block.timestamp >= deadline, "Arena: not authorized yet");
            authorized = true;
        }

        m.state = MatchState.Cancelled;
        emit MatchCancelled(matchId, "cancelled - all bets refunded");
    }

    /**
     * @notice Void a match that closed or started but never produced a result.
     * @dev Permissionless after the timeout so a silent arbiter cannot strand
     *      the pools. Refunds open immediately via claim().
     */
    function voidMatch(uint256 matchId) external {
        MatchInfo storage m = _matches[matchId];
        MatchState st = m.state;
        require(st == MatchState.BettingClosed || st == MatchState.Live, "Arena: not voidable");

        if (msg.sender != arbiter && msg.sender != owner()) {
            uint64 base = st == MatchState.BettingClosed ? m.bettingClosesAt : m.bettingClosesAt;
            require(block.timestamp >= base + LIVE_TIMEOUT, "Arena: not timed out");
        }

        m.state = MatchState.Voided;
        emit MatchVoided(matchId, "voided - all bets refunded");
    }

    /* ==================================================================
       Claims
    ================================================================== */

    /**
     * @notice Take your winnings, or your refund. One call covers both.
     * @dev Deliberately NOT gated on whenNotPaused - see pause().
     */
    function claim(uint256 matchId) external nonReentrant {
        MatchInfo storage m = _matches[matchId];
        require(!claimed[matchId][msg.sender], "Arena: already claimed");

        uint256 amount = _claimable(m, matchId, msg.sender);
        require(amount > 0, "Arena: nothing to claim");

        // Effects before interaction; nonReentrant is the belt to this braces.
        claimed[matchId][msg.sender] = true;
        if (m.state == MatchState.Settled) m.paidOut += amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Arena: transfer failed");

        emit Claimed(matchId, msg.sender, amount);
    }

    function _claimable(MatchInfo storage m, uint256 matchId, address who) private view returns (uint256) {
        MatchState st = m.state;

        if (st == MatchState.Settled) {
            uint256 stake = betOf[matchId][who][m.winner];
            if (stake == 0 || m.winningPool == 0) return 0;
            /* Floor division. The remainder is dust, at most one wei per
               winning bettor, and sweepDust() says where it goes. */
            return (m.distributable * stake) / m.winningPool;
        }

        if (st == MatchState.Cancelled || st == MatchState.Voided) {
            return betOf[matchId][who][SIDE_A] + betOf[matchId][who][SIDE_B];
        }

        return 0;
    }

    /**
     * @notice What claim() would pay right now.
     */
    function claimable(uint256 matchId, address who) external view returns (uint256) {
        if (claimed[matchId][who]) return 0;
        return _claimable(_matches[matchId], matchId, who);
    }

    /* ==================================================================
       Treasury
    ================================================================== */

    function withdrawFees(address payable to) external onlyOwner nonReentrant {
        require(to != address(0), "Arena: zero address");
        uint256 amount = accumulatedFees;
        require(amount > 0, "Arena: no fees");
        accumulatedFees = 0;

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Arena: fee transfer failed");

        emit FeesWithdrawn(to, amount);
    }

    /**
     * @notice Sweep the rounding remainder, and anything a winner never came
     *         back for, into the fee balance.
     * @dev Time-locked 90 days past settlement. The dust itself is wei-scale
     *      and not worth gaming; the lock exists so this can never be used to
     *      front-run a winner who is simply slow to claim.
     */
    function sweepDust(uint256 matchId) external onlyOwner {
        MatchInfo storage m = _matches[matchId];
        require(m.state == MatchState.Settled, "Arena: not settled");
        require(block.timestamp >= m.settledAt + UNCLAIMED_PERIOD, "Arena: too early");
        require(m.distributable > m.paidOut, "Arena: nothing to sweep");

        uint256 amount = m.distributable - m.paidOut;
        m.paidOut = m.distributable;
        accumulatedFees += amount;

        emit DustSwept(matchId, amount);
    }

    /* ==================================================================
       Views
    ================================================================== */

    function getMatch(uint256 matchId) external view returns (MatchInfo memory) {
        return _matches[matchId];
    }

    function getAgent(uint256 matchId, uint8 side) external view returns (AgentTypes.AgentSnapshot memory) {
        require(side == SIDE_A || side == SIDE_B, "Arena: bad side");
        return _agents[matchId][side];
    }

    /**
     * @notice Live pool state plus the fee the match is locked to.
     */
    function pools(uint256 matchId)
        external
        view
        returns (uint256 poolA, uint256 poolB, uint16 matchFeeBps, uint8 state, uint64 closesAt)
    {
        MatchInfo storage m = _matches[matchId];
        return (m.poolA, m.poolB, m.feeBps, uint8(m.state), m.bettingClosesAt);
    }

    /**
     * @notice What adding `amount` to `side` would pay if that side won,
     *         given the pools as they stand.
     * @dev The frontend's odds preview calls this rather than reimplementing
     *      the arithmetic, so the number quoted before a bet is the number
     *      the contract pays after it. Estimates only: the pools keep moving
     *      until betting closes.
     */
    function quote(uint256 matchId, uint8 side, uint256 amount) external view returns (uint256) {
        require(side == SIDE_A || side == SIDE_B, "Arena: bad side");
        MatchInfo storage m = _matches[matchId];

        uint256 mine = (side == SIDE_A ? m.poolA : m.poolB) + amount;
        uint256 total = m.poolA + m.poolB + amount;
        if (mine == 0 || total == 0) return 0;

        uint256 distributable = total - (total * m.feeBps) / BPS;
        return (distributable * amount) / mine;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /** @dev No stray deposits: every MON in here belongs to a specific match. */
    receive() external payable {
        revert("Arena: direct deposits disabled");
    }
}
