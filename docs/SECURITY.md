# Fuku security model and trust assumptions

Checked against the code on 2026-09-30 (branch `feat/cleanverse-cvi-cva`). Where a property depends on a server key or on Fuku's database rather than on a contract, this document says so.

## 1. What is enforced, and by whom

| Claim | Enforced by | Evidence a third party can check |
| --- | --- | --- |
| Only the owner (or someone the owner delegated to) can register, change, run or revoke an agent | `web/src/lib/services/authz.ts`, used by every web, SDK and CRE route | 403 responses; `Delegation` rows |
| A value action needs a passkey-verified owner, a complete request and a daily limit | Engine rules R11, R12 (`web/src/lib/engine/permission.ts`) | The decision, rule id and proof hash anchored with `recordDecision` |
| An A-Token transfer needs the asset rule, the owner's A-Pass and the recipient's A-Pass | Engine rules R9, R7, R8 plus Cleanverse evidence (`complianceRef`) | `complianceRef` in the attestation and in `GuardedTransferExecuted` |
| A transfer moves only what the owner authorised: token, daily cap, per-transfer limit, expiry, approved payees, active agent, current passport | `FukuSpendGuard.execute` on-chain | The mandate (`mandates()`), `MandateOpened` and `PayeeSet` events |
| Each action executes at most once; retries do not pay twice | `actionExecuted` in the guard, plus `Idempotency-Key` in the API | `ActionAlreadyExecuted` revert; replayed responses |
| Parallel requests cannot spend the same remainder | Off-chain: one conditional `UPDATE` on `BudgetWindow`. On-chain: the guard's per-day cap | R5 decisions; `DailyCapExceeded` |
| Revoking or pausing stops outstanding authorisations | `revokePolicy` and `setStatus` on the registries, checked by the guard | `PolicyNotActive` / `AgentNotActive` reverts |
| A live write is never reported as a successful mock | `send`, `sendStrict`, `executeGuardedTransfer` in `web/src/lib/chain/index.ts` | `receipt.status` and `receiptMode` on every stored action |

What is **not** enforced on-chain:

- The passport's allowed and blocked actions, app scope and off-chain limits are evaluated by Fuku's engine. On-chain, the guard only checks that the passport hash matches.
- The application name is declared by the caller, so it is a label, not proof of where an action ran.

## 2. Authorization

- **Sessions (web app):** HS256 JWT cookie, 7 days, `httpOnly`, `sameSite=lax`, `secure` in production. In production the server refuses to start sessions without a random `FUKU_SESSION_SECRET` of at least 32 characters. Logout deletes the cookie; there is no server-side session revocation yet.
- **API keys (SDK, CRE):** a request that presents a key is authorised by that key alone. An invalid, revoked or disabled key gets 401 and never falls back to the browser session.
- **Acting for an owner** (`canActFor`) is allowed in three cases:
  - the caller is the owner;
  - the caller created the identity through `POST /api/v1/identities` (`managedById`);
  - the owner granted a `Delegation` with scope `agents:register`, `agents:manage` or `agents:execute`, still inside its expiry and not revoked.
- **Delegations:** only the owner can grant or revoke them, from a signed-in session (`/api/delegations`). An API key can never grant itself rights. A revocation takes effect on the next request.
- **Evidence exposure:** `checkPermission` returns Cleanverse evidence (the owner's wallet, record ids, tiers) only to callers who may execute for the agent. Other callers see the pass/fail legs.
- **Rate limits** (`web/src/lib/rate-limit.ts`, fixed windows per process, bounded to 10,000 keys):

  | Bucket | Limit | Keyed by |
  | --- | --- | --- |
  | auth | 20 per minute | client IP |
  | create | 20 per minute | caller |
  | manage | 30 per minute | caller |
  | execute | 60 per minute | caller |
  | read | 120 per minute | caller |

  With N server instances the effective budget is N times these; a shared store is the upgrade path.
- **Demo:** the demo sign-in, `?reset=1` and the seeded demo key are on in development and off in production unless `FUKU_DEMO_ENABLED=true`. The redirect only follows same-site paths.

## 3. Identity evidence

`verificationOf()` in `web/src/lib/services/identity.ts` reports four separate statuses:

| Status | Meaning | Evidence |
| --- | --- | --- |
| passkey | A WebAuthn ceremony with user verification (PIN or biometric) succeeded. The flag is `Identity.humanVerified` | Registration and login require UV |
| wallet | Control of the owner wallet was proven | A Dynamic JWT credential verified server-side, or a signed binding message (EIP-191) |
| unique human | **Never established.** Fuku does not run KYC or proof of personhood | none |
| Cleanverse | The verified wallet's A-Pass is eligible, from the last persisted read | `CleanversePass` row, `source` = cleanverse or simulated |

- **Wallet binding.** The owner signs a one-time message naming the Fuku identity, the wallet, the chain id, a nonce and a 5-minute expiry.
  - EOAs are verified locally. Contract wallets (ERC-1271, ERC-6492) are verified through the chain when it is live; in mock mode only EOAs can bind.
  - A wallet bound to one identity cannot be bound to another.
  - A declared wallet that was never bound fails R7 (`CVI_NO_WALLET`), because its A-Pass would not be the owner's.
- **WebAuthn.**
  - User verification is required.
  - Origins are pinned by `WEBAUTHN_ORIGINS` (falling back to `NEXT_PUBLIC_APP_URL`); outside production, `http://localhost:*` is also accepted.
  - The RP ID comes from `WEBAUTHN_RP_ID` or the origin.
  - Challenges live 5 minutes and are consumed with a conditional delete, so they are single-use even under concurrency.
  - Attestation is `none`: Fuku does not vet authenticator models.

## 4. The enforced financial flow

Setup, done by the owner's own wallet:

1. `approve(FukuSpendGuard, amount)` on the A-Token.
2. `openMandate(agentId, token, dailyCap, maxPerTx, validUntil, restrictPayees)`.
3. `setPayee(agentId, payee, true)`.

Per transfer:

1. The API authorises the caller and evaluates the passport, owner and request (R0 to R4, R11, R12, R9, R7, R8, R5).
2. It reserves the day's budget atomically and creates the action row. The row id is the action id: `actionHash = keccak256(id)`.
3. The compliance signer signs an EIP-712 `GuardedTransfer` over:
   `agentId, from, to, token, amount, policyHash, actionHash, proofHash, complianceRef, mandateVersion, nonce, deadline`
   The deadline is now + 5 minutes.
4. The guard checks, in order:
   - deadline, unused nonce, unused action hash, and a low-s signature from the compliance signer (domain: name, version, chain id, guard address);
   - the agent exists and is not paused or revoked;
   - the policy is active and its hash equals the attested one;
   - the mandate is active, on this token, at this version, and not expired;
   - the amount is non-zero, within `maxPerTx`, and the payee is approved (when restricted);
   - the UTC-day cap.
   It then marks the nonce and action used, calls `transferFrom` (the token re-checks both A-Passes and its revert bubbles up), calls `recordDecision(R6)` and emits `GuardedTransferExecuted`. It is `nonReentrant` and holds no funds.
5. The row becomes `CONFIRMED` with the tx hash, block, block hash and log index, and one reputation success is recorded for it.

**Scope.** Fuku can only move tokens a wallet has approved to the guard, inside that wallet's mandate. It cannot control other wallets or assets.

**Denials.** A would-be revert is caught in simulation and recorded as R10 with a separate `recordDecision`, because a reverted transaction leaves no event.

## 5. Execution lifecycle

| From | To | When |
| --- | --- | --- |
| (request) | DENIED | Any rule blocks: R0 to R12, or R10 when the guard would revert. Nothing executes |
| (request) | AUTHORIZED | Allowed, and Fuku does not execute this kind of action. The decision is anchored; the agent's own integration executes it |
| AUTHORIZED | SUBMITTED | A guarded transfer is broadcast. Its hash is stored before waiting |
| SUBMITTED | CONFIRMED | The receipt succeeded |
| SUBMITTED | PENDING | No receipt within 90 s. HTTP 202; reconciliation settles it |
| SUBMITTED, PENDING | FAILED | Mined and reverted, or never executed and the attestation expired. The budget is released |
| AUTHORIZED | FAILED | Signing or RPC failed before broadcast. HTTP 502, the budget is released, nothing moved |
| AUTHORIZED | SIMULATED | Mock chain: the transfer path ran and nothing moved |
| CONFIRMED | PENDING | Reconciliation no longer finds the receipt (reorg). The success event is removed until it confirms again |

Rules that follow from the lifecycle:

- **Idempotency.** An `Idempotency-Key` is unique per agent. A repeat with the same body replays the stored result; a different body gets 422; an in-flight request gets 409.
- **Reputation.** Only CONFIRMED earns a success.
  - A DENIED caused by the agent's own request is a violation.
  - A DENIED caused by the owner or the infrastructure is neutral: R7, R11, a guard that is not configured, or no mandate.
  - AUTHORIZED, SIMULATED, PENDING and FAILED change nothing.
  - There is at most one event per action.
- **Reconciliation.** `npm run reconcile`, or throttled on activity reads. It settles SUBMITTED and PENDING rows from the stored hash.
  - It recovers a transfer whose hash was never stored (a crash) through the guard's `actionExecuted` and its event log.
  - It re-checks confirmations from the last `FUKU_REORG_DEPTH` blocks (default 64).
  - It retries failed decision anchors.
  - Every transition is a conditional update, so concurrent runs are safe.
- **Chain writes.** They come from one relayer key, serialised in process and across processes by a `ChainLock` lease row (150 s). A live failure is stored as `failed`, never as a mock receipt.

**Known limitation.** A decision anchor (`recordDecision`, not value-moving) whose process dies between broadcast and storing the result may be retried and recorded twice in the registry's counters. A guarded transfer cannot be: the action hash is single-use on-chain.

## 6. Remaining trust assumptions and admin powers

1. **The relayer key** (`DEPLOYER_PRIVATE_KEY`) owns the four registries and is the on-chain controller of every identity (`HumanIdentityRegistry` sets the controller to `msg.sender`). It is also the enforcer and the scorer, and it sets the human-verified flag. It can therefore record any decision or score for any agent. Moving identity control to the owner's own key requires redeploying the registries, which is not done: see the open decision in the final report.
2. **The compliance signer** (`FUKU_COMPLIANCE_SIGNER_KEY`) can attest any transfer that fits a mandate the owner opened, for an active agent whose on-chain passport hash matches. It cannot exceed the owner's token, cap, per-transfer limit, expiry or payee list.
3. **The guard's owner** can rotate the compliance signer. The simulator contracts' owner issues simulator A-Passes and mints `aUSDC-SIM`; they are not Cleanverse.
4. **The engine and database.** The passport's allowed actions, app scope and off-chain limits, and the reputation ledger, live in Fuku's database and are enforced by Fuku's server. On-chain commitments prove the integrity of a recorded decision, not that an AUTHORIZED action was executed or executed correctly.
5. **Cleanverse** runs in simulator mode until the API invite lands (`docs/CLEANVERSE.md`). The real A-Token's transfer rules for third-party contracts are unverified.
6. **Memory vault.** Every identity derives its key from a fixed demo passphrase, so the encryption is structural, not secret. Agents get no key access, and there are no scoped grants.
7. **Not claimed:** unique-human proof, KYC, ERC-8004 conformance (the registries are inspired by it), decentralised verification, and production readiness.

## 7. Reproduce

Local runs on 2026-09-30:

| Command | Expected |
| --- | --- |
| `cd contracts && npm test` | 59 passing |
| `npm test` (root: web + sdk) | 58 web tests, 8 SDK tests, all passing |
| `cd web && npx tsc --noEmit && npm run lint` | no errors |
| `cd cre/fuku-guard && bun test` | 10 pass |
| Local node smoke (`docs/CLEANVERSE.md` "Run it locally", with `DATABASE_URL` pointing at the web instance's database) | `44/44 checks passed` |
| `node examples/sdk-consumer/index.mjs` (after `npm run build -w sdk`) | 17 steps `ok`, exit 0 |
| Mock mode (no chain env): demo reset, then withdraw 4,800 | R2, score 96 → 92, receipt `simulated` |

## 8. Production configuration

The production environment needs:

- `FUKU_SESSION_SECRET`: at least 32 random characters.
- `WEBAUTHN_ORIGINS` (or `NEXT_PUBLIC_APP_URL`) and `WEBAUTHN_RP_ID` for the public domain.
- `FUKU_DEMO_ENABLED` unset. Set it to `true` only for an isolated demo deployment.
- A dedicated `FUKU_COMPLIANCE_SIGNER_KEY`, not the deployer.
- A scheduled `npm run reconcile`.
- A shared database for several instances. SQLite is single-node.
- Upgrade the rate limits to a shared store before scaling out.

## 9. Testnet runbook (not executed; each step needs the owner's go-ahead)

1. `contracts/.env`: set `COMPLIANCE_SIGNER_ADDRESS` to a fresh key's address and `FUKU_COMPLIANCE_SIGNER_KEY` to that key.
2. `cd contracts && npm run deploy:cleanverse:monad`. This is four transactions: two simulators, the guard, and one enforcer grant. The four registries are untouched.
3. `npm run wire:env`. It writes `FUKU_SPEND_GUARD`, `CLEANVERSE_SIM_*` and the signer key into `web/.env`.
4. Add a fresh `DEMO_OWNER_PRIVATE_KEY` to `web/.env`, then run `cd web && npm run cleanverse:setup`. That is about 8 transactions: passes, mint, gas top-up, approve, mandate and payee.
5. Restart the app. Reset the demo so Ava's wallet binding uses the new key.
6. Run the smoke against testnet: `FUKU_BASE_URL=… MONAD_RPC_URL=https://testnet-rpc.monad.xyz FUKU_DEPLOYMENT_FILE=../contracts/deployments/monadTestnet.json DATABASE_URL=… node scripts/live-smoke.mjs`. The reorg check is skipped off Hardhat.
