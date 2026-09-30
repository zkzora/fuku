import { keccak256, stringToHex, type Hex } from "viem";
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
