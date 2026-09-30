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
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { idToBytes32, hashJson, hashString } from "../ids";
import {
  AgentRegistryAbi,
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

export interface ChainReceipt {
  txHash: Hex;
  block: number;
  mode: ChainMode;
  explorerUrl: string;
  note?: string;
}

/** The identity fields the live path needs to anchor an identity lazily. */
export interface IdentityRef {
  id: string;
  humanVerified: boolean;
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
  /** The agent's current passport, so a passport approved in mock mode is anchored lazily too. */
  policy?: { doc: unknown; version: number; active: boolean } | null;
}

/** Build an AgentRef from Prisma rows (capabilities are stored as a JSON string). */
export function toAgentRef(
  agent: {
    id: string;
    name: string;
    version: string;
    capabilities: string | string[];
    policy?: { allowed: string; blocked: string; scopeApps: string; version: number; active: boolean } | null;
  },
  identity: { id: string; humanVerified: boolean; proofHash?: string | null },
): AgentRef {
  let policy: AgentRef["policy"] = null;
  if (agent.policy) {
    try {
      policy = {
        doc: {
          allowed: JSON.parse(agent.policy.allowed),
          blocked: JSON.parse(agent.policy.blocked),
          scopeApps: JSON.parse(agent.policy.scopeApps),
        },
        version: agent.policy.version,
        active: agent.policy.active,
      };
    } catch {
      policy = null;
    }
  }
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
    identity: { id: identity.id, humanVerified: identity.humanVerified, proofHash: identity.proofHash ?? null },
    policy,
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
    signer: mode === "live" && key ? privateKeyToAccount(key).address : null,
  };
}

let mockBlock = 18_204_331;
function mockReceipt(op: string, payload: unknown, note?: string): ChainReceipt {
  const txHash = keccak256(stringToHex(`${op}:${JSON.stringify(payload)}:${Date.now()}:${Math.random()}`));
  mockBlock += 1 + Math.floor(Math.random() * 3);
  return {
    txHash,
    block: mockBlock,
    mode: "mock",
    explorerUrl: `${chainConfig().explorer}/tx/${txHash}`,
    note: note ?? `Mock settlement (set FUKU_CHAIN_MODE=live to anchor on ${chainConfig().name})`,
  };
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
}

/** Simulate (so reverts decode to custom errors), send, and wait until mined. */
async function write(ctx: LiveCtx, label: string, call: Call): Promise<Mined> {
  const { request } = await ctx.publicClient.simulateContract({ ...call, account: ctx.account, chain: ctx.chain });
  const hash = await ctx.walletClient.writeContract(request);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new Error(`${label} reverted on-chain (tx ${hash})`);
  console.log(`[fuku-chain] ${label} mined: tx ${hash} block ${receipt.blockNumber}`);
  return { hash, block: receipt.blockNumber };
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

/** Register the identity on-chain if it is missing; sync the human-verified flag. Idempotent. */
async function ensureIdentityOnChain(ctx: LiveCtx, identity: IdentityRef): Promise<void> {
  const key = idToBytes32(identity.id);
  const [controller, , , , humanVerified] = await ctx.publicClient.readContract({
    address: ctx.addresses.identity,
    abi: HumanIdentityRegistryAbi,
    functionName: "identities",
    args: [key],
  });

  if (controller === zeroAddress) {
    const proofHash = proofHashOf(identity);
    await write(ctx, "registerIdentity", {
      address: ctx.addresses.identity,
      abi: HumanIdentityRegistryAbi,
      functionName: "registerIdentity",
      args: [key, identity.passkeyPubKeyHash ?? proofHash, proofHash],
    });
    ctx.notes.push(`identity ${identity.id} anchored`);
    if (identity.humanVerified) await markHumanVerified(ctx, identity, key);
    return;
  }

  if (!isAddressEqual(controller, ctx.account.address)) {
    console.warn(
      `[fuku-chain] identity ${identity.id} is controlled on-chain by ${controller}, not by the signer ${ctx.account.address}; owner-only writes will revert`,
    );
    return;
  }
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
 * Register the agent (and its identity) on-chain if missing, and, when `syncPolicy` is set,
 * push its current passport if the registry has none (passports approved in mock mode were
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
    await write(ctx, "registerAgent", registerAgentCall(ctx, agent));
    ctx.notes.push(`agent ${agent.id} anchored`);
  }
  if (opts.syncPolicy && agent.policy?.active) await ensurePolicyOnChain(ctx, agent);
}

/** Anchor the agent's current passport when the registry has no active policy for it. */
async function ensurePolicyOnChain(ctx: LiveCtx, agent: AgentRef): Promise<void> {
  if (!agent.policy?.active) return;
  const active = await ctx.publicClient.readContract({
    address: ctx.addresses.permissions,
    abi: PermissionRegistryAbi,
    functionName: "hasActivePolicy",
    args: [idToBytes32(agent.id)],
  });
  if (active) return;
  await write(ctx, "setPolicy", {
    address: ctx.addresses.permissions,
    abi: PermissionRegistryAbi,
    functionName: "setPolicy",
    args: [idToBytes32(agent.id), hashJson(agent.policy.doc), agent.policy.version, `fuku://agents/${agent.id}/policy`],
  });
  ctx.notes.push(`passport v${agent.policy.version} for agent ${agent.id} anchored`);
}

/**
 * Live writes all come from the one signer and viem fetches the nonce per transaction, so two
 * overlapping requests would race on it ("nonce too low" / replacement underpriced) and one
 * of them would silently fall back to a mock receipt. Serialize them per process instead:
 * each write then fetches its nonce only after the previous one is mined.
 */
let liveQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = liveQueue.then(task);
  liveQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function send(op: string, payload: unknown, run: (ctx: LiveCtx) => Promise<Mined>): Promise<ChainReceipt> {
  if (chainMode() !== "live") return mockReceipt(op, payload);
  const c = chainConfig();
  let ctx: LiveCtx | null = null;
  try {
    ctx = liveContext();
    const { hash, block } = await serialized(() => run(ctx as LiveCtx));
    return {
      txHash: hash,
      block: Number(block),
      mode: "live",
      explorerUrl: `${c.explorer}/tx/${hash}`,
      note: ctx.notes.length ? `Anchored first: ${ctx.notes.join("; ")}` : undefined,
    };
  } catch (err) {
    const reason = describeChainError(err);
    console.error(`[fuku-chain] ${op} failed on ${c.name} (chain ${c.id}), recording mock receipt. Reason: ${reason}`);
    return mockReceipt(op, payload, `Live settlement failed (${reason.slice(0, 120)}); mock receipt recorded`);
  }
}

// --- Public operations ---------------------------------------------------------------------

/** Anchor a freshly created identity; also marks it human-verified when `humanVerified` is set. */
export function anchorIdentity(identityId: string, passkeyPubKeyHash: Hex, proofHash: Hex, humanVerified = false) {
  return send("registerIdentity", { identityId, proofHash }, async (ctx) => {
    const key = idToBytes32(identityId);
    const mined = await write(ctx, "registerIdentity", {
      address: ctx.addresses.identity,
      abi: HumanIdentityRegistryAbi,
      functionName: "registerIdentity",
      args: [key, passkeyPubKeyHash, proofHash],
    });
    if (humanVerified) await markHumanVerified(ctx, { id: identityId, humanVerified, proofHash }, key);
    return mined;
  });
}

export function registerAgentOnChain(agent: AgentRef) {
  return send("registerAgent", { id: agent.id, identityId: agent.identity.id }, async (ctx) => {
    await ensureIdentityOnChain(ctx, agent.identity);
    return write(ctx, "registerAgent", registerAgentCall(ctx, agent));
  });
}

export function setPolicyOnChain(agent: AgentRef, policy: unknown, version: number) {
  return send("setPolicy", { agentId: agent.id, version }, async (ctx) => {
    await ensureAgentOnChain(ctx, agent);
    return write(ctx, "setPolicy", {
      address: ctx.addresses.permissions,
      abi: PermissionRegistryAbi,
      functionName: "setPolicy",
      args: [idToBytes32(agent.id), hashJson(policy), version, `fuku://agents/${agent.id}/policy`],
    });
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
  return send("recordDecision", { agentId: agent.id, ...rest }, async (ctx) => {
    await ensureAgentOnChain(ctx, agent, { syncPolicy: true });
    return write(ctx, "recordDecision", {
      address: ctx.addresses.permissions,
      abi: PermissionRegistryAbi,
      functionName: "recordDecision",
      args: [idToBytes32(agent.id), hashString(input.actionId), input.allowed, input.proofHash, input.ruleId],
    });
  });
}

export function updateScoreOnChain(agent: AgentRef, score: number, delta: number, reason: string) {
  return send("updateScore", { agentId: agent.id, score, delta }, async (ctx) => {
    await ensureAgentOnChain(ctx, agent, { syncPolicy: true });
    return write(ctx, "updateScore", {
      address: ctx.addresses.reputation,
      abi: ReputationRegistryAbi,
      functionName: "updateScore",
      args: [idToBytes32(agent.id), score, delta, hashString(reason), reason],
    });
  });
}

/** Content hash of a decision record — this is what gets anchored and what an auditor recomputes. */
export function decisionProofHash(record: {
  agentId: string;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  decision: string;
  ruleId: string;
  policyHash: Hex | null;
  at: string;
}): Hex {
  return hashJson(record);
}
