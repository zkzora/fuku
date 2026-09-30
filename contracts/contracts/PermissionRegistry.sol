// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./Ownable.sol";
import {IAgentRegistry} from "./IAgentRegistry.sol";

/// @title PermissionRegistry (the Agent Permission Passport)
/// @notice Stores the current policy commitment for each agent and an append-only
///         event log of allow / deny decisions taken against that policy.
///         Policies are managed by the agent owner controller; decisions can be
///         recorded by the owner controller or by allow-listed enforcer addresses.
contract PermissionRegistry is Ownable {
    struct Policy {
        bytes32 policyHash;
        uint32 version;
        string policyURI;
        bool active;
        uint64 updatedAt;
    }

    struct Stats {
        uint64 allowedCount;
        uint64 violationCount;
    }

    IAgentRegistry public immutable agentRegistry;

    /// @notice agentId => current policy.
    mapping(bytes32 => Policy) public policies;
    /// @notice enforcer address => allowed to record decisions for any agent.
    mapping(address => bool) public enforcers;

    mapping(bytes32 => Stats) private _stats;

    event PolicySet(bytes32 indexed agentId, bytes32 policyHash, uint32 version, string policyURI);
    event PolicyRevoked(bytes32 indexed agentId);
    event ActionDecision(
        bytes32 indexed agentId,
        bytes32 indexed actionHash,
        bool allowed,
        bytes32 proofHash,
        string ruleId,
        uint64 timestamp
    );
    event EnforcerSet(address indexed enforcer, bool enabled);

    error AgentNotFound(bytes32 agentId);
    error NotAgentOwner(bytes32 agentId, address caller);
    error NotAuthorized(bytes32 agentId, address caller);
    error NoActivePolicy(bytes32 agentId);

    modifier onlyAgentOwner(bytes32 agentId) {
        if (!agentRegistry.exists(agentId)) revert AgentNotFound(agentId);
        if (!agentRegistry.isOwnerController(agentId, msg.sender)) revert NotAgentOwner(agentId, msg.sender);
        _;
    }

    constructor(address agentRegistry_) {
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        agentRegistry = IAgentRegistry(agentRegistry_);
    }

    /// @notice Contract-owner only: add or remove an enforcer.
    function setEnforcer(address enforcer, bool enabled) external onlyOwner {
        if (enforcer == address(0)) revert ZeroAddress();
        enforcers[enforcer] = enabled;
        emit EnforcerSet(enforcer, enabled);
    }

    /// @notice Set (or replace) the policy for `agentId`. Only the agent owner controller.
    function setPolicy(bytes32 agentId, bytes32 policyHash, uint32 version, string calldata policyURI)
        external
        onlyAgentOwner(agentId)
    {
        policies[agentId] = Policy({
            policyHash: policyHash,
            version: version,
            policyURI: policyURI,
            active: true,
            updatedAt: uint64(block.timestamp)
        });
        emit PolicySet(agentId, policyHash, version, policyURI);
    }

    /// @notice Deactivate the policy for `agentId`. Only the agent owner controller.
    function revokePolicy(bytes32 agentId) external onlyAgentOwner(agentId) {
        Policy storage policy = policies[agentId];
        if (!policy.active) revert NoActivePolicy(agentId);
        policy.active = false;
        policy.updatedAt = uint64(block.timestamp);
        emit PolicyRevoked(agentId);
    }

    /// @notice Record an allow / deny decision for an action attempted by `agentId`.
    /// @dev Callable by the agent owner controller or any allow-listed enforcer.
    function recordDecision(
        bytes32 agentId,
        bytes32 actionHash,
        bool allowed,
        bytes32 proofHash,
        string calldata ruleId
    ) external {
        if (!agentRegistry.exists(agentId)) revert AgentNotFound(agentId);
        if (!enforcers[msg.sender] && !agentRegistry.isOwnerController(agentId, msg.sender)) {
            revert NotAuthorized(agentId, msg.sender);
        }

        Stats storage s = _stats[agentId];
        if (allowed) {
            s.allowedCount += 1;
        } else {
            s.violationCount += 1;
        }

        emit ActionDecision(agentId, actionHash, allowed, proofHash, ruleId, uint64(block.timestamp));
    }

    /// @notice Running allow / violation counters for `agentId`.
    function stats(bytes32 agentId) external view returns (uint64 allowedCount, uint64 violationCount) {
        Stats storage s = _stats[agentId];
        return (s.allowedCount, s.violationCount);
    }

    /// @notice True when `agentId` currently has an active policy.
    function hasActivePolicy(bytes32 agentId) external view returns (bool) {
        return policies[agentId].active;
    }
}
