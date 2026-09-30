/**
 * Shared deploy step for the Cleanverse simulators and FukuSpendGuard.
 *
 * Used by scripts/deploy.ts (fresh stack) and scripts/deploy-cleanverse.ts (add the three
 * contracts to an existing stack). Deploys, in order:
 *   1. CleanverseAPassSim   (deployer = owner = default issuer)
 *   2. CleanverseATokenSim  (rule: minTier 1, any group / sub-group)
 *   3. FukuSpendGuard       (against the given AgentRegistry / PermissionRegistry)
 * then calls PermissionRegistry.setEnforcer(guard, true) so the guard can record decisions.
 *
 * The guard's compliance signer is COMPLIANCE_SIGNER_ADDRESS when set, otherwise the
 * deployer (with a loud warning). The deployer must own PermissionRegistry; this is checked
 * before anything is deployed.
 */
import { getAddress, isAddress, zeroHash, type Address, type Hex } from "viem";
import type { NetworkConnection } from "hardhat/types/network";

/** Rule given to CleanverseATokenSim: tier >= 1, any group / sub-group / sub-tier. */
export const ATOKEN_RULE = { group: zeroHash, subGroup: zeroHash, minTier: 1, minSubTier: 0 } as const;

export type CleanverseAddresses = {
  complianceSigner: Address;
  CleanverseAPassSim: Address;
  CleanverseATokenSim: Address;
  FukuSpendGuard: Address;
};

/** COMPLIANCE_SIGNER_ADDRESS if set (validated), else the deployer with a loud warning. */
export function resolveComplianceSigner(deployer: Address): Address {
  const raw = process.env.COMPLIANCE_SIGNER_ADDRESS?.trim();
  if (raw) {
    if (!isAddress(raw, { strict: false })) {
      throw new Error(`COMPLIANCE_SIGNER_ADDRESS is not a valid address: "${raw}"`);
    }
    return raw.toLowerCase() as Address;
  }

  const bar = "!".repeat(86);
  console.warn("");
  console.warn(bar);
  console.warn("!! WARNING: COMPLIANCE_SIGNER_ADDRESS is not set.");
  console.warn(`!! FukuSpendGuard will trust the DEPLOYER ${deployer} as its compliance signer,`);
  console.warn("!! so GuardedTransfer attestations must be signed with the deployer key.");
  console.warn("!! Use a dedicated key instead: set COMPLIANCE_SIGNER_ADDRESS before deploying (and");
  console.warn("!! FUKU_COMPLIANCE_SIGNER_KEY for the web app), or rotate later with");
  console.warn("!! FukuSpendGuard.setComplianceSigner(address) from the owner account.");
  console.warn(bar);
  console.warn("");
  return deployer;
}

export async function deployCleanverse(
  connection: NetworkConnection,
  registries: { AgentRegistry: Address; PermissionRegistry: Address },
): Promise<CleanverseAddresses> {
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  if (!deployer) throw new Error("No signer available to deploy the Cleanverse contracts.");

  async function wait(label: string, hashPromise: Promise<Hex>) {
    const hash = await hashPromise;
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} failed in tx ${hash}`);
    console.log(`  ${label}: ${hash}`);
  }

  // Pre-flight: the guard must be made an enforcer, which only the registry owner can do.
  const permissionRegistry = await viem.getContractAt("PermissionRegistry", registries.PermissionRegistry);
  const registryOwner = await permissionRegistry.read.owner();
  if (getAddress(registryOwner) !== getAddress(deployer.account.address)) {
    throw new Error(
      `PermissionRegistry ${registries.PermissionRegistry} is owned by ${registryOwner}, not by the deployer ` +
        `${deployer.account.address}; it could not make FukuSpendGuard an enforcer. Deploy with the owner key.`,
    );
  }

  const complianceSigner = resolveComplianceSigner(deployer.account.address);
  console.log(`Compliance signer: ${complianceSigner}`);

  console.log("Deploying CleanverseAPassSim...");
  const apass = await viem.deployContract("CleanverseAPassSim");
  console.log(`  -> ${apass.address}`);

  console.log("Deploying CleanverseATokenSim (rule: minTier 1, any group)...");
  const atoken = await viem.deployContract("CleanverseATokenSim", [apass.address, ATOKEN_RULE]);
  console.log(`  -> ${atoken.address}`);

  console.log("Deploying FukuSpendGuard...");
  const guard = await viem.deployContract("FukuSpendGuard", [
    registries.AgentRegistry,
    registries.PermissionRegistry,
    complianceSigner,
  ]);
  console.log(`  -> ${guard.address}`);

  console.log("Granting FukuSpendGuard the enforcer role...");
  await wait("PermissionRegistry.setEnforcer(FukuSpendGuard)", permissionRegistry.write.setEnforcer([guard.address, true]));

  return {
    complianceSigner,
    CleanverseAPassSim: apass.address,
    CleanverseATokenSim: atoken.address,
    FukuSpendGuard: guard.address,
  };
}
