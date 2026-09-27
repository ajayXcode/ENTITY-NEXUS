/* ------------------------------------------------------------------
   config.js - every tunable number in the project.

   ARENA GEOMETRY, derived from the sprite attack boxes in game.js.
   Let d = enemy.position.x - player.position.x  (both bodies are 50 wide,
   so d = 50 means they are touching).

     Samurai (P1, faces RIGHT): attack box spans [x+100, x+220]
       -> can land a hit when  d in [50, 220]
     Monk    (P2, faces LEFT):  attack box spans [x-170, x]
       -> can land a hit when  d in [0, 220]

   Mutual strike band is therefore d in [50, 220], and with MIN_GAP at 70 the
   effective band is [70, 220] for BOTH fighters - deliberately symmetric.

   Neither sprite sheet has a mirrored version, so the fighters must never
   cross over - if they did, both attack boxes would point away from the
   opponent and no hit could ever land again. resolveSeparation() in game.js
   enforces d >= MIN_GAP as a hard floor.

   MAX_KITE must sit ABOVE 220 so that retreating actually takes you out of
   reach - otherwise a dodge is purely cosmetic and nobody ever whiffs.
------------------------------------------------------------------- */

const CONFIG = {
  /* ---- Round structure ---- */
  /* 25, not 30. Measured over 1250 fights the longest round ran 24.2s and
     the median 18.3s, so a 30s clock was pure decoration - nothing ever
     reached it and no finish ever felt like it beat the buzzer. At 25 the
     sudden-death mark at 20s IS the final five seconds. */
  FIGHT_SECONDS: 25,
  PROMPT_SECONDS: 60,
  ANALYZE_MS: 3000,
  REVEAL_MS: 5600,
  MAX_PROMPT_WORDS: 200,     // hard limit on a strategy prompt
  MAX_PROMPT_CHARS: 1600,    // safety backstop (200 words of sane length)
  HUD_PROMPT_CHARS: 150,     // how much of it fits on the fight HUD

  /* ---- Gemini stat engine (js/gemini.js + server.js) ----
     Strictly an upgrade path: if the arena server is not running, or the
     keys are exhausted, or Google is slow, the local lexicon parse that is
     already on screen is what the fight uses. The demo cannot fail here.
     ?noai=1 forces the local parser, which is worth knowing the night
     before a presentation. */
  AI_ENABLED: true,
  AI_ENDPOINT: '/api/analyze',
  /* Measured: gemini-3.6-flash returns this prompt in ~2.0-2.5s, with the
     occasional 4s. 7000 leaves room for one silent key failover inside the
     server before the client gives up. Both players are asked in parallel,
     so this is the wait for the pair, not per fighter. */
  AI_TIMEOUT_MS: 7000,
  /* How long the ANALYZING screen may hold past its scripted 3s while
     waiting for the verdict. Past this it stops waiting and the local parse
     stands - an audience notices six seconds of spinner, and a fight that
     starts is worth more than a fight that is better balanced. */
  AI_MAX_WAIT_MS: 6500,

  /* ---- Arena ---- */
  MIN_GAP: 70,        // hard separation floor
  /* Must sit ABOVE the 220 strike ceiling, or retreating can never take you
     out of reach and a dodge is cosmetic. At 210 nobody ever whiffed
     (97% accuracy), so the whiff-punish window never opened and defensive
     prompts had no way to win. */
  MAX_KITE: 252,
  CLOSE_MAX: 115,     // d below this: too close, back off
  BAND_MAX: 205,      // d up to this: both can land a hit
  MID_MAX: 310,       // d up to this: approach range
  /* Symmetric about the canvas centre: each fighter starts 247px from its
     own wall (canvas 1024, body 50 -> max x 974). Upstream's 220/700 gave
     P2 54px more room to retreat into, which matters a great deal now that
     MAX_KITE is 252 - P1 got cornered first, could not kite out of reach,
     and lost mirror matches it should have split. */
  START_P1_X: 247,
  START_P2_X: 727,
  GROUND_Y: 330,
  JUMP_V: -20,

  /* ---- Pressure ramp: guarantees a finish even if both prompts are cowardly ----
     pressure ramps 0 -> 1 between these two marks, then sudden death. */
  PRESSURE_START_S: 7,
  PRESSURE_FULL_S: 18,
  SUDDEN_DEATH_S: 20,

  /* Frames between an attack starting and its damage resolving. SHARED by
     both fighters so neither telegraphs longer than the other. Still the
     default, and still what `normal` uses - MOVES below is expressed as
     offsets around it. */
  ATTACK_STARTUP: 11,

  /* ---- The movelist -------------------------------------------------
     Three attacks, and the trade between them is the classic one: speed
     costs damage, damage costs safety.

       jab     fast, weak, cheap to throw and cheap to whiff
       normal  the original attack, unchanged in every respect
       heavy   slow and telegraphed, hits hard, brutal if it misses

     These numbers are SHARED BY BOTH CHARACTERS, deliberately and without
     exception. Every balance bug this project has had came from letting the
     two sprite sheets have different mechanical timings - the README's
     history is a list of them, worth up to 20 points of win rate each. The
     sheets differ in frame count (Samurai 6, Monk 4), so the *animation*
     ranges in game.js differ; the mechanics here do not.

     `startup`  frames until damage resolves. Also the telegraph: a defender
                reacting inside this window escapes.
     `dmg`      multiplier on the fighter's base damage.
     `cdMult`   multiplier on the attack cooldown.
     `recovery` the punish window opened by a WHIFF. Heavy missing should
                genuinely hurt, or there is no reason ever to throw a jab. */
  MOVES: {
    jab:    { startup: 7,  dmg: 0.60, cdMult: 0.70, recovery: 15 },
    normal: { startup: 11, dmg: 1.00, cdMult: 1.00, recovery: 24 },
    heavy:  { startup: 17, dmg: 1.55, cdMult: 1.32, recovery: 34 }
  },

  /* ---- Blocking ------------------------------------------------------
     Without this, defense is only ever a damage multiplier and every
     exchange is two bars draining at different rates. A block is the first
     thing in the game that makes an incoming attack produce NOTHING, which
     is what turns a fight into a read rather than a race.

     It closes a triangle, and the triangle is the point:

       block  beats  jab and normal   (chip only, attacker shoved back)
       heavy  beats  block            (guard break - the block is the thing
                                       that loses, not just a worse trade)
       punish beats  heavy            (34 frames of whiff recovery)

     Every number here is chosen so that no corner of that triangle is free.
     Blocking is not a state you can simply live in: it has a hard duration,
     a cooldown, and chip damage still accrues, so a fighter who only ever
     blocks still loses - slowly, which the pressure ramp then accelerates.

     GUARD_BREAK_STUN is the largest punish window in the game on purpose.
     Reading a block and answering it with a heavy should be the single most
     rewarding decision available, or nobody would ever risk the heavy. */
  BLOCK: {
    CHIP: 0.16,           // fraction of damage that gets through a guard
    MAX_FRAMES: 30,       // longest one block can be held
    COOLDOWN: 24,         // frames before another block can start
    STUN: 4,              // hitstun while guarding (vs 15 taking it clean)
    PUSHBACK: 9,          // the attacker is shoved off a successful guard
    BREAK_DMG: 0.60,      // heavy through a guard still does most of its damage
    BREAK_STUN: 28        // ...and leaves the guard wide open
  },

  /* Chance a defensive fighter answers a telegraphed attack with a block
     rather than a dodge. Aggression pulls it down: a berserker does not
     guard, it swings back. */
  pBlock: (s) => clamp(0.12 + 0.72 * s.defense - 0.30 * s.aggression, 0, 0.88),

  /* ---- Drama ----------------------------------------------------------
     RAGE is the comeback engine: below RAGE_START health a fighter hits
     harder, swings sooner and moves faster, scaling to full at 0 HP. It is
     the standard fighting-game answer (SF Revenge, Smash rage) to the fact
     that a fight already decided is a boring fight - the loser stays
     genuinely dangerous right to the last hit.

     LAST STAND fires once per fighter: a blow that would kill you from
     healthy leaves you on a sliver instead. One per round, and only from
     above LAST_STAND_MIN_HP, so it reads as a clutch survival rather than
     the game refusing to let anyone die. */
  RAGE_START: 0.45,          // hp fraction where rage begins
  RAGE_DMG: 0.38,            // +38% damage at 0 hp
  RAGE_CD: 0.18,             // -18% attack cooldown at full rage
  RAGE_SPEED: 0.16,
  RAGE_AGGRO: 0.28,
  LAST_STAND_HP: 4,          // health you are left on
  LAST_STAND_MIN_HP: 20,     // must have been above this for it to fire
  /* Only some fighters get a last stand at all, rolled per fight from the
     seed. Guaranteeing it made every single round a photo finish, which
     makes none of them feel like one - the drama has to be the exception. */
  LAST_STAND_CHANCE: 0.40,
  DANGER_HP: 25,

  /* ---- Feel ---- */
  HITSTOP_FRAMES: 4,
  SHAKE_FRAMES: 10,
  KNOCKBACK: 14,

  /* ---- Stat -> behaviour. s is {aggression, defense, speed} in 0..1 ---- */

  // Movement. Upstream's fixed speed was 5; that is now our floor.
  moveSpeed: (s) => 5 + 6 * s.speed,

  // How often the AI re-decides. Fast fighters also *react* faster, which
  // reads as speed far more than raw velocity does.
  decisionPeriod: (s) => Math.round(14 - 8 * s.speed),

  // Preferred standoff distance. Turtles hover a body-length further out
  // than berserkers - the clearest visual tell of a defensive prompt.
  bandTarget: (s) => clamp(165 - 25 * s.aggression + 30 * s.defense, 115, 210),

  /* Attack cooldown, in frames. Shared formula for both sides - the only
     difference is the floor, which is (attack animation length + 5) so we
     never queue an attack into a switchSprite that is still locked:
       Samurai attack = 6 anim frames x 5 hold = 30 -> floor 35
       Monk    attack = 4 anim frames x 5 hold = 20 -> floor 25
     An earlier version gave the two sides different bases to compensate for
     the Monk's faster damage frame. The bench showed that overcorrected
     badly (P1 won mirrors ~75%), so they are symmetric now. This is the
     main balance dial - check any change with ?bench=N. */
  cooldown: (s) => Math.round(76 - 24 * s.aggression - 14 * s.speed),

  /* SHARED floor, both sides. The two characters' attack animations are
     different lengths (Samurai 6 frames = 30, Monk 4 frames = 20), so their
     physical minimums differ: 35 vs 25. That never mattered while cooldowns
     sat above both - but the combo discount drives cooldown down to ~19,
     where both floors bind and the Monk chains 40% faster than the Samurai
     physically can. It handed P2 every aggressive mirror match (32/68).
     Capping both at the slower character's floor removes the asymmetry at
     source; the Monk simply doesn't get to out-cadence the Samurai. */
  COOLDOWN_FLOOR_P1: 25,   // Samurai attack is now 18 game frames + margin
  COOLDOWN_FLOOR_P2: 25,   // Monk attack is 20 game frames + margin

  /* No per-character damage compensation is needed now that the cooldown
     floor is shared - this was a patch over that asymmetry. Kept as a dial
     in case the bench ever shows a residual lean. */
  CHAR_DMG: { left: 1.0, right: 1.0 },

  /* Damage. Deliberately low at the start and savage at the end: early
     exchanges chip, late ones kill. Combined with PRESSURE_DMG below this
     is what drags finishes toward the buzzer instead of resolving them at
     the eight-second mark, which is what makes a comeback feel last-minute
     rather than just close. */
  baseDamage: (s) => 6 + 8 * s.aggression,
  PRESSURE_DMG: 1.15,        // damage multiplier added at full pressure
  SUDDEN_DEATH_DMG: 2.2,

  /* Damage TAKEN. Defense reduces it, and aggression raises it - a high
     aggression prompt is explicitly a glass cannon. Without the aggression
     term, attacking was strictly better than defending (more damage AND
     more attacks) and every berserker-vs-turtle ended 100/0. */
  damageTakenMult: (s) => clamp(1 - 0.40 * s.defense + 0.25 * s.aggression, 0.55, 1.35),

  /* ---- Behaviour probabilities ---- */
  pAttackInBand: (a) => 0.42 + 0.50 * a,
  pRetreat: (d) => 0.50 * d,
  pDodgeReact: (d) => 0.18 + 0.72 * d,
  pHop: (s) => 0.10 + 0.25 * s,
  pPunish: (a) => 0.70 + 0.30 * a,

  JITTER: 0.10,       // +/- noise on every probability
  WILDCARD: 0.06      // chance a tick ignores the plan entirely
}

/* ---- Monad network & contract config ---- */
const MONAD = {
  /* Flipped to true once arenaAddress/nftAddress below are real. Until then
     every chain path is labelled DEMO in the UI and nothing claims to have
     touched Monad - see blockchain.js. */
  USE_REAL_CHAIN: true,

  chainIdHex: '0x279f',              // 10143 (Monad Testnet)
  chainIdDec: 10143,
  chainName: 'Monad Testnet',
  /* More than one, in preference order, because a single public endpoint
     is a single point of failure for every number on the page. When the
     first one rate-limits or 4xxs, js/betting.js rotates to the next
     rather than reporting the pools as unknown.

     The first entry is also what gets handed to MetaMask in
     wallet_addEthereumChain, so it should stay the canonical one.

     Both were checked with a real eth_call against the deployed
     ArenaBattle, not just eth_chainId - an endpoint can answer the second
     and refuse the first, which is how a fallback ends up being no
     fallback at all. */
  rpcUrls: [
    'https://testnet-rpc.monad.xyz',
    'https://rpc.ankr.com/monad_testnet'
  ],
  blockExplorerUrls: ['https://testnet.monadexplorer.com'],
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },

  // Filled in by contracts/scripts/deploy.js output.
  arenaAddress: '0x0329D1A516e9F5f8a89B48C4AD0515884f0652a5',
  nftAddress: '0xD12205ea18E336F2a4995Cc0Ef6226efaC48639F',

  /* The rules version of the deterministic engine. The contract refuses an
     agent or a settlement built against a different one, so bumping this
     after changing fight physics is what stops a result produced under new
     rules settling a match the crowd bet on under the old ones. */
  SIM_VERSION: 1,

  FEE_BPS: 500,                      // mirrors the contract default
  defaultBet: '0.05',
  /* Seconds the market stays open. Only used by the legacy arena screen
     (js/arena.js), where the browser opens its own match. A room fight's
     window is set by the SERVER, which owns the market now and has to,
     because the fight does not start until a backer is on each side and
     only the server can read the pools - see WINDOW_SECONDS in
     house/rooms-chain.js and house/director.js. */
  BETTING_WINDOW: 120,

  SIDE_A: 1,
  SIDE_B: 2,

  /* MatchState, straight off the contract enum. Index is the number the
     `getMatch` getter returns, and there is no worse place for an off-by-one:
     this is what decides whether betting is open. */
  STATE: ['none', 'created', 'agents_locked', 'betting_open', 'betting_closed',
          'live', 'settled', 'cancelled', 'voided'],

  FINISH: { KO: 1, TIMEOUT: 2, DRAW: 3 },

  /* EIP-712 domain. Must match the contract's constructor exactly or every
     signature this project produces verifies as some other address. */
  EIP712_DOMAIN_NAME: 'AARAGE ArenaBattle',
  EIP712_DOMAIN_VERSION: '2',

  ARENA_ABI: [
    'function createMatch(uint32 simVersion) external returns (uint256)',
    'function submitAgent(uint256 matchId, uint8 side, (address owner, string name, string prompt, string model, string modelVersion, string archetype, bytes32 jevConfigHash, uint8 aggression, uint8 defense, uint8 speed, uint32 simVersion) snap) external',
    'function lockAgents(uint256 matchId, bytes32 seedCommit) external',
    'function openBetting(uint256 matchId, uint64 window) external',
    'function placeBet(uint256 matchId, uint8 side) external payable',
    'function closeBetting(uint256 matchId) external',
    'function startMatch(uint256 matchId, uint256 preimage) external',
    'function settleMatch((uint256 matchId, bytes32 agentAHash, bytes32 agentBHash, uint256 seed, uint8 winner, uint8 finishType, bytes32 resultDigest, bytes32 decisionHash, uint32 simVersion) s, bytes signature) external',
    'function claim(uint256 matchId) external',
    'function cancelMatch(uint256 matchId) external',
    'function voidMatch(uint256 matchId) external',
    'function claimable(uint256 matchId, address who) external view returns (uint256)',
    'function quote(uint256 matchId, uint8 side, uint256 amount) external view returns (uint256)',
    'function pools(uint256 matchId) external view returns (uint256 poolA, uint256 poolB, uint16 matchFeeBps, uint8 state, uint64 closesAt)',
    'function getMatch(uint256 matchId) external view returns ((uint8 state, uint16 feeBps, uint32 simVersion, address creator, uint64 createdAt, uint64 bettingClosesAt, uint64 closedAtBlock, uint64 settledAt, uint256 minBet, uint256 maxBet, bytes32 seedCommit, uint256 seed, uint256 poolA, uint256 poolB, uint8 winner, uint8 finishType, uint256 distributable, uint256 winningPool, uint256 paidOut, uint256 nftTokenId))',
    'function getAgent(uint256 matchId, uint8 side) external view returns ((address owner, string name, string prompt, string model, string modelVersion, string archetype, bytes32 jevConfigHash, uint8 aggression, uint8 defense, uint8 speed, uint32 simVersion))',
    'function agentHash(uint256 matchId, uint8 side) external view returns (bytes32)',
    'function betOf(uint256 matchId, address bettor, uint8 side) external view returns (uint256)',
    'function claimed(uint256 matchId, address bettor) external view returns (bool)',
    'function nextMatchId() external view returns (uint256)',
    'event MatchCreated(uint256 indexed matchId, address indexed creator, uint16 feeBps, uint32 simVersion, uint256 minBet, uint256 maxBet)',
    'event AgentSubmitted(uint256 indexed matchId, uint8 indexed side, address indexed owner, bytes32 snapshotHash)',
    'event AgentsLocked(uint256 indexed matchId, bytes32 agentAHash, bytes32 agentBHash, bytes32 seedCommit)',
    'event BettingOpened(uint256 indexed matchId, uint64 closesAt)',
    'event BetPlaced(uint256 indexed matchId, address indexed bettor, uint8 indexed side, uint256 amount, uint256 poolA, uint256 poolB)',
    'event BettingClosed(uint256 indexed matchId, uint256 poolA, uint256 poolB)',
    'event MatchStarted(uint256 indexed matchId, uint256 seed)',
    'event MatchSettled(uint256 indexed matchId, uint8 indexed winner, uint8 finishType, uint256 totalPool, uint256 fee, uint256 distributable, uint256 nftTokenId, bytes32 resultDigest, bytes32 decisionHash)',
    'event MatchVoided(uint256 indexed matchId, string reason)',
    'event MatchCancelled(uint256 indexed matchId, string reason)',
    'event Claimed(uint256 indexed matchId, address indexed bettor, uint256 amount)'
  ],

  NFT_ABI: [
    'function tokenURI(uint256 tokenId) external view returns (string)',
    'function ownerOf(uint256 tokenId) external view returns (address)',
    'function totalMinted() external view returns (uint256)',
    'function tokenOfMatch(uint256 matchId) external view returns (uint256)'
  ]
}

/* ==================================================================
   PEN FIGHT - the second game. Same prompt, same stats, a desk instead
   of an arena.

   Everything here is in SI units, because the whole mode is a real rigid
   body simulation and guessing at "feels about right" numbers in made-up
   units is how a pen ends up sliding like a hockey puck. A pen is 14.5cm
   and 12 grams, the desk is 1.24m x 0.76m, friction is a real Coulomb
   deceleration, and one flick is an impulse in kg m/s.

   The two numbers everything else is balanced around:

     MAX_IMPULSE 0.034 kg m/s / 0.012 kg  ->  2.83 m/s off the finger
     travel = v^2 / (2 * MU) = 8.03 / 4.6 ->  1.74m of slide

   A full-power flick therefore carries further than the desk is long. That
   is the whole design of the mode in one line: a smash that CONNECTS wins
   the round, and a smash that WHIFFS puts your own pen on the floor. Nobody
   had to write a whiff-punish rule - the desk is the punish.

   These were 0.022 and 3.6 first, and that pairing quietly broke the game:
   max travel came to 0.47m, less than the gap the pens start at, so no
   flick could reach without dying on the way and 60% of all losses were
   self-inflicted. The bench read "coward beats everything 64-75%" because
   the passive prompt was simply the one that declined to take part.
================================================================== */

const PEN = {
  /* ---- the desk (half-extents, metres) ---- */
  DESK_HX: 0.62,
  DESK_HZ: 0.38,

  /* Sudden death closes the desk in rather than just multiplying damage.
     A pen fight that ends on a health bar is a pen fight nobody remembers;
     shrinking the desk guarantees the round ends with something going over
     an edge. */
  /* The desk closes in. This is the pen game's answer to the fighting
     game's pressure ramp, and it has to be on its own clock rather than
     CONFIG.SUDDEN_DEATH_S: pen rounds run 4-14s, so a squeeze that started
     at 20s never once fired and passive prompts simply outlived everyone
     (the bench read coward 57-69% against the field).

     It is aimed squarely at that. A careful pen wins by retreating to the
     middle and waiting; shrinking the desk is the one punishment that takes
     the middle away, because the middle is defined by the edges. */
  SHRINK_START_S: 8,
  SHRINK_SECONDS: 10,       // seconds to close fully
  SHRINK_TO: 0.50,          // fraction of the original desk at full shrink

  /* ---- the pen ---- */
  LEN: 0.145,               // 14.5cm barrel, tip to cap
  RAD: 0.0062,              // 12mm across the grip
  MASS: 0.012,              // 12g
  /* The cap end is heavier than the nib end on every pen ever made, and it
     is why a real pen pivots around its back third instead of its middle.
     Offset of the centre of mass from the geometric centre, toward the cap,
     as a fraction of half-length. */
  COM_OFFSET: 0.18,

  /* ---- desk friction ---- */
  /* Linear deceleration, m/s^2. mu_k ~0.23 for a polished barrel on a
     varnished desk - the low end of the plausible 0.2-0.35 range, chosen
     deliberately: friction is what decides how far a STRUCK pen travels, and
     at 2.6 a clean hit moved the other pen 23cm, which is nowhere near an
     edge from the middle of the desk. Landing a smash won 1-3% of rounds.
     A slicker desk pays attacking prompts without making misses safer,
     because a miss is already clamped by the runway check. */
  MU: 2.3,
  SPIN_MU: 9.0,             // angular deceleration, rad/s^2
  STOP_V: 0.018,            // below this it is considered stopped
  STOP_W: 0.22,

  /* ---- pen on pen ---- */
  RESTITUTION: 0.50,        // plastic clack, not a superball. Raised from 0.36:
                            // with equal masses the struck pen leaves at
                            // v*(1+e)/2, so e is literally how much of an
                            // attack CONVERTS - and at 0.36 landing a hit
                            // barely moved anyone, which is why passivity
                            // was winning. It also rebounds the attacker,
                            // so connecting is now safER than whiffing.
  FRICTION: 0.30,           // tangential impulse - this is the spin transfer,
                            // and spin transfer is why glancing blows read
                            // as glancing blows

  /* ---- the flick ---- */
  MAX_IMPULSE: 0.034,
  SETTLE_SPEED: 0.055,      // you may not flick a pen that is still moving
  TURN_RATE: 0.085,         // rad/frame while aiming - the visible telegraph
  ENGLISH: 0.9,             // lateral offset of the flick, in pen radii
  AIM_SPREAD: 0.30,         // rad of aim error before stat scaling

  /* Three flicks, and the same trade as the movelist in the main game:
     power costs time, and time is the only thing the other pen needs.
       tap    reposition, chip, set up a line
       drive  the honest attack
       smash  wins the round or loses it

     `arrive` is the speed the pen wants to be doing AT THE CONTACT, in m/s -
     not the speed it leaves the finger at. Damage is closing speed, so that
     is the number that decides how hard the flick lands, and the launch
     speed is then solved backwards from the gap:

       v0 = sqrt(arrive^2 + 2 * MU * gap)

     Expressing it this way is what makes distance a real decision rather
     than a nuisance: the same smash is a completely different shot from
     across the desk than from five centimetres away, and the AI has to
     spend more of its 2.5 m/s ceiling the further out it commits from. */
  MOVES: {
    tap:   { arrive: 0.40, windup: 13, cd: 24 },
    drive: { arrive: 1.20, windup: 23, cd: 38 },
    smash: { arrive: 2.00, windup: 37, cd: 58 }
  },

  /* How closely the pen must be pointing down its chosen line before it is
     allowed to let go, and how many extra frames it may spend getting there.
     A flick leaves along the barrel, so firing before the turn is finished
     sends the pen somewhere nobody planned and every safety check was done
     against the plan. */
  AIM_TOL: 0.06,            // radians, ~3.4 degrees
  MAX_ALIGN: 45,            // frames of grace before it commits anyway

  DANGER_MARGIN: 0.09,      // this close to an edge and a careful pen retreats
  SETUP_QUALITY: 0.32,      // line quality below which a thinker repositions

  /* Committing range. Past this gap a flick has to be thrown nearly flat out
     just to ARRIVE - v0 = sqrt(arrive^2 + 2*MU*gap) grows fast - and a
     nearly-flat-out flick that misses does not stop before the far edge. So
     beyond this the pen closes the distance instead of swinging, and the
     round develops as approach, approach, strike.

     This is the desk's version of CONFIG.bandTarget: the fighting game has a
     preferred standoff distance and so does a pen, for the same reason - the
     interesting decisions all live at one range and throwing from outside it
     is not aggression, it is a donation. Berserkers commit from further out
     anyway, which is the entire berserker problem in one term. */
  STRIKE_RANGE: 0.30,       // metres of GAP (surface to surface, not centres)
  /* How much further an all-out prompt will commit. Small on purpose: it was
     0.14 and that is a penalty with no upside attached - throwing from
     further out is simply a worse shot, so it read as "aggression means lose"
     rather than as a risk with a reward. Worth 2 points of spread. */
  STRIKE_RANGE_AGGR: 0.04,

  /* Damage per (m/s) of closing speed, ^1.15. A clean smash is ~20, so the
     health bar alone takes five or six of them - slow enough that the desk
     decides most rounds, fast enough that TIME UP still has a winner. */
  DMG: 11,
  FALL_FRAMES: 74           // how long the tumble off the edge plays
}
