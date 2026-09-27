// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentTypes
 * @notice The immutable Agent Snapshot, and the one function that reduces it
 *         to a hash.
 *
 * WHY THE WHOLE SNAPSHOT LIVES ON CHAIN
 *
 * A spectator is not betting on a wallet address. They are betting on a
 * specific configuration of a specific agent: this prompt, run by this model,
 * at this model version, with this JEV config, against these simulation
 * rules. Change any one of those and it is a different fighter wearing the
 * same name.
 *
 * The strategy is public before betting opens, so there is nothing secret
 * left to protect by keeping it off chain - and a strategy displayed from a
 * relay is a strategy the relay could misreport. Putting it in contract
 * storage makes the chain the single source of truth for what the crowd is
 * betting on, which is the only version of this that survives someone
 * arguing about it afterwards.
 *
 * `hash()` is what the settlement signature binds to. Every field that can
 * materially change how the agent behaves is inside it, so a settlement can
 * be checked against the exact agent the bets were placed on.
 */
library AgentTypes {
    /* Bounds. These are enforced at submit time, not assumed, because
       storage here is paid for by whoever locks the match and an unbounded
       prompt is an unbounded bill. */
    uint256 internal constant MAX_NAME = 32;
    uint256 internal constant MAX_PROMPT = 280;
    uint256 internal constant MAX_MODEL = 64;
    uint256 internal constant MAX_ARCHETYPE = 32;

    struct AgentSnapshot {
        address owner;          // who configured this agent
        string name;            // display name
        string prompt;          // the strategy, PUBLIC before betting opens
        string model;           // e.g. "jev-gemini-3.6-flash"
        string modelVersion;    // provider-reported version string
        string archetype;       // derived archetype, part of combat identity
        bytes32 jevConfigHash;  // advisor cadence/temperature/action-set config
        uint8 aggression;       // 0..100
        uint8 defense;          // 0..100
        uint8 speed;            // 0..100
        uint32 simVersion;      // rules version of the deterministic engine
    }

    /**
     * @notice Reduce a snapshot to the 32 bytes that identify it.
     * @dev abi.encode, never abi.encodePacked: five of these fields are
     *      dynamic strings, and packed encoding of adjacent dynamic values
     *      lets ("ab","c") and ("a","bc") collide into the same preimage.
     *      Each string is pre-hashed so the outer encode sees fixed words.
     */
    function hash(AgentSnapshot memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                a.owner,
                keccak256(bytes(a.name)),
                keccak256(bytes(a.prompt)),
                keccak256(bytes(a.model)),
                keccak256(bytes(a.modelVersion)),
                keccak256(bytes(a.archetype)),
                a.jevConfigHash,
                a.aggression,
                a.defense,
                a.speed,
                a.simVersion
            )
        );
    }

    /**
     * @notice Reject a snapshot that cannot be stored or displayed sanely.
     * @dev Stats are bounded because they feed the NFT's SVG bar widths and
     *      a value over 100 draws a bar outside the card.
     */
    function validate(AgentSnapshot memory a) internal pure {
        require(a.owner != address(0), "Agent: zero owner");
        require(bytes(a.name).length > 0 && bytes(a.name).length <= MAX_NAME, "Agent: bad name");
        require(bytes(a.prompt).length > 0 && bytes(a.prompt).length <= MAX_PROMPT, "Agent: bad prompt");
        require(bytes(a.model).length > 0 && bytes(a.model).length <= MAX_MODEL, "Agent: bad model");
        require(bytes(a.modelVersion).length <= MAX_MODEL, "Agent: bad model version");
        require(bytes(a.archetype).length > 0 && bytes(a.archetype).length <= MAX_ARCHETYPE, "Agent: bad archetype");
        require(a.aggression <= 100 && a.defense <= 100 && a.speed <= 100, "Agent: stats out of range");
        require(a.simVersion > 0, "Agent: bad sim version");
    }
}
