import type { Identity } from "@prisma/client";
import { db } from "../db";
import { ForbiddenError } from "../errors";

/**
 * Shared authorization for the web app, the public API, the SDK and CRE (which calls the public
 * API). An identity may act for an owner when it IS the owner, when it created that identity for
 * one of its users through the API (a recorded management grant, `Identity.managedById`), or when
 * the owner granted it an unexpired, unrevoked delegation with the needed scope.
 */
export const SCOPES = ["agents:register", "agents:manage", "agents:execute"] as const;
export type Scope = (typeof SCOPES)[number];

export type ActAs =
  | { ok: true; via: "self" | "managed" | "delegation"; delegationId?: string }
  | { ok: false; reason: string };

export async function canActFor(callerId: string, ownerId: string, scope: Scope, now = new Date()): Promise<ActAs> {
  if (callerId === ownerId) return { ok: true, via: "self" };
  const owner = await db.identity.findUnique({ where: { id: ownerId }, select: { managedById: true } });
  if (!owner) return { ok: false, reason: "Owner identity not found" };
  if (owner.managedById && owner.managedById === callerId) return { ok: true, via: "managed" };
  const grants = await db.delegation.findMany({
    where: { ownerId, delegateId: callerId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  });
  const grant = grants.find((d) => parseScopes(d.scopes).includes(scope));
  return grant ? { ok: true, via: "delegation", delegationId: grant.id } : { ok: false, reason: `No delegation from ${ownerId} with scope ${scope}` };
}

/** Throws ForbiddenError (HTTP 403) unless `caller` may act for `ownerId` with `scope`. */
export async function requireActFor(caller: Identity, ownerId: string, scope: Scope): Promise<Extract<ActAs, { ok: true }>> {
  const r = await canActFor(caller.id, ownerId, scope);
  if (!r.ok) throw new ForbiddenError(`Not authorized to ${scope.split(":")[1]} agents for this owner. The owner must grant a delegation.`);
  return r;
}

/** The agent, if `caller` may act on it with `scope`; 404 for unknown agents, 403 otherwise. */
export async function authorizedAgent(caller: Identity, agentId: string, scope: Scope) {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, identityId: true } });
  if (!agent) throw new Error("Agent not found");
  const via = await requireActFor(caller, agent.identityId, scope);
  return { agent, via };
}

export function parseScopes(raw: string): Scope[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)) : [];
  } catch {
    return [];
  }
}

// --- Owner-side management -------------------------------------------------------------------------

export async function grantDelegation(owner: Identity, input: { delegateId: string; scopes: Scope[]; expiresAt?: Date | null }) {
  if (input.delegateId === owner.id) throw new ForbiddenError("An identity cannot delegate to itself.");
  const delegate = await db.identity.findUnique({ where: { id: input.delegateId }, select: { id: true } });
  if (!delegate) throw new Error("Delegate identity not found");
  return db.delegation.create({
    data: { ownerId: owner.id, delegateId: input.delegateId, scopes: JSON.stringify([...new Set(input.scopes)]), expiresAt: input.expiresAt ?? null },
  });
}

export async function revokeDelegation(owner: Identity, id: string) {
  const r = await db.delegation.updateMany({ where: { id, ownerId: owner.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (r.count === 0) throw new Error("Delegation not found");
}

export async function listDelegations(owner: Identity) {
  const rows = await db.delegation.findMany({
    where: { OR: [{ ownerId: owner.id }, { delegateId: owner.id }] },
    include: { owner: { select: { id: true, displayName: true } }, delegate: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((d) => ({
    id: d.id,
    direction: d.ownerId === owner.id ? ("granted" as const) : ("received" as const),
    owner: d.owner,
    delegate: d.delegate,
    scopes: parseScopes(d.scopes),
    expiresAt: d.expiresAt?.toISOString() ?? null,
    revokedAt: d.revokedAt?.toISOString() ?? null,
    active: !d.revokedAt && (!d.expiresAt || d.expiresAt > new Date()),
    createdAt: d.createdAt.toISOString(),
  }));
}
