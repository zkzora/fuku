// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "../Ownable.sol";
import {CleanverseAPassSim} from "./CleanverseAPassSim.sol";

/// @title CleanverseATokenSim
/// @notice Local / testnet simulator of a Cleanverse aToken (compliant aUSDC). A minimal
///         ERC-20 whose every transfer requires both the sender and the recipient to hold an
///         eligible A-Pass under `rule`. The spender in `transferFrom` is not checked, so a
///         contract such as FukuSpendGuard can move funds between two eligible wallets.
///         `setPaused` mirrors Cleanverse `atoken/set_paused`.
/// @dev This is NOT the Cleanverse contract. No permit, no hooks, 6 decimals like USDC.
contract CleanverseATokenSim is Ownable {
    string public constant name = "Cleanverse aUSDC (Fuku simulator)";
    string public constant symbol = "aUSDC-SIM";
    uint8 public constant decimals = 6;

    uint8 private constant CODE_ELIGIBLE = 4;

    /// @notice A-Pass registry consulted on every transfer and mint.
    CleanverseAPassSim public immutable apass;
    /// @notice Eligibility rule both parties of a transfer must satisfy.
    CleanverseAPassSim.Rule public rule;
    /// @notice When true, transfer / transferFrom / mint revert with `TokenPaused`.
    bool public paused;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event RuleSet(bytes32 group, bytes32 subGroup, uint8 minTier, uint8 minSubTier);
    event PausedSet(bool isPaused);

    /// @notice `who` failed `apass.verify(who, rule)` with result `code` (see CleanverseAPassSim).
    error ComplianceRejected(address who, uint8 code);
    error TokenPaused();
    error InsufficientBalance(address from, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    modifier whenNotPaused() {
        if (paused) revert TokenPaused();
        _;
    }

    constructor(address apass_, CleanverseAPassSim.Rule memory rule_) {
        if (apass_ == address(0)) revert ZeroAddress();
        apass = CleanverseAPassSim(apass_);
        _setRule(rule_);
    }

    // --- admin ---------------------------------------------------------------------------

    /// @notice Contract-owner only: replace the eligibility rule.
    function setRule(CleanverseAPassSim.Rule calldata rule_) external onlyOwner {
        _setRule(rule_);
    }

    /// @notice Contract-owner only: pause or unpause transfers and minting.
    function setPaused(bool isPaused) external onlyOwner {
        paused = isPaused;
        emit PausedSet(isPaused);
    }

    /// @notice Contract-owner only: mint `amount` to `to`, which must hold an eligible A-Pass.
    function mint(address to, uint256 amount) external onlyOwner whenNotPaused {
        _requireEligible(to);
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    // --- ERC-20 --------------------------------------------------------------------------

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external whenNotPaused returns (bool) {
        _requireEligible(msg.sender);
        _requireEligible(to);
        _move(msg.sender, to, value);
        return true;
    }

    /// @dev Only `from` and `to` are compliance-checked; the spender (msg.sender) is not.
    ///      An allowance of type(uint256).max is treated as infinite and never decremented.
    function transferFrom(address from, address to, uint256 value) external whenNotPaused returns (bool) {
        _requireEligible(from);
        _requireEligible(to);

        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(msg.sender, allowed, value);
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }

        _move(from, to, value);
        return true;
    }

    // --- internals -----------------------------------------------------------------------

    function _move(address from, address to, uint256 value) internal {
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance(from, balance, value);
        unchecked {
            balanceOf[from] = balance - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _requireEligible(address who) internal view {
        uint8 code = apass.verify(who, rule);
        if (code != CODE_ELIGIBLE) revert ComplianceRejected(who, code);
    }

    function _setRule(CleanverseAPassSim.Rule memory rule_) internal {
        rule = rule_;
        emit RuleSet(rule_.group, rule_.subGroup, rule_.minTier, rule_.minSubTier);
    }
}
