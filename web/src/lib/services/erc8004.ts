import type { Agent, Identity } from "@prisma/client";
import { createWalletClient, getAddress, http, isAddress, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { db } from "../db";
import { chainConfig, chainMode, chainReader, settlementChain } from "../chain";
import { agentKeysConfigured, newAgentKey, openAgentKey } from "../agent-keys";
import { demoOwnerKey } from "../cleanverse/demo";
import { DEMO_IDENTITY_ID } from "../demo-mode";
import {
  ERC8004_SOURCE,
  Erc8004IdentityRegistryAbi,
  MAX_DEADLINE_DELAY_S,
  agentRegistryId,
  agentWalletSetIn,
  erc8004IdentityRegistry,
  readErc8004Domain,
  registerCalldata,
  registeredIn,
  setAgentWalletCalldata,
  signAgentWalletSet,
} from "../erc8004";

/**
 * Registering a Fuku agent on the canonical ERC-8004 Identity Registry:
 *   1. the owner's wallet sends register(agentURI); the agent NFT is minted to that wallet;
 *   2. the agent's own key (lib/agent-keys.ts) signs AgentWalletSet, and the owner's wallet sends
 *      setAgentWallet with that signature, so the agent key becomes the agent's `agentWallet`.
 * Fuku prepares both transactions and confirms each from its receipt, its sender, the decoded
 * event and an independent read; it never signs for the owner. The seeded demo identity is the one
 * exception: Fuku holds Ava's wallet key (custodial demo), so it can send both itself.
 */

export type Erc8004Op = "erc8004Register" | "erc8004SetAgentWallet";

export interface Erc8004Action {
  op: Erc8004Op;
  description: string;
  tx: { chainId: number; from: Address; to: Address; data: Hex; value: "0x0" };
  /** setAgentWallet: the agent key's signature is refused after this unix time (block time). */
  deadline?: number;
}

export type Erc8004Reason = "mock-chain" | "unsupported-chain" | "no-owner-wallet" | "agent-keys-not-configured" | "owned-elsewhere";

export interface Erc8004View {
  chainId: number;
  explorer: string;
  /** How the owner wallet was bound (dynamic | signature): which wallet the app asks to sign. */
  walletVerifiedBy: string | null;
  registry: Address | null;
  registryId: string | null;
  reason: Erc8004Reason | null;
  ownerWallet: Address | null;
  /** Fuku holds the owner wallet's key (seeded demo only) and can send the transactions itself. */
  custodialDemo: boolean;
  /** The agent's own key: its intended (or current) agentWallet. */
  agentWallet: Address | null;
  agentId: string | null;
  agentURI: string;
  registerTx: string | null;
  walletTx: string | null;
  onChain: { owner: Address; agentWallet: Address; tokenURI: string } | null;
  /** Registered, owned by the owner's wallet, and agentWallet is the agent's own key. */
  complete: boolean;
  actions: Erc8004Action[];
  source: typeof ERC8004_SOURCE;
}

type Env = Record<string, string | undefined>;

/** The public base URL of agent URIs and registration files (FUKU_ERC8004_URI_BASE, else the app URL). */
export function erc8004BaseUrl(env: Env = process.env): string {
  return (env.FUKU_ERC8004_URI_BASE?.trim() || env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3001").replace(/\/+$/, "");
}

/** Where the agent's registration file is served (app/api/erc8004/agents/[id]/registration.json). */
export function agentUriFor(agentId: string, env: Env = process.env): string {
  return `${erc8004BaseUrl(env)}/api/erc8004/agents/${encodeURIComponent(agentId)}/registration.json`;
}

function ownerWalletOf(identity: Pick<Identity, "walletAddress" | "walletVerifiedBy">): Address | null {
  return identity.walletVerifiedBy && identity.walletAddress && isAddress(identity.walletAddress) ? getAddress(identity.walletAddress) : null;
}

/** Ava's wallet account when Fuku holds a real (configured, not derived) key for it. */
function demoOwnerAccount(identity: Identity): PrivateKeyAccount | null {
  if (identity.id !== DEMO_IDENTITY_ID) return null;
  const { key, derived } = demoOwnerKey();
  if (derived) return null;
  const account = privateKeyToAccount(key);
  const wallet = ownerWalletOf(identity);
  return wallet && isAddressEqual(account.address, wallet) ? account : null;
}

/** The agent's key, generated and sealed on first use. */
async function ensureAgentKey(agent: Agent): Promise<PrivateKeyAccount> {
  let row = agent;
  if (!row.agentKey || !row.agentWallet) {
    const fresh = newAgentKey(agent.id);
    await db.agent.updateMany({ where: { id: agent.id, agentKey: null }, data: { agentWallet: fresh.address, agentKey: fresh.sealed } });
    row = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
  }
  const account = openAgentKey(row.id, row.agentKey!);
  if (!isAddressEqual(account.address, row.agentWallet as Address)) throw new Error(`agent key of ${agent.id} does not match its stored address`);
  return account;
}

async function agentWalletAction(client: PublicClient, registry: Address, agent: Agent, owner: Address, chainId: number): Promise<Erc8004Action> {
  const key = await ensureAgentKey(agent);
  const [domain, latest] = await Promise.all([readErc8004Domain(client, registry), client.getBlock()]);
  // Block time plus four minutes: inside the registry's five-minute window, with slack for mining.
  const deadline = latest.timestamp + BigInt(MAX_DEADLINE_DELAY_S - 60);
  const message = { agentId: BigInt(agent.erc8004Id!), newWallet: key.address, owner, deadline };
  const signature = await signAgentWalletSet(key, domain, message);
  return {
    op: "erc8004SetAgentWallet",
    description: `Make ${agent.name}'s own key (${key.address.slice(0, 8)}…) its agentWallet; signed by the agent key, valid about 4 minutes`,
    tx: { chainId, from: owner, to: registry, data: setAgentWalletCalldata(message, signature), value: "0x0" },
    deadline: Number(deadline),
  };
}

export async function erc8004View(agent: Agent, identity: Identity): Promise<Erc8004View> {
  const c = chainConfig();
  const registry = erc8004IdentityRegistry(c.id);
  const ownerWallet = ownerWalletOf(identity);
  const agentURI = agent.erc8004Uri ?? agentUriFor(agent.id);
  const view: Erc8004View = {
    chainId: c.id,
    explorer: c.explorer,
    walletVerifiedBy: identity.walletVerifiedBy,
    registry,
    registryId: registry ? agentRegistryId(c.id, registry) : null,
    reason: null,
    ownerWallet,
    custodialDemo: Boolean(demoOwnerAccount(identity)),
    agentWallet: agent.agentWallet ? getAddress(agent.agentWallet) : null,
    agentId: agent.erc8004Id,
    agentURI,
    registerTx: agent.erc8004Tx,
    walletTx: agent.erc8004WalletTx,
    onChain: null,
    complete: false,
    actions: [],
    source: ERC8004_SOURCE,
  };
  if (chainMode() !== "live") return { ...view, reason: "mock-chain" };
  if (!registry) return { ...view, reason: "unsupported-chain" };
  if (!ownerWallet) return { ...view, reason: "no-owner-wallet" };
  const client = chainReader()!;

  if (!agent.erc8004Id) {
    view.actions.push({
      op: "erc8004Register",
      description: `Register ${agent.name} on the ERC-8004 Identity Registry; the agent NFT is minted to your wallet`,
      tx: { chainId: c.id, from: ownerWallet, to: registry, data: registerCalldata(agentURI), value: "0x0" },
    });
    return view;
  }
  const id = BigInt(agent.erc8004Id);
  const [owner, agentWallet, tokenURI] = await Promise.all([
    client.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "ownerOf", args: [id] }),
    client.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "getAgentWallet", args: [id] }),
    client.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "tokenURI", args: [id] }),
  ]);
  view.onChain = { owner, agentWallet, tokenURI };
  if (!isAddressEqual(owner, ownerWallet)) return { ...view, reason: "owned-elsewhere" };
  const keyBound = Boolean(agent.agentWallet && isAddressEqual(agentWallet, agent.agentWallet as Address));
  if (keyBound) return { ...view, complete: true };
  if (!agentKeysConfigured()) return { ...view, reason: "agent-keys-not-configured" };
  view.actions.push(await agentWalletAction(client, registry, agent, ownerWallet, c.id));
  view.agentWallet = getAddress((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).agentWallet!);
  return view;
}

export type Erc8004Confirmation = { ok: true; op: Erc8004Op; agentId: string; txHash: Hex } | { ok: false; error: string };

/**
 * Record a mined ERC-8004 transaction once the chain proves it: success, sent by the owner's
 * wallet to the canonical registry, the expected event, and an independent read.
 */
export async function confirmErc8004(agent: Agent, identity: Identity, input: { op: Erc8004Op; txHash: Hex }): Promise<Erc8004Confirmation> {
  const c = chainConfig();
  const registry = erc8004IdentityRegistry(c.id);
  const ownerWallet = ownerWalletOf(identity);
  if (chainMode() !== "live" || !registry) return { ok: false, error: "ERC-8004 registration needs the live chain with a canonical registry" };
  if (!ownerWallet) return { ok: false, error: "the identity has no verified owner wallet" };
  const client = chainReader()!;
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: input.txHash }), client.getTransaction({ hash: input.txHash })]);
  if (receipt.status !== "success") return { ok: false, error: `transaction ${input.txHash} reverted` };
  if (!isAddressEqual(tx.from, ownerWallet)) return { ok: false, error: `sent by ${tx.from}, not the owner wallet ${ownerWallet}` };
  if (!tx.to || !isAddressEqual(tx.to, registry)) return { ok: false, error: `sent to ${tx.to}, not the ERC-8004 Identity Registry ${registry}` };

  if (input.op === "erc8004Register") {
    const agentURI = agent.erc8004Uri ?? agentUriFor(agent.id);
    const minted = registeredIn(receipt.logs, registry, ownerWallet, agentURI);
    if (minted === null) return { ok: false, error: `no Registered event for ${agentURI} and ${ownerWallet}` };
    const owner = await client.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "ownerOf", args: [minted] });
    if (!isAddressEqual(owner, ownerWallet)) return { ok: false, error: `agent #${minted} is owned by ${owner}` };
    const saved = await db.agent.updateMany({
      where: { id: agent.id, erc8004Id: null },
      data: { erc8004Id: minted.toString(), erc8004Registry: registry, erc8004ChainId: c.id, erc8004Owner: ownerWallet.toLowerCase(), erc8004Uri: agentURI, erc8004Tx: input.txHash },
    });
    if (saved.count === 0) {
      const current = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
      if (current.erc8004Tx?.toLowerCase() !== input.txHash.toLowerCase()) return { ok: false, error: `${agent.name} is already registered as ERC-8004 agent #${current.erc8004Id}` };
    }
    return { ok: true, op: input.op, agentId: minted.toString(), txHash: input.txHash };
  }

  if (!agent.erc8004Id || !agent.agentWallet) return { ok: false, error: "register the agent and prepare its key first" };
  const id = BigInt(agent.erc8004Id);
  if (!agentWalletSetIn(receipt.logs, registry, id, agent.agentWallet as Address)) return { ok: false, error: `no MetadataSet(agentWallet = ${agent.agentWallet}) for agent #${id}` };
  const onChain = await client.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "getAgentWallet", args: [id] });
  if (!isAddressEqual(onChain, agent.agentWallet as Address)) return { ok: false, error: `getAgentWallet(#${id}) is ${onChain}` };
  await db.agent.update({ where: { id: agent.id }, data: { erc8004WalletTx: input.txHash } });
  return { ok: true, op: input.op, agentId: agent.erc8004Id, txHash: input.txHash };
}

/**
 * Seeded demo only: Fuku holds Ava's wallet key (custodial demo), so it sends her pending ERC-8004
 * transactions itself and confirms each the same way as an owner-sent one.
 */
export async function registerFromDemoWallet(agentId: string): Promise<{ sent: { op: Erc8004Op; txHash: Hex }[]; view: Erc8004View }> {
  let agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  const identity = await db.identity.findUniqueOrThrow({ where: { id: agent.identityId } });
  const account = demoOwnerAccount(identity);
  if (!account) throw new Error("Only the seeded demo identity, with DEMO_OWNER_PRIVATE_KEY configured, can be registered by Fuku itself.");
  const c = chainConfig();
  const client = chainReader()!;
  const wallet = createWalletClient({ account, chain: settlementChain(), transport: http(c.rpc) });
  const sent: { op: Erc8004Op; txHash: Hex }[] = [];
  let view = await erc8004View(agent, identity);
  while (view.actions.length > 0 && sent.length < 2) {
    const action = view.actions[0];
    const txHash = await wallet.sendTransaction({ to: action.tx.to, data: action.tx.data });
    await client.waitForTransactionReceipt({ hash: txHash });
    // Re-read: preparing setAgentWallet stored the agent's new key.
    agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const confirmed = await confirmErc8004(agent, identity, { op: action.op, txHash });
    if (!confirmed.ok) throw new Error(`${action.op}: ${confirmed.error}`);
    sent.push({ op: action.op, txHash });
    agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    view = await erc8004View(agent, identity);
  }
  return { sent, view };
}
