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
| `FukuSpendGuard` | Moves a funding wallet's tokens for an agent only inside the mandate that wallet opened on-chain (token, UTC-day cap, per-transaction limit, expiry, optional payee list), only with a single-use EIP-712 attestation from the compliance signer tied to the current mandate version, and only for a live agent whose active on-chain policy matches. Records each transfer as an allowed decision (`"R6"`) in `PermissionRegistry` (it is an enforcer). See [below](#cleanverse-simulator-contracts--fukuspendguard). |
| `sim/CleanverseAPassSim` | **Simulator** of the Cleanverse A-Pass (CVI): wallet-bound, non-transferable compliance credential; `verify` mirrors Cleanverse `verify_apass` codes. |
| `sim/CleanverseATokenSim` | **Simulator** of a Cleanverse aToken (`aUSDC-SIM`, 6 decimals): ERC-20 whose transfers require an eligible A-Pass on both sides. |

`Ownable.sol` is a tiny inline owner pattern (no OpenZeppelin). `IAgentRegistry.sol` is the
narrow interface shared by the permission and reputation registries.

Dependency order: `HumanIdentityRegistry` → `AgentRegistry` → `PermissionRegistry` / `ReputationRegistry`
→ `CleanverseAPassSim` → `CleanverseATokenSim`, and `FukuSpendGuard` (needs `AgentRegistry` +
`PermissionRegistry`, then `PermissionRegistry.setEnforcer(guard, true)`).

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
npm run deploy:monad     # 7 contracts + 3 role grants, writes deployments/monadTestnet.json
npm run wire:env         # backs up ../web/.env to ../web/.env.bak, upserts the live settings into it
```

Set `COMPLIANCE_SIGNER_ADDRESS` in `.env` first (see
[Cleanverse simulator contracts + FukuSpendGuard](#cleanverse-simulator-contracts--fukuspendguard));
otherwise the deployer becomes the guard's compliance signer and the deploy prints a warning.
Already deployed the four registries? `npm run deploy:cleanverse:monad` adds only the three
new contracts to the existing `deployments/monadTestnet.json` instead of redeploying everything.

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
  `FUKU_REPUTATION_REGISTRY`; plus, when the deployments file has them, `FUKU_SPEND_GUARD`,
  `CLEANVERSE_SIM_APASS`, `CLEANVERSE_SIM_ATOKEN`, and `FUKU_COMPLIANCE_SIGNER_KEY` when it is
  set in `.env` or the environment (masked in `--dry-run` like the deployer key; the script
  warns when that key's address is not the deployment's `complianceSigner`, because every
  guarded transfer would then revert with `BadAttestation`). Existing lines are replaced in place, commented placeholders
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

`npx hardhat node` in one terminal, then
`COMPLIANCE_SIGNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 npx hardhat run scripts/deploy.ts --network localhost`
writes `deployments/localhost.json` (chain 31337). Wire the web app to it with the node's
account keys and RPC for that run only:
`DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 FUKU_COMPLIANCE_SIGNER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d MONAD_RPC_URL=http://127.0.0.1:8545 npm run wire:env -- --network localhost`.
Re-run `npm run wire:env` (no overrides) to point it back at testnet.

Local node account roles (Hardhat's well-known default accounts; **local-test values only**,
publicly known, never fund them on a real network):

| Account | Role on localhost | Address | Private key |
| --- | --- | --- | --- |
| #0 | Deployer: owner of every contract, registry enforcer + scorer, A-Pass issuer, aToken minter | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| #1 | Compliance signer (`COMPLIANCE_SIGNER_ADDRESS` / `FUKU_COMPLIANCE_SIGNER_KEY`): signs `GuardedTransfer` attestations | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| #2 | Demo owner: the funding wallet that holds an A-Pass and aUSDC-SIM, opens the mandate and approves the guard | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |

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
  A full deploy is ten transactions (seven contract creations, three role grants);
  `deploy:cleanverse:monad` is four (three creations, one role grant). Top up at the
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
script deploys the four registries in dependency order, grants the deployer the
`enforcer` (PermissionRegistry) and `scorer` (ReputationRegistry) roles, deploys the
Cleanverse simulators and `FukuSpendGuard` through the shared `scripts/lib/cleanverse.ts`
(which also makes the guard a PermissionRegistry enforcer), and writes
`deployments/<network>.json`:

```json
{
  "network": "monadTestnet",
  "chainId": 10143,
  "deployer": "0x...",
  "deployedAt": "2026-...",
  "complianceSigner": "0x...",
  "contracts": {
    "HumanIdentityRegistry": "0x...",
    "AgentRegistry": "0x...",
    "PermissionRegistry": "0x...",
    "ReputationRegistry": "0x...",
    "CleanverseAPassSim": "0x...",
    "CleanverseATokenSim": "0x...",
    "FukuSpendGuard": "0x..."
  }
}
```

Files written before the Cleanverse contracts existed have only the four registries and no
`complianceSigner`; `scripts/deploy-cleanverse.ts` adds the rest (below).

If `DEPLOYER_PRIVATE_KEY` is unset the `monadTestnet` network is configured without
signers (read-only), and the deploy script exits with a clear error.

## Cleanverse simulator contracts + FukuSpendGuard

Cleanverse is not deployed on Monad testnet, so `contracts/sim/` holds two **simulators**
that reproduce the parts of Cleanverse the demo needs. They are not Cleanverse code and hold
no real value. `FukuSpendGuard` is a real Fuku contract (not the `cre/` workflow of a similar
name) and works with any ERC-20, including a real Cleanverse aToken.

### `CleanverseAPassSim` (A-Pass / CVI)

- `APass { status, tier, subTier, group, subGroup, expiresAt, cvRecordId }`; status `0` none,
  `1` active, `2` frozen; `expiresAt == 0` never expires.
- Wallet-bound: there is no transfer function at all. Issuers call `issue(wallet, pass)`
  (status must be 1 or 2) and `setStatus(wallet, status)` (0 revokes; the pass must exist).
  The deployer is an issuer by default; the owner manages issuers with `setIssuer(addr, bool)`.
- `verify(wallet, Rule{group, subGroup, minTier, minSubTier})` returns the Cleanverse
  `verify_apass` code, evaluated in this order: **2** no A-Pass (status 0 / never issued) ->
  **3** frozen or expired (`expiresAt != 0 && expiresAt <= block.timestamp`) -> **1** rule
  rejected (`tier < minTier`, or `tier == minTier && subTier < minSubTier`, or a non-zero
  `group` / `subGroup` that differs) -> **4** eligible. A zero rule field means "any".
- Events `APassIssued`, `APassStatusChanged`, `IssuerSet`; errors `NotIssuer`,
  `InvalidStatus`, `NoAPass`, `ZeroAddress`, `NotOwner`.

### `CleanverseATokenSim` (aToken)

- ERC-20 "Cleanverse aUSDC (Fuku simulator)" / `aUSDC-SIM`, 6 decimals, no permit.
- Constructor takes the A-Pass address and a `Rule`; the deploy scripts use `minTier = 1`,
  everything else "any". The owner can `setRule` (event `RuleSet`).
- `transfer` / `transferFrom` require `verify(from) == 4` and then `verify(to) == 4`, else
  `ComplianceRejected(address who, uint8 code)`. The spender (`msg.sender` of
  `transferFrom`) is not checked, so the guard can move funds between eligible wallets.
- `mint(to, amount)` is owner-only and only to eligible wallets. `setPaused(bool)` (owner,
  mirrors Cleanverse `atoken/set_paused`) blocks transfer / transferFrom / mint with
  `TokenPaused`. `type(uint256).max` allowances are never decremented.

### `FukuSpendGuard`

Trust model: the compliance signer (the Fuku server key) decides off-chain whether an action is
allowed, but it can only move funds inside what the owner's own wallet authorised on-chain: the
mandate's token, UTC-day cap, per-transaction limit, expiry and (with `restrictPayees`) payee
list, plus the ERC-20 allowance the wallet gave the guard. It can only do so for a live agent
(registered, neither Paused nor Revoked) whose current on-chain policy is active and equal to the
attested policy hash. Every attestation is single-use (its nonce and its `actionHash`) and tied
to the current mandate version, so changing, closing or re-opening a mandate voids it. A leaked
signer key is therefore bounded by the open mandates and allowances; the owner cuts it off by
closing the mandate, pausing or revoking the agent, revoking the policy or withdrawing the
allowance, and the guard owner can rotate the key with `setComplianceSigner`.

- `constructor(agentRegistry, permissionRegistry, complianceSigner)`; owner-only
  `setComplianceSigner(address)` (event `ComplianceSignerSet`).
- Mandates, keyed by (agentId, wallet), are managed by the funding wallet itself
  (`msg.sender`). The agent need not exist yet. The wallet must also `approve` the guard on the
  token.
  - `openMandate(agentId, token, dailyCap, maxPerTx, validUntil, restrictPayees)`.
    `maxPerTx == 0` means no per-transaction limit beyond the daily cap; `validUntil` is unix
    seconds, `0` = no expiry, expired once `block.timestamp > validUntil`. Reverts `ZeroAddress`
    (token 0), `ZeroDailyCap`, or `InvalidMandate()` (`maxPerTx > dailyCap`, or
    `validUntil != 0 && validUntil <= block.timestamp`). Replaces any existing mandate; the
    amount already spent today still counts. Event
    `MandateOpened(agentId, wallet, token, dailyCap, maxPerTx, validUntil, restrictPayees, version)`.
  - `closeMandate(agentId)`: `NoMandate(agentId, wallet)` when none is active; otherwise clears
    the terms and emits `MandateClosed(agentId, wallet, version)`.
  - Version: a per-(agentId, wallet) counter bumped by every open and every close (first open
    = 1; open, close, open = 1, 2, 3). It lives in its own mapping, so a close + re-open never
    reuses a version.
  - View `mandates(agentId, wallet) -> (token, dailyCap, maxPerTx, validUntil, restrictPayees, version, active)`;
    a closed mandate reads `(0, 0, 0, 0, false, version, false)`.
  - Payees: `setPayee(agentId, payee, allowed)` (`ZeroRecipient` for payee 0; event
    `PayeeSet(agentId, wallet, payee, allowed)`), view `isPayee(agentId, wallet, payee)`. The
    list is the owner's address book: it survives close / re-open and is enforced only while the
    mandate has `restrictPayees`. Removing a payee also stops attestations already signed.
- `execute(GuardedTransfer t, bytes sig)` (non-reentrant, callable by any relayer) checks, in
  order:
  1. attestation: `AttestationExpired` (`block.timestamp > deadline`), `NonceUsed` (nonces are
     global to the guard), `ActionAlreadyExecuted(actionHash)` (one Fuku action => at most one
     transfer, even with a fresh nonce), `BadAttestation` (65-byte signature only, low-s, `v`
     27/28, `ecrecover` of the EIP-712 digest for this chain and this guard must equal
     `complianceSigner`);
  2. agent and policy: `AgentNotFound` / `AgentNotActive` (Registered and Active pass; Paused
     and Revoked fail), `PolicyNotActive` / `PolicyMismatch` (on-chain `policyHash` must equal
     `t.policyHash`);
  3. mandate: `NoMandate`, `TokenNotMandated`, `StaleMandate(current, attested)`
     (`t.mandateVersion` must equal the mandate's `version`), `MandateExpired(validUntil)`,
     `ZeroAmount` / `ZeroRecipient`, `PerTxLimitExceeded(maxPerTx)`,
     `PayeeNotApproved(payee)` (only with `restrictPayees`), `DailyCapExceeded(remaining)` (per
     agent, wallet and UTC day `block.timestamp / 1 days`).

  It then marks the nonce and the action as used, adds to the day's spend, calls
  `token.transferFrom(from, to, amount)` (tokens that return nothing are accepted; a failing
  token's revert data, such as `ComplianceRejected`, is bubbled unchanged and nothing is
  consumed), calls `PermissionRegistry.recordDecision(agentId, actionHash, true, proofHash, "R6")`
  and emits
  `GuardedTransferExecuted(agentId, from, to, token, amount, actionHash, proofHash, complianceRef, mandateVersion, nonce)`.
- Supersession: `bumpValidAfter(agentId)` (the agent's owner controller or a PermissionRegistry
  enforcer) voids every attestation for the agent issued at or before that block;
  `bumpWalletValidAfter(agentId, wallet)` (the wallet itself or an enforcer) does the same for one
  funding wallet. Both emit `ValidAfterBumped`. `setMaxAttestationTtl(ttl)` (owner, 10 s to 1 h,
  default 60 s) caps `deadline - issuedAt`.
- Views: `spentToday(agentId, wallet)`, `hashTransfer(t)` (full EIP-712 digest),
  `domainSeparator()`, `nonceUsed(nonce)`, `actionExecuted(actionHash)`,
  `isPayee(agentId, wallet, payee)`, `agentValidAfter(agentId)`,
  `walletValidAfter(agentId, wallet)`, `maxAttestationTtl()`, `GUARDED_TRANSFER_TYPEHASH`.

EIP-712, as signed by the compliance signer (viem `signTypedData` with exactly these values;
`test/FukuSpendGuard.test.ts` checks `hashTransfer` against viem `hashTypedData`).
`mandateVersion` is the `version` that `mandates(agentId, from)` returns when the attestation is
issued. `issuedAt` is the block time it was issued at: it must be later than both `validAfter`
values, at most 5 s ahead of block time, and at most `maxAttestationTtl` before `deadline`. The
struct gained `mandateVersion` and then `issuedAt` before any public deployment; a signer still
using older types gets `BadAttestation`.

```ts
const domain = { name: "FukuSpendGuard", version: "1", chainId, verifyingContract: guardAddress };
const types = {
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
    { name: "issuedAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
// typehash: GuardedTransfer(bytes32 agentId,address from,address to,address token,uint256 amount,bytes32 policyHash,bytes32 actionHash,bytes32 proofHash,bytes32 complianceRef,uint64 mandateVersion,uint256 nonce,uint64 issuedAt,uint64 deadline)
```

### Deploying them

- Fresh stack: `scripts/deploy.ts` deploys them after the registries (see above).
- Existing stack: `scripts/deploy-cleanverse.ts` reads `deployments/<network>.json`, checks
  the chain id, that `AgentRegistry` / `PermissionRegistry` have code on chain and that the
  signer owns `PermissionRegistry`, deploys **only** the three new contracts against the
  existing registries, grants the guard the enforcer role, and writes the three addresses and
  `complianceSigner` back into the same file (other fields kept). Re-running it replaces them
  and revokes the previous guard's enforcer role. `FUKU_DEPLOYMENT_FILE=<path>` targets a
  different file.

```bash
npm run deploy:cleanverse:local   # hardhat run scripts/deploy-cleanverse.ts --network localhost
npm run deploy:cleanverse:monad   # hardhat run scripts/deploy-cleanverse.ts --network monadTestnet
```

The compliance signer is `COMPLIANCE_SIGNER_ADDRESS` (`.env` or environment). If it is unset,
the deployer is used and a loud warning is printed; rotate later with
`setComplianceSigner`. The matching private key goes in `FUKU_COMPLIANCE_SIGNER_KEY` for
`wire:env` to copy into `web/.env`. On localhost the convention is account #1 (see the
account table under [Rehearse against a local node](#rehearse-against-a-local-node-optional)).

The deploy step does not issue A-Passes, mint aUSDC-SIM or open mandates; that demo setup
(for example for account #2 on localhost) is left to the caller.

## ABIs

After compiling, export ABIs for the web app / SDK:

```bash
npm run export-abi     # node scripts/export-abi.mjs
```

This writes:

- `abi/HumanIdentityRegistry.json`, `abi/AgentRegistry.json`,
  `abi/PermissionRegistry.json`, `abi/ReputationRegistry.json`,
  `abi/CleanverseAPassSim.json`, `abi/CleanverseATokenSim.json`,
  `abi/FukuSpendGuard.json` — plain ABI arrays (the simulators' artifacts come from
  `artifacts/contracts/sim/`)
- `abi/index.ts` — `as const` exports for viem / wagmi:

```ts
import { AgentRegistryAbi, PermissionRegistryAbi, FukuAbis } from "../contracts/abi/index.ts";

const agent = getContract({ address, abi: AgentRegistryAbi, client });
```

Exported names: `HumanIdentityRegistryAbi`, `AgentRegistryAbi`, `PermissionRegistryAbi`,
`ReputationRegistryAbi`, `CleanverseAPassSimAbi`, `CleanverseATokenSimAbi`,
`FukuSpendGuardAbi`, plus the `FukuAbis` map and the `FukuContractName` type. The same
exports are also written to `../web/src/lib/chain/abi.ts` (set `FUKU_WEB_ABI_PATH=skip` to
skip that copy).

Re-run the export whenever a contract interface changes; `abi/` is committed so
consumers do not need to compile.

## Layout

```
contracts/
  contracts/            Solidity sources (registries, FukuSpendGuard)
  contracts/sim/        Cleanverse simulators (CleanverseAPassSim, CleanverseATokenSim)
  test/                 node:test suites + fixtures.ts (deployFukuStack, deployCleanverseStack)
  scripts/check-deployer.mjs   pre-flight: address, chain id, MON balance (npm run check:deployer)
  scripts/deploy.ts            deploy + role grants + deployments/<network>.json
  scripts/deploy-cleanverse.ts add only the Cleanverse sims + guard to an existing deployment
  scripts/lib/cleanverse.ts    shared deploy step for the sims + guard
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
