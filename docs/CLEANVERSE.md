# Fuku × Cleanverse: CVI / CVA integration

Status on 2026-09-30:

- The code path is complete: engine rules, the Cleanverse client, the simulator, FukuSpendGuard, UI and SDK.
- The live Cleanverse API has **never been called**. API access is invite-only and the invite is pending. The client is covered only by contract tests against a fake HTTP server.
- Everything that runs today runs against **Fuku's simulator**, which is labelled as such everywhere.
- The simulator contracts and the guard are **deployed on Monad testnet** since 2026-09-30, with sources verified on Sourcify. They are still Fuku's simulator: aUSDC-SIM is not a Cleanverse token, and Fuku issues the A-Passes.
- On testnet the live smoke passed 66/66 against them, and the SDK example paid 25 aUSDC-SIM through the guard. Addresses and every transaction hash are in [On Monad testnet](#on-monad-testnet-2026-09-30).

## What it does

A passport that lists A-Tokens (`assets: ["aUSDC"]`) is an **A-Token passport**. Only those passports enter the Cleanverse perimeter. Trading Assistant and every other passport behave exactly as before.

~~~
Owner's A-Pass wallet --approve + openMandate(agent, aUSDC, dailyCap, maxPerTx, validUntil, restrictPayees)
                      --setPayee(agent, supplier)--> FukuSpendGuard

Agent request (transfer, to, asset)
  -> Fuku engine: R0-R4, then R9 asset rule, R7 owner A-Pass, R8 recipient A-Pass, then R5, R6
  -> compliance signer (Fuku server) signs an EIP-712 GuardedTransfer for exactly this transfer,
     bound to the action id, the passport hash and the mandate version
  -> FukuSpendGuard.execute: attestation (single-use action), agent status, current passport hash,
     mandate (token, version, expiry, per-transfer limit, approved payee), UTC daily cap
  -> aUSDC.transferFrom(owner, recipient)     <- the A-Token re-checks both A-Passes
  -> PermissionRegistry.recordDecision(R6)    <- same transaction
~~~

The guard never holds funds. The owner keeps the tokens and gives the guard an allowance. In this build only `transfer` moves value.

| Rule | Checks | Sub-codes |
| --- | --- | --- |
| R9 asset (CVA) | The value action is `transfer`, the asset is on the passport, and it resolves to an A-Token in the current mode | `CVA_NOT_ALLOWED`, `PROVIDER_ERROR` |
| R7 owner (CVI) | The owner has a wallet with an active, unexpired A-Pass, and `verify_apass(owner, atoken) == 4` | `CVI_NO_WALLET`, `CVI_NOT_FOUND`, `CVI_FROZEN`, `CVI_EXPIRED`, `CVI_RULE_REJECTED`, `PROVIDER_ERROR`, `PROVIDER_OFF` |
| R8 counterparty (CVI) | `to` is a valid address and `verify_apass(to, atoken) == 4`. For any other code, `query_apass(to)` tells frozen, expired and rule-rejected apart | same as R7 |
| R10 on-chain guard | The guard would revert. The reason is the decoded custom error, or `GUARD_NOT_CONFIGURED` when the chain is live but the guard or signer is not set, or `AUTHORIZATION_CHANGED` when the owner revoked or replaced the passport, or paused the agent, between the decision and the signature (nothing is signed) | `GUARD_REJECTED`, `GUARD_NOT_CONFIGURED`, `AUTHORIZATION_CHANGED` |

Evaluation order: R0, R1, R2, R3, R4, R9, R7, R8, R5, R6, then R10 at execution. R0 to R6 keep their ids and meanings. Evidence is gathered only after R0 to R4 pass, so a request those rules block never reaches Cleanverse. Everything fails closed: any error, timeout, missing field or unknown code blocks the action.

## Modes

One code path serves every mode (`web/src/lib/cleanverse/mode.ts`, `web/src/lib/services/cleanverse.ts`).

| Mode | When | Provider |
| --- | --- | --- |
| live | `CLEANVERSE_API_ID` and `CLEANVERSE_API_KEY` are set and `CLEANVERSE_MODE` is not `sim` | The cooperate API (`LiveCleanverseProvider`) |
| simulated, `sim-chain` | No credentials (or `CLEANVERSE_MODE=sim`), the chain is live, and `CLEANVERSE_SIM_APASS` and `CLEANVERSE_SIM_ATOKEN` are set | The Fuku simulator contracts, read with viem |
| simulated, `sim-fixtures` | No credentials and the chain is mocked | `CleanversePass` rows with `source: "simulated"`, same semantics as the contracts |
| off | `CLEANVERSE_MODE=off`, or a live chain with neither credentials nor simulator addresses | none. A-Token transfers are blocked with R7 `PROVIDER_OFF` |

The Developer Console card says **live** only when the mode is live and the last live call succeeded. With credentials but no successful call it says **configured**. In the simulator it says **simulated · API invite pending**.

## Environment

| Variable | Purpose |
| --- | --- |
| `CLEANVERSE_API_ID`, `CLEANVERSE_API_KEY` | Cooperate API credentials. The key is base64 and decodes to 16, 24 or 32 bytes (the AES key). Never commit them |
| `CLEANVERSE_BASE_URL` | Default `https://uatapi.cleanverse.com/api/cooperate` (UAT) |
| `CLEANVERSE_CHAIN` | Chain id string sent to the API. Default `monad` (unverified, see open questions) |
| `CLEANVERSE_MODE` | `sim` forces the simulator; `off` switches Cleanverse off |
| `CLEANVERSE_REQUEST_TIMEOUT_MS` | Default 8000 |
| `CLEANVERSE_ATOKEN_SYMBOL`, `CLEANVERSE_ATOKEN_ADDRESS` | A known A-Token. It is checked before `query_deposit_atoken_list` |
| `CLEANVERSE_SIM_APASS`, `CLEANVERSE_SIM_ATOKEN` | Simulator contract addresses (`npm run wire:env` writes them) |
| `FUKU_SPEND_GUARD` | FukuSpendGuard address (`wire:env` writes it) |
| `FUKU_COMPLIANCE_SIGNER_KEY` | Key of the guard's compliance signer. It signs `GuardedTransfer` attestations. Use a dedicated key, not the deployer |
| `DEMO_OWNER_PRIVATE_KEY` | Ava's funding wallet (testnet only). The seed uses its address as her wallet, and the setup script signs `approve` and `openMandate` with it |

## API contract and its provenance

**Provenance.** The contract below comes from the integration brief. It was inferred from public Cleanverse hackathon code and has **not** been verified against Cleanverse documentation or the live API. `web/src/lib/cleanverse/cleanverse.test.ts` checks the client against a fake HTTP server. These are contract tests, not evidence that the real API behaves this way.

- **Base URL and headers:** `api-id: $CLEANVERSE_API_ID`, `content-type: application/json`, and `X-Request-ID: <uuid>` on every call.
- **Envelope:** `{code, message, data}`. Success iff `code === "0000"`. A `data` string is decrypted.
- **Encrypted bodies (write endpoints):** `{data: base64(AES-CBC(JSON))}`. The IV is 16 zero bytes, with PKCS7 padding. Fuku calls no write endpoint today.

| Endpoint | Body | Used for |
| --- | --- | --- |
| `/query_apass` | `{chain, address}` | Owner A-Pass (R7) and why a recipient failed (R8) |
| `/verify_apass` | `{atoken, chain, address}` | 4 eligible, 2 no A-Pass. Only 4 and 2 are evidenced |
| `/atoken/rules` | `{chain, atokenAddress}` | The A-Token rule, recorded in the evidence |
| `/query_deposit_atoken_list` | `{chain}` | Resolving `aUSDC` on the chain |
| `/download_travel_rule` | `{txHash}` | Wired in the client; not called yet (P1) |
| `/faucet` | `{chain, symbol, depositAddress, amount}` | Not wired |

**Out of scope, next steps:**
- `generate_apass`: Fuku reads A-Passes and never collects KYC documents or bank data.
- `atoken/launch`.
- CCP pool registration (`validator/*`).

## Simulator semantics

These contracts are **not** Cleanverse. They exist so the full flow can run on a chain where Cleanverse is not deployed.

- **`CleanverseAPassSim`** holds one pass per wallet, with no transfer function.
  - `status`: 0 none, 1 active, 2 frozen. `expiresAt = 0` never expires.
  - Only issuers write. The deployer is the default issuer.
  - `verify(wallet, rule)` evaluates in this order: no pass → 2; frozen or expired → 3; tier or sub-tier below the rule, or a group mismatch → 1; otherwise 4.
- **`CleanverseATokenSim`** is `aUSDC-SIM` with 6 decimals.
  - Every `transfer`, `transferFrom` and `mint` requires both parties to pass `verify` under the token rule (minTier 1, any group). The spender is not checked, so the guard can move funds between two eligible wallets.
  - A failure reverts with `ComplianceRejected(who, code)`. `setPaused` blocks transfers.
- **The fixture backend** (mock-chain mode) answers from `CleanversePass` rows seeded with `source: "simulated"`. It uses `simVerify`, which has the same semantics as the contract.
- The symbols `aUSDC` and `aUSDC-SIM` both resolve to the simulated token.
- Demo recipients use deterministic testnet-only addresses: `privateKeyToAddress(keccak256("fuku:demo:<label>"))`.
  - Nusantara Supplies: active, tier 2.
  - Frozen wallet: status 2.
  - Unverified wallet: no pass.
- Ava's pass is active, tier 2, record `cv-sim-ava-chen`.

## FukuSpendGuard (v2)

- **EIP-712 domain:** `{name: "FukuSpendGuard", version: "1", chainId, verifyingContract}`.
- **Typed struct (field order is part of the typehash):**
  `GuardedTransfer(bytes32 agentId,address from,address to,address token,uint256 amount,bytes32 policyHash,bytes32 actionHash,bytes32 proofHash,bytes32 complianceRef,uint64 mandateVersion,uint256 nonce,uint64 issuedAt,uint64 deadline)`.
- **The owner's mandate:** `openMandate(agentId, token, dailyCap, maxPerTx, validUntil, restrictPayees)` and `setPayee(agentId, payee, allowed)`, both sent from the owner's own wallet.
  - `mandates(agentId, wallet)` returns `(token, dailyCap, maxPerTx, validUntil, restrictPayees, version, active)`.
  - The version increases on every open and close, so reopening a mandate voids attestations signed against the old one.
- **Supersession:**
  - `bumpValidAfter(agentId)` (the agent's controller or an enforcer) voids every attestation for the agent issued at or before that block.
  - `bumpWalletValidAfter(agentId, wallet)` (the wallet itself or an enforcer) does the same for one funding wallet.
  - Fuku bumps on pause, revoke and allowance changes.
- **Checks, in order:**
  1. The attestation window:
     - the deadline has not passed;
     - `issuedAt` is at most 5 s ahead of block time;
     - `deadline − issuedAt` is at most `maxAttestationTtl` (60 s by default; owner-settable from 10 s to 1 h);
     - `issuedAt` is later than both `validAfter` values (`AttestationSuperseded`).
     Then an unused nonce, an unused action hash (`ActionAlreadyExecuted`), and a low-s signature from the compliance signer.
  2. The agent exists and is not Paused or Revoked.
  3. The policy is active and its hash equals the attested `policyHash`.
  4. An active mandate for `(agentId, from)` on this token at the attested version (`StaleMandate`) that has not expired (`MandateExpired`).
  5. The amount is non-zero and within `maxPerTx` (`PerTxLimitExceeded`), and the recipient is not zero and is an approved payee when payees are restricted (`PayeeNotApproved`).
  6. The amount fits the daily cap per `(agent, wallet, UTC day)` (`DailyCapExceeded`).
- **Effects:** the guard marks the nonce and the action hash used, calls `transferFrom` and bubbles the token's revert data. It records `recordDecision(agentId, actionHash, true, proofHash, "R6")` as a PermissionRegistry enforcer, emits `GuardedTransferExecuted` (with `actionHash`, `complianceRef` and `mandateVersion`), and is `nonReentrant`.
- **What the server does per transfer:**
  1. Creates the `AgentAction` row first. `actionHash = keccak256(action id)`.
  2. Anchors the agent and passport if needed, and reads the on-chain policy hash.
  3. Reserves the day's budget atomically, then signs with a random 256-bit nonce, a deadline of now + 5 min, the mandate version read from chain, and the amount in base units computed by the engine.
  4. Simulates the call, broadcasts it through the signer lease, and stores the hash before waiting for the receipt.
  - A simulated revert becomes BLOCKED R10 (lifecycle DENIED). The proof hash is recomputed and recorded with `recordDecision`, and the budget is released.
  - A receipt that does not arrive in 90 s leaves the row PENDING (HTTP 202) for reconciliation. A mined revert is FAILED.
  - An RPC or signing failure before broadcast returns HTTP 502 and marks the row FAILED. It never falls back to a mock receipt.
  - In mock-chain mode the row is SIMULATED, the receipt is a labelled mock, and no token moves.
  - The lifecycle, idempotency and reconciliation are described in `docs/SECURITY.md`.
- **Kill switch on-chain:**
  - Revoke calls `PermissionRegistry.revokePolicy`, so outstanding attestations fail with `PolicyNotActive`.
  - Pause and resume call `AgentRegistry.setStatus`, so attestations fail with `AgentNotActive`.
  - Sync failures come back as `chainSync.ok = false`.
  - A changed passport is re-anchored before the next transfer, so a stale attestation fails with `PolicyMismatch`.

## Evidence and the compliance reference

For every value action on an A-Token passport the engine gets an evidence object:

`{provider: "cleanverse", mode, chain, atoken: {symbol, address, rule}, owner: {wallet, cvRecordId, status, tier, subTier, expiresAt, verifyCode}, counterparty: {wallet, verifyCode, message}, checkedAt, requestIds}`

- `complianceRef = keccak256(canonical JSON)`, with keys sorted and undefined values dropped. `web/src/lib/cleanverse/evidence.ts` builds it; it does not use `hashJson`.
- `complianceRef` goes into the proof hash (only when evidence exists, so other actions keep their hash format) and into the on-chain attestation.
- The row stores the whole evidence object. Every A-Pass read is persisted to `CleanversePass`, so the Identity page and verifyAgent never call the provider synchronously.
- No personal data goes on-chain; the evidence holds only record ids, tiers, codes and wallet addresses.

## Run it locally (verified 2026-09-30)

~~~bash
# 1. chain + contracts (account #0 deployer, #1 compliance signer, #2 Ava)
cd contracts && npx hardhat node                       # terminal 1
COMPLIANCE_SIGNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  npx hardhat run scripts/deploy.ts --network localhost

# 2. web env for the local node (see contracts/README.md for wire:env with overrides):
#    FUKU_CHAIN_MODE=live FUKU_CHAIN_ID=31337 MONAD_RPC_URL=http://127.0.0.1:8545
#    DEPLOYER_PRIVATE_KEY=<#0> FUKU_COMPLIANCE_SIGNER_KEY=<#1> DEMO_OWNER_PRIVATE_KEY=<#2>
#    the four FUKU_*_REGISTRY, CLEANVERSE_SIM_APASS, CLEANVERSE_SIM_ATOKEN, FUKU_SPEND_GUARD
cd web && npm run cleanverse:setup                    # A-Passes, 10,000 aUSDC-SIM, approve, mandate v2, payee
npm run dev -- -p 3002                                 # terminal 2
DATABASE_URL=<the web instance's database> SMOKE_OWNER_PRIVATE_KEY=<#3> \
  FUKU_BASE_URL=http://localhost:3002 node scripts/live-smoke.mjs
~~~

Expected result on a fresh node: `67/67 checks passed`. That is 19 demo-flow and chain checks, 31 Cleanverse and guard checks and 17 owner-custody checks. Without `SMOKE_OWNER_PRIVATE_KEY` the owner-custody section is skipped. Each run pays from a fresh A-Token agent with its own mandate and daily cap, so the smoke can run again on the same node the same day. On Monad testnet it is 66/66, because the reorg check needs a Hardhat node.

The 29 Cleanverse and guard checks cover the following:
- 250 aUSDC-SIM to Nusantara is CONFIRMED. The transfer, `GuardedTransferExecuted` (bound to the action id) and `ActionDecision` land in one transaction, and `GET /api/v1/actions/:id` returns the tx and its log index.
- The Travel Rule record (simulator) is stored and its canonical-JSON hash equals the action's `travelRuleRef`.
- Frozen and Unverified are blocked with R8 `CVI_FROZEN` and `CVI_NOT_FOUND`, with no Transfer event.
- A repeated `Idempotency-Key` replays instead of paying twice.
- Direct attestations revert with `PerTxLimitExceeded`, `PayeeNotApproved` and `DailyCapExceeded`.
- Two concurrent requests cannot spend the same remainder, and the balances move exactly once per confirmed transfer (900 in total).
- Reconciliation, run as a separate process, recovers a transfer whose hash was never stored, without double credit. A confirmation removed by `evm_revert` goes back to PENDING and loses its credit.
- Pausing then resuming in the app bumps the guard's `validAfter`, so a pre-pause attestation stays dead (`AttestationSuperseded`). An allowance withdrawn and restored from Ava's wallet makes reconcile bump the wallet's `validAfter`, with the same effect.
- Revoking in the app bumps `validAfter` and emits `PolicyRevoked`. A pre-signed attestation reverts with `AttestationSuperseded`, a fresh one with `PolicyNotActive`, and the app blocks the agent. A later decision anchor and a reconcile pass leave the passport inactive.

Without any chain env (mock mode), the demo runs with the fixture backend and mock receipts.

## On Monad testnet (2026-09-30)

The simulator contracts and FukuSpendGuard were deployed next to the four existing registries on Monad testnet (chain 10143), set up, and exercised end to end. They are still **Fuku's simulator**: aUSDC-SIM is not a Cleanverse token, and Fuku issues the A-Passes.

| Contract | Address | Deploy transaction |
| --- | --- | --- |
| CleanverseAPassSim | [`0x0607ba109cf19e0ca3b8d6606a142b38c61fc579`](https://testnet.monadvision.com/address/0x0607ba109cf19e0ca3b8d6606a142b38c61fc579) | [`0x02fb78f5…fc9e`](https://testnet.monadvision.com/tx/0x02fb78f50724e68dc7eb7907c51c21d46f097e19e3803032cf864d2069c1fc9e) |
| CleanverseATokenSim (aUSDC-SIM) | [`0xb67038fc577315f0646fc4d1b84ee2d428878a14`](https://testnet.monadvision.com/address/0xb67038fc577315f0646fc4d1b84ee2d428878a14) | [`0xb89ee396…c5ed`](https://testnet.monadvision.com/tx/0xb89ee396f7b18fb749c4f103260213b312d061605717ee2c6b38e93c0ce1c5ed) |
| FukuSpendGuard | [`0x3d5d3d38362fcb9ecc26250867cc3f30c99746dc`](https://testnet.monadvision.com/address/0x3d5d3d38362fcb9ecc26250867cc3f30c99746dc) | [`0x1de59d19…78a7`](https://testnet.monadvision.com/tx/0x1de59d1917981d7b1160ce36f79ee79412746a79ee501cbf05fb690a046a78a7) |

- `PermissionRegistry.setEnforcer(FukuSpendGuard)`: [`0x72534cc4…cdd0`](https://testnet.monadvision.com/tx/0x72534cc409855b867c6c496130ccf29015a794882f72a2f6452a9679cd9ecdd0).
- All seven Fuku contracts, the four registries included, are verified on Sourcify with an exact match (`npm run verify:monad`). MonadVision reads Sourcify.

Accounts (public addresses; the keys are only in `contracts/.env` and `web/.env`):
- The relayer [`0x248a9ACA0146b0112f102455fbc11B45338fD3DE`](https://testnet.monadvision.com/address/0x248a9ACA0146b0112f102455fbc11B45338fD3DE) owns the registries, is their enforcer and scorer, and deployed the simulators and the guard.
- The compliance signer [`0xE50e45a4102B8d625b10793d1698A3d53810F62E`](https://testnet.monadvision.com/address/0xE50e45a4102B8d625b10793d1698A3d53810F62E) is the only key FukuSpendGuard accepts attestations from. It sends no transactions.
- Ava's wallet [`0x41Db346C3471818c47792eD5C57728923CE1DFFc`](https://testnet.monadvision.com/address/0x41Db346C3471818c47792eD5C57728923CE1DFFc) (`DEMO_OWNER_PRIVATE_KEY`, a custodial demo key) received 10,000 aUSDC-SIM and a simulator A-Pass. It opened the Payments Agent's mandate: 1,000 aUSDC-SIM a day, 500 per transfer, Nusantara Supplies only.
- The smoke owner [`0x8E5cDd4ba4f1F9d487bcDD35acCE53bb5D778505`](https://testnet.monadvision.com/address/0x8E5cDd4ba4f1F9d487bcDD35acCE53bb5D778505) controls the live smoke's owner-controlled identity.

What ran, in order:
1. `npm run deploy:cleanverse:monad`: the two simulators, the guard and its enforcer grant. The four registries were not touched.
2. `npm run cleanverse:setup`: the simulator A-Passes (Ava, Nusantara Supplies, the frozen wallet), the aUSDC-SIM mint, a gas top-up for Ava, then Ava's allowance, mandate and payee.
3. `npm run reconcile -- --anchor-seeded`: 5 agents, 3 passports, 25 seeded decisions and 5 scores, 38 transactions.
4. `npm run erc8004:register -- --allow-testnet`: 5/5 demo agents registered, each with its own key as `agentWallet` (table below).
5. `web/scripts/live-smoke.mjs` against testnet: **66/66**. The reorg check needs a Hardhat node, so it did not run. The Cleanverse checks ran on a fresh A-Token agent, not on the demo agents.
6. `examples/sdk-consumer` against testnet: every step behaved as expected. It created its own agent with a key generated in the process and had Ava's wallet open the mandate and register it on ERC-8004. It paid 25 aUSDC-SIM through the guard ([`0x20e2bd76…931a`](https://testnet.monadvision.com/tx/0x20e2bd76cfd394b768e3a6c678a7ac336b1ecad54bf3c7c70ce4c0977d3a931a)), checked `GuardedTransferExecuted` on-chain itself, then revoked.
7. `npm run verify-score -- --demo`: 5/5 demo agents verified from the chain, before and after the smoke's two demo resets. Trading Assistant scored 96 from the chain, 96 anchored and 96 in the ledger, with 15/15 records matching. After restarting the app on 3001, the app lists Trading Assistant at 96, and **Recompute from chain** (`GET /api/agents/:id/verify-score`, the endpoint the button calls) returns ✓.

ERC-8004 registrations, on the canonical Identity Registry [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.monadvision.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e):

| Agent | ERC-8004 agent id | `register` | `setAgentWallet` |
| --- | --- | --- | --- |
| Trading Assistant | 1955 | [`0x3771cc08d9d2e3f41d00e8dd386a8452e68c996ad23ac950200809bc58dfb844`](https://testnet.monadvision.com/tx/0x3771cc08d9d2e3f41d00e8dd386a8452e68c996ad23ac950200809bc58dfb844) | [`0xc49ca5e3fee1069aa21290600bba14e6b9bc2add8b4c0689e5feb4a09ebda491`](https://testnet.monadvision.com/tx/0xc49ca5e3fee1069aa21290600bba14e6b9bc2add8b4c0689e5feb4a09ebda491) |
| Research Agent | 1956 | [`0xdc574aa06f9f49a5fed957479198d71421b90eddd4d50f2ca0eee6dbda5bb4d3`](https://testnet.monadvision.com/tx/0xdc574aa06f9f49a5fed957479198d71421b90eddd4d50f2ca0eee6dbda5bb4d3) | [`0x4a5792ecf7a8c166b24faaacbe1c3c05b7c04c81e7285d11ca6ade8c3733058e`](https://testnet.monadvision.com/tx/0x4a5792ecf7a8c166b24faaacbe1c3c05b7c04c81e7285d11ca6ade8c3733058e) |
| Payments Agent | 1957 | [`0xf8ca2a1a0362e3e36334611d0df489cc3d6367fda428ec442eeecd98e5b44f9f`](https://testnet.monadvision.com/tx/0xf8ca2a1a0362e3e36334611d0df489cc3d6367fda428ec442eeecd98e5b44f9f) | [`0x9422680216e1fe6f0735ef66ccec6595e15aaa013520fc9954e68635a226d26e`](https://testnet.monadvision.com/tx/0x9422680216e1fe6f0735ef66ccec6595e15aaa013520fc9954e68635a226d26e) |
| Ops Scheduler | 1958 | [`0x2ab3a9c8beaa11b0e8ff1b0608d9131e45cae322b3bc8bbbf2c4cdb587abf422`](https://testnet.monadvision.com/tx/0x2ab3a9c8beaa11b0e8ff1b0608d9131e45cae322b3bc8bbbf2c4cdb587abf422) | [`0x389cb78095fa02211792efd86480b95d98b826689d28a8d18818845f1bbffb9e`](https://testnet.monadvision.com/tx/0x389cb78095fa02211792efd86480b95d98b826689d28a8d18818845f1bbffb9e) |
| Portfolio Rebalancer | 1959 | [`0x497f8230b8cc755143fe637357acfd5ce3782d25409bc08ae8303962d770b4e8`](https://testnet.monadvision.com/tx/0x497f8230b8cc755143fe637357acfd5ce3782d25409bc08ae8303962d770b4e8) | [`0xd6b94454b31eacbc0b073392146730b21f40ff5ce75b7e81dddf2fd5365d4441`](https://testnet.monadvision.com/tx/0xd6b94454b31eacbc0b073392146730b21f40ff5ce75b7e81dddf2fd5365d4441) |
| The SDK example's own agent (key generated in the example) | 1960 | [`0xa1c2ac51f1a4c435e1bee8e129ad9a3bb5a4a2026b12daa4c0c06e6ae7b1971e`](https://testnet.monadvision.com/tx/0xa1c2ac51f1a4c435e1bee8e129ad9a3bb5a4a2026b12daa4c0c06e6ae7b1971e) | [`0x05cae08247f1b76317f828b4df56d47d171539145b2f602e27a95d8db08185eb`](https://testnet.monadvision.com/tx/0x05cae08247f1b76317f828b4df56d47d171539145b2f602e27a95d8db08185eb) |

Cost: 116 transactions, none reverted, 1.83 MON of gas at about 102 gwei (gas limit × price, which Monad charges).

| Phase | Transactions | MON of gas |
| --- | --- | --- |
| `npm run deploy:cleanverse:monad` | 4 | 0.398 |
| `npm run cleanverse:setup` | 8 | 0.069 |
| Funding the smoke owner | 1 | 0.002 |
| `npm run reconcile -- --anchor-seeded` | 38 | 0.402 |
| `npm run erc8004:register` | 10 | 0.253 |
| Live smoke | 42 | 0.512 |
| Topping up Ava's wallet | 1 | 0.002 |
| `examples/sdk-consumer` | 12 | 0.188 |
| **Total** | **116** | **1.826** |

Two phases cost more than the fork rehearsal predicted: the anchoring (0.40 MON against 0.32) and the smoke (0.51 against about 0.33). The relayer also sent 0.7 MON to Ava and the smoke owner; that is a transfer, not a cost.

Operational note: for about five minutes after Ava's wallet was first funded, the public RPC refused its first transaction with "Signer had insufficient balance", although `eth_getBalance` showed the 0.4 MON. The same approval then went through when re-sent with an explicit gas limit and fee, and every later transaction from the wallet went through without that. Fund a new wallet a few minutes before its first transaction.

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

## Flip-to-live checklist (when the invite lands)

1. Put `CLEANVERSE_API_ID` and `CLEANVERSE_API_KEY` in `web/.env` (never commit them). Keep `CLEANVERSE_BASE_URL` on UAT until Cleanverse says otherwise.
2. `cd web && npm run cleanverse:check`. It calls `query_deposit_atoken_list`, `query_apass` and `verify_apass` for Ava's wallet (or `--wallet 0x...`) and prints the results, request ids and the mapped sub-code. It sends nothing on-chain.
3. Confirm the chain identifier with Cleanverse and set `CLEANVERSE_CHAIN` if it is not `monad`.
4. Set `CLEANVERSE_ATOKEN_SYMBOL=aUSDC` and `CLEANVERSE_ATOKEN_ADDRESS` to the address from step 2.
5. Get an A-Pass for the owner wallet and for a test recipient in the Cleanverse app. Fund the owner wallet with aUSDC (Cleanverse faucet or app).
6. From the owner wallet, `approve(FUKU_SPEND_GUARD, amount)` on the real aUSDC, then on the guard `openMandate(paymentsAgentKey, aUSDC, dailyCap, maxPerTx, validUntil, true)` and `setPayee(paymentsAgentKey, recipient, true)`. Bind that wallet to the owner's Fuku identity (Identity page or `/api/identity/wallet`). The setup script targets the simulator token today, so do this by hand or add a live-token flag.
7. Restart the app. The Cleanverse card reads **configured** until the first successful call, then **live**.
8. Run one transfer to the test recipient. Watch for a token-level revert (R10 with the token's error). That would mean the real A-Token does not let a third-party contract move funds, and CCP registration is needed (see open questions).

## Decisions and deviations (logged per the brief)

1. **`CleanversePass.found`:** an extra column. It records "the provider says there is no A-Pass" separately from "never checked".
2. **Revoke vs pause on-chain:** revoke calls only `revokePolicy`, and pause/resume own `setStatus`. The guard checks agent status before the policy, so revoking would otherwise surface as `AgentNotActive` instead of the `PolicyNotActive` the brief's smoke test expects. The DB still marks a revoked agent paused.
3. **Demo reset:** it resumes the Payments Agent on-chain if an earlier pause left it paused. Otherwise the reseeded agent would keep failing with `AgentNotActive`.
4. **RPC failure on a guarded transfer:** the row becomes BLOCKED R10 "Guarded transfer not sent" and the API returns 502. There is no reputation event and no on-chain record. Known gap: a receipt timeout after broadcast can leave a mined transfer recorded as not sent. Reconciliation is on the technical-depth list.
5. **Evidence timing:** evidence is gathered only after R0 to R4 pass, so blocked requests make no provider calls.
6. **Two daily limits:** the passport limit (R5, off-chain, USDC) and the mandate cap (on-chain, token base units) are separate. The seed sets both to 1,000. For A-Token transfers the guard is authoritative.
7. **Simulator fixtures:** they are seeded in every mode, not only mock-chain. They are `source: "simulated"` and identical to what the setup script issues, and in sim-chain mode real chain reads overwrite them.
8. **Contracts, beyond the brief:**
   - Extra custom errors: `ZeroDailyCap`, `TokenTransferFailed`, `ReentrantCall`, `NoAPass`, `InsufficientBalance`, `InsufficientAllowance`.
   - The deployer is the default issuer.
   - `execute` is split into private helpers because of "stack too deep".
   - `deploy-cleanverse.ts` checks the chain id, registry code and ownership. On a re-run it revokes the previous guard's enforcer role.
   - `wire-env.mjs` now masks keys in files with CRLF line endings.
9. **Script order:** `npm run cleanverse:check` (P1 item 5) was built ahead of P1 items 1 to 4, because the flip-to-live checklist depends on it.
10. **SDK tests:** the SDK workspace test script pointed at a missing folder. It now runs contract tests, so the root `npm test` passes.
11. **Guard v2 (after the brief, for the technical-depth work):** the typehash gained `mandateVersion`, and `openMandate` gained `maxPerTx`, `validUntil` and `restrictPayees`, plus `setPayee`, a single-use action hash and new errors. The brief's struct was changed deliberately. The guard is not deployed on any public network, so nothing breaks.
12. **R7 needs a verified wallet binding:** a verified Dynamic credential or a signed binding message. A wallet that is only declared fails with `CVI_NO_WALLET`, because its A-Pass would not prove anything about the owner. Without `DEMO_OWNER_PRIVATE_KEY`, Ava's wallet comes from a public demo key so the seed can sign a real binding. Never fund it.
13. **A-Pass in the trust score (P1 item 2, done):** the flat "verified human +20" is now passkey +10 plus Cleanverse A-Pass +10, read from `CleanversePass`. Seeded scores are unchanged (Trading Assistant 96).
14. **P1 items:**
    - **Travel Rule:** done. After each guarded transfer Fuku stores a record: Cleanverse's `download_travel_rule` in live mode, a record marked `source: "simulated"` in the simulator. It is hashed into `travelRuleRef` and downloadable from the result dialog and `GET /api/v1/actions/:id/travel-rule`.
    - **Envio:** done. The in-app HyperSync feed shows guard events, and the HyperIndex config and handlers cover the guard and the A-Pass simulator, with idempotent handlers. HyperIndex itself was not run here, because it needs Docker.
    - **CRE:** done (see `cre/README.md`).
    - **`cleanverse:check`:** done.
    - **Owner mandate from the Dynamic wallet:** built but not exercised. `@dynamic-labs-sdk/evm/viem` exposes `createWalletClientForWalletAccount`, and the mandate panel uses it to send `approve`, `openMandate` and `setPayee` from the owner's Dynamic wallet. It needs the guard on a chain the Dynamic environment supports, plus gas in that wallet.

## Open questions for Cleanverse

1. The chain identifier for Monad testnet. Is it `monad`?
2. Is aUSDC (or another A-Token) deployed on Monad testnet, and at what address?
3. The meaning of `verify_apass` codes 1 and 3. Fuku treats anything but 4 as a block and uses `query_apass` to explain why.
4. Does the A-Token allow `transferFrom` by a third-party contract (FukuSpendGuard) between two A-Pass holders, or does that contract need CCP registration (`validator/*`)?
5. The custody model. Fuku moves funds from the owner's wallet, which holds the A-Pass; the agent never holds an A-Pass. Is that the intended model, or should agents hold their own passes or delegated credentials?
6. Which endpoints expect encrypted bodies, and the format of the Travel Rule record.
7. Evidence freshness. Fuku caches the owner's A-Pass for 60 s and an attestation lives 5 min. Does the real A-Token re-check A-Passes at transfer time, as the simulator does? If not, a pass frozen inside that window could still move funds.

## Honesty guardrails

- Simulator output is never presented as Cleanverse-issued. The UI shows "Cleanverse simulator" and the SDK returns `mode: "simulated"`.
- The card reads live only after a successful live call.
- Fuku never collects KYC documents or bank data.
