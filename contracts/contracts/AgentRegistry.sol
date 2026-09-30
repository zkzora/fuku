// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Narrow view of HumanIdentityRegistry used by AgentRegistry.
interface IHumanIdentityRegistry {
    function identities(bytes32 identityId)
        external
        view
        returns (address controller, bytes32 passkeyPubKeyHash, bytes32 proofHash, uint64 registeredAt, bool humanVerified);
}

/// @title AgentRegistry
/// @notice ERC-8004-inspired registry of AI agents. Every agent is owned by a human
///         identity from HumanIdentityRegistry; only that identity controller address
///         may register or change the agent.
contract AgentRegistry {
    enum AgentStatus {
        Registered, // 0
        Active, // 1
        Paused, // 2
        Revoked // 3
    }

    struct Agent {
        bytes32 ownerIdentityId;
        string name;
        string version;
        bytes32 capabilitiesHash;
        string metadataURI;
        AgentStatus status;
        uint64 registeredAt;
    }

    IHumanIdentityRegistry public immutable identityRegistry;

    /// @notice agentId => agent record. `registeredAt == 0` means unregistered.
    mapping(bytes32 => Agent) public agents;

    event AgentRegistered(bytes32 indexed agentId, bytes32 indexed ownerIdentityId, string name, bytes32 capabilitiesHash);
    event AgentStatusChanged(bytes32 indexed agentId, uint8 status);

    error ZeroAddress();
    error AgentAlreadyExists(bytes32 agentId);
    error AgentNotFound(bytes32 agentId);
    error NotIdentityController(bytes32 identityId, address caller);
    error InvalidStatus(uint8 status);

    constructor(address identityRegistry_) {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        identityRegistry = IHumanIdentityRegistry(identityRegistry_);
    }

    /// @notice Register a new agent owned by `ownerIdentityId`.
    /// @dev Caller must be the controller of `ownerIdentityId`. Status starts as Registered.
    function registerAgent(
        bytes32 agentId,
        bytes32 ownerIdentityId,
        string calldata name,
        string calldata version,
        bytes32 capabilitiesHash,
        string calldata metadataURI
    ) external {
        if (agents[agentId].registeredAt != 0) revert AgentAlreadyExists(agentId);
        if (!_isController(ownerIdentityId, msg.sender)) revert NotIdentityController(ownerIdentityId, msg.sender);

        agents[agentId] = Agent({
            ownerIdentityId: ownerIdentityId,
            name: name,
            version: version,
            capabilitiesHash: capabilitiesHash,
            metadataURI: metadataURI,
            status: AgentStatus.Registered,
            registeredAt: uint64(block.timestamp)
        });

        emit AgentRegistered(agentId, ownerIdentityId, name, capabilitiesHash);
    }

    /// @notice Change the lifecycle status of an agent. Only the owner identity controller.
    function setStatus(bytes32 agentId, uint8 status) external {
        if (status > uint8(AgentStatus.Revoked)) revert InvalidStatus(status);
        Agent storage agent = agents[agentId];
        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (!_isController(agent.ownerIdentityId, msg.sender)) {
            revert NotIdentityController(agent.ownerIdentityId, msg.sender);
        }

        agent.status = AgentStatus(status);
        emit AgentStatusChanged(agentId, status);
    }

    /// @notice Identity that owns `agentId` (bytes32(0) when unregistered).
    function ownerOf(bytes32 agentId) external view returns (bytes32 identityId) {
        return agents[agentId].ownerIdentityId;
    }

    /// @notice True when `who` is the controller of the identity that owns `agentId`.
    function isOwnerController(bytes32 agentId, address who) external view returns (bool) {
        Agent storage agent = agents[agentId];
        if (agent.registeredAt == 0) return false;
        return _isController(agent.ownerIdentityId, who);
    }

    /// @notice True when `agentId` has been registered.
    function exists(bytes32 agentId) external view returns (bool) {
        return agents[agentId].registeredAt != 0;
    }

    function _isController(bytes32 identityId, address who) internal view returns (bool) {
        (address controller,,,,) = identityRegistry.identities(identityId);
        return controller != address(0) && controller == who;
    }
}
