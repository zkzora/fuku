// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./Ownable.sol";

/// @title HumanIdentityRegistry
/// @notice Anchors a human identity (keyed by an opaque `identityId`) to a controller
///         address, a passkey public-key hash and an off-chain proof hash. The contract
///         owner acts as the verifier role and can flag identities as human-verified.
contract HumanIdentityRegistry is Ownable {
    struct Identity {
        address controller;
        bytes32 passkeyPubKeyHash;
        bytes32 proofHash;
        uint64 registeredAt;
        bool humanVerified;
    }

    /// @notice identityId => identity record. `controller == address(0)` means unregistered.
    mapping(bytes32 => Identity) public identities;

    event IdentityRegistered(bytes32 indexed identityId, address indexed controller, bytes32 proofHash);
    event HumanVerified(bytes32 indexed identityId, bool verified);

    error AlreadyRegistered(bytes32 identityId);
    error NotRegistered(bytes32 identityId);

    /// @notice Register `identityId` with `msg.sender` as its controller.
    /// @dev Reverts if the identity already exists. Verification starts as `false`.
    function registerIdentity(bytes32 identityId, bytes32 passkeyPubKeyHash, bytes32 proofHash) external {
        if (identities[identityId].controller != address(0)) revert AlreadyRegistered(identityId);

        identities[identityId] = Identity({
            controller: msg.sender,
            passkeyPubKeyHash: passkeyPubKeyHash,
            proofHash: proofHash,
            registeredAt: uint64(block.timestamp),
            humanVerified: false
        });

        emit IdentityRegistered(identityId, msg.sender, proofHash);
    }

    /// @notice Verifier-only: mark `identityId` as (not) human-verified.
    function setHumanVerified(bytes32 identityId, bool verified) external onlyOwner {
        if (identities[identityId].controller == address(0)) revert NotRegistered(identityId);
        identities[identityId].humanVerified = verified;
        emit HumanVerified(identityId, verified);
    }

    /// @notice True when the identity exists and has been human-verified.
    function isHuman(bytes32 identityId) external view returns (bool) {
        return identities[identityId].humanVerified;
    }

    /// @notice Controller address of `identityId`, or address(0) when unregistered.
    function controllerOf(bytes32 identityId) external view returns (address) {
        return identities[identityId].controller;
    }
}
