import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddressEqual,
  isHex,
  keccak256,
  parseEventLogs,
  stringToHex,
  toHex,
  zeroAddress,
  type Log,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { randomBytes, randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { idToBytes32, hashJson, hashString } from "../ids";
import { db } from "../db";
import { parsePolicy, policyAnchorHash } from "../engine/policy";
import { custodyFor, type Custody } from "../custody";
import {
  AgentRegistryAbi,
  FukuSpendGuardAbi,
  HumanIdentityRegistryAbi,
  PermissionRegistryAbi,
  ReputationRegistryAbi,
} from "./abi";

/**
 * Monad settlement adapter.
 *
 * mode "live": signs real transactions against the deployed Fuku registries.
 * mode "mock": produces deterministic proof hashes and pseudo transaction receipts so the
 *              full trust flow runs locally with no key, no RPC and no gas.
 *
 * Go live with FUKU_CHAIN_MODE=live, DEPLOYER_PRIVATE_KEY and the four FUKU_*_REGISTRY
 * addresses. The chain itself is configurable so the same code runs against Monad testnet
 * (default), a local Hardhat node (FUKU_CHAIN_ID=31337) or any other EVM endpoint:
 *
 *   FUKU_CHAIN_ID      default 10143
 *   FUKU_CHAIN_NAME    default "Monad Testnet"
 *   MONAD_RPC_URL      default https://testnet-rpc.monad.xyz
 *   FUKU_EXPLORER_URL  default https://testnet.monadexplorer.com
 *
 * Identities and agents created while in mock mode (including the seeded demo data) were
 * never anchored, and the registries enforce ownership: AgentRegistry.registerAgent requires
 * the signer to control the owner identity, and PermissionRegistry / ReputationRegistry
 * revert with AgentNotFound for unknown agents. The live path therefore anchors lazily and
 * idempotently: it registers the identity (and marks it human-verified, since the signer is
 * the registry owner) before registering an agent, and registers the agent before writing a
 * policy, a decision or a score for it.
 */

export const MONAD_TESTNET = {
  id: 10143,
  name: "Monad Testnet",
  rpc: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadexplorer.com",
} as const;

export interface ChainConfig {
  id: number;
  name: string;
  rpc: string;
  explorer: string;
}

/** Chain parameters from the environment, falling back to Monad testnet. */
export function chainConfig(): ChainConfig {
  const rawId = Number(process.env.FUKU_CHAIN_ID ?? MONAD_TESTNET.id);
  return {
    id: Number.isInteger(rawId) && rawId > 0 ? rawId : MONAD_TESTNET.id,
    name: process.env.FUKU_CHAIN_NAME?.trim() || MONAD_TESTNET.name,
    rpc: process.env.MONAD_RPC_URL?.trim() || MONAD_TESTNET.rpc,
    explorer: (process.env.FUKU_EXPLORER_URL?.trim() || MONAD_TESTNET.explorer).replace(/\/+$/, ""),
  };
}

function toChain(c: ChainConfig): Chain {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
    blockExplorers: { default: { name: `${c.name} Explorer`, url: c.explorer } },
    testnet: true,
  });
}

/** The chain the adapter settles on (Monad testnet unless FUKU_CHAIN_* overrides it). */
export function settlementChain(): Chain {
  return toChain(chainConfig());
}

/** Monad testnet with the built-in defaults (kept for callers that want the canonical chain). */
export const monadTestnet = toChain({ ...MONAD_TESTNET });

export type ChainMode = "live" | "mock";

/**
 * confirmed: mined successfully (live). pending: broadcast, receipt not seen yet; reconciliation
 * settles it. failed: nothing was anchored (live). simulated: a mock receipt (mock mode only).
 * awaiting-owner: the identity is owner-controlled and this write must be signed by the owner's
 * wallet (see lib/custody.ts); nothing was sent. A live failure is never dressed up as a mock receipt.
 */
export type ReceiptStatus = "confirmed" | "pending" | "failed" | "simulated" | "awaiting-owner";

export interface ChainReceipt {
  txHash: Hex | null;
  block: number | null;
  mode: ChainMode;
  status: ReceiptStatus;
  chainId: number;
  explorerUrl: string | null;
  note?: string;
}

/** How a write should be recorded on its row: live-anchored, mock, pending or failed. */
export function anchorStateOf(r: ChainReceipt | null): "anchored" | "mock" | "pending" | "failed" | "awaiting-owner" {
  if (!r) return "failed";
  return r.status === "confirmed" ? "anchored" : r.status === "simulated" ? "mock" : r.status;
}

/** The identity fields the live path needs to anchor an identity lazily. */
export interface IdentityRef {
  id: string;
  humanVerified: boolean;
  /** Who controls the identity on-chain; owner-controlled identities are never anchored by the relayer. */
  custody?: Custody;
  /** The bound owner wallet (the controller when custody is "owner"). */
  wallet?: string | null;
  /** keccak256 ownership proof stored on the Identity row (falls back to a hash of the id). */
  proofHash?: string | null;
  passkeyPubKeyHash?: Hex | null;
}

/** The agent fields the live path needs to register an agent lazily. */
export interface AgentRef {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  identity: IdentityRef;
}

/** Build an AgentRef from Prisma rows (capabilities are stored as a JSON string). */
export function toAgentRef(
  agent: {
    id: string;
    name: string;
    version: string;
    capabilities: string | string[];
  },
  identity: {
    id: string;
    humanVerified: boolean;
    proofHash?: string | null;
    walletAddress?: string | null;
    walletVerifiedBy?: string | null;
    chainCustody?: string | null;
  },
): AgentRef {
  let capabilities: string[] = [];
  if (Array.isArray(agent.capabilities)) capabilities = agent.capabilities;
  else {
    try {
      const parsed = JSON.parse(agent.capabilities);
      if (Array.isArray(parsed)) capabilities = parsed.map(String);
    } catch {
      capabilities = [];
    }
  }
  return {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    capabilities,
    identity: {
      id: identity.id,
      humanVerified: identity.humanVerified,
      proofHash: identity.proofHash ?? null,
      custody: custodyFor(identity),
      wallet: identity.walletVerifiedBy ? (identity.walletAddress ?? null) : null,
    },
  };
}

interface Addresses {
  identity: Address;
  agents: Address;
  permissions: Address;
  reputation: Address;
}

function addresses(): Addresses | null {
  const a = {
    identity: process.env.FUKU_IDENTITY_REGISTRY,
    agents: process.env.FUKU_AGENT_REGISTRY,
    permissions: process.env.FUKU_PERMISSION_REGISTRY,
    reputation: process.env.FUKU_REPUTATION_REGISTRY,
  };
  if (!a.identity || !a.agents || !a.permissions || !a.reputation) return null;
  return a as Addresses;
}

function signerKey(): Hex | null {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  return isHex(key) && key.length === 66 ? (key as Hex) : null;
}

let warnedIncomplete = false;

export function chainMode(): ChainMode {
  const forced = process.env.FUKU_CHAIN_MODE;
  if (forced !== "live") return "mock";
  if (signerKey() && addresses()) return "live";
  if (!warnedIncomplete) {
    warnedIncomplete = true;
    console.warn(
      "[fuku-chain] FUKU_CHAIN_MODE=live but DEPLOYER_PRIVATE_KEY or a FUKU_*_REGISTRY address is missing; running in mock mode",
    );
  }
  return "mock";
}

export function chainStatus() {
  const c = chainConfig();
  const mode = chainMode();
  const key = signerKey();
  return {
    mode,
    chainId: c.id,
    network: c.name,
    rpc: c.rpc,
    explorer: c.explorer,
    contracts: addresses(),
    spendGuard: spendGuardAddress(),
    signer: mode === "live" && key ? privateKeyToAccount(key).address : null,
  };
}

/** Read-only client for the settlement chain, or null in mock mode. */
export function chainReader(): PublicClient | null {
  if (chainMode() !== "live") return null;
  const chain = settlementChain();
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]), pollingInterval: POLLING_INTERVAL_MS });
}

function envAddress(name: string): Address | null {
  const v = process.env[name]?.trim();
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;
}

/** FukuSpendGuard address (FUKU_SPEND_GUARD), or null when not deployed / not wired. */
export function spendGuardAddress(): Address | null {
  return envAddress("FUKU_SPEND_GUARD");
}

/** The EIP-712 signer the guard trusts (FUKU_COMPLIANCE_SIGNER_KEY). Never the relayer by default. */
function complianceSigner(): PrivateKeyAccount | null {
  const raw = process.env.FUKU_COMPLIANCE_SIGNER_KEY?.trim();
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  return isHex(key) && key.length === 66 ? privateKeyToAccount(key as Hex) : null;
}

let mockBlock = 18_204_331;
function mockReceipt(op: string, payload: unknown, note?: string): ChainReceipt {
  const txHash = keccak256(stringToHex(`${op}:${JSON.stringify(payload)}:${Date.now()}:${Math.random()}`));
  mockBlock += 1 + Math.floor(Math.random() * 3);
  return {
    txHash,
    block: mockBlock,
    mode: "mock",
    status: "simulated",
    chainId: chainConfig().id,
    // A mock hash has no transaction behind it, so there is no explorer link.
    explorerUrl: null,
    note: note ?? `Mock settlement (set FUKU_CHAIN_MODE=live to anchor on ${chainConfig().name})`,
  };
}

// --- Live write health (for the integration board) ------------------------------------------

export interface ChainHealth {
  ok: boolean;
  at: string;
  op: string;
  error?: string;
}
const health = globalThis as unknown as { __fukuChainHealth?: ChainHealth };
function noteHealth(ok: boolean, op: string, error?: string) {
  health.__fukuChainHealth = { ok, op, at: new Date().toISOString(), ...(error ? { error: error.slice(0, 200) } : {}) };
}
/** Outcome of the most recent live write in this process, or null if there has been none. */
export function lastChainWrite(): ChainHealth | null {
  return health.__fukuChainHealth ?? null;
}

// --- Live path ---------------------------------------------------------------------------

const RECEIPT_TIMEOUT_MS = 90_000;
const POLLING_INTERVAL_MS = 1_000;

interface LiveCtx {
  addresses: Addresses;
  chain: Chain;
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Human-readable notes about extra anchoring transactions, surfaced on the receipt. */
  notes: string[];
}

function liveContext(): LiveCtx {
  const key = signerKey();
  const a = addresses();
  if (!key || !a) throw new Error("live settlement is not configured");
  const chain = settlementChain();
  const account = privateKeyToAccount(key);
  const transport = http(chain.rpcUrls.default.http[0]);
  return {
    addresses: a,
    chain,
    account,
    publicClient: createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS }),
    walletClient: createWalletClient({ chain, transport, account }),
    notes: [],
  };
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

interface Mined {
  hash: Hex;
  block: bigint;
  blockHash: Hex;
  logs: Log[];
}

/** Broadcast, but no receipt within RECEIPT_TIMEOUT_MS. The transaction may still be mined. */
export class ReceiptTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly hash: Hex,
  ) {
    super(`${label} was broadcast (tx ${hash}) but no receipt arrived in time`);
    this.name = "ReceiptTimeoutError";
  }
}

/** Mined, but the transaction reverted (a race after a successful simulation). */
export class RevertedOnChainError extends Error {
  constructor(
    readonly label: string,
    readonly hash: Hex,
    readonly block: bigint,
  ) {
    super(`${label} reverted on-chain (tx ${hash})`);
    this.name = "RevertedOnChainError";
  }
}

/**
 * Simulate (so reverts decode to custom errors), send, then wait until mined. `onSubmitted` runs
 * right after the broadcast, before waiting, so callers can persist the hash first: a crash or a
 * timeout after that point can be reconciled from the stored hash instead of being retried blind.
 */
async function write(ctx: LiveCtx, label: string, call: Call, onSubmitted?: (hash: Hex) => Promise<void> | void): Promise<Mined> {
  const { request } = await ctx.publicClient.simulateContract({ ...call, account: ctx.account, chain: ctx.chain });
  const hash = await ctx.walletClient.writeContract(request);
  await onSubmitted?.(hash);
  let receipt;
  try {
    receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  } catch {
    throw new ReceiptTimeoutError(label, hash);
  }
  if (receipt.status !== "success") throw new RevertedOnChainError(label, hash, receipt.blockNumber);
  console.log(`[fuku-chain] ${label} mined: tx ${hash} block ${receipt.blockNumber}`);
  return { hash, block: receipt.blockNumber, blockHash: receipt.blockHash, logs: receipt.logs };
}

/** Turn a viem error into a short reason, preferring the decoded custom error. */
export function describeChainError(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason ?? "revert";
      const args = (reverted.data?.args ?? []).map((v) => String(v)).join(", ");
      return `${name}(${args})`;
    }
    return err.shortMessage || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function proofHashOf(identity: IdentityRef): Hex {
  const p = identity.proofHash;
  return p && isHex(p) && p.length === 66 ? (p as Hex) : hashString(identity.id);
}

/**
 * An owner-controlled identity needs its owner's wallet for this write; the relayer does not send
 * it. Surfaced as an `awaiting-owner` receipt (or an R10 rejection for a guarded transfer).
 */
export class OwnerSignatureRequired extends Error {
  constructor(
    readonly op: "registerIdentity" | "registerAgent" | "setPolicy" | "revokePolicy" | "setStatus",
    readonly subject: string,
  ) {
    super(`${op} for ${subject} must be signed by the owner's wallet`);
    this.name = "OwnerSignatureRequired";
  }
}

async function rememberCustody(identityId: string, custody: Custody) {
  await db.identity.updateMany({ where: { id: identityId, chainCustody: null }, data: { chainCustody: custody } }).catch(() => undefined);
}

/**
 * Register the identity on-chain if it is missing; sync the human-verified flag. Idempotent.
 * Owner-controlled identities are never registered by the relayer: their owner's wallet must.
 */
async function ensureIdentityOnChain(ctx: LiveCtx, identity: IdentityRef): Promise<void> {
  const key = idToBytes32(identity.id);
  const [controller, , , , humanVerified] = await ctx.publicClient.readContract({
    address: ctx.addresses.identity,
    abi: HumanIdentityRegistryAbi,
    functionName: "identities",
    args: [key],
  });

  if (controller === zeroAddress && identity.custody === "owner") throw new OwnerSignatureRequired("registerIdentity", identity.id);
  if (controller === zeroAddress) {
    const proofHash = proofHashOf(identity);
    await write(ctx, "registerIdentity", {
      address: ctx.addresses.identity,
      abi: HumanIdentityRegistryAbi,
      functionName: "registerIdentity",
      args: [key, identity.passkeyPubKeyHash ?? proofHash, proofHash],
    });
    ctx.notes.push(`identity ${identity.id} anchored`);
    await rememberCustody(identity.id, "relayer");
    if (identity.humanVerified) await markHumanVerified(ctx, identity, key);
    return;
  }

  if (!isAddressEqual(controller, ctx.account.address)) {
    // Owner-controlled (or foreign). The relayer may still attest the passkey flag as registry owner.
    if (identity.custody === "owner" && identity.humanVerified && !humanVerified) await markHumanVerified(ctx, identity, key);
    return;
  }
  await rememberCustody(identity.id, "relayer");
  if (identity.humanVerified && !humanVerified) await markHumanVerified(ctx, identity, key);
}

/** setHumanVerified is owner-only; a failure here should not sink the main transaction. */
async function markHumanVerified(ctx: LiveCtx, identity: IdentityRef, key: Hex): Promise<void> {
  try {
    await write(ctx, "setHumanVerified", {
      address: ctx.addresses.identity,
      abi: HumanIdentityRegistryAbi,
      functionName: "setHumanVerified",
      args: [key, true],
    });
    ctx.notes.push(`identity ${identity.id} marked human-verified`);
  } catch (err) {
    console.warn(`[fuku-chain] setHumanVerified skipped for ${identity.id}: ${describeChainError(err)}`);
  }
}

function registerAgentCall(ctx: LiveCtx, agent: AgentRef): Call {
  return {
    address: ctx.addresses.agents,
    abi: AgentRegistryAbi,
    functionName: "registerAgent",
    args: [
      idToBytes32(agent.id),
      idToBytes32(agent.identity.id),
      agent.name,
      agent.version,
      hashJson(agent.capabilities),
      `fuku://agents/${agent.id}`,
    ],
  };
}

/**
 * Register the agent (and its identity) on-chain if missing, and, when `syncPolicy` is set, anchor
 * the database's current passport if the registry lacks it (passports approved in mock mode were
 * never anchored). Idempotent.
 */
async function ensureAgentOnChain(ctx: LiveCtx, agent: AgentRef, opts: { syncPolicy?: boolean } = {}): Promise<void> {
  const exists = await ctx.publicClient.readContract({
    address: ctx.addresses.agents,
    abi: AgentRegistryAbi,
    functionName: "exists",
    args: [idToBytes32(agent.id)],
  });
  if (!exists) {
    await ensureIdentityOnChain(ctx, agent.identity);
    if (agent.identity.custody === "owner") throw new OwnerSignatureRequired("registerAgent", agent.id);
    await write(ctx, "registerAgent", registerAgentCall(ctx, agent));
    ctx.notes.push(`agent ${agent.id} anchored`);
  }
  if (opts.syncPolicy) await ensurePolicyOnChain(ctx, agent);
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The agent's passport as the database holds it now. The chain follows the database, never a
 * caller's snapshot: this is read under the signer lease, right before a policy write or an
 * attestation, so an agent row loaded before a revoke (by a concurrent request, a queued anchor or a
 * reconcile pass) can neither re-activate the revoked passport nor anchor a replaced one.
 */
async function currentPassport(agentId: string): Promise<{ hash: Hex; version: number; active: boolean } | null> {
  const row = await db.policy.findUnique({ where: { agentId } });
  if (!row) return null;
  if (row.policyHash && isHex(row.policyHash) && row.policyHash.length === 66) return { hash: row.policyHash as Hex, version: row.version, active: row.active };
  const doc = parsePolicy(row);
  return doc ? { hash: policyAnchorHash(doc, row.version), version: row.version, active: row.active } : null;
}

/** The passport a write was prepared for is no longer the database's active one; nothing was sent. */
export class PassportSuperseded extends Error {
  constructor(
    readonly agentId: string,
    readonly version: number,
  ) {
    super(`passport v${version} of ${agentId} was revoked or replaced before it was anchored`);
    this.name = "PassportSuperseded";
  }
}

/**
 * Anchor the database's current passport when the registry lacks it (never anchored, or another
 * hash). A passport the database has revoked is never anchored again. Idempotent.
 */
async function ensurePolicyOnChain(ctx: LiveCtx, agent: AgentRef): Promise<void> {
  const passport = await currentPassport(agent.id);
  if (!passport?.active) return;
  const [onChainHash, , , active] = await ctx.publicClient.readContract({
    address: ctx.addresses.permissions,
    abi: PermissionRegistryAbi,
    functionName: "policies",
    args: [idToBytes32(agent.id)],
  });
  if (active && sameHex(onChainHash, passport.hash)) return;
  if (agent.identity.custody === "owner") throw new OwnerSignatureRequired("setPolicy", agent.id);
  await write(ctx, "setPolicy", {
    address: ctx.addresses.permissions,
    abi: PermissionRegistryAbi,
    functionName: "setPolicy",
    args: [idToBytes32(agent.id), passport.hash, passport.version, `fuku://agents/${agent.id}/policy`],
  });
  ctx.notes.push(`passport v${passport.version} for agent ${agent.id} ${active ? "re-anchored (hash changed)" : "anchored"}`);
}

/**
 * Live writes all come from one signer, and viem fetches the nonce per transaction, so overlapping
 * writes would race on it. Writes are therefore serialized twice: an in-process queue, and a lease
 * row in the database (ChainLock) held for the duration of the write, so several server instances
 * sharing the database never broadcast for the same signer at the same time. A lease outlives a
 * crashed holder by at most LEASE_MS.
 */
const LEASE_MS = 150_000;
const LEASE_WAIT_MS = 180_000;
const INSTANCE_ID = randomUUID();
let liveQueue: Promise<unknown> = Promise.resolve();

async function acquireLease(id: string): Promise<string> {
  const token = `${INSTANCE_ID}:${randomUUID()}`;
  const giveUp = Date.now() + LEASE_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS);
    try {
      await db.chainLock.create({ data: { id, holder: token, expiresAt: until } });
      return token;
    } catch {
      // The row exists: take it over only if the previous lease expired.
    }
    const taken = await db.chainLock.updateMany({ where: { id, expiresAt: { lt: now } }, data: { holder: token, expiresAt: until } });
    if (taken.count === 1) return token;
    if (Date.now() > giveUp) throw new Error(`signer lease ${id} is busy`);
    await new Promise((r) => setTimeout(r, Math.min(2_000, 50 * 2 ** attempt)));
  }
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = liveQueue.then(async () => {
    const key = signerKey();
    const id = `signer:${chainConfig().id}:${key ? privateKeyToAccount(key).address.toLowerCase() : "none"}`;
    const token = await acquireLease(id);
    try {
      return await task();
    } finally {
      await db.chainLock.deleteMany({ where: { id, holder: token } }).catch(() => undefined);
    }
  });
  liveQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function liveReceipt(c: ChainConfig, mined: Mined, ctx: LiveCtx): ChainReceipt {
  return {
    txHash: mined.hash,
    block: Number(mined.block),
    mode: "live",
    status: "confirmed",
    chainId: c.id,
    explorerUrl: `${c.explorer}/tx/${mined.hash}`,
    note: ctx.notes.length ? `Anchored first: ${ctx.notes.join("; ")}` : undefined,
  };
}

function awaitingOwnerReceipt(c: ChainConfig, err: OwnerSignatureRequired): ChainReceipt {
  return {
    txHash: null,
    block: null,
    mode: "live",
    status: "awaiting-owner",
    chainId: c.id,
    explorerUrl: null,
    note: `${err.op} must be signed by the owner's wallet (owner-controlled identity); nothing was sent by Fuku.`,
  };
}

function supersededReceipt(c: ChainConfig, err: PassportSuperseded): ChainReceipt {
  return {
    txHash: null,
    block: null,
    mode: "live",
    status: "failed",
    chainId: c.id,
    explorerUrl: null,
    note: `Not anchored: ${err.message}. Nothing was sent.`,
  };
}

function pendingReceipt(c: ChainConfig, hash: Hex): ChainReceipt {
  return {
    txHash: hash,
    block: null,
    mode: "live",
    status: "pending",
    chainId: c.id,
    explorerUrl: `${c.explorer}/tx/${hash}`,
    note: "Broadcast; no receipt yet. Reconciliation settles it from the stored hash.",
  };
}

/**
 * A decision, score, registration or passport write. In live mode a failure is reported as a
 * `failed` receipt (nothing anchored) and a timeout after broadcast as `pending`; neither is ever
 * replaced by a mock receipt.
 */
async function send(
  op: string,
  payload: unknown,
  run: (ctx: LiveCtx, onSubmitted: (hash: Hex) => void) => Promise<Mined>,
): Promise<ChainReceipt> {
  if (chainMode() !== "live") return mockReceipt(op, payload);
  const c = chainConfig();
  let ctx: LiveCtx | null = null;
  let submitted: Hex | null = null;
  try {
    ctx = liveContext();
    const mined = await serialized(() => run(ctx as LiveCtx, (h) => (submitted = h)));
    noteHealth(true, op);
    return liveReceipt(c, mined, ctx);
  } catch (err) {
    if (err instanceof ReceiptTimeoutError && err.label === op) return pendingReceipt(c, err.hash);
    if (err instanceof OwnerSignatureRequired) return awaitingOwnerReceipt(c, err);
    if (err instanceof PassportSuperseded) return supersededReceipt(c, err);
    const reason = describeChainError(err);
    noteHealth(false, op, reason);
    console.error(`[fuku-chain] ${op} failed on ${c.name} (chain ${c.id}). Reason: ${reason}`);
    return {
      txHash: null,
      block: null,
      mode: "live",
      status: "failed",
      chainId: c.id,
      explorerUrl: null,
      note: `Live settlement failed (${reason.slice(0, 160)})${submitted ? `; tx ${submitted} reverted` : ""}. Nothing was anchored; reconciliation retries it.`,
    };
  }
}

/**
 * Like `send`, but a failure throws with the decoded reason (kill switch). `run` may return null
 * when there is nothing to do on-chain. A timeout after broadcast is returned as `pending`.
 */
async function sendStrict(op: string, payload: unknown, run: (ctx: LiveCtx) => Promise<Mined | null>): Promise<ChainReceipt | null> {
  if (chainMode() !== "live") return mockReceipt(op, payload);
  const c = chainConfig();
  const ctx = liveContext();
  let mined: Mined | null;
  try {
    mined = await serialized(() => run(ctx));
  } catch (err) {
    if (err instanceof ReceiptTimeoutError && err.label === op) return pendingReceipt(c, err.hash);
    if (err instanceof OwnerSignatureRequired) return awaitingOwnerReceipt(c, err);
    noteHealth(false, op, describeChainError(err));
    throw new ChainWriteError(op, describeChainError(err), err);
  }
  if (!mined) return null;
  noteHealth(true, op);
  return liveReceipt(c, mined, ctx);
}

export class ChainWriteError extends Error {
  constructor(
    readonly op: string,
    readonly reason: string,
    readonly cause?: unknown,
  ) {
    super(`${op} failed on-chain: ${reason}`);
    this.name = "ChainWriteError";
  }
}

// --- Public operations ---------------------------------------------------------------------

/** Kill switch: revoke the passport on-chain. Returns null when nothing is active on-chain. */
export function revokePolicyOnChain(agent: AgentRef) {
  return sendStrict("revokePolicy", { agentId: agent.id }, async (ctx) => {
    const key = idToBytes32(agent.id);
    const exists = await ctx.publicClient.readContract({ address: ctx.addresses.agents, abi: AgentRegistryAbi, functionName: "exists", args: [key] });
    if (!exists) return null;
    const [, , , active] = await ctx.publicClient.readContract({
      address: ctx.addresses.permissions,
      abi: PermissionRegistryAbi,
      functionName: "policies",
      args: [key],
    });
    if (!active) return null;
    if (agent.identity.custody === "owner") throw new OwnerSignatureRequired("revokePolicy", agent.id);
    return write(ctx, "revokePolicy", { address: ctx.addresses.permissions, abi: PermissionRegistryAbi, functionName: "revokePolicy", args: [key] });
  });
}

/** Kill switch: pause (2) or resume (1) the agent on-chain. Returns null when already in that state. */
export function setAgentStatusOnChain(agent: AgentRef, status: "active" | "paused") {
  const code = status === "active" ? 1 : 2;
  return sendStrict("setStatus", { agentId: agent.id, status }, async (ctx) => {
    const key = idToBytes32(agent.id);
    const exists = await ctx.publicClient.readContract({ address: ctx.addresses.agents, abi: AgentRegistryAbi, functionName: "exists", args: [key] });
    if (!exists) {
      // Never anchored: nothing can execute for it on-chain while paused. Resuming anchors it lazily later.
      return null;
    }
    const record = (await ctx.publicClient.readContract({
      address: ctx.addresses.agents,
      abi: AgentRegistryAbi,
      functionName: "agents",
      args: [key],
    })) as readonly unknown[];
    if (Number(record[5]) === code) return null;
    if (agent.identity.custody === "owner") throw new OwnerSignatureRequired("setStatus", agent.id);
    return write(ctx, "setStatus", { address: ctx.addresses.agents, abi: AgentRegistryAbi, functionName: "setStatus", args: [key, code] });
  });
}

/**
 * Kill switch, part of pause and revoke: void every outstanding FukuSpendGuard attestation for the
 * agent (guard.bumpValidAfter), as an enforcer. Needs no owner signature, so it takes effect even for
 * owner-controlled agents whose registry writes wait for the owner. Null when there is no guard.
 */
export function bumpValidAfterOnChain(agent: AgentRef) {
  const guard = spendGuardAddress();
  if (!guard || chainMode() !== "live") return Promise.resolve(null);
  return sendStrict("bumpValidAfter", { agentId: agent.id }, async (ctx) =>
    write(ctx, "bumpValidAfter", { address: guard, abi: FukuSpendGuardAbi, functionName: "bumpValidAfter", args: [idToBytes32(agent.id)] }),
  );
}

/** After the owner's allowance to the guard changed: void the attestations drawing on that wallet. */
export function bumpWalletValidAfterOnChain(agentId: string, wallet: Address) {
  const guard = spendGuardAddress();
  if (!guard || chainMode() !== "live") return Promise.resolve(null);
  return sendStrict("bumpWalletValidAfter", { agentId, wallet }, async (ctx) =>
    write(ctx, "bumpWalletValidAfter", { address: guard, abi: FukuSpendGuardAbi, functionName: "bumpWalletValidAfter", args: [idToBytes32(agentId), wallet] }),
  );
}

/** Anchor a freshly created identity; also marks it human-verified when `humanVerified` is set. */
export function anchorIdentity(identityId: string, passkeyPubKeyHash: Hex, proofHash: Hex, humanVerified = false) {
  return send("registerIdentity", { identityId, proofHash }, async (ctx, onSubmitted) => {
    const key = idToBytes32(identityId);
    const mined = await write(
      ctx,
      "registerIdentity",
      { address: ctx.addresses.identity, abi: HumanIdentityRegistryAbi, functionName: "registerIdentity", args: [key, passkeyPubKeyHash, proofHash] },
      onSubmitted,
    );
    if (humanVerified) await markHumanVerified(ctx, { id: identityId, humanVerified, proofHash }, key);
    return mined;
  });
}

export function registerAgentOnChain(agent: AgentRef) {
  return send("registerAgent", { id: agent.id, identityId: agent.identity.id }, async (ctx, onSubmitted) => {
    await ensureIdentityOnChain(ctx, agent.identity);
    return write(ctx, "registerAgent", registerAgentCall(ctx, agent), onSubmitted);
  });
}

/**
 * Anchor passport `version` under `policyHash` (see policyAnchorHash). Sent only if it is still the
 * database's active passport once the signer lease is held; a revoke or a newer version that won the
 * race is left alone (the receipt says nothing was sent). Owner-controlled agents: awaiting-owner.
 */
export function setPolicyOnChain(agent: AgentRef, policyHash: Hex, version: number) {
  return send("setPolicy", { agentId: agent.id, version }, async (ctx, onSubmitted) => {
    await ensureAgentOnChain(ctx, agent);
    const passport = await currentPassport(agent.id);
    if (!passport?.active || passport.version !== version || !sameHex(passport.hash, policyHash)) throw new PassportSuperseded(agent.id, version);
    if (agent.identity.custody === "owner") throw new OwnerSignatureRequired("setPolicy", agent.id);
    return write(
      ctx,
      "setPolicy",
      {
        address: ctx.addresses.permissions,
        abi: PermissionRegistryAbi,
        functionName: "setPolicy",
        args: [idToBytes32(agent.id), policyHash, version, `fuku://agents/${agent.id}/policy`],
      },
      onSubmitted,
    );
  });
}

export function recordDecisionOnChain(input: {
  agent: AgentRef;
  actionId: string;
  allowed: boolean;
  proofHash: Hex;
  ruleId: string;
}) {
  const { agent, ...rest } = input;
  return send("recordDecision", { agentId: agent.id, ...rest }, async (ctx, onSubmitted) => {
    await ensureAgentOnChain(ctx, agent, { syncPolicy: true });
    return write(
      ctx,
      "recordDecision",
      {
        address: ctx.addresses.permissions,
        abi: PermissionRegistryAbi,
        functionName: "recordDecision",
        args: [idToBytes32(agent.id), hashString(input.actionId), input.allowed, input.proofHash, input.ruleId],
      },
      onSubmitted,
    );
  });
}

export function updateScoreOnChain(agent: AgentRef, score: number, delta: number, reason: string) {
  return send("updateScore", { agentId: agent.id, score, delta }, async (ctx, onSubmitted) => {
    await ensureAgentOnChain(ctx, agent, { syncPolicy: true });
    return write(
      ctx,
      "updateScore",
      {
        address: ctx.addresses.reputation,
        abi: ReputationRegistryAbi,
        functionName: "updateScore",
        args: [idToBytes32(agent.id), score, delta, hashString(reason), reason],
      },
      onSubmitted,
    );
  });
}

// --- Guarded transfers (FukuSpendGuard) ------------------------------------------------------

export interface GuardedTransferInput {
  agent: AgentRef;
  actionId: string;
  from: Address;
  to: Address;
  token: Address;
  /** Authoritative amount in token base units (6 decimals). */
  amount: bigint;
  proofHash: Hex;
  complianceRef: Hex;
  /** The passport version the engine authorized this transfer under; re-checked before signing. */
  policyVersion: number;
  /** Persist the transaction hash as soon as it is broadcast (before waiting for the receipt). */
  onSubmitted?: (hash: Hex) => Promise<void> | void;
}

export interface GuardedExecution {
  receipt: ChainReceipt;
  blockHash: Hex | null;
  /** Index of the GuardedTransferExecuted log in its block (the evidence locator). */
  logIndex: number | null;
  mandateVersion: bigint | null;
}

export type GuardedTransferOutcome =
  | ({ status: "executed" } & GuardedExecution)
  /** The guard (or the token behind it) would revert, or the guard is not configured: BLOCKED R10. Nothing was broadcast. */
  | { status: "rejected"; reason: string }
  /** Broadcast, receipt not seen within the timeout; reconciliation settles it from the stored hash. */
  | { status: "pending"; receipt: ChainReceipt }
  /** Mined but reverted (a race after the simulation): execution FAILED, nothing moved. */
  | { status: "reverted"; receipt: ChainReceipt; reason: string };

const GUARDED_TRANSFER_TYPES = {
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

/**
 * How long a GuardedTransfer attestation lives, in seconds: FUKU_ATTESTATION_TTL_S (default 60),
 * within [10, 3600] and never longer than the guard's own maxAttestationTtl, which it enforces.
 * Reconciliation relies on it (see reconcile.ts).
 */
export function attestationTtlSeconds(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FUKU_ATTESTATION_TTL_S ?? 60);
  return Number.isFinite(n) ? Math.min(3600, Math.max(10, Math.floor(n))) : 60;
}

function isRevert(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
}

/** The GuardedTransferExecuted log for `actionHash` among `logs`, if any. */
function executionLog(logs: Log[], guard: Address, actionHash: Hex) {
  const parsed = parseEventLogs({ abi: FukuSpendGuardAbi, eventName: "GuardedTransferExecuted", logs });
  return parsed.find((l) => l.address.toLowerCase() === guard.toLowerCase() && l.args.actionHash.toLowerCase() === actionHash.toLowerCase()) ?? null;
}

/**
 * Re-check, right before signing, that what authorized a transfer still holds in the database: the
 * agent is active and passport `policyVersion` is still its active passport. The kill switch writes
 * the database first, so a revoke, a pause or a newer passport committed before this read wins and
 * nothing is signed. Returns the passport to attest to, or why the transfer is refused.
 */
async function freshAuthorization(agentId: string, policyVersion: number): Promise<{ passport: { hash: Hex; version: number } } | { reason: string }> {
  const [agent, passport] = await Promise.all([db.agent.findUnique({ where: { id: agentId }, select: { status: true } }), currentPassport(agentId)]);
  if (!agent || agent.status !== "active") return { reason: `AUTHORIZATION_CHANGED(agent ${agent?.status ?? "missing"})` };
  if (!passport?.active) return { reason: "AUTHORIZATION_CHANGED(passport revoked)" };
  if (passport.version !== policyVersion) return { reason: `AUTHORIZATION_CHANGED(passport v${passport.version} replaced v${policyVersion})` };
  return { passport };
}

/**
 * Move `amount` of an A-Token from the owner's funding wallet through FukuSpendGuard. Under the
 * signer lease, Fuku first re-checks the authorization in the database (freshAuthorization); the
 * compliance signer then attests to exactly this transfer (EIP-712) against that passport's hash,
 * once it is the active one on-chain, and the owner's current mandate version; the guard re-checks agent status, passport,
 * mandate (token, cap, per-tx limit, expiry, payees), the token applies its own compliance, and
 * the guard records the decision (R6) itself. The action hash is single-use on-chain.
 *
 * Never falls back to a mock receipt in live mode: a would-be revert is `rejected` (R10), a mined
 * revert `reverted`, a receipt timeout `pending`, and anything else (RPC, signing, anchoring before
 * broadcast) throws a ChainWriteError.
 */
export async function executeGuardedTransfer(input: GuardedTransferInput): Promise<GuardedTransferOutcome> {
  if (chainMode() !== "live") {
    const auth = await freshAuthorization(input.agent.id, input.policyVersion);
    if ("reason" in auth) return { status: "rejected", reason: auth.reason };
    return {
      status: "executed",
      receipt: mockReceipt("guardedTransfer", { agentId: input.agent.id, to: input.to, amount: input.amount.toString() }, "Mock guarded transfer (chain in mock mode; no tokens moved)"),
      blockHash: null,
      logIndex: null,
      mandateVersion: null,
    };
  }
  const guard = spendGuardAddress();
  const signer = complianceSigner();
  if (!guard || !signer) return { status: "rejected", reason: "GUARD_NOT_CONFIGURED" };
  const c = chainConfig();
  const ctx = liveContext();
  const actionHash = hashString(input.actionId);

  return serialized(async (): Promise<GuardedTransferOutcome> => {
    const auth = await freshAuthorization(input.agent.id, input.policyVersion);
    if ("reason" in auth) return { status: "rejected", reason: auth.reason };
    let transfer;
    let signature: Hex;
    try {
      await ensureAgentOnChain(ctx, input.agent, { syncPolicy: true });
      const agentId = idToBytes32(input.agent.id);
      const [[onChainHash, , , policyActive], mandate, maxTtl, agentFloor, walletFloor, latest] = await Promise.all([
        ctx.publicClient.readContract({ address: ctx.addresses.permissions, abi: PermissionRegistryAbi, functionName: "policies", args: [agentId] }),
        ctx.publicClient.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "mandates", args: [agentId, input.from] }),
        ctx.publicClient.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "maxAttestationTtl" }),
        ctx.publicClient.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "agentValidAfter", args: [agentId] }),
        ctx.publicClient.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "walletValidAfter", args: [agentId, input.from] }),
        ctx.publicClient.getBlock(),
      ]);
      // Attest only to the passport the database authorized, and only once it is the active one on-chain.
      if (!policyActive || !sameHex(onChainHash, auth.passport.hash)) return { status: "rejected", reason: "AUTHORIZATION_CHANGED(on-chain passport differs)" };
      // Issued at chain time, strictly after the last bump (the guard allows up to 5 s ahead of block time).
      const floor = agentFloor > walletFloor ? agentFloor : walletFloor;
      const issuedAt = latest.timestamp > floor ? latest.timestamp : floor + BigInt(1);
      const ttl = BigInt(Math.min(attestationTtlSeconds(), Number(maxTtl)));
      transfer = {
        agentId,
        from: input.from,
        to: input.to,
        token: input.token,
        amount: input.amount,
        policyHash: auth.passport.hash,
        actionHash,
        proofHash: input.proofHash,
        complianceRef: input.complianceRef,
        mandateVersion: mandate[5],
        nonce: BigInt(toHex(randomBytes(32))),
        issuedAt,
        deadline: issuedAt + ttl,
      };
      signature = await signer.signTypedData({
        domain: { name: "FukuSpendGuard", version: "1", chainId: ctx.chain.id, verifyingContract: guard },
        types: GUARDED_TRANSFER_TYPES,
        primaryType: "GuardedTransfer",
        message: transfer,
      });
    } catch (err) {
      if (err instanceof OwnerSignatureRequired) return { status: "rejected", reason: `OWNER_SIGNATURE_REQUIRED(${err.op})` };
      throw new ChainWriteError("guardedTransfer", describeChainError(err), err);
    }

    let request;
    try {
      ({ request } = await ctx.publicClient.simulateContract({
        address: guard,
        abi: FukuSpendGuardAbi,
        functionName: "execute",
        args: [transfer, signature],
        account: ctx.account,
        chain: ctx.chain,
      }));
    } catch (err) {
      if (isRevert(err)) return { status: "rejected", reason: describeChainError(err) };
      throw new ChainWriteError("guardedTransfer", describeChainError(err), err);
    }

    let hash: Hex;
    try {
      hash = await ctx.walletClient.writeContract(request);
    } catch (err) {
      noteHealth(false, "guardedTransfer", describeChainError(err));
      throw new ChainWriteError("guardedTransfer", describeChainError(err), err);
    }
    await input.onSubmitted?.(hash);
    let mined;
    try {
      mined = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch {
      return { status: "pending", receipt: pendingReceipt(c, hash) };
    }
    const receipt: ChainReceipt = {
      txHash: hash,
      block: Number(mined.blockNumber),
      mode: "live",
      status: mined.status === "success" ? "confirmed" : "failed",
      chainId: c.id,
      explorerUrl: `${c.explorer}/tx/${hash}`,
      note: ctx.notes.length ? `Anchored first: ${ctx.notes.join("; ")}` : undefined,
    };
    if (mined.status !== "success") {
      noteHealth(false, "guardedTransfer", "reverted on-chain");
      return { status: "reverted", receipt, reason: `REVERTED_ON_CHAIN(${hash})` };
    }
    noteHealth(true, "guardedTransfer");
    console.log(`[fuku-chain] guardedTransfer mined: tx ${hash} block ${mined.blockNumber}`);
    const log = executionLog(mined.logs, guard, actionHash);
    return { status: "executed", receipt, blockHash: mined.blockHash, logIndex: log?.logIndex ?? null, mandateVersion: transfer.mandateVersion };
  });
}

// --- Reconciliation reads ------------------------------------------------------------------------

export type TxOutcome =
  | { found: false }
  | { found: true; success: boolean; block: number; blockHash: Hex; logIndex: number | null };

/** What the chain says about a transaction now (null in mock mode). */
export async function transactionOutcome(hash: Hex, actionHash?: Hex): Promise<TxOutcome | null> {
  const client = chainReader();
  if (!client) return null;
  try {
    const r = await client.getTransactionReceipt({ hash });
    const guard = spendGuardAddress();
    const log = guard && actionHash ? executionLog(r.logs, guard, actionHash) : null;
    return { found: true, success: r.status === "success", block: Number(r.blockNumber), blockHash: r.blockHash, logIndex: log?.logIndex ?? null };
  } catch {
    return { found: false };
  }
}

/** Whether the guard has already executed a transfer for this action (single-use action hash). */
export async function guardActionExecuted(actionId: string): Promise<boolean | null> {
  const client = chainReader();
  const guard = spendGuardAddress();
  if (!client || !guard) return null;
  return client.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "actionExecuted", args: [hashString(actionId)] });
}

/** Find the GuardedTransferExecuted log for an action (for a transfer whose hash was never stored). */
export async function findGuardExecution(agentId: string, actionId: string, fromBlock: bigint) {
  const client = chainReader();
  const guard = spendGuardAddress();
  if (!client || !guard) return null;
  const actionHash = hashString(actionId).toLowerCase();
  // Newest first, one RPC-sized range at a time, stopping at the first hit (a crashed transfer is recent).
  const head = await client.getBlockNumber();
  const span = logChunkSize();
  for (let to = head; to >= fromBlock; to -= span) {
    const from = to - span + BigInt(1) > fromBlock ? to - span + BigInt(1) : fromBlock;
    const logs = await client.getContractEvents({
      address: guard,
      abi: FukuSpendGuardAbi,
      eventName: "GuardedTransferExecuted",
      args: { agentId: idToBytes32(agentId) },
      fromBlock: from,
      toBlock: to,
    });
    const hit = logs.find((l) => l.args.actionHash?.toLowerCase() === actionHash);
    if (hit) return { txHash: hit.transactionHash, block: Number(hit.blockNumber), blockHash: hit.blockHash, logIndex: hit.logIndex };
    if (from === fromBlock) break;
  }
  return null;
}

/**
 * Blocks per eth_getLogs call: FUKU_LOG_CHUNK, else 100 (Monad's public RPC refuses wider ranges),
 * or 50,000 on a local Hardhat node.
 */
export function logChunkSize(): bigint {
  const raw = Number(process.env.FUKU_LOG_CHUNK);
  if (Number.isFinite(raw) && raw > 0) return BigInt(Math.floor(raw));
  return BigInt(chainConfig().id === 31337 ? 50_000 : 100);
}

export interface AgentOnChain {
  exists: boolean;
  /** AgentRegistry status: 0 Registered, 1 Active, 2 Paused, 3 Revoked. */
  status: number | null;
  policyHash: Hex | null;
  policyVersion: number | null;
  policyActive: boolean;
}

/** What the registries say about an agent right now (null in mock mode). */
export async function readAgentOnChain(agentId: string): Promise<AgentOnChain | null> {
  const client = chainReader();
  const a = addresses();
  if (!client || !a) return null;
  const key = idToBytes32(agentId);
  const exists = await client.readContract({ address: a.agents, abi: AgentRegistryAbi, functionName: "exists", args: [key] });
  if (!exists) return { exists: false, status: null, policyHash: null, policyVersion: null, policyActive: false };
  const [record, policy] = await Promise.all([
    client.readContract({ address: a.agents, abi: AgentRegistryAbi, functionName: "agents", args: [key] }) as Promise<readonly unknown[]>,
    client.readContract({ address: a.permissions, abi: PermissionRegistryAbi, functionName: "policies", args: [key] }),
  ]);
  return { exists: true, status: Number(record[5]), policyHash: policy[0], policyVersion: Number(policy[1]), policyActive: policy[3] };
}

/** The four registry addresses (null when not configured). */
export function registryAddresses() {
  return addresses();
}

/** The relayer's address (the live signer), or null in mock mode. */
export function relayerAddress(): Address | null {
  const key = signerKey();
  return chainMode() === "live" && key ? privateKeyToAccount(key).address : null;
}

/** The relayer attests the passkey flag for an identity (it is the registry owner). */
export function setHumanVerifiedOnChain(identityId: string) {
  return send("setHumanVerified", { identityId }, async (ctx, onSubmitted) =>
    write(
      ctx,
      "setHumanVerified",
      { address: ctx.addresses.identity, abi: HumanIdentityRegistryAbi, functionName: "setHumanVerified", args: [idToBytes32(identityId), true] },
      onSubmitted,
    ),
  );
}

export async function latestBlock(): Promise<bigint | null> {
  const client = chainReader();
  return client ? client.getBlockNumber() : null;
}

export interface MandateView {
  guard: Address;
  wallet: string;
  token: string;
  dailyCapUsdc: number;
  maxPerTxUsdc: number | null;
  validUntil: number | null;
  restrictPayees: boolean;
  version: number;
  spentTodayUsdc: number;
  active: boolean;
}

/** The owner's on-chain mandate for this agent, or null in mock mode / without a guard. */
export async function readMandate(agentId: string, wallet: string): Promise<MandateView | null> {
  const guard = spendGuardAddress();
  const client = chainReader();
  if (!guard || !client || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return null;
  const key = idToBytes32(agentId);
  const [[token, dailyCap, maxPerTx, validUntil, restrictPayees, version, active], spent] = await Promise.all([
    client.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "mandates", args: [key, wallet as Address] }),
    client.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "spentToday", args: [key, wallet as Address] }),
  ]);
  return {
    guard,
    wallet: wallet.toLowerCase(),
    token: token.toLowerCase(),
    dailyCapUsdc: Number(dailyCap) / 1e6,
    maxPerTxUsdc: maxPerTx > BigInt(0) ? Number(maxPerTx) / 1e6 : null,
    validUntil: validUntil > BigInt(0) ? Number(validUntil) : null,
    restrictPayees,
    version: Number(version),
    spentTodayUsdc: Number(spent) / 1e6,
    active,
  };
}

/**
 * Content hash of a decision record — this is what gets anchored and what an auditor recomputes.
 * `complianceRef` is appended only when Cleanverse evidence exists, so every other action keeps
 * the original hash format.
 */
export function decisionProofHash(record: {
  agentId: string;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  decision: string;
  ruleId: string;
  policyHash: Hex | null;
  at: string;
  complianceRef?: Hex | null;
}): Hex {
  const { complianceRef, ...base } = record;
  return hashJson(complianceRef ? { ...base, complianceRef } : base);
}
