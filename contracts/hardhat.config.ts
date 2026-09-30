import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";

// Load ./.env if present (Node >= 20.12 built-in, no dotenv dependency).
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the process environment
}

const MONAD_RPC_URL = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const rawKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const DEPLOYER_PRIVATE_KEY = rawKey ? (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) : undefined;

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Local JSON-RPC node (`npx hardhat node`) standing in for Monad testnet during development.
    // Accounts come from the node's unlocked list (Hardhat account #0 deploys).
    localhost: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: process.env.LOCALHOST_RPC_URL ?? "http://127.0.0.1:8545",
    },
    // A local fork of Monad testnet (`npx hardhat node --fork https://testnet-rpc.monad.xyz --port 8546
    // --chain-id 10143`): the real ERC-8004 registries at chain id 10143, and the node's funded
    // unlocked accounts. For rehearsing the testnet runbook without spending MON.
    monadFork: {
      type: "http",
      chainType: "l1",
      chainId: 10143,
      url: process.env.MONAD_FORK_RPC_URL ?? "http://127.0.0.1:8546",
    },
    monadTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 10143,
      url: MONAD_RPC_URL,
      // Only attach a signer when DEPLOYER_PRIVATE_KEY is set; otherwise fall back to
      // "remote" accounts (read-only unless the RPC node unlocks accounts).
      ...(DEPLOYER_PRIVATE_KEY ? { accounts: [DEPLOYER_PRIVATE_KEY] } : {}),
    },
  },
};

export default config;
