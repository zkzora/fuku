/**
 * Agent keys: API keys bound to one agent, for software that acts as that agent (the Fuku MCP
 * server, an agent runtime) and must not hold the owner's key. An owner key acts as the owner on
 * every v1 route: it can change passports, register and pause agents, bind wallets, mint keys. An
 * agent key can only do what the agent itself needs, on routes that opt in (lib/api.ts withApiKey):
 *
 *   agent:read     its own verification, trust score, mandate and score recomputation
 *   agent:check    dry-run its own actions
 *   agent:execute  execute its own actions (an agent that holds its own key still signs each one)
 *   agent:actions  read its own actions' receipts
 *   agents:verify  read other agents' public verification (counterparty checks); not granted by default
 *
 * Everything else answers 403: passport changes, agent registration and management, identities and
 * wallets, ERC-8004 setup, records, delegations, key management, other agents and other owners. The
 * vault and the rest of the web app take a session cookie only, never an API key.
 *
 * The key belongs to the agent's owner (ApiKey.identityId) and is checked against the agent on every
 * request: if the agent no longer belongs to that owner the key stops working. Deleting the agent
 * deletes its keys.
 */
import type { Identity } from "@prisma/client";
import { db } from "../db";
import { ForbiddenError, RequestError } from "../errors";
import { hashApiKey } from "./identity";
import { randomToken } from "../ids";

export const AGENT_KEY_SCOPES = ["agent:read", "agent:check", "agent:execute", "agent:actions", "agents:verify"] as const;
export type AgentKeyScope = (typeof AGENT_KEY_SCOPES)[number];
/** What the MCP server needs. agents:verify (other agents) is opt-in. */
export const DEFAULT_AGENT_KEY_SCOPES: AgentKeyScope[] = ["agent:read", "agent:check", "agent:execute", "agent:actions"];
export const AGENT_KEY_PREFIX = "fk_agent_";

export function parseAgentKeyScopes(raw: string | null | undefined): AgentKeyScope[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((s): s is AgentKeyScope => (AGENT_KEY_SCOPES as readonly string[]).includes(s)) : [];
  } catch {
    return [];
  }
}

/** Mint an agent key. Only the agent's owner may (not a delegate, not another agent key). */
export async function createAgentApiKey(owner: Identity, input: { agentId: string; name: string; scopes?: AgentKeyScope[] }) {
  const agent = await db.agent.findUnique({ where: { id: input.agentId }, select: { id: true, identityId: true, name: true } });
  if (!agent) throw new Error("Agent not found");
  if (agent.identityId !== owner.id) throw new ForbiddenError("Only the agent's owner can create a key for it.");
  const scopes = [...new Set(input.scopes?.length ? input.scopes : DEFAULT_AGENT_KEY_SCOPES)];
  const unknown = scopes.filter((s) => !(AGENT_KEY_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new RequestError(`Unknown agent key scope: ${unknown.join(", ")}. Known: ${AGENT_KEY_SCOPES.join(", ")}.`, 400, "invalid_scope");
  const raw = `${AGENT_KEY_PREFIX}${randomToken(18)}`;
  const key = await db.apiKey.create({
    data: { identityId: owner.id, agentId: agent.id, scopes: JSON.stringify(scopes), name: input.name, prefix: raw.slice(0, 14), keyHash: hashApiKey(raw) },
  });
  return { key: agentKeyView(key), raw };
}

export async function listAgentApiKeys(owner: Identity, agentId: string) {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { identityId: true } });
  if (!agent) throw new Error("Agent not found");
  if (agent.identityId !== owner.id) throw new ForbiddenError("Only the agent's owner can list its keys.");
  const keys = await db.apiKey.findMany({ where: { agentId, identityId: owner.id }, orderBy: { createdAt: "desc" } });
  return keys.map(agentKeyView);
}

/** Revoke (delete) an agent key; it stops working on the next request. */
export async function revokeAgentApiKey(owner: Identity, agentId: string, keyId: string) {
  const r = await db.apiKey.deleteMany({ where: { id: keyId, agentId, identityId: owner.id } });
  if (r.count === 0) throw new Error("Agent key not found");
}

export function agentKeyView(k: { id: string; name: string; prefix: string; agentId: string | null; scopes: string | null; createdAt: Date; lastUsedAt: Date | null }) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    agentId: k.agentId,
    scopes: parseAgentKeyScopes(k.scopes),
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  };
}
