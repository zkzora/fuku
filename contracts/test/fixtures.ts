import { keccak256, maxUint256, stringToHex, zeroHash, type Address, type Hex } from "viem";
import type { NetworkConnection } from "hardhat/types/network";

export const id = (label: string): Hex => keccak256(stringToHex(label));

export const ALICE_ID = id("identity:alice");
export const BOB_ID = id("identity:bob");
export const AGENT_ID = id("agent:alice-assistant");
export const PASSKEY_HASH = id("passkey:alice");
export const PROOF_HASH = id("proof:alice");
export const CAPABILITIES_HASH = id("capabilities:v1");

/**
 * Deploys the whole Fuku stack on a fresh connection and registers:
 *  - alice's identity (controller = alice)
 *  - bob's identity (controller = bob)
 *  - one agent owned by alice
 * Wallet index 0 (owner) deploys every contract and is therefore the contract owner.
 */
export async function deployFukuStack(connection: NetworkConnection) {
  const { viem } = connection;
  const [owner, alice, bob, enforcer, scorer, stranger] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const identityRegistry = await viem.deployContract("HumanIdentityRegistry");
  const agentRegistry = await viem.deployContract("AgentRegistry", [identityRegistry.address]);
  const permissionRegistry = await viem.deployContract("PermissionRegistry", [agentRegistry.address]);
  const reputationRegistry = await viem.deployContract("ReputationRegistry", [agentRegistry.address]);

  await identityRegistry.write.registerIdentity([ALICE_ID, PASSKEY_HASH, PROOF_HASH], { account: alice.account });
  await identityRegistry.write.registerIdentity([BOB_ID, id("passkey:bob"), id("proof:bob")], { account: bob.account });

  await agentRegistry.write.registerAgent(
    [AGENT_ID, ALICE_ID, "Alice Assistant", "1.0.0", CAPABILITIES_HASH, "ipfs://agent-metadata"],
    { account: alice.account },
  );

  return {
    viem,
    publicClient,
    owner,
    alice,
    bob,
    enforcer,
    scorer,
    stranger,
    identityRegistry,
    agentRegistry,
    permissionRegistry,
    reputationRegistry,
  };
}

// --- Cleanverse simulator + FukuSpendGuard ----------------------------------------------

export const POLICY_HASH = id("policy:v1");
export const GROUP_RETAIL = id("cleanverse:group:retail");
export const ONE_TOKEN = 1_000_000n; // aUSDC-SIM has 6 decimals
export const MINT_AMOUNT = 1_000n * ONE_TOKEN;
export const DAILY_CAP = 500n * ONE_TOKEN;
/** Rule the deploy scripts give the aToken: tier >= 1, any group / sub-group. */
export const ATOKEN_RULE = { group: zeroHash, subGroup: zeroHash, minTier: 1, minSubTier: 0 } as const;

export type APass = {
  status: number;
  tier: number;
  subTier: number;
  group: Hex;
  subGroup: Hex;
  expiresAt: bigint;
  cvRecordId: Hex;
};

/** An active, non-expiring tier-2 retail A-Pass, with optional overrides. */
export function activePass(overrides: Partial<APass> = {}): APass {
  return {
    status: 1,
    tier: 2,
    subTier: 0,
    group: GROUP_RETAIL,
    subGroup: zeroHash,
    expiresAt: 0n,
    cvRecordId: id("cv:record"),
    ...overrides,
  };
}

export type GuardedTransfer = {
  agentId: Hex;
  from: Address;
  to: Address;
  token: Address;
  amount: bigint;
  policyHash: Hex;
  actionHash: Hex;
  proofHash: Hex;
  complianceRef: Hex;
  mandateVersion: bigint;
  nonce: bigint;
  deadline: bigint;
};

/** EIP-712 types for FukuSpendGuard. Field order must match the Solidity typehash. */
export const GUARDED_TRANSFER_TYPES = {
  GuardedTransfer: [
    { name: "agentId", type: "bytes32" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "actionHash", type: "bytes32" },
    { name: "proofHash", type: "bytes32" },
    { name: "complianceRef", type: "bytes32" },
    { name: "mandateVersion", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/** Index of `version` in the tuple returned by FukuSpendGuard.mandates(agentId, wallet). */
const MANDATE_VERSION_INDEX = 5;

/**
 * deployFukuStack plus the Cleanverse simulators and FukuSpendGuard:
 *  - CleanverseAPassSim (owner = issuer) with active tier-2 A-Passes for alice and bob
 *  - CleanverseATokenSim with ATOKEN_RULE; MINT_AMOUNT minted to alice
 *  - FukuSpendGuard whose compliance signer is wallet #6 (dedicated), set as a
 *    PermissionRegistry enforcer
 *  - POLICY_HASH set (active) for AGENT_ID by alice
 *  - alice opened a DAILY_CAP mandate for AGENT_ID on the aToken (no per-tx limit, no
 *    expiry, any payee; mandate version 1) and approved the guard
 * `signed()` builds a GuardedTransfer (alice -> bob, 100 tokens, fresh nonce and action,
 * the current on-chain mandate version of (agentId, from), deadline latest block + 1h, any
 * field overridable) and signs it with the compliance signer. `sign()` optionally takes
 * domain overrides to sign for another chain id or verifying contract.
 */
export async function deployCleanverseStack(connection: NetworkConnection) {
  const stack = await deployFukuStack(connection);
  const { viem, publicClient, alice, bob, agentRegistry, permissionRegistry } = stack;
  const wallets = await viem.getWalletClients();
  const complianceSigner = wallets[6];
  const carol = wallets[7];

  const apass = await viem.deployContract("CleanverseAPassSim");
  const atoken = await viem.deployContract("CleanverseATokenSim", [apass.address, ATOKEN_RULE]);
  const guard = await viem.deployContract("FukuSpendGuard", [
    agentRegistry.address,
    permissionRegistry.address,
    complianceSigner.account.address,
  ]);

  await permissionRegistry.write.setEnforcer([guard.address, true]);
  await permissionRegistry.write.setPolicy([AGENT_ID, POLICY_HASH, 1, "ipfs://policy-v1"], { account: alice.account });

  await apass.write.issue([alice.account.address, activePass({ cvRecordId: id("cv:alice") })]);
  await apass.write.issue([bob.account.address, activePass({ cvRecordId: id("cv:bob") })]);
  await atoken.write.mint([alice.account.address, MINT_AMOUNT]);

  await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, 0n, false], { account: alice.account });
  await atoken.write.approve([guard.address, maxUint256], { account: alice.account });

  const chainId = await publicClient.getChainId();
  const domain = { name: "FukuSpendGuard", version: "1", chainId, verifyingContract: guard.address } as const;

  /** Current mandate version of (agentId, wallet), as the Fuku server would attest to it. */
  async function mandateVersionOf(agentId: Hex, wallet: Address): Promise<bigint> {
    return (await guard.read.mandates([agentId, wallet]))[MANDATE_VERSION_INDEX];
  }

  let nextNonce = 1n;
  async function buildTransfer(overrides: Partial<GuardedTransfer> = {}): Promise<GuardedTransfer> {
    const n = nextNonce++;
    const latest = await publicClient.getBlock();
    const agentId = overrides.agentId ?? AGENT_ID;
    const from = overrides.from ?? alice.account.address;
    return {
      agentId,
      from,
      to: bob.account.address,
      token: atoken.address,
      amount: 100n * ONE_TOKEN,
      policyHash: POLICY_HASH,
      actionHash: id(`action:${n}`),
      proofHash: id(`proof:${n}`),
      complianceRef: id(`cleanverse:ref:${n}`),
      mandateVersion: overrides.mandateVersion ?? (await mandateVersionOf(agentId, from)),
      nonce: n,
      deadline: latest.timestamp + 3600n,
      ...overrides,
    };
  }

  type Domain = { name: string; version: string; chainId: number; verifyingContract: Address };

  async function sign(t: GuardedTransfer, signer = complianceSigner, domainOverrides: Partial<Domain> = {}): Promise<Hex> {
    return signer.signTypedData({
      account: signer.account,
      domain: { ...domain, ...domainOverrides },
      types: GUARDED_TRANSFER_TYPES,
      primaryType: "GuardedTransfer",
      message: t,
    });
  }

  async function signed(overrides: Partial<GuardedTransfer> = {}) {
    const t = await buildTransfer(overrides);
    return { t, sig: await sign(t) };
  }

  return {
    ...stack,
    complianceSigner,
    carol,
    apass,
    atoken,
    guard,
    chainId,
    domain,
    mandateVersionOf,
    buildTransfer,
    sign,
    signed,
  };
}
