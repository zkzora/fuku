// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./Ownable.sol";
import {IAgentRegistry} from "./IAgentRegistry.sol";

/// @title ReputationRegistry
/// @notice Latest 0-100 trust score per agent, written by allow-listed scorer addresses.
///         Every update is emitted so the full history can be reconstructed from events.
contract ReputationRegistry is Ownable {
    struct Score {
        uint16 score;
        uint64 updatedAt;
        bool exists;
    }

    uint16 public constant MAX_SCORE = 100;

    IAgentRegistry public immutable agentRegistry;

    /// @notice scorer address => allowed to update scores.
    mapping(address => bool) public scorers;

    mapping(bytes32 => Score) private _scores;

    event ScorerSet(address indexed scorer, bool enabled);
    event ScoreUpdated(
        bytes32 indexed agentId,
        uint16 newScore,
        int16 delta,
        bytes32 reasonHash,
        string reason,
        uint64 timestamp
    );

    error NotScorer(address caller);
    error AgentNotFound(bytes32 agentId);
    error ScoreOutOfBounds(uint16 score);

    modifier onlyScorer() {
        if (!scorers[msg.sender]) revert NotScorer(msg.sender);
        _;
    }

    constructor(address agentRegistry_) {
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        agentRegistry = IAgentRegistry(agentRegistry_);
    }

    /// @notice Contract-owner only: add or remove a scorer.
    function setScorer(address scorer, bool enabled) external onlyOwner {
        if (scorer == address(0)) revert ZeroAddress();
        scorers[scorer] = enabled;
        emit ScorerSet(scorer, enabled);
    }

    /// @notice Scorer only: store `newScore` (0-100) for `agentId` and emit the change.
    function updateScore(bytes32 agentId, uint16 newScore, int16 delta, bytes32 reasonHash, string calldata reason)
        external
        onlyScorer
    {
        if (newScore > MAX_SCORE) revert ScoreOutOfBounds(newScore);
        if (!agentRegistry.exists(agentId)) revert AgentNotFound(agentId);

        uint64 nowTs = uint64(block.timestamp);
        _scores[agentId] = Score({score: newScore, updatedAt: nowTs, exists: true});

        emit ScoreUpdated(agentId, newScore, delta, reasonHash, reason, nowTs);
    }

    /// @notice Latest score for `agentId`. `exists` is false until the first update.
    function getScore(bytes32 agentId) external view returns (uint16 score, uint64 updatedAt, bool exists) {
        Score storage s = _scores[agentId];
        return (s.score, s.updatedAt, s.exists);
    }
}
