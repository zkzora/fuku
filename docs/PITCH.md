# Fuku Protocol: Hackathon Pitch

Track: Trust, Identity & AI Infrastructure on Monad.
Audience: the judges, and the founder who delivers it.
Every claim below was checked against the code in this repository on 2026-09-23. Where something is simulated, this document says so.

---

## 1. One-liner and the 30-second version

**One-liner.** Fuku is the trust layer for AI agents on Monad: a verified human owner, a permission passport that says what the agent may do, and a portable trust score, with every decision hashed and anchored.

**30 seconds.**

"AI agents are starting to hold money, keys and calendars, and nobody can answer three questions about an agent: who is the human behind it, what is it allowed to do, and should I trust it. Fuku answers all three. A human creates an identity with a passkey. They register their agent and approve a permission passport: allowed actions, daily USDC limits, hard blocks, app scope. Every action the agent attempts runs through a deterministic engine that allows or blocks it with a rule id, anchors a proof on Monad, updates an explainable trust score and explains the outcome in plain language. Any application can verify an agent with one SDK call. Identity, permissions, reputation: one primitive, built on Monad."

Settlement status (2026-09-24): the four registries are deployed on Monad testnet (chain 10143, `contracts/deployments/monadTestnet.json`) and the app runs in live mode, so "anchors a proof on Monad" is literally true; every receipt links to a real transaction on testnet.monadexplorer.com. Keep the mock-mode substitutions in section 2 only as a contingency if the deployer wallet runs out of MON or the RPC is down on the day.

---

## 2. Three-minute talk track (synchronised with the live demo)

**Before you walk on.** Open `http://localhost:3001/api/auth/demo?reset=1&next=/sign-in` once. This reseeds Ava Chen so the Trading Assistant starts at 96, then lands on the sign-in page. Leave that tab open. Spoken words below: 345, which leaves room to breathe. The lines are written for live settlement; if the Monad card still says simulated on the day, apply the three substitutions listed after the talk track.

### 0:00 to 0:20 · Sign in

**Click:** on `/sign-in`, press **Try the demo as Ava Chen**. (If Windows Hello is set up on this machine and you want a real WebAuthn ceremony, type a name and press **Create with passkey** instead. Only do this if you rehearsed it on this exact machine.)

**Say:** "AI agents are about to hold our money and our calendars, and nobody can answer three questions about one: who is the human behind it, what is it allowed to do, and should I trust it. Fuku answers all three on Monad. Sign-in is by passkey, a real WebAuthn ceremony, and a passkey identity is human-verified from the first second. I am taking the demo shortcut into Ava's seeded account to save time."

### 0:20 to 0:45 · Dashboard

**Click:** nothing. Point at the identity card, the trust ring (96), the Agents tile (4), and the Permission status list.

**Say:** "This is Ava. She owns four agents. Her Trading Assistant scores 96 and carries a passport: swap up to 5,000 USDC a day on Monad DEX, read balances, price feeds. Withdraw, transfer and change owner are hard-blocked. That passport is the product."

### 0:45 to 1:10 · Register an agent

**Click:** **Register agent** (top right). Name: `Support Agent`. Keep the default capabilities (Swap assets, Read balances). Press **Register agent**. You land on the Permission Manager with the new agent selected, status pill "Just registered", "No passport".

**Say:** "Registering an agent takes ten seconds. It gets a portable Fuku identity owned by Ava, in the direction of ERC-8004, and it stays inactive until she attaches a passport. Deny by default."

### 1:10 to 1:35 · Approve the passport

**Click:** the editor is prefilled: declared capabilities allowed, swap limited to 5,000 USDC a day, withdraw and change owner blocked. Type `Monad DEX` in the app scope field. Press **Approve passport**. The status pill flips to "active".

**Say:** "Allowed, limited, or blocked, per capability, plus an app scope. Approving hashes the policy and anchors the hash, and the agent goes active. The owner never writes code."

### 1:35 to 2:15 · Run the unauthorized action (the climax)

**Click:** sidebar **Dashboard**. In the card titled "Run an unauthorized action", press **Run agent action**. A result dialog opens. Leave it open while you talk.

**Say:** "Now the part that matters. Trading Assistant tries to withdraw 4,800 USDC. Every action runs the same seven-step workflow: request, owner verified, passport evaluated, execute or block, proof anchored on Monad, reputation updated, explanation. Blocked by rule R2: withdraw is on the hard block list. Here is the trace, the proof hash, the Monad receipt, and an explanation a non-technical owner can read. Nothing left Ava's control."

### 2:15 to 2:40 · Reputation

**Click:** close the dialog, sidebar **Reputation**. The Trading Assistant chip now reads 92. Point at the Score breakdown card.

**Say:** "The score moved from 96 to 92, and it is fully explainable: 40 baseline, plus 20 for a verified human owner, plus 5 for an active passport, plus 35 for successful actions, minus 4 per violation. Deterministic, bounded, and anyone can recompute it from the event log."

### 2:40 to 3:00 · Developer Console

**Click:** sidebar **Developer Console**. Press **Run demo flow** in the "Testing environment" card. Scroll to "Integration status".

**Say:** "Developers get all of this through one SDK and seven endpoints: verify an agent, dry-run a permission, execute through Fuku, read the trust score. The sandbox just ran that against the public API. And this board is honest: every sponsor card reports live or simulated from its own env var. Fuku: identity, permissions, reputation, on Monad."

### If settlement is still mock on the day

Three substitutions keep the spoken lines true. At 1:10, "anchors the hash" becomes "commits the hash for anchoring". At 1:35, "proof anchored on Monad" becomes "proof hashed for Monad", and "the Monad receipt" becomes "the receipt, mocked today; the contracts are written and tested, and the live path is one deploy away". The result dialog labels it "Monad receipt (mock)" itself, so never call it a transaction.

---

## 3. Problem, insight, why now, why Monad

**Problem.** Agents are being given wallets, API keys and tool access. Today there is no reliable way to know the human behind an agent, no portable record of what it is allowed to do, and no reputation that follows it between applications. Every app that adopts agents rebuilds its own trust logic, and the user's context ends up owned by the platform, not the user.

**Insight.** Permissions are the product. Identity and reputation only matter when they are attached to an enforceable answer to "what may this agent do right now?". Fuku's unit of work is a decision: (agent, action, amount, app) evaluated against a passport, producing ALLOWED or BLOCKED with a rule id (R0 to R6), a proof hash and a receipt. The score, the explanation, the activity timeline and the indexer all derive from that decision log.

**Why now.** Passkeys ship in every mainstream browser and OS, so human verification no longer needs a KYC vendor to get started. Agent frameworks are giving models real spending power. ERC-8004 is defining what an agent identity looks like on EVM chains. And fast, cheap EVM execution makes it reasonable to write a proof per action instead of a summary per month.

**Why Monad.**
- Fuku writes a transaction per decision (`recordDecision`) and per score change (`updateScore`). A per-action proof log only makes sense on a chain built for high throughput and low cost per write. That is Monad's design goal, and it is why the contracts emit an event for every decision instead of batching.
- Monad is EVM-compatible, so the four Solidity registries deploy through Hardhat unchanged and the app talks to them with viem. No custom tooling.
- The AgentRegistry follows the ERC-8004 direction (owner-bound agent record, metadata URI, capabilities hash, lifecycle status), so Fuku agents can line up with the emerging EVM agent-identity standard rather than a proprietary format.
- Illustrative scale, not a measurement: the seeded demo holds 25 decisions for one person's four agents over one week. A fleet of agents acting for thousands of owners is thousands of decisions per day, each one an on-chain event.

---

## 4. Architecture in five lines, and the honest state of the build

1. **Identity.** A passkey (WebAuthn via `@simplewebauthn`) creates a Fuku identity, human-verified at creation; the passkey public-key hash and a proof hash are anchored in `HumanIdentityRegistry`, and the verified flag is set on-chain in live mode. "Human-verified" means a completed WebAuthn registration, no KYC; the server does not require the authenticator's user-verification flag.
2. **Agents.** `AgentRegistry` binds each agent to its owner identity: name, version, capabilities hash, metadata URI, status (Registered, Active, Paused, Revoked).
3. **Permissions.** A passport (allowed rules with optional daily USDC limits, a block list, scope apps) is evaluated by a deterministic engine with rules R0 to R6; the policy hash and version go to `PermissionRegistry`, and every decision emits `ActionDecision(agentId, actionHash, allowed, proofHash, ruleId)`.
4. **Reputation.** Score = 40 baseline + 20 verified human + 5 active passport + 2.5 per success (max 35) minus 4 per violation (max 40) minus 10 per security event, clamped to 0 to 100; the latest score is written to `ReputationRegistry` by an allow-listed scorer.
5. **Surface.** Next.js app, public v1 API with hashed API keys, `@fuku/sdk`, Envio HyperSync indexing the four registries (Activity → On-chain) plus HyperRPC proof verification, an Envio HyperIndex config, Kimi/Qwen explanations with a rule-based fallback, and an AES-GCM encrypted memory vault.

### What is real today

| Component | State |
| --- | --- |
| Passkey identity | Real WebAuthn registration and login; identity is human-verified at creation; the stored passkey keeps its signature counter. |
| Permission engine | Deterministic, every decision attributed to R0 to R6, per-day USDC limits, app scope. |
| Trust score | Deterministic formula with a six-line breakdown, served by the UI, the session API and the public API. |
| Solidity registries | Four contracts in Hardhat 3, Solidity 0.8.28, 18 passing tests, deploy script with role grants, ABI export, pre-flight and env-wiring scripts. Deployed on Monad testnet on 2026-09-24 (`contracts/deployments/monadTestnet.json`: HumanIdentityRegistry 0x9fe8…4a2b, AgentRegistry 0x41a1…5e29, PermissionRegistry 0xfe5c…46cc, ReputationRegistry 0x33a2…efad) and verified end to end against it with `web/scripts/live-smoke.mjs` (19 of 19 checks, real receipts and on-chain reads). |
| Settlement adapter | Live path simulates each call before sending (reverts decode to the contract's custom errors), waits for the receipt, anchors missing identities, agents and passports lazily (so data created in mock mode is settled on its first live write), serializes writes from the single signer, and falls back to a mock receipt with the reason instead of failing the action. Proven end to end on a local Hardhat node with `web/scripts/live-smoke.mjs` (19 checks). |
| SDK | `@fuku/sdk` 0.1.0, built to `dist/`, eight methods (the seven endpoints the Developer Console documents plus `revokePermission`, a DELETE on the permissions route), exercised against the running server. |
| Proofs | `proofHash = keccak256` of the decision record (agent, action, amount, app, decision, rule id, policy hash, timestamp); seven-step workflow trace on every action. |
| Memory vault | AES-GCM-256 with a PBKDF2 key (100,000 iterations) derived in the browser; the server stores ciphertext and IVs only. Today there is no passphrase prompt: every identity derives its key from the fixed `DEMO_VAULT_PASSPHRASE` constant, so the encryption is structural, not yet a secrecy guarantee. |

### What is simulated until keys are configured

| Component | Today | What flips it |
| --- | --- | --- |
| Monad settlement | Mock receipts with a deterministic proof hash. The explorer link in a mock receipt does not resolve. | One deploy and one `npm run wire:env` away (it writes `FUKU_CHAIN_MODE=live`, the signer key and the four `FUKU_*_REGISTRY` addresses). Do not call this "one env var". |
| AI explanations | Rule-based narrator (`fuku-rules`). | Literally one env var: `KIMI_API_KEY` or `QWEN_API_KEY`. The adapter has not been exercised with a real key; on any error it falls back to the narrator. |
| Nansen | Key configured and verified against the live API (free plan). Wallet-label lookups cost 100 Nansen credits each, so until the account holds at least 100 credits the Reputation card shows ledger-derived signals and says so. | Top up Nansen credits (or Pro plan); the code path is exercised and cached per address for a day. |
| Envio | Live. HyperSync indexes every Fuku registry event on Monad testnet for the signed-in identity and its agents (Activity → On-chain · Envio, with block times and explorer links). HyperRPC verifies a single decision: its receipt, its ActionDecision event, and that the on-chain proof hash equals the Fuku ledger ("Verify on-chain" on an activity row). The HyperIndex config in `/indexer` carries the real addresses but is not run (it needs Docker). | Nothing for the demo. Running HyperIndex would add a GraphQL API over the same events. |
| Privy, Cleanverse | Status cards driven by env vars. No client code behind them yet. The Cleanverse credential is a demo row attached to verified identities. | Real integration work, not just a key. Say so if asked. |
| Chainlink CRE | Real workflow in `cre/fuku-guard` (TypeScript, CRE SDK 1.22): HTTP trigger, verify through the Fuku API, execute, then an EVM read of the Monad registries through the DON. Proven with `cre workflow simulate` against the live app: a blocked withdraw produced a real Monad transaction and CRE read back the matching score. Not deployed to the DON: Chainlink answered our access request (2026-09-24) that hackathon teams simulate locally, and that testnet or mainnet deployment goes through a commercial call and an MNDA. | A commercial agreement with Chainlink, then `node cre/deploy.mjs` (tunnel, secret, deploy, `CRE_WORKFLOW_ID`) is ready to run. |
| On-chain human flag | In live mode the app sets `setHumanVerified` itself, because its signer is the registry owner (the verifier role). | An independent verifier holding that role is future work. |
| Signing model | In live mode the server signs everything with one relayer key that is registry owner, identity controller, enforcer and scorer. | Owner-controlled keys (next step). |
| Seeded demo data | Ava Chen, her four agents and their history are seeded; their tx hashes are placeholders. In live mode they are anchored lazily on the first write (extra transactions on that first action). | Pre-warm before the pitch (see the runbook). |

### Going live on Monad testnet before the demo (the founder's runbook)

1. Generate a fresh key and fund it from the Monad faucet (`https://faucet.monad.xyz`). Never reuse a mainnet key.
2. `contracts/.env`: `DEPLOYER_PRIVATE_KEY=0x...` and `MONAD_RPC_URL=https://testnet-rpc.monad.xyz`.
3. `cd contracts && npm install && npm test` (18 passing), then `npm run check:deployer`. It derives the address, confirms chain id 10143 and a non-zero MON balance, and warns below 0.1 MON. A full deploy sends six transactions (four deploys, two role grants).
4. `npm run deploy:monad`. It deploys the four contracts in order, grants the deployer the enforcer and scorer roles, and writes `contracts/deployments/monadTestnet.json`.
5. `npm run wire:env`. It backs up `web/.env` to `web/.env.bak`, then upserts `FUKU_CHAIN_MODE=live`, `FUKU_CHAIN_ID=10143`, `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and the four `FUKU_*_REGISTRY` lines. Preview first with `node scripts/wire-env.mjs --dry-run`. The web signer must be the account that deployed, because it holds the owner, enforcer and scorer roles; `wire:env` copies the same key.
6. Restart the dev server (`cd web && npm run dev -- -p 3001`); env is read at startup.
7. Check: Developer Console, the pill next to "Integration status" reads "Monad Testnet · chain 10143 · live settlement" and the Monad card says live. `curl http://localhost:3001/api/integrations` shows `chain.mode: "live"` and the signer address.
8. Produce a real receipt: **Create with passkey** (`registerIdentity` then `setHumanVerified`), **Register agent** (`registerAgent`), **Approve passport** (`setPolicy`), then run a withdraw of 4,800 from the Permission Manager's "Test an action against the passport" form (`recordDecision` then `updateScore`; the dashboard preset only targets Trading Assistant). The result dialog now says "Monad transaction" and the link opens on `testnet.monadexplorer.com`. Each write waits for its receipt (up to 90 seconds), so expect a short pause per anchor.
9. Pre-warm the seeded demo. Ava Chen and Trading Assistant were never anchored, so their first live action adds three transactions in front (`registerIdentity`, `setHumanVerified`, `registerAgent`) and the receipt notes "Anchored first: ...". Run one action on Trading Assistant before the pitch (the sandbox's **Run demo flow** does it), then open the `?reset=1` link. The on-chain records survive the reseed because the ids are fixed, so the live demo action is two transactions again.
10. Rehearse without testnet if you want: `npx hardhat node` in `contracts/`, `npx hardhat run scripts/deploy.ts --network localhost`, then wire the web app to the node's account #0 for that run only: `DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 MONAD_RPC_URL=http://127.0.0.1:8545 npm run wire:env -- --network localhost` (without those two overrides `wire:env` writes the testnet RPC and refuses to run without a key), and set `FUKU_CHAIN_NAME="Hardhat local"` in `web/.env`. Same code path, chain id 31337, receipts are real but the explorer link points at Monad's explorer and will not resolve. Re-run `npm run wire:env` with no overrides to point back at testnet.
11. Optional: open Activity → On-chain · Envio to show the same decisions read back from Monad by Envio HyperSync, and press Verify on-chain on the fresh blocked withdraw (Envio HyperRPC).
12. Never commit `web/.env`, `web/.env.bak` or `contracts/.env`.

---

## 5. Sponsor mapping

Source of truth: `web/src/lib/integrations/index.ts`, rendered on the Developer Console.

| Sponsor | Category | What it does in Fuku | Live when | Otherwise |
| --- | --- | --- | --- | --- |
| Monad | Settlement | Identity, agent, permission and reputation registries; a tx per decision and per score change. | `FUKU_CHAIN_MODE=live` plus the signer key and four addresses (`npm run wire:env` writes all of them). | Proof hashes computed locally, receipts mocked. |
| Mera | Identity | Passkey onboarding and approval (WebAuthn, P-256). Reported live because passkeys genuinely work in the browser; no Mera-specific API is called. | Always. | n/a |
| Privy | Wallet | Embedded wallets for agents and owners. | `NEXT_PUBLIC_PRIVY_APP_ID` flips the card. | The identity's wallet address is an optional field (the seed fills Ava's). No Privy client code yet. |
| Dynamic | Identity | Email sign-in with an embedded EVM wallet (Dynamic JavaScript SDK 1.34, headless), on the sign-in page and as "Connect wallet with Dynamic" on the Identity page. The server verifies Dynamic's JWT (RS256 against the environment JWKS, issuer, `user:basic` scope) before issuing a Fuku session, and takes the wallet only from the token's verified credentials. The wallet becomes the identity's owner wallet. | `NEXT_PUBLIC_DYNAMIC_ENV_ID` (sandbox environment configured). | Passkey sign-in. Email sign-in alone does not mark an identity human-verified; only a passkey does. |
| Nansen | Data | Behavioural risk signals for agent wallets, shown on the Reputation report; the integration board shows the plan and remaining credits from Nansen's free `account` endpoint. | `NANSEN_API_KEY` (verified live) plus at least 100 Nansen credits per wallet-label lookup (`POST /profiler/address/labels`, chain from `NANSEN_CHAIN`, default `monad`, cached per address for a day). | Below 100 credits, or without a key: signals derived from Fuku's ledger (violation ratio, security events, agent age, volume), with the reason printed on the card. |
| Envio | Data | HyperSync: on-chain history of identities, agents, passports, decisions and scores from the Fuku registries. HyperRPC: per-decision proof verification against Monad. | `ENVIO_API_TOKEN` (HyperSync) and `ENVIO_HYPERRPC_TOKEN` (HyperRPC), both configured and verified. | Without tokens: activity from the local ledger only. |
| Kimi | AI | Trust explanations for decisions and scores (OpenAI-compatible chat, 9 s timeout). | `KIMI_API_KEY` (adapter not yet exercised with a real key). | Deterministic rule narrator. |
| Qwen | AI | Policy interpretation and explanations (same adapter, tried after Kimi). | `QWEN_API_KEY` (same caveat). | Deterministic rule narrator. |
| Chainlink CRE | Automation | `fuku-guard` workflow: request (HTTP trigger), verify (Fuku API: human owner, trust score, dry run; low-trust agents are rejected before execution), execute (Fuku API, one call across the DON), record (EVM read of PermissionRegistry and ReputationRegistry on monad-testnet). Actions it submits are tagged "via Chainlink CRE" in the activity timeline. | `CRE_WORKFLOW_ID` from `cre workflow deploy`, which Chainlink gates behind a commercial agreement (hackathons simulate). | Runs end to end with `cre workflow simulate`; the in-app seven-step trace runs on every action regardless. |
| Cleanverse | Credentials | Verified identity credential shown on the Identity page. | `CLEANVERSE_API_KEY` flips the card. | A demo credential row is attached to every verified identity. |

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
Every term is bounded: successes cap at +35, violations subtract up to 40, security events cost 10 each, and the result is clamped to 0 to 100. Only allow-listed scorers can write on-chain, and the formula is public, so anyone can recompute it from the event log. Honest limitation: a cheap read counts the same as a swap, so an owner can reach the success cap with reads. Next is weighting successes by action risk and folding in Nansen labels.

**6. How private is the memory vault?**
The server stores only ciphertext and IVs (the memory API only accepts ciphertext). The key is derived in the browser with PBKDF2 (100,000 iterations, SHA-256, salted with the identity id) into AES-GCM-256, and decryption happens in the browser. Applications get vault access through requests the owner approves on the Memory Vault page. Nothing from the vault goes on-chain. Honest limitation: there is no passphrase prompt yet, so every identity, not only the seeded demo, derives its key from the fixed `DEMO_VAULT_PASSPHRASE` constant in the source. The architecture is end-to-end encryption; the secrecy arrives with a per-user passphrase or a passkey-derived key, which is on the next-steps list.

**7. What does ERC-8004 compatibility mean here?**
Direction, not conformance. `AgentRegistry` follows the ERC-8004 shape: an agent record bound to an owner, with a metadata URI, a capabilities hash and a lifecycle status, keyed by bytes32 ids. It does not yet implement the standard's interfaces or its reputation and validation registries. Adopting them is a contained change because the app reaches the registries through one adapter.

**8. What is the business model?** (proposed; nothing in the repo monetises)
The Developer Console already issues API keys, so the natural model is usage-based: free for owners, metered `verifyAgent`, `checkPermission` and `executeAction` calls for applications, and paid policy features for teams running agent fleets.

**9. What would you build next?**
Owner-controlled keys as the on-chain identity controller (passkey-signed or a Privy embedded wallet) instead of the relayer. An independent verifier for the human flag. Run Envio HyperIndex for a GraphQL API over the registry events. Deploy the `fuku-guard` CRE workflow to the DON after a commercial agreement with Chainlink (the deploy script is ready). ERC-8004 interface conformance. Risk-weighted scoring. A per-user vault passphrase (or a passkey-derived key) in place of the fixed demo constant. Publish `@fuku/sdk` to npm.

**10. How are daily limits enforced?**
Per agent and per action type. Before evaluating a value action (swap, withdraw, transfer, stake), Fuku sums that agent's allowed actions of the same type since local midnight and blocks with rule R5 when the amount exceeds the limit minus what was spent. In the seed, Trading Assistant may swap 5,000 USDC a day and has already swapped 1,200 today, so 3,800 remains. Blocked attempts do not consume budget. Limits reset at midnight, server time; a rolling 24-hour window and on-chain limit checks are future work.

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
- Kalau juri membaca catatan "Mock settlement" di dialog, jawab jujur dan singkat: "Settlement hari ini mock. Kontraknya ada, 18 test lulus, satu deploy plus `npm run wire:env` membuatnya live." Jujur lebih menang daripada mengaku-aku.
- Biarkan dialog hasil terbuka sekitar sepuluh detik. Sebut "rule R2" dengan jelas, lalu bacakan satu kalimat penjelasannya. Itu bagian yang paling gampang diingat.
- Di Developer Console, jangan buru-buru scroll. Tunjuk kartu yang bertulis "simulated" dan bilang itu disengaja: juri menghargai kejujuran.

**Ringkasan cara uji di Monad testnet** (detail lengkap di bagian 4, runbook).
- Isi `contracts/.env` dengan key baru yang sudah diisi MON dari faucet, lalu `npm run check:deployer` untuk memastikan chain 10143 dan saldo cukup.
- `npm run deploy:monad`, lalu `npm run wire:env` supaya `web/.env` otomatis berisi mode live, key, dan empat alamat registry. Restart dev server.
- Cek Developer Console: pil di sebelah "Integration status" harus bertulis "live settlement".
- Pemanasan: jalankan satu aksi di Trading Assistant dulu (tombol **Run demo flow** di sandbox), karena aksi live pertama untuk data seed akan menambah tiga transaksi di depan. Setelah itu buka link `?reset=1`.
- Kalau ingin pakai identitas passkey baru di mode live, angkanya jadi 60 setelah register, 65 setelah passport disetujui, 61 setelah withdraw diblokir. Sebutkan angka itu sebelum mulai supaya juri tidak bingung. Setiap langkah menunggu receipt, jadi isi jeda dengan narasi, jangan diam.

**Menjawab pertanyaan juri.** Satu kalimat inti dulu, baru detail kalau diminta. Kalau sesuatu belum ada di kode, bilang "belum, itu langkah berikutnya" dan sebut langkahnya. Jangan pernah bilang integrasi live kalau kartunya masih simulated.

**Cadangan kalau UI bermasalah.** Sandbox di Developer Console menjalankan alur yang sama lewat API publik. Simpan juga screenshot dialog hasil (blocked R2) dan halaman Reputation (96 ke 92) di folder yang gampang dibuka.
