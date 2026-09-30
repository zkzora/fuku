// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Ownable
/// @notice Minimal single-owner access control. Deliberately tiny so the
///         project carries no external Solidity dependencies.
abstract contract Ownable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner(address caller);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Hand ownership to `newOwner`. The zero address is rejected so ownership
    ///         cannot be burned by accident.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
