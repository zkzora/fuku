# Fuku Protocol: Hackathon Pitch

Track: Trust, Identity & AI Infrastructure on Monad.
Audience: the judges, and the founder who delivers it.
Every claim below was checked against the code in this repository on 2026-09-30. Where something is simulated, this document says so. `docs/SECURITY.md` lists what the server can still do on its own; read it before answering trust questions.

---

## 1. One-liner and the 30-second version

**One-liner.** Fuku is the trust layer for AI agents on Monad: a passkey-verified owner, a permission passport that says what the agent may do, an on-chain guard that enforces the owner's limits when an agent moves money, and a portable trust score, with every decision hashed and anchored.

**30 seconds.**

"AI agents are starting to hold money, keys and calendars, and nobody can answer three questions about an agent: who is the human behind it, what is it allowed to do, and should I trust it. Fuku answers all three. A human creates an identity with a passkey. They register their agent and approve a permission passport: allowed actions, daily USDC limits, hard blocks, app scope. Every action the agent attempts runs through a deterministic engine that allows or blocks it with a rule id, anchors a proof on Monad, updates an explainable trust score and explains the outcome in plain language. Any application can verify an agent with one SDK call. Identity, permissions, reputation: one primitive, built on Monad."

Settlement status (2026-09-30): seven contracts are live on Monad testnet (chain 10143, `contracts/deployments/monadTestnet.json`), all with sources verified on Sourcify. The four registries have been there since 2026-09-24; FukuSpendGuard and the two Cleanverse simulators since 2026-09-30. The app runs in live mode, so "anchors a proof on Monad" is literally true, and every receipt links to a real transaction. The Cleanverse answers still come from Fuku's simulator (aUSDC-SIM), labelled as such. Keep the mock-mode substitutions in section 2 only as a contingency, for a deployer wallet out of MON or an RPC outage on the day. The full testnet record is at the end of section 4.

---

## 2. Three-minute talk track (synchronised with the live demo)

**Before you walk on.** Open `http://localhost:3001/api/auth/demo?reset=1&next=/sign-in` once. This reseeds Ava Chen so the Trading Assistant starts at 96, then lands on the sign-in page. Leave that tab open. The supplier-payment beat needs the Cleanverse simulator and FukuSpendGuard on the chain you present on, plus `npm run cleanverse:setup` once (section 4). On Monad testnet both are deployed and set up (2026-09-30). On another chain without them, the preset is blocked with R7 `PROVIDER_OFF`, so skip that beat. The same condition affects the score: 10 of the Trading Assistant's 96 points are Ava's Cleanverse A-Pass, so on a live chain with Cleanverse off the dashboard shows 86 (and 82 after the climax). Say those numbers instead, or present in mock mode, where the simulator fixtures answer. Spoken words below: 342, which leaves room to breathe. The lines are written for live settlement; if the Monad card still says simulated on the day, apply the four substitutions listed after the talk track.

### 0:00 to 0:15 · Sign in

**Click:** on `/sign-in`, press **Try the demo as Ava Chen**. (If Windows Hello is set up on this machine and you want a real WebAuthn ceremony, type a name and press **Create with passkey** instead. Only do this if you rehearsed it on this exact machine.)

**Say:** "AI agents are about to hold our money, and nobody can answer three questions about one: who is the human behind it, what is it allowed to do, and should I trust it. Fuku answers all three on Monad. Sign-in is a passkey ceremony; I'm taking the demo shortcut."

### 0:15 to 0:35 · Dashboard

**Click:** nothing. Point at the identity card, the trust ring (96), the Agents tile (5), and the Permission status list.

**Say:** "This is Ava. She owns five agents. Her Trading Assistant scores 96 and carries a passport: swap up to 5,000 USDC a day on Monad DEX, read balances, price feeds. Withdraw, transfer and change owner are hard-blocked. That passport is the product."

### 0:35 to 0:55 · Register an agent

**Click:** **Register agent** (top right). Name: `Support Agent`. Keep the default capabilities (Swap assets, Read balances). Press **Register agent**. You land on the Permission Manager with the new agent selected, status pill "Just registered", "No passport".

**Say:** "Registering an agent takes ten seconds. It gets a portable identity owned by Ava, and stays inactive until she approves a passport. Deny by default."

### 0:55 to 1:15 · Approve the passport

**Click:** the editor is prefilled: declared capabilities allowed, swap limited to 5,000 USDC a day, withdraw and change owner blocked. Type `Monad DEX` in the app scope field. Press **Approve passport**. The status pill flips to "active".

**Say:** "Allowed, limited, or blocked, per capability, plus an app scope. Approving hashes the policy and anchors the hash, and the agent goes active. The owner never writes code."

### 1:15 to 1:50 · Run the unauthorized action (the climax)

**Click:** sidebar **Dashboard**. In the card titled "Run an unauthorized action", press **Run agent action**. A result dialog opens. Leave it open while you talk.

**Say:** "Trading Assistant tries to withdraw 4,800 USDC. Every action runs the same workflow: request, owner verified, passport evaluated, execute or block, proof anchored on Monad, reputation, explanation. Blocked by rule R2: withdraw is hard-blocked. Here is the trace, the proof hash, the Monad receipt, and a plain-language explanation. Nothing left Ava's control."

### 1:50 to 2:20 · Pay a verified supplier (Cleanverse)

**Click:** close the dialog. In the card titled "Pay a verified supplier", press **Run agent action**. Point at the three Cleanverse checks, the "Cleanverse simulator" badge and the "Token moved via FukuSpendGuard" link.

**Say:** "Now money that should move. Payments Agent pays 250 aUSDC to Nusantara Supplies. Fuku checks the token rule and both A-Passes with Cleanverse, then FukuSpendGuard moves the token from Ava's wallet under her on-chain daily cap, in one transaction. A frozen recipient gets rule R8. Until our Cleanverse API invite lands, a labelled simulator answers these checks."

### 2:20 to 2:40 · Reputation

**Click:** close the dialog, sidebar **Reputation**. The Trading Assistant chip now reads 92. Point at the Score breakdown card.

**Say:** "The score moved from 96 to 92: 40 baseline, plus 10 for Ava's passkey and 10 for her Cleanverse A-Pass, plus 5 for an active passport, plus 35 for past actions, minus 4 per violation. Anyone can recompute it from the event log."

### 2:40 to 3:00 · Developer Console

**Click:** sidebar **Developer Console**. Press **Run demo flow** in the "Testing environment" card. Scroll to "Integration status".

**Say:** "Developers get all of this through one SDK: verify an agent, dry-run a permission, execute through Fuku, read the trust score. The sandbox ran that against the public API. And this board says what is live and what is simulated. Fuku: identity, permissions, reputation, on Monad."

### If settlement is still mock on the day

Four substitutions keep the spoken lines true. At 0:55, "anchors the hash" becomes "commits the hash for anchoring". At 1:15, "proof anchored on Monad" becomes "proof hashed for Monad", and "the Monad receipt" becomes "the receipt, mocked today; the contracts are written and tested, and the live path is one deploy away". At 1:50, "moves the token ... in one transaction" becomes "would move the token; today the receipt is mocked and nothing moves". The result dialog labels mock receipts itself, so never call them transactions.

---

## 3. Problem, insight, why now, why Monad

**Problem.** Agents are being given wallets, API keys and tool access. Today there is no reliable way to know the human behind an agent, no portable record of what it is allowed to do, and no reputation that follows it between applications. Every app that adopts agents rebuilds its own trust logic, and the user's context ends up owned by the platform, not the user.

**Insight.** Permissions are the product. Identity and reputation only matter when they are attached to an enforceable answer to "what may this agent do right now?". Fuku's unit of work is a decision: (agent, action, amount, app) evaluated against a passport, producing ALLOWED or BLOCKED with a rule id (R0 to R6), a proof hash and a receipt. The score, the explanation, the activity timeline and the indexer all derive from that decision log.

**Why now.** Passkeys ship in every mainstream browser and OS, so human verification no longer needs a KYC vendor to get started. Agent frameworks are giving models real spending power. ERC-8004 is defining what an agent identity looks like on EVM chains. And fast, cheap EVM execution makes it reasonable to write a proof per action instead of a summary per month.

**Why Monad.**
- Fuku writes a transaction per decision (`recordDecision`) and per score change (`updateScore`). A per-action proof log only makes sense on a chain built for high throughput and low cost per write. That is Monad's design goal, and it is why the contracts emit an event for every decision instead of batching.
- Monad is EVM-compatible, so the four Solidity registries deploy through Hardhat unchanged and the app talks to them with viem. No custom tooling.
- Fuku agents carry the standard agent identity, not a proprietary one. They are registered on ERC-8004's canonical Identity Registry on Monad testnet (`0x8004A818BFB912233c491871b3d84c89A494BD9e`): the five demo agents are #1955–#1959, and the agent `examples/sdk-consumer` registered with its own locally generated key is #1960. Any EVM application can resolve them with the standard's `ownerOf`, `tokenURI` and `getAgentWallet`.
- Illustrative scale, not a measurement: the seeded demo holds 25 decisions across one person's agents over one week. A fleet of agents acting for thousands of owners is thousands of decisions per day, each one an on-chain event.

---

## 4. Architecture in five lines, and the honest state of the build

1. **Identity.** A passkey (WebAuthn via `@simplewebauthn`, user verification required, origins pinned) creates a Fuku identity. The passkey public-key hash and a proof hash are anchored in `HumanIdentityRegistry`, and the flag Fuku still calls `humanVerified` is set on-chain in live mode. It means "a passkey ceremony with a PIN or biometric succeeded": not KYC, and not proof of a unique person. The owner wallet counts only once control is proven, through a verified Dynamic credential or a signed binding message.
2. **Agents.** `AgentRegistry` binds each agent to its owner identity: name, version, capabilities hash, metadata URI, status (Registered, Active, Paused, Revoked).
3. **Permissions.** A passport (allowed rules with optional daily USDC limits, a block list, scope apps, and optionally Cleanverse A-Tokens) is evaluated by a deterministic engine with rules R0 to R6, plus R7 to R10 for transfers on A-Token passports; the policy hash and version go to `PermissionRegistry`, and every decision emits `ActionDecision(agentId, actionHash, allowed, proofHash, ruleId)`. A-Token transfers move through `FukuSpendGuard`, which enforces on-chain the mandate the owner's own wallet opened (token, UTC daily cap, per-transfer limit, expiry, approved payees), the agent's status, the current passport hash and a single-use action hash. R11 blocks value actions for an owner without a passkey ceremony; R12 requires a complete request and a daily limit.
4. **Reputation (fuku-score/2).** Score = 40 baseline + 10 passkey-verified owner + 10 Cleanverse A-Pass on the owner's verified wallet + 5 active passport + 2.5 per completed action (max 35) minus 4 per violation (max 40) minus 10 per security event, clamped to 0 to 100. Only a transfer confirmed on-chain counts as a completed action from now on. Allowed decisions Fuku does not execute, dry runs, mock settlements and reads earn nothing; the seeded history keeps its legacy successes. The report adds dimensions, evidence count, observation period and uncertainty. The latest score is written to `ReputationRegistry` by an allow-listed scorer.
   - Verifiable by commit-reveal. Each anchored proof is the hash of a decision record Fuku keeps and reveals.
   - `npm run verify-score` (or **Recompute from chain** on the agent page) checks every record against the chain and recomputes the score from what checks out.
   - It lists what the chain does not commit to: security events, an A-Pass read through the Cleanverse API, the passkey ceremony itself, and the seeded history's completed actions (Fuku's own records under the old rules).
   - On a local node, after `npm run reconcile -- --anchor-seeded`, the Trading Assistant verifies at 96, and at 92 after the climax (16/16 records).
   - On Monad testnet, anchored on 2026-09-30, all five demo agents verify, Trading Assistant at 96 with 15/15 records. They still verify after the live smoke's two demo resets.
5. **Surface.** Next.js app, public v1 API with hashed API keys, `@fuku/sdk`, Envio HyperSync indexing the four registries (Activity → On-chain) plus HyperRPC proof verification, an Envio HyperIndex config, Kimi/Qwen explanations with a rule-based fallback, and an AES-GCM encrypted memory vault.

### What is real today

| Component | State |
| --- | --- |
| Passkey identity | Real WebAuthn registration and login with user verification required, origins pinned and one-time challenges; the stored passkey keeps its signature counter. The identity is "passkey-verified", which is never presented as proof of a unique person. |
| Permission engine | Deterministic; every decision is attributed to a rule id. R0 to R6 as before (R4 now also blocks a scoped passport when the app is omitted); R11 (owner not passkey-verified) and R12 (incomplete request or limitless value rule) for value actions; R9, R7, R8 (Cleanverse) and R10 (on-chain guard) for A-Token transfers. Daily limits are integer base units per UTC day, reserved atomically. |
| Trust score | fuku-score/2: the six-line breakdown plus dimensions, evidence count, observation period, scoring version and uncertainty, served by the UI, the session API and the public API. Seeded numbers are unchanged (96 → 92). |
| Solidity registries | Four registries plus FukuSpendGuard v2 (owner-bounded mandates, single-use actions) and two Cleanverse simulators in Hardhat 3, Solidity 0.8.28, 72 passing tests (13 of them adversarial), deploy scripts with role grants, ABI export, pre-flight and env-wiring scripts. All seven are on Monad testnet with sources verified on Sourcify (README, "Deployments"): the four registries since 2026-09-24, FukuSpendGuard 0x3d5d…46dc and the two simulators since 2026-09-30. |
| Settlement adapter | Live path simulates each call before sending (reverts decode to the contract's custom errors), stores a guarded transfer's hash as soon as it is broadcast, waits for the receipt, and anchors missing identities, agents and passports lazily. A live failure is recorded as `failed` and a timeout as `pending`, never as a mock receipt; `npm run reconcile` settles them, recovers crashed transfers through the guard and handles reorgs. One signer, serialised across processes by a database lease. Proven with `web/scripts/live-smoke.mjs`: 67/67 on a local Hardhat node, and 66/66 on Monad testnet on 2026-09-30 (the reorg check needs Hardhat). |
| SDK | `@fuku/sdk` 0.3.0, built to `dist/`. 19 methods, including `getAction` (lifecycle and evidence) and `getMandate`; idempotency keys; structured error codes. Eight contract tests. `examples/sdk-consumer` runs the whole flow against a local node, and ran it on Monad testnet on 2026-09-30. The flow covers its own agent with a key generated locally, the owner's mandate and ERC-8004 registration (#1960), a guarded payment, and independent on-chain verification of the transfer. |
| Proofs | `proofHash = keccak256` of the decision record (agent, action, amount, app, decision, rule id, policy hash, timestamp, plus the Cleanverse `complianceRef` when evidence exists); a workflow trace on every action. |
| Cleanverse CVI / CVA | Real integration code: cooperate API client (envelope, AES-CBC bodies, fail-closed code mapping), asset / owner / recipient checks, evidence hashed into a `complianceRef`, A-Pass reads persisted, UI and SDK. The live API has never been called (invite pending); answers come from a Fuku-built simulator, labelled everywhere. See `docs/CLEANVERSE.md`. |
| Authorization | One path for the web app, the API, the SDK and CRE: an owner, an identity the caller created, or an owner-granted delegation with scopes (register, manage, execute). Invalid API keys are 401 with no session fallback. Rate limits per process. The demo sign-in and demo key are off in production unless explicitly enabled. |
| Execution lifecycle | DENIED, AUTHORIZED, SUBMITTED, CONFIRMED, PENDING, FAILED and SIMULATED are stored with receipt mode, chain id, block and log index; `Idempotency-Key` replays instead of executing twice. |
| Memory vault | AES-GCM-256 with a PBKDF2 key (100,000 iterations) derived in the browser from the owner's own passphrase; the server stores ciphertext, IVs and an encrypted check value, never the passphrase. Only the seeded demo identity opens with a public demo passphrase, labelled as not secret. Titles are stored in clear. |

### What is simulated until keys are configured

| Component | Today | What flips it |
| --- | --- | --- |
| Monad settlement | Mock receipts with a deterministic proof hash. The explorer link in a mock receipt does not resolve. | One deploy and one `npm run wire:env` away (it writes `FUKU_CHAIN_MODE=live`, the signer key and the four `FUKU_*_REGISTRY` addresses). Do not call this "one env var". |
| AI explanations | Rule-based narrator (`fuku-rules`). | Literally one env var: `KIMI_API_KEY` or `QWEN_API_KEY`. The adapter has not been exercised with a real key; on any error it falls back to the narrator. |
| Nansen | Key configured and verified against the live API (free plan). Wallet-label lookups cost 100 Nansen credits each, so until the account holds at least 100 credits the Reputation card shows ledger-derived signals and says so. | Top up Nansen credits (or Pro plan); the code path is exercised and cached per address for a day. |
| Envio | Live. HyperSync indexes every Fuku registry event on Monad testnet for the signed-in identity and its agents (Activity → On-chain · Envio, with block times and explorer links). HyperRPC verifies a single decision: its receipt, its ActionDecision event, and that the on-chain proof hash equals the Fuku ledger ("Verify on-chain" on an activity row). The HyperIndex config in `/indexer` carries the real addresses but is not run (it needs Docker). | Nothing for the demo. Running HyperIndex would add a GraphQL API over the same events. |
| Cleanverse | Simulated, "API invite pending". With a live chain, Fuku's `CleanverseAPassSim` and `CleanverseATokenSim` (aUSDC-SIM) answer; with a mocked chain, DB fixtures with the same semantics do. The simulator has been deployed on Monad testnet since 2026-09-30, and the testnet smoke passed 66/66. | The API invite, then the checklist in `docs/CLEANVERSE.md` (`npm run cleanverse:check` first). |
| Chainlink CRE | Real workflow in `cre/fuku-guard` (TypeScript, CRE SDK 1.22): HTTP trigger, verify through the Fuku API, execute, then an EVM read of the Monad registries through the DON. Proven with `cre workflow simulate` against the live app: a blocked withdraw produced a real Monad transaction and CRE read back the matching score. Not deployed to the DON: Chainlink answered our access request (2026-09-24) that hackathon teams simulate locally, and that testnet or mainnet deployment goes through a commercial call and an MNDA. | A commercial agreement with Chainlink, then `node cre/deploy.mjs` (tunnel, secret, deploy, `CRE_WORKFLOW_ID`) is ready to run. |
| On-chain human flag | In live mode the app sets `setHumanVerified` itself, because its signer is the registry owner (the verifier role). | An independent verifier holding that role is future work. |
| Signing model | In live mode the relayer key is registry owner, identity controller, enforcer and scorer, so it can record any decision or score. The compliance signer attests guarded transfers, but only inside the mandate the owner's own wallet opened (token, cap, per-transfer limit, expiry, payees). The owner's wallet signs the approval, the mandate and the payee list. | Owner-controlled identity keys, which need a registry redeploy (an open decision). |
| Seeded demo data | Ava Chen, her agents and their history are seeded with deterministic ids and decision records. `npm run reconcile -- --anchor-seeded` anchors them once. A demo reset rebuilds the same records, so they stay verifiable. | Anchored on Monad testnet on 2026-09-30. A reset cannot rewind live actions on-chain, so after a live climax, `npm run demo:cohort` gives the demo fresh, anchored agents. |

### Going live on Monad testnet before the demo (the founder's runbook)

1. Generate a fresh key and fund it from the Monad faucet (`https://faucet.monad.xyz`). Never reuse a mainnet key.
2. `contracts/.env`: `DEPLOYER_PRIVATE_KEY=0x...` and `MONAD_RPC_URL=https://testnet-rpc.monad.xyz`.
3. `cd contracts && npm install && npm test` (72 passing), then `npm run check:deployer`. It derives the address, confirms chain id 10143 and a non-zero MON balance, and warns below 0.1 MON. A full deploy sends ten transactions (seven deploys, three role grants).
4. `npm run deploy:monad`. It deploys the four registries in order, grants the deployer the enforcer and scorer roles, deploys the two Cleanverse simulators and FukuSpendGuard (compliance signer from `COMPLIANCE_SIGNER_ADDRESS`, else the deployer with a warning), makes the guard an enforcer, and writes `contracts/deployments/monadTestnet.json`. For the stack that is already on testnet, `npm run deploy:cleanverse:monad` adds only the three new contracts and the enforcer grant (four transactions) and never touches the registries. That ran on 2026-09-30.
5. `npm run wire:env`. It copies `web/.env` to a new timestamped backup, then upserts `FUKU_CHAIN_MODE=live`, `FUKU_CHAIN_ID=10143`, `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, the four `FUKU_*_REGISTRY` lines and, when deployed, `FUKU_SPEND_GUARD`, `CLEANVERSE_SIM_APASS` and `CLEANVERSE_SIM_ATOKEN` (plus `FUKU_COMPLIANCE_SIGNER_KEY` from `contracts/.env`). Then, for the supplier-payment beat, add `DEMO_OWNER_PRIVATE_KEY` (a fresh testnet key for Ava's wallet) to `web/.env` and run `cd web && npm run cleanverse:setup`: it issues the simulator A-Passes, mints 10,000 aUSDC-SIM to Ava, tops up her gas, and opens the 1,000/day mandate. Preview first with `node scripts/wire-env.mjs --dry-run`. The web signer must be the account that deployed, because it holds the owner, enforcer and scorer roles; `wire:env` copies the same key, and refuses to replace a different key already in `web/.env` unless given `--replace-keys`.
6. Restart the dev server (`cd web && npm run dev -- -p 3001`); env is read at startup.
7. Check: Developer Console, the pill next to "Integration status" reads "Monad Testnet · chain 10143 · live settlement" and the Monad card says live. `curl http://localhost:3001/api/integrations` shows `chain.mode: "live"` and the signer address.
8. Produce a real receipt: **Create with passkey** (`registerIdentity` then `setHumanVerified`), **Register agent** (`registerAgent`), **Approve passport** (`setPolicy`), then run a withdraw of 4,800 from the Permission Manager's "Test an action against the passport" form (`recordDecision` then `updateScore`; the dashboard preset only targets Trading Assistant). The result dialog now says "Monad transaction" and the link opens on `testnet.monadexplorer.com`. Each write waits for its receipt (up to 90 seconds), so expect a short pause per anchor.
9. The full sequence with measured costs (deploy, setup, seed anchoring, ERC-8004 registration of the demo agents, smoke, Sourcify verification) is in `docs/SECURITY.md` section 10.
   Anchor the seeded demo: open the `?reset=1` link, then run `cd web && npm run reconcile -- --anchor-seeded`. It registers the demo agents and passports, anchors the 25 seeded decisions and writes their scores, printing every transaction. **Recompute from chain** on Trading Assistant then shows ✓ at 96.
   - Do not rehearse the climax on the testnet agents. A reset rebuilds the seeded ledger but cannot remove a live decision from the chain, so the agent would no longer verify.
   - A reset keeps what the setup recorded about the seeded agents: their ERC-8004 registration, their sealed agent keys and the anchoring transactions. The activity rows come back as anchored.
   - Between the video and live judging, run `cd web && npm run demo:cohort -- --allow-testnet`. It gives the demo five fresh agents and anchors their seeded history. It also opens Ava's mandate for the new Payments Agent and registers the agents on ERC-8004, then checks each score from the chain. About 0.69 MON, priced from the testnet run's own transactions (0.59 on the fork): 0.41 from the relayer and 0.28 from Ava's wallet, which the script tops up. Then open the `?reset=1` link once.
10. Rehearse without testnet if you want: `npx hardhat node` in `contracts/`, `COMPLIANCE_SIGNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 npx hardhat run scripts/deploy.ts --network localhost` (account #1 is the compliance signer, account #2 is Ava for `DEMO_OWNER_PRIVATE_KEY`; `docs/CLEANVERSE.md` has the full local run), then wire the web app to the node's account #0 for that run only: `DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 MONAD_RPC_URL=http://127.0.0.1:8545 npm run wire:env -- --network localhost` (without those two overrides `wire:env` writes the testnet RPC and refuses to run without a key), and set `FUKU_CHAIN_NAME="Hardhat local"` in `web/.env`. Same code path, chain id 31337, receipts are real but the explorer link points at Monad's explorer and will not resolve. Re-run `npm run wire:env` with no overrides to point back at testnet.
11. Optional: open Activity → On-chain · Envio to show the same decisions read back from Monad by Envio HyperSync, and press Verify on-chain on the fresh blocked withdraw (Envio HyperRPC).
12. Never commit `web/.env`, its `web/.env.bak*` backups or `contracts/.env`.

---

### Monad testnet record (2026-09-30)

Step 5 of the runbook ran on Monad testnet on 2026-09-30, between 16:40 and 16:53 UTC.
- 116 transactions, none reverted, 1.83 MON of gas.
- Contract addresses: README, "Deployments". What ran and why: `docs/CLEANVERSE.md`, "On Monad testnet".

Results:
- The simulators and the guard are deployed, and all seven contracts are verified on Sourcify (exact match).
- The seeded history is anchored: 38 transactions.
- The live smoke passed 66/66, and `examples/sdk-consumer` behaved as expected at every step.
- All five demo agents verify from the chain. Trading Assistant scores 96 from the chain, 96 anchored and 96 in the ledger, with 15/15 records matching. After restarting the app on 3001, the app lists Trading Assistant at 96, and **Recompute from chain** (the endpoint its button calls) returns ✓.

ERC-8004: the five demo agents (cohort `v2`) are registered on the canonical Identity Registry [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.monadvision.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e). Each NFT is owned by Ava's demo wallet, with the agent's own key as `agentWallet`.

| Agent | ERC-8004 agent id | `register` transaction |
| --- | --- | --- |
| Trading Assistant | 1955 | [`0x3771cc08…b844`](https://testnet.monadvision.com/tx/0x3771cc08d9d2e3f41d00e8dd386a8452e68c996ad23ac950200809bc58dfb844) |
| Research Agent | 1956 | [`0xdc574aa0…b4d3`](https://testnet.monadvision.com/tx/0xdc574aa06f9f49a5fed957479198d71421b90eddd4d50f2ca0eee6dbda5bb4d3) |
| Payments Agent | 1957 | [`0xf8ca2a1a…4f9f`](https://testnet.monadvision.com/tx/0xf8ca2a1a0362e3e36334611d0df489cc3d6367fda428ec442eeecd98e5b44f9f) |
| Ops Scheduler | 1958 | [`0x2ab3a9c8…f422`](https://testnet.monadvision.com/tx/0x2ab3a9c8beaa11b0e8ff1b0608d9131e45cae322b3bc8bbbf2c4cdb587abf422) |
| Portfolio Rebalancer | 1959 | [`0x497f8230…b4e8`](https://testnet.monadvision.com/tx/0x497f8230b8cc755143fe637357acfd5ce3782d25409bc08ae8303962d770b4e8) |

<details>
<summary>All 116 transactions of the testnet run, 2026-09-30 16:40 to 16:53 UTC (blocks 67,021,388 to 67,023,916; none reverted; 1.83 MON of gas)</summary>

Collected from Envio HyperSync by sender (the relayer, Ava's wallet and the smoke owner) and cross-checked against what each script printed. The fee is gas limit × price, which is what Monad charges.

**1. `npm run deploy:cleanverse:monad`: the two simulators, the guard, and its enforcer grant.** 4 transactions, 0.3977 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 1 | deploy CleanverseAPassSim |  | relayer | [`0x02fb78f50724e68dc7eb7907c51c21d46f097e19e3803032cf864d2069c1fc9e`](https://testnet.monadvision.com/tx/0x02fb78f50724e68dc7eb7907c51c21d46f097e19e3803032cf864d2069c1fc9e) |
| 2 | deploy CleanverseATokenSim |  | relayer | [`0xb89ee396f7b18fb749c4f103260213b312d061605717ee2c6b38e93c0ce1c5ed`](https://testnet.monadvision.com/tx/0xb89ee396f7b18fb749c4f103260213b312d061605717ee2c6b38e93c0ce1c5ed) |
| 3 | deploy FukuSpendGuard |  | relayer | [`0x1de59d1917981d7b1160ce36f79ee79412746a79ee501cbf05fb690a046a78a7`](https://testnet.monadvision.com/tx/0x1de59d1917981d7b1160ce36f79ee79412746a79ee501cbf05fb690a046a78a7) |
| 4 | PermissionRegistry.setEnforcer |  | relayer | [`0x72534cc409855b867c6c496130ccf29015a794882f72a2f6452a9679cd9ecdd0`](https://testnet.monadvision.com/tx/0x72534cc409855b867c6c496130ccf29015a794882f72a2f6452a9679cd9ecdd0) |

**2. `npm run cleanverse:setup`: simulator A-Passes, 10,000 aUSDC-SIM and 0.4 MON to Ava; her allowance, mandate and payee for the Payments Agent.** 8 transactions, 0.0689 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 5 | CleanverseAPassSim.issue |  | relayer | [`0xb8a74b308df7f8e0a57af326bba76305f1e6f6ffcfa01facd389f22e9e26684d`](https://testnet.monadvision.com/tx/0xb8a74b308df7f8e0a57af326bba76305f1e6f6ffcfa01facd389f22e9e26684d) |
| 6 | CleanverseAPassSim.issue |  | relayer | [`0xda2b94f42d20137378a7ed454a50b598310519d2305a5cddff8e898a6008e4b5`](https://testnet.monadvision.com/tx/0xda2b94f42d20137378a7ed454a50b598310519d2305a5cddff8e898a6008e4b5) |
| 7 | CleanverseAPassSim.issue |  | relayer | [`0xc130ad12dac24dead57d1d0d32ba99d58f827e38b4eeb8d289bb1106f6812883`](https://testnet.monadvision.com/tx/0xc130ad12dac24dead57d1d0d32ba99d58f827e38b4eeb8d289bb1106f6812883) |
| 8 | CleanverseATokenSim.mint |  | relayer | [`0xe63f2a977bc207cc5e3c8dfe53906315d591ffbbacf33c5a65aead1ce434d52e`](https://testnet.monadvision.com/tx/0xe63f2a977bc207cc5e3c8dfe53906315d591ffbbacf33c5a65aead1ce434d52e) |
| 9 | send 0.4 MON to Ava's wallet |  | relayer | [`0xea81a457f0ff5aa308e124b2fe49349d7328bcafc405a08449b937d5a16241e9`](https://testnet.monadvision.com/tx/0xea81a457f0ff5aa308e124b2fe49349d7328bcafc405a08449b937d5a16241e9) |
| 10 | CleanverseATokenSim.approve |  | Ava's wallet | [`0x80b325267e10fbfefac6f9753f679cb1e12adc518f1ea65b6f597b133118ee52`](https://testnet.monadvision.com/tx/0x80b325267e10fbfefac6f9753f679cb1e12adc518f1ea65b6f597b133118ee52) |
| 11 | FukuSpendGuard.openMandate |  | Ava's wallet | [`0x2814dde3a57710c21d22f12ffc41b86e7dfada63dd53f0c01b5f9e14ab6dd69c`](https://testnet.monadvision.com/tx/0x2814dde3a57710c21d22f12ffc41b86e7dfada63dd53f0c01b5f9e14ab6dd69c) |
| 12 | FukuSpendGuard.setPayee |  | Ava's wallet | [`0xdafdd34bb0ce043596324b2fc034b7a0cc10179d4e27be8cd4e815eb1465eb9f`](https://testnet.monadvision.com/tx/0xdafdd34bb0ce043596324b2fc034b7a0cc10179d4e27be8cd4e815eb1465eb9f) |

**3. Funding the smoke owner's wallet.** 1 transaction, 0.0022 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 13 | send 0.1 MON to smoke owner |  | relayer | [`0xfb18afbcae7e951a82836ec124983819f36cea91539aed63dba0018dda3d4739`](https://testnet.monadvision.com/tx/0xfb18afbcae7e951a82836ec124983819f36cea91539aed63dba0018dda3d4739) |

**4. `npm run reconcile -- --anchor-seeded`: 5 agents, 3 passports, 25 seeded decisions, 5 scores.** 38 transactions, 0.4025 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 14 | AgentRegistry.registerAgent | Trading Assistant | relayer | [`0x7b07d07eb2ecdf92b18e621fa8b1f82e53e3825dacc9a34b9dcb156da2e6031a`](https://testnet.monadvision.com/tx/0x7b07d07eb2ecdf92b18e621fa8b1f82e53e3825dacc9a34b9dcb156da2e6031a) |
| 15 | PermissionRegistry.setPolicy | Trading Assistant | relayer | [`0xed3b7d1b699919bf050d7839381c54ce13e9ca2b81d9b11b78a18644eff015b9`](https://testnet.monadvision.com/tx/0xed3b7d1b699919bf050d7839381c54ce13e9ca2b81d9b11b78a18644eff015b9) |
| 16 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x27125b3fcf53798924c3b9728ef3e7e2df99e210905bb10c4a7a867c29ced8f8`](https://testnet.monadvision.com/tx/0x27125b3fcf53798924c3b9728ef3e7e2df99e210905bb10c4a7a867c29ced8f8) |
| 17 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x80843a4c9caac9c5b915a428a0c0e02cbb012136d7682d94c61cb4518054876f`](https://testnet.monadvision.com/tx/0x80843a4c9caac9c5b915a428a0c0e02cbb012136d7682d94c61cb4518054876f) |
| 18 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0xea66da38149d90507fc794c415ba18da8ee14e21e49197b0716d3410e644dad9`](https://testnet.monadvision.com/tx/0xea66da38149d90507fc794c415ba18da8ee14e21e49197b0716d3410e644dad9) |
| 19 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x699fb7e909300b8fb21d9f5b95150006aa234706a4eb59cc29d86070f094418f`](https://testnet.monadvision.com/tx/0x699fb7e909300b8fb21d9f5b95150006aa234706a4eb59cc29d86070f094418f) |
| 20 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x11315346225e73aa056059431f5108621145c9492c05f8fb4bcc42df16e401e6`](https://testnet.monadvision.com/tx/0x11315346225e73aa056059431f5108621145c9492c05f8fb4bcc42df16e401e6) |
| 21 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0xb74b4ce0f6685bf8f14051210f3401e2e54170018ebaf354ba598aeb00d41910`](https://testnet.monadvision.com/tx/0xb74b4ce0f6685bf8f14051210f3401e2e54170018ebaf354ba598aeb00d41910) |
| 22 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x5a5b779dbc310335ad6b9fa6c4d63b33ff7a969b7183aba5fe401d33e60ba9f7`](https://testnet.monadvision.com/tx/0x5a5b779dbc310335ad6b9fa6c4d63b33ff7a969b7183aba5fe401d33e60ba9f7) |
| 23 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x39b95420de3b7c17ba4f4c890d8bf15f06ad38249fb46ea6e69679d8a70901bb`](https://testnet.monadvision.com/tx/0x39b95420de3b7c17ba4f4c890d8bf15f06ad38249fb46ea6e69679d8a70901bb) |
| 24 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x24a7288137794dc6cdcaff407bd38cba0630582dc98d9bcdc35c38688af92cb1`](https://testnet.monadvision.com/tx/0x24a7288137794dc6cdcaff407bd38cba0630582dc98d9bcdc35c38688af92cb1) |
| 25 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x6e2bfb135ec8f83bc8d9cd62464a1f1d6d8d3e3cc3ad7b9d274cb0d619677085`](https://testnet.monadvision.com/tx/0x6e2bfb135ec8f83bc8d9cd62464a1f1d6d8d3e3cc3ad7b9d274cb0d619677085) |
| 26 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0xdd09e6bcd53116b658e94b7299ec416d95d14eb69a6272ccec343b7fe6295030`](https://testnet.monadvision.com/tx/0xdd09e6bcd53116b658e94b7299ec416d95d14eb69a6272ccec343b7fe6295030) |
| 27 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x9d643610fd9842be6693d26922e67eae2433424f725dcc7b483ca96e88de8617`](https://testnet.monadvision.com/tx/0x9d643610fd9842be6693d26922e67eae2433424f725dcc7b483ca96e88de8617) |
| 28 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x5d261193403ab6ab3ecd4d74e6e82015602fe0d562f37d029e58d4e2aa887445`](https://testnet.monadvision.com/tx/0x5d261193403ab6ab3ecd4d74e6e82015602fe0d562f37d029e58d4e2aa887445) |
| 29 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0x5503fbbe21b3213257b334464c8217cd40b2e8a0406305cc4b61484181a20424`](https://testnet.monadvision.com/tx/0x5503fbbe21b3213257b334464c8217cd40b2e8a0406305cc4b61484181a20424) |
| 30 | PermissionRegistry.recordDecision | Trading Assistant | relayer | [`0xdba85d96a8aa10f14dec431f82aa5ed67ed751a56094a5be17a72caabca7c35f`](https://testnet.monadvision.com/tx/0xdba85d96a8aa10f14dec431f82aa5ed67ed751a56094a5be17a72caabca7c35f) |
| 31 | ReputationRegistry.updateScore | Trading Assistant | relayer | [`0xb25585747e53da248f0d34bd690ca41c066b82b8134deff360e143a14f8c8142`](https://testnet.monadvision.com/tx/0xb25585747e53da248f0d34bd690ca41c066b82b8134deff360e143a14f8c8142) |
| 32 | AgentRegistry.registerAgent | Research Agent | relayer | [`0x65ccbcbbed22ee4faf297060204a49f882bf11f3f43e10aef612109321188e80`](https://testnet.monadvision.com/tx/0x65ccbcbbed22ee4faf297060204a49f882bf11f3f43e10aef612109321188e80) |
| 33 | PermissionRegistry.setPolicy | Research Agent | relayer | [`0xe2e26dff3695d94ad137bb6f25251e5e301a53d5f9f52c881c83b351d8143a9e`](https://testnet.monadvision.com/tx/0xe2e26dff3695d94ad137bb6f25251e5e301a53d5f9f52c881c83b351d8143a9e) |
| 34 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0x02ce93a068a6613e19afe4ac8e325d5df968f68e71ed32ce4a86834f897f8711`](https://testnet.monadvision.com/tx/0x02ce93a068a6613e19afe4ac8e325d5df968f68e71ed32ce4a86834f897f8711) |
| 35 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0x69c59cba90a88aef96d906436eea37b2c714a4c19f272e041aec44958692b04b`](https://testnet.monadvision.com/tx/0x69c59cba90a88aef96d906436eea37b2c714a4c19f272e041aec44958692b04b) |
| 36 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0xec0a186f8a6c914e67b7c52d3be8dfc62417c15610e7da130e9104f142b92002`](https://testnet.monadvision.com/tx/0xec0a186f8a6c914e67b7c52d3be8dfc62417c15610e7da130e9104f142b92002) |
| 37 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0xb4bbc3ec458708e4aa759a3552d188a16175cf39b8af848bb141451fe536a7d7`](https://testnet.monadvision.com/tx/0xb4bbc3ec458708e4aa759a3552d188a16175cf39b8af848bb141451fe536a7d7) |
| 38 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0x27f0264c62639f53a3bf77fd1976f44c8ee9d5fb26639acc0a1809bdda3aa381`](https://testnet.monadvision.com/tx/0x27f0264c62639f53a3bf77fd1976f44c8ee9d5fb26639acc0a1809bdda3aa381) |
| 39 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0xee0808dca35853e176710f1d800b4dfdbf4dadf92feeb16b616221a4bbbf072b`](https://testnet.monadvision.com/tx/0xee0808dca35853e176710f1d800b4dfdbf4dadf92feeb16b616221a4bbbf072b) |
| 40 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0x1dc4255bb9fea2101e9340fadbcbf3e19d7bbc7d221ed493bbd4a37f0240ad6c`](https://testnet.monadvision.com/tx/0x1dc4255bb9fea2101e9340fadbcbf3e19d7bbc7d221ed493bbd4a37f0240ad6c) |
| 41 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0x64e16515ea87ff0a3466ba5353f99378688a13ae2f5a86da3cf1fe3d9ae4fecf`](https://testnet.monadvision.com/tx/0x64e16515ea87ff0a3466ba5353f99378688a13ae2f5a86da3cf1fe3d9ae4fecf) |
| 42 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0x0f34f2b770328185f863a491d3863b49916c674e4ad4fbe0611e3ca314059627`](https://testnet.monadvision.com/tx/0x0f34f2b770328185f863a491d3863b49916c674e4ad4fbe0611e3ca314059627) |
| 43 | PermissionRegistry.recordDecision | Research Agent | relayer | [`0x73f1ec7c3ecf0b9226b22d61b3ed2c094047e9bac83208fe10d56a45d76ad39b`](https://testnet.monadvision.com/tx/0x73f1ec7c3ecf0b9226b22d61b3ed2c094047e9bac83208fe10d56a45d76ad39b) |
| 44 | ReputationRegistry.updateScore | Research Agent | relayer | [`0x218346558a6a8739e68f7a2eba5ecad25844a965654f176a12aebc07e1c29003`](https://testnet.monadvision.com/tx/0x218346558a6a8739e68f7a2eba5ecad25844a965654f176a12aebc07e1c29003) |
| 45 | AgentRegistry.registerAgent | Payments Agent | relayer | [`0x8fde3e9e1ae34a0dd9dfe0b1c6e7eb49f175bea0fdec643c40f9827334e7d8b9`](https://testnet.monadvision.com/tx/0x8fde3e9e1ae34a0dd9dfe0b1c6e7eb49f175bea0fdec643c40f9827334e7d8b9) |
| 46 | PermissionRegistry.setPolicy | Payments Agent | relayer | [`0x4324ce9a46626fc5bd072a94b8b017e127080162695cbbb148e807e966ea3202`](https://testnet.monadvision.com/tx/0x4324ce9a46626fc5bd072a94b8b017e127080162695cbbb148e807e966ea3202) |
| 47 | ReputationRegistry.updateScore | Payments Agent | relayer | [`0x3de7955460a63f9337542e765ea17c3cd4535aa8900204a9d51106dec275b53f`](https://testnet.monadvision.com/tx/0x3de7955460a63f9337542e765ea17c3cd4535aa8900204a9d51106dec275b53f) |
| 48 | AgentRegistry.registerAgent | Ops Scheduler | relayer | [`0x8cba02d80f7f9d165cf3553cfcddd07979ce7b69bdcb98674bac5b2f1060dd7b`](https://testnet.monadvision.com/tx/0x8cba02d80f7f9d165cf3553cfcddd07979ce7b69bdcb98674bac5b2f1060dd7b) |
| 49 | ReputationRegistry.updateScore | Ops Scheduler | relayer | [`0xfd2e4452296f2350000b46ae35e9607e315627527e3d914baa116066c08c51a9`](https://testnet.monadvision.com/tx/0xfd2e4452296f2350000b46ae35e9607e315627527e3d914baa116066c08c51a9) |
| 50 | AgentRegistry.registerAgent | Portfolio Rebalancer | relayer | [`0xb4fb1fbcc5011e9e0eb73940ca1c2bd86834c30d4b843ec0fa654884e75f5f90`](https://testnet.monadvision.com/tx/0xb4fb1fbcc5011e9e0eb73940ca1c2bd86834c30d4b843ec0fa654884e75f5f90) |
| 51 | ReputationRegistry.updateScore | Portfolio Rebalancer | relayer | [`0x54fc97b6c0f256f0ff718049f6f32dd01930ea9aca5ea4aa45b5b184c2d10667`](https://testnet.monadvision.com/tx/0x54fc97b6c0f256f0ff718049f6f32dd01930ea9aca5ea4aa45b5b184c2d10667) |

**5. `npm run erc8004:register -- --allow-testnet`: the 5 demo agents on the canonical ERC-8004 Identity Registry.** 10 transactions, 0.2525 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 52 | ERC8004IdentityRegistry.register | Trading Assistant → #1955 | Ava's wallet | [`0x3771cc08d9d2e3f41d00e8dd386a8452e68c996ad23ac950200809bc58dfb844`](https://testnet.monadvision.com/tx/0x3771cc08d9d2e3f41d00e8dd386a8452e68c996ad23ac950200809bc58dfb844) |
| 53 | ERC8004IdentityRegistry.setAgentWallet | Trading Assistant → #1955 | Ava's wallet | [`0xc49ca5e3fee1069aa21290600bba14e6b9bc2add8b4c0689e5feb4a09ebda491`](https://testnet.monadvision.com/tx/0xc49ca5e3fee1069aa21290600bba14e6b9bc2add8b4c0689e5feb4a09ebda491) |
| 54 | ERC8004IdentityRegistry.register | Research Agent → #1956 | Ava's wallet | [`0xdc574aa06f9f49a5fed957479198d71421b90eddd4d50f2ca0eee6dbda5bb4d3`](https://testnet.monadvision.com/tx/0xdc574aa06f9f49a5fed957479198d71421b90eddd4d50f2ca0eee6dbda5bb4d3) |
| 55 | ERC8004IdentityRegistry.setAgentWallet | Research Agent → #1956 | Ava's wallet | [`0x4a5792ecf7a8c166b24faaacbe1c3c05b7c04c81e7285d11ca6ade8c3733058e`](https://testnet.monadvision.com/tx/0x4a5792ecf7a8c166b24faaacbe1c3c05b7c04c81e7285d11ca6ade8c3733058e) |
| 56 | ERC8004IdentityRegistry.register | Payments Agent → #1957 | Ava's wallet | [`0xf8ca2a1a0362e3e36334611d0df489cc3d6367fda428ec442eeecd98e5b44f9f`](https://testnet.monadvision.com/tx/0xf8ca2a1a0362e3e36334611d0df489cc3d6367fda428ec442eeecd98e5b44f9f) |
| 57 | ERC8004IdentityRegistry.setAgentWallet | Payments Agent → #1957 | Ava's wallet | [`0x9422680216e1fe6f0735ef66ccec6595e15aaa013520fc9954e68635a226d26e`](https://testnet.monadvision.com/tx/0x9422680216e1fe6f0735ef66ccec6595e15aaa013520fc9954e68635a226d26e) |
| 58 | ERC8004IdentityRegistry.register | Ops Scheduler → #1958 | Ava's wallet | [`0x2ab3a9c8beaa11b0e8ff1b0608d9131e45cae322b3bc8bbbf2c4cdb587abf422`](https://testnet.monadvision.com/tx/0x2ab3a9c8beaa11b0e8ff1b0608d9131e45cae322b3bc8bbbf2c4cdb587abf422) |
| 59 | ERC8004IdentityRegistry.setAgentWallet | Ops Scheduler → #1958 | Ava's wallet | [`0x389cb78095fa02211792efd86480b95d98b826689d28a8d18818845f1bbffb9e`](https://testnet.monadvision.com/tx/0x389cb78095fa02211792efd86480b95d98b826689d28a8d18818845f1bbffb9e) |
| 60 | ERC8004IdentityRegistry.register | Portfolio Rebalancer → #1959 | Ava's wallet | [`0x497f8230b8cc755143fe637357acfd5ce3782d25409bc08ae8303962d770b4e8`](https://testnet.monadvision.com/tx/0x497f8230b8cc755143fe637357acfd5ce3782d25409bc08ae8303962d770b4e8) |
| 61 | ERC8004IdentityRegistry.setAgentWallet | Portfolio Rebalancer → #1959 | Ava's wallet | [`0xd6b94454b31eacbc0b073392146730b21f40ff5ce75b7e81dddf2fd5365d4441`](https://testnet.monadvision.com/tx/0xd6b94454b31eacbc0b073392146730b21f40ff5ce75b7e81dddf2fd5365d4441) |

**6. `web/scripts/live-smoke.mjs` against testnet (66/66), on its own agents.** 42 transactions, 0.5120 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 62 | AgentRegistry.registerAgent |  | relayer | [`0x856aebdd479913644ec576134c986899ef95a03011291b5d0abdee3553b2c918`](https://testnet.monadvision.com/tx/0x856aebdd479913644ec576134c986899ef95a03011291b5d0abdee3553b2c918) |
| 63 | PermissionRegistry.setPolicy |  | relayer | [`0xa89507d6bb817c5f8bba600d63ee66b7f20d72f9587f407c5f96fb66a2a848c1`](https://testnet.monadvision.com/tx/0xa89507d6bb817c5f8bba600d63ee66b7f20d72f9587f407c5f96fb66a2a848c1) |
| 64 | PermissionRegistry.recordDecision |  | relayer | [`0x22133871c32784ebd78e969e0e1fdccb316808c4273f3e869a8bd10d29e37b45`](https://testnet.monadvision.com/tx/0x22133871c32784ebd78e969e0e1fdccb316808c4273f3e869a8bd10d29e37b45) |
| 65 | PermissionRegistry.recordDecision |  | relayer | [`0xb7770e2af7b002cc3a9769b9d6b81bcf4b86f81e162df3c5a7f8661cce89b1db`](https://testnet.monadvision.com/tx/0xb7770e2af7b002cc3a9769b9d6b81bcf4b86f81e162df3c5a7f8661cce89b1db) |
| 66 | ReputationRegistry.updateScore |  | relayer | [`0x1b07dc7258e536160b172f146811baa50474944f12976046116806ab44df7b68`](https://testnet.monadvision.com/tx/0x1b07dc7258e536160b172f146811baa50474944f12976046116806ab44df7b68) |
| 67 | AgentRegistry.setStatus |  | relayer | [`0xa6f05e5a190c71a54aa1bf8e7fc5461aaaa1da0e7d3324ff4754559e22585173`](https://testnet.monadvision.com/tx/0xa6f05e5a190c71a54aa1bf8e7fc5461aaaa1da0e7d3324ff4754559e22585173) |
| 68 | AgentRegistry.registerAgent |  | relayer | [`0xf09aa0a7c37c56c2f248459cdfcb01dd21b0475a2075f9e1f3ca4d55ae56f8dc`](https://testnet.monadvision.com/tx/0xf09aa0a7c37c56c2f248459cdfcb01dd21b0475a2075f9e1f3ca4d55ae56f8dc) |
| 69 | PermissionRegistry.setPolicy |  | relayer | [`0x6944a7393fdf4cad93797cebf2507e9ee586e496a0aa97ab5908de72571f5333`](https://testnet.monadvision.com/tx/0x6944a7393fdf4cad93797cebf2507e9ee586e496a0aa97ab5908de72571f5333) |
| 70 | FukuSpendGuard.openMandate |  | Ava's wallet | [`0xcf36db591e3a90f6ddb2060763bee6aa3e47e9d7e3660a5ebece8ac6acb74e93`](https://testnet.monadvision.com/tx/0xcf36db591e3a90f6ddb2060763bee6aa3e47e9d7e3660a5ebece8ac6acb74e93) |
| 71 | FukuSpendGuard.setPayee |  | Ava's wallet | [`0x13d437cc1d0e380ac16104ecae57fcecd7fc5770a0d39a631a06ca9380184560`](https://testnet.monadvision.com/tx/0x13d437cc1d0e380ac16104ecae57fcecd7fc5770a0d39a631a06ca9380184560) |
| 72 | FukuSpendGuard.execute |  | relayer | [`0x20f0968f7027cf25d1b73864a9a92965058399b7dcf8967936c7152978b0b35c`](https://testnet.monadvision.com/tx/0x20f0968f7027cf25d1b73864a9a92965058399b7dcf8967936c7152978b0b35c) |
| 73 | ReputationRegistry.updateScore |  | relayer | [`0x42884d0f749e7e805cfc5d00b333a42f2b5a24cb30658be930776cbf55b274fc`](https://testnet.monadvision.com/tx/0x42884d0f749e7e805cfc5d00b333a42f2b5a24cb30658be930776cbf55b274fc) |
| 74 | PermissionRegistry.recordDecision |  | relayer | [`0x14a364afa04488408bb78086d7fc855c9a2023720b0174a32b6a5ce0310a03bd`](https://testnet.monadvision.com/tx/0x14a364afa04488408bb78086d7fc855c9a2023720b0174a32b6a5ce0310a03bd) |
| 75 | ReputationRegistry.updateScore |  | relayer | [`0x6e8cc3c561e7192e81aca6d0b7129fe4961f60cc5aee335a2a25e0e8236cbddd`](https://testnet.monadvision.com/tx/0x6e8cc3c561e7192e81aca6d0b7129fe4961f60cc5aee335a2a25e0e8236cbddd) |
| 76 | PermissionRegistry.recordDecision |  | relayer | [`0x85eca39208a0456d093ba196d578a857f006f7f0c80b704ea75e36bd8ce2123a`](https://testnet.monadvision.com/tx/0x85eca39208a0456d093ba196d578a857f006f7f0c80b704ea75e36bd8ce2123a) |
| 77 | ReputationRegistry.updateScore |  | relayer | [`0x16686afe359ceb31187304fca419fa3c93cd7cc92d5f9abab63283d3be975ee4`](https://testnet.monadvision.com/tx/0x16686afe359ceb31187304fca419fa3c93cd7cc92d5f9abab63283d3be975ee4) |
| 78 | FukuSpendGuard.execute |  | relayer | [`0x5896943e03aef920f3a99bdc9603db6d4cb9ba41d556365248f49982d0d5a095`](https://testnet.monadvision.com/tx/0x5896943e03aef920f3a99bdc9603db6d4cb9ba41d556365248f49982d0d5a095) |
| 79 | ReputationRegistry.updateScore |  | relayer | [`0xe02195e0be059964d0dfd0278a76b34c2ac8c3dc08383b54d03e272ddd0b28e4`](https://testnet.monadvision.com/tx/0xe02195e0be059964d0dfd0278a76b34c2ac8c3dc08383b54d03e272ddd0b28e4) |
| 80 | FukuSpendGuard.execute |  | relayer | [`0xf546c2c743494cefee93538d25f2422b4c9c71fbe0d61c015d2267474b6e7fae`](https://testnet.monadvision.com/tx/0xf546c2c743494cefee93538d25f2422b4c9c71fbe0d61c015d2267474b6e7fae) |
| 81 | ReputationRegistry.updateScore |  | relayer | [`0xb992edad428c3ed9b7db012272eac828700336fe5a8a7a95354019cb2890e5c3`](https://testnet.monadvision.com/tx/0xb992edad428c3ed9b7db012272eac828700336fe5a8a7a95354019cb2890e5c3) |
| 82 | FukuSpendGuard.execute |  | relayer | [`0x4c9d58e67820bdbc6a46fc55ed92942e4b388db676e0f2de9f13f3882a45def4`](https://testnet.monadvision.com/tx/0x4c9d58e67820bdbc6a46fc55ed92942e4b388db676e0f2de9f13f3882a45def4) |
| 83 | PermissionRegistry.recordDecision |  | relayer | [`0xa4a7fef1d58a93a00b3be8877638a776823f99b9a776a2d70fb70818c192c16a`](https://testnet.monadvision.com/tx/0xa4a7fef1d58a93a00b3be8877638a776823f99b9a776a2d70fb70818c192c16a) |
| 84 | ReputationRegistry.updateScore |  | relayer | [`0x5af60742cb02e0d209dd24ecf476b89d2c15bb6c0d59d68d025da61f51308ad4`](https://testnet.monadvision.com/tx/0x5af60742cb02e0d209dd24ecf476b89d2c15bb6c0d59d68d025da61f51308ad4) |
| 85 | ReputationRegistry.updateScore |  | relayer | [`0xf024c723d8273696d142e2fef0d05580925d3b1d49e1c32c458add993a7aa587`](https://testnet.monadvision.com/tx/0xf024c723d8273696d142e2fef0d05580925d3b1d49e1c32c458add993a7aa587) |
| 86 | FukuSpendGuard.bumpValidAfter |  | relayer | [`0x7a6feabf57c0b89f8c8d90fd396485bfcc492702688b7cf529ed5e81be4962c9`](https://testnet.monadvision.com/tx/0x7a6feabf57c0b89f8c8d90fd396485bfcc492702688b7cf529ed5e81be4962c9) |
| 87 | AgentRegistry.setStatus |  | relayer | [`0x6b45d03e2be3950f27c834d7d31c9a575ce0af8a58ed6ef0c0e8490aba46420f`](https://testnet.monadvision.com/tx/0x6b45d03e2be3950f27c834d7d31c9a575ce0af8a58ed6ef0c0e8490aba46420f) |
| 88 | AgentRegistry.setStatus |  | relayer | [`0x3b91268007933f8883e98226a44abb05ed3872b6f45641c01aaccc9547545b24`](https://testnet.monadvision.com/tx/0x3b91268007933f8883e98226a44abb05ed3872b6f45641c01aaccc9547545b24) |
| 89 | CleanverseATokenSim.approve |  | Ava's wallet | [`0x62f5e8d4bdb841f259338f24b1b669f02cd3ba8cb11bca19f30f63c7c9fda740`](https://testnet.monadvision.com/tx/0x62f5e8d4bdb841f259338f24b1b669f02cd3ba8cb11bca19f30f63c7c9fda740) |
| 90 | CleanverseATokenSim.approve |  | Ava's wallet | [`0x2d67617de9892f34eef9904bba19cc6194b78d9762cc2e99a25e8ec1a6fe7252`](https://testnet.monadvision.com/tx/0x2d67617de9892f34eef9904bba19cc6194b78d9762cc2e99a25e8ec1a6fe7252) |
| 91 | FukuSpendGuard.bumpWalletValidAfter |  | relayer | [`0x21efe34e570625613c2d0c5004f1a7eed00b4b199f95a571ac52da1b65944e3b`](https://testnet.monadvision.com/tx/0x21efe34e570625613c2d0c5004f1a7eed00b4b199f95a571ac52da1b65944e3b) |
| 92 | FukuSpendGuard.bumpWalletValidAfter |  | relayer | [`0xc1270decb49ebf839ac135e7de4768b85057fb9a4eaad95f8d8156597c1f85bc`](https://testnet.monadvision.com/tx/0xc1270decb49ebf839ac135e7de4768b85057fb9a4eaad95f8d8156597c1f85bc) |
| 93 | FukuSpendGuard.bumpValidAfter |  | relayer | [`0x4ef762e3c0e884711091fb8f4819dd8968e86f730f43de9f08a28b5f1cf127a5`](https://testnet.monadvision.com/tx/0x4ef762e3c0e884711091fb8f4819dd8968e86f730f43de9f08a28b5f1cf127a5) |
| 94 | PermissionRegistry.revokePolicy |  | relayer | [`0x69a68bfa9bb764ee0104486ad94eb9a77cc43b78e6475d88c710bfebd9ac7703`](https://testnet.monadvision.com/tx/0x69a68bfa9bb764ee0104486ad94eb9a77cc43b78e6475d88c710bfebd9ac7703) |
| 95 | PermissionRegistry.recordDecision |  | relayer | [`0x3f3d488eed2be64994226246bd60382c5270b75156af45fbd79dd1626c5b500e`](https://testnet.monadvision.com/tx/0x3f3d488eed2be64994226246bd60382c5270b75156af45fbd79dd1626c5b500e) |
| 96 | ReputationRegistry.updateScore |  | relayer | [`0x2156c928de7985b9827789fa83e6480f00107d8e6e856cf53cfb5500b4e514d7`](https://testnet.monadvision.com/tx/0x2156c928de7985b9827789fa83e6480f00107d8e6e856cf53cfb5500b4e514d7) |
| 97 | PermissionRegistry.setPolicy |  | relayer | [`0x6c8e531c274e1de398b1d0c86ca0e989370b160b939dc96b4b71c4d4ba5cf518`](https://testnet.monadvision.com/tx/0x6c8e531c274e1de398b1d0c86ca0e989370b160b939dc96b4b71c4d4ba5cf518) |
| 98 | HumanIdentityRegistry.registerIdentity |  | smoke owner | [`0xa20b6e0099577cec01ac8be48f26e8250b290a104da211701c19cfc7a34f1bfd`](https://testnet.monadvision.com/tx/0xa20b6e0099577cec01ac8be48f26e8250b290a104da211701c19cfc7a34f1bfd) |
| 99 | AgentRegistry.registerAgent |  | smoke owner | [`0x2ead0e1731495433483408d19a41cbd840d5bb705d39289bdf305ebdf1030a02`](https://testnet.monadvision.com/tx/0x2ead0e1731495433483408d19a41cbd840d5bb705d39289bdf305ebdf1030a02) |
| 100 | PermissionRegistry.setPolicy |  | smoke owner | [`0xf315c159432b4b6d49c1fb6c1a43f326b811c868cd82460e114ad18dc218d8b1`](https://testnet.monadvision.com/tx/0xf315c159432b4b6d49c1fb6c1a43f326b811c868cd82460e114ad18dc218d8b1) |
| 101 | PermissionRegistry.recordDecision |  | relayer | [`0x79243544dfd84c6d092259e1952fb7e3517932a2e357d63c26d3d9d329a787ae`](https://testnet.monadvision.com/tx/0x79243544dfd84c6d092259e1952fb7e3517932a2e357d63c26d3d9d329a787ae) |
| 102 | PermissionRegistry.setPolicy |  | smoke owner | [`0x2431fe00b3276286e24ed5ef966093b98c8ac4d56ee44f6362782b9952bd64eb`](https://testnet.monadvision.com/tx/0x2431fe00b3276286e24ed5ef966093b98c8ac4d56ee44f6362782b9952bd64eb) |
| 103 | PermissionRegistry.revokePolicy |  | smoke owner | [`0x8f85c089b3aa68ee376b9dd8ed690c10c1e049d76177487cde9c13a35936389c`](https://testnet.monadvision.com/tx/0x8f85c089b3aa68ee376b9dd8ed690c10c1e049d76177487cde9c13a35936389c) |

**7. Topping up Ava's wallet for the SDK example.** 1 transaction, 0.0022 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 104 | send 0.2 MON to Ava's wallet |  | relayer | [`0x733d0f506de70cdbc93d85b595bb9665e76e88133601a86c04af8ff09c9b0ef0`](https://testnet.monadvision.com/tx/0x733d0f506de70cdbc93d85b595bb9665e76e88133601a86c04af8ff09c9b0ef0) |

**8. `examples/sdk-consumer` against testnet: its own agent, key generated locally (ERC-8004 #1960).** 12 transactions, 0.1883 MON.

| # | Call | Subject | From | Transaction |
| --- | --- | --- | --- | --- |
| 105 | AgentRegistry.registerAgent | the example's agent | relayer | [`0x98ad1713d60e4e7313fc0be1292258d83c50642e73557c6c2ff7a5747650658e`](https://testnet.monadvision.com/tx/0x98ad1713d60e4e7313fc0be1292258d83c50642e73557c6c2ff7a5747650658e) |
| 106 | PermissionRegistry.setPolicy | the example's agent | relayer | [`0xbcfd3eeeab5b2dc1f7483ecd10582e82dac2d94bc0c4dc613de9a79d55271327`](https://testnet.monadvision.com/tx/0xbcfd3eeeab5b2dc1f7483ecd10582e82dac2d94bc0c4dc613de9a79d55271327) |
| 107 | FukuSpendGuard.openMandate | the example's agent | Ava's wallet | [`0x84fa99e0d0887eee7251c88f706cffba7b7d175dca98a5070f128e877523172d`](https://testnet.monadvision.com/tx/0x84fa99e0d0887eee7251c88f706cffba7b7d175dca98a5070f128e877523172d) |
| 108 | FukuSpendGuard.setPayee | the example's agent | Ava's wallet | [`0xdcd03ce92d198d02a2711279e31b92a9b780832adf2907ec599a29486fef2737`](https://testnet.monadvision.com/tx/0xdcd03ce92d198d02a2711279e31b92a9b780832adf2907ec599a29486fef2737) |
| 109 | ERC8004IdentityRegistry.register | the example's agent → #1960 | Ava's wallet | [`0xa1c2ac51f1a4c435e1bee8e129ad9a3bb5a4a2026b12daa4c0c06e6ae7b1971e`](https://testnet.monadvision.com/tx/0xa1c2ac51f1a4c435e1bee8e129ad9a3bb5a4a2026b12daa4c0c06e6ae7b1971e) |
| 110 | ERC8004IdentityRegistry.setAgentWallet | the example's agent → #1960 | Ava's wallet | [`0x05cae08247f1b76317f828b4df56d47d171539145b2f602e27a95d8db08185eb`](https://testnet.monadvision.com/tx/0x05cae08247f1b76317f828b4df56d47d171539145b2f602e27a95d8db08185eb) |
| 111 | FukuSpendGuard.execute | the example's agent | relayer | [`0x20e2bd76cfd394b768e3a6c678a7ac336b1ecad54bf3c7c70ce4c0977d3a931a`](https://testnet.monadvision.com/tx/0x20e2bd76cfd394b768e3a6c678a7ac336b1ecad54bf3c7c70ce4c0977d3a931a) |
| 112 | ReputationRegistry.updateScore | the example's agent | relayer | [`0xeb61cc51f087c13d7f1cf367eeb66321107595a3bb83f23eb51d992dce9e27ed`](https://testnet.monadvision.com/tx/0xeb61cc51f087c13d7f1cf367eeb66321107595a3bb83f23eb51d992dce9e27ed) |
| 113 | FukuSpendGuard.bumpValidAfter | the example's agent | relayer | [`0x41324391e81b7cf84c1f2565a3381260b413740e775e96fd74b4d6963290beb8`](https://testnet.monadvision.com/tx/0x41324391e81b7cf84c1f2565a3381260b413740e775e96fd74b4d6963290beb8) |
| 114 | PermissionRegistry.revokePolicy | the example's agent | relayer | [`0xf9c5eedda1567205bfc80a91e3e3b06a427964999b5bd213cb2f087bfb8a5bbf`](https://testnet.monadvision.com/tx/0xf9c5eedda1567205bfc80a91e3e3b06a427964999b5bd213cb2f087bfb8a5bbf) |
| 115 | PermissionRegistry.recordDecision | the example's agent | relayer | [`0x2423a4cb9d6f5e7f18c6a75a15cd934ca04f8348c23bcc16958edbbd271f0ecf`](https://testnet.monadvision.com/tx/0x2423a4cb9d6f5e7f18c6a75a15cd934ca04f8348c23bcc16958edbbd271f0ecf) |
| 116 | ReputationRegistry.updateScore | the example's agent | relayer | [`0x9cba5864ea1abf12160f98b725c229856d3f79c6a8e023d48436de7c1035ae1f`](https://testnet.monadvision.com/tx/0x9cba5864ea1abf12160f98b725c229856d3f79c6a8e023d48436de7c1035ae1f) |

</details>

## 5. Sponsor mapping

Source of truth: `web/src/lib/integrations/index.ts`, rendered on the Developer Console.

| Sponsor | Category | What it does in Fuku | Live when | Otherwise |
| --- | --- | --- | --- | --- |
| Monad | Settlement | Identity, agent, permission and reputation registries; a tx per decision and per score change; FukuSpendGuard for A-Token transfers. | `FUKU_CHAIN_MODE=live` plus the signer key and addresses, and a write actually mined by this server (the card says configured until then, and shows the last failure). | Proof hashes computed locally, receipts labelled mock (no explorer link). |
| Dynamic | Identity | Email sign-in with an embedded EVM wallet (Dynamic JavaScript SDK 1.34, headless), on the sign-in page and as "Connect wallet with Dynamic" on the Identity page. The server verifies Dynamic's JWT (RS256 against the environment JWKS, issuer, `user:basic` scope) before issuing a Fuku session, and takes the wallet only from the token's verified credentials. The wallet becomes the identity's owner wallet. | `NEXT_PUBLIC_DYNAMIC_ENV_ID` plus a Dynamic token verified by this server (configured until then). | Passkey sign-in. Email sign-in alone does not mark an identity human-verified; only a passkey does. |
| Nansen | Data | Behavioural risk signals for agent wallets, shown on the Reputation report; the integration board shows the plan and remaining credits from Nansen's free `account` endpoint. | `NANSEN_API_KEY` (verified live) plus at least 100 Nansen credits per wallet-label lookup (`POST /profiler/address/labels`, chain from `NANSEN_CHAIN`, default `monad`, cached per address for a day). | Below 100 credits, or without a key: signals derived from Fuku's ledger (violation ratio, security events, agent age, volume), with the reason printed on the card. |
| Envio | Data | HyperSync: on-chain history of identities, agents, passports, decisions and scores from the Fuku registries. HyperRPC: per-decision proof verification against Monad. | `ENVIO_API_TOKEN` (HyperSync) and `ENVIO_HYPERRPC_TOKEN` (HyperRPC), both configured and verified. | Without tokens: activity from the local ledger only. |
| Kimi | AI | Trust explanations for decisions and scores (OpenAI-compatible chat, 9 s timeout). | `KIMI_API_KEY` and a call that succeeded (configured until then; the adapter has not been exercised with a real key). | Deterministic rule narrator. |
| Qwen | AI | Policy interpretation and explanations (same adapter, tried after Kimi). | `QWEN_API_KEY` and a call that succeeded (same caveat). | Deterministic rule narrator. |
| Chainlink CRE | Automation | `fuku-guard` workflow: request (HTTP trigger), verify (Fuku API: human owner, trust score, dry run; low-trust agents are rejected before execution), execute (Fuku API, one call across the DON), record (EVM read of PermissionRegistry and ReputationRegistry on monad-testnet). Actions it submits are tagged "via Chainlink CRE" in the activity timeline. | `CRE_WORKFLOW_ID` from `cre workflow deploy`, which Chainlink gates behind a commercial agreement (hackathons simulate). | Runs end to end with `cre workflow simulate`; the in-app seven-step trace runs on every action regardless. |
| Cleanverse | Credentials | A-Pass (CVI) and A-Token (CVA) checks before an agent moves value: asset rule (R9), owner A-Pass (R7), recipient A-Pass (R8), evidence hashed into the attestation that FukuSpendGuard verifies; the owner's A-Pass card on the Identity page. | Live only after a call to the cooperate API has succeeded with `CLEANVERSE_API_ID` and `CLEANVERSE_API_KEY` (the card says "configured" before that). | Simulated, "API invite pending": Fuku's simulator contracts (live chain) or DB fixtures (mock chain), labelled "Cleanverse simulator" in the UI and `mode: "simulated"` in the SDK. |

---

## 6. Likely judge questions

**1. Why not just a wallet policy or a smart-account spending limit?**
A wallet policy binds to one key on one chain and only sees value transfers. Fuku's passport binds to an agent identity owned by a verified human, covers non-financial actions too (read vault, web search, email draft, sign message), carries an app scope, and produces a decision log and a score that third parties can query with `verifyAgent`. Wallet policies are a good enforcement backend for the value actions; Fuku is the identity and reputation layer above them.

**2. Why does this need to be on-chain at all?**
So a counterparty does not have to trust Fuku's database. The policy hash and version, every allow or deny decision with its rule id and proof hash, and every score update are events any indexer can read. The proof hash is keccak256 of the decision record, so an auditor can recompute it. Off-chain we keep the readable policy and the plain-text reasons; on-chain we keep the commitments.

**3. How does a third party verify an agent?**
`fuku.verifyAgent(agentId)` with an API key returns the owner (human-verified or not, auth method), the passport (allowed, blocked, scope), the trust score and level, and the bytes32 on-chain ids of both the agent and the owner, so the caller can cross-check the registries once they are live. `checkPermission` is a dry run that records nothing.

**4. What stops a malicious owner?**
Fuku does not claim to stop a bad human; it makes them accountable. Every agent is bound to a human identity, every policy change is versioned and hashed, and every violation is counted on the agent and visible to anyone who asks. On-chain, only the identity controller can set or revoke a policy, and decisions can only be recorded by that controller or an allow-listed enforcer. Today the Fuku relayer holds those roles; moving the controller to the owner's own key is the next step.

**5. How does the score resist gaming?**
Every term is bounded: completed actions cap at +35, violations subtract up to 40, security events cost 10 each, and the result is clamped to 0 to 100. Since fuku-score/2, only a transfer confirmed on-chain by the guard counts as a completed action, once per action id. Reads, dry runs, mock settlements, retried requests and allowed decisions Fuku does not execute earn nothing, so volume cannot be farmed. Blocks caused by the owner or the infrastructure (no passkey, the owner's A-Pass, a provider outage) are neutral. The report states the evidence count, observation period and uncertainty. Honest limitation: the relayer is the scorer, so the on-chain score is Fuku's statement, recomputable from the ledger but not independently derived.

**6. How private is the memory vault?**
The server stores only ciphertext and IVs (the memory API only accepts ciphertext). The key is derived in the browser with PBKDF2 (100,000 iterations, SHA-256, salted with the identity id) into AES-GCM-256, and decryption happens in the browser. Applications get vault access through requests the owner approves on the Memory Vault page. Nothing from the vault goes on-chain. Each owner chooses a passphrase (at least 10 characters) the first time they open the vault; Fuku never receives it and cannot recover it, and the key lives only in the open tab. Honest limitations: the seeded demo identity opens with a public demo passphrase so the demo works without setup (the page says so), and item titles are stored in clear.

**7. What does ERC-8004 compatibility mean here?**
Fuku's agents are registered in the standard's own registry. The five demo agents hold ERC-8004 agent ids 1955 to 1959 on the canonical Identity Registry on Monad testnet (0x8004A818BFB912233c491871b3d84c89A494BD9e, `getVersion()` 2.0.0).
- Each agent NFT is owned by Ava's wallet.
- Each `agentWallet` is the agent's own key, bound with the EIP-712 `AgentWalletSet` signature the registry checks.
- The agentURI is the registration file, served as a `data:` URI until the app has a public URL.

Any developer can do the same through the SDK with a key that never leaves their process (`examples/sdk-consumer`, agent 1960).

What is not claimed: Fuku's own four registries do not implement the ERC-8004 interfaces, and Fuku does not use the ERC-8004 reputation or validation registries yet. `AgentRegistry` follows the same shape (owner-bound record, metadata URI, capabilities hash, lifecycle status), so adopting them is a contained change.

**8. What is the business model?** (proposed; nothing in the repo monetises)
The Developer Console already issues API keys, so the natural model is usage-based: free for owners, metered `verifyAgent`, `checkPermission` and `executeAction` calls for applications, and paid policy features for teams running agent fleets.

**9. What would you build next?**
Cleanverse live once the API invite lands (the client and checklist are ready). Move the remaining custodial identities to their owners' wallets (re-key plan in `docs/MIGRATION.md`). An independent verifier for the human flag. Run Envio HyperIndex for a GraphQL API over the registry events. Deploy the `fuku-guard` CRE workflow to the DON after a commercial agreement with Chainlink (the deploy script is ready). ERC-8004 interface conformance. Risk-weighted scoring. A passkey-derived vault key as an alternative to the passphrase. Publish `@fuku/sdk` to npm.

**10. How are daily limits enforced?**
Per agent and per action type. Before evaluating a value action (swap, withdraw, transfer, stake), Fuku reads that agent's spend of the same type since midnight UTC, in integer base units, and blocks with rule R5 when the amount exceeds the limit minus what was spent. An allowed action then reserves its amount with one conditional database update, so two concurrent requests cannot both spend the remainder; a failed execution gives it back. In the seed, Trading Assistant may swap 5,000 USDC a day and has already swapped 1,200 today, so 3,800 remains. Blocked attempts do not consume budget. For A-Token transfers there is a second, on-chain limit: FukuSpendGuard enforces the owner's mandate cap per agent, wallet and UTC day in token base units (plus a per-transfer limit and approved payees), atomically with the transfer.

**11. Is this real Cleanverse?**
The integration code is real; the answers are not Cleanverse's yet, and the product says so. Fuku has a client for Cleanverse's cooperate API (`query_apass`, `verify_apass`, `atoken/rules`, the A-Token list, Travel Rule), with the envelope, encryption and fail-closed code mapping, tested against a fake server. API access is invite-only and ours is pending, so a Fuku-built simulator answers today: an A-Pass contract and an `aUSDC-SIM` token with the same verify codes, or DB fixtures when the chain is mocked. The UI badges it "Cleanverse simulator", the SDK returns `mode: "simulated"`, and the integration card reads "API invite pending". What does not depend on Cleanverse is real on the chain we run: FukuSpendGuard checks the attestation, the agent's status, the current passport hash, the owner's mandate and the daily cap before the token moves. When the invite lands, it is credentials plus the checklist in `docs/CLEANVERSE.md`.

**12. What can the Fuku server still do on its own?**
More than we would like, and we list it in `docs/SECURITY.md`. The relayer key owns the four registries and is every identity's on-chain controller, so it could record any decision or score. Fixing that means redeploying the registries with owner-controlled identities, which is an open decision. For money it cannot do what it likes: a transfer needs a mandate the owner's own wallet opened, and the guard enforces the token, daily cap, per-transfer limit, expiry, approved payees, active agent, current passport hash and a single-use action. A stolen compliance key is bounded by those limits.

---

## 7. Ask and next steps

**Ask.**
- Monad: testnet support for deployment, and feedback on the registry design and ERC-8004 alignment.
- One design partner (a Monad DEX or an agent framework) to integrate `verifyAgent` and `checkPermission` before an agent touches funds.
- Sponsor keys (Kimi or Qwen) and Nansen credits so the integration board goes live for real.

**Next two weeks.**
1. Serve the ERC-8004 registration file from a public URL, and move the registered agents to it with `setAgentURI`.
2. Owner-controlled keys as identity controller; an independent verifier for the human flag.
3. Serve the whole activity timeline from the Envio index instead of the local ledger.
4. Publish `@fuku/sdk` to npm with its 20 public v1 endpoints documented.
5. Risk-weighted scoring and a rolling 24-hour limit window.

---

## Cara membawakannya (tips untuk founder)

**Bingkai ceritanya dengan tiga pertanyaan.** Siapa manusia di balik agen ini, agen ini boleh apa, dan bisa dipercaya atau tidak. Ucapkan di pembukaan, ulangi di penutup. Kalau perlu analogi: Fuku itu paspor sekaligus SIM untuk agen AI. Paspor bilang siapa pemiliknya, SIM bilang boleh "nyetir" apa, dan catatan pelanggarannya ikut ke mana pun dia pergi.

**Kalimat kunci yang harus keluar.** "The passport is the product." "Deny by default." "Nothing left Ava's control." "Every sponsor card reports live or simulated." Juri mengingat kalimat pendek, bukan paragraf.

**Sebelum naik panggung.**
- Buka `http://localhost:3001/api/auth/demo?reset=1&next=/sign-in` sekali, supaya skor Trading Assistant kembali ke 96. Setiap kali demo dijalankan tanpa reset, skor turun 4 lagi.
- Pakai tombol **Try the demo as Ava Chen** kecuali kamu sudah latihan **Create with passkey** dengan Windows Hello di laptop yang sama. Passkey asli mengesankan, tapi kalau gagal di depan juri, momentum hilang.
- Latihan penuh minimal tiga kali dengan stopwatch. Target 2:50, bukan 3:00.

**Saat demo.**
- Jangan klik link explorer selama mode mock. Transaksinya tidak ada di explorer. Klik hanya kalau dialog hasil menulis "Monad transaction", bukan "Monad receipt (mock)".
- Kalau juri membaca catatan "Mock settlement" di dialog, jawab jujur dan singkat: "Settlement hari ini mock. Kontraknya ada di Monad testnet, 72 test kontrak lulus, dan `npm run wire:env` membuat app-nya live." Jujur lebih menang daripada mengaku-aku.
- Biarkan dialog hasil terbuka sekitar sepuluh detik. Sebut "rule R2" dengan jelas, lalu bacakan satu kalimat penjelasannya. Itu bagian yang paling gampang diingat.
- Di beat Cleanverse, ucapkan kata "simulator" dengan jelas dan tunjuk badge "Cleanverse simulator". Jangan pernah bilang A-Pass itu diterbitkan Cleanverse selama kartunya masih "API invite pending".
- Di Developer Console, jangan buru-buru scroll. Tunjuk kartu yang bertulis "simulated" dan bilang itu disengaja: juri menghargai kejujuran.

**Ringkasan cara uji di Monad testnet** (detail lengkap di bagian 4, runbook).
- Isi `contracts/.env` dengan key baru yang sudah diisi MON dari faucet, lalu `npm run check:deployer` untuk memastikan chain 10143 dan saldo cukup.
- `npm run deploy:monad`, lalu `npm run wire:env` supaya `web/.env` otomatis berisi mode live, key, dan empat alamat registry. Restart dev server.
- Cek Developer Console: pil di sebelah "Integration status" harus bertulis "live settlement".
- Pemanasan: jalankan satu aksi di Trading Assistant dulu (tombol **Run demo flow** di sandbox), karena aksi live pertama untuk data seed akan menambah tiga transaksi di depan. Setelah itu buka link `?reset=1`.
- Kalau ingin pakai identitas passkey baru di mode live, angkanya jadi 50 setelah register (belum ada A-Pass), 55 setelah passport disetujui, 51 setelah withdraw diblokir. Sebutkan angka itu sebelum mulai supaya juri tidak bingung. Setiap langkah menunggu receipt, jadi isi jeda dengan narasi, jangan diam.

**Menjawab pertanyaan juri.** Satu kalimat inti dulu, baru detail kalau diminta. Kalau sesuatu belum ada di kode, bilang "belum, itu langkah berikutnya" dan sebut langkahnya. Jangan pernah bilang integrasi live kalau kartunya masih simulated.

**Cadangan kalau UI bermasalah.** Sandbox di Developer Console menjalankan alur yang sama lewat API publik. Simpan juga screenshot dialog hasil (blocked R2) dan halaman Reputation (96 ke 92) di folder yang gampang dibuka.
