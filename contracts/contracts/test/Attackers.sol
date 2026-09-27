// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArena {
    function placeBet(uint256 matchId, uint8 side) external payable;
    function claim(uint256 matchId) external;
}

/** @notice A winner whose address refuses money. Proves settlement does not
 *          depend on any recipient's fallback succeeding. */
contract RejectingBettor {
    IArena public immutable arena;

    constructor(address _arena) { arena = IArena(_arena); }

    function bet(uint256 matchId, uint8 side) external payable {
        arena.placeBet{value: msg.value}(matchId, side);
    }

    function claim(uint256 matchId) external {
        arena.claim(matchId);
    }

    receive() external payable {
        revert("nope");
    }
}

/** @notice Tries to re-enter claim() from inside the payout transfer. */
contract ReentrantBettor {
    IArena public immutable arena;
    uint256 private _matchId;
    bool private _reentered;

    constructor(address _arena) { arena = IArena(_arena); }

    function bet(uint256 matchId, uint8 side) external payable {
        arena.placeBet{value: msg.value}(matchId, side);
    }

    function claim(uint256 matchId) external {
        _matchId = matchId;
        arena.claim(matchId);
    }

    receive() external payable {
        if (!_reentered) {
            _reentered = true;
            arena.claim(_matchId);   // must revert on the guard
        }
    }
}
