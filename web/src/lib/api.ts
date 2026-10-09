import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import type { Identity } from "@prisma/client";
import { requireIdentity, UnauthorizedError } from "./session";
import { apiKeyFromRaw } from "./services/identity";
import { parseAgentKeyScopes, type AgentKeyScope } from "./services/api-keys";
import { ChainWriteError } from "./chain";
import { ForbiddenError, RequestError } from "./errors";
import { RateLimitError } from "./rate-limit";

export type Ctx<P = Record<string, string>> = { params: Promise<P> };

type Handler<P> = (req: NextRequest, identity: Identity, params: P, principal: Principal) => Promise<Response>;

/**
 * Who is calling a v1 route. `identity` is always the owner the call acts for; an agent key
 * (services/api-keys.ts) additionally narrows the call to one agent and a few scopes.
 */
export type Principal =
  | { kind: "owner"; keyId: string | null }
  | { kind: "agent"; keyId: string; agentId: string; scopes: AgentKeyScope[] };

/** How a route admits agent keys. Routes without it refuse them. */
export interface AgentKeyAccess<P> {
  /** The scope an agent key needs on this route; null: any agent key (it reads only itself). */
  scope: AgentKeyScope | null;
  /** The route param naming the agent: an agent key may only name its own agent. */
  agentParam?: keyof P & string;
  /** A scope that lets an agent key name another agent here (public verification only). */
  otherAgents?: AgentKeyScope;
}

function handleError(err: unknown) {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: err.message || "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (err instanceof RateLimitError) {
    return NextResponse.json(
      { error: err.message, code: "rate_limited" },
      { status: 429, headers: { "retry-after": String(err.retryAfterSec) } },
    );
  }
  if (err instanceof RequestError) {
    return NextResponse.json({ error: err.message, code: err.code ?? "bad_request" }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "Invalid request", code: "invalid_request", issues: err.issues }, { status: 400 });
  }
  if (err instanceof ChainWriteError) {
    // Surfaced, never swallowed: the on-chain write (kill switch, guarded transfer) did not happen.
    console.error("[fuku-api]", err.message);
    return NextResponse.json({ error: err.message, code: "chain_write_failed", chain: { op: err.op, reason: err.reason } }, { status: 502 });
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  console.error("[fuku-api]", err);
  const status = /not found/i.test(message) ? 404 : 500;
  return NextResponse.json({ error: message, code: status === 404 ? "not_found" : "internal" }, { status });
}

/** Session-cookie authenticated route (the web app). */
export function withSession<P = Record<string, string>>(handler: Handler<P>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      const identity = await requireIdentity();
      return await handler(req, identity, await ctx.params, { kind: "owner", keyId: null });
    } catch (err) {
      return handleError(err);
    }
  };
}

/** The API key a request presents (Authorization: Bearer … or x-fuku-key), if any. */
export function presentedApiKey(req: NextRequest | Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || null;
  return req.headers.get("x-fuku-key")?.trim() || null;
}

/**
 * API-key authenticated route (the public v1 API used by the SDK). A request that presents a key
 * is authorised by that key alone: an invalid, revoked or disabled key is rejected with 401 and
 * never falls back to the browser session. Only requests without any key use the session cookie
 * (the in-app Developer Console).
 *
 * Agent keys (fk_agent_…) are refused (403) unless the route opts in with `agentKey`, and then only
 * with the scope it names and only for the agent the key is bound to.
 */
export function withApiKey<P = Record<string, string>>(handler: Handler<P>, opts: { agentKey?: AgentKeyAccess<P> } = {}) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      const raw = presentedApiKey(req);
      const params = await ctx.params;
      let identity: Identity | null;
      let principal: Principal;
      if (raw) {
        const key = await apiKeyFromRaw(raw);
        if (!key) throw new UnauthorizedError("Invalid API key");
        identity = key.identity;
        principal = key.agentId ? { kind: "agent", keyId: key.id, agentId: key.agentId, scopes: parseAgentKeyScopes(key.scopes) } : { kind: "owner", keyId: key.id };
        if (principal.kind === "agent") {
          if (!key.agent || key.agent.identityId !== key.identityId) {
            throw new ForbiddenError("This agent key's agent no longer belongs to the key's owner.", "agent_key_owner_mismatch");
          }
          admitAgentKey(principal, params, opts.agentKey);
        }
      } else {
        identity = await requireIdentity();
        principal = { kind: "owner", keyId: null };
      }
      return await handler(req, identity, params, principal);
    } catch (err) {
      return handleError(err);
    }
  };
}

function admitAgentKey<P>(principal: Extract<Principal, { kind: "agent" }>, params: P, access: AgentKeyAccess<P> | undefined) {
  const bound = `This key is an agent key for ${principal.agentId}`;
  if (!access) throw new ForbiddenError(`${bound}: it cannot use this endpoint. Use the owner's key or the Fuku app.`, "agent_key_forbidden");
  if (access.scope && !principal.scopes.includes(access.scope)) throw new ForbiddenError(`${bound} without the ${access.scope} scope.`, "agent_key_scope");
  if (!access.agentParam) return;
  const named = String(params[access.agentParam]);
  if (named === principal.agentId) return;
  if (access.otherAgents && principal.scopes.includes(access.otherAgents)) return;
  throw new ForbiddenError(`${bound}: it cannot act on or read ${named}.`, "agent_key_other_agent");
}

/** Unauthenticated route with uniform error handling. */
export function withErrors<P = Record<string, string>>(handler: (req: NextRequest, params: P) => Promise<Response>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      return await handler(req, await ctx.params);
    } catch (err) {
      return handleError(err);
    }
  };
}

/** JSON response; bigint values (token base units) are sent as decimal strings. */
export const json = (data: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new NextResponse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { ...init, headers });
};
