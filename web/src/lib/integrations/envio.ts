import { decodeEventLog, isHex, type Abi, type Hex } from "viem";
import { chainConfig } from "../chain";
import {
  AgentRegistryAbi,
  FukuSpendGuardAbi,
  HumanIdentityRegistryAbi,
  PermissionRegistryAbi,
  ReputationRegistryAbi,
} from "../chain/abi";
import { idToBytes32 } from "../ids";

/**
 * Envio integration.
 *
 * HyperSync (ENVIO_API_TOKEN) indexes the Fuku registries on Monad: every identity anchor,
 * agent registration, passport, decision and score change, with block timestamps, in one query.
 * HyperRPC (ENVIO_HYPERRPC_TOKEN) is Envio's read-only JSON-RPC; Fuku uses it to verify that a
 * decision's transaction exists on-chain and carries the same proof hash as the Fuku ledger.
 *
 * HyperRPC does not support eth_call, so contract writes and simulations stay on MONAD_RPC_URL.
 */

type RegistryKey = "identity" | "agents" | "permissions" | "reputation" | "guard";

const ABIS: Record<RegistryKey, Abi> = {
  identity: HumanIdentityRegistryAbi as unknown as Abi,
  agents: AgentRegistryAbi as unknown as Abi,
  permissions: PermissionRegistryAbi as unknown as Abi,
  reputation: ReputationRegistryAbi as unknown as Abi,
  // Mandate, payee and guarded-transfer events carry the agent id as their first indexed topic too.
  guard: FukuSpendGuardAbi as unknown as Abi,
};

function registries(): Partial<Record<RegistryKey, string>> {
  const r: Partial<Record<RegistryKey, string>> = {};
  if (process.env.FUKU_IDENTITY_REGISTRY) r.identity = process.env.FUKU_IDENTITY_REGISTRY.toLowerCase();
  if (process.env.FUKU_AGENT_REGISTRY) r.agents = process.env.FUKU_AGENT_REGISTRY.toLowerCase();
  if (process.env.FUKU_PERMISSION_REGISTRY) r.permissions = process.env.FUKU_PERMISSION_REGISTRY.toLowerCase();
  if (process.env.FUKU_REPUTATION_REGISTRY) r.reputation = process.env.FUKU_REPUTATION_REGISTRY.toLowerCase();
  if (process.env.FUKU_SPEND_GUARD) r.guard = process.env.FUKU_SPEND_GUARD.toLowerCase();
  return r;
}

export function hypersyncUrl() {
  return (process.env.ENVIO_HYPERSYNC_URL?.trim() || `https://${chainConfig().id}.hypersync.xyz`).replace(/\/+$/, "");
}

function hyperrpcUrl(): string | null {
  const token = process.env.ENVIO_HYPERRPC_TOKEN?.trim();
  if (!token) return null;
  const base = (process.env.ENVIO_HYPERRPC_URL?.trim() || `https://${chainConfig().id}.rpc.hypersync.xyz`).replace(/\/+$/, "");
  return `${base}/${token}`;
}

export function startBlock() {
  const n = Number(process.env.ENVIO_START_BLOCK ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// --- Status (for the integration board) -----------------------------------------------------

export interface EnvioStatus {
  hypersync: { ok: boolean; height?: number; error?: string };
  hyperrpc: { ok: boolean; block?: number; error?: string };
  registriesConfigured: boolean;
  checkedAt: number;
}

let statusCache: EnvioStatus | null = null;

export async function envioStatus(): Promise<EnvioStatus> {
  if (statusCache && Date.now() - statusCache.checkedAt < 60_000) return statusCache;
  const hs: EnvioStatus["hypersync"] = { ok: false };
  const rpc: EnvioStatus["hyperrpc"] = { ok: false };
  const token = process.env.ENVIO_API_TOKEN?.trim();
  await Promise.all([
    (async () => {
      if (!token) return void (hs.error = "no ENVIO_API_TOKEN");
      try {
        const res = await fetch(`${hypersyncUrl()}/height`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(6000),
        });
        const j = (await res.json()) as { height?: number };
        if (res.ok && typeof j.height === "number") Object.assign(hs, { ok: true, height: j.height });
        else hs.error = `HTTP ${res.status}`;
      } catch (e) {
        hs.error = (e as Error).message;
      }
    })(),
    (async () => {
      const url = hyperrpcUrl();
      if (!url) return void (rpc.error = "no ENVIO_HYPERRPC_TOKEN");
      try {
        const j = await rpcCall<string>(url, "eth_blockNumber", []);
        Object.assign(rpc, { ok: true, block: Number(BigInt(j)) });
      } catch (e) {
        rpc.error = (e as Error).message;
      }
    })(),
  ]);
  const regs = registries();
  // The four registries; the spend guard is optional on top of them.
  const registriesConfigured = Boolean(regs.identity && regs.agents && regs.permissions && regs.reputation);
  statusCache = { hypersync: hs, hyperrpc: rpc, registriesConfigured, checkedAt: Date.now() };
  return statusCache;
}

// --- HyperSync: indexed registry events --------------------------------------------------------

interface HsLog {
  block_number: number;
  log_index: number;
  transaction_hash: string;
  address: string;
  data: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
}
interface HsBlock {
  number: number;
  timestamp: string;
}
interface HsResponse {
  data?: { logs?: HsLog[]; blocks?: HsBlock[] }[];
  next_block: number;
  archive_height: number;
}

export interface OnChainEvent {
  id: string;
  kind: string;
  registry: RegistryKey;
  title: string;
  detail: string;
  tone: "allow" | "block" | "violet" | "neutral";
  subjectKey: Hex | null;
  blockNumber: number;
  timestamp: string | null;
  txHash: string;
  args: Record<string, string | number | boolean>;
}

export interface OnChainFeed {
  source: "envio-hypersync";
  url: string;
  fromBlock: number;
  height: number;
  scannedTo: number;
  events: OnChainEvent[];
}

async function hypersyncQuery(body: unknown): Promise<HsResponse> {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) throw new Error("ENVIO_API_TOKEN is not set");
  const res = await fetch(`${hypersyncUrl()}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HyperSync ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()) as HsResponse;
}

const toStr = (v: unknown): string | number | boolean =>
  typeof v === "bigint" ? v.toString() : typeof v === "boolean" || typeof v === "number" ? v : String(v);

/**
 * Registry events whose first indexed topic is one of `subjects` (identity ids and agent ids,
 * as Fuku ids). `names` maps each subject's bytes32 key to a display name.
 */
export async function fetchRegistryEvents(opts: {
  subjects: string[];
  names?: Record<string, string>;
  limit?: number;
}): Promise<OnChainFeed> {
  const regs = registries();
  const addresses = Object.values(regs);
  if (addresses.length === 0) throw new Error("Fuku registry addresses are not configured");
  const byAddress = new Map<string, RegistryKey>(Object.entries(regs).map(([k, a]) => [a, k as RegistryKey]));
  const keys = opts.subjects.map((s) => idToBytes32(s));
  const names: Record<string, string> = {};
  for (const [id, name] of Object.entries(opts.names ?? {})) names[idToBytes32(id)] = name;

  const fromBlock = startBlock();
  const logs: HsLog[] = [];
  const blockTs = new Map<number, string>();
  let next = fromBlock;
  let height = fromBlock;
  // HyperSync returns a page per call; follow next_block until the archive height (bounded).
  for (let page = 0; page < 20; page++) {
    const r = await hypersyncQuery({
      from_block: next,
      logs: [{ address: addresses, topics: [[], keys] }],
      field_selection: {
        log: ["block_number", "log_index", "transaction_hash", "address", "data", "topic0", "topic1", "topic2", "topic3"],
        block: ["number", "timestamp"],
      },
    });
    for (const chunk of r.data ?? []) {
      logs.push(...(chunk.logs ?? []));
      for (const b of chunk.blocks ?? []) blockTs.set(Number(b.number), b.timestamp);
    }
    height = r.archive_height;
    if (!r.next_block || r.next_block >= r.archive_height || r.next_block <= next) {
      next = r.next_block ?? next;
      break;
    }
    next = r.next_block;
  }

  const events: OnChainEvent[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const registry = byAddress.get(log.address.toLowerCase());
    if (!registry) continue;
    // Pages can overlap; an event is identified by its transaction and log index, so it counts once.
    const eventId = `${log.transaction_hash}-${log.log_index}`;
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter((t): t is string => Boolean(t)) as [Hex, ...Hex[]];
    let decoded: { eventName: string; args: Record<string, unknown> };
    try {
      decoded = decodeEventLog({ abi: ABIS[registry], topics, data: (log.data && isHex(log.data) ? log.data : "0x") as Hex }) as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
    } catch {
      continue;
    }
    const args: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(decoded.args ?? {})) args[k] = toStr(v);
    const subjectKey = (log.topic1 ?? null) as Hex | null;
    const who = (subjectKey && names[subjectKey]) || "Unknown subject";
    const ts = blockTs.get(Number(log.block_number));
    events.push({
      id: `${log.transaction_hash}-${log.log_index}`,
      kind: decoded.eventName,
      registry,
      ...describe(decoded.eventName, args, who),
      subjectKey,
      blockNumber: Number(log.block_number),
      timestamp: ts ? new Date(Number(BigInt(ts)) * 1000).toISOString() : null,
      txHash: log.transaction_hash,
      args,
    });
  }
  events.sort((a, b) => b.blockNumber - a.blockNumber || b.id.localeCompare(a.id));
  return {
    source: "envio-hypersync",
    url: hypersyncUrl(),
    fromBlock,
    height,
    scannedTo: next,
    events: events.slice(0, opts.limit ?? 100),
  };
}

function describe(
  kind: string,
  a: Record<string, string | number | boolean>,
  who: string,
): Pick<OnChainEvent, "title" | "detail" | "tone"> {
  switch (kind) {
    case "IdentityRegistered":
      return { title: `${who} identity anchored`, detail: `controller ${short(a.controller)} · proof ${short(a.proofHash)}`, tone: "violet" };
    case "HumanVerified":
      return { title: `${who} marked ${a.verified ? "human-verified" : "not verified"}`, detail: "HumanIdentityRegistry", tone: a.verified ? "allow" : "block" };
    case "AgentRegistered":
      return { title: `${who} registered`, detail: `name "${a.name}" · capabilities ${short(a.capabilitiesHash)}`, tone: "violet" };
    case "AgentStatusChanged":
      return { title: `${who} status changed`, detail: `status ${["Registered", "Active", "Paused", "Revoked"][Number(a.status)] ?? a.status}`, tone: "neutral" };
    case "PolicySet":
      return { title: `${who} passport v${a.version} anchored`, detail: `policy hash ${short(a.policyHash)}`, tone: "violet" };
    case "PolicyRevoked":
      return { title: `${who} passport revoked`, detail: "PermissionRegistry", tone: "block" };
    case "ActionDecision":
      return {
        title: `${who} action ${a.allowed ? "ALLOWED" : "BLOCKED"} · rule ${a.ruleId}`,
        detail: `proof ${short(a.proofHash)}`,
        tone: a.allowed ? "allow" : "block",
      };
    case "MandateOpened":
      return {
        title: `${who} mandate v${a.version} opened by the owner`,
        detail: `cap ${units(a.dailyCap)}/day · max ${units(a.maxPerTx)} per transfer · payees ${a.restrictPayees ? "restricted" : "open"}`,
        tone: "violet",
      };
    case "MandateClosed":
      return { title: `${who} mandate closed by the owner`, detail: `version ${a.version}`, tone: "block" };
    case "PayeeSet":
      return { title: `${who} payee ${a.allowed ? "approved" : "removed"} by the owner`, detail: `payee ${short(a.payee)}`, tone: a.allowed ? "allow" : "neutral" };
    case "GuardedTransferExecuted":
      return {
        title: `${who} moved ${units(a.amount)} through FukuSpendGuard`,
        detail: `to ${short(a.to)} · action ${short(a.actionHash)} · compliance ${short(a.complianceRef)}`,
        tone: "allow",
      };
    case "ScoreUpdated": {
      const d = Number(a.delta);
      return { title: `${who} trust score ${a.newScore} (${d > 0 ? "+" : ""}${d})`, detail: String(a.reason), tone: d < 0 ? "block" : "allow" };
    }
    default:
      return { title: `${who} ${kind}`, detail: "", tone: "neutral" };
  }
}

/** Token base units (6 decimals) as a plain amount. */
function units(v: unknown) {
  try {
    return (Number(BigInt(String(v))) / 1e6).toLocaleString("en-US");
  } catch {
    return String(v);
  }
}

function short(v: unknown) {
  const s = String(v ?? "");
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

// --- HyperRPC: verify a decision on-chain ------------------------------------------------------

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json()) as { result?: T; error?: { message?: string } | string };
  if (!res.ok || j.error) throw new Error(typeof j.error === "string" ? j.error : j.error?.message ?? `HTTP ${res.status}`);
  return j.result as T;
}

export interface ProofVerification {
  source: "envio-hyperrpc";
  txHash: string;
  found: boolean;
  success: boolean;
  blockNumber: number | null;
  decisionEvent: boolean;
  onChain: { allowed: boolean; ruleId: string; proofHash: string } | null;
  proofMatches: boolean;
  message: string;
}

/** Fetch the receipt through HyperRPC and check its ActionDecision event against the Fuku ledger. */
export async function verifyDecisionTx(txHash: string, expectedProofHash: string): Promise<ProofVerification> {
  const url = hyperrpcUrl();
  if (!url) throw new Error("ENVIO_HYPERRPC_TOKEN is not set");
  const base: ProofVerification = {
    source: "envio-hyperrpc",
    txHash,
    found: false,
    success: false,
    blockNumber: null,
    decisionEvent: false,
    onChain: null,
    proofMatches: false,
    message: "",
  };
  const receipt = await rpcCall<{
    status: string;
    blockNumber: string;
    logs: { address: string; topics: Hex[]; data: Hex }[];
  } | null>(url, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { ...base, message: "Transaction not found on-chain (a mock receipt, or not yet indexed)." };

  const permissions = registries().permissions;
  const result: ProofVerification = {
    ...base,
    found: true,
    success: receipt.status === "0x1",
    blockNumber: Number(BigInt(receipt.blockNumber)),
  };
  for (const log of receipt.logs) {
    if (permissions && log.address.toLowerCase() !== permissions) continue;
    try {
      const ev = decodeEventLog({ abi: ABIS.permissions, topics: log.topics as [Hex, ...Hex[]], data: log.data }) as unknown as {
        eventName: string;
        args: { allowed: boolean; ruleId: string; proofHash: string };
      };
      if (ev.eventName !== "ActionDecision") continue;
      result.decisionEvent = true;
      result.onChain = { allowed: ev.args.allowed, ruleId: ev.args.ruleId, proofHash: ev.args.proofHash };
      result.proofMatches = ev.args.proofHash.toLowerCase() === expectedProofHash.toLowerCase();
      break;
    } catch {
      /* not a PermissionRegistry event */
    }
  }
  result.message = !result.success
    ? "Transaction reverted on-chain."
    : !result.decisionEvent
      ? "Transaction found, but it carries no ActionDecision event."
      : result.proofMatches
        ? `Verified on-chain: ActionDecision in block ${result.blockNumber} carries the same proof hash as the Fuku ledger.`
        : "Mismatch: the on-chain proof hash differs from the Fuku ledger.";
  return result;
}
