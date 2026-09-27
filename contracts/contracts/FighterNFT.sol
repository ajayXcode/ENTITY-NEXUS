// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title FighterNFT
 * @notice The on-chain victory receipt for one settled agent match.
 *
 * Fully self-contained: the image is an SVG generated in `generateSVG` and
 * the metadata is Base64 JSON built in `tokenURI`, so the token survives
 * without IPFS, a gateway, or this project's server existing at all.
 *
 * WHAT IS ON THE CARD, AND WHY
 *
 * A receipt that only said "this address won match #12" would be a receipt
 * for nothing in particular - the interesting claim is that a SPECIFIC agent
 * build beat another specific agent build under specific rules. So the token
 * carries the two snapshot hashes, the seed, the decision hash and the result
 * digest. Anyone holding the off-chain decision log can recompute those four
 * values and prove the log belongs to this fight; anyone who cannot is
 * looking at a log for a different one.
 *
 * The winner's prompt is stored in the clear because by settlement it has
 * been public since before betting opened - it is the thing the crowd bet on.
 * Nothing private is ever written here.
 */
contract FighterNFT is ERC721, Ownable {
    using Strings for uint256;
    using Strings for uint8;

    /** @dev Passed as a struct because the flat argument list overflowed the
     *       stack, and because the arena builds it in one place. */
    struct WinnerData {
        address to;
        uint256 matchId;
        string name;
        string prompt;
        string archetype;
        string model;
        uint8 aggression;
        uint8 defense;
        uint8 speed;
        uint8 finishType;     // 1 KO, 2 timeout (3 draw never mints)
        uint256 seed;
        address opponent;
        bytes32 snapshotHash;
        bytes32 opponentHash;
        bytes32 decisionHash;
        bytes32 resultDigest;
        uint32 simVersion;
    }

    struct FighterData {
        uint256 matchId;
        string name;
        string prompt;
        string archetype;
        string model;
        uint8 aggression;
        uint8 defense;
        uint8 speed;
        uint8 finishType;
        uint256 seed;
        address opponent;
        bytes32 snapshotHash;
        bytes32 opponentHash;
        bytes32 decisionHash;
        bytes32 resultDigest;
        uint32 simVersion;
        uint256 timestamp;
    }

    uint8 public constant FINISH_KO = 1;
    uint8 public constant FINISH_TIMEOUT = 2;

    uint256 private _nextTokenId;
    address public arenaContract;

    mapping(uint256 => FighterData) private _fighters;
    /** @dev One receipt per match, forever. The arena's state machine already
     *       prevents a second settlement, but a mint guard that does not
     *       depend on another contract behaving is worth its storage slot. */
    mapping(uint256 => uint256) public tokenOfMatch;

    event FighterMinted(uint256 indexed tokenId, address indexed winner, uint256 indexed matchId, bytes32 snapshotHash);
    event ArenaContractUpdated(address indexed newArena);

    modifier onlyArena() {
        require(msg.sender == arenaContract, "FighterNFT: not arena");
        _;
    }

    constructor(address initialOwner) ERC721("Monad AI Fighter", "MAIF") Ownable(initialOwner) {
        _nextTokenId = 1;
    }

    function setArenaContract(address _arena) external onlyOwner {
        require(_arena != address(0), "FighterNFT: zero address");
        arenaContract = _arena;
        emit ArenaContractUpdated(_arena);
    }

    /**
     * @notice Mint the victory receipt. Arena only, once per match.
     */
    function mintWinner(WinnerData calldata w) external onlyArena returns (uint256) {
        require(w.to != address(0), "FighterNFT: mint to zero address");
        require(tokenOfMatch[w.matchId] == 0, "FighterNFT: match already minted");
        require(w.finishType == FINISH_KO || w.finishType == FINISH_TIMEOUT, "FighterNFT: no NFT for a draw");

        uint256 tokenId = _nextTokenId++;
        _fighters[tokenId] = FighterData({
            matchId: w.matchId,
            name: w.name,
            prompt: w.prompt,
            archetype: w.archetype,
            model: w.model,
            aggression: w.aggression,
            defense: w.defense,
            speed: w.speed,
            finishType: w.finishType,
            seed: w.seed,
            opponent: w.opponent,
            snapshotHash: w.snapshotHash,
            opponentHash: w.opponentHash,
            decisionHash: w.decisionHash,
            resultDigest: w.resultDigest,
            simVersion: w.simVersion,
            timestamp: block.timestamp
        });
        tokenOfMatch[w.matchId] = tokenId;

        _safeMint(w.to, tokenId);
        emit FighterMinted(tokenId, w.to, w.matchId, w.snapshotHash);
        return tokenId;
    }

    function getFighter(uint256 tokenId) external view returns (FighterData memory) {
        _requireOwned(tokenId);
        return _fighters[tokenId];
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    /* ==================================================================
       On-chain art
    ================================================================== */

    function generateSVG(uint256 tokenId) public view returns (string memory) {
        _requireOwned(tokenId);
        FighterData memory f = _fighters[tokenId];

        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 560" width="100%" height="100%">',
                _svgDefs(),
                '<rect width="400" height="560" rx="20" fill="url(#bg)" stroke="#836ef9" stroke-width="3"/>',
                '<rect x="20" y="20" width="360" height="520" rx="14" fill="none" stroke="#2a2e45" stroke-width="1"/>',
                '<text x="200" y="52" font-family="monospace" font-size="11" fill="#836ef9" font-weight="bold" text-anchor="middle" letter-spacing="2">AARAGE VICTORY  MATCH #',
                f.matchId.toString(),
                '</text>',
                '<text x="200" y="88" font-family="monospace" font-size="22" fill="url(#gold)" font-weight="900" text-anchor="middle">',
                _esc(_truncate(f.name, 18)),
                '</text>',
                '<text x="200" y="110" font-family="monospace" font-size="12" fill="#8e96b8" text-anchor="middle" letter-spacing="1">',
                _esc(_truncate(f.archetype, 24)),
                '  /  ',
                f.finishType == FINISH_KO ? 'K.O.' : 'DECISION',
                '</text>',
                '<rect x="40" y="126" width="320" height="1" fill="#2a2e45"/>',
                _svgStats(f),
                _svgPrompt(f),
                _svgFooter(f),
                '</svg>'
            )
        );
    }

    function _svgDefs() private pure returns (string memory) {
        return string(
            abi.encodePacked(
                '<defs>',
                '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">',
                '<stop offset="0%" stop-color="#080b18"/><stop offset="100%" stop-color="#141829"/>',
                '</linearGradient>',
                '<linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">',
                '<stop offset="0%" stop-color="#ffd24a"/><stop offset="100%" stop-color="#ff9d00"/>',
                '</linearGradient>',
                '</defs>'
            )
        );
    }

    function _svgStats(FighterData memory f) private pure returns (string memory) {
        return string(
            abi.encodePacked(
                '<g transform="translate(50, 146)">',
                _bar('ATK', '#ff3b6b', f.aggression, 0),
                _bar('DEF', '#00c8ff', f.defense, 32),
                _bar('SPD', '#ffd24a', f.speed, 64),
                '</g>'
            )
        );
    }

    /** @dev 180px is the full-width track; stats are capped at 100 on submit,
     *       so the fill can never overrun it. */
    function _bar(string memory label, string memory colour, uint8 value, uint256 dy)
        private
        pure
        returns (string memory)
    {
        uint256 width = (uint256(value) * 180) / 100;
        return string(
            abi.encodePacked(
                '<text x="0" y="', (dy + 18).toString(), '" font-family="monospace" font-size="12" fill="', colour, '" font-weight="bold">', label, '</text>',
                '<rect x="40" y="', (dy + 5).toString(), '" width="180" height="16" rx="4" fill="#1e2235"/>',
                '<rect x="40" y="', (dy + 5).toString(), '" width="', width.toString(), '" height="16" rx="4" fill="', colour, '"/>',
                '<text x="235" y="', (dy + 18).toString(), '" font-family="monospace" font-size="12" fill="#fff">', uint256(value).toString(), '</text>'
            )
        );
    }

    function _svgPrompt(FighterData memory f) private pure returns (string memory) {
        return string(
            abi.encodePacked(
                '<rect x="40" y="258" width="320" height="120" rx="8" fill="#0e1222" stroke="#252a42"/>',
                '<text x="55" y="282" font-family="monospace" font-size="10" fill="#6d7599" font-weight="bold">PUBLIC STRATEGY</text>',
                '<text x="55" y="304" font-family="monospace" font-size="10" fill="#d1d6ed">',
                '<tspan x="55" dy="0">', _esc(_truncate(f.prompt, 42)), '</tspan>',
                '<tspan x="55" dy="14">', _esc(_slice(f.prompt, 42, 42)), '</tspan>',
                '<tspan x="55" dy="14">', _esc(_slice(f.prompt, 84, 42)), '</tspan>',
                '</text>',
                '<text x="55" y="366" font-family="monospace" font-size="9" fill="#586080">MODEL ', _esc(_truncate(f.model, 34)), '</text>'
            )
        );
    }

    /** @dev The four hashes are the auditable part of the receipt; short
     *       prefixes are enough to eyeball, and `getFighter` returns them in
     *       full for anything that actually verifies. */
    function _svgFooter(FighterData memory f) private pure returns (string memory) {
        return string(
            abi.encodePacked(
                '<text x="50" y="404" font-family="monospace" font-size="9" fill="#8e96b8">AGENT    ', _hex8(f.snapshotHash), '</text>',
                '<text x="50" y="420" font-family="monospace" font-size="9" fill="#8e96b8">DEFEATED ', _hex8(f.opponentHash), '</text>',
                '<text x="50" y="436" font-family="monospace" font-size="9" fill="#8e96b8">DECISION ', _hex8(f.decisionHash), '</text>',
                '<text x="50" y="452" font-family="monospace" font-size="9" fill="#8e96b8">RESULT   ', _hex8(f.resultDigest), '</text>',
                '<text x="50" y="472" font-family="monospace" font-size="9" fill="#586080">SEED ', _hex8(bytes32(f.seed)), '  SIM v', uint256(f.simVersion).toString(), '</text>',
                '<text x="50" y="500" font-family="monospace" font-size="10" fill="#836ef9" font-weight="bold">SETTLED ON MONAD</text>'
            )
        );
    }

    /* ==================================================================
       Metadata
    ================================================================== */

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        FighterData memory f = _fighters[tokenId];

        string memory image = string(
            abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes(generateSVG(tokenId))))
        );

        bytes memory json = abi.encodePacked(
            '{"name":"AARAGE Victory #', tokenId.toString(), ' - ', _esc(f.name),
            '","description":"On-chain victory receipt for autonomous agent match #', f.matchId.toString(),
            ' on Monad. Winning public strategy: ', _esc(f.prompt),
            '","image":"', image,
            '","attributes":[',
            '{"trait_type":"Archetype","value":"', _esc(f.archetype), '"},',
            '{"trait_type":"Model","value":"', _esc(f.model), '"},',
            '{"trait_type":"Finish","value":"', f.finishType == FINISH_KO ? 'K.O.' : 'Decision', '"},',
            '{"trait_type":"Aggression","value":', uint256(f.aggression).toString(), '},',
            '{"trait_type":"Defense","value":', uint256(f.defense).toString(), '},',
            '{"trait_type":"Speed","value":', uint256(f.speed).toString(), '},',
            '{"trait_type":"Match ID","value":', f.matchId.toString(), '},',
            '{"trait_type":"Sim Version","value":', uint256(f.simVersion).toString(), '},',
            _hashAttributes(f),
            ']}'
        );

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    function _hashAttributes(FighterData memory f) private pure returns (string memory) {
        return string(
            abi.encodePacked(
                '{"trait_type":"Agent Snapshot","value":"', Strings.toHexString(uint256(f.snapshotHash), 32), '"},',
                '{"trait_type":"Opponent Snapshot","value":"', Strings.toHexString(uint256(f.opponentHash), 32), '"},',
                '{"trait_type":"Decision Hash","value":"', Strings.toHexString(uint256(f.decisionHash), 32), '"},',
                '{"trait_type":"Result Digest","value":"', Strings.toHexString(uint256(f.resultDigest), 32), '"},',
                '{"trait_type":"Seed","value":"', Strings.toHexString(f.seed, 32), '"}'
            )
        );
    }

    /* ==================================================================
       String helpers

       Everything here writes into an SVG that is then embedded in a JSON
       string, so a raw quote or backslash from a user-supplied prompt would
       break the document. `_esc` is not cosmetic - it is what stops a prompt
       from corrupting its own token's metadata.
    ================================================================== */

    function _truncate(string memory str, uint256 maxLen) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        if (b.length <= maxLen) return str;
        bytes memory res = new bytes(maxLen);
        for (uint256 i = 0; i < maxLen; i++) res[i] = b[i];
        return string(res);
    }

    /** @dev Byte slice for wrapping the prompt across tspans. Returns empty
     *       past the end rather than reverting, so a short prompt just leaves
     *       the later lines blank. */
    function _slice(string memory str, uint256 start, uint256 len) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        if (start >= b.length) return "";
        uint256 end = start + len;
        if (end > b.length) end = b.length;
        bytes memory res = new bytes(end - start);
        for (uint256 i = start; i < end; i++) res[i - start] = b[i];
        return string(res);
    }

    /** @dev Escapes for both layers at once: `"` and `\` would break the JSON
     *       string, `<`, `>` and `&` would break the SVG. */
    function _esc(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        uint256 extra = 0;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == '\\') extra += 1;
            else if (c == '<' || c == '>') extra += 3;   // &lt; &gt;
            else if (c == '&') extra += 4;               // &amp;
        }
        if (extra == 0) return str;

        bytes memory res = new bytes(b.length + extra);
        uint256 j = 0;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == '\\') {
                res[j++] = '\\';
                res[j++] = c;
            } else if (c == '<') {
                res[j++] = '&'; res[j++] = 'l'; res[j++] = 't'; res[j++] = ';';
            } else if (c == '>') {
                res[j++] = '&'; res[j++] = 'g'; res[j++] = 't'; res[j++] = ';';
            } else if (c == '&') {
                res[j++] = '&'; res[j++] = 'a'; res[j++] = 'm'; res[j++] = 'p'; res[j++] = ';';
            } else {
                res[j++] = c;
            }
        }
        return string(res);
    }

    /** @dev First 4 bytes of a hash as `0xabcdef12`, for the card. */
    function _hex8(bytes32 h) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory res = new bytes(10);
        res[0] = '0';
        res[1] = 'x';
        for (uint256 i = 0; i < 4; i++) {
            res[2 + i * 2] = hexChars[uint8(h[i]) >> 4];
            res[3 + i * 2] = hexChars[uint8(h[i]) & 0x0f];
        }
        return string(res);
    }
}
