# Fuku Protocol — Contracts

Smart-contract layer for **Fuku Protocol**, a human-backed AI-agent trust layer on
[Monad](https://monad.xyz). This is a standalone [Hardhat 3](https://hardhat.org) project
(viem toolbox, `node:test` runner). It is **not** part of the npm workspace at the repo
root: run every command from inside `contracts/` and install dependencies here only.

## Contracts

| Contract | Purpose |
| --- | --- |
| `HumanIdentityRegistry` | Binds an opaque `identityId` to a controller address, passkey public-key hash and proof hash. The contract owner (verifier role) flags identities as human-verified. |
| `AgentRegistry` | ERC-8004-inspired agent identity. Each agent is owned by a human identity; only that identity's controller can register it or change its status (`0 Registered, 1 Active, 2 Paused, 3 Revoked`). |
| `PermissionRegistry` | The "Agent Permission Passport": per-agent policy commitment (`policyHash`, `version`, `policyURI`, `active`) plus an append-only `ActionDecision` event log and allow/violation counters. Decisions are recorded by the agent owner or by allow-listed enforcers. |
| `ReputationRegistry` | Latest 0–100 score per agent written by allow-listed scorers; every update emits `ScoreUpdated`. |

`Ownable.sol` is a tiny inline owner pattern (no OpenZeppelin). `IAgentRegistry.sol` is the
narrow interface shared by the permission and reputation registries.

Dependency order: `HumanIdentityRegistry` → `AgentRegistry` → `PermissionRegistry` / `ReputationRegistry`.

## Requirements

- Node.js 22+ (developed on Node 24) and npm
- No Foundry needed

## Setup

```bash
cd contracts
npm install
cp .env.example .env   # then fill in DEPLOYER_PRIVATE_KEY for testnet deploys (see "Go live")
```

## Compile

```bash
npm run compile        # npx hardhat compile
```

Solidity `0.8.28`, optimizer enabled (200 runs). Artifacts land in `artifacts/` (git-ignored).

## Test

```bash
npm test               # npx hardhat test
```

Tests live in `test/*.test.ts` and use Node's built-in `node:test` runner with
`node:assert/strict` and Hardhat's viem assertions. Each test deploys a fresh stack via
`test/fixtures.ts`.

## Deploy

### Local (in-process simulated network)

```bash
npm run deploy:local   # npx hardhat run scripts/deploy.ts
```

### Go live on Monad testnet (chainId 10143)

Once you have a private key holding some testnet MON, going live is three commands from
this folder. Nothing beyond Node and this folder's `node_modules` is needed.

#### 0. One time: a deployer key with testnet MON

Generate a throwaway key (never reuse a mainnet key), or export one from MetaMask
(account menu -> Account details -> Show private key):

```bash
node -e "import('viem/accounts').then(a=>{const k=a.generatePrivateKey();console.log(k, a.privateKeyToAccount(k).address)})"
```

Fund the printed address at the Monad faucet, <https://faucet.monad.xyz> (alternatives in
[Monad testnet facts](#monad-testnet-facts-verified-2026-09-23)), then put the key in `.env`:

```bash
cp .env.example .env
# .env
DEPLOYER_PRIVATE_KEY=0x...                      # 0x + 64 hex characters
MONAD_RPC_URL=https://testnet-rpc.monad.xyz     # public endpoint; a QuickNode/Alchemy/Ankr URL avoids rate limits
```

#### 1, 2, 3

```bash
npm run check:deployer   # address, chain id (must be 10143) and MON balance; fails early if unfunded
npm run deploy:monad     # 4 contracts + 2 role grants, writes deployments/monadTestnet.json
npm run wire:env         # backs up ../web/.env to ../web/.env.bak, upserts the live settings into it
```

Then restart the web app (`Ctrl+C`, `cd ../web && npm run dev -- -p 3001`): Next.js reads
`.env` when it starts.

What the two helper scripts do:

- `check:deployer` (`scripts/check-deployer.mjs`) reads `DEPLOYER_PRIVATE_KEY` and
  `MONAD_RPC_URL` from `.env` or the environment, derives the address with viem, asks the RPC
  for the chain id and balance, and prints all three. It exits 1 with a plain-language hint
  when the key is missing or malformed, the RPC is unreachable, the chain id is not 10143, or
  the balance is 0 (it points you at the faucet). The key itself is never printed.
  Flags: `--rpc <url>`, `--chain-id <id>`.
- `wire:env` (`scripts/wire-env.mjs`) reads `deployments/<network>.json` (default
  `monadTestnet`) and upserts into `../web/.env`: `FUKU_CHAIN_MODE=live`, `FUKU_CHAIN_ID`,
  `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (copied from `.env` or the environment) and
  `FUKU_IDENTITY_REGISTRY`, `FUKU_AGENT_REGISTRY`, `FUKU_PERMISSION_REGISTRY`,
  `FUKU_REPUTATION_REGISTRY`. Existing lines are replaced in place, commented placeholders
  such as `# FUKU_AGENT_REGISTRY=0x...` are uncommented, every other line is kept, and the
  previous file is copied to `.env.bak` first. Flags: `--network <name>` (or positional),
  `--env <path>` to target another file, `--dry-run` to print the resulting file to stdout
  (key masked) without writing anything.

An exported variable wins over `.env` (Node's `process.loadEnvFile` does not override the
environment), so one-off overrides work:
`MONAD_RPC_URL=https://rpc.ankr.com/monad_testnet npm run check:deployer`.

#### Confirm it is live

- `curl -s http://localhost:3001/api/integrations` -> `"chain": { "mode": "live", "chainId": 10143, ..., "signer": "0x<your deployer>" }`,
  and the Monad card in the Developer Console integration board reads **live**
  ("Transactions are signed and anchored on Monad testnet") instead of **simulated**.
- Run an action (Dashboard -> **Run agent action**, or `POST /api/agents/:id/actions`).
  The receipt has `"mode": "live"`, a real `txHash` and an `explorerUrl` that opens on the
  explorer (`testnet.monadexplorer.com` redirects to `testnet.monadvision.com`). In mock
  mode the same receipt says `"mode": "mock"` with a note.
- `GET /api/v1/agents/:id` with `Authorization: Bearer <api key>` includes `"chain": "live"`.
- If `web/scripts/live-smoke.mjs` is present in your checkout, it drives the whole demo
  flow through the API and then re-reads the registries with viem. Against testnet, from
  `web/`:
  `FUKU_BASE_URL=http://localhost:3001 MONAD_RPC_URL=https://testnet-rpc.monad.xyz FUKU_DEPLOYMENT_FILE=../contracts/deployments/monadTestnet.json node scripts/live-smoke.mjs`
  (its defaults target a local Hardhat node on port 3002; exit code 0 means every check passed).

#### Rehearse against a local node (optional)

`npx hardhat node` in one terminal, then `npx hardhat run scripts/deploy.ts --network localhost`
writes `deployments/localhost.json` (chain 31337). Wire the web app to it with the node's
account #0 key and RPC for that run only:
`DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 MONAD_RPC_URL=http://127.0.0.1:8545 npm run wire:env -- --network localhost`.
Re-run `npm run wire:env` (no overrides) to point it back at testnet.

#### Monad testnet facts (verified 2026-09-23)

| Item | Value | How it was verified |
| --- | --- | --- |
| Chain id | **10143** (`0x279f`) | [docs: Network Information - Testnet](https://docs.monad.xyz/developer-essentials/testnet), [docs: add testnet to wallet](https://docs.monad.xyz/guides/add-monad-to-wallet/testnet), [chainlist.org/chain/10143](https://chainlist.org/chain/10143), [chainid.network](https://chainid.network/chain/10143/); a live `eth_chainId` call to the public RPC returned `0x279f` |
| RPC | **https://testnet-rpc.monad.xyz** (public, QuickNode-hosted per the docs). Alternates the docs list: `https://rpc.ankr.com/monad_testnet`, `https://rpc-testnet.monadinfra.com` (both also have `wss://`) | docs testnet page; live `eth_blockNumber` returned `0x3de872b` (block 64,915,243) |
| Explorer | Docs list **https://testnet.monadvision.com** and **https://testnet.monadscan.com**. `https://testnet.monadexplorer.com`, the web app's default, now answers HTTP 308 to `testnet.monadvision.com` (including `/tx/<hash>` paths), so receipt links keep working; set `FUKU_EXPLORER_URL` in `web/.env` to change it | [docs: block explorers](https://docs.monad.xyz/tooling-and-infra/block-explorers); `curl -I` |
| Faucet | **https://faucet.monad.xyz** (the docs testnet page names it as the faucet). Fetching it from a script returns HTTP 429 (Vercel security checkpoint), so its current per-claim amount and cooldown could not be read directly; open it in a browser and follow the rules it shows (they vary by wallet history). Alternatives: [QuickNode](https://faucet.quicknode.com/monad/testnet), [Alchemy](https://www.alchemy.com/faucets/monad-testnet), [Chainlink](https://faucets.chain.link/monad-testnet) | docs testnet page; the docs' own [faucet page](https://docs.monad.xyz/developer-essentials/faucet) rendered without details when fetched; the three alternative faucet pages answered HTTP 200 |
| Notices | The docs say the **testnet was reset from genesis on 2025-12-16** (client v0.15.2, MONAD_NINE); anything deployed before that date is gone. Monad **mainnet is chain 143** (`https://rpc.monad.xyz`, real MON), so never point `MONAD_RPC_URL` there. `testnet.monad.xyz` now redirects to `monad.xyz/developers/` | [docs testnet page](https://docs.monad.xyz/developer-essentials/testnet), [docs mainnet page](https://docs.monad.xyz/developer-essentials/network-information); `curl -I` |

Sources agree on chain id, RPC and faucet. The only drift is the explorer hostname
(monadexplorer.com -> monadvision.com), handled by the redirect.

#### Troubleshooting

- **insufficient funds / insufficient balance** while deploying: the deployer ran out of MON.
  A full deploy is six transactions (four contract creations, two role grants). Top up at the
  faucet and re-run `npm run check:deployer` until it prints a non-zero balance.
- **Wrong chain id** (`check:deployer` says "Wrong chain", or Hardhat refuses to connect):
  `MONAD_RPC_URL` points at mainnet (143), a local node (31337) or a stale endpoint.
  `hardhat.config.ts` pins `monadTestnet` to 10143; use a testnet RPC from the table above.
- **RPC rate limits** (HTTP 429, "too many requests", random timeouts on the public endpoint):
  switch `MONAD_RPC_URL` to a dedicated endpoint (QuickNode, Alchemy, Ankr, monadinfra), set
  it in both `contracts/.env` and `web/.env` (re-run `npm run wire:env`), and retry. When a
  live write fails, the web app records a mock receipt whose note starts with
  `Live settlement failed (...)` and logs the reason under `[fuku-chain]`.
- **`NotIdentityController`**: the signer (`DEPLOYER_PRIVATE_KEY` in `web/.env`) is not the
  controller address that `HumanIdentityRegistry` recorded for that identity.
  `AgentRegistry.registerAgent` requires `msg.sender == controllerOf(ownerIdentityId)`. This
  happens when the identity was anchored with a different key, or the key was changed after
  anchoring. Use the key that anchored the identity, or deploy fresh registries
  (`npm run deploy:monad && npm run wire:env`) so everything re-anchors with the current key.
- **`NotAuthorized` / `NotScorer`**: the signer is not an enforcer / scorer. The deploy
  script grants both roles to the deployer, so this means `web/.env` is signing with a
  different key than the one that deployed; either use that key or, as the registry owner,
  call `setEnforcer(addr, true)` / `setScorer(addr, true)`.
- **`AgentNotFound`**: a policy, decision or score was written for an agent that was never
  registered on-chain. The web adapter registers agents lazily before writing, so check the
  server log for the failed `registerAgent` transaction.
- **Board still says "simulated" after wiring**: the app logs
  `[fuku-chain] FUKU_CHAIN_MODE=live but DEPLOYER_PRIVATE_KEY or a FUKU_*_REGISTRY address is missing`.
  Run `npm run wire:env -- --dry-run` to see what would be written, fix `contracts/.env`,
  re-run `npm run wire:env` and restart the web app.
- **`No signer available on network "monadTestnet"`**: the deploy script's own error;
  `DEPLOYER_PRIVATE_KEY` is missing from `contracts/.env`.
- **nonce too low / replacement transaction underpriced**: two processes are signing with the
  same key at once (for example `live-smoke.mjs` while clicking in the UI). Run one at a time.

### Deploy script details

`npm run deploy:monad` runs `npx hardhat run scripts/deploy.ts --network monadTestnet`. The
script deploys the four contracts in dependency order, grants the deployer the
`enforcer` (PermissionRegistry) and `scorer` (ReputationRegistry) roles, and writes
`deployments/<network>.json`:

```json
{
  "network": "monadTestnet",
  "chainId": 10143,
  "deployer": "0x...",
  "deployedAt": "2026-...",
  "contracts": {
    "HumanIdentityRegistry": "0x...",
    "AgentRegistry": "0x...",
    "PermissionRegistry": "0x...",
    "ReputationRegistry": "0x..."
  }
}
```

If `DEPLOYER_PRIVATE_KEY` is unset the `monadTestnet` network is configured without
signers (read-only), and the deploy script exits with a clear error.

## ABIs

After compiling, export ABIs for the web app / SDK:

```bash
npm run export-abi     # node scripts/export-abi.mjs
```

This writes:

- `abi/HumanIdentityRegistry.json`, `abi/AgentRegistry.json`,
  `abi/PermissionRegistry.json`, `abi/ReputationRegistry.json` — plain ABI arrays
- `abi/index.ts` — `as const` exports for viem / wagmi:

```ts
import { AgentRegistryAbi, PermissionRegistryAbi, FukuAbis } from "../contracts/abi/index.ts";

const agent = getContract({ address, abi: AgentRegistryAbi, client });
```

Exported names: `HumanIdentityRegistryAbi`, `AgentRegistryAbi`, `PermissionRegistryAbi`,
`ReputationRegistryAbi`, plus the `FukuAbis` map and the `FukuContractName` type.

Re-run the export whenever a contract interface changes; `abi/` is committed so
consumers do not need to compile.

## Layout

```
contracts/
  contracts/            Solidity sources
  test/                 node:test suites + fixtures.ts
  scripts/check-deployer.mjs   pre-flight: address, chain id, MON balance (npm run check:deployer)
  scripts/deploy.ts            deploy + role grants + deployments/<network>.json
  scripts/wire-env.mjs         deployments/<network>.json -> ../web/.env (npm run wire:env)
  scripts/export-abi.mjs
  abi/                  exported ABIs (JSON + index.ts)
  deployments/          per-network address files
  hardhat.config.ts
  .env.example
```

## Notes

- Access control: `Ownable` owner = deployer. Transfer with `transferOwnership(address)`.
- All timestamps are `uint64 block.timestamp`; all IDs are opaque `bytes32` values
  (e.g. `keccak256` of an off-chain identifier).
- Custom errors are used everywhere (`NotOwner`, `AlreadyRegistered`,
  `NotIdentityController`, `NotAgentOwner`, `NotAuthorized`, `NotScorer`,
  `ScoreOutOfBounds`, ...). Decode them with the exported ABIs.
