// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./Ownable.sol";

/// @dev Narrow view of AgentRegistry used by FukuSpendGuard. `status` is the AgentStatus
///      enum ABI-encoded as uint8 (0 Registered, 1 Active, 2 Paused, 3 Revoked).
interface ISpendGuardAgentRegistry {
    function agents(bytes32 agentId)
        external
        view
        returns (
            bytes32 ownerIdentityId,
            string memory name,
            string memory version,
            bytes32 capabilitiesHash,
            string memory metadataURI,
            uint8 status,
            uint64 registeredAt
        );

    function exists(bytes32 agentId) external view returns (bool);
}

/// @dev Narrow view of PermissionRegistry used by FukuSpendGuard (which must be an enforcer).
interface ISpendGuardPermissionRegistry {
    function policies(bytes32 agentId)
        external
        view
        returns (bytes32 policyHash, uint32 version, string memory policyURI, bool active, uint64 updatedAt);

    function recordDecision(bytes32 agentId, bytes32 actionHash, bool allowed, bytes32 proofHash, string calldata ruleId)
        external;
}

/// @title FukuSpendGuard
/// @notice Moves a funding wallet's tokens for an AI agent only inside limits the wallet set
///         on-chain itself, and only with a single-use attestation from the Fuku compliance
///         signer for exactly that transfer.
///
///         Trust model. The compliance signer (the Fuku server key) decides off-chain whether
///         an action is allowed, but it can only move funds inside what the owner's own wallet
///         authorised on-chain: the mandate the wallet opened for the agent (token, UTC-day
///         cap, per-transaction limit, expiry and, when `restrictPayees` is set, the payee
///         list kept with `setPayee`) and the ERC-20 allowance the wallet gave this contract.
///         It can also only do so for a live agent (registered in AgentRegistry and neither
///         Paused nor Revoked) whose current on-chain policy in PermissionRegistry is active
///         and equal to the attested policy hash. A leaked or misbehaving signer key is
///         therefore bounded by the open mandates and allowances; the owner cuts it off by
///         closing the mandate, pausing or revoking the agent, revoking its policy or
///         withdrawing the allowance, and the contract owner can rotate the signer.
///
///         Single use. Each attestation consumes its `nonce` (global to this guard) and its
///         `actionHash` (one Fuku action => at most one transfer, even with a fresh nonce). It
///         names the `mandateVersion` it was issued under, a per-(agent, wallet) counter that
///         increases on every `openMandate` and `closeMandate`, so replacing, closing or
///         re-opening a mandate voids every attestation issued under earlier terms. The
///         EIP-712 domain binds it to this chain and this contract.
///
///         The token itself (for example a Cleanverse aToken) still applies its own compliance
///         checks; its revert data is bubbled up unchanged, and a reverted transfer consumes
///         no budget, nonce or action. Every executed transfer is logged as an allowed
///         decision (rule "R6") in PermissionRegistry.
/// @dev Anyone may relay `execute`; authority comes from the attestation, the mandate and
///      the token allowance, never from msg.sender.
contract FukuSpendGuard is Ownable {
    /// @notice A funding wallet's on-chain authorisation for one agent. Field order is the
    ///         order `mandates(agentId, wallet)` returns.
    struct Mandate {
        address token; // the only token the agent may move from this wallet
        uint256 dailyCap; // max total per UTC day, in token base units
        uint256 maxPerTx; // max per transfer; 0 = only the daily cap applies
        uint64 validUntil; // unix seconds; expired once block.timestamp > validUntil; 0 = never
        bool restrictPayees; // true: `to` must be on the wallet's payee list for this agent
        uint64 version; // current mandate version of (agent, wallet); bumped on open and close
        bool active; // open (true) or closed / never opened (false)
    }

    /// @notice EIP-712 message signed by the compliance signer. Field order is part of the
    ///         typehash; do not reorder.
    struct GuardedTransfer {
        bytes32 agentId;
        address from;
        address to;
        address token;
        uint256 amount;
        bytes32 policyHash;
        bytes32 actionHash;
        bytes32 proofHash;
        bytes32 complianceRef;
        uint64 mandateVersion;
        uint256 nonce;
        uint64 deadline;
    }

    bytes32 public constant GUARDED_TRANSFER_TYPEHASH = keccak256(
        "GuardedTransfer(bytes32 agentId,address from,address to,address token,uint256 amount,bytes32 policyHash,bytes32 actionHash,bytes32 proofHash,bytes32 complianceRef,uint64 mandateVersion,uint256 nonce,uint64 deadline)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("FukuSpendGuard");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @notice Rule id recorded in PermissionRegistry for every executed transfer.
    string public constant DECISION_RULE_ID = "R6";

    /// @dev secp256k1n / 2. Signatures with a larger `s` are malleable twins and rejected.
    uint256 private constant SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint8 private constant AGENT_STATUS_PAUSED = 2;

    ISpendGuardAgentRegistry public immutable agentRegistry;
    ISpendGuardPermissionRegistry public immutable permissionRegistry;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    /// @notice Address whose EIP-712 signature authorises each `GuardedTransfer`.
    address public complianceSigner;

    /// @notice agentId => funding wallet => mandate, returned as (token, dailyCap, maxPerTx,
    ///         validUntil, restrictPayees, version, active). A closed mandate has its terms
    ///         zeroed and `active == false` but still shows the current `version`.
    mapping(bytes32 => mapping(address => Mandate)) public mandates;
    /// @notice nonce => already consumed (nonces are global to this guard).
    mapping(uint256 => bool) public nonceUsed;
    /// @notice actionHash => a transfer was already executed for this Fuku action.
    mapping(bytes32 => bool) public actionExecuted;

    /// @dev agentId => funding wallet => last mandate version handed out. Kept apart from
    ///      `mandates` so a closed and re-opened mandate never reuses a version.
    mapping(bytes32 => mapping(address => uint64)) private _mandateVersions;
    /// @dev agentId => funding wallet => payee => approved. Survives close / re-open.
    mapping(bytes32 => mapping(address => mapping(address => bool))) private _payees;
    /// @dev agentId => funding wallet => UTC day (block.timestamp / 1 days) => amount spent.
    mapping(bytes32 => mapping(address => mapping(uint256 => uint256))) private _spent;

    uint256 private _lock = 1;

    event ComplianceSignerSet(address indexed previousSigner, address indexed newSigner);
    event MandateOpened(
        bytes32 indexed agentId,
        address indexed wallet,
        address indexed token,
        uint256 dailyCap,
        uint256 maxPerTx,
        uint64 validUntil,
        bool restrictPayees,
        uint64 version
    );
    event MandateClosed(bytes32 indexed agentId, address indexed wallet, uint64 version);
    event PayeeSet(bytes32 indexed agentId, address indexed wallet, address indexed payee, bool allowed);
    event GuardedTransferExecuted(
        bytes32 indexed agentId,
        address indexed from,
        address indexed to,
        address token,
        uint256 amount,
        bytes32 actionHash,
        bytes32 proofHash,
        bytes32 complianceRef,
        uint64 mandateVersion,
        uint256 nonce
    );

    error AttestationExpired(uint64 deadline, uint256 timestamp);
    error NonceUsed(uint256 nonce);
    error ActionAlreadyExecuted(bytes32 actionHash);
    error BadAttestation();
    error AgentNotFound(bytes32 agentId);
    error AgentNotActive(bytes32 agentId, uint8 status);
    error PolicyNotActive(bytes32 agentId);
    error PolicyMismatch(bytes32 onChain, bytes32 attested);
    error NoMandate(bytes32 agentId, address wallet);
    error TokenNotMandated(address mandated, address requested);
    error StaleMandate(uint64 current, uint64 attested);
    error MandateExpired(uint64 validUntil);
    error PerTxLimitExceeded(uint256 maxPerTx);
    error PayeeNotApproved(address payee);
    error DailyCapExceeded(uint256 remaining);
    error InvalidMandate();
    error ZeroAmount();
    error ZeroRecipient();
    error ZeroDailyCap();
    error TokenTransferFailed(address token);
    error ReentrantCall();

    modifier nonReentrant() {
        if (_lock != 1) revert ReentrantCall();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address agentRegistry_, address permissionRegistry_, address complianceSigner_) {
        if (agentRegistry_ == address(0) || permissionRegistry_ == address(0) || complianceSigner_ == address(0)) {
            revert ZeroAddress();
        }
        agentRegistry = ISpendGuardAgentRegistry(agentRegistry_);
        permissionRegistry = ISpendGuardPermissionRegistry(permissionRegistry_);
        complianceSigner = complianceSigner_;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit ComplianceSignerSet(address(0), complianceSigner_);
    }

    // --- admin ---------------------------------------------------------------------------

    /// @notice Contract-owner only: rotate the compliance signer. Attestations signed by the
    ///         previous signer stop verifying immediately.
    function setComplianceSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        address previous = complianceSigner;
        complianceSigner = newSigner;
        emit ComplianceSignerSet(previous, newSigner);
    }

    // --- mandates and payees (msg.sender is the funding wallet) ----------------------------

    /// @notice Allow `agentId` to move `token` from the caller's wallet within these limits
    ///         (the caller must also approve this contract on `token`). Opening again replaces
    ///         the previous terms; the amount already spent today still counts. Every open
    ///         bumps the mandate version, voiding attestations issued under earlier terms.
    /// @param dailyCap       Max total per UTC day, in token base units; must be > 0.
    /// @param maxPerTx       Max per transfer; 0 = only the daily cap applies; must be <= dailyCap.
    /// @param validUntil     Unix seconds, must be in the future; 0 = no expiry. Transfers
    ///                       revert with `MandateExpired` once block.timestamp > validUntil.
    /// @param restrictPayees Only pay addresses the caller approved with `setPayee`.
    /// @dev The agent does not have to exist yet; `execute` checks it.
    function openMandate(
        bytes32 agentId,
        address token,
        uint256 dailyCap,
        uint256 maxPerTx,
        uint64 validUntil,
        bool restrictPayees
    ) external {
        if (token == address(0)) revert ZeroAddress();
        if (dailyCap == 0) revert ZeroDailyCap();
        if (maxPerTx > dailyCap || (validUntil != 0 && validUntil <= block.timestamp)) revert InvalidMandate();

        uint64 version = _bumpMandateVersion(agentId, msg.sender);
        mandates[agentId][msg.sender] = Mandate({
            token: token,
            dailyCap: dailyCap,
            maxPerTx: maxPerTx,
            validUntil: validUntil,
            restrictPayees: restrictPayees,
            version: version,
            active: true
        });
        emit MandateOpened(agentId, msg.sender, token, dailyCap, maxPerTx, validUntil, restrictPayees, version);
    }

    /// @notice Withdraw the caller's mandate for `agentId`. Bumps the mandate version, so
    ///         attestations issued before never work again, not even after a re-open.
    function closeMandate(bytes32 agentId) external {
        if (!mandates[agentId][msg.sender].active) revert NoMandate(agentId, msg.sender);
        uint64 version = _bumpMandateVersion(agentId, msg.sender);
        // Clear the terms; keep the current version readable through `mandates`.
        mandates[agentId][msg.sender] = Mandate({
            token: address(0),
            dailyCap: 0,
            maxPerTx: 0,
            validUntil: 0,
            restrictPayees: false,
            version: version,
            active: false
        });
        emit MandateClosed(agentId, msg.sender, version);
    }

    /// @notice Approve (`allowed` = true) or remove `payee` on the caller's payee list for
    ///         `agentId`. The list is enforced only while the caller's mandate has
    ///         `restrictPayees`, and it survives close / re-open (it is the owner's address
    ///         book). A removal takes effect immediately, including for attestations that
    ///         were already signed.
    function setPayee(bytes32 agentId, address payee, bool allowed) external {
        if (payee == address(0)) revert ZeroRecipient();
        _payees[agentId][msg.sender][payee] = allowed;
        emit PayeeSet(agentId, msg.sender, payee, allowed);
    }

    // --- execution -----------------------------------------------------------------------

    /// @notice Execute an attested transfer of `t.amount` of `t.token` from `t.from` to `t.to`.
    /// @param t   The attested transfer; see `GuardedTransfer`.
    /// @param sig 65-byte (r, s, v) EIP-712 signature by `complianceSigner` over `hashTransfer(t)`.
    function execute(GuardedTransfer calldata t, bytes calldata sig) external nonReentrant {
        // Checks (each helper reverts with its own custom error).
        _checkAttestation(t, sig);
        _checkAgentAndPolicy(t);
        uint256 newSpent = _checkMandateAndCap(t);

        // Effects: the attestation is single-use (nonce and action) and the day's spend grows.
        nonceUsed[t.nonce] = true;
        actionExecuted[t.actionHash] = true;
        _spent[t.agentId][t.from][block.timestamp / 1 days] = newSpent;

        // Interactions. Any revert below (such as the token's own compliance check) rolls the
        // effects back, so a failed transfer consumes no budget, nonce or action.
        _safeTransferFrom(t.token, t.from, t.to, t.amount);
        permissionRegistry.recordDecision(t.agentId, t.actionHash, true, t.proofHash, DECISION_RULE_ID);
        _emitExecuted(t);
    }

    // --- views ---------------------------------------------------------------------------

    /// @notice True when `wallet` approved `payee` for `agentId` (see `setPayee`).
    function isPayee(bytes32 agentId, address wallet, address payee) external view returns (bool) {
        return _payees[agentId][wallet][payee];
    }

    /// @notice Amount `agentId` has moved from `wallet` during the current UTC day.
    function spentToday(bytes32 agentId, address wallet) external view returns (uint256) {
        return _spent[agentId][wallet][block.timestamp / 1 days];
    }

    /// @notice Full EIP-712 digest of `t` (what the compliance signer signs).
    function hashTransfer(GuardedTransfer calldata t) public view returns (bytes32) {
        // Every field is a static type encoded as one 32-byte ABI word, so
        // abi.encode(typehash, t) is exactly the EIP-712 encodeData of the struct.
        bytes32 structHash = keccak256(abi.encode(GUARDED_TRANSFER_TYPEHASH, t));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice EIP-712 domain separator: name "FukuSpendGuard", version "1",
    ///         chainId = block.chainid, verifyingContract = this contract.
    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    // --- internals -----------------------------------------------------------------------

    /// @dev 1. Attestation: not expired, nonce unused, action not executed yet, and signed by
    ///      the compliance signer for this chain and this contract.
    function _checkAttestation(GuardedTransfer calldata t, bytes calldata sig) private view {
        if (block.timestamp > t.deadline) revert AttestationExpired(t.deadline, block.timestamp);
        if (nonceUsed[t.nonce]) revert NonceUsed(t.nonce);
        if (actionExecuted[t.actionHash]) revert ActionAlreadyExecuted(t.actionHash);
        if (_recover(hashTransfer(t), sig) != complianceSigner) revert BadAttestation();
    }

    /// @dev 2. Agent registered and neither Paused nor Revoked; 3. policy active and equal
    ///      to the policy hash the attestation was issued against.
    function _checkAgentAndPolicy(GuardedTransfer calldata t) private view {
        if (!agentRegistry.exists(t.agentId)) revert AgentNotFound(t.agentId);
        (,,,,, uint8 status,) = agentRegistry.agents(t.agentId);
        if (status >= AGENT_STATUS_PAUSED) revert AgentNotActive(t.agentId, status);

        (bytes32 policyHash,,, bool active,) = permissionRegistry.policies(t.agentId);
        if (!active) revert PolicyNotActive(t.agentId);
        if (policyHash != t.policyHash) revert PolicyMismatch(policyHash, t.policyHash);
    }

    /// @dev 4. Mandate open for (agent, from), on this token, at the attested version and not
    ///      expired; 5. sane amount / recipient; 6. per-transaction limit; 7. payee list when
    ///      restricted; 8. daily cap per (agent, wallet, UTC day). Returns today's spent total
    ///      after `t`.
    function _checkMandateAndCap(GuardedTransfer calldata t) private view returns (uint256 newSpent) {
        Mandate storage mandate = mandates[t.agentId][t.from];
        if (!mandate.active) revert NoMandate(t.agentId, t.from);
        if (mandate.token != t.token) revert TokenNotMandated(mandate.token, t.token);
        if (t.mandateVersion != mandate.version) revert StaleMandate(mandate.version, t.mandateVersion);
        uint64 validUntil = mandate.validUntil;
        if (validUntil != 0 && block.timestamp > validUntil) revert MandateExpired(validUntil);

        if (t.amount == 0) revert ZeroAmount();
        if (t.to == address(0)) revert ZeroRecipient();

        uint256 maxPerTx = mandate.maxPerTx;
        if (maxPerTx != 0 && t.amount > maxPerTx) revert PerTxLimitExceeded(maxPerTx);
        if (mandate.restrictPayees && !_payees[t.agentId][t.from][t.to]) revert PayeeNotApproved(t.to);

        uint256 spent = _spent[t.agentId][t.from][block.timestamp / 1 days];
        uint256 cap = mandate.dailyCap;
        uint256 remaining = spent >= cap ? 0 : cap - spent;
        if (t.amount > remaining) revert DailyCapExceeded(remaining);
        return spent + t.amount;
    }

    /// @dev Next version for (agentId, wallet): 1 on the first open, then +1 on every open
    ///      and close.
    function _bumpMandateVersion(bytes32 agentId, address wallet) private returns (uint64 version) {
        version = _mandateVersions[agentId][wallet] + 1;
        _mandateVersions[agentId][wallet] = version;
    }

    function _emitExecuted(GuardedTransfer calldata t) private {
        emit GuardedTransferExecuted(
            t.agentId,
            t.from,
            t.to,
            t.token,
            t.amount,
            t.actionHash,
            t.proofHash,
            t.complianceRef,
            t.mandateVersion,
            t.nonce
        );
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @dev Strict ecrecover: 65-byte signatures only, low-s, v in {27, 28}, non-zero signer.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadAttestation();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_HALF) revert BadAttestation();
        if (v != 27 && v != 28) revert BadAttestation();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadAttestation();
    }

    /// @dev transferFrom that accepts tokens returning nothing, and bubbles the token's
    ///      revert data (e.g. a Cleanverse `ComplianceRejected`) when the call fails.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        if (token.code.length == 0) revert TokenTransferFailed(token);
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, to, amount));
        if (!ok) {
            if (ret.length == 0) revert TokenTransferFailed(token);
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool)))) revert TokenTransferFailed(token);
    }
}
