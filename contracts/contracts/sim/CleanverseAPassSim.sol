// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "../Ownable.sol";

/// @title CleanverseAPassSim
/// @notice Local / testnet simulator of the Cleanverse A-Pass (CVI): a compliance credential
///         bound to one wallet. There is deliberately no transfer function of any kind, so a
///         pass can never move to another wallet; issuers can only (re)issue it or change its
///         status. `verify` mirrors the result codes of Cleanverse `verify_apass`.
/// @dev This is NOT the Cleanverse contract. It exists so the Fuku demo can run the full
///      A-Pass -> aToken -> FukuSpendGuard flow on a chain where Cleanverse is not deployed.
contract CleanverseAPassSim is Ownable {
    /// @notice A wallet's A-Pass. `status`: 0 none, 1 active, 2 frozen. `expiresAt == 0`
    ///         means the pass never expires. `cvRecordId` is the opaque Cleanverse record id.
    struct APass {
        uint8 status;
        uint8 tier;
        uint8 subTier;
        bytes32 group;
        bytes32 subGroup;
        uint64 expiresAt;
        bytes32 cvRecordId;
    }

    /// @notice Eligibility rule checked by `verify`. A zero field means "any".
    struct Rule {
        bytes32 group;
        bytes32 subGroup;
        uint8 minTier;
        uint8 minSubTier;
    }

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_ACTIVE = 1;
    uint8 public constant STATUS_FROZEN = 2;

    /// @notice `verify` result codes (same meaning as Cleanverse `verify_apass`).
    uint8 public constant CODE_RULE_REJECTED = 1;
    uint8 public constant CODE_NO_APASS = 2;
    uint8 public constant CODE_FROZEN_OR_EXPIRED = 3;
    uint8 public constant CODE_ELIGIBLE = 4;

    /// @notice issuer address => allowed to issue passes and change their status.
    mapping(address => bool) public issuers;

    mapping(address => APass) private _passes;

    event IssuerSet(address indexed issuer, bool enabled);
    event APassIssued(
        address indexed wallet,
        address indexed issuer,
        uint8 status,
        uint8 tier,
        uint8 subTier,
        bytes32 group,
        bytes32 subGroup,
        uint64 expiresAt,
        bytes32 cvRecordId
    );
    event APassStatusChanged(address indexed wallet, address indexed issuer, uint8 previousStatus, uint8 status);

    error NotIssuer(address caller);
    error InvalidStatus(uint8 status);
    error NoAPass(address wallet);

    modifier onlyIssuer() {
        if (!issuers[msg.sender]) revert NotIssuer(msg.sender);
        _;
    }

    /// @dev The deployer (initial owner) starts out as an issuer; it can remove itself.
    constructor() {
        issuers[msg.sender] = true;
        emit IssuerSet(msg.sender, true);
    }

    /// @notice Contract-owner only: add or remove an issuer.
    function setIssuer(address issuer, bool enabled) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        issuers[issuer] = enabled;
        emit IssuerSet(issuer, enabled);
    }

    /// @notice Issuer only: issue (or fully replace) the A-Pass bound to `wallet`.
    /// @dev `pass.status` must be active (1) or frozen (2); use `setStatus(wallet, 0)` to revoke.
    function issue(address wallet, APass calldata pass) external onlyIssuer {
        if (wallet == address(0)) revert ZeroAddress();
        if (pass.status != STATUS_ACTIVE && pass.status != STATUS_FROZEN) revert InvalidStatus(pass.status);

        _passes[wallet] = pass;

        emit APassIssued(
            wallet,
            msg.sender,
            pass.status,
            pass.tier,
            pass.subTier,
            pass.group,
            pass.subGroup,
            pass.expiresAt,
            pass.cvRecordId
        );
    }

    /// @notice Issuer only: change the status of an existing A-Pass (0 revokes, 1 active, 2 frozen).
    function setStatus(address wallet, uint8 status) external onlyIssuer {
        if (status > STATUS_FROZEN) revert InvalidStatus(status);
        APass storage pass = _passes[wallet];
        uint8 previous = pass.status;
        if (previous == STATUS_NONE) revert NoAPass(wallet);

        pass.status = status;
        emit APassStatusChanged(wallet, msg.sender, previous, status);
    }

    /// @notice The A-Pass bound to `wallet` (all zero when none was ever issued).
    function passOf(address wallet) external view returns (APass memory) {
        return _passes[wallet];
    }

    /// @notice Check `wallet` against `rule`, mirroring Cleanverse `verify_apass`.
    /// @dev Evaluated in order: no pass -> frozen / expired -> rule.
    /// @return code 4 eligible; 2 no A-Pass; 3 frozen or expired; 1 rejected by the rule
    ///         (tier below `minTier`, same tier but sub-tier below `minSubTier`, or a
    ///         non-zero `group` / `subGroup` that does not match).
    function verify(address wallet, Rule calldata rule) external view returns (uint8 code) {
        APass storage pass = _passes[wallet];

        if (pass.status == STATUS_NONE) return CODE_NO_APASS;
        if (pass.status == STATUS_FROZEN) return CODE_FROZEN_OR_EXPIRED;
        if (pass.expiresAt != 0 && pass.expiresAt <= block.timestamp) return CODE_FROZEN_OR_EXPIRED;

        if (pass.tier < rule.minTier) return CODE_RULE_REJECTED;
        if (pass.tier == rule.minTier && pass.subTier < rule.minSubTier) return CODE_RULE_REJECTED;
        if (rule.group != bytes32(0) && pass.group != rule.group) return CODE_RULE_REJECTED;
        if (rule.subGroup != bytes32(0) && pass.subGroup != rule.subGroup) return CODE_RULE_REJECTED;

        return CODE_ELIGIBLE;
    }
}
