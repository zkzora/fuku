/**
 * Deploys the Fuku Protocol registries in dependency order, grants the deployer the
 * enforcer + scorer roles, and writes deployments/<network>.json.
 *
 *   npx hardhat run scripts/deploy.ts                        # in-process simulated network
 *   npx hardhat run scripts/deploy.ts --network monadTestnet # needs DEPLOYER_PRIVATE_KEY
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { network } from "hardhat";

const { viem, networkName } = await network.create();
const publicClient = await viem.getPublicClient();
const walletClients = await viem.getWalletClients();

if (walletClients.length === 0) {
  throw new Error(
    `No signer available on network "${networkName}". Set DEPLOYER_PRIVATE_KEY in .env (see .env.example).`,
  );
}

const [deployer] = walletClients;
const chainId = await publicClient.getChainId();
const balance = await publicClient.getBalance({ address: deployer.account.address });

console.log(`Network:  ${networkName} (chainId ${chainId})`);
console.log(`Deployer: ${deployer.account.address} (balance ${balance} wei)`);

async function wait(label: string, hashPromise: Promise<`0x${string}`>) {
  const hash = await hashPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed in tx ${hash}`);
  console.log(`  ${label}: ${hash}`);
}

console.log("Deploying HumanIdentityRegistry...");
const identityRegistry = await viem.deployContract("HumanIdentityRegistry");
console.log(`  -> ${identityRegistry.address}`);

console.log("Deploying AgentRegistry...");
const agentRegistry = await viem.deployContract("AgentRegistry", [identityRegistry.address]);
console.log(`  -> ${agentRegistry.address}`);

console.log("Deploying PermissionRegistry...");
const permissionRegistry = await viem.deployContract("PermissionRegistry", [agentRegistry.address]);
console.log(`  -> ${permissionRegistry.address}`);

console.log("Deploying ReputationRegistry...");
const reputationRegistry = await viem.deployContract("ReputationRegistry", [agentRegistry.address]);
console.log(`  -> ${reputationRegistry.address}`);

console.log("Granting roles to deployer...");
await wait("setEnforcer(deployer)", permissionRegistry.write.setEnforcer([deployer.account.address, true]));
await wait("setScorer(deployer)", reputationRegistry.write.setScorer([deployer.account.address, true]));

const deployment = {
  network: networkName,
  chainId,
  deployer: deployer.account.address,
  deployedAt: new Date().toISOString(),
  contracts: {
    HumanIdentityRegistry: identityRegistry.address,
    AgentRegistry: agentRegistry.address,
    PermissionRegistry: permissionRegistry.address,
    ReputationRegistry: reputationRegistry.address,
  },
};

const outDir = path.resolve(process.cwd(), "deployments");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${networkName}.json`);
writeFileSync(outFile, JSON.stringify(deployment, null, 2) + "\n");

console.log(`\nWrote ${outFile}`);
console.log(JSON.stringify(deployment.contracts, null, 2));
