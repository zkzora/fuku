# Fuku Protocol: Hackathon Pitch

Track: Trust, Identity & AI Infrastructure on Monad.
Audience: the judges, and the founder who delivers it.
Every claim below was checked against the code in this repository on 2026-09-30. Where something is simulated, this document says so. `docs/SECURITY.md` lists what the server can still do on its own; read it before answering trust questions.

---

## 1. One-liner and the 30-second version

**One-liner.** Fuku is the trust layer for AI agents on Monad: a passkey-verified owner, a permission passport that says what the agent may do, an on-chain guard that enforces the owner's limits when an agent moves money, and a portable trust score, with every decision hashed and anchored.

**30 seconds.**

"AI agents are starting to hold money, keys and calendars, and nobody can answer three questions about an agent: who is the human behind it, what is it allowed to do, and should I trust it. Fuku answers all three. A human creates an identity with a passkey. They register their agent and approve a permission passport: allowed actions, daily USDC limits, hard blocks, app scope. Every action the agent attempts runs through a deterministic engine that allows or blocks it with a rule id, anchors a proof on Monad, updates an explainable trust score and explains the outcome in plain language. Any application can verify an agent with one SDK call. Identity, permissions, reputation: one primitive, built on Monad."

Settlement status (2026-09-24): the four registries are deployed on Monad testnet (chain 10143, `contracts/deployments/monadTestnet.json`) and the app runs in live mode, so "anchors a proof on Monad" is literally true; every receipt links to a real transaction on testnet.monadexplorer.com. Keep the mock-mode substitutions in section 2 only as a contingency if the deployer wallet runs out of MON or the RPC is down on the day. The Cleanverse simulator and FukuSpendGuard are not on Monad testnet yet: they were verified on a local node, and deploying them to the existing testnet stack is four transactions that still need a go-ahead (section 4, step 5).

---

## 2. Three-minute talk track (synchronised with the live demo)

**Before you walk on.** Open `http://localhost:3001/api/auth/demo?reset=1&next=/sign-in` once. This reseeds Ava Chen so the Trading Assistant starts at 96, then lands on the sign-in page. Leave that tab open. The supplier-payment beat needs the Cleanverse simulator and FukuSpendGuard on the chain you present on, plus `npm run cleanverse:setup` once (section 4). Without them the preset is blocked with R7 `PROVIDER_OFF`, so skip that beat. The same condition affects the score: 10 of the Trading Assistant's 96 points are Ava's Cleanverse A-Pass, so on a live chain with Cleanverse off the dashboard shows 86 (and 82 after the climax). Say those numbers instead, or present in mock mode, where the simulator fixtures answer. Spoken words below: 342, which leaves room to breathe. The lines are written for live settlement; if the Monad card still says simulated on the day, apply the three substitutions listed after the talk track.

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
- The AgentRegistry follows the ERC-8004 direction (owner-bound agent record, metadata URI, capabilities hash, lifecycle status), so Fuku agents can line up with the emerging EVM agent-identity standard rather than a proprietary format.
- Illustrative scale, not a measurement: the seeded demo holds 25 decisions across one person's agents over one week. A fleet of agents acting for thousands of owners is thousands of decisions per day, each one an on-chain event.

---

## 4. Architecture in five lines, and the honest state of the build

1. **Identity.** A passkey (WebAuthn via `@simplewebauthn`, user verification required, origins pinned) creates a Fuku identity. The passkey public-key hash and a proof hash are anchored in `HumanIdentityRegistry`, and the flag Fuku still calls `humanVerified` is set on-chain in live mode. It means "a passkey ceremony with a PIN or biometric succeeded": not KYC, and not proof of a unique person. The owner wallet counts only once control is proven, through a verified Dynamic credential or a signed binding message.
2. **Agents.** `AgentRegistry` binds each agent to its owner identity: name, version, capabilities hash, metadata URI, status (Registered, Active, Paused, Revoked).
3. **Permissions.** A passport (allowed rules with optional daily USDC limits, a block list, scope apps, and optionally Cleanverse A-Tokens) is evaluated by a deterministic engine with rules R0 to R6, plus R7 to R10 for transfers on A-Token passports; the policy hash and version go to `PermissionRegistry`, and every decision emits `ActionDecision(agentId, actionHash, allowed, proofHash, ruleId)`. A-Token transfers move through `FukuSpendGuard`, which enforces on-chain the mandate the owner's own wallet opened (token, UTC daily cap, per-transfer limit, expiry, approved payees), the agent's status, the current passport hash and a single-use action hash. R11 blocks value actions for an owner without a passkey ceremony; R12 requires a complete request and a daily limit.
4. **Reputation (fuku-score/2).** Score = 40 baseline + 10 passkey-verified owner + 10 Cleanverse A-Pass on the owner's verified wallet + 5 active passport + 2.5 per completed action (max 35) minus 4 per violation (max 40) minus 10 per security event, clamped to 0 to 100. Only a transfer confirmed on-chain counts as a completed action from now on. Allowed decisions Fuku does not execute, dry runs, mock settlements and reads earn nothing; the seeded history keeps its legacy successes. The report adds dimensions, evidence count, observation period and uncertainty. The latest score is written to `ReputationRegistry` by an allow-listed scorer.
5. **Surface.** Next.js app, public v1 API with hashed API keys, `@fuku/sdk`, Envio HyperSync indexing the four registries (Activity → On-chain) plus HyperRPC proof verification, an Envio HyperIndex config, Kimi/Qwen explanations with a rule-based fallback, and an AES-GCM encrypted memory vault.

### What is real today

| Component | State |
| --- | --- |
| Passkey identity | Real WebAuthn registration and login with user verification required, origins pinned and one-time challenges; the stored passkey keeps its signature counter. The identity is "passkey-verified", which is never presented as proof of a unique person. |
| Permission engine | Deterministic; every decision is attributed to a rule id. R0 to R6 as before (R4 now also blocks a scoped passport when the app is omitted); R11 (owner not passkey-verified) and R12 (incomplete request or limitless value rule) for value actions; R9, R7, R8 (Cleanverse) and R10 (on-chain guard) for A-Token transfers. Daily limits are integer base units per UTC day, reserved atomically. |
| Trust score | fuku-score/2: the six-line breakdown plus dimensions, evidence count, observation period, scoring version and uncertainty, served by the UI, the session API and the public API. Seeded numbers are unchanged (96 → 92). |
| Solidity registries | Four registries plus FukuSpendGuard v2 (owner-bounded mandates, single-use actions) and two Cleanverse simulators in Hardhat 3, Solidity 0.8.28, 59 passing tests, deploy scripts with role grants, ABI export, pre-flight and env-wiring scripts. Only the four registries are on testnet (`contracts/deployments/monadTestnet.json`: HumanIdentityRegistry 0x9fe8…4a2b, AgentRegistry 0x41a1…5e29, PermissionRegistry 0xfe5c…46cc, ReputationRegistry 0x33a2…efad), verified end to end against it with `web/scripts/live-smoke.mjs` on 2026-09-24. |
| Settlement adapter | Live path simulates each call before sending (reverts decode to the contract's custom errors), stores a guarded transfer's hash as soon as it is broadcast, waits for the receipt, and anchors missing identities, agents and passports lazily. A live failure is recorded as `failed` and a timeout as `pending`, never as a mock receipt; `npm run reconcile` settles them, recovers crashed transfers through the guard and handles reorgs. One signer, serialised across processes by a database lease. Proven on a local Hardhat node with `web/scripts/live-smoke.mjs` (45 checks). |
| SDK | `@fuku/sdk` 0.3.0, built to `dist/`. Ten methods, including `getAction` (lifecycle and evidence) and `getMandate`; idempotency keys; structured error codes. Eight contract tests. `examples/sdk-consumer` runs the whole flow against a local node: 17 steps, including independent on-chain verification of the transfer. |
| Proofs | `proofHash = keccak256` of the decision record (agent, action, amount, app, decision, rule id, policy hash, timestamp, plus the Cleanverse `complianceRef` when evidence exists); a workflow trace on every action. |
| Cleanverse CVI / CVA | Real integration code: cooperate API client (envelope, AES-CBC bodies, fail-closed code mapping), asset / owner / recipient checks, evidence hashed into a `complianceRef`, A-Pass reads persisted, UI and SDK. The live API has never been called (invite pending); answers come from a Fuku-built simulator, labelled everywhere. See `docs/CLEANVERSE.md`. |
| Authorization | One path for the web app, the API, the SDK and CRE: an owner, an identity the caller created, or an owner-granted delegation with scopes (register, manage, execute). Invalid API keys are 401 with no session fallback. Rate limits per process. The demo sign-in and demo key are off in production unless explicitly enabled. |
| Execution lifecycle | DENIED, AUTHORIZED, SUBMITTED, CONFIRMED, PENDING, FAILED and SIMULATED are stored with receipt mode, chain id, block and log index; `Idempotency-Key` replays instead of executing twice. |
| Memory vault | AES-GCM-256 with a PBKDF2 key (100,000 iterations) derived in the browser; the server stores ciphertext and IVs only. Today there is no passphrase prompt: every identity derives its key from the fixed `DEMO_VAULT_PASSPHRASE` constant, so the encryption is structural, not yet a secrecy guarantee. |

### What is simulated until keys are configured

| Component | Today | What flips it |
| --- | --- | --- |
| Monad settlement | Mock receipts with a deterministic proof hash. The explorer link in a mock receipt does not resolve. | One deploy and one `npm run wire:env` away (it writes `FUKU_CHAIN_MODE=live`, the signer key and the four `FUKU_*_REGISTRY` addresses). Do not call this "one env var". |
| AI explanations | Rule-based narrator (`fuku-rules`). | Literally one env var: `KIMI_API_KEY` or `QWEN_API_KEY`. The adapter has not been exercised with a real key; on any error it falls back to the narrator. |
| Nansen | Key configured and verified against the live API (free plan). Wallet-label lookups cost 100 Nansen credits each, so until the account holds at least 100 credits the Reputation card shows ledger-derived signals and says so. | Top up Nansen credits (or Pro plan); the code path is exercised and cached per address for a day. |
| Envio | Live. HyperSync indexes every Fuku registry event on Monad testnet for the signed-in identity and its agents (Activity → On-chain · Envio, with block times and explorer links). HyperRPC verifies a single decision: its receipt, its ActionDecision event, and that the on-chain proof hash equals the Fuku ledger ("Verify on-chain" on an activity row). The HyperIndex config in `/indexer` carries the real addresses but is not run (it needs Docker). | Nothing for the demo. Running HyperIndex would add a GraphQL API over the same events. |
| Privy | Not integrated: an app id is configured, but there is no Privy client or server code, so the card reads "configured" or "off", never live. | Real integration work, not just a key. Say so if asked. |
| Cleanverse | Simulated, "API invite pending". With a live chain, Fuku's `CleanverseAPassSim` and `CleanverseATokenSim` (aUSDC-SIM) answer; with a mocked chain, DB fixtures with the same semantics do. Verified end to end on a local node (36/36 smoke), not yet deployed to Monad testnet. | The API invite, then the checklist in `docs/CLEANVERSE.md` (`npm run cleanverse:check` first). For the simulator on testnet: `npm run deploy:cleanverse:monad` (four transactions, needs the owner's go-ahead). |
| Mera | Not integrated: passkeys are standard WebAuthn through `@simplewebauthn`, and no Mera SDK or API is called, so the card reads off. | A Mera SDK integration. |
| Chainlink CRE | Real workflow in `cre/fuku-guard` (TypeScript, CRE SDK 1.22): HTTP trigger, verify through the Fuku API, execute, then an EVM read of the Monad registries through the DON. Proven with `cre workflow simulate` against the live app: a blocked withdraw produced a real Monad transaction and CRE read back the matching score. Not deployed to the DON: Chainlink answered our access request (2026-09-24) that hackathon teams simulate locally, and that testnet or mainnet deployment goes through a commercial call and an MNDA. | A commercial agreement with Chainlink, then `node cre/deploy.mjs` (tunnel, secret, deploy, `CRE_WORKFLOW_ID`) is ready to run. |
| On-chain human flag | In live mode the app sets `setHumanVerified` itself, because its signer is the registry owner (the verifier role). | An independent verifier holding that role is future work. |
| Signing model | In live mode the relayer key is registry owner, identity controller, enforcer and scorer, so it can record any decision or score. The compliance signer attests guarded transfers, but only inside the mandate the owner's own wallet opened (token, cap, per-transfer limit, expiry, payees). The owner's wallet signs the approval, the mandate and the payee list. | Owner-controlled identity keys, which need a registry redeploy (an open decision). |
| Seeded demo data | Ava Chen, her four agents and their history are seeded; their tx hashes are placeholders. In live mode they are anchored lazily on the first write (extra transactions on that first action). | Pre-warm before the pitch (see the runbook). |

### Going live on Monad testnet before the demo (the founder's runbook)

1. Generate a fresh key and fund it from the Monad faucet (`https://faucet.monad.xyz`). Never reuse a mainnet key.
2. `contracts/.env`: `DEPLOYER_PRIVATE_KEY=0x...` and `MONAD_RPC_URL=https://testnet-rpc.monad.xyz`.
3. `cd contracts && npm install && npm test` (59 passing), then `npm run check:deployer`. It derives the address, confirms chain id 10143 and a non-zero MON balance, and warns below 0.1 MON. A full deploy sends ten transactions (seven deploys, three role grants).
4. `npm run deploy:monad`. It deploys the four registries in order, grants the deployer the enforcer and scorer roles, deploys the two Cleanverse simulators and FukuSpendGuard (compliance signer from `COMPLIANCE_SIGNER_ADDRESS`, else the deployer with a warning), makes the guard an enforcer, and writes `contracts/deployments/monadTestnet.json`. For the stack that is already on testnet, `npm run deploy:cleanverse:monad` adds only the three new contracts and the enforcer grant (four transactions) and never touches the registries.
5. `npm run wire:env`. It backs up `web/.env` to `web/.env.bak`, then upserts `FUKU_CHAIN_MODE=live`, `FUKU_CHAIN_ID=10143`, `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, the four `FUKU_*_REGISTRY` lines and, when deployed, `FUKU_SPEND_GUARD`, `CLEANVERSE_SIM_APASS` and `CLEANVERSE_SIM_ATOKEN` (plus `FUKU_COMPLIANCE_SIGNER_KEY` from `contracts/.env`). Then, for the supplier-payment beat, add `DEMO_OWNER_PRIVATE_KEY` (a fresh testnet key for Ava's wallet) to `web/.env` and run `cd web && npm run cleanverse:setup`: it issues the simulator A-Passes, mints 10,000 aUSDC-SIM to Ava, tops up her gas, and opens the 1,000/day mandate. Preview first with `node scripts/wire-env.mjs --dry-run`. The web signer must be the account that deployed, because it holds the owner, enforcer and scorer roles; `wire:env` copies the same key.
6. Restart the dev server (`cd web && npm run dev -- -p 3001`); env is read at startup.
7. Check: Developer Console, the pill next to "Integration status" reads "Monad Testnet · chain 10143 · live settlement" and the Monad card says live. `curl http://localhost:3001/api/integrations` shows `chain.mode: "live"` and the signer address.
8. Produce a real receipt: **Create with passkey** (`registerIdentity` then `setHumanVerified`), **Register agent** (`registerAgent`), **Approve passport** (`setPolicy`), then run a withdraw of 4,800 from the Permission Manager's "Test an action against the passport" form (`recordDecision` then `updateScore`; the dashboard preset only targets Trading Assistant). The result dialog now says "Monad transaction" and the link opens on `testnet.monadexplorer.com`. Each write waits for its receipt (up to 90 seconds), so expect a short pause per anchor.
9. Pre-warm the seeded demo. Ava Chen and Trading Assistant were never anchored, so their first live action adds three transactions in front (`registerIdentity`, `setHumanVerified`, `registerAgent`) and the receipt notes "Anchored first: ...". Run one action on Trading Assistant before the pitch (the sandbox's **Run demo flow** does it), then open the `?reset=1` link. The on-chain records survive the reseed because the ids are fixed, so the live demo action is two transactions again.
10. Rehearse without testnet if you want: `npx hardhat node` in `contracts/`, `COMPLIANCE_SIGNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 npx hardhat run scripts/deploy.ts --network localhost` (account #1 is the compliance signer, account #2 is Ava for `DEMO_OWNER_PRIVATE_KEY`; `docs/CLEANVERSE.md` has the full local run), then wire the web app to the node's account #0 for that run only: `DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 MONAD_RPC_URL=http://127.0.0.1:8545 npm run wire:env -- --network localhost` (without those two overrides `wire:env` writes the testnet RPC and refuses to run without a key), and set `FUKU_CHAIN_NAME="Hardhat local"` in `web/.env`. Same code path, chain id 31337, receipts are real but the explorer link points at Monad's explorer and will not resolve. Re-run `npm run wire:env` with no overrides to point back at testnet.
11. Optional: open Activity → On-chain · Envio to show the same decisions read back from Monad by Envio HyperSync, and press Verify on-chain on the fresh blocked withdraw (Envio HyperRPC).
12. Never commit `web/.env`, `web/.env.bak` or `contracts/.env`.

---

## 5. Sponsor mapping

Source of truth: `web/src/lib/integrations/index.ts`, rendered on the Developer Console.

| Sponsor | Category | What it does in Fuku | Live when | Otherwise |
| --- | --- | --- | --- | --- |
| Monad | Settlement | Identity, agent, permission and reputation registries; a tx per decision and per score change; FukuSpendGuard for A-Token transfers. | `FUKU_CHAIN_MODE=live` plus the signer key and addresses, and a write actually mined by this server (the card says configured until then, and shows the last failure). | Proof hashes computed locally, receipts labelled mock (no explorer link). |
| Mera | Identity | Not integrated. Passkey onboarding uses standard WebAuthn (P-256, user verification) without any Mera SDK or API. | Never, until a Mera SDK is integrated. | The card reads off. |
| Privy | Wallet | Not integrated (no client or server code). | Never, until the code exists. | Configured when an app id is set, off otherwise. |
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
The server stores only ciphertext and IVs (the memory API only accepts ciphertext). The key is derived in the browser with PBKDF2 (100,000 iterations, SHA-256, salted with the identity id) into AES-GCM-256, and decryption happens in the browser. Applications get vault access through requests the owner approves on the Memory Vault page. Nothing from the vault goes on-chain. Honest limitation: there is no passphrase prompt yet, so every identity, not only the seeded demo, derives its key from the fixed `DEMO_VAULT_PASSPHRASE` constant in the source. The architecture is end-to-end encryption; the secrecy arrives with a per-user passphrase or a passkey-derived key, which is on the next-steps list.

**7. What does ERC-8004 compatibility mean here?**
Direction, not conformance. `AgentRegistry` follows the ERC-8004 shape: an agent record bound to an owner, with a metadata URI, a capabilities hash and a lifecycle status, keyed by bytes32 ids. It does not yet implement the standard's interfaces or its reputation and validation registries. Adopting them is a contained change because the app reaches the registries through one adapter.

**8. What is the business model?** (proposed; nothing in the repo monetises)
The Developer Console already issues API keys, so the natural model is usage-based: free for owners, metered `verifyAgent`, `checkPermission` and `executeAction` calls for applications, and paid policy features for teams running agent fleets.

**9. What would you build next?**
Cleanverse live once the API invite lands (the client and checklist are ready). Owner-controlled keys as the on-chain identity controller (passkey-signed or a Privy embedded wallet) instead of the relayer. An independent verifier for the human flag. Run Envio HyperIndex for a GraphQL API over the registry events. Deploy the `fuku-guard` CRE workflow to the DON after a commercial agreement with Chainlink (the deploy script is ready). ERC-8004 interface conformance. Risk-weighted scoring. A per-user vault passphrase (or a passkey-derived key) in place of the fixed demo constant. Publish `@fuku/sdk` to npm.

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
- Sponsor keys (Kimi or Qwen, Privy) and Nansen credits so the integration board goes live for real.

**Next two weeks.**
1. Deploy the registries to Monad testnet and switch the app to live settlement.
2. Owner-controlled keys as identity controller; an independent verifier for the human flag.
3. Serve the whole activity timeline from the Envio index instead of the local ledger.
4. Publish `@fuku/sdk` to npm with the seven endpoints documented.
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
- Kalau juri membaca catatan "Mock settlement" di dialog, jawab jujur dan singkat: "Settlement hari ini mock. Kontraknya ada, 59 test lulus, satu deploy plus `npm run wire:env` membuatnya live." Jujur lebih menang daripada mengaku-aku.
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
