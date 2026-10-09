# Fuku Protocol

Human-backed AI agent trust infrastructure on Monad. Fuku binds every agent to a passkey-verified owner, evaluates each action against a permission passport the owner approved, enforces the owner's limits on-chain when an agent moves money, and keeps an explainable reputation. What is enforced on-chain, what is enforced by Fuku's server, and what the server can still do on its own are listed in [`docs/SECURITY.md`](docs/SECURITY.md).

```
web/        Next.js 16 app: landing, dashboard, identity, agents, permissions, reputation,
            activity, memory vault, developer console + the API (session and public v1)
contracts/  Solidity for Monad (Hardhat 3): HumanIdentityRegistry, AgentRegistry,
            PermissionRegistry, ReputationRegistry, FukuSpendGuard (owner-bounded mandates),
            and the Cleanverse simulators CleanverseAPassSim / CleanverseATokenSim — 72 passing tests
sdk/        @fuku/sdk 0.5.0 — createIdentity, registerAgent, verifyAgent, requestPermission,
            getTrustScore, checkPermission, executeAction (signed with the agent's own key),
            getAction, getMandate, verifyScore, createAgentKey (keys bound to one agent)
mcp/        @fuku/mcp — MCP server: Claude Desktop or Claude Code acts as a Fuku agent (stdio)
examples/   sdk-consumer: an external program using only the SDK, verifying results on-chain
docs/       PITCH.md (talk track, status, judge Q&A), CLEANVERSE.md (CVI/CVA integration),
            SECURITY.md (authorization, lifecycle, trust assumptions, runbooks)
indexer/    Envio HyperIndex config + handlers for the on-chain events (real Monad addresses)
cre/        Chainlink CRE workflow fuku-guard (request -> verify -> execute -> record on Monad)
Fuku UI mockups/  Design source (Claude Design exports) and the product specs
```

## Run it

```bash
npm install                 # installs web, sdk and mcp (npm workspaces)
cd web
npx prisma db push          # creates web/prisma/dev.db (SQLite); run it again after pulling schema changes
npm run db:seed             # seeds Ava Chen, 5 agents, activity, vault items, demo API key
npm run dev -- -p 3001      # http://localhost:3001
```

`web/.env` is pre-filled for local dev; see `web/.env.example` for every option.

Contracts (standalone, own `node_modules`):

```bash
cd contracts && npm install && npm test        # 72 passing
```

Web tests (`cd web && npm test`, node:test via tsx) cover the permission engine, the Cleanverse module, authorization (cross-owner calls, delegations, invalid keys), atomic budgets, idempotency, reputation farming and wallet binding against a throwaway database. `npm test` at the root also runs the SDK's contract tests. The end-to-end proof on a local chain is `web/scripts/live-smoke.mjs` (67 checks; 66 on Monad testnet, where the reorg check cannot run) and `examples/sdk-consumer`.

Without a deployment the web app runs in **mock settlement** mode: every decision is still hashed and gets a deterministic receipt, so the full flow works offline. To anchor real transactions, see the next section.

## Deployments (Monad testnet, chain 10143)

All seven contracts are live on Monad testnet. Their sources are verified on Sourcify (exact match), which MonadVision reads. The addresses are in [`contracts/deployments/monadTestnet.json`](contracts/deployments/monadTestnet.json). Every transaction of the 2026-09-30 run is listed in [`docs/CLEANVERSE.md`](docs/CLEANVERSE.md#on-monad-testnet-2026-09-30).

| Contract | Address | Deployed |
| --- | --- | --- |
| HumanIdentityRegistry | [`0x9fe852bddcb71b765af9ca1b8390d9ccfe024a2b`](https://testnet.monadvision.com/address/0x9fe852bddcb71b765af9ca1b8390d9ccfe024a2b) | 2026-09-24 |
| AgentRegistry | [`0x41a176a946ab83cd26cfad4f07e6afdf61475e29`](https://testnet.monadvision.com/address/0x41a176a946ab83cd26cfad4f07e6afdf61475e29) | 2026-09-24 |
| PermissionRegistry | [`0xfe5caf3a4521ead0c8dce0f851461cdc072746cc`](https://testnet.monadvision.com/address/0xfe5caf3a4521ead0c8dce0f851461cdc072746cc) | 2026-09-24 |
| ReputationRegistry | [`0x33a216af5621adab5a10aef7f538db4ff3d4efad`](https://testnet.monadvision.com/address/0x33a216af5621adab5a10aef7f538db4ff3d4efad) | 2026-09-24 |
| FukuSpendGuard | [`0x3d5d3d38362fcb9ecc26250867cc3f30c99746dc`](https://testnet.monadvision.com/address/0x3d5d3d38362fcb9ecc26250867cc3f30c99746dc) | 2026-09-30 |
| CleanverseAPassSim (Fuku's simulator, not Cleanverse) | [`0x0607ba109cf19e0ca3b8d6606a142b38c61fc579`](https://testnet.monadvision.com/address/0x0607ba109cf19e0ca3b8d6606a142b38c61fc579) | 2026-09-30 |
| CleanverseATokenSim, aUSDC-SIM (Fuku's simulator, not Cleanverse) | [`0xb67038fc577315f0646fc4d1b84ee2d428878a14`](https://testnet.monadvision.com/address/0xb67038fc577315f0646fc4d1b84ee2d428878a14) | 2026-09-30 |

Accounts:
- The relayer [`0x248a9ACA0146b0112f102455fbc11B45338fD3DE`](https://testnet.monadvision.com/address/0x248a9ACA0146b0112f102455fbc11B45338fD3DE) owns the registries and is their enforcer and scorer.
- FukuSpendGuard accepts attestations only from the compliance signer [`0xE50e45a4102B8d625b10793d1698A3d53810F62E`](https://testnet.monadvision.com/address/0xE50e45a4102B8d625b10793d1698A3d53810F62E).
- Ava's custodial demo wallet is [`0x41Db346C3471818c47792eD5C57728923CE1DFFc`](https://testnet.monadvision.com/address/0x41Db346C3471818c47792eD5C57728923CE1DFFc).

**ERC-8004.** The five seeded demo agents are registered on the canonical ERC-8004 Identity Registry on Monad testnet, [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.monadvision.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) (`getVersion()` 2.0.0).
- Each agent NFT is owned by Ava's demo wallet.
- Each `agentWallet` is the agent's own key, which Fuku holds sealed.
- The agentURI is a `data:` URI holding the registration file. There is no public URL yet; `setAgentURI` can switch to one later.

| Agent | Fuku agent id | ERC-8004 agent id | agentWallet |
| --- | --- | --- | --- |
| Trading Assistant | `fuku:agent:0xb6b1bec4676f0fa730a4a7f9316e33ce604729ac` | 1955 | `0x5e76F33C8F896946690Ed070195FE16120a53F1C` |
| Research Agent | `fuku:agent:0xe778f6077fb9615564ee27c631065cec50b89151` | 1956 | `0xF1AF9865F69705aE67250A0148A68334601EdC21` |
| Payments Agent | `fuku:agent:0x0e0acd52d5c78ee77274a6604717693214c34838` | 1957 | `0x526b436E4c069E3515b0517C26938ece0B93A96D` |
| Ops Scheduler | `fuku:agent:0x45edacaef93036f9e9a0831b08db4212eacc8e88` | 1958 | `0x8B97339F86bCc34ecB5ECCC6d143c8A10EE5B594` |
| Portfolio Rebalancer | `fuku:agent:0xc08cd9a25f55692b8476cd0893d669b542f3e969` | 1959 | `0xAfAA1fe0Ad9e85f0939641fAeC82761e78409B07` |
| MCP Assistant | `fuku:agent:0x367168b5752479508c6851576c6fb2ece23bda90` | 1963 | `0x2d9E18519fF81959CB9b5Ed8AaB73cECC9E2beB8` |

The first five are demo cohort `v2`. After a live climax, `npm run demo:cohort` registers a fresh cohort under new ids; this table stays the record of `v2`.

The MCP Assistant (registered 2026-10-01) is the agent an AI assistant acts as through the Fuku MCP server. Its key is not held by Fuku: it was generated on the operator's machine and stays in `mcp/.env`. A demo reset keeps it. Its transactions are in [`docs/CLEANVERSE.md`](docs/CLEANVERSE.md#the-mcp-assistant-and-the-signed-execution-checks-on-monad-testnet-2026-10-01).

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
npm run wire:env         # timestamped backup of web/.env, then upserts the live settings
```

`wire:env` writes `FUKU_CHAIN_MODE=live`, `FUKU_CHAIN_ID=10143`, `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and the four `FUKU_*_REGISTRY` addresses into `web/.env`, replacing lines in place and leaving everything else alone (`--dry-run` previews with secrets masked, `--env <path>` targets another file). It never replaces a different key already in `web/.env` unless given `--replace-keys`, and it writes a new timestamped backup (`web/.env.bak-<time>`) before each change. **Restart the web app** afterwards (`Ctrl+C`, `cd web && npm run dev -- -p 3001`): Next.js reads `.env` at start.

**Confirm it is live**

- `curl -s http://localhost:3001/api/integrations` shows `"chain": { "mode": "live", ... "signer": "0x<your deployer>" }`, and the Monad card on the Developer Console integration board reads **live** ("Transactions are signed and anchored on Monad testnet") instead of **simulated**.
- Run an action (Dashboard -> **Run agent action**, or `POST /api/agents/:id/actions`): the receipt shows `"mode": "live"`, a real `txHash` and an explorer link (`testnet.monadexplorer.com` redirects to `testnet.monadvision.com`). `GET /api/v1/agents/:id` with your bearer key includes `"chain": "live"`.
- If `web/scripts/live-smoke.mjs` is present in your checkout, it runs the whole demo flow through the API and then re-reads the registries on-chain: from `web/`, `FUKU_BASE_URL=http://localhost:3001 MONAD_RPC_URL=https://testnet-rpc.monad.xyz FUKU_DEPLOYMENT_FILE=../contracts/deployments/monadTestnet.json node scripts/live-smoke.mjs` (exit 0 = every check passed; 66/66 against Monad testnet on 2026-09-30).

**Monad testnet facts (verified 2026-09-23)**

| Item | Value | Source |
| --- | --- | --- |
| Chain id | 10143 (`0x279f`) | [Monad docs: testnet](https://docs.monad.xyz/developer-essentials/testnet), [chainlist](https://chainlist.org/chain/10143); a live `eth_chainId` against the public RPC returned `0x279f` |
| RPC | `https://testnet-rpc.monad.xyz` (public). Alternates from the docs: `https://rpc.ankr.com/monad_testnet`, `https://rpc-testnet.monadinfra.com` | same docs page; live `eth_blockNumber` = 64,915,243 at verification time |
| Explorer | `https://testnet.monadvision.com`, `https://testnet.monadscan.com`; `https://testnet.monadexplorer.com` (the app default) 308-redirects to monadvision | [docs: block explorers](https://docs.monad.xyz/tooling-and-infra/block-explorers); `curl -I` |
| Faucet | `https://faucet.monad.xyz` (named by the docs). It sits behind a bot check (HTTP 429 to scripts), so its current per-claim amount and cooldown could not be read directly; open it in a browser and follow the rules it shows. Alternatives: [QuickNode](https://faucet.quicknode.com/monad/testnet), [Alchemy](https://www.alchemy.com/faucets/monad-testnet), [Chainlink](https://faucets.chain.link/monad-testnet) | [docs: testnet](https://docs.monad.xyz/developer-essentials/testnet) names the faucet; the alternative faucet pages answered HTTP 200 |
| Notice | Docs: testnet was **reset from genesis on 2025-12-16**. Mainnet is chain 143 (`https://rpc.monad.xyz`, real MON): never point `MONAD_RPC_URL` there | [docs: testnet](https://docs.monad.xyz/developer-essentials/testnet), [docs: mainnet](https://docs.monad.xyz/developer-essentials/network-information) |

**Troubleshooting**

- **Insufficient funds**: the deployer ran out of MON (a full deploy is ten transactions). Top up at the faucet; `npm run check:deployer` shows the balance.
- **Wrong chain id**: `MONAD_RPC_URL` points at mainnet (143), a local node (31337) or a stale endpoint; `hardhat.config.ts` pins 10143. `check:deployer` reports the id the RPC returns.
- **RPC rate limits** (HTTP 429, timeouts on the public endpoint): use a dedicated endpoint, set `MONAD_RPC_URL` in `contracts/.env`, re-run `wire:env`, restart. A failed live write is recorded as `failed` (never as a mock receipt) with a `[fuku-chain]` log line, and `npm run reconcile` retries decision anchors and settles pending transfers. Guarded transfers and the on-chain kill switch surface failures directly: HTTP 502 or `chainSync.ok: false`.
- **`NotIdentityController`**: the signer in `web/.env` is not the controller recorded on-chain for that identity (`AgentRegistry.registerAgent` requires `msg.sender == controllerOf(ownerIdentityId)`). Use the key that anchored the identity, or redeploy fresh registries (`deploy:monad` + `wire:env`) so everything re-anchors with the current key.
- **`NotAuthorized` / `NotScorer`**: the signer is not the deployer (who was granted enforcer + scorer). Sign with the deployer key, or grant the roles from the owner.
- **Still "simulated" after wiring**: the server logs `[fuku-chain] FUKU_CHAIN_MODE=live but DEPLOYER_PRIVATE_KEY or a FUKU_*_REGISTRY address is missing`; run `npm run wire:env -- --dry-run`, fix, re-run, restart.

## Three-minute demo

1. Open `/sign-in`. Either **Create with passkey** (real WebAuthn with user verification) or **Try the demo as Ava Chen** (development only, or `FUKU_DEMO_ENABLED=true`).
2. **Dashboard**: identity card, trust score, agents, permission status, recent activity.
3. **Register agent** (top right): give it a name and capabilities. It is registered on the Monad registry and lands on the Permissions page.
4. **Permissions**: approve a passport (allow / limit / block per capability, app scope). The agent becomes active; the passport hash is anchored.
5. **Test an action** on the Permissions page, or go back to the Dashboard and press **Run agent action**: Trading Assistant tries to withdraw 4,800 USDC.
6. Fuku blocks it (rule R2), shows the workflow trace, the decision hash and the Monad receipt, and explains why in plain language.
7. **Pay a verified supplier** (Dashboard): Payments Agent sends 250 aUSDC to Nusantara Supplies. Fuku checks the asset rule and both A-Passes (Cleanverse simulator until the API invite lands), then FukuSpendGuard moves the token under the owner's on-chain mandate. Pick the Frozen or Unverified wallet in the Run action form to see R8.
8. **Reputation**: the score drops (96 → 92) with a breakdown and an explanation. **Activity** shows the proof.

The Developer Console has API keys, the SDK reference, a sandbox that runs the same flow through the public API, and the sponsor integration board (live vs simulated per env var).

## Use Fuku from an AI assistant (MCP)

`mcp/` is an MCP server, and it makes a real AI assistant a Fuku agent. In Claude Desktop or Claude Code, the assistant holds its own agent key and sends every action through Fuku. Its owner's passport then decides:
- Fuku allows the action, or blocks it with a rule id;
- or Fuku pays through FukuSpendGuard on Monad, inside the owner's on-chain mandate.

A blocked action comes back to the assistant as a normal result: the rule, the reason and the anchored proof, which it reports to the user. Fuku executes this agent over the API only when the request is signed with its own key, which never leaves your machine.

```bash
npm run mcp:build    # sdk/dist + mcp/dist
npm run mcp:setup    # "MCP Assistant" under Ava: key in mcp/.env, passport, mandate; prints the client config
```

Setup, the Claude Desktop and Claude Code configuration, and troubleshooting are in [`mcp/README.md`](mcp/README.md).

## How trust is computed

Permission engine (`web/src/lib/engine/permission.ts`), deterministic and rule-attributed:

| Rule | Outcome |
| --- | --- |
| R0 agent not active | blocked |
| R1 no active passport | blocked (deny by default) |
| R2 action on the block list | blocked |
| R3 action not on the allow list | blocked |
| R4 app outside the passport scope, or missing when the passport is scoped | blocked |
| R11 value action and the owner has no passkey verification | blocked |
| R12 value action with a missing or invalid amount (6 decimals max) or recipient, or a passport rule without a daily limit | blocked |
| R9 A-Token passports: asset not on the passport or not a Cleanverse A-Token | blocked |
| R7 A-Token passports: owner has no active, unexpired A-Pass, or verify_apass ≠ 4 | blocked |
| R8 A-Token passports: recipient fails verify_apass | blocked |
| R5 daily USDC limit exceeded (UTC day, base units, reserved atomically) | blocked |
| R6 | allowed |
| R10 A-Token transfers: the on-chain FukuSpendGuard would revert | blocked |

Rules run in the order shown. R11 and R12 apply to value actions; R9, R7 and R8 only to value actions on passports that list A-Tokens. Cleanverse failures fail closed and carry a sub-code (for example `CVI_FROZEN`). An allowed action that Fuku does not execute itself is recorded as AUTHORIZED; an A-Token transfer goes through the lifecycle SUBMITTED → CONFIRMED (or PENDING, FAILED), see `docs/SECURITY.md`.

Trust score (`web/src/lib/engine/reputation.ts`, fuku-score/2): 40 baseline, +10 passkey-verified owner, +10 Cleanverse A-Pass on the owner's verified wallet, +5 active passport, +2.5 per completed action (max +35), −4 per violation (max −40), −10 per security event. Bounded 0–100; High ≥ 85, Medium ≥ 60.

- Only a transfer confirmed on-chain counts as a completed action, once per action.
- Allowed decisions Fuku does not execute, dry runs, mock settlements and reads earn nothing.
- Blocks caused by the owner or the infrastructure are neutral.
- The report includes dimensions, evidence count, observation period and uncertainty.

Every action runs the same workflow: request → owner verified → passport evaluated → execute or block → proof anchored on Monad → reputation updated → explanation generated (Kimi/Qwen when keys are set, otherwise a rule-based narrator).

## Security, in one paragraph

Every client (web app, SDK, CRE) goes through one authorization path: an agent's owner, an identity the caller created, or an owner-granted delegation with scopes. An invalid API key is a 401, never a session fallback. Passkeys require user verification on pinned origins. Wallet control is proven by signature or a verified Dynamic credential. Value actions need a passkey-verified owner, a complete request and a daily limit that is reserved atomically. Repeated requests with one `Idempotency-Key` replay. Live chain failures are recorded as failed or pending and reconciled, never shown as mock successes. What the server can still do on its own (it owns the registries and controls every identity on-chain) is spelled out in [`docs/SECURITY.md`](docs/SECURITY.md).

## Cleanverse A-Token payments

A passport that lists A-Tokens (`assets: ["aUSDC"]`) lets its agent `transfer` only after Cleanverse checks: the asset rule, the owner's A-Pass and the recipient's A-Pass. Fuku's compliance signer then attests to that exact transfer (EIP-712), and `FukuSpendGuard` moves the token from the owner's wallet. The owner's own wallet opened a mandate (token, UTC daily cap, per-transfer limit, expiry, approved payees) and approved the guard. The guard checks it, the agent's status and the current passport hash on-chain, executes each action at most once, and records the decision in the same transaction.

The live Cleanverse API is invite-only and has not been called yet. Until then a Fuku-built simulator answers (`CleanverseAPassSim` / `CleanverseATokenSim` on a live chain, DB fixtures in mock mode), labelled "Cleanverse simulator" in the UI and `mode: "simulated"` in the SDK. Modes, env vars, the API contract and its provenance, the local run, the flip-to-live checklist and the open questions are in [`docs/CLEANVERSE.md`](docs/CLEANVERSE.md).

## Sponsor stack

Monad (settlement), Dynamic (email sign-in with an embedded EVM wallet; the server verifies Dynamic's JWT), Nansen (behavioural intelligence; the free `account` endpoint drives the status card, wallet labels cost 100 Nansen credits per lookup and are cached for a day), Envio (HyperSync indexes the Fuku registries on Monad for Activity → On-chain; HyperRPC verifies each decision's proof hash; HyperIndex config in `/indexer`), Kimi and Qwen (trust explanations), Chainlink CRE (`cre/fuku-guard`: HTTP-triggered workflow that verifies an agent through the Fuku API, executes the action, then reads the Monad registries through the DON; simulated end to end with `cre workflow simulate`; DON deployment requires a commercial agreement with Chainlink, see `cre/README.md`), Cleanverse (A-Pass and A-Token checks before an agent moves value; simulated until the API invite lands, see `docs/CLEANVERSE.md`). Each integration reports its mode in the Developer Console.
