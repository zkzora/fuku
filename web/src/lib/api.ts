import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import type { Identity } from "@prisma/client";
import { requireIdentity, UnauthorizedError } from "./session";
import { identityFromApiKey } from "./services/identity";
import { ChainWriteError } from "./chain";
import { ForbiddenError, RequestError } from "./errors";
import { RateLimitError } from "./rate-limit";

export type Ctx<P = Record<string, string>> = { params: Promise<P> };

type Handler<P> = (req: NextRequest, identity: Identity, params: P) => Promise<Response>;

function handleError(err: unknown) {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: err.message || "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message, code: "forbidden" }, { status: 403 });
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
      return await handler(req, identity, await ctx.params);
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
 */
export function withApiKey<P = Record<string, string>>(handler: Handler<P>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      const raw = presentedApiKey(req);
      let identity: Identity | null;
      if (raw) {
        identity = await identityFromApiKey(raw);
        if (!identity) throw new UnauthorizedError("Invalid API key");
      } else {
        identity = await requireIdentity();
      }
      return await handler(req, identity, await ctx.params);
    } catch (err) {
      return handleError(err);
    }
  };
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
