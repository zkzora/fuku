# @fuku/sdk

The developer surface of Fuku Protocol: agent identity bound to a passkey-verified owner, permission passports, one enforced payment flow, and an explainable trust score on Monad.

```ts
import { Fuku } from "@fuku/sdk";

const fuku = new Fuku({ apiKey: process.env.FUKU_API_KEY!, baseUrl: "http://localhost:3001" });

// What backs this agent? One check per claim; `verified` needs all of them (never just a DB row).
const v = await fuku.verifyAgent("fuku:agent:0x7a3f…9c21");
// v.checks.owner.passkey.status, v.checks.owner.wallet.status, v.checks.anchoring.status, v.checks.executable.ok

// Preview (nothing recorded, reserved or signed)
const check = await fuku.checkPermission(agentId, { action: "withdraw", amountUsdc: 4800 });
// check.preview === true, check.allowed === false, check.ruleId === "R2"

// Full workflow: authorize → evaluate → execute or block → anchor → score → explain
const key = Fuku.newIdempotencyKey();
const result = await fuku.executeAction(agentId, { action: "swap", amountUsdc: 1200, app: "Monad DEX" }, { idempotencyKey: key });
// result.decision, result.status ("AUTHORIZED": Fuku recorded the decision, your integration executes it)

// Register your own agent and attach a passport (value actions need a daily limit)
const { agent } = await fuku.registerAgent({ name: "Support Agent", capabilities: ["read_vault", "summarize"] });
await fuku.requestPermission(agent.id, { allowed: [{ action: "read_vault" }], blocked: ["withdraw"] });
const trust = await fuku.getTrustScore(agent.id);
```

## The enforced flow: Cleanverse A-Token payments

A passport that lists A-Tokens (`assets: ["aUSDC"]`) lets its agent `transfer` only after several checks:

1. Cleanverse checks the asset rule (R9), the owner's A-Pass on a *verified* wallet (R7) and the recipient's A-Pass (R8).
2. Fuku's compliance signer attests to that exact transfer (EIP-712). The attestation is bound to the action, the amount, the recipient, the passport hash and the owner's mandate version.
3. `FukuSpendGuard` moves the token from the owner's wallet. It does so only inside the mandate that the owner's own wallet opened on-chain: token, daily cap, per-transfer limit, expiry and approved payees. It also checks that the agent is active and that the passport hash matches.
4. Each action executes at most once on-chain.

```ts
const { mandate } = await fuku.getMandate(paymentsAgentId);  // the owner's on-chain mandate
const pay = await fuku.executeAction(
  paymentsAgentId,
  { action: "transfer", amountUsdc: 250, asset: "aUSDC", to: supplierWallet },
  { idempotencyKey: Fuku.newIdempotencyKey() },
);
pay.status;       // "CONFIRMED" (mined), "PENDING" (broadcast, HTTP 202), "DENIED", "FAILED", "SIMULATED" (mock chain)
pay.transfer;     // { txHash, explorerUrl, mode, status, block, logIndex }
const receipt = await fuku.getAction(pay.id);   // lifecycle + evidence: actionHash, chainId, block, logIndex
```

A few rules for reading results:

- `compliance.mode === "simulated"` means Fuku's Cleanverse simulator answered, not Cleanverse. A receipt with `mode: "mock"` has no transaction behind it.
- In live mode a write that failed says `status: "failed"`. It is never presented as a mock success.
- Retrying with the same `idempotencyKey` replays the stored result (`replayed: true`). The same key with a different body is rejected with `idempotency_mismatch`.

## Agent-signed execution

An agent can hold its own key: you generate it, keep it, and give Fuku only its address with `setErc8004AgentKey()` (it becomes the agent's ERC-8004 `agentWallet`). Fuku then executes that agent over the API only when the request is signed with that key:

```ts
import { privateKeyToAccount } from "viem/accounts";

const agentKey = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const pay = await fuku.executeAction(agentId, { action: "transfer", amountUsdc: 30, asset: "aUSDC", to: supplier }, { signer: agentKey });
pay.agentSignature; // { signer: "0x…" }: Fuku checked the signature against the agent's key
```

- The signature (EIP-191) covers the exact request body, the idempotency key and the issue time (`agentRequestMessage()` builds the message). Fuku accepts it for 5 minutes.
- Without a signature, an execution for such an agent is refused with `401 agent_signature_required`. A signature from another key is refused with `agent_signature_invalid`.
- Agents whose key Fuku holds (the seeded demo agents) and agents without a key are executed as before.
- Any object with `signMessage({ message })` works as a signer; the SDK itself has no crypto dependency.

## Authorization

A key acts for its own identity, and for identities it created with `createIdentity()` (recorded as managed by it). To act for any other owner, that owner must grant it a delegation in the Developer Console, with scopes `agents:register`, `agents:manage` or `agents:execute`.

Delegations cannot be granted through the SDK. That is deliberate: an API key can never give itself rights. Without a delegation, calls are refused with `403 forbidden`, and an invalid key gets `401`. There is no fallback.

## Errors

Blocked actions resolve with the result (HTTP 403). Everything else that fails throws `FukuError` with `status`, `code`, `body` and, for 429, `retryAfter`. The codes are:

- `unauthorized`, `forbidden`, `rate_limited`, `invalid_request`, `not_found`
- `idempotency_mismatch`, `idempotency_in_progress`, `idempotency_failed`
- `agent_signature_required`, `agent_signature_invalid`, `agent_signature_expired` (401: see "Agent-signed execution")
- `chain_write_failed` (502: the guarded transfer was not sent, nothing moved)

| Method | Endpoint |
| --- | --- |
| `createIdentity()` | `POST /api/v1/identities` |
| `registerAgent()` | `POST /api/v1/agents` |
| `verifyAgent()` | `GET /api/v1/agents/:id` |
| `requestPermission()` / `revokePermission()` | `PUT` / `DELETE /api/v1/agents/:id/permissions` |
| `getTrustScore()` | `GET /api/v1/agents/:id/trust` |
| `checkPermission()` | `POST /api/v1/agents/:id/check` |
| `executeAction()` | `POST /api/v1/agents/:id/execute` |
| `getAction()` | `GET /api/v1/actions/:id` |
| `getMandate()` | `GET /api/v1/agents/:id/mandate` |
| `verifyScore()` | `GET /api/v1/agents/:id/verify-score` |

Get an API key from the Developer Console in the Fuku app. The seeded demo key is `fk_live_demo_ava_chen_2026`; it only works while the demo is enabled (development, or `FUKU_DEMO_ENABLED=true`).

- Build: `npm run build` (emits `dist/`).
- Test: `npm test` (contract tests against a fake HTTP server).
- A complete consumer lives in [`examples/sdk-consumer`](../examples/sdk-consumer). It previews, pays, retries, verifies on-chain, revokes and shows the next attempt fail.

## Changes

### 0.5.0

- Agent keys: `createAgentKey(agentId, { name, scopes? })`, `listAgentKeys()`, `revokeAgentKey()`. An agent key (`fk_agent_…`) acts only as its agent, only with its scopes (`agent:read`, `agent:check`, `agent:execute`, `agent:actions`; `agents:verify` for other agents' public verification, opt-in). Every other route answers 403 with a `code` starting `agent_key_`. Give it to the software that runs the agent instead of the owner's key.
- `keyInfo()`: whether the client's key is an owner key or an agent key, and for which agent and scopes.

### 0.4.0

- `executeAction(…, { signer })` signs the request with the agent's own key. Fuku requires it for agents that hold their own key: unsigned executions for them are refused with 401 (breaking for such agents).
- `verifyScore()`: recompute the trust score from the chain (commit-reveal), with the ✓ as `verified`.
- `verifyAgent()` adds `agent.agentKey`, `agent.erc8004` and `owner.custody`; `getMandate()` adds `payees` and `payeesSource`; `ActionResult.agentSignature` is new.

### 0.3.0 (breaking)

- `Receipt.txHash`, `block` and `explorerUrl` can be `null`: a failed live write has no hash, and a mock receipt has no explorer link. `Receipt.status` and `chainId` are new.
- `verifyAgent().verified` is true only when every check holds. It is false in mock mode and for unanchored or stale agents. Read `checks` for the reasons.
- `ActionResult.status` (the lifecycle) is new. An allowed action Fuku does not execute is `AUTHORIZED` and earns no reputation. Only confirmed transfers do.
- Engine rules applied to every client, including CRE:
  - R4 now requires `app` for scoped passports.
  - R11 blocks value actions for an owner without passkey verification.
  - R12 requires a positive amount (6 decimals at most), a valid `to` for transfer, and a daily limit on every allowed value action.
- `registerAgent({ ownerIdentityId })` needs a delegation (403 otherwise). Invalid keys are 401 instead of falling back to a session.
- New: `executeAction(…, { idempotencyKey })`, `getAction()`, `getMandate()`, `FukuError.code`, `Fuku.newIdempotencyKey()`. The trust score adds `scoringVersion`, `dimensions`, `evidence` and `uncertainty`.

### 0.2.0

- Cleanverse A-Token payments: `to`, `asset`, `compliance`, `transfer`, `owner.cleanverse`.
- `revokePermission()` returns `chainSync`.
