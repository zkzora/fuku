// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Narrow view of AgentRegistry shared by the permission and reputation registries.
interface IAgentRegistry {
    function isOwnerController(bytes32 agentId, address who) external view returns (bool);
    function exists(bytes32 agentId) external view returns (bool);
}
