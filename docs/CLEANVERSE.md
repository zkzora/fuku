# Fuku × Cleanverse: CVI / CVA integration

Status on 2026-09-30:

- The code path is complete: engine rules, the Cleanverse client, the simulator, FukuSpendGuard, UI and SDK.
- The live Cleanverse API has **never been called**. API access is invite-only and the invite is pending. The client is covered only by contract tests against a fake HTTP server.
- Everything that runs today runs against **Fuku's simulator**, which is labelled as such everywhere.
- The simulator contracts and the guard are verified end to end on a local Hardhat node. They are **not deployed to Monad testnet**: that needs the owner's go-ahead (four transactions on the existing stack).

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
| R10 on-chain guard | The guard would revert. The reason is the decoded custom error, or `GUARD_NOT_CONFIGURED` when the chain is live but the guard or signer is not set | `GUARD_REJECTED`, `GUARD_NOT_CONFIGURED` |

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
  `GuardedTransfer(bytes32 agentId,address from,address to,address token,uint256 amount,bytes32 policyHash,bytes32 actionHash,bytes32 proofHash,bytes32 complianceRef,uint64 mandateVersion,uint256 nonce,uint64 deadline)`.
- **The owner's mandate:** `openMandate(agentId, token, dailyCap, maxPerTx, validUntil, restrictPayees)` and `setPayee(agentId, payee, allowed)`, both sent from the owner's own wallet.
  - `mandates(agentId, wallet)` returns `(token, dailyCap, maxPerTx, validUntil, restrictPayees, version, active)`.
  - The version increases on every open and close, so reopening a mandate voids attestations signed against the old one.
- **Checks, in order:**
  1. Deadline; unused nonce; unused action hash (`ActionAlreadyExecuted`); a low-s signature from the compliance signer.
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
DATABASE_URL=<the web instance's database> FUKU_BASE_URL=http://localhost:3002 node scripts/live-smoke.mjs
~~~

Expected result: `45/45 checks passed`. The 26 Cleanverse and guard checks cover the following:
- 250 aUSDC-SIM to Nusantara is CONFIRMED. The transfer, `GuardedTransferExecuted` (bound to the action id) and `ActionDecision` land in one transaction, and `GET /api/v1/actions/:id` returns the tx and its log index.
- The Travel Rule record (simulator) is stored and its canonical-JSON hash equals the action's `travelRuleRef`.
- Frozen and Unverified are blocked with R8 `CVI_FROZEN` and `CVI_NOT_FOUND`, with no Transfer event.
- A repeated `Idempotency-Key` replays instead of paying twice.
- Direct attestations revert with `PerTxLimitExceeded`, `PayeeNotApproved` and `DailyCapExceeded`.
- Two concurrent requests cannot spend the same remainder, and the balances move exactly once per confirmed transfer (900 in total).
- Reconciliation, run as a separate process, recovers a transfer whose hash was never stored, without double credit. A confirmation removed by `evm_revert` goes back to PENDING and loses its credit.
- Revoking in the app emits `PolicyRevoked`, after which a pre-signed attestation reverts with `PolicyNotActive` and the app blocks the agent.

Without any chain env (mock mode), the demo runs with the fixture backend and mock receipts.

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
