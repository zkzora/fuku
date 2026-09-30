# Fuku Protocol

Human-backed AI agent trust infrastructure on Monad. Fuku gives humans and AI agents portable identity, programmable permissions and verifiable reputation so autonomous systems can operate safely without centralized control.

```
web/        Next.js 16 app: landing, dashboard, identity, agents, permissions, reputation,
            activity, memory vault, developer console + the API (session and public v1)
contracts/  Solidity registries for Monad (Hardhat 3): HumanIdentityRegistry, AgentRegistry,
            PermissionRegistry, ReputationRegistry — 18 passing tests
sdk/        @fuku/sdk — createIdentity, registerAgent, verifyAgent, requestPermission,
            getTrustScore, checkPermission, executeAction
indexer/    Envio HyperIndex config + handlers for the on-chain events (real Monad addresses)
cre/        Chainlink CRE workflow fuku-guard (request -> verify -> execute -> record on Monad)
Fuku UI mockups/  Design source (Claude Design exports) and the product specs
```

## Run it

```bash
npm install                 # installs web + sdk (npm workspaces)
cd web
npx prisma db push          # creates web/prisma/dev.db (SQLite)
npm run db:seed             # seeds Ava Chen, 4 agents, activity, vault items, demo API key
npm run dev -- -p 3001      # http://localhost:3001
```

`web/.env` is pre-filled for local dev; see `web/.env.example` for every option.

Contracts (standalone, own `node_modules`):

```bash
cd contracts && npm install && npm test        # 18 passing
```

Without a deployment the web app runs in **mock settlement** mode: every decision is still hashed and gets a deterministic receipt, so the full flow works offline. To anchor real transactions, see the next section.

## Go live on Monad testnet

You need exactly one thing: a private key holding some testnet MON. Then it is three commands from `contracts/`. Full detail, including what each script does, lives in [`contracts/README.md`](contracts/README.md#go-live-on-monad-testnet-chainid-10143).

**0. One time: key + faucet.** Generate a throwaway key (never reuse a mainnet key), or export one from MetaMask (Account details -> Show private key):

```bash
cd contracts
node -e "import('viem/accounts').then(a=>{const k=a.generatePrivateKey();console.log(k, a.privateKeyToAccount(k).address)})"
```

Paste the printed address into the faucet at <https://faucet.monad.xyz>, then create `contracts/.env`:

```
DEPLOYER_PRIVATE_KEY=0x...                      # 0x + 64 hex characters
MONAD_RPC_URL=https://testnet-rpc.monad.xyz     # public endpoint (optional; this is the default)
```

**1, 2, 3.**

```bash
npm run check:deployer   # prints address, chain id (10143) and MON balance; exits 1 with a hint if unfunded
npm run deploy:monad     # deploys the 4 registries, grants roles, writes deployments/monadTestnet.json
npm run wire:env         # backs up web/.env to web/.env.bak and upserts the live settings
```

`wire:env` writes `FUKU_CHAIN_MODE=live`, `FUKU_CHAIN_ID=10143`, `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and the four `FUKU_*_REGISTRY` addresses into `web/.env`, replacing lines in place and leaving everything else alone (`--dry-run` previews with the key masked, `--env <path>` targets another file). **Restart the web app** afterwards (`Ctrl+C`, `cd web && npm run dev -- -p 3001`): Next.js reads `.env` at start.

**Confirm it is live**

- `curl -s http://localhost:3001/api/integrations` shows `"chain": { "mode": "live", ... "signer": "0x<your deployer>" }`, and the Monad card on the Developer Console integration board reads **live** ("Transactions are signed and anchored on Monad testnet") instead of **simulated**.
- Run an action (Dashboard -> **Run agent action**, or `POST /api/agents/:id/actions`): the receipt shows `"mode": "live"`, a real `txHash` and an explorer link (`testnet.monadexplorer.com` redirects to `testnet.monadvision.com`). `GET /api/v1/agents/:id` with your bearer key includes `"chain": "live"`.
- If `web/scripts/live-smoke.mjs` is present in your checkout, it runs the whole demo flow through the API and then re-reads the registries on-chain: from `web/`, `FUKU_BASE_URL=http://localhost:3001 MONAD_RPC_URL=https://testnet-rpc.monad.xyz FUKU_DEPLOYMENT_FILE=../contracts/deployments/monadTestnet.json node scripts/live-smoke.mjs` (exit 0 = every check passed).

**Monad testnet facts (verified 2026-09-23)**

| Item | Value | Source |
| --- | --- | --- |
| Chain id | 10143 (`0x279f`) | [Monad docs: testnet](https://docs.monad.xyz/developer-essentials/testnet), [chainlist](https://chainlist.org/chain/10143); a live `eth_chainId` against the public RPC returned `0x279f` |
| RPC | `https://testnet-rpc.monad.xyz` (public). Alternates from the docs: `https://rpc.ankr.com/monad_testnet`, `https://rpc-testnet.monadinfra.com` | same docs page; live `eth_blockNumber` = 64,915,243 at verification time |
| Explorer | `https://testnet.monadvision.com`, `https://testnet.monadscan.com`; `https://testnet.monadexplorer.com` (the app default) 308-redirects to monadvision | [docs: block explorers](https://docs.monad.xyz/tooling-and-infra/block-explorers); `curl -I` |
| Faucet | `https://faucet.monad.xyz` (named by the docs). It sits behind a bot check (HTTP 429 to scripts), so its current per-claim amount and cooldown could not be read directly; open it in a browser and follow the rules it shows. Alternatives: [QuickNode](https://faucet.quicknode.com/monad/testnet), [Alchemy](https://www.alchemy.com/faucets/monad-testnet), [Chainlink](https://faucets.chain.link/monad-testnet) | [docs: testnet](https://docs.monad.xyz/developer-essentials/testnet) names the faucet; the alternative faucet pages answered HTTP 200 |
| Notice | Docs: testnet was **reset from genesis on 2025-12-16**. Mainnet is chain 143 (`https://rpc.monad.xyz`, real MON): never point `MONAD_RPC_URL` there | [docs: testnet](https://docs.monad.xyz/developer-essentials/testnet), [docs: mainnet](https://docs.monad.xyz/developer-essentials/network-information) |

**Troubleshooting**

- **Insufficient funds**: the deployer ran out of MON (a deploy is six transactions). Top up at the faucet; `npm run check:deployer` shows the balance.
- **Wrong chain id**: `MONAD_RPC_URL` points at mainnet (143), a local node (31337) or a stale endpoint; `hardhat.config.ts` pins 10143. `check:deployer` reports the id the RPC returns.
- **RPC rate limits** (HTTP 429, timeouts on the public endpoint): use a dedicated endpoint, set `MONAD_RPC_URL` in `contracts/.env`, re-run `wire:env`, restart. A failed live write is recorded as a mock receipt with a `Live settlement failed (...)` note and a `[fuku-chain]` log line.
- **`NotIdentityController`**: the signer in `web/.env` is not the controller recorded on-chain for that identity (`AgentRegistry.registerAgent` requires `msg.sender == controllerOf(ownerIdentityId)`). Use the key that anchored the identity, or redeploy fresh registries (`deploy:monad` + `wire:env`) so everything re-anchors with the current key.
- **`NotAuthorized` / `NotScorer`**: the signer is not the deployer (who was granted enforcer + scorer). Sign with the deployer key, or grant the roles from the owner.
- **Still "simulated" after wiring**: the server logs `[fuku-chain] FUKU_CHAIN_MODE=live but DEPLOYER_PRIVATE_KEY or a FUKU_*_REGISTRY address is missing`; run `npm run wire:env -- --dry-run`, fix, re-run, restart.

## Three-minute demo

1. Open `/sign-in`. Either **Create with passkey** (real WebAuthn, human-verified identity) or **Try the demo as Ava Chen**.
2. **Dashboard**: identity card, trust score, agents, permission status, recent activity.
3. **Register agent** (top right): give it a name and capabilities. It is registered on the Monad registry and lands on the Permissions page.
4. **Permissions**: approve a passport (allow / limit / block per capability, app scope). The agent becomes active; the passport hash is anchored.
5. **Test an action** on the Permissions page, or go back to the Dashboard and press **Run agent action**: Trading Assistant tries to withdraw 4,800 USDC.
6. Fuku blocks it (rule R2), shows the workflow trace, the decision hash and the Monad receipt, and explains why in plain language.
7. **Reputation**: the score drops (96 → 92) with a breakdown and an explanation. **Activity** shows the proof.

The Developer Console has API keys, the SDK reference, a sandbox that runs the same flow through the public API, and the sponsor integration board (live vs simulated per env var).

## How trust is computed

Permission engine (`web/src/lib/engine/permission.ts`), deterministic and rule-attributed:

| Rule | Outcome |
| --- | --- |
| R0 agent not active | blocked |
| R1 no active passport | blocked (deny by default) |
| R2 action on the block list | blocked |
| R3 action not on the allow list | blocked |
| R4 app outside the passport scope | blocked |
| R5 daily USDC limit exceeded | blocked |
| R6 | allowed |

Trust score (`web/src/lib/engine/reputation.ts`): 40 baseline, +20 verified human owner, +5 active passport, +2.5 per successful action (max +35), −4 per violation (max −40), −10 per security event. Bounded 0–100; High ≥ 85, Medium ≥ 60.

Every action runs the same workflow: request → owner verified → passport evaluated → execute or block → proof anchored on Monad → reputation updated → explanation generated (Kimi/Qwen when keys are set, otherwise a rule-based narrator).

## Sponsor stack

Monad (settlement), Mera (passkey identity, WebAuthn), Dynamic (email sign-in with an embedded EVM wallet; the server verifies Dynamic's JWT), Privy (adapter card), Nansen (behavioural intelligence; the free `account` endpoint drives the status card, wallet labels cost 100 Nansen credits per lookup and are cached for a day), Envio (HyperSync indexes the Fuku registries on Monad for Activity → On-chain; HyperRPC verifies each decision's proof hash; HyperIndex config in `/indexer`), Kimi and Qwen (trust explanations), Chainlink CRE (`cre/fuku-guard`: HTTP-triggered workflow that verifies an agent through the Fuku API, executes the action, then reads the Monad registries through the DON; simulated end to end with `cre workflow simulate`; DON deployment requires a commercial agreement with Chainlink, see `cre/README.md`), Cleanverse (credentials). Each integration reports live or simulated in the Developer Console.
